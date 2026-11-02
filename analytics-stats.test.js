import test from 'node:test';
import assert from 'node:assert/strict';
import { BREADTH_CARD_BENCHMARK, vocabCards, statusCounts, vocabBreadth, skillSelfRatings, performanceInsights } from './analytics-stats.js';

const cards = (n, status) => Array.from({ length: n }, (_, i) => ({ id: `${status}-${i}`, status }));
const decks = [{ id: 'v1' }, { id: 'v2', deckType: 'vocab' }, { id: 'g1', deckType: 'grammar' }];
const cardStates = { v1: [...cards(3, 'known'), ...cards(1, 'weak')], v2: [...cards(2, 'new'), { id: 'blank' }, { id: 'odd', wordType: 'grammar', status: 'known' }], g1: cards(5, 'known'), orphan: cards(9, 'known') };

test('vocabulary counts follow Home: every card in a non-grammar deck, nothing else', () => {
  const vocab = vocabCards(decks, cardStates);
  assert.equal(vocab.length, 8);
  assert.deepEqual(statusCounts(vocab), { total: 8, known: 4, weak: 1, newC: 3, knownPct: 50 });
  assert.deepEqual(vocabCards(undefined, cardStates), []);
});

test('breadth is the card count against the 4,500-card benchmark and stops at 100%', () => {
  assert.equal(BREADTH_CARD_BENCHMARK, 4500);
  assert.deepEqual(vocabBreadth(cards(900, 'known').concat(cards(450, 'new'))), { cards: 1350, known: 900, benchmark: 4500, pct: 30 });
  assert.equal(vocabBreadth(cards(5000, 'new')).pct, 100);
  assert.equal(vocabBreadth([]).pct, 0);
});

test('only rated master Reading, Listening and Speaking sessions move the self-ratings', () => {
  const empty = { reading: null, listening: null, speaking: null };
  const noise = [
    { module: 'reading', rating: 5 },
    { module: 'listening', rating: 4, master: false },
    { module: 'speaking', master: true },
    { module: 'speaking', rating: 0, master: true },
    { module: 'reading', rating: 9, master: true },
    { module: 'vocab', rating: 5, master: true },
    { module: 'writing', rating: 5, master: true },
  ];
  assert.deepEqual(skillSelfRatings({ entries: noise }), empty);
  assert.deepEqual(skillSelfRatings(undefined), empty);
  const rated = skillSelfRatings({ entries: [...noise, { module: 'listening', rating: 4, master: true }] });
  assert.deepEqual(rated, { ...empty, listening: 4 });
  assert.equal(skillSelfRatings({ entries: [{ module: 'reading', rating: 2, master: true }, { module: 'reading', rating: 4, master: true }] }).reading, 3.1);
});

test('insights read the vocabulary cards only', () => {
  const vocab = vocabCards(decks, cardStates);
  const first = performanceInsights(vocab)[0];
  assert.match(first.text, /50% of vocabulary cards known/);
  assert.deepEqual(performanceInsights([]), []);
  const week = performanceInsights(vocab, { weekMin: 160, byMod: {}, weeklyTarget: 150 });
  assert.ok(week.some(i => i.text.startsWith('On track — 160 min')));
});
