// Caption timestamps are seconds on the video's timeline.
export const normalizeWord = text => String(text || '').normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

export function lineEnd(lines, index) {
  const line = lines[index], next = lines[index + 1]?.start;
  const end = line.start + (line.dur > 0 ? line.dur : 4);
  return next > line.start ? Math.min(end, next) : end;
}

export function playbackPosition(lines, breakdown, time) {
  let lo = 0, hi = lines.length - 1, index = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].start != null && lines[mid].start <= time) { index = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (index < 0) return { index: -1, word: -1 };
  const line = lines[index], end = lineEnd(lines, index), words = breakdown[index]?.w || [];
  if (time >= end || !words.length) return { index, word: -1 };
  const timed = line.words;
  if (timed?.length === words.length && timed.every((w, i) => normalizeWord(w.text) === normalizeWord(words[i].ar))) {
    let word = -1;
    for (let i = 0; i < timed.length; i++) {
      if (time >= timed[i].start && time < Math.min(timed[i].end, timed[i + 1]?.start ?? end, end)) word = i;
    }
    return { index, word };
  }
  // Caption-only sources have no exact word times: estimate inside the cue,
  // never across overlapping captions or beyond the end of speech.
  const weights = words.map(w => Math.max(1, normalizeWord(w.ar).length));
  const target = (time - line.start) / Math.max(0.01, end - line.start) * weights.reduce((a, b) => a + b, 0);
  let sum = 0;
  return { index, word: weights.findIndex(w => (sum += w) > target) };
}

export function captionWords(event, decode = s => s) {
  const segments = event.segs || [];
  if (!segments.some(s => Number.isFinite(s.tOffsetMs) && s.tOffsetMs > 0)) return undefined;
  const words = [];
  segments.forEach((seg, i) => {
    const tokens = decode(seg.utf8 || '').trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const start = ((event.tStartMs || 0) + (seg.tOffsetMs || 0)) / 1000;
    const next = segments.slice(i + 1).find(s => Number.isFinite(s.tOffsetMs) && s.tOffsetMs > (seg.tOffsetMs || 0));
    const end = ((event.tStartMs || 0) + (next?.tOffsetMs ?? event.dDurationMs ?? 0)) / 1000;
    tokens.forEach((text, k) => words.push({ text, start: start + (end - start) * k / tokens.length, end: start + (end - start) * (k + 1) / tokens.length }));
  });
  return words.length ? words : undefined;
}
