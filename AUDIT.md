# Audit Guide — Phases 0–5 (Arabic Immersion App)

Checkpoint before the commercial band (Phases 6–9). Everything below is **local,
uncommitted** working-tree changes built additively on the native stack
(Vite + React/JSX + Firebase/Firestore + OpenRouter/Vercel). See `STACK.md` for
the inventory. Client builds green (`npm run build`); server fns pass
`node --check`.

## How to run / verify locally
- `npm run build` — production build (should succeed; the only warning is the
  pre-existing >500 kB chunk size).
- `npm run dev` + the Vercel dev server (`vercel dev` on :3000) so `/api/*` works.
- Most features need sign-in (Firebase Google auth) and an OpenRouter key
  (Settings → API Keys, or `OPENROUTER_API_KEY` env on the function).

## Founder actions still pending (not code)
1. **`FIREBASE_SERVICE_ACCOUNT`** env on Vercel → activates the gateway's
   server-side cache + usage logging + token auth. Without it the gateway still
   generates (graceful), but "identical inputs hit cache" / usage_events won't
   show. (`api/_firebase.js`)
2. **Firestore rules** — allow the owner to read/write `users/{uid}/island/**`
   for cross-device capsule sync (else it silently falls back to localStorage).
3. **Product name** (Phase 0) and the §8 decisions (free allotment, Pro quota,
   pricing/markup, TTS/STT vendor) — needed for Phases 6–9.
4. **Root duplicate API handlers** (`/claude.js`,`/tts.js`,`/stt.js`,`/image.js`)
   — still present; their headers self-describe as "for routing". I have NOT
   deleted them pending your explicit OK. The live copies are in `api/`.

## What changed, per phase

### Phase 0 — Inventory + drop in Language Island
- `STACK.md` written. Module vendored at `language-island/` and mounted as the
  `island` screen.
- **Verify:** existing flashcard features still work; `STACK.md` matches reality.

### Phase 1 — Auth, onboarding, placement, profile
- Rewrote `Onboarding` into welcome → context form → placement → result →
  personalization toggle. `ProfilePanel` in Settings edits it all. Profile +
  placement persisted to the Firestore user doc.
- **Placement is intentionally NO-AI** (static `PLACEMENT_TIERS`, lightly
  adaptive via `scorePlacement`) so it stays free (rule R1).
- **Verify:** fresh user → wizard runs → lands on a level → reload skips
  onboarding. Settings → Profile reflects/edit/persists; "Retake placement".
- **Caveat:** pre-existing users (have `onboardingDone`, no `profile`) default to
  Beginner/General until they edit Settings or retake.

### Phase 2 — Curriculum data (no duplication)
- `UNITS` (64) derived from the vendored `BOOKS` (single source of truth), stable
  ids `"<book>-<unit>"`, level + `verified` flag. Helpers `unitById`,
  `cardsForCurriculum`, `knownVocab`. Decks gain an optional `unitId`/`level`;
  link via Create Deck or the deck ⋮ menu.
- **Verify:** create/link a deck to a unit → chip shows, persists. `knownVocab()`
  returns known/weak card words. No existing deck/card data duplicated.

### Phase 3 — The generation gateway (critical)
- `api/generate.js` = the one server-side path: auth → entitlement (STUB) →
  Firestore cache (`generations`, dedupe on input hash) → generate (reuses the
  module's prompt/parser) → cache + `usage_events`. 402 paywall path ready.
- `callGenerate()` client helper (sends Firebase ID token; meters only on
  cache-miss; throws `err.paywall`). Language Island routed through it. Island
  store is layered localStorage + Firestore.
- **Verify (with env #1 set):** generate in Language Island → a `generations`
  doc + `usage_events` doc appear; generate the same unit/level fresh again →
  `cached:true`, no new usage_events. Confirm no API key in the client bundle.
- **Caveat:** only Language Island + Dictation use the gateway so far; the older
  reading/listening/conversation features still use `/api/claude` (migrate later).
  Entitlement is a stub until Phase 6.

### Phase 4 — Practice modules (Writing/Dictation new)
- New `DictationScreen` + `DictationAudio` player: **live speed (`playbackRate`,
  no restart), scrubbing, pause keeps position**; reveal-after-write with a
  word-level diff (`diffTokens`, diacritic-insensitive) + score. Gateway kind
  `dictation`.
- **Listening** speed made live/non-restart (renders TTS at neutral speed, applies
  `playbackRate` via `setTtsPlaybackRate`).
- `dictation` usage tag registered in all 4 cost places (initUsage, USAGE_LABELS,
  MODEL_FEATURES, ACTIONS).
- **Verify:** Dictation → listen, scrub, change speed mid-play (no restart) →
  type → Submit → correction + score. Listening → drag speed while playing.

### Phase 5 — Capsules + personalization
- `CAPSULES` registry + `CapsulesScreen` hub (home card → hub). `buildPersona()`
  → gateway appends a learner-context clause when personalized; known-vocab
  biasing via `inputs.vocab`. General = shared/cacheable; personalized = per-user.
- **Verify:** Settings → turn Personalized on (+ fill context) → Island/Dictation
  generations reflect your context; turn off → general/shared. Capsules hub lists
  Island (live) + others (SOON).

## AI-credit accounting (uniform across added features)
Both AI-spending features added — `island`, `dictation` — are registered in all
four usage places and reuse existing keys (OpenRouter for text, Google TTS for
dictation audio). Costs show in Settings → AI Credit Usage and the daily
projector. Cache hits cost nothing.

## Suggested audit focus (highest-value)
1. **Gateway security/cache** (`api/generate.js`): hash determinism, personalized
   vs shared keying, graceful no-admin path, 402 path.
2. **Free vs paid boundary**: confirm general mode never sends vocab/persona and
   stays cache-shared; personalized is per-user. (Entitlement ENFORCEMENT is
   Phase 6 — today the stub allows all.)
3. **Data model**: profile/placement/units/deck-links shape in Firestore; no
   duplication; `knownVocab` correctness.
4. **No regressions** in the existing flashcard/study/reading/listening/
   conversation flows.
