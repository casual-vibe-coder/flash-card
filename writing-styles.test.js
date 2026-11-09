import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStyleBlock, normalizeMix, forLevel, parseGuide, sentenceSpec, styleById, DEFAULT_MIX } from './writing-styles.js';
const guide = n => `# ${n}\nintro\n\n## Quick summary\nSUM-${n}\n\n## Level 1: easy\nL1-${n}\n\n## Level 2: harder\nL2-${n}\n\n## Do and don't\nRULES-${n}`;
const defaults = { 'bayna-yadayk': guide('B'), nadawi: guide('N'), madinah: guide('M') };
test('default is a blend of all three, Al-Nadawi leading', () => {
  const out = buildStyleBlock({ defaults, fallback: 'F' });
  assert.match(out, /BLEND/); assert.match(out, /Al-Nadawi — 50%/); assert.match(out, /Bayna Yadayk — 33%/); assert.match(out, /Madinah Books — 17%/);
  assert.match(out, /SUM-B/); assert.ok(!/RULES-B/.test(out));
});
test('auto keeps the original model-inferred behaviour', () => {
  assert.equal(buildStyleBlock({ auto: true, defaults, fallback: 'F' }), 'F');
});
test('single author uses the full guide filtered to the learner level', () => {
  const out = buildStyleBlock({ mix: { bayna: 3, nadawi: 0, madinah: 0 }, levels: { bayna: 2 }, defaults, fallback: 'F' });
  assert.match(out, /L2-B/); assert.ok(!/L1-B/.test(out)); assert.match(out, /RULES-B/); assert.ok(!/BLEND/.test(out));
});
test('blend includes only the learner level section per author', () => {
  const out = buildStyleBlock({ levels: { bayna: 1, nadawi: 2 }, defaults, fallback: 'F' });
  assert.match(out, /L1-B/); assert.ok(!/L2-B/.test(out)); assert.match(out, /L2-N/);
});
test('focus note is appended in every mode; overrides win; empty falls back', () => {
  assert.match(buildStyleBlock({ auto: true, focus: 'hollow verbs', fallback: 'F' }), /hollow verbs/);
  assert.match(buildStyleBlock({ mix: { bayna: 0, nadawi: 3, madinah: 0 }, overrides: { nadawi: 'MINE' }, defaults, fallback: 'F' }), /MINE/);
  assert.equal(buildStyleBlock({ mix: { bayna: 3 }, fallback: 'F' }), 'F');
});
test('legacy single writingStyle becomes a one-author mix; junk mix becomes default', () => {
  assert.deepEqual(normalizeMix(undefined, 'madinah'), { bayna: 0, nadawi: 0, madinah: 3 });
  assert.deepEqual(normalizeMix({ bayna: 'x' }), DEFAULT_MIX);
  assert.equal(normalizeMix({ bayna: 9 }).bayna, 3);
});
test('parseGuide / forLevel / lookups', () => {
  assert.equal(parseGuide(guide('X')).filter(s => s.level).length, 2);
  assert.ok(!forLevel(guide('X'), 1).includes('L2-X'));
  assert.equal(styleById('zzz').id, 'bayna'); assert.match(sentenceSpec('long'), /20-35/);
});
