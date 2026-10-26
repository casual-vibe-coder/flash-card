import { captionWords } from '../watch-timing.js';
// api/yt-transcript.js — Vercel serverless function
// GET /api/yt-transcript?v=<videoId>  →  { videoId, title, lang, auto, lines:[{start,dur,text}] }
// Reads the video's own Arabic captions (no audio download, no API key).
// If the video has no Arabic captions it returns { error:"no_arabic_captions" }.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const WATCH_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Reads ytInitialPlayerResponse out of the public watch page.
async function getPlayer(videoId) {
  const r = await fetch('https://www.youtube.com/watch?v=' + videoId, {
    signal: AbortSignal.timeout(6000),
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
  const r = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': UA } });
  if (!r.ok) return { error: 'caption_blocked', detail: 'YouTube caption access was blocked.' };
  const text = await r.text();
  if (!text) return { error: 'empty_caption_response' };
  const data = JSON.parse(text);
  const lines = [];
  for (const ev of data.events || []) {
    if (!ev.segs) continue;
    const t = decodeEntities(ev.segs.map(s => s.utf8 || '').join('')).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    lines.push({ start: (ev.tStartMs || 0) / 1000, dur: (ev.dDurationMs || 0) / 1000, text: t, ...(captionWords(ev, decodeEntities) ? { words: captionWords(ev, decodeEntities) } : {}) });
  }
  if (!lines.length) return { error: 'empty_caption_response', detail: 'The caption track contained no transcript text.' };
  return {
    via: 'youtube',
    videoId,
    title: player?.videoDetails?.title || '',
    durationSec: +(player?.videoDetails?.lengthSeconds || 0),
    lang: track.languageCode,
    auto: track.kind === 'asr',
    lines: lines.sort((a,b) => a.start-b.start),
  };
}

// Native mode must never silently start paid speech-to-text.
const SUPA = 'https://api.supadata.ai/v1/transcript';
const key = () => process.env.SUPADATA_API_KEY || process.env.SUPA_API_KEY;
export function normalizeSupadata(data, videoId) {
  const transcript = data.result && typeof data.result === 'object' ? data.result : data;
  if (!Array.isArray(transcript.content)) return { error: 'invalid_transcript', detail: 'The provider returned no timestamped transcript.' };
  const lines = transcript.content.map(c => ({ start: Number(c.offset) / 1000, dur: Number(c.duration) / 1000,
    text: String(c.text || '').replace(/\s+/g, ' ').trim() }))
    .filter(line => line.text && Number.isFinite(line.start) && line.start >= 0 && Number.isFinite(line.dur) && line.dur >= 0)
    .sort((a,b) => a.start - b.start);
  if (!lines.length) return { error: 'no_speech', detail: 'No speech was found in the returned transcript.' };
  if (transcript.lang && !String(transcript.lang).toLowerCase().startsWith('ar'))
    return { error: 'no_arabic_captions', detail: 'The returned transcript is not Arabic.' };
  return { videoId, title: '', durationSec: 0, lang: transcript.lang || 'ar', auto: false, via: 'supadata', lines };
}
function providerError(response, data, generating) {
  const code = typeof data.error === 'string' ? data.error : data.error?.code;
  if (response.status === 206 || code === 'transcript-unavailable')
    return { error: 'no_captions', detail: 'No existing transcript is available.', canGenerate: true };
  if ([401,403].includes(response.status)) return { error: 'transcript_auth', detail: 'The transcript service is not authorised. Its API key or access needs checking.', canGenerate: false };
  if (response.status === 402 || response.status === 429) return { error: 'transcript_limit', detail: 'The transcript service has reached a plan, rate or credit limit. Try again after the limit is resolved.', canGenerate: false };
  return { error: 'transcript_provider_failed', detail: generating ? 'Speech-to-text could not be completed. Please try again later.' : 'Existing captions could not be retrieved.', canGenerate: !generating };
}
async function fetchViaSupadata(videoId, generate) {
  if (!key()) return { error: 'needs_transcript_source', detail: 'Speech-to-text is not configured for this app yet.', canGenerate: false };
  const params = new URLSearchParams({ url: 'https://www.youtube.com/watch?v=' + videoId, lang: 'ar', text: 'false', mode: generate ? 'generate' : 'native' });
  const response = await fetch(SUPA + '?' + params, { headers: { 'x-api-key': key() }, signal: AbortSignal.timeout(generate ? 110000 : 15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error || response.status === 206) return providerError(response, data, generate);
  if (data.jobId) return { pending: true, jobId: data.jobId };
  return normalizeSupadata(data, videoId);
}
async function pollSupadata(jobId, videoId) {
  if (!key()) return { error: 'needs_transcript_source', detail: 'The transcript service is not configured.', canGenerate: false };
  const response = await fetch(SUPA + '/' + encodeURIComponent(jobId), { headers: { 'x-api-key': key() }, signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 404) return { error: 'job_expired', detail: 'This transcript job has expired. Starting a new transcription may incur a new charge.', canGenerate: true };
  if (!response.ok) return providerError(response, data, true);
  if (data.status === 'completed') return normalizeSupadata(data, videoId);
  if (data.status === 'failed') return { error: 'transcription_failed', detail: 'The speech-to-text job failed. No new job was started.' };
  if (['queued','active','processing','pending'].includes(data.status)) return { pending: true, jobId };
  return { error: 'invalid_job', detail: 'The transcript service returned an unknown job state. No new job was started.' };
}
export default async function handler(req, res) {
  const videoId = String(req.query?.v || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return res.status(400).json({ error: 'bad_video_id', canGenerate: false });
  const generate = req.query?.generate === '1';
  try {
    let out;
    if (req.query?.job) out = await pollSupadata(String(req.query.job), videoId);
    else if (generate) out = await fetchViaSupadata(videoId, true);
    else {
      try { out = await fetchTranscript(videoId); }
      catch { out = { error: 'direct_failed', detail: 'YouTube caption access was blocked or unavailable.' }; }
      if (out.error && out.error !== 'unplayable' && key()) out = await fetchViaSupadata(videoId, false);
    }
    if (out.error) {
      if (out.canGenerate == null) out.canGenerate = !!key() && !generate;
      if (!key() && !out.canGenerate) out.setupRequired = true;
      res.setHeader('Cache-Control', 'no-store');
      return res.status(out.error === 'needs_transcript_source' ? 503 : 422).json(out);
    }
    res.setHeader('Cache-Control', out.pending || generate || req.query?.job ? 'no-store' : 's-maxage=86400');
    return res.status(out.pending ? 202 : 200).json(out);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: 'fetch_failed', detail: generate ? 'Speech-to-text took too long or lost its connection. A provider request may still be billed; resume a saved job if available.' : 'The transcript service could not be reached.', canGenerate: !!key() && !generate });
  }
}
