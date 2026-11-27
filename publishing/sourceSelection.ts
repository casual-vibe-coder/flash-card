import { parseCardContent } from './catalogContract.ts'
import type { FlashcardDraft } from './types'

/** Explicit content-only projection. Private fields and media URLs never cross. */
export function prepareSourceDeck(deck: Record<string, unknown>, cards: unknown[], id = () => crypto.randomUUID()): FlashcardDraft {
  if (typeof deck.title !== 'string' || !deck.title.trim() || deck.title.length > 300 || !Array.isArray(cards) || cards.length > 2000) throw new Error('Select a named deck with at most 2,000 cards. Nothing was copied.')
  return {
    title: deck.title, deckType: deck.deckType === 'grammar' ? 'grammar' : 'vocabulary',
    ...(typeof deck.description === 'string' ? { description: deck.description } : {}),
    ...(typeof deck.level === 'string' ? { level: deck.level } : {}),
    cards: cards.map((raw, index) => {
      try {
        const c = raw as Record<string, unknown>
        return parseCardContent({ id: id(), wordType: c.wordType ?? 'noun', arabicBase: c.arabicBase ?? '', english: c.english, forms: c.forms ?? {}, ...(c.grammarScience === undefined ? {} : { grammarScience: c.grammarScience }), ...(c.examples === undefined ? {} : { examples: c.examples }), ...(c.grammar === undefined ? {} : { grammar: c.grammar }) }, true)
      } catch { throw new Error(`Card ${index + 1} has invalid content. Correct it before preparing a shared draft; nothing was omitted.`) }
    }),
  }
}
