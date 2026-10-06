import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERRUPTED, RunStore } from '../src/pipeline/store.js';
import { PIPELINE, type RunConfig } from '../src/types.js';

const cfg: RunConfig = { repoUrl: 'https://github.com/x/y', aws: { region: 'ap-south-1', instanceType: 't4g.micro', openPorts: [] } };

describe('RunStore persistence', () => {
  it('debounces atomic writes, flushes on done, and reloads runs', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bd-store-'));
    const a = new RunStore(dir);
    const run = a.create(cfg);
    a.emit(run.id, { type: 'node', node: 'clone', status: 'success', summary: 'ok' });
    expect(readdirSync(dir)).toEqual([]); // debounced
    await new Promise((r) => setTimeout(r, 400));
    expect(readdirSync(dir)).toEqual([`${run.id}.json`]); // no tmp file left behind
    run.status = 'live';
    a.emit(run.id, { type: 'done', status: 'live', appUrl: 'http://1.2.3.4:3000/' });
    expect(JSON.parse(readFileSync(path.join(dir, `${run.id}.json`), 'utf8')).run.status).toBe('live'); // final flush is immediate

    const b = new RunStore(dir);
    expect(b.get(run.id)).toMatchObject({ status: 'live', nodes: { clone: { status: 'success' } } });
    expect(b.events(run.id)).toEqual(a.events(run.id));
  });

  it('marks interrupted runs failed but keeps outputs.created for teardown', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bd-store-'));
    const a = new RunStore(dir);
    const run = a.create(cfg);
    a.emit(run.id, { type: 'node', node: 'ec2', status: 'running' });
    run.outputs.created.push({ type: 'ec2', id: 'i-1' });
    run.outputs.instanceId = 'i-1';
    a.touch(run.id);
    a.flush();

    const b = new RunStore(dir);
    const loaded = b.get(run.id)!;
    expect(loaded.status).toBe('failed');
    expect(loaded.nodes.ec2).toMatchObject({ status: 'failed', summary: INTERRUPTED });
    expect(loaded.nodes.deploy.status).toBe('skipped');
    expect(PIPELINE.every((n) => ['success', 'failed', 'skipped'].includes(loaded.nodes[n].status))).toBe(true);
    expect(loaded.outputs.created).toEqual([{ type: 'ec2', id: 'i-1' }]);
    expect(b.events(run.id).at(-1)).toMatchObject({ type: 'done', status: 'failed', diagnosis: { rootCause: INTERRUPTED } });
    // The interruption itself is persisted, so a second restart does not repeat it.
    expect(new RunStore(dir).events(run.id).filter((e) => e.type === 'done')).toHaveLength(1);
  });
});
