// api/claude.js — Vercel serverless function
// Routes all LLM calls through OpenRouter so you can switch models freely

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured in Vercel environment variables' });
  }

  // req.body contains { model, max_tokens, messages }
  const { model, max_tokens, messages } = req.body;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000',
        'X-Title': 'Arabic Flashcard App',
      },
      body: JSON.stringify({
        model: model || 'openai/gpt-4o-mini',
        max_tokens: max_tokens || 1000,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter error:', data);
      return res.status(response.status).json(data);
    }

    // Normalise to Anthropic-style shape so the frontend doesn't need to know which API was used
    // OpenRouter returns: data.choices[0].message.content
    const text = data.choices?.[0]?.message?.content || '';
    return res.status(200).json({
      content: [{ type: 'text', text }],
      usage: {
        input_tokens:  data.usage?.prompt_tokens     || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
      model: data.model,
    });
  } catch (error) {
    console.error('OpenRouter proxy error:', error);
    return res.status(500).json({ error: 'Failed to reach OpenRouter API' });
  }
}
