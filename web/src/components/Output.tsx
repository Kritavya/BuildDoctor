import { useState } from 'react'
import { Check, Copy, FileText, Stethoscope } from 'lucide-react'
import type { AnalysisResult, Diagnosis } from '../contract'
import { isAnalysis, isDiagnosis, looksLikeDockerfile } from '../outputs'

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="copy-btn"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {})
        setDone(true)
        window.setTimeout(() => setDone(false), 1400)
      }}
      aria-label={done ? 'Copied' : label}
      title={done ? 'Copied' : label}
    >
      {done ? <Check size={13} strokeWidth={2.6} /> : <Copy size={13} />}
      <span>{done ? 'Copied' : label}</span>
    </button>
  )
}

const RUNTIME: Record<AnalysisResult['runtime'], string> = {
  node: 'Node.js', python: 'Python', go: 'Go', unknown: 'Not recognised',
}

export function CodeBlock({ code, title, lang }: { code: string; title: string; lang?: string }) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <figure className="code">
      <figcaption className="code-head">
        <FileText size={13} />
        <span className="code-title">{title}</span>
        {lang && <span className="code-lang">{lang}</span>}
        <CopyButton text={code} />
      </figcaption>
      <pre className="code-body">
        {lines.map((l, i) => (
          <div key={i} className="code-line">
            <span className="code-ln">{i + 1}</span>
            <span className={dockerTone(l)}>{l || ' '}</span>
          </div>
        ))}
      </pre>
    </figure>
  )
}

function dockerTone(line: string) {
  if (/^\s*#/.test(line)) return 'tok-comment'
  return ''
}

/** Highlights the Dockerfile instruction keyword without a highlighter dependency. */
function DockerLine({ line }: { line: string }) {
  const m = /^(\s*)(FROM|RUN|CMD|COPY|ADD|WORKDIR|ENV|EXPOSE|USER|ARG|ENTRYPOINT|LABEL|HEALTHCHECK)(\b.*)$/i.exec(line)
  if (!m) return <>{line || ' '}</>
  return <>{m[1]}<span className="tok-kw">{m[2]}</span>{m[3]}</>
}

export function DockerfileBlock({ code, title }: { code: string; title: string }) {
  const lines = code.replace(/\n$/, '').split('\n')
  return (
    <figure className="code">
      <figcaption className="code-head">
        <FileText size={13} />
        <span className="code-title">{title}</span>
        <CopyButton text={code} />
      </figcaption>
      <pre className="code-body">
        {lines.map((l, i) => (
          <div key={i} className="code-line">
            <span className="code-ln">{i + 1}</span>
            <span className={dockerTone(l)}><DockerLine line={l} /></span>
          </div>
        ))}
      </pre>
    </figure>
  )
}

export function AnalysisTable({ a }: { a: AnalysisResult }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Runtime', RUNTIME[a.runtime]],
    ['Framework', a.framework ?? 'None detected'],
    ['Start command', a.entryCommand ? <code key="cmd">{a.entryCommand}</code> : 'Not found'],
    ['Port', a.port ?? 'Not found'],
    ['Dockerfile', a.dockerfile === 'present' ? 'Found in repo' : 'Missing, will be drafted'],
    ['Dependency files', a.dependencyFiles.length ? a.dependencyFiles.map((f) => <code key={f}>{f}</code>) : 'None'],
    ['Env vars needed', a.envVars.length ? a.envVars.map((f) => <code key={f}>{f}</code>) : 'None'],
  ]
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k} className="facts-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DiagnosisCard({ d, attempt }: { d: Diagnosis; attempt?: number }) {
  const fixed = d.result === 'fixed'
  return (
    <article className="diag">
      <header className="diag-head">
        <span className="diag-icon"><Stethoscope size={15} /></span>
        <span className="diag-title">Diagnosis{attempt ? `, before attempt ${attempt}` : ''}</span>
        <span className={'diag-result' + (fixed ? ' is-fixed' : ' is-open')}>{fixed ? 'Fix applied' : 'Not fixed'}</span>
      </header>
      <dl className="diag-body">
        <dt>Root cause</dt>
        <dd>{d.rootCause}</dd>
        <dt>Evidence</dt>
        <dd><code className="diag-evidence">{d.evidence}</code></dd>
        <dt>Attempted fix</dt>
        <dd>{d.attemptedFix}</dd>
        <dt>Result</dt>
        <dd>{fixed ? 'The fix was applied and the step is being retried.' : 'The problem is still there.'}</dd>
        {d.nextStep && (
          <>
            <dt>Next step</dt>
            <dd>{d.nextStep}</dd>
          </>
        )}
      </dl>
    </article>
  )
}

export function OutputView({ data, index, total }: { data: unknown; index: number; total: number }) {
  const version = total > 1 ? ` (version ${index + 1} of ${total})` : ''
  if (looksLikeDockerfile(data)) return <DockerfileBlock code={data} title={`Dockerfile${version}`} />
  if (isAnalysis(data)) return <AnalysisTable a={data} />
  if (isDiagnosis(data)) return null // rendered from the retry diagnoses list
  if (typeof data === 'string') return <CodeBlock code={data} title={`Output${version}`} />
  return <CodeBlock code={JSON.stringify(data, null, 2)} title={`Output${version}`} lang="json" />
}
