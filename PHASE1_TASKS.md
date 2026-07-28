# Phase 1 — Security Hardening & $7 Usage Cap (Task List)

> Scope: hide all AI keys from users, move to env-only server-side, add $7 per-user cap
> with client + server enforcement, replace model picker with quality-tier selector.
> Target: 1 day of execution.
> Source: PM handoff doc + roadmap + developer decisions.

---

## Models (tier → OpenRouter model, env-overridable)

| Tier | Default model | Env override |
|---|---|---|
| `normal` | `openai/gpt-4o-mini` | `MODEL_NORMAL` |
| `high` | `google/gemini-flash-1.5` | `MODEL_HIGH` |
| `extrahigh` | `openai/gpt-4o` | `MODEL_EXTRAHIGH` |

- Fallback tier = `normal`.
- On provider error → retry once with `normal` model.
- Client sends `tier` only, never `model`.
- Client pricing preview uses hardcoded defaults (env overrides are server-side only).

---

## 🌅 Morning — Client UI (no env needed)

### [1] Strip all key inputs + model dropdowns from `App.jsx`  *(PM 3, 9)* — ✅ DONE
- [x] Delete the **API Keys card** — OpenRouter + Google AI Studio inputs.
- [x] Delete **TTS key** and **STT key** inputs in the Voice section.
- [x] Delete the **AI Model · Default** dropdown.
- [x] Delete the **Per-Feature Override** block.
- [x] Delete the **Image Model** dropdown (kept the auto-generate toggle).
- [x] Remove the now-unused `_orKey`, `_gKey`, `_ttsKey`, `_sttKey` module refs.
- [x] Remove their sync in the `useEffect`.
- [x] Remove `orKey/gKey/ttsKey/sttKey` from the default `settings` object.
- [x] Stop sending `apiKey` in request bodies (callClaude, callGenerate, TTS, STT, image).
- [x] Remove "Where you're billed" block from UsageMeter (no longer user-billed).
- [x] Update all error messages that referenced "check your API key in Settings".
- [x] `npm run build` passes.

### [2] Add quality-tier selector + shared model map  *(new requirement)* — ✅ DONE
- [x] Create `api/_models.js` exporting `TIER_TO_MODEL` (env-overridable) + `FALLBACK_TIER` + `resolveModel()`.
- [x] In Settings, add a single dropdown: **Normal / High / Extra High** (default `normal`).
- [x] Persist as `settings.tier` in the user doc.
- [x] Stop sending `model` from client; send `tier` instead (callClaude + callGenerate).
- [x] Client imports hardcoded defaults for pricing preview only (`TIER_TO_MODEL`, `resolveTierModel`).
- [x] `api/claude.js` resolves tier → model, env-only key, fallback retry on 5xx/429.
- [x] `api/generate.js` resolves tier → model, env-only key, fallback retry on 5xx/429.
- [x] UsageMeter `modelForTag` + `activeModel` resolve via tier.
- [x] `npm run build` passes; `node --check` passes on all api files.

### [3] Update UsageMeter UI to show remaining credit  *(PM 6 + new requirement)* — ✅ DONE
- [x] Header now shows: **"$X.XX of $7.00 · $Y.YY remaining"** + a progress bar.
- [x] Read cap from `settings.usageCap ?? 7`.
- [x] Use existing `usage.byTag` + `MODEL_PRICES` (already wired).
- [x] Color-coded bar: green (<15%), amber (<70%), red (≥cap).
- [x] Warning banner shown when cap is reached: "⚠ You've reached your $7 AI credit cap."
- [x] Expanded view shows Spent (vs cap) + Remaining lines.
- [x] `npm run build` passes.

### [4] Client-side cap guard  *(PM 7, 13)* — ✅ DONE
- [x] Added module-level `CapReachedError` class (typed error with `capReached` flag).
- [x] Added `computeSpent(byTag)` function using the same pricing tables as UsageMeter.
- [x] Added `checkCap()` that throws `CapReachedError` + shows toast when cap is hit.
- [x] Added `checkCap()` guard at the start of: `callClaude`, `callGenerate`, `synthesizeArabic`, `getTtsSrc`, `transcribeAudio`, `generateImage`.
- [x] Added module-level refs `_usageByTag`, `_usageCap`, `_isAdmin` synced from App state.
- [x] Admin users (`role === "admin"` in user doc) bypass the cap.
- [x] Existing callers' catch blocks display the error message gracefully.
- [x] `npm run build` passes.

---

## ☀️ Afternoon — Server-side (env ideal, codeable without)

### [5] Init `usageCap:7` on new user signup  *(PM 7)* — ✅ DONE
- [x] Added `usageCap: 7` to the default `settings` object.
- [x] On first sign-in (user doc doesn't exist), explicitly creates the doc with `role: "user"`, `settings: { usageCap: 7, tier: "normal" }`, `createdAt`.
- [x] Existing users with missing `usageCap` → treated as `7` in code (no migration needed).
- [x] `_isAdmin` synced from `d.role === "admin"` on user doc load.
- [x] `npm run build` passes.

### [6] Write `checkCap(uid)` helper in `api/_firebase.js`  *(PM 7)* — ✅ DONE
- [x] Added server-side pricing tables (mirror of client `MODEL_PRICES`, `IMAGE_PRICES`, etc.).
- [x] Added `computeSpent(byTag, tier)` function using `resolveModel()` from `_models.js`.
- [x] Added `checkCap(uid, tier)` — reads `users/{uid}` via Firebase Admin.
- [x] Reads `settings.usageCap ?? 7` and `role`.
- [x] Admin bypass: `role === "admin"` OR email in `ADMINS` env allowlist.
- [x] If `spent >= cap` → returns `{ allowed: false, spent, cap, reason: "cap_reached" }`.
- [x] Graceful fallback: if Admin SDK not configured, allows (client guard is fallback).
- [x] Wired `checkCap` into `api/claude.js` (verifies Firebase ID token first).
- [x] Wired `checkCap` into `api/generate.js` (replaced old `checkEntitlement` stub).
- [x] `callClaude` now sends Firebase ID token (was missing before).
- [x] Client handles 402 `cap_reached` → throws `CapReachedError`.
- [x] `node --check` passes on all API files; `npm run build` passes.

### [7] Wire `checkCap` + tier resolution into `api/claude.js` and `api/generate.js`  *(PM 4, 7, 13)* — ✅ DONE (completed alongside Task 6)
- [x] Remove `req.body?.apiKey` / `userKey` fallback → env-only.
- [x] Resolve `tier → TIER_TO_MODEL[tier]`, fallback to `normal` if invalid.
- [x] Call `checkCap(uid)` before the OpenRouter request.
- [x] If blocked → return `402 { error: "cap_reached", spent, cap }`.
- [x] On provider 5xx/rate-limit → retry once with `normal` model.
- [x] Keep writing `usage_events` (already done in `generate.js:165`).
- [x] `callClaude` now sends Firebase ID token (was missing before).
- [x] `checkEntitlement` stub removed from `generate.js`, replaced by `checkCap`.

### [8] Lock `api/tts.js`, `api/stt.js`, `api/image.js` to env-only  *(PM 4, 5)* — ✅ DONE
- [x] `api/tts.js`: removed `req.body.apiKey` fallback → env-only (`GOOGLE_TTS_API_KEY` / `GOOGLE_API_KEY`).
- [x] `api/stt.js`: removed `req.body.openaiKey` / `req.body.deepgramKey` fallbacks → env-only.
- [x] `api/image.js`: removed `req.body.apiKey` fallback → env-only (`GOOGLE_API_KEY`).
- [x] Added `checkCap` enforcement to all three (auth + cap check before the provider call).
- [x] Client sends Firebase ID token on TTS, STT, and image calls.
- [x] Client handles 402 `cap_reached` from all three.
- [x] `node --check` passes on all API files; `npm run build` passes.

### [9] Admin allowlist  *(PM 7 admin flag)* — ✅ DONE (completed alongside Task 6)
- [x] `isAdminEmail()` in `api/_firebase.js` reads `ADMINS` env var (comma-separated emails).
- [x] `checkCap()` checks both `role === "admin"` (from user doc) AND email allowlist.
- [x] Per-user `usageCap` override = admin edits the user's Firestore `settings.usageCap` manually (no UI this phase).

### [10] Verify Google auth + clean empty new account  *(PM 8)* — ✅ VERIFIED
- [x] Fresh Google sign-in via `signInWithPopup` → user doc created with `usageCap:7, role:"user", tier:"normal"`.
- [x] New user starts with seed decks (starter content, not API-key screens).
- [x] No API-key screens visible to any user (removed in Task 1).
- [x] Auth state gating: loading spinner → `LoginScreen` → app.
- [x] Session restore from localStorage with 30-day TTL; reload skips onboarding for existing users.
- [x] Sign out: clears sessions + study history, calls `signOut(auth)`, returns to `LoginScreen`.

### [11] Firestore rules  *(PM 10, 11)* — ✅ DONE
- [x] Created `firestore.rules`:
  - `users/{uid}` → read/write only if `request.auth.uid == uid`.
  - `users/{uid}/island/{key}` → owner-only (Language Island capsule sync).
  - `preset_decks` → read-only for authenticated users.
  - `generations`, `usage_events` → **no client access** (server-only via Admin SDK).
  - Default deny for everything else.
- [x] No Cloud Storage used (per `STACK.md`) → nothing to write.
- [x] `npm run build` passes.

### [12] Cleanup: delete stale root duplicates — ✅ DONE
- [x] Deleted repo-root `claude.js`, `tts.js`, `stt.js`, `image.js`.
- [x] Live copies remain in `api/` (the ones Vercel uses).
- [x] `npm run build` passes after deletion.

---

## 🌙 Evening — Docs & QA

### [13] QA test checklist into `TESTING.md`  *(PM 12)*
- [ ] Signup → text gen → image gen → TTS → STT → cap enforcement → failure states when AI unavailable.
- **~30 min**

### [14] `NOTES.md` for bugs/debt/future  *(PM 14)*
- [ ] `FIREBASE_SERVICE_ACCOUNT` env dependency.
- [ ] reading/listening/conversation still on old `/api/claude` (not gateway).
- [ ] entitlement stub (no real free/paid tiers yet).
- [ ] no admin UI for cap editing (manual Firestore edit only).
- [ ] Stripe/billing not built (Phase 6+).
- [ ] client pricing preview uses hardcoded defaults — may drift if env overrides a tier.
- **~30 min**

---

## Time budget

| Block | Hours |
|---|---|
| Morning (Tasks 1-4) | ~3.5 |
| Afternoon (Tasks 5-12) | ~3.5 |
| Evening (Tasks 13-14) | ~1 |
| Buffer (test + debug) | ~1.5 |
| **Total** | **~9.5 hr** |

---

## Blockers (founder action, not code)

- [ ] `OPENROUTER_API_KEY` (SimplifAI-owned) set in Vercel.
- [ ] `FIREBASE_SERVICE_ACCOUNT` JSON set in Vercel.
- [ ] Vercel project access granted.
- [ ] `ADMINS` env var (comma-separated admin emails).
- [ ] Optional: `MODEL_NORMAL`, `MODEL_HIGH`, `MODEL_EXTRAHIGH` overrides.
- [ ] Optional: `GOOGLE_API_KEY`, `GOOGLE_TTS_API_KEY`, `OPENAI_API_KEY` for image/TTS/STT.

---

## Decisions locked

- Cap enforced on **all AI calls** (text + image + TTS + STT), not just OpenRouter.
- Hide **all** key inputs (OpenRouter + Google AI Studio + TTS + STT).
- **$7 default for everyone** (new + existing users; existing treated as 7 if field missing).
- **Simple admin flag**: read `usageCap` + `role` from user doc; admin emails in `ADMINS` env var.
- **One global quality tier** (user-selectable in Settings), no per-feature overrides.
- **Tier → model** mapping hardcoded with env-var override.
- **Fallback** on provider error: retry once with `normal` model.
- **Client-side guard** runs first (fast UX); **server-side `checkCap`** is the source of truth (tamper-proof).