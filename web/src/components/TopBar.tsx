import { Cloud, Container, Cpu, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { LocalHealth } from '../api'
import type { Phase } from '../state'

type HealthState = { status: 'loading' } | { status: 'ok'; data: LocalHealth } | { status: 'error' }

function Pill({ ok, icon, label, value, title }: { ok: boolean; icon: React.ReactNode; label: string; value: string; title: string }) {
  return (
    <span className={'pill' + (ok ? ' is-ok' : ' is-bad')} title={title}>
      {icon}
      <span className="pill-label">{label}</span>
      <span className="pill-value">{value}</span>
      <span className="pill-dot" aria-hidden />
    </span>
  )
}

const PHASE_TEXT: Record<Phase, string> = {
  setup: 'Ready',
  starting: 'Starting',
  running: 'Running',
  'awaiting-approval': 'Needs your approval',
  live: 'Live',
  failed: 'Stopped',
  'torn-down': 'Torn down',
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
        <rect width="32" height="32" rx="8" className="wm-tile" />
        <path d="M5 17h6l2.5-6 4 11 2.5-5H27" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="wm-text">BuildDoctor</span>
    </span>
  )
}

export function TopBar({ health, phase, repo, mock, formOpen, onToggleForm }: {
  health: HealthState
  phase: Phase
  repo?: string
  mock: boolean
  formOpen: boolean
  onToggleForm: () => void
}) {
  return (
    <header className="topbar">
      <button type="button" className="icon-btn topbar-toggle" onClick={onToggleForm}
        aria-label={formOpen ? 'Hide run setup' : 'Show run setup'} title={formOpen ? 'Hide run setup' : 'Show run setup'}>
        {formOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
      </button>
      <Wordmark />
      {repo && phase !== 'setup' && (
        <span className="run-crumb">
          <span className="crumb-sep">/</span>
          <span className="crumb-repo">{repo}</span>
          <span className={`phase phase--${phase}`}><span className="dot" />{PHASE_TEXT[phase]}</span>
        </span>
      )}
      {mock && <span className="demo-tag" title="Events are replayed from a script. Nothing touches Docker or AWS.">Demo data</span>}

      <div className="topbar-health" aria-label="Local status">
        {health.status === 'loading' && (
          <>
            <span className="pill pill--skeleton" style={{ width: 92 }} />
            <span className="pill pill--skeleton" style={{ width: 210 }} />
            <span className="pill pill--skeleton" style={{ width: 150 }} />
          </>
        )}
        {health.status === 'error' && (
          <span className="pill is-bad" title="GET /api/health/local failed">
            <span className="pill-label">Server offline</span>
            <span className="pill-value">start it on port 4000</span>
            <span className="pill-dot" aria-hidden />
          </span>
        )}
        {health.status === 'ok' && (
          <>
            <Pill ok={health.data.docker} icon={<Container size={13} />} label="Docker" value={health.data.docker ? 'Running' : 'Not running'}
              title={health.data.docker ? 'Docker daemon is reachable' : 'Start Docker Desktop to build images'} />
            <Pill ok={health.data.ollama} icon={<Cpu size={13} />} label="Local model (Ollama)"
              value={health.data.ollama ? health.data.model : 'Not running'}
              title={health.data.ollama ? `Using ${health.data.model}` : 'Run "ollama serve" to enable Dockerfile drafting'} />
            <Pill ok={!!health.data.awsAccount && health.data.awsPermissions?.ok !== false} icon={<Cloud size={13} />} label="AWS"
              value={!health.data.awsAccount ? 'No credentials' : health.data.awsPermissions?.ok === false ? 'Permissions missing' : health.data.awsAccount}
              title={!health.data.awsAccount ? 'Configure AWS credentials to deploy'
                : health.data.awsPermissions?.ok === false
                  ? `Account ${health.data.awsAccount}: attach docs/iam/deploy-user-policy.json to the deploy user (denied: ${health.data.awsPermissions.missing.join(', ')})`
                  : `Account ${health.data.awsAccount}`} />
          </>
        )}
      </div>
    </header>
  )
}

export type { HealthState }
