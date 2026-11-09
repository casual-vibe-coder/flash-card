// Automatic word pool for the practice modules (speaking, listening, reading),
// so nobody has to pick decks before practising. Uses words the learner has
// actually met (reviewed, known or weak) across all vocabulary decks; falls
// back to every card while the learner has met fewer than `minPool` words.
export function smartWordPool(decks, cardStates, minPool = 10) {
  const vocab = (decks || []).filter(d => d.deckType !== 'grammar');
  const met = [], all = [];
  for (const d of vocab) for (const c of cardStates?.[d.id] || []) {
    all.push([d.id, c]);
    if (c.srsLastReview || c.status === 'known' || c.status === 'weak') met.push([d.id, c]);
  }
  const chosen = met.length >= minPool ? met : all;
  return {
    deckIds: new Set(vocab.map(d => d.id)),
    cardIds: new Set(chosen.map(([, c]) => c.id)),
    count: chosen.length,
    usedFallback: chosen === all,
  };
}
