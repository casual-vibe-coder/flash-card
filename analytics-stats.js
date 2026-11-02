// Numbers behind the Analytics screen. Vocabulary is counted by Home's rule:
// every card in a deck whose deckType is not "grammar".

// A breadth benchmark in cards. It is not a count of proven words or a CEFR level.
export const BREADTH_CARD_BENCHMARK = 4500;

// Only these modules have a master session that asks for a rating.
export const SELF_RATED_SKILLS = ["reading", "listening", "speaking"];

export function vocabCards(decks, cardStates) {
  return (decks || []).filter(d => d.deckType !== "grammar").flatMap(d => (cardStates || {})[d.id] || []);
}

export function statusCounts(cards) {
  const total = cards.length;
  const known = cards.filter(c => c.status === "known").length;
  const weak = cards.filter(c => c.status === "weak").length;
  const newC = cards.filter(c => c.status === "new" || !c.status).length;
  return { total, known, weak, newC, knownPct: total ? Math.round(known / total * 100) : 0 };
}

export function vocabBreadth(cards) {
  const { total, known } = statusCounts(cards);
  return { cards: total, known, benchmark: BREADTH_CARD_BENCHMARK, pct: Math.min(100, Math.round(total / BREADTH_CARD_BENCHMARK * 100)) };
}

/** The learner's own 1-5 ratings from master sessions; recent ratings weigh more. */
export function skillSelfRatings(studyLog) {
  const ratings = Object.fromEntries(SELF_RATED_SKILLS.map(s => [s, []]));
  for (const e of (studyLog?.entries || [])) {
    if (e.master !== true || !ratings[e.module]) continue;
    if (!Number.isFinite(e.rating) || e.rating < 1 || e.rating > 5) continue;
    ratings[e.module].push(e.rating);
  }
  const result = {};
  for (const [skill, list] of Object.entries(ratings)) {
    if (!list.length) { result[skill] = null; continue; }
    const weighted = list.map((r, i) => ({ r, w: 1 + i * 0.3 }));
    const sum = weighted.reduce((s, x) => s + x.r * x.w, 0);
    const wSum = weighted.reduce((s, x) => s + x.w, 0);
    result[skill] = Math.round(sum / wSum * 10) / 10;
  }
  return result;
}

/** Short readings of the vocabulary cards and this week's study time. */
export function performanceInsights(cards, { weekMin = 0, byMod = {}, weeklyTarget = 150 } = {}) {
  const { total, known, weak, knownPct } = statusCounts(cards);
  if (!total) return [];
  const weakPct = Math.round(weak / total * 100);
  const insights = [];

  if (knownPct >= 70) insights.push({ icon: "🌟", text: "Strong vocabulary foundation — " + knownPct + "% of vocabulary cards known.", type: "success" });
  else if (knownPct >= 40) insights.push({ icon: "📈", text: "Improving steadily — " + knownPct + "% of vocabulary cards known, keep going.", type: "info" });
  else insights.push({ icon: "🌱", text: "Early stage — " + knownPct + "% of vocabulary cards known. Focus on daily review.", type: "info" });

  if (weakPct > 20) insights.push({ icon: "⚠️", text: "Weak card load is high (" + weakPct + "%). Prioritize weak card review.", type: "warning" });
  if (weak > 0 && known > weak * 3) insights.push({ icon: "💪", text: "Good ratio — " + known + " known vs " + weak + " weak cards.", type: "success" });

  const maxMod = Object.entries(byMod).filter(([k]) => k !== "manual").sort((a, b) => b[1] - a[1])[0];
  const minMod = Object.entries(byMod).filter(([k]) => k !== "manual" && byMod[k] !== undefined).sort((a, b) => a[1] - b[1])[0];
  if (maxMod && minMod && maxMod[1] > 0 && minMod[1] === 0) insights.push({ icon: "📊", text: `${maxMod[0]} is your strongest module. Consider more ${minMod[0]} practice.`, type: "info" });

  if (weekMin >= weeklyTarget) insights.push({ icon: "✅", text: `On track — ${Math.round(weekMin)} min this week (target: ${weeklyTarget} min).`, type: "success" });
  else if (weekMin >= weeklyTarget * 0.5) insights.push({ icon: "🔄", text: `${Math.round(weekMin)} of ${weeklyTarget} min target this week — ${Math.round(weekMin / weeklyTarget * 100)}% done.`, type: "info" });
  else if (weekMin > 0) insights.push({ icon: "⏰", text: `Behind target — only ${Math.round(weekMin)} of ${weeklyTarget} min this week.`, type: "warning" });

  return insights.slice(0, 4);
}
