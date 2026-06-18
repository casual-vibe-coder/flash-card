// The four difficulty levels. `desc` shows in the UI; `guidance` is injected into the
// generation prompt. This is the main file to edit when you personalize difficulty —
// e.g. tie each level to a slice of your own flashcard deck (see examples/personalized-levels.js).

export const LEVELS = [
  {
    id: "b1i",
    name: "B1 — intermediate",
    desc: "Simple connected sentences, everyday vocabulary, mostly present tense, basic connectors.",
    guidance:
      "CEFR B1 (intermediate). Short connected sentences, high-frequency everyday vocabulary, " +
      "mostly present tense with a little simple past, basic connectors (وَ، لَكِنْ، لِأَنَّ، ثُمَّ). " +
      "Each answer one short sentence.",
  },
  {
    id: "b1u",
    name: "B1 — upper",
    desc: "Longer sentences, more connectors (عِنْدَمَا، الَّذِي، إِذَا), opinions, past & future.",
    guidance:
      "CEFR B1 (upper). Longer sentences using connectors (عِنْدَمَا، الَّذِي، إِذَا، بَعْدَ أَنْ، كَيْ) " +
      "and opinion verbs (أَعْتَقِدُ، أُفَضِّلُ، أَتَمَنَّى), with a mix of past, present and future. " +
      "Answers one to two sentences.",
  },
  {
    id: "b2l",
    name: "B2 — lower",
    desc: "More abstract vocabulary, subordinate clauses, reasoning and comparison.",
    guidance:
      "CEFR B2 (lower). More abstract and topic-specific vocabulary, subordinate clauses, clear " +
      "reasoning and comparison (أَكْثَرُ مِنْ، بَيْنَمَا، رَغْمَ أَنَّ), and some common MSA expressions. " +
      "Answers about two developed sentences.",
  },
  {
    id: "b2u",
    name: "B2 — upper",
    desc: "Rich vocabulary, complex structures, nuanced opinions, near-native phrasing.",
    guidance:
      "CEFR B2 (upper). Rich, precise vocabulary; complex and varied sentence structures; nuanced, " +
      "well-argued opinions; conditionals and verbal nouns (المَصْدَر); idiomatic MSA phrasing. " +
      "Answers two to three articulate sentences.",
  },
];
