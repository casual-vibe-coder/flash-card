// Balances for the paid services the app calls, read server-side so keys never
// reach the browser. Only providers that expose a balance to a normal API key
// are queried; the rest are reported as "no balance API" with where to look.
// A key typed into the app's Settings (sent as x-or-key) is used for OpenRouter
// in place of the server key, matching how the app makes its AI calls.
const timeout = () => AbortSignal.timeout(10000);
const json = async r => r.json().catch(() => ({}));

async function openrouter(userKey) {
  const key = (userKey || '').trim() || process.env.OPENROUTER_API_KEY;
  if (!key) return { id: 'openrouter', name: 'OpenRouter (AI text)', status: 'not_configured' };
  const headers = { Authorization: 'Bearer ' + key };
  const [credits, info] = await Promise.all([
    fetch('https://openrouter.ai/api/v1/credits', { headers, signal: timeout() }),
    fetch('https://openrouter.ai/api/v1/key', { headers, signal: timeout() }),
  ]);
  if (credits.status === 401 || info.status === 401) return { id: 'openrouter', name: 'OpenRouter (AI text)', status: 'error', detail: 'OpenRouter rejected the API key.' };
  const c = (await json(credits)).data, k = (await json(info)).data;
  // /credits is the account balance; /key can carry a per-key spending limit.
  if (c && Number.isFinite(c.total_credits) && Number.isFinite(c.total_usage)) {
    const remaining = c.total_credits - c.total_usage;
    const keyLeft = Number.isFinite(k?.limit_remaining) ? k.limit_remaining : null;
    return { id: 'openrouter', name: 'OpenRouter (AI text)', status: 'ok', unit: 'usd', remaining, total: c.total_credits, used: c.total_usage,
      note: keyLeft != null ? `This key also has a spending limit with $${keyLeft.toFixed(2)} left.` : '', exhausted: remaining <= 0 || (keyLeft != null && keyLeft <= 0) };
  }
  if (k && Number.isFinite(k.usage)) return { id: 'openrouter', name: 'OpenRouter (AI text)', status: 'ok', unit: 'usd', used: k.usage,
    remaining: Number.isFinite(k.limit_remaining) ? k.limit_remaining : null, total: Number.isFinite(k.limit) ? k.limit : null,
    note: 'The account balance needs a different key type; showing this key\'s usage.', exhausted: Number.isFinite(k.limit_remaining) && k.limit_remaining <= 0 };
  return { id: 'openrouter', name: 'OpenRouter (AI text)', status: 'error', detail: 'OpenRouter did not return a balance.' };
}

async function supadata() {
  const key = process.env.SUPADATA_API_KEY || process.env.SUPA_API_KEY;
  if (!key) return { id: 'supadata', name: 'Supadata (video transcripts)', status: 'not_configured' };
  const r = await fetch('https://api.supadata.ai/v1/me', { headers: { 'x-api-key': key }, signal: timeout() });
  if ([401, 403].includes(r.status)) return { id: 'supadata', name: 'Supadata (video transcripts)', status: 'error', detail: 'Supadata rejected the API key.' };
  const d = await json(r), max = Number(d.maxCredits), used = Number(d.usedCredits);
  if (!r.ok || !Number.isFinite(max) || !Number.isFinite(used)) return { id: 'supadata', name: 'Supadata (video transcripts)', status: 'error', detail: `Supadata returned HTTP ${r.status}.` };
  return { id: 'supadata', name: 'Supadata (video transcripts)', status: 'ok', unit: 'credits', used, total: max, remaining: Math.max(0, max - used), exhausted: used >= max, note: d.plan ? `${d.plan} plan` : '' };
}

async function deepgram() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return { id: 'deepgram', name: 'Deepgram (speech-to-text)', status: 'not_configured' };
  const headers = { Authorization: 'Token ' + key };
  const p = await fetch('https://api.deepgram.com/v1/projects', { headers, signal: timeout() });
  if ([401, 403].includes(p.status)) return { id: 'deepgram', name: 'Deepgram (speech-to-text)', status: 'error', detail: 'Deepgram rejected the API key.' };
  const id = (await json(p)).projects?.[0]?.project_id;
  if (!id) return { id: 'deepgram', name: 'Deepgram (speech-to-text)', status: 'error', detail: 'No Deepgram project found for this key.' };
  const b = await fetch(`https://api.deepgram.com/v1/projects/${id}/balances`, { headers, signal: timeout() });
  if (!b.ok) return { id: 'deepgram', name: 'Deepgram (speech-to-text)', status: 'error', detail: 'This Deepgram key is not allowed to read balances.' };
  const balances = (await json(b)).balances || [];
  const amount = balances.reduce((n, x) => n + (Number(x.amount) || 0), 0);
  return { id: 'deepgram', name: 'Deepgram (speech-to-text)', status: 'ok', unit: 'usd', remaining: amount, exhausted: balances.length > 0 && amount <= 0 };
}

const manual = [
  { id: 'openai', name: 'OpenAI (Whisper, DALL-E images)', status: 'no_api', note: 'OpenAI does not let an API key read its balance.', url: 'https://platform.openai.com/settings/organization/billing/overview', configured: !!process.env.OPENAI_API_KEY },
  { id: 'google', name: 'Google (Gemini images, text-to-speech)', status: 'no_api', note: 'Google bills after the fact and exposes no balance to an API key.', url: 'https://console.cloud.google.com/billing', configured: !!(process.env.GOOGLE_API_KEY || process.env.GOOGLE_TTS_API_KEY) },
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const settled = await Promise.allSettled([openrouter(req.headers['x-or-key']), supadata(), deepgram()]);
  const names = ['OpenRouter (AI text)', 'Supadata (video transcripts)', 'Deepgram (speech-to-text)'];
  const services = settled.map((s, i) => s.status === 'fulfilled' ? s.value : { id: names[i], name: names[i], status: 'error', detail: 'Could not be reached.' });
  return res.status(200).json({ services: [...services, ...manual], checkedAt: Date.now() });
}
