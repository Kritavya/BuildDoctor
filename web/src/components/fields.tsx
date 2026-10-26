import { useId, useState, type ReactNode } from 'react'
import { Check, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { COMMON_PORTS, INSTANCE_SIZES, REGIONS } from '../meta'
import { addressOf, newEnvRow, type EnvRow, type FormState } from '../form'

export type SetForm = (patch: Partial<FormState>) => void

export function Field(props: {
  label: string
  hint?: ReactNode
  error?: string
  children: (id: string) => ReactNode
  optional?: boolean
}) {
  const id = useId()
  return (
    <div className={'field' + (props.error ? ' field--error' : '')}>
      <label className="field-label" htmlFor={id}>
        {props.label}
        {props.optional && <span className="field-optional">Optional</span>}
      </label>
      {props.children(id)}
      {props.error ? (
        <p className="field-msg field-msg--error" role="alert">{props.error}</p>
      ) : props.hint ? (
        <p className="field-msg">{props.hint}</p>
      ) : null}
    </div>
  )
}

export function RepoFields({ form, set, readOnly, errors }: { form: FormState; set: SetForm; readOnly?: boolean; errors?: { repoUrl?: string } }) {
  return (
    <>
      <Field label="GitHub repository" error={errors?.repoUrl} hint="Public repositories work out of the box.">
        {(id) => (
          <input
            id={id}
            className="input"
            placeholder="https://github.com/owner/repo"
            value={form.repoUrl}
            readOnly={readOnly}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => set({ repoUrl: e.target.value })}
          />
        )}
      </Field>
      <Field label="Branch" optional hint="Leave empty to use the default branch.">
        {(id) => (
          <input id={id} className="input" placeholder="main" value={form.branch} readOnly={readOnly} spellCheck={false}
            onChange={(e) => set({ branch: e.target.value })} />
        )}
      </Field>
    </>
  )
}

export function PortField({ form, set, readOnly, error, detected }: { form: FormState; set: SetForm; readOnly?: boolean; error?: string; detected?: number }) {
  return (
    <Field label="App port" optional error={error}
      hint={detected ? `Detected ${detected} from your code.` : 'Detected from your code. Set it only to override.'}>
      {(id) => (
        <input id={id} className="input input--short" inputMode="numeric" placeholder={detected ? String(detected) : 'Auto-detect'}
          value={form.appPort} readOnly={readOnly}
          onChange={(e) => set({ appPort: e.target.value.replace(/[^\d]/g, '').slice(0, 5) })} />
      )}
    </Field>
  )
}

function EnvRowEditor({ row, readOnly, onChange, onRemove }: { row: EnvRow; readOnly?: boolean; onChange: (r: EnvRow) => void; onRemove: () => void }) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className="env-row">
      <input className="input input--mono" placeholder="NAME" aria-label="Variable name" value={row.key} readOnly={readOnly} spellCheck={false}
        onChange={(e) => onChange({ ...row, key: e.target.value.replace(/\s/g, '_') })} />
      <div className="input-wrap">
        <input className="input input--mono" placeholder="value" aria-label={`Value for ${row.key || 'variable'}`}
          type={reveal ? 'text' : 'password'} autoComplete="new-password" value={row.value} readOnly={readOnly}
          onChange={(e) => onChange({ ...row, value: e.target.value })} />
        <button type="button" className="input-icon-btn" onClick={() => setReveal((v) => !v)}
          aria-label={reveal ? 'Hide value' : 'Show value'} title={reveal ? 'Hide value' : 'Show value'}>
          {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
        </button>
      </div>
      {!readOnly && (
        <button type="button" className="icon-btn" onClick={onRemove} aria-label="Remove variable" title="Remove">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

function EnvRows({ rows, onRows, readOnly }: { rows: EnvRow[]; onRows: (rows: EnvRow[]) => void; readOnly?: boolean }) {
  const update = (i: number, r: EnvRow) => onRows(rows.map((x, j) => (j === i ? r : x)))
  const remove = (i: number) => onRows(rows.length === 1 ? [newEnvRow()] : rows.filter((_, j) => j !== i))
  return (
    <>
      <div className="env-list">
        {rows.map((r, i) => (
          <EnvRowEditor key={r.id} row={r} readOnly={readOnly} onChange={(x) => update(i, x)} onRemove={() => remove(i)} />
        ))}
      </div>
      {!readOnly && (
        <button type="button" className="link-btn" onClick={() => onRows([...rows, newEnvRow()])}>
          <Plus size={14} /> Add variable
        </button>
      )}
    </>
  )
}

export function EnvEditor({ form, set, readOnly, label = 'Environment variables' }: { form: FormState; set: SetForm; readOnly?: boolean; label?: string }) {
  return (
    <div className="field">
      <span className="field-label">{label} <span className="field-optional">Optional</span></span>
      <EnvRows rows={form.env} onRows={(env) => set({ env })} readOnly={readOnly} />
      <p className="field-msg">Values go to the container only. They are never logged or shown to the local model.</p>
    </div>
  )
}

export interface KnownService {
  name: string
  kind: 'server' | 'static'
  port: number
  envVars: string[]
  dependsOn: string[]
}

const IGNORED_ENV = /^(PORT|HOST|HOSTNAME|NODE_ENV)$/

/** Env for one service at a time (multi-service repos). Values override the shared ones for that service. */
export function ServiceEnvEditor({ form, set, readOnly, services }: { form: FormState; set: SetForm; readOnly?: boolean; services: KnownService[] }) {
  const [active, setActive] = useState(services[0]?.name)
  const svc = services.find((s) => s.name === active) ?? services[0]
  if (!svc) return null
  const rows = form.serviceEnv[svc.name]?.length ? form.serviceEnv[svc.name] : [newEnvRow()]
  const onRows = (next: EnvRow[]) => set({ serviceEnv: { ...form.serviceEnv, [svc.name]: next } })
  const have = new Set([...form.env, ...rows].map((r) => r.key.trim()).filter(Boolean))
  // Server services get a dependency's address wired in automatically; static builds cannot.
  const wired = svc.kind === 'server' ? svc.envVars.filter((n) => !have.has(n) && addressOf(n, svc.dependsOn)) : []
  const suggest = svc.envVars.filter((n) => !IGNORED_ENV.test(n) && !have.has(n) && !wired.includes(n))
  const count = (name: string) => (form.serviceEnv[name] ?? []).filter((r) => r.key.trim()).length
  return (
    <div className="field">
      <span className="field-label">Per-service variables <span className="field-optional">Optional</span></span>
      <div className="seg" role="tablist" aria-label="Service">
        {services.map((s) => (
          <button key={s.name} type="button" role="tab" aria-selected={s.name === svc.name}
            className={'seg-btn' + (s.name === svc.name ? ' is-on' : '')} onClick={() => setActive(s.name)}>
            {s.name}
            {count(s.name) > 0 && <span className="seg-count">{count(s.name)}</span>}
          </button>
        ))}
      </div>
      <EnvRows rows={rows} onRows={onRows} readOnly={readOnly} />
      {suggest.length > 0 && (
        <div className="env-suggest">
          <span>{svc.name} reads</span>
          {suggest.map((n) => (
            <button key={n} type="button" className="env-suggest-btn" disabled={readOnly}
              onClick={() => onRows([...rows.filter((r) => r.key.trim() || r.value), newEnvRow(n, '')])}>
              {!readOnly && <Plus size={11} />}{n}
            </button>
          ))}
        </div>
      )}
      {wired.length > 0 && (
        <p className="field-msg">
          {wired.map((n) => <code key={n}>{n}</code>)} {wired.length > 1 ? 'are' : 'is'} set to the address of {[...new Set(wired.map((n) => addressOf(n, svc.dependsOn)))].join(', ')} automatically.
        </p>
      )}
      <p className="field-msg">Only the {svc.name} container gets these. A name set here wins over the shared value.</p>
    </div>
  )
}

export function RegionSelect({ form, set, readOnly }: { form: FormState; set: SetForm; readOnly?: boolean }) {
  return (
    <Field label="Region" hint="Pick the one closest to your users.">
      {(id) => (
        <select id={id} className="input select" value={form.region} disabled={readOnly} onChange={(e) => set({ region: e.target.value })}>
          {REGIONS.map((r) => (
            <option key={r.id} value={r.id}>{r.name} ({r.id})</option>
          ))}
        </select>
      )}
    </Field>
  )
}

export function ModelPicker({ form, set, readOnly, localModel, groq }: {
  form: FormState; set: SetForm; readOnly?: boolean; localModel: string; groq?: { ready: boolean; model: string }
}) {
  const name = useId()
  const opts = [
    { id: 'local' as const, name: 'Local', model: localModel, hint: 'Runs on this machine; your code never leaves it.', off: false },
    {
      id: 'groq' as const, name: 'Groq', model: groq?.model ?? 'not configured',
      hint: groq ? (groq.ready ? 'Cloud, much faster and more accurate. Repo facts are sent to Groq; env values never are.' : 'Key set but Groq is not reachable right now.') : 'Add GROQ_API_KEY to .env to enable.',
      off: !groq?.ready,
    },
  ]
  return (
    <fieldset className="field" disabled={readOnly}>
      <legend className="field-label">Model</legend>
      <div className="size-list">
        {opts.map((o) => (
          <label key={o.id} className={'size-opt' + (form.llm === o.id ? ' is-on' : '') + (o.off ? ' is-disabled' : '')}>
            <input type="radio" name={name} value={o.id} checked={form.llm === o.id} disabled={o.off}
              onChange={() => set({ llm: o.id })} />
            <span className="size-main">
              <span className="size-name">{o.name} <code className="model-id">{o.model}</code></span>
              <span className="size-hint">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export function SizePicker({ form, set, readOnly }: { form: FormState; set: SetForm; readOnly?: boolean }) {
  const name = useId()
  return (
    <fieldset className="field" disabled={readOnly}>
      <legend className="field-label">Server size</legend>
      <div className="size-list">
        {INSTANCE_SIZES.map((s) => (
          <label key={s.id} className={'size-opt' + (form.instanceType === s.id ? ' is-on' : '')}>
            <input type="radio" name={name} value={s.id} checked={form.instanceType === s.id}
              onChange={() => set({ instanceType: s.id })} />
            <span className="size-main">
              <span className="size-name">{s.id}</span>
              <span className="size-hint">{s.spec}. {s.hint}</span>
            </span>
            <span className="size-price">~${s.monthly}<small>/mo</small></span>
          </label>
        ))}
      </div>
      <p className="field-msg">ARM-based (Graviton). Prices are rough on-demand estimates.</p>
    </fieldset>
  )
}

export function PortsChecklist({ form, set, readOnly, appPort }: { form: FormState; set: SetForm; readOnly?: boolean; appPort?: number }) {
  const toggle = (p: number) =>
    set({ openPorts: form.openPorts.includes(p) ? form.openPorts.filter((x) => x !== p) : [...form.openPorts, p] })
  const port = form.appPort ? Number(form.appPort) : appPort
  return (
    <fieldset className="field" disabled={readOnly}>
      <legend className="field-label">Open to the internet</legend>
      <div className="check-list">
        <div className="check-opt is-locked">
          <span className="check-box is-on"><Check size={12} strokeWidth={3} /></span>
          <span className="check-text">
            <span className="check-name">App port {port ? <code>{port}</code> : null}</span>
            <span className="check-hint">Always open so people can reach your app</span>
          </span>
        </div>
        {COMMON_PORTS.map((p) => {
          const on = form.openPorts.includes(p.port)
          return (
            <label key={p.port} className="check-opt">
              <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(p.port)} />
              <span className={'check-box' + (on ? ' is-on' : '')} aria-hidden>{on && <Check size={12} strokeWidth={3} />}</span>
              <span className="check-text">
                <span className="check-name">{p.label} <code>{p.port}</code></span>
                <span className="check-hint">{p.hint}</span>
              </span>
            </label>
          )
        })}
      </div>
      <p className="field-msg">SSH (22) is never opened. BuildDoctor manages the server through AWS Systems Manager.</p>
    </fieldset>
  )
}

export function AdvancedFields({ form, set, readOnly, only }: { form: FormState; set: SetForm; readOnly?: boolean; only?: 'ec2' | 'sg' | 'retries' }) {
  return (
    <>
      {(!only || only === 'ec2') && (
        <Field label="Existing EC2 instance" optional hint={<>Must be arm64 (t4g), managed by SSM and tagged <code>Project=BuildDoctor</code>, or it is refused.</>}>
          {(id) => (
            <input id={id} className="input input--mono" placeholder="i-0123456789abcdef0" value={form.existingInstanceId} readOnly={readOnly}
              spellCheck={false} onChange={(e) => set({ existingInstanceId: e.target.value.trim() })} />
          )}
        </Field>
      )}
      {(!only || only === 'sg') && (
        <Field label="Existing security group" optional hint={<>Must be tagged <code>Project=BuildDoctor</code>, or it is refused.</>}>
          {(id) => (
            <input id={id} className="input input--mono" placeholder="sg-0123456789abcdef0" value={form.existingSecurityGroupId} readOnly={readOnly}
              spellCheck={false} onChange={(e) => set({ existingSecurityGroupId: e.target.value.trim() })} />
          )}
        </Field>
      )}
      {(!only || only === 'retries') && (
        <Field label="Automatic fix attempts" hint="How many times BuildDoctor may fix and retry a failing step.">
          {(id) => (
            <div className="stepper">
              <button type="button" className="icon-btn" disabled={readOnly || form.maxFixAttempts <= 0}
                onClick={() => set({ maxFixAttempts: form.maxFixAttempts - 1 })} aria-label="Fewer attempts">−</button>
              <output id={id} className="stepper-val">{form.maxFixAttempts}</output>
              <button type="button" className="icon-btn" disabled={readOnly || form.maxFixAttempts >= 6}
                onClick={() => set({ maxFixAttempts: form.maxFixAttempts + 1 })} aria-label="More attempts">+</button>
            </div>
          )}
        </Field>
      )}
    </>
  )
}
