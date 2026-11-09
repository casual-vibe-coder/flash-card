// Author writing styles used to steer all generated Arabic. Guides live in
// style-guides/*.md (editable); the user can also override each in Settings.
export const STYLES = [
  { id: 'bayna',   label: 'Bayna Yadayk', blurb: 'Warm textbook narrative, graded by book', file: 'bayna-yadayk' },
  { id: 'nadawi',  label: 'Al-Nadawi',    blurb: 'Classic storytelling, moral and Quranic tone', file: 'nadawi' },
  { id: 'madinah', label: 'Madinah Books', blurb: 'Clear dialogues and drills, community life', file: 'madinah' },
];
export const styleById = id => STYLES.find(s => s.id === id) || STYLES[0];

// defaults: { fileName: text } loaded from style-guides/*.md.
// Returns the prompt block for the chosen style: the user's edited guide if
// they wrote one, else the shipped guide, else `fallback`.
export function styleBlock({ id, overrides = {}, defaults = {}, fallback = '' }) {
  const s = styleById(id);
  const text = (overrides[s.id] || '').trim() || (defaults[s.file] || '').trim();
  if (!text) return fallback;
  return `STYLE GUIDE — write in the manner of ${s.label}. Follow this guide closely (voice, sentence shape, vocabulary level, tashkeel):\n\n${text}`;
}

export const SENTENCE_LENGTHS = [
  { id: 'short',  label: 'Short',  words: '6-12 words' },
  { id: 'medium', label: 'Medium', words: '12-20 words, one fuller sentence with a connector such as و / ثُمَّ / لِأَنَّ' },
  { id: 'long',   label: 'Long',   words: '20-35 words, two or three linked clauses, like the author\'s own narration' },
];
export const sentenceSpec = id => (SENTENCE_LENGTHS.find(l => l.id === id) || SENTENCE_LENGTHS[0]).words;
