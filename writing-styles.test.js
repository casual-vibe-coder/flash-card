import test from 'node:test';
import assert from 'node:assert/strict';
import { styleBlock, sentenceSpec, styleById } from './writing-styles.js';
test('override beats shipped guide beats fallback', () => {
  const d = { nadawi: 'DEFAULT TEXT' };
  assert.match(styleBlock({ id: 'nadawi', overrides: { nadawi: 'MINE' }, defaults: d, fallback: 'F' }), /MINE/);
  assert.match(styleBlock({ id: 'nadawi', defaults: d, fallback: 'F' }), /DEFAULT TEXT/);
  assert.equal(styleBlock({ id: 'madinah', defaults: d, fallback: 'F' }), 'F');
  assert.equal(styleBlock({ id: 'madinah', overrides: { madinah: '  ' }, fallback: 'F' }), 'F');
});
test('unknown style/length fall back to the first', () => {
  assert.equal(styleById('zzz').id, 'bayna');
  assert.match(sentenceSpec('nope'), /6-12/);
  assert.match(sentenceSpec('long'), /20-35/);
});
