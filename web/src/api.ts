import type { DeployOutputs, RunConfig, RunEvent } from './contract'
import { createMockBackend } from './mock'

export interface LocalHealth {
  docker: boolean
  ollama: boolean
  model: string
  awsAccount?: string
}

export interface Backend {
  mock: boolean
  health(): Promise<LocalHealth>
  start(cfg: RunConfig): Promise<string>
  /** onReplay fires when the stream reconnects; the server then replays the whole history. */
  subscribe(id: string, onEvent: (ev: RunEvent) => void, onReplay?: () => void): () => void
  approve(id: string, approved: boolean): Promise<void>
  dashboard(id: string, enabled: boolean): Promise<DeployOutputs['dashboard']>
  teardown(id: string): Promise<{ deleted: string[] }>
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `Server answered ${res.status}`)
  }
  return res.json() as Promise<T>
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

const realBackend: Backend = {
  mock: false,
  health: () => fetch('/api/health/local').then((r) => json<LocalHealth>(r)),
  start: (cfg) => post('/api/runs', cfg).then((r) => json<{ id: string }>(r)).then((r) => r.id),
  subscribe(id, onEvent, onReplay) {
    const es = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`)
    let opened = false
    let finished = false
    es.onopen = () => {
      if (opened) onReplay?.()
      opened = true
    }
    es.onmessage = (m) => {
      let ev: RunEvent
      try {
        ev = JSON.parse(m.data) as RunEvent
      } catch {
        return // ignore malformed frames
      }
      if (ev.type === 'done') finished = true
      onEvent(ev)
    }
    // The browser reconnects on its own; once the run has finished there is nothing left to wait for.
    es.onerror = () => {
      if (finished) es.close()
    }
    return () => es.close()
  },
  approve: (id, approved) => post(`/api/runs/${id}/approve`, { approved }).then((r) => {
    if (!r.ok) throw new Error(`Server answered ${r.status}`)
  }),
  dashboard: (id, enabled) =>
    post(`/api/runs/${id}/dashboard`, { enabled }).then((r) => json<DeployOutputs['dashboard']>(r)),
  teardown: (id) => post(`/api/runs/${id}/teardown`).then((r) => json<{ deleted: string[] }>(r)),
}

export const params = new URLSearchParams(window.location.search)
export const isMock = params.get('mock') === '1'

export const backend: Backend = isMock
  ? createMockBackend({
      step: params.get('step') ?? undefined,
      play: params.get('play') === '1',
      speed: Number(params.get('speed') ?? '1') || 1,
    })
  : realBackend
