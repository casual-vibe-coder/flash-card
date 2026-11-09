// Settings are synced per key, not as one whole object, so a device holding
// older settings can't overwrite a value changed on another device.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Keys of `cur` that differ from what the cloud last had (`synced`).
export function settingsPatch(synced, cur) {
  const out = {};
  for (const [k, v] of Object.entries(cur || {})) {
    if (v === undefined || !SAFE_KEY.test(k)) continue;
    if (!same(v, synced?.[k])) out[k] = v;
  }
  return out;
}

// Fold the cloud's settings into local ones: a key that changed in the cloud
// since we last synced wins, unless it was also changed here (unsaved edit).
export function mergeCloudSettings(local, cloud, synced) {
  const out = { ...local };
  for (const [k, v] of Object.entries(cloud || {})) {
    const changedElsewhere = !same(v, synced?.[k]);
    const changedHere = k in (synced || {}) && !same(local?.[k], synced[k]);
    if (changedElsewhere && !changedHere) out[k] = v;
  }
  return out;
}
