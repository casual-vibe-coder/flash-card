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

### [5] Init `usageCap:7` on new user signup  *(PM 7)*
- [ ] In the user-doc creation path, write `usageCap: 7`, `role: "user"`.
- [ ] Existing users with missing `usageCap` → treated as `7` in code (no migration).
- **~15 min**

### [6] Write `checkCap(uid)` helper in `api/_firebase.js`  *(PM 7)*
- [ ] Read `users/{uid}` via Firebase Admin.
- [ ] Sum costs from `usage.byTag` (existing meter shape).
- [ ] Read `usageCap ?? 7` and `role`.
- [ ] If `role === "admin"` → always allow.
- [ ] Else if `spent >= usageCap` → return `{ allowed: false, spent, cap }`.
- [ ] Else return `{ allowed: true, spent, cap }`.
- **~30 min**

### [7] Wire `checkCap` + tier resolution into `api/claude.js` and `api/generate.js`  *(PM 4, 7, 13)*
- [ ] Remove `req.body?.apiKey` / `userKey` fallback → env-only.
- [ ] Resolve `tier → TIER_TO_MODEL[tier]`, fallback to `normal` if invalid.
- [ ] Call `checkCap(uid)` before the OpenRouter request.
- [ ] If blocked → return `402 { error: "cap_reached", spent, cap }`.
- [ ] On provider 5xx/rate-limit → retry once with `normal` model.
- [ ] Keep writing `usage_events` (already done in `generate.js:165`).
- **~1 hr**

### [8] Lock `api/tts.js`, `api/stt.js`, `api/image.js` to env-only  *(PM 4, 5)*
- [ ] Remove `req.body.apiKey` fallback in each → env-only.
- [ ] Optionally add `checkCap` here too (cap covers all AI per decision).
- **~20 min**

### [9] Admin allowlist  *(PM 7 admin flag)*
- [ ] Read `ADMINS` env var (comma-separated emails) in `api/_firebase.js`.
- [ ] If caller email in allowlist → treat as admin → `checkCap` allows.
- [ ] Per-user `usageCap` override = admin edits Firestore doc manually (no UI this phase).
- **~15 min**

### [10] Verify Google auth + clean empty new account  *(PM 8)*
- [ ] Fresh Google sign-in → user doc with `usageCap:7, role:"user"`, empty `decks`, no key fields.
- [ ] Confirm no API-key screens visible to a fresh user.
- [ ] Reload → session restored, no onboarding re-trigger.
- [ ] Sign out → `LoginScreen`.
- **~15 min**

### [11] Firestore rules  *(PM 10, 11)*
- [ ] Write `firestore.rules`:
  - `users/{uid}` → read/write only if `request.auth.uid == uid`.
  - `generations`, `usage_events` → **no client access** (server-only via Admin SDK).
- [ ] No Cloud Storage used (per `STACK.md`) → note in TESTING, nothing to write.
- **~30 min**

### [12] Cleanup: delete stale root duplicates
- [ ] Delete repo-root `claude.js`, `tts.js`, `stt.js`, `image.js` (live copies in `api/`).
- [ ] Per `AUDIT.md:25-27`.
- **~5 min**

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