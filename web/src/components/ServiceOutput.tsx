import type { ReactNode } from 'react'
import type { NodeId, ServicePlan } from '../contract'
import { STATUS_LABEL } from '../meta'
import { isDiagnosis, looksLikeDockerfile } from '../outputs'
import type { LogEntry, NodeView } from '../state'
import { CodeBlock, DiagnosisCard, DockerfileBlock } from './Output'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : undefined)

/** Segmented control above a multi-service step's output: one segment per service, plus every raw output. */
export function ServiceSwitch({ names, value, view, onChange }: {
  names: string[]
  value: string
  view: NodeView
  onChange: (v: string) => void
}) {
  return (
    <div className="seg seg--panel" role="tablist" aria-label="Service">
      {names.map((n) => {
        const st = view.services[n]?.status ?? 'idle'
        return (
          <button key={n} type="button" role="tab" aria-selected={value === n}
            className={'seg-btn' + (value === n ? ' is-on' : '')} onClick={() => onChange(n)}>
            <span className={`svc-dot is-${st}`} aria-label={STATUS_LABEL[st]} />{n}
          </button>
        )
      })}
      <button type="button" role="tab" aria-selected={value === '*'} className={'seg-btn seg-btn--all' + (value === '*' ? ' is-on' : '')}
        onClick={() => onChange('*')}>All</button>
    </div>
  )
}

/** This service's Dockerfile versions, oldest first: full-pass outputs carry services[name], fixes name their service. */
function dockerfiles(outputs: unknown[], svc: string): Array<{ code: string; mode?: string }> {
  const out: Array<{ code: string; mode?: string }> = []
  for (const o of outputs) {
    const r = rec(o)
    if (!r) continue
    const own = rec(rec(r.services)?.[svc])
    if (own && looksLikeDockerfile(own.dockerfile)) out.push({ code: own.dockerfile as string, mode: own.mode as string })
    else if (r.mode === 'fixed' && r.service === svc && looksLikeDockerfile(r.dockerfile)) out.push({ code: r.dockerfile as string, mode: 'fixed' })
  }
  return out
}

/** The latest per-service entry in a step's outputs (outputs[].services[name]). */
function latestFor(outputs: unknown[], svc: string): Rec | undefined {
  for (let i = outputs.length - 1; i >= 0; i--) {
    const own = rec(rec(rec(outputs[i])?.services)?.[svc])
    if (own) return own
  }
  return undefined
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (!shown.length) return null
  return (
    <dl className="facts">
      {shown.map(([k, v]) => (
        <div key={k} className="facts-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

const MODE: Record<string, string> = { generated: 'Generated', existing: 'Kept from the repo', fixed: 'Rewritten by the doctor loop' }

/** One service's slice of a step: status, its diagnoses, its result and its own log lines. */
export function ServiceOutputView({ node, svc, view, logs, plan }: {
  node: NodeId
  svc: string
  view: NodeView
  logs: LogEntry[]
  plan?: ServicePlan
}) {
  const state = view.services[svc]
  const diagnoses = view.diagnoses.filter((d) => d.service === svc)
  // The run's final diagnosis lands on the failed step without a service; show it where it names this one.
  const final = view.outputs.filter(isDiagnosis).filter((d) => !view.diagnoses.some((x) => x.rootCause === d.rootCause) && d.rootCause.includes(svc))
  const own = latestFor(view.outputs, svc)
  const prefix = `[${svc}] `
  const lines = logs.filter((l) => l.node === node && l.line.startsWith(prefix)).map((l) => l.line.slice(prefix.length))

  let body: ReactNode = null
  if (node === 'dockerfile') {
    const versions = dockerfiles(view.outputs, svc)
    body = versions.length
      ? [...versions].reverse().map((v, i) => (
        <DockerfileBlock key={i} title={`${plan?.dockerfile ?? 'Dockerfile'}${versions.length > 1 ? ` (version ${versions.length - i} of ${versions.length})` : ''}${v.mode ? ` · ${MODE[v.mode] ?? v.mode}` : ''}`} code={v.code} />
      ))
      : null
  } else if (node === 'lint') {
    const findings = latestForArray(view.outputs, svc) ?? []
    body = findings.length
      ? <CodeBlock title={`hadolint findings for ${svc}`} code={findings.map((f) => `line ${f.line} ${f.code} (${f.level}): ${f.message}`).join('\n')} />
      : state?.status === 'success' ? <p className="svc-note">hadolint found nothing to report.</p> : null
  } else if (node === 'build') {
    body = own && <Facts rows={[['Image', <code key="i">{String(own.image)}</code>], ['Size', own.sizeMb !== undefined ? `${own.sizeMb} MB` : undefined], ['Architecture', own.arch as string], ['Layers', own.layers as number]]} />
  } else if (node === 'smoke') {
    body = own && (
      <>
        <Facts rows={[['Port', own.port as number], ['Check', own.check === 'http' ? `HTTP ${own.status}` : own.check === 'tcp' ? 'TCP accept' : undefined]]} />
        {typeof own.logs === 'string' && own.logs && <CodeBlock title={`${svc} container output`} code={own.logs} />}
      </>
    )
  } else if (node === 'deploy') {
    body = own && <Facts rows={[['Container', <code key="c">{String(own.container)}</code>], ['Image', <code key="i">{String(own.imageUri).split('/').pop()}</code>], ['Port', own.port as number]]} />
  } else if (node === 'health') {
    body = own && <Facts rows={[['URL', <a key="u" href={String(own.url)} target="_blank" rel="noreferrer">{String(own.url)}</a>], ['Result', own.healthy ? `Healthy, HTTP ${own.status}` : `Not answering (${String(own.detail ?? 'no response')})`]]} />
  }

  const empty = !state && !diagnoses.length && !final.length && !body && !lines.length
  return (
    <div className="svc-out">
      {state && (
        <p className={`svc-state is-${state.status}`}>
          <span className="svc-dot" />
          <strong>{svc}</strong> {STATUS_LABEL[state.status].toLowerCase()}
          {state.summary && <span className="svc-state-sum">· {state.summary}</span>}
        </p>
      )}
      {[...diagnoses].reverse().map((d, i) => <DiagnosisCard key={'d' + i} d={d} attempt={d.attempt} />)}
      {final.map((d, i) => <DiagnosisCard key={'f' + i} d={d} />)}
      {body}
      {lines.length > 0 && <CodeBlock title={`${svc} log (last ${Math.min(lines.length, 80)} lines)`} code={lines.slice(-80).join('\n')} />}
      {empty && (
        <div className="empty-note">
          <p className="empty-title">Nothing for {svc} yet</p>
          <p>Its results show up here once this step gets to it.</p>
        </div>
      )}
    </div>
  )
}

type Finding = { line: number; code: string; level: string; message: string }
function latestForArray(outputs: unknown[], svc: string): Finding[] | undefined {
  for (let i = outputs.length - 1; i >= 0; i--) {
    const v = rec(rec(outputs[i])?.services)?.[svc]
    if (Array.isArray(v)) return v as Finding[]
  }
  return undefined
}
