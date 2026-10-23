// api/yt-search.js — Vercel serverless function
// GET /api/yt-search?q=<arabic query>&pageToken=  →  { items:[{id,title,channel,thumb,durationSec}], next }
// Official YouTube Data API v3. Needs YOUTUBE_API_KEY in Vercel env vars.
// Only returns embeddable videos that have captions (videoCaption=closedCaption).
// Quota: a search costs 100 units of the free 10,000/day (~99 searches/day).

const isoToSec = (iso) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  return m ? (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) : 0;
};

export default async function handler(req, res) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return res.status(501).json({ error: 'no_api_key', detail: 'Add YOUTUBE_API_KEY in Vercel → Settings → Environment Variables.' });
  const q = String(req.query?.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing_query' });
  try {
    const sp = new URLSearchParams({
      part: 'snippet', type: 'video', q, maxResults: '15', key,
      videoCaption: 'closedCaption', videoEmbeddable: 'true', relevanceLanguage: 'ar', safeSearch: 'moderate',
    });
    if (req.query?.pageToken) sp.set('pageToken', String(req.query.pageToken));
    const s = await (await fetch('https://www.googleapis.com/youtube/v3/search?' + sp)).json();
    if (s.error) return res.status(502).json({ error: 'youtube_error', detail: s.error.message });
    const ids = (s.items || []).map(i => i.id?.videoId).filter(Boolean);
    let dur = {};
    if (ids.length) {
      const v = await (await fetch('https://www.googleapis.com/youtube/v3/videos?' + new URLSearchParams({ part: 'contentDetails', id: ids.join(','), key }))).json();
      for (const it of v.items || []) dur[it.id] = isoToSec(it.contentDetails?.duration);
    }
    const items = (s.items || []).filter(i => i.id?.videoId).map(i => ({
      id: i.id.videoId,
      title: i.snippet?.title || '',
      channel: i.snippet?.channelTitle || '',
      thumb: i.snippet?.thumbnails?.medium?.url || '',
      durationSec: dur[i.id.videoId] || 0,
    }));
    res.setHeader('Cache-Control', 's-maxage=3600');
    return res.status(200).json({ items, next: s.nextPageToken || null });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', detail: String(e.message || e) });
  }
}
