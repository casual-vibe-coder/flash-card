import type { PublishedCard } from './catalogContract'
export type ContentKind = 'flashcards' | 'watch'
export interface FlashcardDraft { title: string; description?: string; deckType: 'vocabulary' | 'grammar'; unitId?: string; level?: string; cards: PublishedCard[] }
export interface WatchDraft { videoId: string; title: string; level: string; lines: { start: number; dur: number; text: string }[]; breakdown: ({ tr: string; w: { ar: string; en: string; pos?: string; lemma?: string }[] } | null)[] }
export type PublishingContent = FlashcardDraft | WatchDraft
export interface PublishingActor { uid: string; project: 'kayfa' | 'flash-card'; role: 'superAdmin' | 'catalogPublisher' }
