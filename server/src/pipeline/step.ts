import type { ConfigPatch, NodeId, RunState, RunEvent, Diagnosis } from '../types.js';

export interface StepContext {
  run: RunState;
  workdir: string;                       // cloned repo path: workspaces/<runId>/repo
  log: (line: string) => void;           // streams a 'log' event for the current node
  emit: (e: RunEvent) => void;
  signal: AbortSignal;
}

export type StepResult =
  | { ok: true; summary: string; output?: unknown }
  // retryFrom: node the doctor loop should resume at after applying a fix.
  // patch: runtime-config change applied to run.config before resuming (see applyPatch in the engine).
  | { ok: false; summary: string; error: string; retryFrom?: NodeId; diagnosis?: Diagnosis; patch?: ConfigPatch };

export interface Step {
  id: NodeId;
  run(ctx: StepContext): Promise<StepResult>;
}
