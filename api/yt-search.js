// Caption availability must not hide videos that can use explicit speech-to-text.
const isoToSec = iso => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? +(m[1] || 0) * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0) : 0;
};
export default async function handler(req, res) {
  const q = String(req.query?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing_query', detail: 'Enter a video title or topic.' });
  const transcriptKey = process.env.SUPADATA_API_KEY || process.env.SUPA_API_KEY;
  const alternate = !!transcriptKey;
  try {
    if (req.query?.provider === 'supadata') {
      if (!transcriptKey) return res.status(503).json({ error: 'no_transcript_key', detail: 'Transcript-service search is not configured.' });
      const params = new URLSearchParams({ query: q, type: 'video', sortBy: 'relevance' });
      if (req.query?.captions === '1') params.set('features', 'subtitles');
      if (req.query?.pageToken) params.set('nextPageToken', String(req.query.pageToken));
      const r = await fetch('https://api.supadata.ai/v1/youtube/search?' + params, { headers: { 'x-api-key': transcriptKey }, signal: AbortSignal.timeout(15000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.error) return res.status(502).json({ error: 'search_provider_failed', detail: 'Transcript-service search is unavailable. Check its access, credits or rate limits.' });
      const items = (d.results || []).filter(v => v.type === 'video' && /^[\w-]{11}$/.test(v.id || '')).map(v => ({ id: v.id, title: v.title || '', channel: v.channel?.name || '', thumb: v.thumbnail || '', durationSec: Number(v.duration) || 0 }));
      res.setHeader('Cache-Control', 's-maxage=3600');
      return res.status(200).json({ items, next: d.nextPageToken || null, provider: 'supadata' });
    }
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) return res.status(503).json({ error: 'no_api_key', detail: 'YouTube search is not configured. You can still paste a video link.', canUseTranscriptSearch: alternate });
    const params = new URLSearchParams({ part: 'snippet', type: 'video', q, maxResults: '15', key,
      videoCaption: req.query?.captions === '1' ? 'closedCaption' : 'any', videoEmbeddable: 'true', relevanceLanguage: 'ar', safeSearch: 'moderate' });
    if (req.query?.pageToken) params.set('pageToken', String(req.query.pageToken));
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?' + params, { signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) return res.status(502).json({ error: 'youtube_error', detail: 'YouTube search is unavailable or its quota/access limit was reached. Try again later or paste a video link.', canUseTranscriptSearch: alternate });
    let durations = {};
    const ids = (d.items || []).map(v => v.id?.videoId).filter(Boolean);
    if (ids.length) {
      // Duration metadata is optional: a failed metadata call must not erase valid search results.
      try {
        const response = await fetch('https://www.googleapis.com/youtube/v3/videos?' + new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key }), { signal: AbortSignal.timeout(10000) });
        if (response.ok) { const metadata = await response.json(); for (const v of metadata.items || []) durations[v.id] = isoToSec(v.contentDetails?.duration); }
      } catch {}
    }
    const items = (d.items || []).filter(v => v.id?.videoId).map(v => ({ id: v.id.videoId, title: v.snippet?.title || '', channel: v.snippet?.channelTitle || '', thumb: v.snippet?.thumbnails?.medium?.url || '', durationSec: durations[v.id.videoId] || 0 }));
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ items, next: d.nextPageToken || null, provider: 'youtube', canUseTranscriptSearch: alternate });
  } catch {
    return res.status(502).json({ error: 'fetch_failed', detail: 'Search could not connect. Try again or paste a video link.', canUseTranscriptSearch: alternate });
  }
}
