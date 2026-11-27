import { parseCardContent } from './catalogContract'
import type { ContentKind, PublishingContent } from './types'

export interface DeviceDraft { content: PublishingContent; baseVersion: number; publication: string | null }
export const draftPrefix = (owner: string, kind: ContentKind) => `kayfa:publisher:${owner}:${kind}:`
export function readDeviceDraft(key: string, kind: ContentKind): DeviceDraft | null {
  try {
    const d = JSON.parse(localStorage.getItem(key) ?? 'null'), c = d?.content
    if (!c || typeof c.title !== 'string' || !Number.isSafeInteger(d.baseVersion)) return null
    if (kind === 'flashcards') {
      if (!Array.isArray(c.cards) || c.cards.length > 2000 || !['vocabulary', 'grammar'].includes(c.deckType)) return null
      c.cards = c.cards.map((card: unknown) => parseCardContent(card, true))
    } else if (!Array.isArray(c.lines) || !Array.isArray(c.breakdown) || c.lines.length !== c.breakdown.length || typeof c.videoId !== 'string' || c.lines.some((l: { text: unknown; start: number; dur: number }) => typeof l?.text !== 'string' || !Number.isFinite(l.start) || !Number.isFinite(l.dur)) || c.breakdown.some((b: { tr: unknown; w: { ar: unknown; en: unknown }[] } | null) => b !== null && (typeof b?.tr !== 'string' || !Array.isArray(b.w) || b.w.some(w => typeof w?.ar !== 'string' || typeof w?.en !== 'string')))) return null
    return d
  } catch { return null }
}
export function deviceDrafts(owner: string, kind: ContentKind) {
  const prefix = draftPrefix(owner, kind), result: { id: string; title: string }[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) { const draft = readDeviceDraft(key, kind); if (draft) result.push({ id: key.slice(prefix.length), title: draft.content.title || 'Untitled draft' }) }
    }
  } catch { /* Storage may be unavailable; saving still reports its error. */ }
  return result
}
