// Model client. All LLM calls go through here: the local Ollama server by default, or Groq (LLM_PROVIDER=groq).
// Calls always stream; inside an llmScope each call is mirrored as 'llm' run events.
import { nanoid } from 'nanoid';
import type { NodeId, RunEvent } from '../types.js';
import { llmScope, type LlmScope } from './scope.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  json?: boolean;
  temperature?: number;
  signal?: AbortSignal;
  numCtx?: number;
  label?: string;    // shown in the UI, e.g. "Writing Dockerfile"; defaults from the step
  service?: string;  // overrides the scope's service; appended to the label
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
export const PROVIDER: 'ollama' | 'groq' = process.env.LLM_PROVIDER === 'groq' ? 'groq' : 'ollama';
const GROQ_URL = 'https://api.groq.com/openai/v1';
export const MODEL = PROVIDER === 'groq' ? (process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b') : (process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b');
// Reasoning models (qwen3, ...): OLLAMA_THINK=false turns their thinking trace off; unset leaves the request unchanged.
const THINK = process.env.OLLAMA_THINK === undefined ? undefined : process.env.OLLAMA_THINK === 'true';

// Drops a <think>...</think> block if a model emits one inline, so it never reaches a Dockerfile or a plan.
export const stripThinking = (t: string) => t.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();

export const DELTA_MS = 70;
export const END_TEXT_MAX = 12_000;

const DEFAULT_LABEL: Partial<Record<NodeId, string>> = {
  analyze: 'Planning services',
  dockerfile: 'Writing Dockerfile',
  build: 'Diagnosing build failure',
  smoke: 'Diagnosing smoke test',
  health: 'Diagnosing health check',
};

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (PROVIDER === 'groq') return chatGroq(messages, opts);
  const call = track(llmScope.getStore(), opts);
  let text = '';
  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: true,
        think: THINK,
        format: opts.json ? 'json' : undefined,
        options: { temperature: opts.temperature ?? 0.2, num_ctx: opts.numCtx ?? 8192 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const out = await readStream(res, (chunk) => {
      text += chunk;
      call?.delta(chunk);
    });
    const answer = stripThinking(out.text);
    call?.end(true, answer, out.tokens);
    return answer;
  } catch (err) {
    call?.end(false, text);
    throw err;
  }
}

export async function chatJson<T>(messages: ChatMessage[], opts: Omit<ChatOptions, 'json'> = {}): Promise<T> {
  return JSON.parse(await chat(messages, { ...opts, json: true })) as T;
}

interface Chunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
  eval_count?: number;
}

// Parses Ollama's NDJSON stream. Throws on an error line or a stream that ends before done.
export async function readStream(res: Response, onText: (t: string) => void): Promise<{ text: string; tokens: number }> {
  let text = '';
  let tokens = 0;
  let done = false;
  let buf = '';
  const line = (raw: string) => {
    if (!raw.trim() || done) return;
    const c = JSON.parse(raw) as Chunk;
    if (c.error) throw new Error(`Ollama: ${c.error}`);
    const t = c.message?.content ?? '';
    if (t) {
      text += t;
      tokens++;
      onText(t);
    }
    if (c.done) {
      done = true;
      if (typeof c.eval_count === 'number') tokens = c.eval_count;
    }
  };
  if (!res.body) {
    for (const l of (await res.text()).split('\n')) line(l);
  } else {
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { value, done: eof } = await reader.read();
      buf += decoder.decode(value, { stream: !eof });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) line(l);
      if (eof) break;
    }
    line(buf);
  }
  if (!done) throw new Error('Ollama stream ended before the reply was complete');
  return { text, tokens };
}

// start/end go to the run history; deltas are batched every DELTA_MS and only broadcast (see RunStore.emit).
function track(scope: LlmScope | undefined, opts: ChatOptions) {
  if (!scope) return undefined;
  const id = nanoid(8);
  const { node } = scope;
  const service = opts.service ?? scope.service;
  const label = `${opts.label ?? DEFAULT_LABEL[node] ?? `Model call · ${node}`}${service ? ` · ${service}` : ''}`;
  const t0 = Date.now();
  let pending = '';
  let pendingThinking = '';
  let tokens = 0;
  let timer: NodeJS.Timeout | undefined;
  let ended = false;
  const send = (e: Omit<Extract<RunEvent, { type: 'llm' }>, 'type' | 'id' | 'node' | 'service' | 'label'>) => {
    try {
      scope.emit({ type: 'llm', id, node, ...(service ? { service } : {}), label, ...e });
    } catch {
      // the UI stream must never break a model call
    }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!pending && !pendingThinking) return;
    send({ phase: 'delta', text: pending, ...(pendingThinking ? { thinking: pendingThinking } : {}), tokens, ms: Date.now() - t0 });
    pending = '';
    pendingThinking = '';
  };
  send({ phase: 'start' });
  return {
    delta(t: string, thinking = false) {
      if (ended) return;
      if (thinking) pendingThinking += t;
      else pending += t;
      tokens++;
      timer ??= setTimeout(flush, DELTA_MS);
    },
    end(ok: boolean, text: string, total = tokens) {
      if (ended) return;
      flush();
      ended = true;
      const capped = text.length > END_TEXT_MAX ? `${text.slice(0, END_TEXT_MAX)}\n…` : text;
      send({ phase: 'end', ok, text: capped, ms: Date.now() - t0, tokens: total });
    },
  };
}

export async function ollamaReady(): Promise<boolean> {
  if (PROVIDER === 'groq') return groqReady();
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const { models } = (await res.json()) as { models: Array<{ name: string }> };
    return models.some((m) => m.name === MODEL);
  } catch {
    return false;
  }
}

// --- Groq (OpenAI-compatible API, server-sent events) ---------------------------------------

const groqKey = () => process.env.GROQ_API_KEY ?? '';

// Reasoning models stream their reasoning separately from the answer, so it can be shown but never
// ends up in a Dockerfile or plan. gpt-oss takes include_reasoning; other reasoning models take reasoning_format.
function reasoningParams(model: string): Record<string, unknown> {
  if (model.startsWith('openai/gpt-oss')) return { include_reasoning: true, reasoning_effort: process.env.GROQ_REASONING_EFFORT ?? 'medium' };
  if (/qwen3/i.test(model)) return { reasoning_format: 'parsed' };
  return {};
}

async function chatGroq(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const call = track(llmScope.getStore(), opts);
  let text = '';
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${GROQ_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${groqKey()}` },
        signal: opts.signal,
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: true,
          temperature: opts.temperature ?? 0.2,
          max_completion_tokens: 8192,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          ...reasoningParams(MODEL),
        }),
      });
      // Free-tier rate limits: wait as told and retry a few times.
      if (res.status === 429 && attempt < 4) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt * 2, 30);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const out = await readSse(res, (chunk, thinking) => {
        if (!thinking) text += chunk;
        call?.delta(chunk, thinking);
      });
      const answer = stripThinking(out.text);
      call?.end(true, answer, out.tokens);
      return answer;
    }
  } catch (err) {
    call?.end(false, text);
    throw err;
  }
}

interface SseChunk {
  choices?: Array<{ delta?: { content?: string | null; reasoning?: string | null }; finish_reason?: string | null }>;
  x_groq?: { usage?: { completion_tokens?: number }; error?: string };
  usage?: { completion_tokens?: number };
  error?: { message?: string };
}

// Parses an OpenAI-style SSE stream: "data: {json}" lines ending with "data: [DONE]".
export async function readSse(res: Response, onText: (t: string, thinking: boolean) => void): Promise<{ text: string; tokens: number }> {
  let text = '';
  let tokens = 0;
  let done = false;
  let buf = '';
  const line = (raw: string) => {
    const l = raw.trim();
    if (!l.startsWith('data:') || done) return;
    const data = l.slice(5).trim();
    if (data === '[DONE]') { done = true; return; }
    const c = JSON.parse(data) as SseChunk;
    if (c.error?.message || c.x_groq?.error) throw new Error(`Groq: ${c.error?.message ?? c.x_groq?.error}`);
    const d = c.choices?.[0]?.delta;
    if (d?.reasoning) onText(d.reasoning, true);
    if (d?.content) {
      text += d.content;
      tokens++;
      onText(d.content, false);
    }
    const used = c.x_groq?.usage?.completion_tokens ?? c.usage?.completion_tokens;
    if (typeof used === 'number') tokens = used;
  };
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  for (;;) {
    const { value, done: eof } = await reader.read();
    buf += decoder.decode(value, { stream: !eof });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) line(l);
    if (eof) break;
  }
  line(buf);
  if (!done) throw new Error('Groq stream ended before the reply was complete');
  return { text, tokens };
}

let groqOk: { at: number; ok: boolean } | undefined;
async function groqReady(): Promise<boolean> {
  if (groqOk && Date.now() - groqOk.at < 60_000) return groqOk.ok;
  try {
    const res = await fetch(`${GROQ_URL}/models/${encodeURIComponent(MODEL)}`, { headers: { authorization: `Bearer ${groqKey()}` }, signal: AbortSignal.timeout(5000) });
    groqOk = { at: Date.now(), ok: res.ok };
  } catch {
    groqOk = { at: Date.now(), ok: false };
  }
  return groqOk.ok;
}
