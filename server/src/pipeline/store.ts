// In-memory run store with per-run event history. SSE subscribers get the history replayed, then live events.
import { nanoid } from 'nanoid';
import { PIPELINE, type NodeId, type RunConfig, type RunEvent, type RunState } from '../types.js';

type Listener = (e: RunEvent) => void;

const MAX_LOG_LINES = 2000;

export class RunStore {
  private runs = new Map<string, RunState>();
  private history = new Map<string, RunEvent[]>();
  private listeners = new Map<string, Set<Listener>>();

  create(config: RunConfig, id = nanoid(10).toLowerCase().replace(/[^a-z0-9]/g, 'x')): RunState {
    const nodes = Object.fromEntries(PIPELINE.map((n) => [n, { status: 'idle', logs: [] }])) as unknown as RunState['nodes'];
    const run: RunState = { id, config, nodes, outputs: { created: [] }, status: 'running', createdAt: Date.now() };
    this.runs.set(id, run);
    this.history.set(id, []);
    this.listeners.set(id, new Set());
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
