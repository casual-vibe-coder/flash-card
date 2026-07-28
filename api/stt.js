// api/stt.js — Vercel serverless function
// Vendor-neutral speech-to-text proxy. Accepts base64 audio + optional provider
// hint, transcribes via OpenAI Whisper or Deepgram, returns plain text.
//
// Provider selection order:
//   1. DEEPGRAM_API_KEY env var → Deepgram
//   2. OPENAI_API_KEY env var → Whisper
//   3. Nothing set → { transcript: null, noKey: true } (client falls back to
//      browser Web Speech API)
//
// Security: API keys are env-only (never accepted from the client). The $7
// usage cap is enforced server-side via checkCap when Firebase Admin is
// configured.
//
// Audio is expected as a base64-encoded webm/ogg/wav blob from MediaRecorder.

import { getAdmin, checkCap } from "./_firebase.js";

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const audioB64 = req.body.audio;
  const mime = req.body.mime || 'audio/webm';
  const language = req.body.language || 'ar';
  const providerHint = (req.body.provider || '').toLowerCase();
  // Env-only keys — never accepted from the client.
  const openaiKey = process.env.OPENAI_API_KEY || '';
  const deepgramKey = process.env.DEEPGRAM_API_KEY || '';

  if (!audioB64) return res.status(400).json({ transcript: null, error: 'Missing audio' });
  if (!openaiKey && !deepgramKey) {
    return res.status(200).json({ transcript: null, noKey: true });
  }

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

  const useDeepgram =
    providerHint === 'deepgram' ||
    (!providerHint && deepgramKey && !openaiKey);

  try {
    const buf = Buffer.from(audioB64, 'base64');

    if (useDeepgram) {
      const dgRes = await fetch(
        `https://api.deepgram.com/v1/listen?model=nova-2&language=${language}&punctuate=true`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Token ${deepgramKey}`,
            'Content-Type': mime,
          },
          body: buf,
        }
      );
      const dg = await dgRes.json();
      if (!dgRes.ok) return res.status(200).json({ transcript: null, error: dg.err_msg || 'Deepgram error' });
      const transcript = dg.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
      return res.status(200).json({ transcript, provider: 'deepgram' });
    }

    // OpenAI Whisper (default)
    // Whisper validates the upload's file extension, so strip any ";codecs=..."
    // suffix — e.g. "audio/webm;codecs=opus" → "webm", not "webm;codecs=opus"
    // (the latter is an invalid extension and Whisper rejects it).
    const ext = (mime.split(';')[0].split('/')[1] || 'webm');
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), `audio.${ext}`);
    form.append('model', 'whisper-1');
    form.append('language', language);
    const oaRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}` },
      body: form,
    });
    const oa = await oaRes.json();
    if (!oaRes.ok) return res.status(200).json({ transcript: null, error: oa.error?.message || 'Whisper error' });
    return res.status(200).json({ transcript: oa.text || '', provider: 'whisper' });
  } catch (error) {
    return res.status(200).json({ transcript: null, error: error.message });
  }
}