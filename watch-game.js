// Light game layer for Watch: XP for time watched and words collected, levels,
// a daily streak and a daily "collect N new words" quest. Pure functions; the
// screen keeps the state in localStorage.
export const QUEST_TARGET = 5;
export const XP = { tenSeconds: 1, wordTap: 2, wordAdd: 5, quest: 10 };
const TITLES = ['Newcomer', 'Listener', 'Explorer', 'Word Hunter', 'Storyteller', 'Fluent Ear', 'Master of the Majlis'];

export const emptyGame = () => ({ xp: 0, streak: 0, lastDay: null, day: null, questWords: [], questDone: false, seen: [] });

export function levelInfo(xp) {
  const n = Math.max(0, Math.floor(xp || 0));
  let level = 1, need = 30, floor = 0;
  while (n >= floor + need) { floor += need; level++; need = Math.round(need * 1.35); }
  return { level, title: TITLES[Math.min(level - 1, TITLES.length - 1)], into: n - floor, need, pct: Math.round((n - floor) / need * 100) };
}

const dayBefore = day => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

// Roll the state to `day` (YYYY-MM-DD): new day resets the daily quest and
// extends or breaks the streak.
export function rollDay(game, day) {
  if (game.day === day) return game;
  return { ...game, day, questWords: [], questDone: false, streak: game.lastDay === dayBefore(day) ? game.streak : (game.lastDay === day ? game.streak : 0) };
}

// Award XP. Returns { game, gained, questJustCompleted }.
export function award(game, amount, day) {
  let g = rollDay(game, day);
  let gained = Math.max(0, amount);
  if (gained > 0 && g.lastDay !== day) g = { ...g, streak: g.streak + 1, lastDay: day };
  return { game: { ...g, xp: g.xp + gained }, gained, questJustCompleted: false };
}

// A word was tapped/collected. `key` identifies the word (Arabic text).
// First time seen in the day counts toward the quest.
export function collectWord(game, key, day, { added = false } = {}) {
  let g = rollDay(game, day);
  let gained = 0, questJustCompleted = false;
  if (!g.questWords.includes(key)) {
    g = { ...g, questWords: [...g.questWords, key] };
    gained += XP.wordTap;
  }
  if (added) gained += XP.wordAdd;
  if (!g.questDone && g.questWords.length >= QUEST_TARGET) { g = { ...g, questDone: true }; gained += XP.quest; questJustCompleted = true; }
  const r = award(g, gained, day);
  return { game: r.game, gained, questJustCompleted };
}
