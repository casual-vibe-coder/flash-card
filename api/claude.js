import { chatComplete } from './_openrouter.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { model, max_tokens, messages, apiKey: userKey } = req.body;
  const apiKey = (userKey || '').trim() || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No API key provided. Add your OpenRouter key in Settings.' });
  try {
    const result = await chatComplete({
      apiKey,
      model: model || 'openai/gpt-4o-mini',
      max_tokens: max_tokens || 1000,
      messages,
    });
    if (!result.ok) return res.status(result.status).json(result.data);
    return res.status(200).json({
      content: [{ type: 'text', text: result.text }],
      usage: result.usage,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to reach OpenRouter' });
  }
}
