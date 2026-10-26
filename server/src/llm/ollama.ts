// Thin client for the local Ollama server. All LLM calls go through here.
// Calls always stream (NDJSON); inside an llmScope each call is mirrored as 'llm' run events.
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
export const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';

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
        format: opts.json ? 'json' : undefined,
        options: { temperature: opts.temperature ?? 0.2, num_ctx: opts.numCtx ?? 8192 },
      }),
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    const out = await readStream(res, (chunk) => {
      text += chunk;
      call?.delta(chunk);
    });
    call?.end(true, out.text, out.tokens);
    return out.text;
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
    if (!pending) return;
    send({ phase: 'delta', text: pending, tokens, ms: Date.now() - t0 });
    pending = '';
  };
  send({ phase: 'start' });
  return {
    delta(t: string) {
      if (ended) return;
      pending += t;
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
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const { models } = (await res.json()) as { models: Array<{ name: string }> };
    return models.some((m) => m.name === MODEL);
  } catch {
    return false;
  }
}
