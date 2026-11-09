import test from 'node:test';
import assert from 'node:assert/strict';
import { smartWordPool } from './practice-words.js';
const decks = [{ id: 'a' }, { id: 'g', deckType: 'grammar' }, { id: 'b' }];
const mk = (n, extra) => Array.from({ length: n }, (_, i) => ({ id: `${extra.p}${i}`, ...extra.f }));
test('uses met words and skips grammar decks', () => {
  const s = smartWordPool(decks, { a: mk(8, { p: 'a', f: { status: 'known' } }), b: mk(5, { p: 'b', f: { status: 'new' } }), g: mk(9, { p: 'g', f: { status: 'known' } }) }, 5);
  assert.equal(s.count, 8); assert.equal(s.usedFallback, false);
  assert.ok(!s.deckIds.has('g')); assert.ok(!s.cardIds.has('b0'));
});
test('falls back to every card when too few words are met', () => {
  const s = smartWordPool(decks, { a: mk(3, { p: 'a', f: { status: 'known' } }), b: mk(5, { p: 'b', f: { status: 'new' } }) }, 10);
  assert.equal(s.count, 8); assert.equal(s.usedFallback, true);
});
test('reviewed cards count as met even if status is new', () => {
  const s = smartWordPool(decks, { a: mk(4, { p: 'a', f: { status: 'new', srsLastReview: 5 } }) }, 3);
  assert.equal(s.count, 4); assert.equal(s.usedFallback, false);
});
