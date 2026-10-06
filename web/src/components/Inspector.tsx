import { useEffect, useState } from 'react'
import { Lock, X } from 'lucide-react'
import type { NodeId } from '../contract'
import type { FormState } from '../form'
import { NODE_META, STATUS_LABEL } from '../meta'
import type { LogEntry, NodeView, Phase } from '../state'
import { AdvancedFields, EnvEditor, PortField, PortsChecklist, RegionSelect, RepoFields, SizePicker, type SetForm } from './fields'
import { DiagnosisCard, isDiagnosis, OutputView } from './Output'
import { LogLines } from './Console'

export type InspectorTab = 'parameters' | 'output' | 'logs'

interface Props {
  node: NodeId | null
  view?: NodeView
  logs: LogEntry[]
  form: FormState
  set: SetForm
  phase: Phase
  detectedPort?: number
  approvalActions?: string[]
  initialTab?: InspectorTab
  onClose: () => void
}

function Params({ node, form, set, readOnly, detectedPort, approvalActions }: {
  node: NodeId; form: FormState; set: SetForm; readOnly: boolean; detectedPort?: number; approvalActions?: string[]
}) {
  switch (node) {
    case 'clone':
      return <RepoFields form={form} set={set} readOnly={readOnly} />
    case 'analyze':
      return <PortField form={form} set={set} readOnly={readOnly} detected={detectedPort} />
    case 'dockerfile':
    case 'lint':
    case 'build':
      return (
        <>
          <p className="param-note">
            {node === 'dockerfile'
              ? 'An existing Dockerfile is used as-is when it passes checks. Otherwise the local model drafts one from the project facts. Secret values are never shared with it.'
              : node === 'lint'
                ? 'Checks the Dockerfile with hadolint. A failing check sends the Dockerfile back for a fix.'
                : 'Builds the image with Docker on this machine. A failed build is diagnosed and the Dockerfile is fixed.'}
          </p>
          <AdvancedFields form={form} set={set} readOnly={readOnly} only="retries" />
        </>
      )
    case 'smoke':
      return (
        <>
          <p className="param-note">Starts the container locally with your env vars and requests the app port.</p>
          <PortField form={form} set={set} readOnly={readOnly} detected={detectedPort} />
          <EnvEditor form={form} set={set} readOnly={readOnly} />
        </>
      )
    case 'approve':
      return approvalActions?.length ? (
        <ul className="action-list">
          {approvalActions.map((a) => <li key={a}>{a}</li>)}
        </ul>
      ) : (
        <p className="param-note">The run pauses here and lists every AWS change. Nothing is created until you approve.</p>
      )
    case 'ecr':
      return <RegionSelect form={form} set={set} readOnly={readOnly} />
    case 'securityGroup':
      return (
        <>
          <PortsChecklist form={form} set={set} readOnly={readOnly} appPort={detectedPort} />
          <AdvancedFields form={form} set={set} readOnly={readOnly} only="sg" />
        </>
      )
    case 'ec2':
      return (
        <>
          <SizePicker form={form} set={set} readOnly={readOnly} />
          <RegionSelect form={form} set={set} readOnly={readOnly} />
          <AdvancedFields form={form} set={set} readOnly={readOnly} only="ec2" />
        </>
      )
    case 'deploy':
      return <EnvEditor form={form} set={set} readOnly={readOnly} />
    case 'health':
      return (
        <>
          <p className="param-note">Requests the app three times from outside AWS. If it fails, the container logs are diagnosed and the deploy is retried.</p>
          <PortField form={form} set={set} readOnly={readOnly} detected={detectedPort} />
        </>
      )
    case 'dashboard':
      return (
        <p className="param-note">
          Optional. Runs cAdvisor (metrics) and Dozzle (container logs) next to your app. Turn it on or off from the live card once the app is up.
        </p>
      )
  }
}

export function Inspector({ node, view, logs, form, set, phase, detectedPort, approvalActions, initialTab, onClose }: Props) {
  const [tab, setTab] = useState<InspectorTab>(initialTab ?? 'parameters')
  const [shown, setShown] = useState<NodeId | null>(node)

  // Keep the last node rendered while the panel slides out.
  useEffect(() => {
    if (node) setShown(node)
  }, [node])

  // Opening a step that has already produced something lands on its results.
  useEffect(() => {
    if (!node) return
    if (initialTab) return setTab(initialTab)
    if (view && (view.outputs.length || view.diagnoses.length)) setTab('output')
    else if (view && view.status !== 'idle') setTab('logs')
    else setTab('parameters')
    // only when a different node is opened
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node])

  const readOnly = phase !== 'setup'
  const id = node ?? shown
  const meta = id ? NODE_META[id] : null
  const Icon = meta?.icon
  const outputs = view?.outputs ?? []
  const diagnoses = view?.diagnoses ?? []
  const extraDiag = outputs.filter(isDiagnosis).filter((o) => !diagnoses.some((d) => d.rootCause === o.rootCause))
  const visibleOutputs = outputs.filter((o) => !isDiagnosis(o))
  const outCount = visibleOutputs.length + diagnoses.length + extraDiag.length
  const nodeLogs = id ? logs.filter((l) => l.node === id) : []

  return (
    <aside className={'inspector' + (node ? ' is-open' : '')} aria-hidden={!node} aria-label="Step details">
      {id && meta && Icon && (
        <>
          <header className="insp-head">
            <span className={`insp-icon is-${view?.status ?? 'idle'}`}><Icon size={18} /></span>
            <div className="insp-titles">
              <h2 className="insp-title">{meta.title}</h2>
              <p className={`insp-status is-${view?.status ?? 'idle'}`}>
                <span className="dot" />
                {STATUS_LABEL[view?.status ?? 'idle']}
                {view?.attempt && view.attempt > 1 ? `, attempt ${view.attempt}` : ''}
              </p>
            </div>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close panel"><X size={16} /></button>
          </header>
          {view?.summary && <p className="insp-summary">{view.summary}</p>}

          <div className="tabs" role="tablist">
            {(['parameters', 'output', 'logs'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={'tab' + (tab === t ? ' is-on' : '')}
                onClick={() => setTab(t)}>
                {t === 'parameters' ? 'Parameters' : t === 'output' ? 'Output' : 'Logs'}
                {t === 'output' && outCount > 0 && <span className="tab-count">{outCount}</span>}
                {t === 'logs' && nodeLogs.length > 0 && <span className="tab-count">{nodeLogs.length}</span>}
              </button>
            ))}
          </div>

          <div className="insp-body">
            {tab === 'parameters' && (
              <div className="insp-params">
                {readOnly && (
                  <p className="readonly-note"><Lock size={12} /> Read-only while the run is active</p>
                )}
                <Params node={id} form={form} set={set} readOnly={readOnly} detectedPort={detectedPort} approvalActions={approvalActions} />
              </div>
            )}
            {tab === 'output' && (
              <div className="insp-output">
                {outCount === 0 && (
                  <div className="empty-note">
                    <p className="empty-title">No output yet</p>
                    <p>Results from this step show up here once it runs.</p>
                  </div>
                )}
                {[...diagnoses].reverse().map((d, i) => <DiagnosisCard key={'d' + i} d={d} attempt={d.attempt} />)}
                {extraDiag.map((d, i) => <DiagnosisCard key={'x' + i} d={d} />)}
                {[...visibleOutputs].reverse().map((o, i) => (
                  <OutputView key={'o' + i} data={o} index={visibleOutputs.length - 1 - i} total={visibleOutputs.length} />
                ))}
              </div>
            )}
            {tab === 'logs' && (
              <div className="insp-logs">
                {nodeLogs.length ? <LogLines logs={nodeLogs} showNode={false} /> : (
                  <div className="empty-note">
                    <p className="empty-title">No logs yet</p>
                    <p>Logs stream in live while this step runs.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
