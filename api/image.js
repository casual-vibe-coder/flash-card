export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.OPENAI_API_KEY || req.body.apiKey;
  if (!apiKey) return res.status(200).json({ data: null, noKey: true });
  const { apiKey: _removed, ...imageBody } = req.body;
  try {
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(imageBody),
    });
    const data = await response.json();
    if (!response.ok) return res.status(200).json({ data: null, error: data.error?.message });
    return res.status(200).json(data);
  } catch (error) {
    return res.status(200).json({ data: null, error: error.message });
  }
}
