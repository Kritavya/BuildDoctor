import { PIPELINE } from './contract'
import type {
  ApprovalRequest, DeployOutputs, Diagnosis, NodeId, NodeStatus, RunEvent,
} from './contract'

export interface NodeView {
  status: NodeStatus
  summary?: string
  attempt?: number
  outputs: unknown[]
  diagnoses: Array<Diagnosis & { attempt: number; to: NodeId }>
}

export interface LogEntry {
  id: number
  node: NodeId
  line: string
  ts: number
}

export interface RetryMark {
  attempt: number
  seq: number
}

export type Phase = 'setup' | 'starting' | 'running' | 'awaiting-approval' | 'live' | 'failed' | 'torn-down'

export interface RunUi {
  phase: Phase
  runId?: string
  nodes: Record<NodeId, NodeView>
  logs: LogEntry[]
  retries: Record<string, RetryMark>
  retrySeq: number
  approval?: ApprovalRequest
  done?: { status: 'live' | 'failed'; appUrl?: string; diagnosis?: Diagnosis }
  dashboard?: DeployOutputs['dashboard']
  deleted?: string[]
}

export type Action =
  | { kind: 'reset' }
  | { kind: 'replay' }
  | { kind: 'starting' }
  | { kind: 'started'; runId: string }
  | { kind: 'event'; ev: RunEvent }
  | { kind: 'approvalSent'; approved: boolean }
  | { kind: 'dashboard'; value: DeployOutputs['dashboard'] }
  | { kind: 'tornDown'; deleted: string[] }

export const retryKey = (from: NodeId, to: NodeId) => `${from}->${to}`

function freshNodes(): Record<NodeId, NodeView> {
  const out = {} as Record<NodeId, NodeView>
  for (const id of PIPELINE) out[id] = { status: 'idle', outputs: [], diagnoses: [] }
  return out
}

export function initialRun(): RunUi {
  return { phase: 'setup', nodes: freshNodes(), logs: [], retries: {}, retrySeq: 0 }
}

let logSeq = 0

function patchNode(s: RunUi, id: NodeId, patch: (n: NodeView) => NodeView): RunUi {
  return { ...s, nodes: { ...s.nodes, [id]: patch(s.nodes[id]) } }
}

function applyEvent(s: RunUi, ev: RunEvent): RunUi {
  switch (ev.type) {
    case 'node':
      // A decided approval step means the prompt is over (also covers history replays).
      if (ev.node === 'approve' && (ev.status === 'success' || ev.status === 'failed') && s.phase === 'awaiting-approval') {
        s = { ...s, approval: undefined, phase: 'running' }
      }
      return patchNode(s, ev.node, (n) => ({
        ...n,
        status: ev.status,
        summary: ev.summary ?? n.summary,
        attempt: ev.attempt ?? n.attempt,
      }))
    case 'log': {
      const logs = s.logs.length > 4000 ? s.logs.slice(-3000) : s.logs
      return { ...s, logs: [...logs, { id: ++logSeq, node: ev.node, line: ev.line, ts: ev.ts }] }
    }
    case 'output':
      return patchNode(s, ev.node, (n) => ({ ...n, outputs: [...n.outputs, ev.data] }))
    case 'retry': {
      const seq = s.retrySeq + 1
      const next = patchNode(s, ev.from, (n) => ({
        ...n,
        diagnoses: [...n.diagnoses, { ...ev.diagnosis, attempt: ev.attempt, to: ev.to }],
      }))
      return {
        ...next,
        retrySeq: seq,
        retries: { ...next.retries, [retryKey(ev.from, ev.to)]: { attempt: ev.attempt, seq } },
      }
    }
    case 'approval':
      return { ...s, phase: 'awaiting-approval', approval: ev.request }
    case 'done': {
      // Surface the final diagnosis on the step that failed so its panel can show it.
      if (ev.diagnosis) {
        const failed = PIPELINE.filter((id) => s.nodes[id].status === 'failed').pop()
        if (failed) s = patchNode(s, failed, (n) => ({ ...n, outputs: [...n.outputs, ev.diagnosis] }))
      }
      return {
        ...s,
        phase: ev.status,
        approval: undefined,
        done: { status: ev.status, appUrl: ev.appUrl, diagnosis: ev.diagnosis },
      }
    }
  }
}

export function reducer(s: RunUi, a: Action): RunUi {
  switch (a.kind) {
    case 'reset':
      return initialRun()
    case 'replay':
      // stream reconnected: the server replays every event, so rebuild from scratch
      return { ...initialRun(), phase: 'running', runId: s.runId, dashboard: s.dashboard }
    case 'starting':
      return { ...initialRun(), phase: 'starting' }
    case 'started':
      return { ...s, phase: 'running', runId: a.runId }
    case 'event':
      return applyEvent(s, a.ev)
    case 'approvalSent':
      return { ...s, approval: undefined, phase: a.approved ? 'running' : s.phase }
    case 'dashboard':
      return { ...s, dashboard: a.value }
    case 'tornDown':
      return { ...s, phase: 'torn-down', deleted: a.deleted }
  }
}

/** Latest output of a node, optionally narrowed by a type guard. */
export function latestOutput(n: NodeView): unknown {
  return n.outputs.length ? n.outputs[n.outputs.length - 1] : undefined
}
