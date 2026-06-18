# STACK.md — Existing App Inventory

> Produced for Phase 0 of `ROADMAP.md`. This documents **what is actually in the repo today**,
> so downstream phases conform to it. No feature code has been written yet.

## TL;DR

This is a **single-page Vite + React (JSX, not TypeScript)** Arabic flashcard app, using
**Firebase** (Google Auth + Firestore) for accounts/persistence and **OpenRouter** (server-side,
via Vercel functions) for all AI. It is **not** the Next.js/TypeScript/Supabase/Prisma/Stripe
stack the roadmap *recommends* — and the roadmap says to **conform to the existing stack**, so
that mismatch is the first decision to settle (see bottom).

---

## Framework & language
- **Build tool:** Vite 5 (`vite.config.js`). Scripts: `dev`, `build`, `preview`.
- **UI:** React 18 (`react`, `react-dom`), function components + hooks. **Plain JSX — no TypeScript.**
  (`@types/*` are present as devDeps but no `.ts/.tsx` files exist.)
- **Entry:** `main.jsx` → `ReactDOM.createRoot` → `App.jsx`.
- **Icons:** `lucide-react`.
- **Structure:** essentially **one monolithic file** — `App.jsx` (~5,700 lines) holds every screen,
  all helpers, the CSS, seed data, and the API layer. ~28 top-level components (see below).

## Styling
- **CSS-in-JS via a single template string** (`const CSS = \`...\``) injected as `<style>{CSS}</style>`.
- **CSS custom properties** for theming, with **light/dark** via `data-theme` on `<html>`.
  Dark mode persisted in `localStorage` (`arabic_fc_dark`), respects `prefers-color-scheme`.
- No Tailwind, no CSS modules. Components style with `className` (utility-ish classes like
  `.btn`, `.module-card`, `.screen`, `.stat-card`) plus inline `style={{}}`.

## Routing / navigation
- **No router library.** A single `screen` state string in `App` (`useState("home")`) selects from
  a `screens` object map; `{screens[screen]}` renders the active one. Navigation = `go("name")`.
- Screens: home, settings, createDeck, addCards, deck, editCard, study, complete, reading,
  listening, conversation, masterReading/Listening/Speaking, masterReview, progress, **island** (new).
- **Session restore:** active study/module sessions persisted to `localStorage`
  (`arabic_fc_active_session`, `arabic_fc_screen_*`, 30-day TTL).

## State management
- Local React state in the root `App` component, threaded via props. No Redux/Zustand/Context.
- Module-level mutable refs (`_defaultModel`, `_orKey`, `_modelByTag`, etc.) hold settings for the
  non-React API helpers; kept in sync by a `useEffect` watching `settings`.

## Auth
- **Firebase Auth**, **Google sign-in only** (`signInWithPopup` + `GoogleAuthProvider`).
- `firebase.js` exports `auth`, `googleProvider`, `db`. Firebase web config is **hardcoded**
  (normal/public for Firebase web apps; the real secret is the OpenRouter key, which is server-side).
- `onAuthStateChanged` gates the app: loading spinner → `LoginScreen` → app.

## Database / persistence
- **Cloud Firestore**, document-per-user at `users/{uid}`. One `setDoc(..., {merge:true})` writes the
  whole user blob (debounced 1.5s) containing: `decks`, `cardStates`, `settings`, `usage`, `studyLog`,
  `onboardingDone`.
- **No relational DB, no Prisma, no migrations.** Data is denormalized JSON in one doc.
- `localStorage` used for: dark mode, active-session restore.

### Data model (as it exists, in Firestore JSON)
- **Deck:** `{ id, title, createdAt }`. Seeded by `SEED_DECKS`.
- **Card** (`cardStates[deckId]` = array): `{ id, wordType:"noun"|"verb"|..., english, arabicBase,
  forms:{ singular, plural, synonym, past, present, masdar, harf, ... }, status:"new"|"weak"|"known",
  srsInterval, srsNextReview, ease, streak, ... }`.
- **Progress / SRS:** **already implemented** — a Leitner/SM-2-ish scheme on each card
  (`srsInterval` days, `srsNextReview` ms, `ease`, `streak`); `getDueCount()` computes due cards.
  Per-user "known vocabulary" is derivable today: cards with `status==="known"|"weak"`.
- **studyLog:** `{ entries:[{date, type, module, minutes, rating, ...}], targets:{dailyMinutes,
  weeklyMinutes} }`. Powers the Progress/Analytics screen.
- **usage:** `{ byTag:{ [tag]:{calls, inputTokens, outputTokens} }, trackingSince }`. Per-feature
  AI cost meter (see below).

## AI generation (current "gateway")
- **All LLM calls already go through a server-side proxy** — `callClaude()` in `App.jsx` POSTs to
  **`/api/claude`** (Vercel serverless), which calls **OpenRouter** with `OPENROUTER_API_KEY` from
  env. **The key is never in the client bundle.** Response normalized to Anthropic shape
  `{content:[{type:"text",text}]}`.
- Model is **per-feature selectable** (`settings.models[tag]` → `pickModelForTag`), default
  `openai/gpt-4o-mini`. So it's **multi-model via OpenRouter, not Anthropic-direct.**
- **Usage metering already exists**: every call is tagged (`flashcard`, `reading`, `island`, …),
  costed against a `MODEL_PRICES` table, and shown in Settings → "AI Credit Usage" with a daily
  projection calculator. This is most of Phase 3's metering, already built.
- Other serverless functions in `api/`: **`tts.js`** (Google Cloud TTS), **`stt.js`** (OpenAI
  Whisper), **`image.js`** (Gemini "Nano Banana" image gen). All keyed server-side.
- ⚠️ **Finding:** the four handlers exist **both** at repo root (`claude.js`, `tts.js`, `stt.js`,
  `image.js`) **and** under `api/`. The `api/` copies are the live Vercel functions; the root copies
  look like **stale duplicates** and differ in size. Recommend deleting the root copies (confirm first).

## Audio
- **TTS:** `/api/tts` → Google Cloud TTS (Wavenet Arabic voice, e.g. `ar-XA-Wavenet-C`), plus a
  browser `SpeechSynthesis` fallback. Voice/speed in settings.
- **STT:** `/api/stt` → OpenAI Whisper, with a Web Speech API baseline; fuzzy (Levenshtein) matching
  for Arabic recognition. Used by the Conversation (speaking) module.

## Existing feature surface (relevant to roadmap overlap)
- **Decks & flashcards** with AI generation, edit, cleanup/dedupe tools, global search.
- **Study** (swipe known/weak, SRS, undo) + **Master Review** across decks.
- **Practice modules already built:** **Reading**, **Listening**, **Conversation (speaking)** —
  each driven by the user's active flashcard vocabulary. **Writing/Dictation does NOT exist yet.**
- **Onboarding** component exists (basic) — no placement assessment, no personal-context form,
  no personalization toggle yet.
- **Progress & Analytics** screen, **Settings** (model per feature, keys, SRS, targets, usage).
- **Language Island** capsule — vendored at `language-island/`, mounted as the `island` screen,
  generation already routed through `/api/claude` + the usage meter (done in prior work).

## Deploy
- **Vercel** (frontend + `api/*` serverless functions). `DEPLOY.md` present. `vercel.json` config.
- Dev: Vite proxies `/api` → `http://localhost:3000` (Vercel dev). Secrets via Vercel env vars.
- **Git:** GitHub `casual-vibe-coder/flash-card`, branch `main`.

---

## How the roadmap maps onto this stack (key deltas)
| Roadmap recommends | This repo actually has | Implication |
|---|---|---|
| Next.js + TypeScript | Vite + React **JSX** | Conform → keep Vite/JSX, or migrate (big rebuild) |
| Supabase Postgres + Prisma | Firebase **Firestore** (JSON blob) | Data model becomes Firestore collections, not SQL tables |
| Anthropic API server-side | **OpenRouter** server-side (`/api/claude`) | Key already server-side ✅; multi-model already ✅ |
| Build `/api/generate` gateway (Phase 3) | `/api/claude` proxy + usage meter exist | Phase 3 = **extend** existing proxy (cache + entitlement), not build from scratch |
| Build reading/writing/speaking/listening (Phase 4) | reading/listening/speaking **already built** | Phase 4 ≈ **add Writing/Dictation only** + preset-content sourcing |
| Stripe billing (Phase 7) | none | Genuinely new |
| Onboarding + placement (Phase 1) | basic Onboarding only | Add placement assessment + profile/personalization |

## The one decision that gates everything
The roadmap **recommends** Next.js/Supabase/Prisma but **instructs** (in §0, §3, §7) to **conform to
the existing stack**. Those point in opposite directions. Per the rules as written, the additive path
is: **stay on Vite + React + Firebase/Firestore + OpenRouter/Vercel** and map the roadmap's
Postgres/Prisma/Supabase *concepts* onto Firestore collections. Migrating to the recommended stack
would be a near-total rebuild of a working app. **This needs the founder's explicit call before
Phase 1.**
