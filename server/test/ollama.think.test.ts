import { describe, expect, it } from 'vitest';
import { stripThinking } from '../src/llm/ollama.js';

describe('stripThinking', () => {
  it('removes an inline thinking block and keeps the answer', () => {
    expect(stripThinking('<think>\nplan the ports\n</think>\n\nFROM node:20-slim')).toBe('FROM node:20-slim');
  });
  it('leaves normal output untouched', () => {
    expect(stripThinking('{"services":[]}')).toBe('{"services":[]}');
  });
});
