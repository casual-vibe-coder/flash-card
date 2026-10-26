// Shared Watch search, transcript ordering and cached-breakdown reconciliation.
import { normalizeWord } from './watch-timing.js';
export const normalizeSearch = text => String(text || '').normalize('NFKC').toLocaleLowerCase()
  .replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function filterVideos(videos, query) {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean);
  return (videos || []).filter(video => {
    const text = normalizeSearch([video.title, video.channel, video.category, video.id].join(' '));
    return terms.every(term => text.includes(term));
  });
}
export function searchQuery(query, category = '') {
  // Never make video search depend on an AI model, translation key or token budget.
  return [String(query || '').trim(), category].filter(Boolean).join(' ').trim();
}
export function normalizeBreakdown(line, entry) {
  if (!entry?.w?.length) return entry || null;
  const tokens = String(line.text || '').replace(/\*+|♪+|\[[^\]]*\]|\([^)]*\)/g, ' ').trim().split(/\s+/).map(normalizeWord).filter(Boolean);
  const words = entry.w;
  if (tokens.length !== words.length) return entry;
  const remaining = words.map((word, index) => ({ word, index, text: normalizeWord(word.ar) }));
  const ordered = [];
  for (const token of tokens) {
    const index = remaining.findIndex(word => word.text === token);
    if (index < 0) return entry; // Do not assign an English gloss to different Arabic text.
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered.every((word, index) => word.index === index) ? entry : { ...entry, w: ordered.map(word => word.word) };
}
export function prepareWatchLesson(lines, breakdown) {
  const pairs = (lines || []).map((line, index) => ({ line, entry: breakdown?.[index], index }));
  pairs.sort((a, b) => {
    if (!Number.isFinite(a.line.start) || !Number.isFinite(b.line.start)) return a.index - b.index;
    return a.line.start - b.line.start || a.index - b.index;
  });
  return { lines: pairs.map(pair => pair.line), breakdown: breakdown ? pairs.map(pair => normalizeBreakdown(pair.line, pair.entry)) : undefined };
}
