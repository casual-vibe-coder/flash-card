// api/tts.js — Vercel serverless function
// Proxies Google Cloud Text-to-Speech for Arabic with full tashkeel support.
// Falls back gracefully if no key is configured — the client then uses the
// browser's built-in speechSynthesis.
//
// Provider-adapter pattern: this file is the only place that talks to a
// specific TTS vendor. Swap Google → Azure/ElevenLabs/etc. by changing the
// fetch call here; the frontend contract stays the same.

const DEFAULT_VOICE = 'ar-XA-Wavenet-C';   // male MSA, decent at case endings
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
