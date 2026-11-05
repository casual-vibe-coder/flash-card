// Where to resume a Watch video. Records are {t: seconds, at: epoch ms}; the
// newest of the on-device and cloud copies wins.
export const posKey = id => `watch:pos:${id}`;
export const newerPos = (a, b) => ((b?.at || 0) > (a?.at || 0) ? b : a) || null;
// Don't resume in the first few seconds or the last few (already finished).
export function resumeFrom(rec, duration = 0) {
  const t = Number(rec?.t);
  if (!Number.isFinite(t) || t < 5) return 0;
  if (duration > 0 && t > duration - 8) return 0;
  return Math.floor(t);
}
