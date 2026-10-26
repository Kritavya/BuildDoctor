import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { END_TEXT_MAX, chat, chatJson } from '../src/llm/ollama.js';
import { llmScope } from '../src/llm/scope.js';
import { Engine } from '../src/pipeline/engine.js';
import { RunStore } from '../src/pipeline/store.js';
import { PIPELINE, type RunEvent } from '../src/types.js';

type Llm = Extract<RunEvent, { type: 'llm' }>;

// Ollama-style NDJSON body; split into byte chunks at odd places to exercise line buffering.
function ndjson(parts: string[], opts: { done?: boolean; evalCount?: number; error?: string; chunk?: number } = {}): Response {
  const lines = parts.map((p) => JSON.stringify({ message: { role: 'assistant', content: p }, done: false }));
  if (opts.error) lines.push(JSON.stringify({ error: opts.error }));
  if (opts.done !== false && !opts.error) lines.push(JSON.stringify({ message: { content: '' }, done: true, eval_count: opts.evalCount ?? parts.length }));
  const bytes = new TextEncoder().encode(lines.join('\n') + '\n');
  const size = opts.chunk ?? 7;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

const fetchMock = (res: () => Response) => vi.stubGlobal('fetch', vi.fn(async () => res()));

afterEach(() => vi.unstubAllGlobals());

describe('ollama streaming', () => {
  it('assembles the streamed reply and asks Ollama to stream', async () => {
    fetchMock(() => ndjson(['FROM node', ':20\n', 'CMD ["node"]']));
    expect(await chat([{ role: 'user', content: 'x' }])).toBe('FROM node:20\nCMD ["node"]');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(body.stream).toBe(true);
  });

  it('parses JSON replies streamed in pieces (format json)', async () => {
    fetchMock(() => ndjson(['{"servi', 'ces": [{"name":', ' "api"}]}']));
    expect(await chatJson([{ role: 'user', content: 'x' }])).toEqual({ services: [{ name: 'api' }] });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).format).toBe('json');
  });

  it('throws on an error line or a stream cut off before done', async () => {
    fetchMock(() => ndjson(['partial'], { error: 'model crashed' }));
    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/model crashed/);
    fetchMock(() => ndjson(['partial'], { done: false }));
    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/ended before/);
    fetchMock(() => new Response('boom', { status: 500 }));
    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/Ollama 500: boom/);
  });

  it('emits nothing outside a scope', async () => {
    fetchMock(() => ndjson(['ok']));
    expect(await chat([{ role: 'user', content: 'x' }])).toBe('ok');
  });
});

describe('llm events', () => {
  it('attributes calls to the scope and labels them; end carries the full text and token count', async () => {
    const events: Llm[] = [];
    fetchMock(() => ndjson(['a', 'b', 'c'], { evalCount: 42 }));
    const text = await llmScope.run({ runId: 'r1', node: 'dockerfile', service: 'web', emit: (e) => events.push(e as Llm) }, () =>
      chat([{ role: 'user', content: 'SECRET PROMPT' }], { label: 'Writing Dockerfile' }));
    expect(text).toBe('abc');
    expect(events[0]).toMatchObject({ phase: 'start', node: 'dockerfile', service: 'web', label: 'Writing Dockerfile · web' });
    const end = events.at(-1)!;
    expect(end).toMatchObject({ phase: 'end', ok: true, text: 'abc', tokens: 42 });
    expect(events.every((e) => e.id === events[0].id)).toBe(true);
    expect(events.filter((e) => e.phase === 'delta').map((e) => e.text).join('')).toBe('abc');
    expect(JSON.stringify(events)).not.toContain('SECRET PROMPT');
  });

  it('keeps attribution across awaits and concurrent scopes; service option overrides; default label from node', async () => {
    const seen: Llm[] = [];
    fetchMock(() => ndjson(['x']));
    const emit = (e: RunEvent) => seen.push(e as Llm);
    await Promise.all([
      llmScope.run({ runId: 'a', node: 'analyze', emit }, async () => {
        await new Promise((r) => setTimeout(r, 5));
        await chat([{ role: 'user', content: 'x' }]);
      }),
      llmScope.run({ runId: 'b', node: 'build', emit }, () => chat([{ role: 'user', content: 'x' }], { service: 'api' })),
    ]);
    const starts = seen.filter((e) => e.phase === 'start');
    expect(starts.find((e) => e.node === 'analyze')).toMatchObject({ label: 'Planning services' });
    expect(starts.find((e) => e.node === 'build')).toMatchObject({ label: 'Diagnosing build failure · api', service: 'api' });
  });

  it('caps the end text and still returns the whole reply', async () => {
    const events: Llm[] = [];
    const big = 'x'.repeat(END_TEXT_MAX + 500);
    fetchMock(() => ndjson([big.slice(0, 6000), big.slice(6000)], { chunk: 4096 }));
    const text = await llmScope.run({ runId: 'r', node: 'analyze', emit: (e) => events.push(e as Llm) }, () => chat([]));
    expect(text).toBe(big);
    expect(events.at(-1)!.text!.length).toBeLessThan(END_TEXT_MAX + 5);
  });

  it('ends with ok:false and rethrows when the stream fails mid-way', async () => {
    const events: Llm[] = [];
    fetchMock(() => ndjson(['half'], { error: 'oom' }));
    await expect(llmScope.run({ runId: 'r', node: 'analyze', emit: (e) => events.push(e as Llm) }, () => chat([]))).rejects.toThrow(/oom/);
    expect(events.at(-1)).toMatchObject({ phase: 'end', ok: false, text: 'half' });
  });

  it('a throwing subscriber does not break the call', async () => {
    fetchMock(() => ndjson(['fine']));
    const text = await llmScope.run({ runId: 'r', node: 'analyze', emit: () => { throw new Error('ui gone'); } }, () => chat([]));
    expect(text).toBe('fine');
  });
});

describe('engine + store', () => {
  it('engine scopes model calls per step; deltas reach live subscribers but never history or the run file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bd-llm-'));
    const store = new RunStore(dir);
    fetchMock(() => ndjson(['FROM ', 'node', ':20']));
    const steps = PIPELINE.filter((id) => id !== 'approve').map((id) => ({
      id,
      async run() {
        if (id === 'dockerfile') await chat([], { label: 'Writing Dockerfile', service: 'app' });
        return { ok: true as const, summary: 'ok' };
      },
    }));
    const engine = new Engine(store, steps, { workspaceRoot: path.join(dir, 'ws'), nodes: ['clone', 'analyze', 'dockerfile'] });
    const run = store.create({ repoUrl: 'https://github.com/x/y', aws: { region: 'us-east-1', instanceType: 't4g.small', openPorts: [] } });
    const live: RunEvent[] = [];
    store.subscribe(run.id, (e) => live.push(e));
    await engine.start(run);

    const llmLive = live.filter((e): e is Llm => e.type === 'llm');
    expect(llmLive.map((e) => e.phase)).toContain('delta');
    expect(llmLive[0]).toMatchObject({ node: 'dockerfile', label: 'Writing Dockerfile · app' });

    const history = store.events(run.id).filter((e): e is Llm => e.type === 'llm');
    expect(history.map((e) => e.phase)).toEqual(['start', 'end']);
    expect(history[1].text).toBe('FROM node:20');

    store.flush();
    const saved = JSON.parse(readFileSync(path.join(dir, `${run.id}.json`), 'utf8')) as { events: RunEvent[] };
    expect(saved.events.filter((e) => e.type === 'llm').map((e) => (e as Llm).phase)).toEqual(['start', 'end']);

    const replay: RunEvent[] = [];
    store.subscribe(run.id, (e) => replay.push(e));
    expect(replay.some((e) => e.type === 'llm' && e.phase === 'delta')).toBe(false);
  });
});
