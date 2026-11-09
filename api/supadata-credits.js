// Reports the transcript service's (Supadata) credit balance so the app can
// show when credits have run out. The API key stays on the server.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = process.env.SUPADATA_API_KEY || process.env.SUPA_API_KEY;
  if (!key) return res.status(200).json({ configured: false });
  try {
    const r = await fetch('https://api.supadata.ai/v1/me', { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(10000) });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403) return res.status(200).json({ configured: true, error: 'auth', detail: 'The transcript service rejected its API key.' });
    if (!r.ok) return res.status(200).json({ configured: true, error: 'unavailable', detail: `The transcript service returned HTTP ${r.status}.` });
    const max = Number(d.maxCredits), used = Number(d.usedCredits);
    if (!Number.isFinite(max) || !Number.isFinite(used)) return res.status(200).json({ configured: true, error: 'unavailable', detail: 'The credit balance was not in the response.' });
    return res.status(200).json({ configured: true, plan: d.plan || '', used, max, remaining: Math.max(0, max - used), exhausted: used >= max });
  } catch {
    return res.status(200).json({ configured: true, error: 'unavailable', detail: 'The transcript service could not be reached.' });
  }
}
