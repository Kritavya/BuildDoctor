import { useEffect, useRef, type ReactNode } from 'react'
import { KeyRound, LoaderCircle, Package, Rocket, Server, ShieldHalf, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { ApprovalRequest, DeployOutputs, InstanceSize } from '../contract'
import { INSTANCE_SIZES } from '../meta'

function Modal({ children, onClose, labelledBy }: { children: ReactNode; onClose: () => void; labelledBy: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
  }, [])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        {children}
      </div>
    </div>
  )
}

function actionIcon(a: string) {
  if (/^run container/i.test(a)) return <Rocket size={15} />
  if (/ec2 instance|existing instance/i.test(a)) return <Server size={15} />
  if (/ecr/i.test(a)) return <Package size={15} />
  if (/security group/i.test(a)) return <ShieldHalf size={15} />
  return <KeyRound size={15} />
}

export function ApprovalModal({ request, size, busy, missingPermissions, onApprove, onCancel, onDismiss }: {
  request: ApprovalRequest
  missingPermissions?: string[]
  size: InstanceSize
  busy: boolean
  onApprove: () => void
  onCancel: () => void
  onDismiss: () => void
}) {
  const price = INSTANCE_SIZES.find((s) => s.id === size)?.monthly
  const blocked = !!missingPermissions?.length
  return (
    <Modal onClose={onDismiss} labelledBy="approve-title">
      <div className="modal-head">
        <span className="modal-icon modal-icon--brand"><ShieldCheck size={20} /></span>
        <div>
          <h2 id="approve-title" className="modal-title">Approve AWS changes</h2>
          <p className="modal-sub">Your app passed local checks. BuildDoctor will make these changes in your account:</p>
        </div>
      </div>
      <ul className="approve-list">
        {request.actions.map((a) => (
          <li key={a}><span className="approve-ico">{actionIcon(a)}</span>{a}</li>
        ))}
      </ul>
      <p className="modal-note">
        {price ? <>Estimated cost about <strong>${price} a month</strong> while it runs. </> : null}
        You can remove everything with one click once the app is live.
      </p>
      {blocked && (
        <p className="modal-warn" role="alert">
          Your AWS user can't make these changes yet ({missingPermissions!.join(', ')} denied).
          Attach <code>docs/iam/deploy-user-policy.json</code> to it in the IAM console, then run again.
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancel run</button>
        <button type="button" className="btn btn--primary" onClick={onApprove} disabled={busy || blocked} data-autofocus>
          {busy && <LoaderCircle size={15} className="spin" />} Approve and deploy
        </button>
      </div>
    </Modal>
  )
}

type Created = DeployOutputs['created'][number]

function describe(r: Created): { icon: ReactNode; title: string; detail: string } {
  switch (r.type) {
    case 'ec2':
      return { icon: <Server size={15} />, title: 'EC2 instance', detail: 'Terminated' }
    case 'sg':
      return { icon: <ShieldHalf size={15} />, title: 'Security group', detail: 'Deleted' }
    case 'sg-rule': {
      const [group, port, cidr] = r.id.split(':')
      return { icon: <ShieldHalf size={15} />, title: `Inbound rule tcp/${port} from ${cidr}`, detail: `Removed from your group ${group}` }
    }
    case 'ecr':
      return { icon: <Package size={15} />, title: 'ECR image', detail: "This run's image; the repository too if it is then empty" }
    default:
      return { icon: <KeyRound size={15} />, title: r.type, detail: 'Kept' }
  }
}

export function TeardownDialog({ busy, resources, envVars, onConfirm, onClose }: {
  busy: boolean
  /** undefined while loading; null if the run could not be fetched */
  resources: Created[] | undefined | null
  envVars: number
  onConfirm: () => void
  onClose: () => void
}) {
  const removable = resources?.filter((r) => r.type !== 'iam-role' && r.type !== 'instance-profile') ?? []
  return (
    <Modal onClose={busy ? () => {} : onClose} labelledBy="teardown-title">
      <div className="modal-head">
        <span className="modal-icon modal-icon--danger"><TriangleAlert size={20} /></span>
        <div>
          <h2 id="teardown-title" className="modal-title">Tear down everything?</h2>
          <p className="modal-sub">
            BuildDoctor removes what this run created. Your app goes offline and this cannot be undone.
          </p>
        </div>
      </div>
      <ul className="res-list" aria-busy={resources === undefined}>
        {resources === undefined && [0, 1, 2].map((i) => <li key={i}><span className="res-skeleton" /></li>)}
        {resources === null && <li>Could not load the list of created resources. Teardown still removes only what this run created.</li>}
        {removable.map((r) => {
          const d = describe(r)
          return (
            <li key={r.type + r.id}>
              <span className="approve-ico">{d.icon}</span>
              <span className="res-kind">{d.title} <small>{d.detail}</small></span>
              <code>{r.type === 'sg-rule' ? '' : r.id}</code>
            </li>
          )
        })}
        {resources && envVars > 0 && (
          <li>
            <span className="approve-ico"><KeyRound size={15} /></span>
            <span className="res-kind">Env parameters <small>{envVars} SSM SecureString value{envVars > 1 ? 's' : ''} deleted</small></span>
          </li>
        )}
        {resources && removable.length === 0 && envVars === 0 && <li>This run has not created anything in AWS yet.</li>}
      </ul>
      <p className="modal-note">
        The shared BuildDoctorEC2Role IAM role is kept for future runs. An instance or security group you supplied yourself keeps running.
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy} data-autofocus>Keep it running</button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy && <LoaderCircle size={15} className="spin" />} {busy ? 'Tearing down' : 'Tear down'}
        </button>
      </div>
    </Modal>
  )
}
