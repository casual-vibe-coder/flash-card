// api/image.js — Vercel serverless function
// Proxies Gemini "Nano Banana" (gemini-2.5-flash-image) so the Google key stays server-side.
// Returns the generated image as a base64 data URL in DALL-E-compatible shape: { data: [{ url }] }.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GOOGLE_API_KEY || req.body.apiKey;
  if (!apiKey) return res.status(200).json({ data: null, noKey: true });

  const prompt = req.body.prompt;
  if (!prompt) return res.status(400).json({ data: null, error: 'Missing prompt' });

  const ALLOWED_MODELS = new Set(['gemini-2.5-flash-image', 'gemini-3.1-flash-image-preview']);
  const model = ALLOWED_MODELS.has(req.body.model) ? req.body.model : 'gemini-2.5-flash-image';

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(200).json({ data: null, error: data.error?.message || 'Gemini error' });
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData?.data || p.inline_data?.data);
    if (!imagePart) {
      return res.status(200).json({ data: null, error: 'No image in response' });
    }
    const inline = imagePart.inlineData || imagePart.inline_data;
    const mime = inline.mimeType || inline.mime_type || 'image/png';
    const dataUrl = `data:${mime};base64,${inline.data}`;
    return res.status(200).json({ data: [{ url: dataUrl }] });
  } catch (error) {
    return res.status(200).json({ data: null, error: error.message });
  }
}
