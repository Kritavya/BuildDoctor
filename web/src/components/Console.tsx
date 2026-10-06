import { useEffect, useRef } from 'react'
import { ChevronDown, ChevronUp, SquareTerminal } from 'lucide-react'
import type { NodeId } from '../contract'
import { NODE_META } from '../meta'
import type { LogEntry } from '../state'

function level(line: string): 'error' | 'warn' | 'ok' | 'cmd' | 'doctor' | 'info' {
  if (/^(ERROR|error:|npm ERR!)|\bERR!|\bfailed\b|exit code [1-9]/i.test(line)) return 'error'
  if (/^WARN|\bwarning\b/i.test(line)) return 'warn'
  if (/^ok\b|\b200 OK\b|\bdone\.?$/i.test(line)) return 'ok'
  if (/^\$ /.test(line)) return 'cmd'
  if (/^Doctor:/.test(line)) return 'doctor'
  return 'info'
}

function clock(ts: number) {
  const d = new Date(ts)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

export function LogLines({ logs, showNode }: { logs: LogEntry[]; showNode: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [logs])
  return (
    <div
      className="loglines"
      ref={ref}
      role="log"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    >
      {logs.map((l) => {
        const lv = level(l.line)
        return (
          <div key={l.id} className={`logline lv-${lv}`}>
            <span className="log-ts">{clock(l.ts)}</span>
            {showNode && <span className="log-node">{NODE_META[l.node].title}</span>}
            <span className="log-text">{l.line}</span>
          </div>
        )
      })}
    </div>
  )
}

interface Props {
  logs: LogEntry[]
  open: boolean
  onToggle: () => void
  filter: NodeId | null
  onClearFilter: () => void
}

export function Console({ logs, open, onToggle, filter, onClearFilter }: Props) {
  const shown = filter ? logs.filter((l) => l.node === filter) : logs
  return (
    <section className={'console' + (open ? ' is-open' : '')} aria-label="Run log">
      <header className="console-head">
        <button type="button" className="console-toggle" onClick={onToggle} aria-expanded={open}>
          <SquareTerminal size={14} />
          <span>Run log</span>
          <span className="console-count">{shown.length}</span>
        </button>
        <div className="console-filters">
          <button type="button" className={'chip' + (!filter ? ' is-on' : '')} onClick={onClearFilter}>All steps</button>
          {filter && <span className="chip is-on">{NODE_META[filter].title}</span>}
        </div>
        <button type="button" className="icon-btn" onClick={onToggle} aria-label={open ? 'Collapse log' : 'Expand log'}>
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </header>
      {open && (
        shown.length ? <LogLines logs={shown} showNode={!filter} /> : (
          <div className="console-empty">
            {filter ? 'This step has not logged anything yet.' : 'Logs from every step stream here once you deploy.'}
          </div>
        )
      )}
    </section>
  )
}
