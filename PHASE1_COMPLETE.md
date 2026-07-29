# Phase 1 — Completion Summary

> What was built to fulfill the PM's requirements: hide OpenRouter keys, harden
> security, verify auth, enforce a $7 per-user cap. Completed in one day.

---

## Requirements fulfilled

### 1. Hide OpenRouter (and all AI) keys from users
- **Removed** all API key input fields from Settings: OpenRouter, Google AI Studio, Google Cloud TTS, OpenAI Whisper.
- **Removed** all model picker dropdowns (default model + per-feature overrides).
- **Stopped sending** `apiKey` in all request bodies from the client (`callClaude`, `callGenerate`, `synthesizeArabic`, `getTtsSrc`, `transcribeAudio`, `generateImage`).
- **Removed** module-level key refs (`_orKey`, `_gKey`, `_ttsKey`, `_sttKey`) and their sync logic.
- **Removed** `orKey`/`gKey`/`ttsKey`/`sttKey` from the default settings object.
- **Removed** all error messages that referenced "check your API key in Settings."
- Users can no longer see, enter, or modify any provider API key.

### 2. Harden OpenRouter security — keys server-side only
- **All 5 serverless functions** (`api/claude.js`, `api/generate.js`, `api/tts.js`, `api/stt.js`, `api/image.js`) now use **env-only keys** — the `req.body.apiKey` fallback was removed from every handler.
- No AI provider key is exposed in the browser or in any client-facing code.
- Keys can be rotated by updating Vercel env vars — no frontend code change needed.
- **Deleted stale root duplicate files** (`claude.js`, `tts.js`, `stt.js`, `image.js` at repo root) — live copies remain in `api/`.

### 3. Quality-tier selector replaces model picker
- Users pick **Normal / High / Extra High** in Settings (one global dropdown).
- The client sends only `tier` — never a model id.
- The server (`api/_models.js`) resolves `tier → model` with env-var overrides.
- Defaults: `normal→openai/gpt-4o-mini`, `high→google/gemini-flash-1.5`, `extrahigh→openai/gpt-4o`.
- Fallback: on provider 5xx/rate-limit, the server retries once with the `normal` model.

### 4. $7 per-user usage cap — enforced from both sides
**Client-side guard** (instant feedback):
- `checkCap()` runs before every AI call (`callClaude`, `callGenerate`, `synthesizeArabic`, `getTtsSrc`, `transcribeAudio`, `generateImage`).
- If `spent >= cap` → throws `CapReachedError` + shows toast: "You've reached your $7.00 AI credit limit."

**Server-side enforcement** (tamper-proof):
- `checkCap(uid, tier)` in `api/_firebase.js` reads the user's Firestore doc, sums spend from `usage.byTag`, and checks against `settings.usageCap ?? 7`.
- Wired into all 5 serverless functions.
- Returns `402 { error: "cap_reached", spent, cap }` when blocked.
- Admins (by `role === "admin"` or `ADMINS` env allowlist) bypass the cap.

**New user initialization**:
- First sign-in creates the Firestore doc with `role: "user"`, `settings: { usageCap: 7, tier: "normal" }`.
- Existing users with missing `usageCap` are treated as `$7` (no migration needed).

### 5. Simplified credit display in UI
- **Home header**: compact pill badge showing `$X.XX / $7` (remaining out of total), color-coded.
- **Settings**: UsageMeter shows only `$X.XX remaining of $7.00` + a progress bar + cap-reached warning.
- **No detailed breakdown** — no per-feature table, no model names, no daily calculator, no reset button.
- All tracking still happens in code (`usage.byTag`, `MODEL_PRICES`, `computeSpent`) — just not shown to users.

### 6. Google auth verified
- `signInWithPopup` → new user doc created with defaults → no API-key screens → onboarding for first-time users.
- Session restore from localStorage (30-day TTL).
- Sign out clears state + returns to `LoginScreen`.

### 7. Firebase Admin SDK integration
- `api/_firebase.js` — lazy Firebase Admin init via `FIREBASE_SERVICE_ACCOUNT` env var.
- Verifies Firebase ID tokens on all serverless AI calls.
- `checkCap()` reads user usage from Firestore.
- Graceful fallback: if Admin SDK isn't configured, the gateway still generates (client-side guard is the fallback).

### 8. Firestore security rules
- `firestore.rules` created:
  - `users/{uid}` + `island/{key}` → owner-only.
  - `preset_decks` → read-only for authenticated users.
  - `generations`, `usage_events` → no client access (server-only via Admin SDK).
  - Default deny for everything else.

### 9. Admin override
- `ADMINS` env var (comma-separated emails) in `api/_firebase.js`.
- Admins bypass the $7 cap.
- Per-user cap override = admin edits `settings.usageCap` in the user's Firestore doc manually (no admin UI this phase).

---

## Files changed

| File | Change |
|---|---|
| `App.jsx` | Removed all key inputs, model dropdowns, detailed UsageMeter; added tier selector, compact credit badge, client-side `checkCap` guard, `CapReachedError`, `computeSpent()`, Firebase token on all AI calls |
| `api/_models.js` | **New** — tier→model resolution with env overrides |
| `api/_firebase.js` | Added `checkCap()`, `computeSpent()`, `isAdminEmail()`, pricing tables |
| `api/claude.js` | Env-only key, tier resolution, `checkCap`, fallback retry, Firebase token auth |
| `api/generate.js` | Env-only key, tier resolution, `checkCap` (replaced `checkEntitlement` stub), fallback retry |
| `api/tts.js` | Env-only key, `checkCap`, Firebase token auth |
| `api/stt.js` | Env-only key, `checkCap`, Firebase token auth |
| `api/image.js` | Env-only key, `checkCap`, Firebase token auth |
| `firestore.rules` | **New** — strict user data isolation |
| Root `claude.js`, `tts.js`, `stt.js`, `image.js` | **Deleted** (stale duplicates) |

---

## What's still needed from management (blockers)

These must be set in Vercel env vars before the server-side cap enforcement works in production:

1. **`OPENROUTER_API_KEY`** — SimplifAI-owned key (not personal).
2. **`FIREBASE_SERVICE_ACCOUNT`** — full JSON of a Firebase service account key.
3. **`ADMINS`** — comma-separated admin email addresses.

Optional (for image/TTS/STT features):
4. `GOOGLE_API_KEY` — Google AI Studio (image generation).
5. `GOOGLE_TTS_API_KEY` — Google Cloud TTS.
6. `OPENAI_API_KEY` — OpenAI Whisper (speech-to-text).

Optional (model overrides):
7. `MODEL_NORMAL`, `MODEL_HIGH`, `MODEL_EXTRAHIGH`.

---

## Known limitations / future work

- Reading, listening, and conversation modules still use `/api/claude` (not the `/api/generate` gateway with caching).
- No admin UI for editing per-user caps (manual Firestore edit only).
- No Stripe/billing or paid tiers yet (Phase 6+).
- Client-side pricing preview uses hardcoded model defaults — may drift slightly if env overrides a tier model.
- `FIREBASE_SERVICE_ACCOUNT` env is required for server-side cap enforcement to be tamper-proof.