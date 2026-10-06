import { describe, expect, it } from 'vitest';
import { Engine, failures } from '../src/pipeline/engine.js';
import type { Step, StepResult } from '../src/pipeline/step.js';
import { RunStore } from '../src/pipeline/store.js';
import { PIPELINE, type NodeId, type RunConfig, type RunEvent } from '../src/types.js';

const config = (over: Partial<RunConfig> = {}): RunConfig => ({
  repoUrl: 'https://github.com/x/y',
  appPort: 3000,
  aws: { region: 'ap-south-1', instanceType: 't4g.small', openPorts: [22] },
  ...over,
});

function fakeSteps(calls: NodeId[], override: Partial<Record<NodeId, (n: number) => StepResult>> = {}): Step[] {
  const count = new Map<NodeId, number>();
  return PIPELINE.map((id) => ({
    id,
    async run(ctx) {
      calls.push(id);
      const n = (count.get(id) ?? 0) + 1;
      count.set(id, n);
      ctx.log(`${id} ran`);
      return override[id]?.(n) ?? { ok: true, summary: `${id} ok` };
    },
  }));
}

function setup(steps: Step[], cfg = config()) {
  const store = new RunStore();
  const engine = new Engine(store, steps, { workspaceRoot: '/tmp/bd-test' });
  const run = store.create(cfg);
  const events: RunEvent[] = [];
  store.subscribe(run.id, (e) => events.push(e));
  return { store, engine, run, events };
}

const waitFor = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pred()).toBe(true);
};

describe('engine', () => {
  it('runs every node in PIPELINE order and pauses at approve', async () => {
    const calls: NodeId[] = [];
    const { engine, run, events } = setup(fakeSteps(calls));
    const done = engine.start(run);
    await waitFor(() => run.status === 'awaiting-approval');
    expect(calls).toEqual(['clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke']);
    expect(run.nodes.approve.status).toBe('waiting');
    const approval = events.find((e) => e.type === 'approval');
    expect(approval).toBeDefined();
    const actions = (approval as { request: { actions: string[] } }).request.actions.join('\n');
    expect(actions).toMatch(/ECR repository/);
    expect(actions).toMatch(/Create new security group .*TCP 22, TCP 3000/);
    expect(actions).toMatch(/Launch new EC2 instance t4g.small .*ap-south-1/);
    expect(actions).toMatch(/IAM role/);

    expect(engine.approve(run.id, true)).toBe(true);
    await done;
    expect(calls).toEqual(PIPELINE);
    expect(run.status).toBe('live');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'live' });
    expect(PIPELINE.every((n) => run.nodes[n].status === 'success')).toBe(true);
    expect(run.nodes.build.logs).toEqual(['build ran']);
  });

  it('approval request reflects existing resources', async () => {
    const { engine, run, events } = setup(fakeSteps([]), config({ aws: { region: 'us-east-1', instanceType: 't4g.micro', openPorts: [], existingInstanceId: 'i-123', existingSecurityGroupId: 'sg-9' } }));
    const done = engine.start(run);
    await waitFor(() => run.status === 'awaiting-approval');
    const { actions } = (events.find((e) => e.type === 'approval') as { request: { actions: string[] } }).request;
    expect(actions.join('\n')).toMatch(/Reuse existing security group sg-9/);
    expect(actions.join('\n')).toMatch(/Reuse existing EC2 instance i-123/);
    engine.approve(run.id, true);
    await done;
  });

  it('uses an injected approval plan when given', async () => {
    const store = new RunStore();
    const engine = new Engine(store, fakeSteps([]), { planApproval: () => ({ actions: ['custom plan'] }) });
    const run = store.create(config());
    const done = engine.start(run);
    await waitFor(() => run.status === 'awaiting-approval');
    expect(store.events(run.id).find((e) => e.type === 'approval')).toEqual({ type: 'approval', request: { actions: ['custom plan'] } });
    engine.approve(run.id, true);
    await done;
  });

  it('denied approval fails cleanly without running AWS steps', async () => {
    const calls: NodeId[] = [];
    const { engine, run, events } = setup(fakeSteps(calls));
    const done = engine.start(run);
    await waitFor(() => run.status === 'awaiting-approval');
    engine.approve(run.id, false);
    await done;
    expect(calls).not.toContain('ecr');
    expect(run.status).toBe('failed');
    expect(run.nodes.approve.status).toBe('failed');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed', diagnosis: { rootCause: expect.stringMatching(/declined/) } });
  });

  it('doctor loop: retries from retryFrom and recovers', async () => {
    const calls: NodeId[] = [];
    const diagnosis = { rootCause: 'wrong CMD', evidence: 'Cannot find module', attemptedFix: 'fix CMD', result: 'not-fixed' as const };
    const steps = fakeSteps(calls, {
      smoke: (n) => (n < 3 ? { ok: false, summary: 'exited', error: 'Error: Cannot find module', retryFrom: 'dockerfile', diagnosis } : { ok: true, summary: 'up' }),
    });
    const { engine, run, events } = setup(steps);
    const seen: Array<string | undefined> = [];
    // The dockerfile step sees the pending failure on re-entry.
    const df = steps.find((s) => s.id === 'dockerfile')!;
    const orig = df.run.bind(df);
    df.run = async (ctx) => {
      seen.push(failures.get(ctx.run)?.pending?.error);
      return orig(ctx);
    };
    const done = engine.start(run);
    await waitFor(() => run.status === 'awaiting-approval');
    engine.approve(run.id, true);
    await done;

    const retries = events.filter((e) => e.type === 'retry');
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ from: 'smoke', to: 'dockerfile', attempt: 1, diagnosis });
    expect(seen).toEqual([undefined, 'Error: Cannot find module', 'Error: Cannot find module']);
    expect(calls.slice(0, 12)).toEqual(['clone', 'analyze', 'dockerfile', 'lint', 'build', 'smoke', 'dockerfile', 'lint', 'build', 'smoke', 'dockerfile', 'lint']);
    expect(run.nodes.smoke.attempt).toBe(3);
    expect(run.status).toBe('live');
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'live', diagnosis: { result: 'fixed' } });
  });

  it('doctor loop: caps at maxFixAttempts then fails with the diagnosis', async () => {
    const calls: NodeId[] = [];
    const diagnosis = { rootCause: 'missing dep', evidence: 'x', attemptedFix: 'y', result: 'not-fixed' as const };
    const steps = fakeSteps(calls, { build: () => ({ ok: false, summary: 'build failed', error: 'boom', retryFrom: 'dockerfile', diagnosis }) });
    const { engine, run, events } = setup(steps, config({ maxFixAttempts: 2 }));
    await engine.start(run);
    expect(calls.filter((c) => c === 'build')).toHaveLength(3);
    expect(events.filter((e) => e.type === 'retry')).toHaveLength(2);
    expect(calls).not.toContain('smoke');
    expect(run.status).toBe('failed');
    expect(run.nodes.build.status).toBe('failed');
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', status: 'failed', diagnosis: { rootCause: 'missing dep', result: 'not-fixed' } });
    expect((done as { diagnosis: { nextStep: string } }).diagnosis.nextStep).toMatch(/2 fix attempts/);
  });

  it('failure without retryFrom stops immediately; thrown errors become failures', async () => {
    const calls: NodeId[] = [];
    const steps = fakeSteps(calls);
    steps[1] = { id: 'analyze', run: async () => { throw new Error('kaboom'); } };
    const { engine, run, events } = setup(steps);
    await engine.start(run);
    expect(calls).toEqual(['clone']);
    expect(events.at(-1)).toMatchObject({ type: 'done', status: 'failed', diagnosis: { evidence: 'kaboom' } });
  });

  it('runs only the requested node subset and replays history to late subscribers', async () => {
    const calls: NodeId[] = [];
    const store = new RunStore();
    const engine = new Engine(store, fakeSteps(calls), { nodes: ['analyze', 'build'] });
    const run = store.create(config());
    await engine.start(run);
    expect(calls).toEqual(['analyze', 'build']);
    expect(run.nodes.clone.status).toBe('skipped');
    const replay: RunEvent[] = [];
    store.subscribe(run.id, (e) => replay.push(e));
    expect(replay).toEqual(store.events(run.id));
    expect(replay.at(-1)).toMatchObject({ type: 'done', status: 'live' });
  });
});
