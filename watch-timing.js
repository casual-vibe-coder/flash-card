// Caption timestamps are seconds on the video's timeline, independent of playback rate.
export const normalizeWord = text => String(text || '').normalize('NFKC')
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[^\p{L}\p{N}]/gu, '');

// Positive offset delays captions; negative offset brings them forward.
export const captionTime = (videoTime, offset = 0) => videoTime - offset;
export const videoTime = (captionTime, offset = 0) => Math.max(0, captionTime + offset);

export function lineEnd(lines, index) {
  const line = lines[index], next = lines[index + 1]?.start;
  const end = line.start + (line.dur > 0 ? line.dur : 4);
  return next > line.start ? Math.min(end, next) : end;
}

// Match the actual caption text, not an identical token count. For example,
// a caption may timestamp "و" + "البيت" while the breakdown displays "وَالْبَيْتِ".
// Keep those timestamps instead of stretching highlights across the entire cue.
export function alignedWordTimes(line, words) {
  const timed = line.words;
  if (!timed?.length || !words?.length) return null;
  const source = [];
  let length = 0;
  for (const word of timed) {
    const text = normalizeWord(word.text);
    if (!text) continue;
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start) return null;
    if (source.length && word.start < source[source.length - 1].start) return null;
    source.push({ ...word, text, from: length, to: length + text.length });
    length += text.length;
  }
  const tokens = words.map(word => normalizeWord(word.ar));
  if (!tokens.every(Boolean) || source.map(word => word.text).join('') !== tokens.join('')) return null;
  let from = 0, cursor = 0;
  return tokens.map(text => {
    const to = from + text.length;
    while (cursor < source.length - 1 && source[cursor].to <= from) cursor++;
    const first = source[cursor];
    let last = first;
    while (last.to < to && cursor < source.length - 1) last = source[++cursor];
    // Only interpolate when a displayed token divides a timed source token.
    const start = first.start + (first.end - first.start) * (from - first.from) / first.text.length;
    const end = last.start + (last.end - last.start) * (to - last.from) / last.text.length;
    from = to;
    return { start, end };
  });
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
  const timed = alignedWordTimes(line, words);
  if (timed) {
    let word = -1;
    for (let i = 0; i < timed.length; i++) {
      if (time >= timed[i].start && time < Math.min(timed[i].end, timed[i + 1]?.start ?? end, end)) word = i;
    }
    return { index, word };
  }
  // Without matching word times, use the available speech window rather than
  // including a cue's trailing display time. This remains an estimate.
  const valid = (line.words || []).filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
  const start = valid.length ? Math.max(line.start, valid[0].start) : line.start;
  const stop = valid.length ? Math.min(end, valid[valid.length - 1].end) : end;
  if (time < start || time >= stop) return { index, word: -1 };
  const weights = words.map(w => Math.max(1, normalizeWord(w.ar).length));
  const target = (time - start) / Math.max(0.01, stop - start) * weights.reduce((a, b) => a + b, 0);
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
