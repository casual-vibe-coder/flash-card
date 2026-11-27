/** CF-01 wire contract. Pure content only; also used by the frontend. */
export interface CatalogExample { ar: string; en?: string }
export interface PublishedCard {
  id: string
  wordType: string
  arabicBase: string
  english: string
  forms: Record<string, string>
  grammarScience?: 'nahw' | 'sarf' | 'other'
  examples?: CatalogExample[]
  grammar?: { explanation: string; examples: CatalogExample[] }
  media?: { kind: 'image' | 'audio'; path: string }[]
}
export interface PublishedDeck {
  source: 'flash-card'
  id: string
  revisionId: string
  title: string
  deckType: 'vocabulary' | 'grammar'
  cardCount: number
  publishedAt: number
  description?: string
  unitId?: string
  level?: string
}
export interface CatalogListInput { cursor?: string; limit?: number }
export interface CatalogDeckInput extends CatalogListInput { deckId: string; revisionId: string }
export interface CatalogListPage { decks: PublishedDeck[]; nextCursor: string | null }
export interface CatalogDeckPage { deck: PublishedDeck; cards: PublishedCard[]; nextCursor: string | null }
export const CATALOG_SCHEMA_VERSION = 1
export const MAX_REVISION_CARDS = 2000
export const MAX_REVISION_BYTES = 800_000
export const validCatalogId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export class InvalidCatalogContent extends Error {
  constructor() { super('Published flashcard content is invalid.'); this.name = 'InvalidCatalogContent' }
}
const invalid = (): never => { throw new InvalidCatalogContent() }
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const text = (value: unknown, max: number, allowEmpty = false): string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0) ? value : invalid()
const integer = (value: unknown, max: number): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid()
function examples(value: unknown, allowEmpty = false): CatalogExample[] {
  if (!Array.isArray(value) || value.length > 20) return invalid()
  return value.map(raw => {
    const v = object(raw)
    return { ar: text(v.ar, 3000, allowEmpty), ...(v.en === undefined ? {} : { en: text(v.en, 3000, allowEmpty) }) }
  })
}

/** Allowlist projection: never spread a source document into a response. */
export function parsePublishedDeck(id: string, raw: unknown): PublishedDeck {
  const v = object(raw)
  if (!validCatalogId(id) || v.schemaVersion !== CATALOG_SCHEMA_VERSION || v.status !== 'published' ||
      !validCatalogId(v.revisionId) || !['vocabulary', 'grammar'].includes(String(v.deckType))) return invalid()
  return {
    source: 'flash-card', id, revisionId: v.revisionId, title: text(v.title, 300),
    deckType: v.deckType as PublishedDeck['deckType'], cardCount: integer(v.cardCount, MAX_REVISION_CARDS),
    publishedAt: integer(v.publishedAt, Number.MAX_SAFE_INTEGER),
    ...(v.description === undefined ? {} : { description: text(v.description, 3000) }),
    ...(v.unitId === undefined ? {} : { unitId: text(v.unitId, 128) }),
    ...(v.level === undefined ? {} : { level: text(v.level, 128) }),
  }
}

/** Shared content validation; personal edits may deliberately clear text fields. */
export function parseCardContent(raw: unknown, personal = false): PublishedCard {
  const v = object(raw)
  if (!validCatalogId(v.id)) return invalid()
  const wordType = text(v.wordType, 40)
  const forms = object(v.forms)
  if (Object.keys(forms).length > 32) return invalid()
  const cleanForms: Record<string, string> = {}
  for (const [key, value] of Object.entries(forms)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) return invalid()
    cleanForms[key] = text(value, 3000, true)
  }
  const card: PublishedCard = {
    id: v.id, wordType, arabicBase: text(v.arabicBase, 1000, personal || wordType === 'grammar'),
    english: text(v.english, 3000, personal), forms: cleanForms,
  }
  if (v.grammarScience !== undefined) {
    if (!['nahw', 'sarf', 'other'].includes(String(v.grammarScience))) return invalid()
    card.grammarScience = v.grammarScience as PublishedCard['grammarScience']
  }
  if (v.examples !== undefined) card.examples = examples(v.examples, personal)
  if (v.grammar !== undefined) {
    const grammar = object(v.grammar)
    card.grammar = { explanation: text(grammar.explanation, 12000, personal), examples: examples(grammar.examples, personal) }
  }
  if (wordType === 'grammar' && !card.grammar) return invalid()
  if (v.media !== undefined) {
    if (!Array.isArray(v.media) || v.media.length > 8) return invalid()
    card.media = v.media.map(rawMedia => {
      const media = object(rawMedia)
      // Published assets only, not private download-token URLs or arbitrary hosts.
      if ((media.kind !== 'image' && media.kind !== 'audio') || typeof media.path !== 'string' ||
          !/^publishedFlashcardMedia\/[A-Za-z0-9_-]{1,128}\.(?:png|jpg|webp|mp3|wav|ogg)$/.test(media.path)) return invalid()
      return { kind: media.kind, path: media.path }
    })
  }
  return card
}

/** A revision is one bounded immutable document: validate the entire deck before pagination. */
export function parsePublishedRevision(deck: PublishedDeck, raw: unknown): PublishedCard[] {
  const v = object(raw)
  if (v.schemaVersion !== CATALOG_SCHEMA_VERSION || v.complete !== true || v.revisionId !== deck.revisionId ||
      !Array.isArray(v.cards) || v.cards.length !== deck.cardCount ||
      new TextEncoder().encode(JSON.stringify(v)).length > MAX_REVISION_BYTES) return invalid()
  const cards = v.cards.map(card => parseCardContent(card))
  if (new Set(cards.map(card => card.id)).size !== cards.length) return invalid()
  return cards
}
