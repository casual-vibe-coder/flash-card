// api/image.js — Vercel serverless function
// Proxies DALL-E image generation so the OpenAI key stays server-side

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Return graceful null instead of error — app shows scene description fallback
    return res.status(200).json({ data: null, noKey: true });
  }

  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('DALL-E error:', data);
      return res.status(200).json({ data: null, error: data.error?.message });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error('Image generation error:', error);
    return res.status(200).json({ data: null, error: error.message });
  }
}
