import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareSourceDeck } from './sourceSelection.ts'
const card = { id: 'private-card', wordType: 'noun', arabicBase: 'كِتَابٌ', english: 'book', forms: { plural: 'كُتُبٌ' }, examples: [{ ar: 'هَذَا كِتَابٌ', en: 'This is a book.' }] }
test('explicit source preparation copies permitted content only, with stable newly assigned identities', () => {
  let n = 0
  const input = { ...card, owner: 'private', notes: 'private', status: 'known', captures: ['private'], srsReps: 99, imageUrl: 'https://private/?token=private' }
  const draft = prepareSourceDeck({ title: 'Books', uid: 'private', unitId: 'unverified-source-unit' }, [input], () => `public-${++n}`)
  assert.deepEqual(draft.cards[0], { ...card, id: 'public-1' })
  assert.equal(draft.unitId, undefined)
  assert.doesNotMatch(JSON.stringify(draft), /private|srsReps|known|imageUrl/)
  assert.equal(input.srsReps, 99)
  const reordered = { ...draft, cards: [...draft.cards].reverse() }; assert.equal(reordered.cards[0].id, 'public-1')
})
test('bundled presets without IDs receive IDs once without mutation', () => {
  const preset = { title: 'Preset', cards: [{ ...card, id: undefined }] }
  const draft = prepareSourceDeck(preset, preset.cards, () => 'stable')
  assert.equal(draft.cards[0].id, 'stable'); assert.equal(preset.cards[0].id, undefined)
})
test('grammar classification/explanation/examples are preserved', () => {
  const grammar = { wordType: 'grammar', arabicBase: '', english: 'Nouns', forms: {}, grammarScience: 'nahw', grammar: { explanation: 'A rule', examples: [{ ar: 'كِتَابٌ' }] } }
  assert.deepEqual(prepareSourceDeck({ title: 'Grammar', deckType: 'grammar' }, [grammar], () => 'g').cards[0], { ...grammar, id: 'g' })
})
test('invalid cards and capacity failures are explicit, with no partial omission', () => {
  assert.throws(() => prepareSourceDeck({ title: 'Books' }, [card, { ...card, english: 3 }]), /Card 2/)
  assert.throws(() => prepareSourceDeck({ title: 'Books' }, Array(2001).fill(card)), /2,000/)
  assert.throws(() => prepareSourceDeck({ title: '' }, [card]), /named deck/)
})
