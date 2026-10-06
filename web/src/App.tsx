import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { CircleCheck, GitBranch, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { backend, isMock, params } from './api'
import type { AnalysisResult, DeployOutputs, NodeId, RunEvent } from './contract'
import { defaultForm, fromRunConfig, repoLabel, toRunConfig, type FormState } from './form'
import { NODE_META } from './meta'
import { initialRun, reducer } from './state'
import { Canvas } from './components/Canvas'
import { Console } from './components/Console'
import { ApprovalModal, TeardownDialog } from './components/Dialogs'
import { Inspector, type InspectorTab } from './components/Inspector'
import { ResultCard } from './components/ResultCard'
import { RunForm } from './components/RunForm'
import { TopBar, type HealthState } from './components/TopBar'

type Toast = { id: number; tone: 'ok' | 'retry' | 'info'; text: string }

const urlNode = params.get('node') as NodeId | null
const urlTab = params.get('tab') as InspectorTab | null
const autoStart = isMock && params.has('step')

export default function App() {
  const [form, setFormState] = useState<FormState>(() => defaultForm(isMock))
  const setForm = useCallback((patch: Partial<FormState>) => setFormState((f) => ({ ...f, ...patch })), [])
  const [run, dispatch] = useReducer(reducer, undefined, initialRun)
  const [health, setHealth] = useState<HealthState>({ status: 'loading' })
  const [selected, setSelected] = useState<NodeId | null>(urlNode && urlNode in NODE_META ? urlNode : null)
  const [formOpen, setFormOpen] = useState(params.get('form') !== '0')
  const [consoleOpen, setConsoleOpen] = useState(params.get('console') === '1')
  const [startError, setStartError] = useState<string>()
  const [approvalHidden, setApprovalHidden] = useState(false)
  const [approving, setApproving] = useState(false)
  const [dashBusy, setDashBusy] = useState(false)
  const [teardownOpen, setTeardownOpen] = useState(false)
  const [tearing, setTearing] = useState(false)
  const [created, setCreated] = useState<DeployOutputs['created'] | null | undefined>()
  const [toasts, setToasts] = useState<Toast[]>([])
  const unsub = useRef<() => void>(undefined)
  const cancelled = useRef(false)
  const quiet = useRef(false) // no toasts while a demo checkpoint fast-forwards

  const toast = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, tone, text }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  useEffect(() => {
    backend.health().then(
      (data) => setHealth({ status: 'ok', data }),
      () => setHealth({ status: 'error' }),
    )
  }, [])

  const onEvent = useCallback((ev: RunEvent) => {
    dispatch({ kind: 'event', ev })
    if (ev.type === 'approval') setApprovalHidden(false)
    if (quiet.current) return
    if (ev.type === 'retry') {
      toast('retry', `${NODE_META[ev.from].title} failed. Fix applied to ${NODE_META[ev.to].title}, trying attempt ${ev.attempt}.`)
    } else if (ev.type === 'done') {
      if (ev.status === 'failed' && cancelled.current) return
      toast(ev.status === 'live' ? 'ok' : 'info', ev.status === 'live' ? 'Your app is live.' : 'The run stopped. See the diagnosis.')
    }
  }, [toast])

  // Follows a run's event stream; the server replays its full history first.
  const follow = useCallback((id: string) => {
    unsub.current?.()
    dispatch({ kind: 'started', runId: id })
    rememberRun(id)
    quiet.current = true
    unsub.current = backend.subscribe(id, onEvent, () => {
      quiet.current = true
      dispatch({ kind: 'replay' })
      window.setTimeout(() => (quiet.current = false), 1000)
    })
    window.setTimeout(() => (quiet.current = false), 1000)
  }, [onEvent])

  // Reopen the last run after a refresh (?run=<id>, else the one remembered in this browser).
  const restored = useRef(false)
  useEffect(() => {
    if (isMock || restored.current) return
    restored.current = true
    const id = params.get('run') ?? readRememberedRun()
    if (!id) return
    backend.getRun(id).then(
      (state) => {
        setFormState(fromRunConfig(state.config))
        setFormOpen(false)
        setConsoleOpen(true)
        follow(id)
      },
      () => rememberRun(undefined),
    )
  }, [follow])

  const deploy = useCallback(async (f: FormState) => {
    setStartError(undefined)
    unsub.current?.()
    dispatch({ kind: 'starting' })
    cancelled.current = false
    try {
      const id = await backend.start(toRunConfig(f))
      if (params.get('form') !== '1') setFormOpen(false)
      if (params.get('console') !== '0') setConsoleOpen(true)
      follow(id)
      quiet.current = false
    } catch (e) {
      dispatch({ kind: 'reset' })
      setStartError(
        e instanceof TypeError || /Failed to fetch|ECONNREFUSED|502|504/.test(String(e))
          ? 'Could not reach the BuildDoctor server on port 4000. Start it with "npm run dev", or open this page with ?mock=1 for a demo run.'
          : `The server refused the run: ${(e as Error).message}`,
      )
    }
  }, [follow])

  // Demo checkpoints (?mock=1&step=...) start on load.
  const started = useRef(false)
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true
      void deploy(form)
    }
  }, [deploy, form])

  useEffect(() => () => unsub.current?.(), [])

  const respond = async (approved: boolean) => {
    if (!run.runId) return
    setApproving(true)
    try {
      cancelled.current = !approved
      await backend.approve(run.runId, approved)
      dispatch({ kind: 'approvalSent', approved })
      toast(approved ? 'ok' : 'info', approved ? 'Approved. Creating AWS resources.' : 'Run cancelled. Nothing was created in AWS.')
    } catch (e) {
      toast('info', `Could not send your answer: ${(e as Error).message}`)
    } finally {
      setApproving(false)
    }
  }

  const toggleDashboard = async (enabled: boolean) => {
    if (!run.runId) return
    setDashBusy(true)
    try {
      dispatch({ kind: 'dashboard', value: await backend.dashboard(run.runId, enabled) })
      toast('ok', enabled ? 'Dashboard is on.' : 'Dashboard is off.')
    } catch (e) {
      toast('info', `Dashboard change failed: ${(e as Error).message}`)
    } finally {
      setDashBusy(false)
    }
  }

  const teardown = async () => {
    if (!run.runId) return
    setTearing(true)
    try {
      const r = await backend.teardown(run.runId)
      dispatch({ kind: 'tornDown', deleted: r.deleted })
      setTeardownOpen(false)
      toast('ok', 'Teardown finished.')
    } catch (e) {
      toast('info', `Teardown failed: ${(e as Error).message}`)
    } finally {
      setTearing(false)
    }
  }

  const openTeardown = () => {
    if (!run.runId) return
    setCreated(undefined)
    setTeardownOpen(true)
    backend.getRun(run.runId).then(
      (r) => setCreated(r.outputs.created),
      () => setCreated(null),
    )
  }

  const newRun = () => {
    unsub.current?.()
    dispatch({ kind: 'reset' })
    setSelected(null)
    setFormOpen(true)
  }

  const analysis = run.nodes.analyze.outputs.find((o): o is AnalysisResult => typeof o === 'object' && o !== null && 'runtime' in o)
  const detectedPort = analysis?.port
  const ghost = run.phase === 'setup' || run.phase === 'starting'
  const failedNode = (Object.keys(run.nodes) as NodeId[]).find((id) => run.nodes[id].status === 'failed')
  const showApproval = run.phase === 'awaiting-approval' && run.approval && !approvalHidden

  return (
    <div className={'app' + (formOpen ? ' form-open' : '')}>
      <TopBar health={health} phase={run.phase} repo={repoLabel(form.repoUrl)} mock={isMock}
        formOpen={formOpen} onToggleForm={() => setFormOpen((v) => !v)} />

      <div className="workspace">
        <div className="side" aria-hidden={!formOpen} inert={!formOpen}>
          <RunForm form={form} set={setForm} phase={run.phase} detectedPort={detectedPort} error={startError}
            onDeploy={() => void deploy(form)} onNewRun={newRun} />
        </div>

        <main className="center">
          <ResultCard phase={run.phase} appUrl={run.done?.appUrl} diagnosis={run.done?.diagnosis}
            dashboard={run.dashboard} dashboardBusy={dashBusy} deleted={run.deleted}
            onDashboard={toggleDashboard} onTeardown={openTeardown}
            onShowDiagnosis={() => setSelected(failedNode ?? 'build')} />

          <div className="canvas-wrap">
            <ReactFlowProvider>
              <Canvas run={run} selected={selected} ghost={ghost} onSelect={setSelected}
                layoutKey={`${formOpen}|${consoleOpen}|${run.runId ?? ''}|${run.phase === 'live' || run.phase === 'failed' || run.phase === 'torn-down'}`} />
            </ReactFlowProvider>

            {ghost && !selected && (
              <div className="empty-hint">
                <span className="empty-hint-icon"><GitBranch size={16} /></span>
                <div>
                  <p className="empty-hint-title">Paste a repo to begin</p>
                  <p className="empty-hint-sub">These 13 steps run in order. Nothing touches AWS until you approve.</p>
                </div>
              </div>
            )}

            {run.phase === 'awaiting-approval' && approvalHidden && (
              <button type="button" className="approval-pill" onClick={() => setApprovalHidden(false)}>
                <ShieldCheck size={15} /> Review AWS changes
              </button>
            )}

            <Inspector node={selected} view={selected ? run.nodes[selected] : undefined} logs={run.logs}
              form={form} set={setForm} phase={run.phase} detectedPort={detectedPort}
              approvalActions={run.approval?.actions} initialTab={urlTab ?? undefined}
              onClose={() => setSelected(null)} />
          </div>

          <Console logs={run.logs} open={consoleOpen} onToggle={() => setConsoleOpen((v) => !v)}
            filter={selected} onClearFilter={() => setSelected(null)} />
        </main>
      </div>

      {showApproval && run.approval && (
        <ApprovalModal request={run.approval} size={form.instanceType} busy={approving}
          missingPermissions={health.status === 'ok' ? health.data.awsPermissions?.missing : undefined}
          onApprove={() => void respond(true)} onCancel={() => void respond(false)} onDismiss={() => setApprovalHidden(true)} />
      )}
      {teardownOpen && <TeardownDialog busy={tearing} resources={created} envVars={Object.keys(toRunConfig(form).env ?? {}).length} onConfirm={() => void teardown()} onClose={() => setTeardownOpen(false)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`}>
            {t.tone === 'retry' ? <RotateCcw size={15} /> : <CircleCheck size={15} />}
            <span>{t.text}</span>
            <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const RUN_KEY = 'builddoctor:lastRun'

function rememberRun(id: string | undefined) {
  if (isMock) return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set('run', id)
  else url.searchParams.delete('run')
  window.history.replaceState(null, '', url)
  try {
    if (id) localStorage.setItem(RUN_KEY, id)
    else localStorage.removeItem(RUN_KEY)
  } catch { /* storage blocked: the URL still carries the run */ }
}

function readRememberedRun(): string | null {
  try {
    return localStorage.getItem(RUN_KEY)
  } catch {
    return null
  }
}
