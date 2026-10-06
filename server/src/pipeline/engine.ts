// Runs the pipeline for a run: node ordering, doctor-loop retries and the approval gate.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE, type ApprovalRequest, type Diagnosis, type NodeId, type RunState } from '../types.js';
import type { Step, StepContext } from './step.js';
import type { RunStore } from './store.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const WORKSPACES = process.env.WORKSPACES_DIR ?? path.join(REPO_ROOT, 'workspaces');

export interface Failure {
  node: NodeId;      // step that failed
  error: string;     // error / log tail from the step
  diagnosis?: Diagnosis;
  attempt: number;   // retry number this failure triggered
}

// Failures the doctor loop is retrying from. The step at retryFrom reads (and clears) `pending`;
// `history` keeps every failure so fix prompts can avoid repeating an earlier attempt.
export const failures = new WeakMap<RunState, { pending?: Failure; history: Failure[] }>();

export interface EngineOptions {
  nodes?: NodeId[];          // subset of PIPELINE to run (in PIPELINE order); default all
  workspaceRoot?: string;
  // Exact AWS plan shown at the approval gate; defaults to approvalRequest() derived from config.
  planApproval?: (run: RunState) => ApprovalRequest;
}

export class Engine {
  private steps: Map<NodeId, Step>;
  private approvals = new Map<string, (approved: boolean) => void>();
  private aborts = new Map<string, AbortController>();
  private nodes: NodeId[];
  private root: string;
  private plan: (run: RunState) => ApprovalRequest;

  constructor(private store: RunStore, steps: Step[], opts: EngineOptions = {}) {
    this.steps = new Map(steps.map((s) => [s.id, s]));
    this.nodes = PIPELINE.filter((n) => !opts.nodes || opts.nodes.includes(n));
    this.root = opts.workspaceRoot ?? WORKSPACES;
    this.plan = opts.planApproval ?? approvalRequest;
  }

  workdir(runId: string): string {
    return path.join(this.root, runId, 'repo');
  }

  approve(runId: string, approved: boolean): boolean {
    const resolve = this.approvals.get(runId);
    if (!resolve) return false;
    this.approvals.delete(runId);
    resolve(approved);
    return true;
  }

  cancel(runId: string): void {
    this.aborts.get(runId)?.abort();
    this.approve(runId, false);
  }

  async start(run: RunState): Promise<void> {
    const ac = new AbortController();
    this.aborts.set(run.id, ac);
    try {
      await this.loop(run, ac.signal);
    } catch (err) {
      this.finish(run, 'failed', {
        rootCause: 'Internal pipeline error',
        evidence: errMsg(err),
        attemptedFix: 'none',
        result: 'not-fixed',
      });
    } finally {
      this.aborts.delete(run.id);
    }
  }

  private async loop(run: RunState, signal: AbortSignal): Promise<void> {
    const emit: StepContext['emit'] = (e) => this.store.emit(run.id, e);
    const max = run.config.maxFixAttempts ?? 3;
    const loops = new Map<NodeId, number>(); // retryFrom target -> retries used
    const state = { history: [] as Failure[] } as { pending?: Failure; history: Failure[] };
    failures.set(run, state);
    let lastDiagnosis: Diagnosis | undefined;

    for (const n of PIPELINE) if (!this.nodes.includes(n)) emit({ type: 'node', node: n, status: 'skipped' });

    let i = 0;
    while (i < this.nodes.length) {
      if (signal.aborted) return this.finish(run, 'failed', cancelled());
      const node = this.nodes[i];
      const step = this.steps.get(node);

      if (node === 'approve') {
        const ok = await this.gate(run, emit);
        if (!ok) {
          emit({ type: 'node', node, status: 'failed', summary: 'Deployment not approved' });
          return this.finish(run, 'failed', {
            rootCause: 'User declined the AWS changes',
            evidence: 'Approval request was denied',
            attemptedFix: 'none',
            result: 'not-fixed',
            nextStep: 'Adjust the AWS configuration and start a new run.',
          });
        }
      }
      if (!step) {
        emit({ type: 'node', node, status: node === 'approve' ? 'success' : 'skipped', summary: node === 'approve' ? 'Approved' : undefined });
        i++;
        continue;
      }

      const attempt = (run.nodes[node].attempt ?? 0) + 1;
      emit({ type: 'node', node, status: 'running', attempt });
      const ctx: StepContext = {
        run,
        workdir: this.workdir(run.id),
        log: (line) => this.store.nodeLog(run.id, node, line),
        emit,
        signal,
      };

      let result;
      try {
        result = await step.run(ctx);
      } catch (err) {
        result = { ok: false as const, summary: `${node} crashed`, error: errMsg(err) };
      }
      if (result.ok && result.output !== undefined) emit({ type: 'output', node, data: result.output });

      if (result.ok) {
        emit({ type: 'node', node, status: 'success', summary: result.summary, attempt });
        i++;
        continue;
      }

      emit({ type: 'node', node, status: 'failed', summary: result.summary, attempt });
      const diagnosis: Diagnosis = result.diagnosis ?? {
        rootCause: result.summary,
        evidence: tail(result.error, 15),
        attemptedFix: 'none',
        result: 'not-fixed',
      };
      lastDiagnosis = diagnosis;
      const to = result.retryFrom;
      const used = to ? loops.get(to) ?? 0 : 0;
      const target = to ? this.nodes.indexOf(to) : -1;

      if (!to || target < 0 || target > i || used >= max || signal.aborted) {
        const final: Diagnosis = {
          ...diagnosis,
          result: 'not-fixed',
          nextStep: diagnosis.nextStep ?? (to && used >= max ? `Gave up after ${max} fix attempts; fix manually and re-run.` : undefined),
        };
        return this.finish(run, 'failed', final);
      }

      loops.set(to, used + 1);
      const failure: Failure = { node, error: result.error, diagnosis, attempt: used + 1 };
      state.pending = failure;
      state.history.push(failure);
      emit({ type: 'retry', from: node, to, attempt: used + 1, diagnosis });
      i = target;
    }

    this.finish(run, 'live', lastDiagnosis && { ...lastDiagnosis, result: 'fixed' });
  }

  // Pauses at the approval node until approve() is called.
  private gate(run: RunState, emit: StepContext['emit']): Promise<boolean> {
    let request: ApprovalRequest;
    try {
      request = this.plan(run);
    } catch {
      request = approvalRequest(run);
    }
    run.status = 'awaiting-approval';
    emit({ type: 'node', node: 'approve', status: 'waiting', summary: 'Waiting for approval' });
    emit({ type: 'output', node: 'approve', data: request });
    emit({ type: 'approval', request });
    return new Promise((resolve) => {
      this.approvals.set(run.id, (ok) => {
        run.status = 'running';
        resolve(ok);
      });
    });
  }

  private finish(run: RunState, status: 'live' | 'failed', diagnosis?: Diagnosis): void {
    run.status = status;
    this.store.emit(run.id, { type: 'done', status, appUrl: status === 'live' ? run.outputs.appUrl : undefined, diagnosis });
  }
}

// Exactly what the AWS steps will create or reuse, derived from the run config.
export function approvalRequest(run: RunState): ApprovalRequest {
  const { aws, env } = run.config;
  const port = run.config.appPort ?? run.analysis?.port;
  const ports = [...new Set([...(port ? [port] : []), ...aws.openPorts])].sort((a, b) => a - b);
  const portList = ports.length ? ports.map((p) => `TCP ${p}`).join(', ') : 'the app port';
  const actions = [
    `Create (or reuse) ECR repository "builddoctor/${run.id}" in ${aws.region} and push image builddoctor/${run.id}:latest`,
    aws.existingSecurityGroupId
      ? `Reuse existing security group ${aws.existingSecurityGroupId} in ${aws.region} (add inbound ${portList} from 0.0.0.0/0 if missing)`
      : `Create new security group in ${aws.region} allowing inbound ${portList} from 0.0.0.0/0`,
    aws.existingInstanceId
      ? `Reuse existing EC2 instance ${aws.existingInstanceId} in ${aws.region} (must be arm64 with SSM agent)`
      : `Launch new EC2 instance ${aws.instanceType} (arm64 Graviton) in ${aws.region}`,
    `Create (or reuse) IAM role + instance profile with AmazonSSMManagedInstanceCore and ECR read access, attached to the instance for SSM`,
    `Run the container on the instance via SSM${port ? `, publishing port ${port}` : ''}${env && Object.keys(env).length ? ` with ${Object.keys(env).length} env var(s): ${Object.keys(env).join(', ')} (values hidden)` : ''}`,
  ];
  return { actions };
}

function cancelled(): Diagnosis {
  return { rootCause: 'Run cancelled', evidence: 'Abort signal received', attemptedFix: 'none', result: 'not-fixed' };
}

export function tail(text: string, lines: number): string {
  return text.split('\n').slice(-lines).join('\n');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
