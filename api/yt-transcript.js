// api/yt-transcript.js — Vercel serverless function
// GET /api/yt-transcript?v=<videoId>  →  { videoId, title, lang, auto, lines:[{start,dur,text}] }
// Reads the video's own Arabic captions (no audio download, no API key).
// If the video has no Arabic captions it returns { error:"no_arabic_captions" }.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const WATCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Reads ytInitialPlayerResponse out of the public watch page.
async function getPlayer(videoId) {
  const r = await fetch('https://www.youtube.com/watch?v=' + videoId, {
    headers: { 'User-Agent': WATCH_UA, 'Accept-Language': 'ar,en;q=0.8', Cookie: 'CONSENT=YES+1' },
  });
  if (!r.ok) throw new Error('watch_' + r.status);
  const html = await r.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var|<\/script>)/s);
  if (!m) throw new Error('no_player_response');
  return JSON.parse(m[1]);
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

export async function fetchTranscript(videoId) {
  const player = await getPlayer(videoId);
  const status = player?.playabilityStatus?.status;
  if (status && status !== 'OK') return { error: 'unplayable', detail: player.playabilityStatus.reason || status };
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  // Prefer a human-made Arabic track over auto-generated (kind === 'asr').
  const ar = tracks.filter(t => (t.languageCode || '').startsWith('ar'));
  const track = ar.find(t => t.kind !== 'asr') || ar[0];
  if (!track) return { error: 'no_arabic_captions', available: tracks.map(t => t.languageCode) };
  const url = track.baseUrl.replace(/&fmt=[^&]*/, '') + '&fmt=json3';
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  const text = await r.text();
  if (!text) return { error: 'empty_caption_response' };
  const data = JSON.parse(text);
  const lines = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const t = decodeEntities(ev.segs.map(s => s.utf8 || '').join('')).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    lines.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text: t });
  }
  return {
    videoId,
    title: player?.videoDetails?.title || '',
    durationSec: +(player?.videoDetails?.lengthSeconds || 0),
    lang: track.languageCode,
    auto: track.kind === 'asr',
    lines,
  };
}

// Fallback: a transcript API (Supadata). Used only when SUPADATA_API_KEY is set
// in Vercel env vars — YouTube often blocks reading caption text directly.
// Cost: 1 credit per video that already has captions (see COST notes in the app).
async function fetchViaSupadata(videoId) {
  const key = process.env.SUPADATA_API_KEY;
  if (!key) return null;
  const url = 'https://api.supadata.ai/v1/transcript?url=' +
    encodeURIComponent('https://www.youtube.com/watch?v=' + videoId) + '&lang=ar&text=false';
  const r = await fetch(url, { headers: { 'x-api-key': key } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(data.content)) return { error: 'supadata_failed', detail: data.message || data.error || ('HTTP ' + r.status) };
  const lines = data.content
    .map(c => ({ start: (c.offset || 0) / 1000, dur: (c.duration || 0) / 1000, text: String(c.text || '').replace(/\s+/g, ' ').trim() }))
    .filter(l => l.text);
  return { videoId, title: '', durationSec: 0, lang: data.lang || 'ar', auto: false, lines, via: 'supadata' };
}

export default async function handler(req, res) {
  const videoId = String(req.query?.v || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'bad_video_id' });
  try {
    let out = null;
    try { out = await fetchTranscript(videoId); } catch (e) { out = { error: 'direct_failed', detail: String(e.message || e) }; }
    if (out.error === 'empty_caption_response' || out.error === 'direct_failed') {
      const viaApi = await fetchViaSupadata(videoId);
      if (viaApi && !viaApi.error) out = viaApi;
      else if (viaApi?.error) out = viaApi;
      else out = { error: 'needs_transcript_source', detail: 'YouTube blocked direct caption access and no SUPADATA_API_KEY is set.' };
    }
    if (!out.error) res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(out.error ? 404 : 200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', detail: String(e.message || e) });
  }
}
