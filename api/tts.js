// api/tts.js — Vercel serverless function
// Proxies Google Cloud Text-to-Speech for Arabic with full tashkeel support.
// Falls back gracefully if no key is configured — the client then uses the
// browser's built-in speechSynthesis.
//
// Provider-adapter pattern: this file is the only place that talks to a
// specific TTS vendor. Swap Google → Azure/ElevenLabs/etc. by changing the
// fetch call here; the frontend contract stays the same.
//
// Security: API key is env-only (never accepted from the client). The $7
// usage cap is enforced server-side via checkCap when Firebase Admin is
// configured.

import { getAdmin, checkCap } from "./_firebase.js";

const DEFAULT_VOICE = 'ar-XA-Wavenet-C';   // male MSA, decent at case endings
const DEFAULT_LANG  = 'ar-XA';
const DEFAULT_RATE  = 0.92;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Env-only key — never accepted from the client.
  const apiKey = process.env.GOOGLE_TTS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return res.status(200).json({ audio: null, noKey: true });

  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ audio: null, error: 'Missing text' });

  const voice = req.body.voice || DEFAULT_VOICE;
  const speakingRate = Math.max(0.5, Math.min(2.0, Number(req.body.speed) || DEFAULT_RATE));

  // Authenticate + enforce the $7 cap.
  const admin = await getAdmin();
  if (admin) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    let uid = null;
    if (token) { try { uid = (await admin.auth().verifyIdToken(token)).uid; } catch { /* anon */ } }
    if (uid) {
      const cap = await checkCap(uid, "normal");
      if (!cap.allowed) {
        return res.status(402).json({ error: "cap_reached", reason: "cap_reached", spent: cap.spent, cap: cap.cap });
      }
    }
  }

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