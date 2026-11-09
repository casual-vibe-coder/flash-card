import { chatComplete } from './_openrouter.js';
import { getAdmin } from './_firebase.js';

// The server's own OpenRouter key is only used for signed-in users: a request
// that brings its own key (from the app's Settings) is passed straight through,
// but one that falls back to the server key must carry a valid Firebase ID token.
async function signedIn(req) {
  const admin = await getAdmin();
  if (!admin) return false;
  const header = String(req.headers?.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return false;
  try { await admin.auth().verifyIdToken(token); return true; } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { model, max_tokens, messages, apiKey: userKey } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages provided.' });
  const ownKey = (userKey || '').trim();
  const apiKey = ownKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No API key provided. Add your OpenRouter key in Settings.' });
  if (!ownKey && !(await signedIn(req))) {
    return res.status(401).json({ error: 'Please sign in again to use the shared AI key, or add your own OpenRouter key in Settings.' });
  }
  try {
    const result = await chatComplete({
      apiKey,
      model: model || 'openai/gpt-4o-mini',
      max_tokens: Math.min(Number(max_tokens) || 1000, 8000),
      messages,
    });
    if (!result.ok) return res.status(result.status).json(result.data);
    return res.status(200).json({
      content: [{ type: 'text', text: result.text }],
      usage: result.usage,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to reach OpenRouter' });
  }
}
