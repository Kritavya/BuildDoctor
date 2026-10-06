// Real local pipeline (analyze -> dockerfile -> lint -> build -> smoke) against fixtures,
// with the real model and Docker. Skips when either is unavailable.
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ollamaReady } from '../src/llm/ollama.js';
import { Engine } from '../src/pipeline/engine.js';
import type { Step } from '../src/pipeline/step.js';
import { RunStore } from '../src/pipeline/store.js';
import { docker, imageTag } from '../src/steps/common.js';
import { localSteps } from '../src/steps/index.js';
import type { RunEvent } from '../src/types.js';

const available = (await docker.ping().then(() => true, () => false)) && (await ollamaReady());
const root = await mkdtemp(path.join(os.tmpdir(), 'builddoctor-e2e-'));
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const images: string[] = [];

async function runFixture(name: string, env?: Record<string, string>) {
  const store = new RunStore();
  const copyFixture: Step = {
    id: 'clone',
    async run(ctx) {
      await rm(ctx.workdir, { recursive: true, force: true });
      await cp(path.join(fixtures, name), ctx.workdir, { recursive: true });
      return { ok: true, summary: `copied fixture ${name}` };
    },
  };
  const steps = [copyFixture, ...localSteps.filter((s) => s.id !== 'clone')];
  const engine = new Engine(store, steps, { workspaceRoot: root, nodes: ['clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke'] });
  const run = store.create({ repoUrl: `file://${name}`, env, maxFixAttempts: 3, aws: { region: 'ap-south-1', instanceType: 't4g.small', openPorts: [] } });
  images.push(imageTag(run.id));
  const events: RunEvent[] = [];
  store.subscribe(run.id, (e) => events.push(e));
  await engine.start(run);
  const retries = events.filter((e) => e.type === 'retry');
  const done = events.at(-1) as Extract<RunEvent, { type: 'done' }>;
  console.log(
    `\n===== ${name}: ${done.status} after ${retries.length} fix attempt(s) =====\n` +
      retries.map((r) => `retry ${r.attempt}: ${r.from} -> ${r.to}: ${r.diagnosis.rootCause}`).join('\n') +
      `\n--- dockerfile node log ---\n${run.nodes.dockerfile.logs.filter((l) => !l.startsWith('  ')).join('\n')}` +
      `\n--- final Dockerfile ---\n${run.dockerfile}` +
      `--- node summaries ---\n${(['analyze', 'dockerfile', 'lint', 'build', 'smoke'] as const).map((n) => `${n}: ${run.nodes[n].status} · ${run.nodes[n].summary ?? ''}`).join('\n')}` +
      (done.diagnosis ? `\n--- diagnosis ---\n${JSON.stringify(done.diagnosis, null, 2)}` : ''),
  );
  return { run, events, retries, done };
}

describe.skipIf(!available)('local pipeline e2e (docker + ollama)', () => {
  afterAll(async () => {
    for (const t of images) await docker.getImage(t).remove({ force: true }).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  it('express-app: generates a Dockerfile, builds and serves', { timeout: 15 * 60_000 }, async () => {
    const { run, done } = await runFixture('express-app', { GREETING: 'hi-from-test' });
    expect(done.status).toBe('live');
    expect(run.nodes.smoke.status).toBe('success');
    expect(run.dockerfile).toMatch(/^FROM /m);
    expect((run.nodes.dockerfile.output as { mode: string }).mode).toMatch(/generated|fixed/);
    // env values never appear in logs
    expect(JSON.stringify(run.nodes)).not.toContain('hi-from-test');
  });

  it('fastapi-app: generates a Dockerfile, builds and serves', { timeout: 15 * 60_000 }, async () => {
    const { run, done } = await runFixture('fastapi-app');
    expect(done.status).toBe('live');
    expect(run.nodes.smoke.status).toBe('success');
    expect(run.analysis?.framework).toBe('fastapi');
  });

  it('express-broken: doctor loop repairs the existing Dockerfile or reports honestly', { timeout: 20 * 60_000 }, async () => {
    const { run, done, retries } = await runFixture('express-broken');
    expect((run.nodes.dockerfile.output as { mode: string }).mode).not.toBe('generated');
    expect(retries.length).toBeGreaterThan(0);
    expect(retries[0]).toMatchObject({ from: expect.stringMatching(/smoke|build|lint/), to: 'dockerfile' });
    if (done.status === 'live') {
      expect(done.diagnosis?.result).toBe('fixed');
    } else {
      expect(retries.length).toBe(3);
      expect(done.diagnosis?.rootCause).toBeTruthy();
      expect(done.diagnosis?.result).toBe('not-fixed');
    }
  });
});
