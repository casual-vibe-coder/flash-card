import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsPatch, mergeCloudSettings } from './settings-sync.js';
test('patch names only keys that changed', () => {
  assert.deepEqual(settingsPatch({ a: 1, b: 2 }, { a: 1, b: 3, c: { x: 1 } }), { b: 3, c: { x: 1 } });
  assert.deepEqual(settingsPatch({ a: 1 }, { a: 1 }), {});
  assert.deepEqual(settingsPatch({}, { 'bad.key': 1, ok: 2 }), { ok: 2 });
});
test('stale device cannot revert a value changed elsewhere', () => {
  // phone synced limit=10; desktop later set 30; phone refreshes
  const out = mergeCloudSettings({ limit: 10, theme: 'x' }, { limit: 30, theme: 'x' }, { limit: 10, theme: 'x' });
  assert.equal(out.limit, 30);
});
test('unsaved local edit is kept over a cloud change', () => {
  const out = mergeCloudSettings({ limit: 40 }, { limit: 30 }, { limit: 10 });
  assert.equal(out.limit, 40);
});
test('new cloud-only keys arrive', () => {
  assert.equal(mergeCloudSettings({}, { z: 1 }, {}).z, 1);
});
