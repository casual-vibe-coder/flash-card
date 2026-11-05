import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeFrom, newerPos } from './watch-position.js';
test('resumes mid-video, not at the very start or end', () => {
  assert.equal(resumeFrom({ t: 125.7 }, 600), 125);
  assert.equal(resumeFrom({ t: 3 }, 600), 0);
  assert.equal(resumeFrom({ t: 595 }, 600), 0);
  assert.equal(resumeFrom({ t: 595 }, 0), 595);
  assert.equal(resumeFrom(null, 600), 0);
  assert.equal(resumeFrom({ t: 'x' }, 600), 0);
});
test('newest record wins', () => {
  assert.deepEqual(newerPos({ t: 10, at: 1 }, { t: 50, at: 2 }), { t: 50, at: 2 });
  assert.deepEqual(newerPos({ t: 10, at: 5 }, null), { t: 10, at: 5 });
  assert.equal(newerPos(null, null), null);
});
