// Thin client for the local Ollama server. All LLM calls go through here.
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
export const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';

export async function chat(
  messages: ChatMessage[],
  opts: { json?: boolean; temperature?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      format: opts.json ? 'json' : undefined,
      options: { temperature: opts.temperature ?? 0.2, num_ctx: 8192 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { message: { content: string } };
  return body.message.content;
}

export async function chatJson<T>(messages: ChatMessage[], opts: { signal?: AbortSignal } = {}): Promise<T> {
  return JSON.parse(await chat(messages, { ...opts, json: true })) as T;
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
