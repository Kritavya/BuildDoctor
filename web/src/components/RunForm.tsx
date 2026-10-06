import { useState, type FormEvent } from 'react'
import { ChevronRight, LoaderCircle, Rocket, RotateCcw } from 'lucide-react'
import type { FormState } from '../form'
import { validate } from '../form'
import type { Phase } from '../state'
import { AdvancedFields, EnvEditor, PortField, PortsChecklist, RegionSelect, RepoFields, SizePicker, type SetForm } from './fields'

interface Props {
  form: FormState
  set: SetForm
  phase: Phase
  detectedPort?: number
  error?: string
  onDeploy: () => void
  onNewRun: () => void
}

export function RunForm({ form, set, phase, detectedPort, error, onDeploy, onNewRun }: Props) {
  const [touched, setTouched] = useState(false)
  const errors = touched ? validate(form) : {}
  const locked = phase !== 'setup'
  const finished = phase === 'live' || phase === 'failed' || phase === 'torn-down'

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (Object.keys(validate(form)).length) return
    onDeploy()
  }

  return (
    <form className="runform" onSubmit={submit} noValidate>
      <div className="runform-scroll">
        <header className="runform-head">
          <h1 className="runform-title">New deployment</h1>
          <p className="runform-sub">
            {locked ? 'Settings are locked while this run is active.' : 'Point BuildDoctor at a repo. Defaults are fine for most apps.'}
          </p>
        </header>

        <section className="form-section">
          <h2 className="form-section-title">Code</h2>
          <RepoFields form={form} set={set} readOnly={locked} errors={errors} />
        </section>

        <section className="form-section">
          <h2 className="form-section-title">App</h2>
          <PortField form={form} set={set} readOnly={locked} error={errors.appPort} detected={detectedPort} />
          <EnvEditor form={form} set={set} readOnly={locked} />
        </section>

        <section className="form-section">
          <h2 className="form-section-title">AWS</h2>
          <RegionSelect form={form} set={set} readOnly={locked} />
          <SizePicker form={form} set={set} readOnly={locked} />
          <PortsChecklist form={form} set={set} readOnly={locked} appPort={detectedPort} />
        </section>

        <details className="form-section advanced">
          <summary className="form-section-title advanced-summary">
            <ChevronRight size={14} className="advanced-chevron" /> Advanced
          </summary>
          <div className="advanced-body">
            <AdvancedFields form={form} set={set} readOnly={locked} />
          </div>
        </details>
      </div>

      <footer className="runform-foot">
        {error && <p className="form-error" role="alert">{error}</p>}
        {finished ? (
          <button type="button" className="btn btn--secondary btn--block" onClick={onNewRun}>
            <RotateCcw size={15} /> Start a new run
          </button>
        ) : (
          <button type="submit" className="btn btn--primary btn--block" disabled={locked}>
            {phase === 'starting' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}
            {phase === 'setup' ? 'Deploy' : phase === 'starting' ? 'Starting' : 'Deploying'}
          </button>
        )}
        <p className="runform-note">You review every AWS change before it happens.</p>
      </footer>
    </form>
  )
}
