import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/aws/steps.js', () => ({
  awsSteps: [],
  plannedActions: () => ['plan'],
  setDashboard: vi.fn(async (run: { outputs: { dashboard?: unknown } }, enabled: boolean) => (run.outputs.dashboard = { enabled })),
  teardown: vi.fn(async () => ['EC2 instance i-1 terminated']),
}));
import { createApp } from '../src/index.js';
import { Engine } from '../src/pipeline/engine.js';
import { RunStore } from '../src/pipeline/store.js';

const store = new RunStore();
const engine = new Engine(store, []);
let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

beforeAll(async () => {
  server = createApp(store, engine).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const cfg = { repoUrl: 'https://user:tok3n@github.com/x/y', aws: { region: 'ap-south-1', instanceType: 't4g.micro' as const, openPorts: [] } };
const post = (p: string, body?: unknown) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

describe('api', () => {
  it('dashboard toggle requires a live run and is mirrored into the event stream', async () => {
    const run = store.create(cfg);
    run.status = 'failed';
    expect((await post(`/api/runs/${run.id}/dashboard`, { enabled: true })).status).toBe(409);
    run.status = 'live';
    const res = await post(`/api/runs/${run.id}/dashboard`, { enabled: true });
    expect(await res.json()).toEqual({ enabled: true });
    expect(store.events(run.id)).toContainEqual({ type: 'output', node: 'dashboard', data: { enabled: true } });
    expect(store.get(run.id)!.nodes.dashboard.summary).toBe('Metrics and logs running');
  });

  it('teardown logs each result line and marks the run torn down', async () => {
    const run = store.create(cfg);
    run.status = 'live';
    expect(await (await post(`/api/runs/${run.id}/teardown`)).json()).toEqual({ deleted: ['EC2 instance i-1 terminated'] });
    expect(run.status).toBe('torn-down');
    expect(store.events(run.id)).toContainEqual(expect.objectContaining({ type: 'log', line: 'teardown: EC2 instance i-1 terminated' }));
  });

  it('never returns credentials embedded in the repo URL', async () => {
    const run = store.create({ ...cfg, env: { SECRET: 'v4lue' } });
    const body = await (await fetch(`${base}/api/runs/${run.id}`)).text();
    const list = await (await fetch(`${base}/api/runs`)).text();
    for (const t of [body, list]) {
      expect(t).not.toContain('tok3n');
      expect(t).not.toContain('v4lue');
    }
  });
});
