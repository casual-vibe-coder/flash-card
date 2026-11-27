import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useModalFocus } from './useModalFocus'

export function PublishingConfirm({ title, body, action, pending, onConfirm, onClose, registerBack }: { title: string; body: string; action: string; pending: boolean; onConfirm: () => void; onClose: () => void; registerBack?: (handler: () => void) => () => void }) {
  const panel = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null), titleId = useId()
  useModalFocus(panel, cancel)
  useEffect(() => registerBack?.(onClose), [registerBack, onClose])
  return createPortal(<div data-modal-layer className="publishing-workspace pub-modal" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() } }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="pub-modal-panel">
      <h3 id={titleId}>{title}</h3><div className="pub-modal-body"><p>{body}</p><p role="status">{pending ? 'Saving… Dismissing this sheet does not cancel a submitted write.' : ''}</p></div>
      <div className="pub-row"><button className="pub-button min-h-12 min-w-12" ref={cancel} onClick={onClose}>Cancel</button><button className="pub-button min-h-12 min-w-12" disabled={pending} onClick={onConfirm}>{action}</button></div>
    </div>
  </div>, document.body)
}
