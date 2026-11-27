import { useLayoutEffect, type RefObject } from 'react'

const layers: HTMLElement[] = []
const locks = new Map<HTMLElement, boolean>()
const focusable = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** Lock sibling branches, never an ancestor of the top modal (including portals). */
function reconcileBackground() {
  const required = new Set<HTMLElement>()
  let branch = layers.at(-1)
  while (branch?.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling instanceof HTMLElement && sibling !== branch) required.add(sibling)
    }
    if (branch.parentElement === document.body) break
    branch = branch.parentElement
  }
  for (const [node, original] of locks) {
    if (!required.has(node)) { node.inert = original; locks.delete(node) }
  }
  for (const node of required) {
    if (!locks.has(node)) locks.set(node, node.inert)
    node.inert = true
  }
}

/** Modal lifetime follows the mounted panel, including its exit animation. */
export function useModalFocus(panel: RefObject<HTMLDivElement | null>, initial: RefObject<HTMLElement | null>, enabled = true, restoreFocus?: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    if (!enabled) return
    const node = panel.current, layer = node?.closest<HTMLElement>('[data-modal-layer]') ?? node?.parentElement
    if (!node || !layer) return
    const before = restoreFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    // Children mount before parents. Preserve a nested child's ownership.
    const child = layers.findIndex(candidate => layer.contains(candidate))
    layers.splice(child < 0 ? layers.length : child, 0, layer)
    const top = () => layers.at(-1) === layer
    reconcileBackground()
    const observer = new MutationObserver(() => { if (top()) reconcileBackground() })
    observer.observe(document.body, { childList: true, subtree: true })
    const available = (el: HTMLElement) => !el.matches(':disabled') && !el.closest('[inert], [hidden]') && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden'
    const targets = () => [...node.querySelectorAll<HTMLElement>(focusable)].filter(available).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING ? 1 : -1)
    const enter = () => {
      const preferred = initial.current
      if (preferred && available(preferred)) preferred.focus({ preventScroll: true })
      else node.focus({ preventScroll: true })
    }
    const contain = (event: FocusEvent) => { if (top() && !node.contains(event.target as Node)) enter() }
    const trap = (event: KeyboardEvent) => {
      if (!top() || event.key !== 'Tab') return
      const items = targets(), first = items[0], last = items.at(-1)
      if (!first) { event.preventDefault(); node.focus({ preventScroll: true }); return }
      const active = document.activeElement
      if (!items.includes(active as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus() }
      else if (event.shiftKey && active === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('focusin', contain)
    document.addEventListener('keydown', trap, true)
    if (top()) enter()
    return () => {
      observer.disconnect()
      document.removeEventListener('focusin', contain)
      document.removeEventListener('keydown', trap, true)
      const wasTop = top(), index = layers.indexOf(layer)
      if (index >= 0) layers.splice(index, 1)
      reconcileBackground()
      if (wasTop && before?.isConnected && !before.closest('[inert]')) before.focus({ preventScroll: true })
    }
  }, [panel, initial, enabled, restoreFocus])
}
