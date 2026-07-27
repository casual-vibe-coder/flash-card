import { resolveModel, TIER_TO_MODEL, FALLBACK_TIER } from "./_models.js";

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Env-only key — never accepted from the client.
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'AI service not configured (server key missing).' });

  const { tier, max_tokens, messages } = req.body;
  const model = resolveModel(tier);

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000',
        'X-Title': 'Arabic Flashcard App',
      },
      body: JSON.stringify({ model, max_tokens: max_tokens || 1000, messages }),
    });
    const data = await response.json();

    // Retry once on 5xx / rate-limit using the fallback (normal-tier) model.
    if (!response.ok && (response.status >= 500 || response.status === 429) && tier !== FALLBACK_TIER) {
      const fallbackModel = TIER_TO_MODEL[FALLBACK_TIER];
      const retry = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000',
          'X-Title': 'Arabic Flashcard App',
        },
        body: JSON.stringify({ model: fallbackModel, max_tokens: max_tokens || 1000, messages }),
      });
      const retryData = await retry.json();
      if (!retry.ok) return res.status(retry.status).json(retryData);
      const retryText = retryData.choices?.[0]?.message?.content || '';
      return res.status(200).json({
        content: [{ type: 'text', text: retryText }],
        usage: { input_tokens: retryData.usage?.prompt_tokens || 0, output_tokens: retryData.usage?.completion_tokens || 0 },
      });
    }

    if (!response.ok) return res.status(response.status).json(data);
    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({
      content: [{ type: 'text', text }],
      usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 },
    });
  } catch (error) {
    return res.status(502).json({ error: 'Failed to reach the AI service.' });
  }
}