// api/_openrouter.js — shared OpenRouter chat-completions call (underscore = not a route).
//
// Why this exists: reasoning models (GLM 5.x, DeepSeek, Qwen, Gemini 3.x, ...) spend
// max_tokens on hidden "thinking" BEFORE writing the answer. With the small token
// budgets these prompts use (a word lookup is ~200 tokens), the budget is gone before
// any answer text appears → message.content is "" and finish_reason is "length".
// The app then reported "Empty response from AI". Fix at the source:
//   1. ask OpenRouter to switch reasoning off (these are short structured-JSON tasks);
//   2. if a model can't switch it off and still comes back empty + "length",
//      retry once with a bigger budget instead of failing.

const URL = "https://openrouter.ai/api/v1/chat/completions";

async function post(apiKey, body, title) {
  const r = await fetch(URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000",
      "X-Title": title,
    },
    body: JSON.stringify(body),
  });
  let data;
  try { data = await r.json(); }
  catch { data = { error: { message: `OpenRouter returned HTTP ${r.status} with an unreadable body.` } }; }
  return { r, data };
}

function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(p => (typeof p === "string" ? p : p?.text || "")).join("");
  return "";
}

export async function chatComplete({ apiKey, model, max_tokens, messages, title = "Arabic Flashcard App" }) {
  const base = { model, max_tokens, messages };

  let { r, data } = await post(apiKey, { ...base, reasoning: { enabled: false } }, title);
  // A model/provider that rejects the reasoning param: retry plain.
  if (!r.ok && r.status === 400 && /reasoning/i.test(JSON.stringify(data?.error || data))) {
    ({ r, data } = await post(apiKey, base, title));
  }
  // OpenRouter can return HTTP 200 with an {error} body (upstream provider failure).
  if (r.ok && data?.error && !data?.choices?.length) {
    return { ok: false, status: 502, data: { error: data.error?.message || "The model provider returned an error." } };
  }
  if (!r.ok) return { ok: false, status: r.status, data };

  let text = extractText(data);
  let retried = false;
  if (!text && data?.choices?.[0]?.finish_reason === "length") {
    retried = true;
    const bigger = Math.min(16000, (max_tokens || 1000) * 4);
    const second = await post(apiKey, { ...base, max_tokens: bigger }, title);
    if (second.r.ok && !second.data?.error) { data = second.data; text = extractText(data); }
  }

  const choice = data?.choices?.[0];
  return {
    ok: true,
    status: 200,
    text,
    usage: {
      input_tokens: data?.usage?.prompt_tokens || 0,
      output_tokens: data?.usage?.completion_tokens || 0,
    },
    // Small on purpose — the client turns this into a short, readable error.
    meta: {
      model: data?.model || model,
      finish_reason: choice?.finish_reason || null,
      reasoning_chars: (choice?.message?.reasoning || "").length,
      retried,
    },
  };
}
