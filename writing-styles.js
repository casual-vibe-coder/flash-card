// Author writing styles used to steer all generated Arabic. Guides live in
// style-guides/*.md (editable); the learner can also override each in
// Settings, blend several authors, say where they are in each book series,
// and add a note about what they are studying right now.
export const STYLES = [
  { id: 'bayna',   label: 'Bayna Yadayk',  blurb: 'Warm textbook narrative, graded by book', file: 'bayna-yadayk', levels: 4 },
  { id: 'nadawi',  label: 'Al-Nadawi',     blurb: 'Classic storytelling, moral and Quranic tone', file: 'nadawi', levels: 3 },
  { id: 'madinah', label: 'Madinah Books', blurb: 'Clear dialogues and drills, community life', file: 'madinah', levels: 3 },
];
export const styleById = id => STYLES.find(s => s.id === id) || STYLES[0];
export const DEFAULT_MIX = { bayna: 2, nadawi: 1, madinah: 1 };      // blended by default
export const WEIGHT_LABELS = ['Off', 'Light', 'Medium', 'Strong'];  // 0..3

// Guides are markdown. "## Level N ..." sections are level-specific; a
// "## Quick summary" section is what is used when authors are blended.
export function parseGuide(text) {
  const parts = String(text || '').split(/^(?=## )/m);
  return parts.map(body => {
    const title = (body.match(/^## (.*)$/m) || [, ''])[1].trim();
    const lv = title.match(/^Level\s*(\d)/i);
    return { title, body: body.trim(), level: lv ? Number(lv[1]) : null, summary: /quick summary/i.test(title) };
  }).filter(p => p.body);
}
// Drop level sections that are not the learner's level (all kept when no level set).
export function forLevel(text, level) {
  const secs = parseGuide(text);
  const keep = secs.filter(s => s.level == null || !level || s.level === level);
  return keep.map(s => s.body).join('\n\n');
}
function summaryOf(text, level) {
  const secs = parseGuide(text);
  const sum = secs.find(s => s.summary);
  const lvl = level ? secs.find(s => s.level === level) : null;
  const head = sum ? sum.body : secs.map(s => s.body).join('\n\n').split(/\s+/).slice(0, 160).join(' ');
  return [head, lvl?.body].filter(Boolean).join('\n\n');
}

export const normalizeMix = (mix, legacyId) => {
  if (mix && typeof mix === 'object') {
    const m = {}; let any = false;
    for (const s of STYLES) { m[s.id] = Math.max(0, Math.min(3, Math.round(Number(mix[s.id]) || 0))); if (m[s.id]) any = true; }
    if (any) return m;
  }
  if (legacyId) return Object.fromEntries(STYLES.map(s => [s.id, s.id === legacyId ? 3 : 0]));
  return { ...DEFAULT_MIX };
};

// auto = the original behaviour: no author guide, the model infers the style.
export function buildStyleBlock({ mix, legacyId, auto = false, levels = {}, focus = '', overrides = {}, defaults = {}, fallback = '' }) {
  const note = String(focus || '').trim();
  const focusLine = note ? `\n\nTHE LEARNER IS STUDYING RIGHT NOW: ${note}\nFavour this grammar, vocabulary and these themes where it fits naturally.` : '';
  if (auto) return fallback + focusLine;
  const m = normalizeMix(mix, legacyId);
  const textOf = s => (overrides[s.id] || '').trim() || (defaults[s.file] || '').trim();
  const active = STYLES.filter(s => m[s.id] > 0 && textOf(s));
  if (!active.length) return fallback + focusLine;
  if (active.length === 1) {
    const s = active[0];
    return `STYLE GUIDE — write in the manner of ${s.label}. Follow this guide closely (voice, sentence shape, vocabulary level, tashkeel):\n\n${forLevel(textOf(s), levels[s.id])}` + focusLine;
  }
  const total = active.reduce((n, s) => n + m[s.id], 0);
  const blocks = active.map(s => `### ${s.label} — ${Math.round(m[s.id] / total * 100)}% of the blend\n${summaryOf(textOf(s), levels[s.id])}`);
  return `STYLE GUIDE — write in a BLEND of these authors' styles, in the proportions shown. Take the voice and register from the strongest, and borrow sentence shapes, devices and themes from the others so the result reads as one coherent text, not a patchwork:\n\n${blocks.join('\n\n')}` + focusLine;
}

export const SENTENCE_LENGTHS = [
  { id: 'short',  label: 'Short',  words: '6-12 words' },
  { id: 'medium', label: 'Medium', words: '12-20 words, one fuller sentence with a connector such as و / ثُمَّ / لِأَنَّ' },
  { id: 'long',   label: 'Long',   words: '20-35 words, two or three linked clauses, like the author\'s own narration' },
];
export const sentenceSpec = id => (SENTENCE_LENGTHS.find(l => l.id === id) || SENTENCE_LENGTHS[0]).words;
