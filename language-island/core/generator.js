// Generation layer. Two ways to use it:
//   1) Built-in: createGenerator({ apiKey }) calls the Anthropic Messages API directly.
//   2) Override: pass config.generate(...) to route through your own backend (keeps the key server-side).
//
// Either way the app expects an array of { q, a, en } objects back.

export function buildPrompt({ unitAr, unitEn, level, count, vocab }) {
  const vocabClause =
    vocab && vocab.length
      ? "\n- The learner ALREADY KNOWS these words; prefer reusing them and introduce as few new words " +
        "as possible:\n  " + vocab.slice(0, 150).join("، ")
      : "";
  return (
`You are an expert Modern Standard Arabic teacher creating speaking-practice material.
Topic: "${unitAr}" (${unitEn}).
Create ${count} natural question-and-answer pairs the learner can practise saying aloud.
- Questions: things a real conversation partner would ask about this topic.
- Answers: natural FIRST-PERSON model answers the learner can adapt (personal and realistic).
- Level: ${level.guidance}${vocabClause}
- Put COMPLETE tashkīl (full harakāt on every word) in BOTH the question and the answer.
- Vary the question words; avoid generic textbook phrasing.
Return ONLY a compact JSON array and nothing else (no markdown, no commentary):
[{"q":"<arabic question fully voweled>","a":"<arabic answer fully voweled>","en":"<very short English gloss of the question>"}]`
  );
}

// Tolerant parser — handles markdown fences and a truncated trailing object.
export function parseQA(text) {
  let t = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const a = JSON.parse(t);
    if (Array.isArray(a)) return a.filter(isValid);
  } catch (_) {}
  const out = [];
  let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { const o = JSON.parse(t.slice(start, i + 1)); if (isValid(o)) out.push(o); } catch (_) {}
        start = -1;
      }
    }
  }
  return out;
}

const isValid = (o) => o && typeof o.q === "string" && typeof o.a === "string";

export function createGenerator(cfg = {}) {
  const model = cfg.model || "claude-sonnet-4-6";
  const endpoint = cfg.endpoint || "https://api.anthropic.com/v1/messages";
  const maxTokens = cfg.maxTokens || 1024;
  const apiKey = cfg.apiKey || null;

  async function generate({ unitAr, unitEn, level, count, vocab }) {
    const headers = { "Content-Type": "application/json" };
    if (apiKey) {
      // Direct browser call to Anthropic. For production, prefer a backend (see config.generate).
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: buildPrompt({ unitAr, unitEn, level, count, vocab }) }],
      }),
    });
    if (!res.ok) throw new Error("Request failed (" + res.status + ")");
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Generation error");
    const out = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const pairs = parseQA(out);
    if (!pairs.length) throw new Error("Could not read the generated questions — try again.");
    return pairs;
  }

  return { generate };
}
