// stt.js — duplicate of api/stt.js for Vercel routing.
// See api/stt.js for full notes.

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const audioB64 = req.body.audio;
  const mime = req.body.mime || 'audio/webm';
  const language = req.body.language || 'ar';
  const providerHint = (req.body.provider || '').toLowerCase();
  const openaiKey = process.env.OPENAI_API_KEY || req.body.openaiKey || '';
  const deepgramKey = process.env.DEEPGRAM_API_KEY || req.body.deepgramKey || '';

  if (!audioB64) return res.status(400).json({ transcript: null, error: 'Missing audio' });
  if (!openaiKey && !deepgramKey) {
    return res.status(200).json({ transcript: null, noKey: true });
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

    const form = new FormData();
    form.append('file', new Blob([buf], { type: mime }), `audio.${mime.split('/')[1] || 'webm'}`);
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
