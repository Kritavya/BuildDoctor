import { Activity, ExternalLink, LoaderCircle, ScrollText, Stethoscope, Trash2, CircleCheck } from 'lucide-react'
import type { DeployOutputs, Diagnosis, ServiceOutput } from '../contract'
import type { Phase } from '../state'
import { CopyButton } from './Output'

interface Props {
  phase: Phase
  appUrl?: string
  /** Multi-service runs: every service's public URL. */
  services?: Record<string, ServiceOutput>
  diagnosis?: Diagnosis
  dashboard?: DeployOutputs['dashboard']
  dashboardBusy: boolean
  deleted?: string[]
  onDashboard: (enabled: boolean) => void
  onTeardown: () => void
  onShowDiagnosis: () => void
}

function ServiceUrls({ services, appUrl }: { services: Record<string, ServiceOutput>; appUrl: string }) {
  // The URL people open first (appUrl), then the rest in plan order.
  const rows = Object.entries(services).filter(([, s]) => s.url).sort(([, a], [, b]) => Number(b.url === appUrl) - Number(a.url === appUrl))
  return (
    <ul className="svc-urls" aria-label="Service URLs">
      {rows.map(([name, s]) => (
        <li key={name} className="svc-url">
          <span className={'svc-url-name' + (s.healthy === false ? ' is-bad' : '')} title={s.container}>
            <span className="svc-dot" />{name}
          </span>
          <a className="svc-url-link" href={s.url} target="_blank" rel="noreferrer">{s.url!.replace(/^https?:\/\//, '')}</a>
          {s.url === appUrl && <span className="svc-url-tag">main</span>}
          <span className="svc-url-actions">
            <CopyButton text={s.url!} label="Copy" />
            <a className="icon-btn icon-btn--sm" href={s.url} target="_blank" rel="noreferrer" aria-label={`Open ${name}`} title={`Open ${name}`}>
              <ExternalLink size={13} />
            </a>
          </span>
        </li>
      ))}
    </ul>
  )
}

export function ResultCard(p: Props) {
  if (p.phase === 'live' && p.appUrl) {
    const on = !!p.dashboard?.enabled
    const multi = !!p.services && Object.keys(p.services).length > 1
    return (
      <section className={'result result--live' + (multi ? ' result--multi' : '')} aria-label="Deployment result">
        <div className="result-main">
          <span className="live-dot" aria-hidden />
          <div className="result-text">
            <p className="result-title">
              Your app is live
              {multi && <span className="result-count">{Object.keys(p.services!).length} services</span>}
            </p>
            {multi ? <ServiceUrls services={p.services!} appUrl={p.appUrl} /> : (
              <div className="result-url">
                <a href={p.appUrl} target="_blank" rel="noreferrer">{p.appUrl.replace(/^https?:\/\//, '')}</a>
                <CopyButton text={p.appUrl} label="Copy URL" />
                <a className="btn btn--secondary btn--sm" href={p.appUrl} target="_blank" rel="noreferrer">
                  Open <ExternalLink size={13} />
                </a>
              </div>
            )}
          </div>
        </div>

        <div className="result-dash">
          <label className="switch">
            <input type="checkbox" role="switch" checked={on} disabled={p.dashboardBusy}
              onChange={(e) => p.onDashboard(e.target.checked)} />
            <span className="switch-track" aria-hidden><span className="switch-thumb" /></span>
            <span className="switch-label">
              Dashboard
              {p.dashboardBusy && <LoaderCircle size={13} className="spin" />}
            </span>
          </label>
          {on ? (
            <div className="dash-links">
              <span className="dash-hint dash-hint--short">Visible only from your IP</span>
              {p.dashboard?.metricsUrl && (
                <a className="dash-link" href={p.dashboard.metricsUrl} target="_blank" rel="noreferrer">
                  <Activity size={14} /> Metrics <span>cAdvisor</span>
                </a>
              )}
              {p.dashboard?.logsUrl && (
                <a className="dash-link" href={p.dashboard.logsUrl} target="_blank" rel="noreferrer">
                  <ScrollText size={14} /> Logs <span>Dozzle</span>
                </a>
              )}
            </div>
          ) : (
            <span className="dash-hint">CPU, memory and container logs. Visible only from your IP.</span>
          )}
        </div>

        <button type="button" className="btn btn--danger-ghost btn--sm result-teardown" onClick={p.onTeardown}>
          <Trash2 size={14} /> Tear down everything
        </button>
      </section>
    )
  }

  if (p.phase === 'failed') {
    return (
      <section className="result result--failed" aria-label="Run stopped">
        <span className="result-badge"><Stethoscope size={16} /></span>
        <div className="result-text">
          <p className="result-title">The run stopped</p>
          <p className="result-desc">{p.diagnosis?.rootCause ?? 'A step failed and could not be fixed automatically.'}</p>
        </div>
        {p.diagnosis && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={p.onShowDiagnosis}>See diagnosis</button>
        )}
      </section>
    )
  }

  if (p.phase === 'torn-down') {
    return (
      <section className="result result--down" aria-label="Torn down">
        <span className="result-badge"><CircleCheck size={16} /></span>
        <div className="result-text">
          <p className="result-title">Teardown finished</p>
          {p.deleted?.length ? (
            <ul className="down-list">
              {p.deleted.map((d) => <li key={d} className={d.startsWith('FAILED') ? 'is-bad' : d.startsWith('Kept') ? 'is-kept' : ''}>{d}</li>)}
            </ul>
          ) : <p className="result-desc">Nothing needed removing.</p>}
        </div>
      </section>
    )
  }
  return null
}
