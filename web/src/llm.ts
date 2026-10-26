// Live state of the local model's calls for the current run. Kept outside the run reducer so
// streaming deltas (~14/s) re-render only the model panel, not the canvas.
import type { NodeId, RunEvent } from './contract'

type LlmEvent = Extract<RunEvent, { type: 'llm' }>

export interface LlmCall {
  id: string
  node: NodeId
  service?: string
  label: string
  text: string
  status: 'streaming' | 'done' | 'failed'
  /** client clock when the call started (or was first seen) */
  seenAt: number
  /** server-side elapsed ms and tokens so far; final on end */
  ms: number
  tokens: number
}

export interface LlmState {
  calls: LlmCall[]
  /** the call currently generating, if any */
  active?: string
}

let state: LlmState = { calls: [] }
const listeners = new Set<() => void>()

function set(next: LlmState) {
  state = next
  for (const l of listeners) l()
}

function patch(id: string, f: (c: LlmCall) => LlmCall) {
  set({ ...state, calls: state.calls.map((c) => (c.id === id ? f(c) : c)) })
}

export const llmStore = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => void listeners.delete(l)
  },
  get: () => state,
  /** node currently being written by the model, for the canvas indicator */
  writingNode: (): NodeId | undefined => state.calls.find((c) => c.id === state.active)?.node,
  reset() {
    if (state.calls.length) set({ calls: [] })
  },
  apply(ev: LlmEvent) {
    const known = state.calls.some((c) => c.id === ev.id)
    if (!known) {
      // a delta or end can arrive first after reconnecting mid-call
      const call: LlmCall = {
        id: ev.id, node: ev.node, service: ev.service, label: ev.label, text: '', status: 'streaming',
        seenAt: Date.now() - (ev.ms ?? 0), ms: 0, tokens: 0,
      }
      set({ calls: [...state.calls, call], active: ev.id })
      if (ev.phase === 'start') return
    }
    if (ev.phase === 'delta') {
      patch(ev.id, (c) => ({ ...c, text: c.text + (ev.text ?? ''), ms: ev.ms ?? c.ms, tokens: ev.tokens ?? c.tokens }))
    } else if (ev.phase === 'end') {
      patch(ev.id, (c) => ({
        ...c, text: ev.text ?? c.text, status: ev.ok === false ? 'failed' : 'done', ms: ev.ms ?? c.ms, tokens: ev.tokens ?? c.tokens,
      }))
      if (state.active === ev.id) set({ ...state, active: undefined })
    } else if (known) {
      set({ ...state, active: ev.id })
    }
  },
}
