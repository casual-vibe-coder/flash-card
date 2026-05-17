// tts.js — Vercel serverless function (duplicate of api/tts.js for routing)
// See api/tts.js for full notes.

const DEFAULT_VOICE = 'ar-XA-Wavenet-C';
const DEFAULT_LANG  = 'ar-XA';
const DEFAULT_RATE  = 0.92;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_API_KEY || req.body.apiKey;
  if (!apiKey) return res.status(200).json({ audio: null, noKey: true });

  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ audio: null, error: 'Missing text' });

  const voice = req.body.voice || DEFAULT_VOICE;
  const speakingRate = Math.max(0.5, Math.min(2.0, Number(req.body.speed) || DEFAULT_RATE));

  try {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: DEFAULT_LANG, name: voice },
          audioConfig: { audioEncoding: 'MP3', speakingRate, sampleRateHertz: 24000 },
        }),
      }
    );
    const data = await response.json();
    if (!response.ok) {
      return res.status(200).json({ audio: null, error: data.error?.message || 'Google TTS error' });
    }
    if (!data.audioContent) {
      return res.status(200).json({ audio: null, error: 'No audio in response' });
    }
    return res.status(200).json({
      audio: `data:audio/mp3;base64,${data.audioContent}`,
      voice,
      speed: speakingRate,
    });
  } catch (error) {
    return res.status(200).json({ audio: null, error: error.message });
  }
}
