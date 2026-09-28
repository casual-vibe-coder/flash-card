# Grammar Curriculum Reference

Background knowledge for the grammar-import feature (`GrammarImportScreen`,
`grammarPrompt` in `App.jsx`) — how real Arabic grammar curricula structure
and atomize material, so extracted concept cards are segmented at a sensible
size instead of guessed. Sourced by sampling (not fully reading) two
reference books the user already had locally. No decks or cards were
created from this — reference knowledge only.

## Sources

1. **A Commentary on al-Ājrūmiyyah** — Muḥammad Muḥī al-Dīn ibn 'Abd
   al-Ḥamīd's bilingual commentary (*al-Tuḥfat al-Saniyyah bi Sharḥ
   al-Muqaddimat al-Ājrūmiyyah*) on Ibn Ājurūm's classical primer. Dar
   al-Arqam Publishing, 2018, 409 pages. **Nahw** (syntax) focused.
   Local: `~/Downloads/all my arabic books/A-Commentary-on-al-Ajrumiyyah.pdf`
2. **Fundamentals of Classical Arabic, Volume II: Increased and
   Quadriliteral Verb Forms** — Husain Abdul Sattar, Sacred Learning,
   2025 edition, 174 pages. **Ṣarf** (morphology) focused — verb-form
   derivation specifically.
   Local: `~/Downloads/FCA-V2-WEB-ED.pdf`

Sampled: front matter + table of contents from both, plus one content
chapter from each as a granularity sample ("Inna and Its Sisters" / "Ẓanna
and Its Sisters" from the Ajrumiyyah commentary; the "Verb Form II" lesson
from FCA Vol. 2).

## Nahw (syntax) — topic taxonomy

Ajrumiyyah's table of contents is effectively the canonical topic list for
foundational Arabic syntax, roughly in teaching order:

Speech and its types → types of speech (noun/verb/particle) → signs of the
noun / signs of the verb / the particle → inflection (إعراب) and its
types → signs of *al-rafʿ* / *al-naṣb* / *al-khafḍ* / *al-jazm* (each with
its own sub-rules, e.g. letters standing in for a vowel) → inflectable
words (by diacritic vs by letter) → the dual, sound masculine plural, the
five nouns, the five verbs → the verb and its types → *nawāṣib*/*jawāzim*
of the *muḍāriʿ* → the subject (فاعل) → the deputy subject / passive
(نائب الفاعل) → the nominal subject and predicate (مبتدأ وخبر) → abrogators
of the nominal sentence: *kāna* and its sisters, *inna* and its sisters,
*ẓanna* and its sisters → the adjective (نعت) → definite/indefinite →
particles of conjunction (حروف العطف) → emphasis (توكيد) → the substitute
(بدل) → the five object types (مفعول به / مطلق / فيه / له / معه) → the
circumstantial adverb (حال) → disambiguation (تمييز) → the exception
(استثناء) → the vocative (منادى) → nouns in the state of *khafḍ*.

### Segmentation rule (Nahw)
Segment at the **chapter/category level**, not the individual-item level.
A chapter covering a small closed set of items that all share the *same*
grammatical behavior — e.g. *kāna* and its sisters, *inna* and its sisters
(inna/anna/lakinna/kaʾanna/layta/laʿalla — all govern case identically),
*ẓanna* and its sisters (10 verbs, all take two objects the same way) — is
**one card**, covering 2–4 member items in the examples, not one card per
item. The shared rule is the teaching point; each member's individual
meaning is a supporting detail, not a separate concept.

## Ṣarf (morphology) — atomization pattern

FCA teaches via numbered **"Principles"** grouped under a **"Lesson"**
(one verb form per lesson). Sampled Lesson 2 (Verb Form II) breaks into 11
principles, each one independently-testable morphological fact:
1. Past-tense formation pattern
2. Present-tense formation pattern
3. *Maṣdar* (verbal noun) pattern
4. Active participle pattern
5. Passive-voice past-tense formation
6. Passive-voice present-tense formation
7. Passive participle pattern
8. Command form
9. Prohibition form
10. (summary table — not a concept)
11. Reference to conjugation tables (not a concept)

### Segmentation rule (Ṣarf)
Segment at the **individual principle/rule level**, even within one
broader topic. Each distinct morphological fact (how *this* pattern's
maṣdar/active participle/passive voice/command form is produced) is its
own card — do not lump a whole verb-form lesson into one mega-card. Full
conjugation tables are drill/reference material, not concepts — never turn
a table into a card.

## Where this is actually used

Both rules (plus the Nahw topic list, compressed) are encoded in the
`grammarPrompt` function in `App.jsx` — the instruction template sent to
the AI every time grammar notes are imported via `GrammarImportScreen`.
This file is the durable, human-readable version of that reasoning; the
prompt is the compressed version the AI actually reads at generation time.
