import { useEffect, useRef, type ReactNode } from 'react'
import { KeyRound, LoaderCircle, Package, Server, ShieldHalf, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { ApprovalRequest, InstanceSize } from '../contract'
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
  if (/ecr|registry|repository/i.test(a)) return <Package size={15} />
  if (/security group|port/i.test(a)) return <ShieldHalf size={15} />
  if (/iam|role|profile|ssm|parameter|env/i.test(a)) return <KeyRound size={15} />
  return <Server size={15} />
}

export function ApprovalModal({ request, size, busy, onApprove, onCancel, onDismiss }: {
  request: ApprovalRequest
  size: InstanceSize
  busy: boolean
  onApprove: () => void
  onCancel: () => void
  onDismiss: () => void
}) {
  const price = INSTANCE_SIZES.find((s) => s.id === size)?.monthly
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
      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>Cancel run</button>
        <button type="button" className="btn btn--primary" onClick={onApprove} disabled={busy} data-autofocus>
          {busy && <LoaderCircle size={15} className="spin" />} Approve and deploy
        </button>
      </div>
    </Modal>
  )
}

export function TeardownDialog({ busy, onConfirm, onClose }: { busy: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal onClose={busy ? () => {} : onClose} labelledBy="teardown-title">
      <div className="modal-head">
        <span className="modal-icon modal-icon--danger"><TriangleAlert size={20} /></span>
        <div>
          <h2 id="teardown-title" className="modal-title">Tear down everything?</h2>
          <p className="modal-sub">
            This deletes the EC2 instance and the security group BuildDoctor created, this run's image (and the ECR repository if that leaves it empty), any firewall rules it added and the stored env parameters. Your app goes offline and this cannot be undone.
          </p>
        </div>
      </div>
      <p className="modal-note">The shared BuildDoctorEC2Role IAM role is kept for future runs. An instance or security group you supplied yourself is left running; only the rules BuildDoctor added are removed.</p>
      <div className="modal-actions">
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy} data-autofocus>Keep it running</button>
        <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
          {busy && <LoaderCircle size={15} className="spin" />} {busy ? 'Tearing down' : 'Tear down'}
        </button>
      </div>
    </Modal>
  )
}
