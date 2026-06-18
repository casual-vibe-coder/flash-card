// api/generate.js — THE generation gateway (Phase 3, product rule R3).
//
// One server-side path for all AI generation. Per request it:
//   1. authenticates the caller (Firebase ID token, if admin is configured)
//   2. checks entitlement            (stubbed "allowed" until Phase 6)
//   3. cache lookup  → hit returns immediately (a free "library read")
//   4. miss + entitled → calls the model, caches the output, logs usage
//   5. miss + not entitled → 402 paywall (wired in Phase 6)
//
// The API key never reaches the browser (OpenRouter key from env, like
// /api/claude). Prompt building + tolerant parsing are REUSED from the vendored
// Language Island module so there's a single source of truth.

import crypto from "node:crypto";
import { buildPrompt, parseQA } from "../language-island/core/generator.js";
import { getAdmin } from "./_firebase.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Dictation (Phase 4): short fully-voweled sentences the learner transcribes.
function buildDictationPrompt({ level, count, vocab, topic }) {
  const vocabClause =
    vocab && vocab.length
      ? "\n- Prefer reusing these words the learner already knows; introduce as few new words as possible:\n  " +
        vocab.slice(0, 120).join("، ")
      : "";
  const topicClause = topic ? ` about "${topic}"` : "";
  return (
`You are an expert Modern Standard Arabic teacher creating DICTATION practice${topicClause}.
Create ${count} short, natural sentences the learner will hear and write down.
- Each sentence one clear idea, easy to say aloud, ${level?.guidance || "intermediate level"}.
- Put COMPLETE tashkīl (full harakāt on every word).
- Avoid proper nouns that are hard to spell; keep them dictation-friendly.${vocabClause}
Return ONLY a compact JSON array and nothing else:
[{"ar":"<arabic sentence fully voweled>","en":"<short English translation>"}]`
  );
}

// Tolerant array parser for {ar,en} items (handles fences + truncation).
function parseSentences(text) {
  let t = (text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const ok = (o) => o && typeof o.ar === "string" && o.ar.trim();
  try { const a = JSON.parse(t); if (Array.isArray(a)) return a.filter(ok); } catch {}
  const out = []; let depth = 0, start = -1;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { depth--; if (depth === 0 && start >= 0) { try { const o = JSON.parse(t.slice(start, i + 1)); if (ok(o)) out.push(o); } catch {} start = -1; } }
  }
  return out;
}

// Registry of generation kinds. Each: how to build the prompt, how to parse the
// response, and whether outputs are cacheable/promotable to the free library.
// Add reading/listening here as those modules migrate onto the gateway.
const KINDS = {
  islandQA: { build: buildPrompt, parse: parseQA, cacheable: true },
  dictation: { build: buildDictationPrompt, parse: parseSentences, cacheable: true },
};

const sha = (obj) =>
  crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 40);

// Entitlement stub — Phase 6 replaces this with real free/paid + quota logic.
// Returns { allowed, tier, reason? }.
async function checkEntitlement(/* uid, kind, personalized */) {
  return { allowed: true, tier: "free" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = req.body?.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(400).json({ error: "No API key. Add your OpenRouter key in Settings or set OPENROUTER_API_KEY." });

  const { kind, model, maxTokens, inputs, personalized = false, noCache = false } = req.body || {};
  const spec = KINDS[kind];
  if (!spec) return res.status(400).json({ error: `Unknown generation kind: ${kind}` });
  if (!inputs || typeof inputs !== "object") return res.status(400).json({ error: "Missing generation inputs." });

  const admin = await getAdmin();
  const db = admin ? admin.firestore() : null;

  // 1. Authenticate (graceful — skipped if admin isn't configured).
  let uid = null;
  if (admin) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (token) { try { uid = (await admin.auth().verifyIdToken(token)).uid; } catch { /* anon */ } }
  }

  // 2. Entitlement (stub until Phase 6).
  const ent = await checkEntitlement(uid, kind, personalized);
  if (!ent.allowed) return res.status(402).json({ error: "paywall", reason: ent.reason || "upgrade_required" });

  // 3. Cache lookup. inputsHash dedupes identical requests; `personalized`
  //    content is keyed per-user so it never leaks into the shared library.
  const inputsHash = sha({ kind, personalized, uid: personalized ? uid : null, inputs });
  const canCache = db && spec.cacheable && !noCache;
  if (canCache) {
    try {
      const snap = await db.collection("generations").doc(inputsHash).get();
      if (snap.exists) {
        return res.status(200).json({ payload: snap.data().payload, cached: true, inputsHash });
      }
    } catch (e) { /* cache miss on error — fall through to generate */ }
  }

  // 4. Generate (model call, server-side).
  // Personalization engine (Phase 5): the module's prompt builders stay intact;
  // when personalized, a learner-context clause (built client-side from the
  // profile) is appended at the gateway layer. Known-vocabulary biasing already
  // rides inside inputs.vocab. General mode sends no persona → shared content.
  let prompt = spec.build(inputs);
  if (personalized && inputs.persona) prompt += `\n\n${inputs.persona}`;
  let text = "", usage = { input_tokens: 0, output_tokens: 0 };
  try {
    const r = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "X-Title": "Arabic Immersion App",
      },
      body: JSON.stringify({
        model: model || "openai/gpt-4o-mini",
        max_tokens: maxTokens || 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || "Generation failed" });
    text = data.choices?.[0]?.message?.content || "";
    usage = {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    };
  } catch (e) {
    return res.status(502).json({ error: "Failed to reach the model provider." });
  }

  const payload = spec.parse(text);
  if (!payload || (Array.isArray(payload) && !payload.length)) {
    return res.status(502).json({ error: "Could not read the generated content — try again." });
  }

  // 5. Persist: cache the output (promotable to the free library later) + log usage.
  if (db) {
    const now = Date.now();
    if (canCache) {
      try {
        await db.collection("generations").doc(inputsHash).set({
          kind, personalized, inputs, payload,
          uid: personalized ? uid : null,
          isFree: !personalized, // shared/general outputs are free-library candidates
          createdAt: now,
        });
      } catch (e) { /* non-fatal */ }
    }
    try {
      await db.collection("usage_events").add({
        uid: uid || null, type: "generation", kind, personalized,
        inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        createdAt: now,
      });
    } catch (e) { /* non-fatal */ }
  }

  return res.status(200).json({ payload, cached: false, inputsHash, usage });
}
