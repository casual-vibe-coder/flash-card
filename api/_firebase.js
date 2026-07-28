// api/_firebase.js — lazy Firebase Admin init + server-side usage cap enforcement.
//
// Set the env var FIREBASE_SERVICE_ACCOUNT (the full JSON of a Firebase
// service-account key) in Vercel to enable the gateway's server-side features:
//   • verifying the caller's Firebase ID token (auth)
//   • the generation cache  (Firestore collection `generations`)
//   • usage logging         (Firestore collection `usage_events`)
//   • per-user $7 usage cap enforcement (checkCap)
//
// Without it the gateway STILL generates — it just skips auth/cache/logging/cap,
// so local dev and first deploys keep working. The client-side guard (in App.jsx)
// remains as a fallback. Activate the full pipeline by adding the env var.
// Admin is imported dynamically so the dependency only loads when configured.

import { resolveModel } from "./_models.js";

let _admin = null;
let _tried = false;

export async function getAdmin() {
  if (_tried) return _admin;
  _tried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return _admin; // not configured → graceful no-op mode
  try {
    const admin = (await import("firebase-admin")).default;
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    }
    _admin = admin;
  } catch (e) {
    console.error("[gateway] Firebase Admin init failed:", e?.message || e);
    _admin = null;
  }
  return _admin;
}

// ─── Pricing tables (mirror of App.jsx client-side) ───
// Used by checkCap to compute total spend from usage.byTag.
const MODEL_PRICES = {
  "openai/gpt-4o-mini":         { in: 0.15, out: 0.60 },
  "openai/gpt-4o":              { in: 2.50, out: 10.0 },
  "openai/gpt-4.1-mini":        { in: 0.40, out: 1.60 },
  "anthropic/claude-3.5-sonnet":{ in: 3.0,  out: 15.0 },
  "anthropic/claude-3-haiku":   { in: 0.25, out: 1.25 },
  "anthropic/claude-sonnet-4-5":{ in: 3.0,  out: 15.0 },
  "google/gemini-flash-1.5":    { in: 0.075,out: 0.30 },
  "google/gemini-pro-1.5":      { in: 1.25, out: 5.0 },
  "meta-llama/llama-3.3-70b-instruct": { in: 0.40, out: 0.40 },
};
const PRICE_FALLBACK = { in: 0.15, out: 0.60 };

const TTS_PRICE_PER_CHAR = 16 / 1_000_000;
const STT_PRICE_PER_SECOND = 0.006 / 60;

const IMAGE_PRICES = {
  "gemini-2.5-flash-image": 0.039,
  "gemini-3.1-flash-image-preview": 0.067,
};

const TAG_TO_IMAGE_MODEL = {
  imageNB1: "gemini-2.5-flash-image",
  imageNB2: "gemini-3.1-flash-image-preview",
};

const NON_TEXT_TAGS = new Set(["imageNB1", "imageNB2", "ttsGoogle", "sttWhisper"]);

// Compute total spent (USD) from a usage.byTag object.
function computeSpent(byTag, tier) {
  if (!byTag) return 0;
  const tierModel = resolveModel(tier);
  let total = 0;
  for (const [tag, v] of Object.entries(byTag)) {
    if (!v || v.calls === 0) continue;
    const imgModel = TAG_TO_IMAGE_MODEL[tag];
    if (imgModel) { total += v.calls * (IMAGE_PRICES[imgModel] || 0); continue; }
    if (tag === "ttsGoogle") { total += v.inputTokens * TTS_PRICE_PER_CHAR; continue; }
    if (tag === "sttWhisper") { total += v.inputTokens * STT_PRICE_PER_SECOND; continue; }
    // Text tags: use the tier-resolved model pricing.
    const p = MODEL_PRICES[tierModel] || PRICE_FALLBACK;
    total += v.inputTokens * p.in / 1_000_000 + v.outputTokens * p.out / 1_000_000;
  }
  return total;
}

// Check if an email is in the ADMINS env var allowlist.
function isAdminEmail(email) {
  const admins = (process.env.ADMINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return admins.includes((email || "").toLowerCase());
}

// ─── checkCap — the server-side usage cap enforcement ───
//
// Reads the user's Firestore doc, sums their spend, and checks against their cap.
// Admins (by role field or ADMINS env allowlist) bypass the cap.
//
// Returns: { allowed: boolean, spent: number, cap: number, reason?: string }
//
// If Firebase Admin isn't configured (no FIREBASE_SERVICE_ACCOUNT env), this
// gracefully allows the request — the client-side guard in App.jsx is the
// fallback. This keeps local dev and first deploys working.
export async function checkCap(uid, tier = "normal") {
  const admin = await getAdmin();
  if (!admin) return { allowed: true, spent: 0, cap: 7, reason: "admin_not_configured" };

  try {
    const db = admin.firestore();
    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) return { allowed: true, spent: 0, cap: 7, reason: "new_user" };

    const data = snap.data();
    const cap = data.settings?.usageCap ?? 7;
    const role = data.role || "user";

    // Admin bypass — by role field or ADMINS env allowlist.
    if (role === "admin") return { allowed: true, spent: 0, cap, reason: "admin_role" };

    // Look up the user's email for the ADMINS allowlist check.
    try {
      const userRecord = await admin.auth().getUser(uid);
      if (isAdminEmail(userRecord.email)) {
        return { allowed: true, spent: 0, cap, reason: "admin_allowlist" };
      }
    } catch { /* user lookup failed — continue with cap check */ }

    // Compute total spent from usage.byTag.
    const byTag = data.usage?.byTag || {};
    const spent = computeSpent(byTag, tier);

    if (spent >= cap) {
      return { allowed: false, spent, cap, reason: "cap_reached" };
    }
    return { allowed: true, spent, cap };
  } catch (e) {
    console.error("[checkCap] Error reading user usage:", e?.message || e);
    // On error, allow the request — don't block users due to a DB issue.
    return { allowed: true, spent: 0, cap: 7, reason: "check_error" };
  }
}
