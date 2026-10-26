import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ChevronLeft, Cpu, Pin, PinOff } from 'lucide-react'
import { llmStore, type LlmCall } from '../llm'
import { NODE_META } from '../meta'

const IDLE_COLLAPSE_MS = 4000

interface Props {
  model: string
  /** whether a run exists (the pill is hidden on the empty setup screen) */
  visible: boolean
  onExpandedChange: (open: boolean) => void
}

/** Left-edge panel that shows the local model's output as it streams. */
export function LlmPanel({ model, visible, onExpandedChange }: Props) {
  const { calls, active } = useSyncExternalStore(llmStore.subscribe, llmStore.get)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [minimised, setMinimised] = useState(false)
  const [viewId, setViewId] = useState<string>()
  const [hover, setHover] = useState(false)

  // A new call opens the panel (unless minimised) and follows it.
  useEffect(() => {
    if (!active) return
    setViewId(undefined)
    if (!minimised) setOpen(true)
  }, [active, minimised])

  // Nothing generating for a while: fold back to the pill unless pinned or being read.
  useEffect(() => {
    if (active || pinned || hover || !open) return
    const t = window.setTimeout(() => setOpen(false), IDLE_COLLAPSE_MS)
    return () => window.clearTimeout(t)
  }, [active, pinned, hover, open, viewId])

  useEffect(() => {
    if (!calls.length) {
      setOpen(false)
      setViewId(undefined)
    }
  }, [calls.length])

  const expanded = visible && open
  useEffect(() => onExpandedChange(expanded), [expanded, onExpandedChange])

  if (!visible) return null
  const shown = calls.find((c) => c.id === viewId) ?? calls.find((c) => c.id === active) ?? calls[calls.length - 1]
  const live = calls.find((c) => c.id === active)

  if (!expanded) {
    const last = live ?? calls[calls.length - 1]
    return (
      <button type="button" className={`llm-pill${live ? ' is-live' : ''}`} onClick={() => { setMinimised(false); setOpen(true) }}
        aria-label="Open the local model panel">
        <span className={`llm-dot${live ? ' is-live' : ''}`} />
        <span className="llm-pill-name">{(live ?? calls[calls.length - 1])?.model?.startsWith('groq') ? 'Groq' : 'Local model'}</span>
        <span className="llm-pill-sep">·</span>
        <span className="llm-pill-label">{live ? live.label : last ? `${last.label} · ${secs(last.ms)}` : 'idle'}</span>
      </button>
    )
  }

  return (
    <aside className="llm-panel" aria-label="Local model output" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <header className="llm-head">
        <span className={`llm-dot${live ? ' is-live' : shown?.status === 'failed' ? ' is-failed' : shown ? ' is-done' : ''}`} />
        <div className="llm-titles">
          <p className="llm-title">{shown?.model?.startsWith('groq') ? 'Groq' : 'Local model'} <span className="llm-model">· {shown?.model?.split(' · ')[1] ?? model}</span></p>
          <p className="llm-label" title={shown?.label}>{shown ? shown.label : 'Waiting for the first model call'}</p>
        </div>
        <button type="button" className={`icon-btn${pinned ? ' is-on' : ''}`} aria-pressed={pinned} onClick={() => setPinned((p) => !p)}
          title={pinned ? 'Unpin: fold away when idle' : 'Pin open'} aria-label={pinned ? 'Unpin panel' : 'Pin panel open'}>
          {pinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button>
        <button type="button" className="icon-btn" onClick={() => { setMinimised(true); setOpen(false); setPinned(false) }}
          title="Minimise" aria-label="Minimise panel"><ChevronLeft size={16} /></button>
      </header>

      {shown ? <Stream call={shown} /> : <div className="llm-body llm-empty"><Cpu size={18} /> No model calls yet in this run.</div>}

      {calls.length > 1 && (
        <div className="llm-history">
          <p className="llm-history-head">This run · {calls.length} calls</p>
          <ol>
            {[...calls].reverse().map((c) => (
              <li key={c.id}>
                <button type="button" className={`llm-hrow${c.id === shown?.id ? ' is-on' : ''}`}
                  onClick={() => setViewId(c.id === active ? undefined : c.id)}>
                  <span className={`llm-dot is-small${c.status === 'streaming' ? ' is-live' : c.status === 'failed' ? ' is-failed' : ' is-done'}`} />
                  <span className="llm-hlabel">{c.label}</span>
                  <span className="llm-hmeta">{c.status === 'streaming' ? 'writing' : secs(c.ms)}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {shown && <Footer call={shown} />}
    </aside>
  )
}

function Stream({ call }: { call: LlmCall }) {
  const body = useRef<HTMLPreElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    stick.current = true
  }, [call.id])

  useEffect(() => {
    const el = body.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [call.text, call.id])

  const streaming = call.status === 'streaming'
  return (
    <pre ref={body} className="llm-body" aria-live="off" tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28
      }}>
      <span className="llm-where">{NODE_META[call.node].title}{call.service ? ` · ${call.service}` : ''}</span>
      {call.thinking && (
        <span className={`llm-thinking${call.text ? ' is-done' : ''}`}>
          <span className="llm-thinking-label">{call.text ? 'Thought' : 'Thinking…'}</span>
          {call.thinking}
        </span>
      )}
      {call.text ? tint(call.text) : call.thinking ? null : streaming ? <span className="llm-reading">Reading the prompt…</span> : <span className="llm-reading">No output.</span>}
      {streaming && <span className="llm-caret" aria-hidden />}
    </pre>
  )
}

function Footer({ call }: { call: LlmCall }) {
  const streaming = call.status === 'streaming'
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) return
    const t = window.setInterval(() => setNow(Date.now()), 200)
    return () => window.clearInterval(t)
  }, [streaming])
  if (!streaming) {
    return (
      <footer className={`llm-foot${call.status === 'failed' ? ' is-failed' : ''}`}>
        {call.status === 'failed' ? `stopped after ${secs(call.ms)} · model error` : `done in ${secs(call.ms)} · ${call.tokens} tokens`}
        {call.status === 'done' && call.ms > 0 && <span className="llm-foot-rate">{rate(call.tokens, call.ms)} tok/s</span>}
      </footer>
    )
  }
  const elapsed = Math.max(call.ms, now - call.seenAt)
  return (
    <footer className="llm-foot is-live">
      <span>{call.tokens ? `${rate(call.tokens, call.ms)} tok/s` : 'thinking'}</span>
      <span className="llm-foot-sep">·</span>
      <span>{call.tokens} tokens</span>
      <span className="llm-foot-rate">{secs(elapsed)}</span>
    </footer>
  )
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const rate = (tokens: number, ms: number) => (ms > 0 ? Math.round(tokens / (ms / 1000)) : 0)

const DOCKER_KW = /^(\s*)(FROM|RUN|COPY|ADD|CMD|ENTRYPOINT|WORKDIR|ENV|EXPOSE|USER|ARG|LABEL|HEALTHCHECK|VOLUME|SHELL|STOPSIGNAL|ONBUILD)\b/

/** Light tint: Dockerfile instructions and comments, JSON keys. */
function tint(text: string): ReactNode[] {
  return text.split('\n').map((line, i, all) => {
    const nl = i < all.length - 1 ? '\n' : ''
    const kw = DOCKER_KW.exec(line)
    if (kw) return <span key={i}>{kw[1]}<span className="tk-kw">{kw[2]}</span>{line.slice(kw[0].length)}{nl}</span>
    if (/^\s*#/.test(line)) return <span key={i} className="tk-cm">{line}{nl}</span>
    if (line.includes('":')) {
      const parts = line.split(/("(?:[^"\\]|\\.)*"\s*:)/)
      return <span key={i}>{parts.map((p, j) => (j % 2 ? <span key={j} className="tk-key">{p}</span> : p))}{nl}</span>
    }
    return <span key={i}>{line}{nl}</span>
  })
}
