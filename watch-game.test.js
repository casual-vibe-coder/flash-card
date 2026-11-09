import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyGame, levelInfo, award, collectWord, rollDay, QUEST_TARGET } from './watch-game.js';
test('levels rise with XP', () => {
  assert.equal(levelInfo(0).level, 1);
  assert.equal(levelInfo(29).level, 1);
  assert.equal(levelInfo(30).level, 2);
  assert.ok(levelInfo(500).level > levelInfo(100).level);
  assert.ok(levelInfo(10).pct >= 0 && levelInfo(10).pct <= 100);
});
test('streak extends on consecutive days and resets after a gap', () => {
  let g = award(emptyGame(), 1, '2026-11-01').game;
  assert.equal(g.streak, 1);
  g = award(g, 1, '2026-11-01').game; assert.equal(g.streak, 1);
  g = award(g, 1, '2026-11-02').game; assert.equal(g.streak, 2);
  g = award(g, 1, '2026-11-05').game; assert.equal(g.streak, 1);
});
test('quest completes after the target number of distinct words, once', () => {
  let g = emptyGame(), done = 0;
  for (let i = 0; i < QUEST_TARGET + 3; i++) { const r = collectWord(g, 'w' + i, '2026-11-01'); g = r.game; if (r.questJustCompleted) done++; }
  assert.equal(done, 1); assert.equal(g.questDone, true);
  const again = collectWord(g, 'w0', '2026-11-01'); assert.equal(again.gained, 0);
});
test('new day resets the quest but keeps XP', () => {
  let g = collectWord(emptyGame(), 'a', '2026-11-01').game;
  const xp = g.xp; g = rollDay(g, '2026-11-02');
  assert.deepEqual(g.questWords, []); assert.equal(g.xp, xp);
});
