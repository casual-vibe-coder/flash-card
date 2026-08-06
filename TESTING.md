# Testing Checklist — Immersion build (Phases 0–5 + onboarding/guidance + presets)

Work top to bottom. ☐ = to test. Pair this with `AUDIT.md` (what each phase is)
and `STACK.md` (the stack). Everything is additive on the existing app.

## 0. Prerequisites
- ☐ `npm run build` succeeds (only warning = the pre-existing >500 kB chunk).
- ☐ `npm run dev` + `vercel dev` (:3000) running so `/api/*` works.
- ☐ Signed in (Firebase Google auth).
- ☐ OpenRouter key set in Settings → API Keys (or `OPENROUTER_API_KEY` env) — needed for any generation.
- ☐ (Optional) Google TTS key in Settings — needed for Dictation/Listening audio scrub + live speed (else browser-voice fallback).
- ☐ (Optional) `FIREBASE_SERVICE_ACCOUNT` env on Vercel — needed to actually SEE gateway cache + usage_events in Firestore.

## 1. Onboarding (new user)
- ☐ Brand-new account → onboarding launches automatically.
- ☐ Intro is short (2 slides) → "Set up my profile".
- ☐ Personal-info form: name + occupation, age band, interests, goals, region, native language. All optional; can proceed.
- ☐ Placement quiz runs; answering well advances to harder tiers; answering tier 1 poorly **stops early** and places Beginner.
- ☐ Result screen shows a level (Beginner/Elementary/Intermediate/Advanced) with CEFR + Book number.
- ☐ Personalization step: pick General (free) or Personalized (paid).
- ☐ "Add a starter deck for my level" checkbox present (default ON).
- ☐ Finish → if checkbox was on, a starter deck appears in your decks. Profile persists (reload → no onboarding).

## 2. Replay onboarding (3 entry points)
- ☐ Home header **?** → Help & Tips → "Replay onboarding" relaunches it, pre-filled with your data.
- ☐ Settings → "Replay Onboarding Guide" works.
- ☐ Settings → Profile & Personalization → "Replay onboarding" works.
- ☐ Existing pre-build users (had onboardingDone, no profile) default to Beginner/General; editable in Settings → Profile.

## 3. Help & in-app tips
- ☐ Home header **?** opens Help & Tips with the full feature guide.
- ☐ First visit to Home / Dictation / Capsules each shows a one-time blue tip banner.
- ☐ Dismissing a tip (✕) keeps it gone after reload.
- ☐ Help & Tips → "Reset tips" → tips reappear on those screens again.

## 4. Preset library
- ☐ Home → "Browse preset decks" opens the library.
- ☐ "My level" filter shows level-matched decks; "All levels" shows all (currently 3 Book-1 decks).
- ☐ A user above Book 1 sees "No preset decks for this level yet" under My level (expected — seed is Book-1 only).
- ☐ "Download" copies a preset into your decks (toast confirms); the deck is editable + studyable + carries its unit link.
- ☐ Downloaded deck syncs (reload → still there).
- ☐ (If you seed Firestore `preset_decks`) those merge in alongside bundled ones.

## 5. Curriculum + deck linking (Phase 2)
- ☐ Create Deck → optional "Curriculum unit" dropdown (64 units, grouped by book).
- ☐ Existing deck → ⋮ menu → "Link to Curriculum Unit"; chip appears under the deck title; persists on reload.
- ☐ No existing decks/cards were duplicated or altered by the curriculum feature.

## 6. Generation gateway (Phase 3)  [needs OpenRouter key; cache needs FIREBASE_SERVICE_ACCOUNT]
- ☐ Language Island → Generate produces Q&A (flows through `/api/generate`).
- ☐ Network tab: no API key visible in the client bundle / requests (key is server-side).
- ☐ With service account set: a `generations` doc + a `usage_events` doc appear in Firestore.
- ☐ Generate the SAME unit/level fresh again (new account or clear `li-seq:*` in localStorage) → response is cached (no new usage_events).
- ☐ "Generate more" yields fresh batches (not duplicates) and accumulates.

## 7. Dictation module (Phase 4)
- ☐ Home → Dictation → pick count → Start (generates sentences at your level).
- ☐ Audio: Play/Pause **keeps position** (doesn't restart).
- ☐ Speed buttons (0.6–1.2×) change speed **live without restarting**.
- ☐ Scrub bar seeks within the clip.
- ☐ Type an answer → Submit → reveal shows: correct answer (missing words underlined), "You wrote" (extra words struck through), and a % score.
- ☐ Diacritic-insensitive: a word right but missing tashkīl still counts.
- ☐ Next/Finish works; finishing shows the session rating (✍️).
- ☐ No TTS key → falls back to browser voice with a note (no scrub/live-speed) but still usable.

## 8. Listening live speed (Phase 4)
- ☐ Listening → start audio → drag the speed slider WHILE playing → speed changes live, no restart.
- ☐ Speed preset chips also change speed live without restarting.

## 9. Capsules + personalization (Phase 5)
- ☐ Home → "Immersion Capsules" opens the hub; Language Island is "live", others show "SOON".
- ☐ Hub header reflects General vs Personalized mode.
- ☐ Settings → Profile → turn Personalized ON (fill context) → Island/Dictation generations reflect your context/vocabulary.
- ☐ Turn Personalized OFF → content is general/shared again.
- ☐ Back from Language Island returns to the Capsules hub.

## 10. Cost / usage accounting
- ☐ After generating in Island and Dictation, Settings → AI Credit Usage shows "Language Island" and "Dictation" rows with calls/tokens/$.
- ☐ Each has a per-feature model dropdown (Settings → Per-Feature Override) and respects it.
- ☐ Daily cost projector includes "Language Island batches" and "Dictation sets".
- ☐ Cache hits add NO cost (generate the same thing twice → second adds nothing).

## 11. Regression (existing features still work)
- ☐ Flashcards: create/edit/delete, AI card generation, study (swipe known/weak), SRS due counts.
- ☐ Master Review, Reading, Listening, Conversation, Progress/Analytics all still work.
- ☐ Global search, dark mode, import/export deck.
- ☐ Sign out / sign in; data loads from Firestore.
- ☐ **Reload always lands on Home** (2026-08-06 change) — start a Study session, a Listening/Reading passage, or Master Review, then hard-refresh the browser: you should land on Home, NOT get auto-navigated back into that screen. (Per-screen preference memory — e.g. Listening remembering your last deck selection when you manually open it again — should still work; only the auto-jump-back-in behavior is gone.)

## 12. Edge cases
- ☐ Not signed in → login screen (no crashes).
- ☐ No OpenRouter key → generation shows a clear error, app doesn't break.
- ☐ Offline → bundled presets still show; island falls back to localStorage store.

## 13. Vocab Import
- ☐ Home → "Import vocabulary" opens the screen; upload a photo of a vocab-list page.
- ☐ Nouns extracted with ONLY singular + plural forms (no harf/synonym/antonym present in preview).
- ☐ Verbs extracted with past/present/future/imperative/masdar/activePart/passivePart + harf (where applicable).
- ☐ `arabicBase` for verbs is 3rd-person masc. singular PAST, even when the source photo only shows present/imperative.
- ☐ `arabicBase` for nouns is singular indefinite, even when the source photo shows a plural or construct form.
- ☐ A word appearing both in a vocab list AND in an example sentence on the same page collapses to ONE card, not two.
- ☐ Common particles/prepositions incidental to example sentences are NOT extracted as their own cards.
- ☐ Multi-page PDF / multiple screenshots in one batch all get processed; progress text updates per batch.
- ☐ Preview stage: remove-before-save works; deck name editable when creating a new deck.
- ☐ Save creates a normal (non-grammar) deck — cards study/flip/SRS exactly like manually-added cards.
- ☐ Settings → Model per feature → "Vocab import" dropdown appears and actually changes which model is used (check Usage tab).
- ☐ Cancel mid-import returns to input stage without saving partial results.
- ☐ Open an existing (non-grammar) deck → small upload-icon button next to "Add Cards" opens Vocab Import targeting that deck; saved cards append to it (not a new deck). Button is absent on grammar decks (they already have their own import route via "Add Cards").
- ☐ **Large-PDF resilience** (added after a real failure on a big vocab PDF): upload a big/dense multi-page PDF.
  - ☐ Preview stage shows a "Found N words from M pages" coverage line, not just a raw card count.
  - ☐ If any batch fails, the warning names the actual page range/source (e.g. `"book.pdf" p.12–14 failed: ...`), not an anonymous "Batch 3/9".
  - ☐ If ONE page in the PDF fails to parse/render, the rest of the PDF still gets processed (doesn't abort the whole import).
  - ☐ If the PDF has >60 pages, a warning states exactly which page range was skipped.
  - ☐ Even if EVERY batch fails, you land on the preview stage (0 cards) with the full list of per-page/batch errors — not a single generic toast that discards the detail.
  - ☐ Compare card count against a manual page-by-page skim on one deliberately-dense page to sanity-check nothing near a batch boundary got silently truncated.

---
### Known/expected at this stage (not bugs)
- Entitlement is a STUB (Phase 6) — "Personalized" isn't paywalled yet; nothing is actually gated.
- Only Language Island + Dictation use the gateway; Reading/Listening/Conversation still use `/api/claude`.
- Preset seed is Book-1 only (3 decks); central Firestore layer is inert until you seed `preset_decks`.
- Root duplicate API handlers (`/claude.js` etc.) still present — not deleted pending your OK.
