# Arabic Immersion App — Deep Analysis, UI/UX Roadmap & Feature Roadmap

**Date:** 2026-07-07 · **For:** dev team · **Scope:** the app at this repo (Vite + React JSX + Firebase/Firestore + OpenRouter/Vercel)

> **Non-negotiable constraint (founder decision, see `STACK.md`):** everything below is **additive on the existing stack**. No migration to Next.js/TypeScript/Supabase/Prisma. Firestore stays the store; OpenRouter stays the LLM layer; Vercel functions stay the backend.
>
> **Content constraint (founder requirement):** any AI-generated imagery (mnemonic images via `/api/image`) must **never depict eyes** — enforce in a single shared image-prompt style wrapper so no call site can forget it.

---

## 0. Executive summary

This is a genuinely strong foundation: a curriculum-anchored (Al-ʿArabiyyah Bayna Yadayk, 64 units), immersion-first (MSA-only, full-tashkeel-enforced, zero transliteration) learning app with 6 practice modalities, per-form weakness tracking, a no-AI placement test, cost-metered AI generation, and a caching gateway. Phases 0–5 of the original roadmap are built; the commercial band (6–9) is stubbed.

The gap between this and a great product is **not more features**. It is, in order:

1. **Trust** — a confirmed data-loss bug wiped a real user's deck index on 2026-07-06 (recovered manually from Firestore). No security rules. No backups. An unauthenticated open LLM proxy.
2. **A daily loop** — the app has an SRS but no "do today's session" concept. SRS settings UI exists but is wired to nothing. The learner must self-assemble every session.
3. **A visible journey** — the user's actual mental model is "I am at Book 2, Part 1, Unit 6" (verbatim from the founder). Nothing in the UI reflects position on the 64-unit path.
4. **Consumer-grade surface** — required-API-key onboarding, blank-screen dead ends, `alert()`s, invisible "new card" counts, dead settings, no PWA.

The roadmap below fixes trust first (P0), then builds the daily loop and the journey (the two retention engines), then layers features and the commercial band.

---

## 1. Current state — inventory (what's already built)

**Screens (28):** home, deck CRUD (create/add-cards/deck/edit-card), study, complete, master review hub, reading, listening, conversation (+ 3 "master" variants), dictation, capsules hub, Language Island, preset library, progress (2 tabs), settings, guide, onboarding wizard, global search, login. Screen routing = a string state + `screens` map (`App.jsx:6684`), no router.

**Learning engine:** SM-2-lite (`calculateSRS`, `App.jsx:101–133`): binary grade (known/weak), ease 1.3+ (no ceiling), ladder 1d → 3d → interval×ease; weak ⇒ interval 0. Due = reviewed cards past `srsNextReview` only. Per-form weakness (`weakForms`). Undo, keyboard shortcuts, session persistence/restore (30-day TTL).

**Card model:** `{wordType: noun|verb|adjective|other, english, arabicBase, forms{…type-specific}, harf, status, weakForms[], srsInterval/Ease/Streak/Reviews/NextReview/LastReview, unitId?, level?}`. Verbs carry conjugations (past/present/imperative/masdar/participles); nouns carry plurals/synonyms/antonyms.

**Curriculum spine:** `BOOKS` → 64 `UNITS` (stable ids `"<book>-<unit>"`), `UNIT_VOCAB` (~70 voweled words/unit) grounds generation; decks optionally link to units. Placement test (static, free) maps to book1–4.

**AI layer:** all keys server-side. Two paths: the **gateway** `/api/generate` (auth → entitlement stub → Firestore cache → generate → usage log; only Island + Dictation use it) and the **legacy proxy** `/api/claude` (no auth, no cache; used by reading/listening/conversation/cards/lookups). TTS (Google Wavenet + browser fallback, localStorage LRU cache), STT (Deepgram/Whisper/browser), images (Gemini).

**Persistence:** one Firestore doc `users/{uid}` holding everything (decks, cardStates, settings incl. user API keys, usage, studyLog, profile), debounced 1.5s whole-blob `setDoc({merge:true})`. Island state in `users/{uid}/island` + localStorage mirror.

**Docs:** `STACK.md` (inventory), `AUDIT.md` (phases 0–5), `TESTING.md` (manual QA), `DEPLOY.md` (stale in places). No automated tests. Single ~1.0 MB JS chunk.

**Strengths worth protecting:** tashkeel enforcement with retry (`callClaudeWithTashkeel`), cost-consciousness everywhere (cache-first, opt-in images, per-feature model overrides, usage meter), curriculum grounding, per-form weakness, the layered offline-tolerant Island store, dark mode + reduced-motion support.

---

## 2. P0 — Trust & integrity (do before anything else)

These are ranked by (risk × already-happened). Item 1 **caused a real incident on 2026-07-06**: a transient condition reset a live user's deck list to seed defaults; 1,872 cards survived only in `cardStates` and were restored by hand from Firestore. Treat this section as a release blocker.

| # | Fix | Where | Detail |
|---|-----|-------|--------|
| P0-1 | **Kill the load-error → seed-overwrite path** | `App.jsx:6366–6417` | On `getDoc` failure the catch sets `dataLoaded=true` with state still = seed defaults; the 1.5s auto-save then **overwrites the cloud doc with seeds** (`{merge:true}` replaces arrays wholesale). Fix: introduce `loadFailed` state; never enable auto-save unless a load **succeeded**; on failure show a "couldn't load your data — retry" screen instead of silently proceeding. Also handle the legit-empty case (`if(d.decks?.length)` guard skips empty arrays, staging the same overwrite). |
| P0-2 | **Never clobber non-empty cloud data with defaults** | same effect | Belt-and-braces: before any save where local `decks` equals seed defaults, read the cloud doc; if it has more decks, abort the save and reload instead. Cheap insurance against every future variant of P0-1. |
| P0-3 | **Firestore security rules** (none exist) | Firebase console / `firestore.rules` | `users/{uid}/**` owner-only read/write; `preset_decks` read-only for authed users, write false (admin only); `generations`, `usage_events` no client access. Without rules, any authed user can read/write **other users' decks and stored API keys**. |
| P0-4 | **Stop persisting user API keys in Firestore** | `settings.orKey/gKey/…` in the user doc | Keys currently sync in plaintext to the cloud doc. Keep keys in localStorage only (they're per-device anyway), or encrypt. Combined with P0-3 this closes the worst credential exposure. |
| P0-5 | **Auth + rate-limit `/api/claude`** | `api/claude.js` | It is an open, unauthenticated OpenRouter proxy — anyone with the URL can burn the server key. Require a Firebase ID token (reuse `api/_firebase.js`), add a simple per-uid daily call ceiling in Firestore, return 429. Same for `tts/stt/image`. |
| P0-6 | **Automatic backups + user export** | new | (a) Nightly scheduled export of `users/*` (Vercel cron hitting an admin function → Cloud Storage or even a `backups/{uid}/{date}` doc, trimmed to N=7). (b) One-tap **"Export all my data (JSON)"** in Settings. (c) Snapshot the user doc to `backups/` before any destructive bulk op (deck delete, cleanup tools, merges). The July 6 incident is the proof of need. |
| P0-7 | **Fallback route + error boundary** | `App.jsx:6684–6742` | If a `screens` map guard is falsy (`deck` with no `activeDeck`, etc.) the app renders **blank with no way out**. Add: unknown/falsy screen → render home + toast; wrap the tree in an ErrorBoundary with a "back to home" recovery. |
| P0-8 | **Confirm/undo on card delete** | `DeckScreen ~App.jsx:2705` | Card delete is instant, unconfirmed, un-undoable (deck delete *does* confirm — inconsistent). Use a 5s undo toast rather than a modal. |
| P0-9 | **Multi-tab / multi-device clobber guard** | save effect | Last-writer-wins whole-blob saves mean two tabs silently destroy each other. Minimum: include `updatedAt` in the doc; before saving, if cloud `updatedAt` > the one you loaded, re-read and merge (or prompt). Long-term fix is P2 sub-collections. |

**Also in this band (small):** delete the stale root duplicate handlers (`/claude.js`, `/tts.js`, `/stt.js`, `/image.js`) after founder OK — the root `claude.js` differs from `api/claude.js` (accepts body apiKey) and is a booby trap; update `DEPLOY.md` (still says "DALL-E", wrong paths).

---

## 3. UI/UX roadmap

Ordered phases; each shippable independently. Line refs are to current `App.jsx`.

### UX-1 · Clarity quick wins (≈1–2 weeks, high leverage)

1. **Deck cards must show the full picture** (`HomeScreen:1605–1625`). Today: weak/known pills only — **new cards are invisible** (bit a real user this week; they thought data was missing). Add a `new` pill and a `due` pill; bar shows known% as now. One-line change per pill.
2. **Curriculum ordering & identity on Home.** Decks sort newest-first only. Add a "curriculum order" sort (unit-linked decks by `globalNo`, others after) and show the unit chip on the deck card (data already exists via `unitId`).
3. **Fix the Home information architecture** (`HomeScreen:1463`). "Progress & Analytics" is listed under *Practice Modules* (it isn't one). Order should be: **Today's session CTA (see UX-2) → decks → practice modules → progress**.
4. **Empty/blocked states.** Reading/Listening/Conversation/Dictation are tappable with 0 cards and dead-end at a disabled Generate. Gate each tile: if no vocab, show "Add cards first →" state instead.
5. **Onboarding → first-action gap.** New users finish onboarding to a dashboard with no next step, and Settings says OpenRouter key is "Required" even though the server key makes it optional (`SettingsScreen:2090`). Fix the copy (BYO-key = optional cost-saver), and end onboarding on a **"Start your first session"** button that opens the starter deck in study mode.
6. **Consistency sweep.** Replace the `alert()` in EditCardScreen (~2801) with toasts; master modules should return to the Master Review hub, not home (`6700–6702`); GlobalSearch shows "30 of N" when truncating (`3905`); Conversation's score-phase back button must not silently submit (`4448`).
7. **Accessibility floor.** Remove `maximum-scale=1.0` from `index.html` (blocks pinch-zoom); make clickable `<div>`s (`.chk`, `.rating-star`, flip card) real buttons with focus styles; bump sub-11px labels; 44px minimum touch targets on the study grade row's neighbors.

### UX-2 · The daily loop (the single biggest product unlock)

The app has all the pieces of a habit product and doesn't assemble them. Build **one screen: "Today"**.

- **Today's queue** = due reviews (all decks) + `newCardsPerDay` new cards (respecting `dailyLimit`) — i.e., **actually wire `DEFAULT_SRS_SETTINGS`** (`5840–5880`), which today is a decorative panel consumed by nothing (`startStudy:6562` ignores it).
- Home's top element becomes a single CTA: **"Today: 23 reviews · 10 new · ~12 min"** → one tap starts it. Zero decisions. (Master Review's "Smart" mode is 80% of the logic already — `MasterReviewScreen:5186`.)
- **Merge the two study engines.** `StudyScreen` (2905) and MasterReview's inner loop are near-duplicate flip-card implementations that have already drifted. Extract one `<StudySession queue={cards} onDone={...}/>` used by deck study, Today, and master review. This halves future study-UX cost.
- Session polish: progress bar + "n of N", real swipe gestures (it's tap-only despite the "swipe" naming), optional auto-play TTS on flip, pre-fetch the next card's learning aid while the current one is on screen.
- End-of-session: keep CompleteScreen, add "streak +1" moment (see UX-3).

### UX-3 · Journey & motivation (make progress visible)

1. **Curriculum path screen** — the flagship. A vertical path of the 64 units (grouped Book → Part), each node showing mastery % (known words in that unit's vocab ∩ user cards), current position highlighted ("You are here: Book 2 · P1 · U6 — Professions"), locked/unlocked states. Tapping a node: unit deck(s), practice modules scoped to that unit, "start unit" if new. *This matches the founder's and users' actual mental model and turns the app from a toolbox into a course.* Data prerequisites all exist (`UNITS`, `UNIT_VOCAB`, deck `unitId`).
2. **Daily habit streak + heatmap.** `studyLog` already records per-day entries; there is **no consecutive-day streak or calendar view**. Add streak counter (Home + end-of-session celebration) and a 12-week heatmap on Progress.
3. **Fix the Progress screen's lies.** The "B2 vocab" bar counts **total cards / 4500**, not known words (`getVocabProgress:254–258`) — change to known-word count. The Vocab skill tile is permanently "—" because master vocab sessions never trigger `SessionRating` (`5275–5281`) — either rate them or derive the score from session accuracy.
4. **Due forecast** — small bar chart "reviews coming in the next 7 days" (pure function of `srsNextReview`s). Motivates daily consistency better than any badge.

### UX-4 · Design system & simplification

- Extract the CSS template string into tokens + component classes; document type scale (Arabic: Scheherazade sizes; UI: Lora/Outfit) and spacing.
- **Split Settings into "Settings" (account, voice, targets, dark mode) and "Advanced / Developer" (API keys, per-feature models, tunables).** The current single screen is developer-grade cognitive load for a language learner.
- Standardize confirm patterns (destructive = undo-toast), loading skeletons for AI generation (topics/passages), and one shared error-state component (Reading currently injects an **Arabic error string into the passage slot** where it reads as content — `3338`).
- Coach-marks: current tips are static banners; add a 3-step anchored tour on first Home visit (Today → decks → path). Keep `TIPS_KEY` plumbing.

### UX-5 · PWA & offline (mobile-first app, zero install story today)

- `manifest.json` + service worker (Vite PWA plugin fits the stack): installable, offline shell.
- Offline study: decks/cardStates already live in the client; queue SRS results in localStorage and flush to Firestore on reconnect (the Island store already models this layered pattern — reuse it).
- Cache TTS audio (already localStorage-LRU'd) and the last generated passages for offline review.
- This is also the prerequisite for **push reminders** (F-4).

---

## 4. Feature roadmap

### F-1 · Learning engine v2 (differentiation: *per-form* scheduling)

1. **4-grade recall** (Again / Hard / Good / Easy) replacing the binary swipe — keys 1–4, swipe still = Again/Good for speed. Fixes the flat ease signal.
2. **FSRS scheduler.** Port `ts-fsrs` (MIT, no framework deps — conforms to stack). Map existing fields (`srsInterval/Ease/Streak/Reviews` → FSRS stability/difficulty via its documented migration) behind a feature flag; A/B old vs new by cohort if desired. Fixes: unbounded ease inflation, no lapse handling, no fuzz.
3. **Leech handling.** Card failed N times → flag, offer "rebuild this card" (fresh AI example + image mnemonic) or suspend. Surfaces in Progress.
4. **Per-form scheduling (the differentiator).** `weakForms` already tracks which form failed. Promote forms to schedulable sub-items: "you know كِتَاب but its plural كُتُب is due." No mainstream SRS app does Arabic morphology-aware review.
5. **Typed recall mode.** Show English → type the Arabic; the diacritic-insensitive `diffTokens` scorer from Dictation already exists — reuse it. Recognition → production is the B1→B2 bridge.
6. **Cloze cards.** Generated example sentences (already produced by learning aids) become cloze deletions targeting the card's word. Cheap to build, high pedagogic value.

### F-2 · Curriculum journey completion

1. **Seed `preset_decks` for all 64 units** from `UNIT_VOCAB` (server script; content pipeline, not code). Today only 3 Book-1 presets exist — a user placed into Book 3 gets nothing.
2. **Unit gate tests.** "Finish Unit" = vocab mastery threshold + a short mixed check (2 reading Qs, 2 dictation sentences, 1 speaking prompt — all generators exist). Pass → next node unlocks on the path. This converts existing modules into a course structure.
3. **Placement → path position.** Placement already yields book1–4; drop the user onto the path node, not just a label.
4. **Align level systems.** Language Island offers B1–B2 only while the app spans A1–C1 (`language-island/data/levels.js`) — add A1–A2 level defs or hide Island below B1.

### F-3 · AI content & skills

1. **Migrate reading/listening/conversation/cards/lookup to the `/api/generate` gateway** (auth, caching, metering, entitlements). Retires the open proxy (P0-5) properly and makes "free = cached/shared, pro = personalized" enforceable. Add kinds: `readingPassage`, `topics`, `cards`, `conversationTurn`, `lookup`, `learningAid`.
2. **Centralize the image style wrapper** for mnemonic images with the **no-eyes rule** baked in (single function every image call goes through), plus a consistent art style for brand feel.
3. **Story mode** (graded reader): multi-chapter generated stories constrained to unit vocab, tap-to-gloss via existing `ClickableArabic`/`WordPopup`, new words auto-offered as cards. High retention feature, mostly assembled from existing parts.
4. **Pronunciation feedback:** record → Whisper transcript → `diffTokens` against target — per-word pronunciation score. STT pipeline already integrated.
5. **Weekly digest** (needs F-4 email or PWA push): "You learned 43 words; 12 are fragile; Unit 7 is 80% done."

### F-4 · Habit & accountability

1. Daily goal ring (minutes or reviews — `studyLog.targets` exists) + streak (UX-3).
2. **Reminders:** PWA push (after UX-5) and/or email via a Vercel cron ("your 23 reviews are waiting").
3. **Study plans:** "Finish Book 2 Part 1 by Sept 1" → computes daily quota from remaining units/cards; plan health on Home.
4. Later: cohorts/leaderboards — defer until single-player retention is proven.

### F-5 · Commercial band (activates existing Phases 6–9 designs)

Order matters: value fences first, then payments.

1. **Entitlement enforcement** in `checkEntitlement()` (`api/generate.js`) — free tier: general/cached generation + N fresh generations/day; Pro: personalization, higher quotas, auto-images. (Design intent already in AUDIT.md.)
2. **Paywall UX:** a 402 today dead-ends with inline error text; build a plan screen + upgrade sheet triggered by `err.paywall`, plus "you're on Free — X of Y today" meter in Settings.
3. **Payments:** Stripe Checkout + a Vercel webhook function writing `entitlements/{uid}` — additive, no stack change.
4. Founder decisions needed first: product name, free allotment, Pro price (see AUDIT.md "founder actions").

### F-6 · Engineering hygiene (parallel track, ~15% of each sprint)

1. **Progressive de-monolith:** extract screens from `App.jsx` (6,742 lines) into `src/screens/*` one at a time; `React.lazy` + `Suspense` per screen → code-splits the 1.0 MB chunk without a rewrite. Start with the screens you touch anyway (Study engine merge, Settings split).
2. **State:** lift `decks/cardStates/settings/profile` into React Context with a reducer (no new deps) to stop whole-tree re-renders on every swipe.
3. **Tests where correctness is money:** vitest unit tests for `calculateSRS`/FSRS port, `diffTokens`, `tashkeelRatio`, gateway hash determinism, and a save-guard test asserting **seed data can never overwrite non-empty cloud data** (P0-1/2 regression lock).
4. Firestore evolution (additive): move `cardStates` to `users/{uid}/decks/{deckId}` sub-docs when P0-9's stopgap shows strain; migration = one-time client-side copy behind a version flag.
5. Observability: log client errors to a `client_errors` collection (sampled); surface gateway `usage_events` in an admin view.

---

## 5. Suggested delivery plan

| Sprint | Theme | Contents |
|---|---|---|
| 1 (wk 1–2) | **Trust** | P0-1…P0-9, root-handler cleanup, DEPLOY.md fix. *Release blocker band.* |
| 2 (wk 3–4) | **Clarity** | UX-1 all items; F-6.1 starts (extract Settings + split Advanced). |
| 3 (wk 5–7) | **Daily loop** | UX-2 (Today queue, merged study engine, wired SRS settings); F-1.1 (4-grade). |
| 4 (wk 8–10) | **Journey** | UX-3 (path screen, streaks, heatmap, fixed metrics); F-2.1 (64-unit presets); F-2.3. |
| 5 (wk 11–13) | **Engine v2** | F-1.2–1.4 (FSRS, leech, per-form) behind a flag; F-6.3 tests. |
| 6 (wk 14–16) | **Reach** | UX-5 (PWA/offline), F-4.1–4.2 (streak ring, reminders). |
| 7 (wk 17–19) | **Skills** | F-3.1 (gateway migration), F-3.3 (story mode), F-1.5–1.6. |
| 8 (wk 20+) | **Monetize** | F-5 end-to-end once founder pricing decisions land. |

Effort assumptions: 1–2 devs; each sprint independently shippable; engineering hygiene (F-6) rides along at ~15% capacity from Sprint 2.

## 6. Success metrics

- **Trust:** zero data-loss incidents; backup restore drill passes; rules audit clean.
- **Habit:** D7 retention; % of active days using "Today" one-tap; median streak length; due-backlog ≤ 1.5× daily throughput.
- **Learning:** weekly known-word growth (deduped headwords — currently 1,011 known / 1,396 for the founder account); lapse rate trend after FSRS.
- **Journey:** % of users with a path position; unit completions/week.
- **Cost:** AI cost per WAU (cache hit-rate from `generations`), kept visible in the existing usage meter.

## Appendix A — Incident report (2026-07-06), abridged

A user's `decks` array was reset to seed defaults while `cardStates` (1,872 cards) survived. Root cause matches P0-1: a failed/empty load left seed state marked `dataLoaded`, and the debounced auto-save overwrote the cloud doc. Recovery required manual Firestore surgery (re-deriving 32 deck identities from card vocabulary against `UNIT_VOCAB`). P0-6 (backups) would have made this a non-event; P0-1/2 make it impossible. Backups from the recovery live at `~/Documents/flash-card-backups/` (moved out of the repo; `BACKUP-*.json` is now gitignored).

## Appendix B — Key code landmarks

| Concern | Location |
|---|---|
| SRS algorithm | `App.jsx:101–161` |
| Study engines (duplicate) | `App.jsx:2905` (StudyScreen), `5186` (MasterReview) |
| Unwired SRS settings | `App.jsx:5840–5880` |
| Deck list pills (add new/due) | `App.jsx:1605–1625` |
| Screens map / fallback gap | `App.jsx:6684–6742` |
| Load/save cycle + P0-1 bug | `App.jsx:6366–6417` |
| Generation gateway | `api/generate.js` |
| Open proxy (P0-5) | `api/claude.js` |
| Curriculum data | `language-island/data/units.js`, `unit-vocab.js`, `App.jsx:4071–4114` |
| Placement | `App.jsx:4204–4242` |
| Vocab-progress metric bug | `App.jsx:254–258` |
| Dead vocab skill rating | `App.jsx:5275–5281` |
