// Run store with per-run event history. SSE subscribers get the history replayed, then live events.
// With a directory, each run is persisted to <dir>/<id>.json (debounced, atomic) and reloaded on start.
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { PIPELINE, type NodeId, type RunConfig, type RunEvent, type RunState } from '../types.js';

type Listener = (e: RunEvent) => void;

const MAX_LOG_LINES = 2000;
const SAVE_DEBOUNCE_MS = 250;
export const INTERRUPTED = 'Interrupted by server restart';

export class RunStore {
  private runs = new Map<string, RunState>();
  private history = new Map<string, RunEvent[]>();
  private listeners = new Map<string, Set<Listener>>();
  private dirty = new Set<string>();
  private timer?: NodeJS.Timeout;

  constructor(private dir?: string) {
    if (dir) this.load(dir);
  }

  // Runs cut off mid-pipeline cannot resume; they become failed but keep outputs.created for teardown.
  private load(dir: string): void {
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      let saved: { run: RunState; events: RunEvent[] };
      try {
        saved = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      const { run, events } = saved;
      if (!run?.id || !Array.isArray(events)) continue;
      this.runs.set(run.id, run);
      this.history.set(run.id, events);
      this.listeners.set(run.id, new Set());
      if (run.status === 'running' || run.status === 'awaiting-approval') {
        for (const n of PIPELINE) {
          const s = run.nodes[n].status;
          if (s === 'running' || s === 'waiting') this.emit(run.id, { type: 'node', node: n, status: 'failed', summary: INTERRUPTED });
          else if (s === 'idle') this.emit(run.id, { type: 'node', node: n, status: 'skipped' });
        }
        run.status = 'failed';
        this.emit(run.id, { type: 'done', status: 'failed', diagnosis: { rootCause: INTERRUPTED, evidence: 'The server stopped while this run was in progress', attemptedFix: 'none', result: 'not-fixed', nextStep: 'Start a new run; use teardown to remove anything this run created.' } });
      }
    }
    this.flush();
  }

  // Marks a run for saving (call after changing RunState outside emit()).
  touch(id: string): void {
    if (!this.dir || !this.runs.has(id)) return;
    this.dirty.add(id);
    this.timer ??= setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
  }

  // Writes every pending run now: tmp file then rename, so a crash never leaves a torn file.
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dir) return;
    for (const id of this.dirty) {
      const file = path.join(this.dir, `${id}.json`);
      try {
        writeFileSync(`${file}.tmp`, JSON.stringify({ run: this.runs.get(id), events: this.history.get(id) }));
        renameSync(`${file}.tmp`, file);
      } catch {
        // persistence is best effort; the in-memory run stays authoritative
      }
    }
    this.dirty.clear();
  }

  create(config: RunConfig, id = nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, 'x')): RunState {
    const nodes = Object.fromEntries(PIPELINE.map((n) => [n, { status: 'idle', logs: [] }])) as unknown as RunState['nodes'];
    const run: RunState = { id, config, nodes, outputs: { created: [] }, status: 'running', createdAt: Date.now() };
    this.runs.set(id, run);
    this.history.set(id, []);
    this.listeners.set(id, new Set());
    this.touch(id);
    return run;
  }

  get(id: string): RunState | undefined {
    return this.runs.get(id);
  }

  list(): RunState[] {
    return [...this.runs.values()];
  }

  events(id: string): RunEvent[] {
    return this.history.get(id) ?? [];
  }

  // Records the event, mirrors node/log/output events into RunState, and fans out to subscribers.
  emit(id: string, e: RunEvent): void {
    const run = this.runs.get(id);
    if (!run) return;
    if (e.type === 'node') {
      const n = run.nodes[e.node];
      n.status = e.status;
      if (e.summary !== undefined) n.summary = e.summary;
      if (e.attempt !== undefined) n.attempt = e.attempt;
    } else if (e.type === 'log') {
      const logs = run.nodes[e.node].logs;
      logs.push(e.line);
      if (logs.length > MAX_LOG_LINES) logs.splice(0, logs.length - MAX_LOG_LINES);
    } else if (e.type === 'output') {
      run.nodes[e.node].output = e.data;
    }
    this.history.get(id)!.push(e);
    this.touch(id);
    if (e.type === 'done') this.flush();
    for (const l of this.listeners.get(id) ?? []) {
      try {
        l(e);
      } catch {
        // a broken subscriber must not stop the pipeline
      }
    }
  }

  // Replays history synchronously, then streams. Returns an unsubscribe function.
  subscribe(id: string, l: Listener): () => void {
    for (const e of this.events(id)) l(e);
    const set = this.listeners.get(id);
    set?.add(l);
    return () => set?.delete(l);
  }

  nodeLog(id: string, node: NodeId, line: string): void {
    this.emit(id, { type: 'log', node, line, ts: Date.now() });
  }
}
