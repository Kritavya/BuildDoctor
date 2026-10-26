import { describe, expect, it } from 'vitest';
import { readSse } from '../src/llm/ollama.js';

const sse = (lines: string[]) => new Response(lines.map((l) => `data: ${l}\n\n`).join(''));

describe('readSse (Groq stream)', () => {
  it('separates reasoning from the answer and reads the token count', async () => {
    const seen: Array<[string, boolean]> = [];
    const out = await readSse(
      sse([
        JSON.stringify({ choices: [{ delta: { reasoning: 'two packages, ' } }] }),
        JSON.stringify({ choices: [{ delta: { content: 'FROM node' } }] }),
        JSON.stringify({ choices: [{ delta: { content: ':20-slim' } }], x_groq: { usage: { completion_tokens: 42 } } }),
        '[DONE]',
      ]),
      (t, thinking) => seen.push([t, thinking]),
    );
    expect(out).toEqual({ text: 'FROM node:20-slim', tokens: 42 });
    expect(seen[0]).toEqual(['two packages, ', true]);
  });
  it('throws when the stream ends without [DONE]', async () => {
    await expect(readSse(sse([JSON.stringify({ choices: [{ delta: { content: 'x' } }] })]), () => {})).rejects.toThrow(/ended/);
  });
});
