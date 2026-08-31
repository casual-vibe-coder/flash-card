import { useState, useRef, useEffect, useCallback } from "react";
import { auth, googleProvider, db } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc, collection, getDocs } from "firebase/firestore";
import {
  Settings, ArrowLeft, ChevronRight, X, Volume2, RotateCcw, BookOpen,
  RefreshCw, Check, Sparkles, Plus, Edit3, Trash2, Layers, Save, Eye,
  EyeOff, Headphones, FileText, Play, Pause, SkipBack, Sliders, Globe,
  PlusCircle, Mic, Info, Image as ImageIcon, MoreVertical, Pencil,
  DollarSign, Zap, ChevronDown, ChevronUp, SquareCheck, Square,
  Moon, Sun, Download, Upload, Search, MessageCircle, HelpCircle,
  Send, Clock, Target, BarChart3, Hash, Star, PenLine, Brain, CheckCircle2
} from "lucide-react";
// Language Island — Arabic immersion capsule (vendored under ./language-island).
// mount() injects its own scoped (.li-root) styles; buildPrompt/parseQA let us
// route generation through this app's own /api/claude proxy + usage meter.
import { mount as mountIsland } from "./language-island/language-island.js";
import { BOOKS } from "./language-island/data/units.js"; // 64-unit curriculum source (Phase 2)
import { UNIT_VOCAB } from "./unit-vocab.js"; // per-unit core vocabulary (grounds generation)
// NB: prompt building + parsing now live server-side in the gateway
// (api/generate.js imports them from language-island/core/generator.js).

// ─────────────────────────────────────────────────────────────
// TASHKEEL VALIDATION
// ─────────────────────────────────────────────────────────────
// Arabic letter range (excluding diacritics, tatweel, and non-joining chars)
const ARABIC_LETTER = /[\u0621-\u063A\u0641-\u064A]/g;
// Tashkeel marks: fatha, damma, kasra, sukun, shadda, tanwin, superscript alef, etc.
const TASHKEEL_MARK = /[\u064B-\u0652\u0670]/;

/**
 * Returns the ratio (0-1) of Arabic letters that are followed by a tashkeel mark.
 * A well-vowelized text typically scores > 0.7.
 */
function tashkeelRatio(text) {
  if (!text) return 1;
  let total = 0, vowelized = 0;
  for (let i = 0; i < text.length; i++) {
    if (ARABIC_LETTER.test(text[i])) {
      ARABIC_LETTER.lastIndex = 0; // reset regex state
      total++;
      // Check if next char is a tashkeel mark
      if (i + 1 < text.length && TASHKEEL_MARK.test(text[i + 1])) vowelized++;
    }
  }
  return total === 0 ? 1 : vowelized / total;
}

/**
 * Check all Arabic string values in a parsed JSON object.
 * Returns true if every Arabic string has tashkeel ratio >= threshold.
 */
function hasSufficientTashkeel(obj, threshold = 0.5) {
  if (typeof obj === "string") return tashkeelRatio(obj) >= threshold;
  if (Array.isArray(obj)) return obj.every(v => hasSufficientTashkeel(v, threshold));
  if (obj && typeof obj === "object") {
    return Object.values(obj).every(v => hasSufficientTashkeel(v, threshold));
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// TOAST NOTIFICATION SYSTEM
// ─────────────────────────────────────────────────────────────
let _toastListeners = [];
let _toastId = 0;

function showToast(message, type = "info", duration = 3000) {
  const toast = { id: ++_toastId, message, type, duration };
  _toastListeners.forEach(fn => fn(toast));
}

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    const handler = (toast) => {
      setToasts(prev => [...prev, toast]);
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toast.id)), toast.duration);
    };
    _toastListeners.push(handler);
    return () => { _toastListeners = _toastListeners.filter(fn => fn !== handler); };
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SPACED REPETITION (SM-2 Lite)
// ─────────────────────────────────────────────────────────────
/**
 * Calculate next review date using simplified SM-2 algorithm.
 * quality: "known" (good recall) or "weak" (poor recall)
 * Returns updated SRS fields to merge into the card.
 */
function calculateSRS(card, quality) {
  const now = Date.now();
  const prev = {
    interval: card.srsInterval || 0,     // days
    ease: card.srsEase || 2.5,           // ease factor
    streak: card.srsStreak || 0,         // consecutive correct
    reviews: card.srsReviews || 0,
  };

  let interval, ease, streak;

  if (quality === "known") {
    streak = prev.streak + 1;
    ease = Math.max(1.3, prev.ease + 0.1);
    if (streak === 1) interval = 1;
    else if (streak === 2) interval = 3;
    else interval = Math.round(prev.interval * ease);
  } else {
    // weak — reset streak, reduce ease, review soon
    streak = 0;
    ease = Math.max(1.3, prev.ease - 0.2);
    interval = 0; // review again today/next session
  }

  return {
    srsInterval: interval,
    srsEase: ease,
    srsStreak: streak,
    srsReviews: prev.reviews + 1,
    srsNextReview: now + interval * 86400000, // ms
    srsLastReview: now,
  };
}

/**
 * Sort cards for study: due cards first (by due date), then new cards.
 */
function sortByDueDate(cards) {
  const now = Date.now();
  return [...cards].sort((a, b) => {
    const aDue = a.srsNextReview || 0;
    const bDue = b.srsNextReview || 0;
    const aIsDue = aDue <= now;
    const bIsDue = bDue <= now;
    // Due cards first
    if (aIsDue && !bIsDue) return -1;
    if (!aIsDue && bIsDue) return 1;
    // Among due cards, most overdue first
    if (aIsDue && bIsDue) return aDue - bDue;
    // Among not-due cards, soonest first
    return aDue - bDue;
  });
}

/**
 * Get count of cards due for review right now.
 * Only counts previously-reviewed cards whose interval has passed — not new/unreviewed cards.
 */
function getDueCount(cards) {
  const now = Date.now();
  return cards.filter(c => c.srsLastReview && c.srsNextReview && c.srsNextReview <= now).length;
}

/**
 * A card with an inflectional weak form pending (e.g. failed "plural" last
 * time) should be TESTED on that form next — not just offer it as an
 * optional reference. Returns the form key to show as the primary answer,
 * or null to fall back to the base word as usual. Filters defensively to
 * INFLECTIONAL_FORMS in case older data has synonym/antonym in weakForms
 * from before that was guarded against.
 */
function pendingTestForm(card) {
  const availForms = Object.entries(card.forms || {}).filter(([, v]) => v);
  const inflectionalWeak = (card.weakForms || []).filter(f => INFLECTIONAL_FORMS.has(f));
  return inflectionalWeak.find(f => availForms.some(([k]) => k === f)) || null;
}

// Master Review's localStorage session snapshot used to store full card
// objects (forms, weakForms, SRS numbers, ...) x2 (sessionCards AND
// savedSession.cards) — for a 150-card Rotation session that's a sizeable
// chunk of localStorage, and combined with the TTS cache it could blow the
// browser's quota and silently fail to save (writes are wrapped in try/catch
// with no surfaced error). Persist just {id,_deckId} pairs instead and
// rehydrate the real card data from cardStates (already in memory) on load —
// smaller payload, and resumed cards reflect current status/weakForms rather
// than a stale snapshot.
function deflateSessionCards(cards) {
  return (cards || []).map(c => ({ id: c.id, _deckId: c._deckId }));
}
function hydrateSessionCards(light, cardStates) {
  return (light || [])
    .map(({ id, _deckId }) => {
      const full = (cardStates[_deckId] || []).find(c => c.id === id);
      return full ? { ...full, _deckId } : null;
    })
    .filter(Boolean);
}

/**
 * Count total unique word instances across all cards.
 * - Does NOT count arabicBase separately (it's the same as singular/past)
 * - Counts each non-empty form value (singular, plural, synonym, etc.)
 * - Deduplicates harfs — common prepositions like فِي only count once globally
 */
function countWordInstances(cardStates) {
  let count = 0;
  const seenHarfs = new Set();
  for (const cards of Object.values(cardStates)) {
    for (const c of cards) {
      if (!c.forms) continue;
      for (const [key, v] of Object.entries(c.forms)) {
        if (!v || !v.trim()) continue;
        if (key === "harf") {
          // Deduplicate harfs — strip tashkeel for comparison
          const stripped = v.replace(/[\u064B-\u065F\u0670]/g, "").trim();
          if (seenHarfs.has(stripped)) continue;
          seenHarfs.add(stripped);
        }
        count++;
      }
    }
  }
  return count;
}

// ─────────────────────────────────────────────────────────────
// STUDY TRACKING & ANALYTICS UTILITIES
// ─────────────────────────────────────────────────────────────
const TODAY_KEY=()=>new Date().toISOString().slice(0,10); // "2026-04-11"

function initStudyLog(){return {entries:[],targets:{dailyMinutes:30,weeklyMinutes:150}};}

function addStudyEntry(log,entry){
  return {...log,entries:[...log.entries,{id:Date.now(),date:TODAY_KEY(),ts:Date.now(),...entry}]};
}

function getEntriesForDate(log,dateKey){return (log.entries||[]).filter(e=>e.date===dateKey);}

function getEntriesForWeek(log){
  const now=new Date();const weekAgo=new Date(now);weekAgo.setDate(now.getDate()-7);
  const cutoff=weekAgo.toISOString().slice(0,10);
  return (log.entries||[]).filter(e=>e.date>=cutoff);
}

function sumMinutes(entries){return entries.reduce((s,e)=>s+(e.minutes||0),0);}

function minutesByModule(entries){
  const m={vocab:0,reading:0,listening:0,speaking:0,manual:0};
  entries.forEach(e=>{m[e.module||"manual"]=(m[e.module||"manual"]||0)+(e.minutes||0);});
  return m;
}

function getLast7DaysData(log){
  const days=[];
  for(let i=6;i>=0;i--){
    const d=new Date();d.setDate(d.getDate()-i);
    const key=d.toISOString().slice(0,10);
    const dayEntries=getEntriesForDate(log,key);
    const app=sumMinutes(dayEntries.filter(e=>e.type==="app"));
    const manual=sumMinutes(dayEntries.filter(e=>e.type==="manual"));
    days.push({date:key,label:d.toLocaleDateString(undefined,{weekday:"short"}),app,manual,total:app+manual});
  }
  return days;
}

// B2 benchmark: ~4000-5000 known words
const B2_WORD_TARGET = 4500;

/** Get module skill scores from master-session ratings only */
function getModuleSkillScores(studyLog) {
  const scores = { vocab: [], reading: [], listening: [], speaking: [] };
  for (const e of (studyLog.entries || [])) {
    if (!e.rating || !e.master) continue; // Only count master sessions
    if (scores[e.module]) scores[e.module].push(e.rating);
  }
  const result = {};
  for (const [mod, ratings] of Object.entries(scores)) {
    if (!ratings.length) { result[mod] = null; continue; }
    // Weighted average — recent ratings count more
    const weighted = ratings.map((r, i) => ({ r, w: 1 + i * 0.3 }));
    const sum = weighted.reduce((s, x) => s + x.r * x.w, 0);
    const wSum = weighted.reduce((s, x) => s + x.w, 0);
    result[mod] = Math.round(sum / wSum * 10) / 10;
  }
  return result;
}

/** Get vocab breadth as percentage toward B2 — based on total cards in decks, not just mastered */
function getVocabProgress(cardStates) {
  const all = Object.values(cardStates).flat().filter(c => c.wordType !== "grammar"); // grammar rules aren't vocabulary words
  const total = all.length;
  const known = all.filter(c => c.status === "known").length;
  return { total, known, target: B2_WORD_TARGET, pct: Math.min(100, Math.round(total / B2_WORD_TARGET * 100)) };
}

/** Generate a performance interpretation from card data and study log */
function getPerformanceInsights(cardStates,studyLog){
  const allCards=Object.values(cardStates).flat();
  const total=allCards.length;if(!total) return [];
  const known=allCards.filter(c=>c.status==="known").length;
  const weak=allCards.filter(c=>c.status==="weak").length;
  const newC=allCards.filter(c=>c.status==="new"||!c.status).length;
  const knownPct=Math.round(known/total*100);
  const weakPct=Math.round(weak/total*100);
  const weekEntries=getEntriesForWeek(studyLog);
  const weekMin=sumMinutes(weekEntries);
  const byMod=minutesByModule(weekEntries);
  const insights=[];

  if(knownPct>=70) insights.push({icon:"🌟",text:"Strong vocabulary foundation — "+knownPct+"% of cards known.",type:"success"});
  else if(knownPct>=40) insights.push({icon:"📈",text:"Improving steadily — "+knownPct+"% known, keep going.",type:"info"});
  else insights.push({icon:"🌱",text:"Early stage — "+knownPct+"% known. Focus on daily review.",type:"info"});

  if(weakPct>20) insights.push({icon:"⚠️",text:"Weak card load is high ("+weakPct+"%). Prioritize weak card review.",type:"warning"});
  if(weak>0&&known>weak*3) insights.push({icon:"💪",text:"Good ratio — knowing "+known+" vs "+weak+" weak cards.",type:"success"});

  const maxMod=Object.entries(byMod).filter(([k])=>k!=="manual").sort((a,b)=>b[1]-a[1])[0];
  const minMod=Object.entries(byMod).filter(([k])=>k!=="manual"&&byMod[k]!==undefined).sort((a,b)=>a[1]-b[1])[0];
  if(maxMod&&minMod&&maxMod[1]>0&&minMod[1]===0) insights.push({icon:"📊",text:`${maxMod[0]} is your strongest module. Consider more ${minMod[0]} practice.`,type:"info"});

  const target=studyLog?.targets?.weeklyMinutes||150;
  if(weekMin>=target) insights.push({icon:"✅",text:`On track — ${weekMin} min this week (target: ${target} min).`,type:"success"});
  else if(weekMin>=target*0.5) insights.push({icon:"🔄",text:`${weekMin} of ${target} min target this week — ${Math.round(weekMin/target*100)}% done.`,type:"info"});
  else if(weekMin>0) insights.push({icon:"⏰",text:`Behind target — only ${weekMin} of ${target} min this week.`,type:"warning"});

  return insights.slice(0,4);
}

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const FORM_LABELS = {
  singular:"Singular", plural:"Plural 1", plural2:"Plural 2",
  synonym:"Synonym", synonymPlural:"Synonym Plural",
  antonym:"Antonym", antonymPlural:"Antonym Plural",
  harf:"Common Preposition",
  past:"Past", present:"Present", future:"Future", imperative:"Command",
  masdar:"Masdar", activePart:"Active Part.", passivePart:"Passive Part.",
  masculine:"Masculine", feminine:"Feminine",
};
const FORM_ARABIC = {
  singular:"مفرد", plural:"جمع ١", plural2:"جمع ٢",
  synonym:"مرادف", synonymPlural:"جمع المرادف",
  antonym:"ضد", antonymPlural:"جمع الضد",
  harf:"حرف الجر",
  past:"ماضي", present:"مضارع", future:"مستقبل", imperative:"أمر",
  masdar:"مصدر", activePart:"فاعل", passivePart:"مفعول",
  masculine:"مذكر", feminine:"مؤنث",
};
const FORMS_BY_TYPE = {
  noun:      ["singular","plural","plural2","synonym","synonymPlural","antonym","antonymPlural","harf"],
  verb:      ["past","present","future","imperative","masdar","activePart","passivePart","harf"],
  adjective: ["masculine","feminine","plural","antonym","antonymPlural","harf"],
  other:     ["singular","plural","plural2","synonym","antonym","harf"],
};
// Forms that are the SAME word, just a different inflection (singular↔plural,
// masc↔fem, verb conjugations). synonym/antonym are deliberately excluded —
// those are different words with their own separate cards, so getting one
// wrong shouldn't mark THIS card weak or get remembered as this card's gap.
const INFLECTIONAL_FORMS = new Set([
  "singular","plural","plural2","masculine","feminine",
  "past","present","future","imperative","masdar","activePart","passivePart",
]);
// A deck counts as "studied" for the rotation queue once this many cards
// from it have been rated in one sitting.
const DECK_TOUCH_THRESHOLD = 20;
// Per-deck rating goal for a given session's card list: normally the flat
// threshold above, but capped to however many of that deck's cards actually
// made it into this session — otherwise a deck smaller than the threshold
// (or one `limit` cut short) could never be rated enough times to count as
// studied, so it never stops looking stalest and never stops crowding out
// other decks on every future rotation.
function deckTouchGoals(cards){
  const counts={};
  for(const c of cards) counts[c._deckId]=(counts[c._deckId]||0)+1;
  const goals={};
  for(const deckId in counts) goals[deckId]=Math.min(DECK_TOUCH_THRESHOLD,counts[deckId]);
  return goals;
}
const OR_MODELS = [
  // OpenAI
  {id:"openai/gpt-4o-mini",        label:"GPT-4o Mini  · Fast · Cheap"},
  {id:"openai/gpt-4o",             label:"GPT-4o  · Best quality"},
  {id:"openai/gpt-4.1-mini",       label:"GPT-4.1 Mini  · Latest"},
  // Anthropic via OpenRouter
  {id:"anthropic/claude-3.5-sonnet",label:"Claude 3.5 Sonnet  · Balanced"},
  {id:"anthropic/claude-3-haiku",   label:"Claude 3 Haiku  · Very fast"},
  {id:"anthropic/claude-sonnet-4-5",label:"Claude Sonnet 4.5  · Latest"},
  // Google
  {id:"google/gemini-flash-1.5",    label:"Gemini Flash 1.5  · Fast"},
  {id:"google/gemini-pro-1.5",      label:"Gemini Pro 1.5  · Capable"},
  // Meta
  {id:"meta-llama/llama-3.3-70b-instruct",label:"Llama 3.3 70B  · Open source"},
];

// Image generation models — Google's Gemini Flash Image family ("Nano Banana")
const IMAGE_MODELS = [
  {id:"gemini-2.5-flash-image", label:"Nano Banana 1  · Gemini 2.5 · $0.039/img · fast, GA"},
  {id:"gemini-3.1-flash-image-preview", label:"Nano Banana 2  · Gemini 3.1 · $0.067/img · sharper, preview"},
];

// Per-model USD pricing per 1M tokens (input / output). Used by the usage
// meter to estimate text-generation cost. Sourced from openrouter.ai/models;
// approximate, treat as estimates. Fallback used when the user's chosen
// model isn't in the table (e.g. they typed in a custom override).
const MODEL_PRICES = {
  "openai/gpt-4o-mini":        { in:0.15, out:0.60 },
  "openai/gpt-4o":             { in:2.50, out:10.0 },
  "openai/gpt-4.1-mini":       { in:0.40, out:1.60 },
  "anthropic/claude-3.5-sonnet":{ in:3.0,  out:15.0 },
  "anthropic/claude-3-haiku":  { in:0.25, out:1.25 },
  "anthropic/claude-sonnet-4-5":{ in:3.0,  out:15.0 },
  "google/gemini-flash-1.5":   { in:0.075,out:0.30 },
  "google/gemini-pro-1.5":     { in:1.25, out:5.0 },
  "meta-llama/llama-3.3-70b-instruct":{ in:0.40, out:0.40 },
};
const PRICE_FALLBACK = { in:0.15, out:0.60 }; // gpt-4o-mini

// Voice provider per-unit pricing (verify periodically at the linked pages).
const TTS_PRICE_PER_CHAR = 16 / 1_000_000;     // Google Cloud TTS Wavenet: $16 / 1M chars
const STT_PRICE_PER_SECOND = 0.006 / 60;       // OpenAI Whisper: $0.006 / minute

// Flat per-image cost for each Gemini image model (USD), 1024x1024 resolution.
// Source: ai.google.dev/gemini-api/docs/pricing (verified Mar 2026).
// Nano Banana 2 has resolution-tiered pricing; values here are the 1K rate.
const IMAGE_PRICES = {
  "gemini-2.5-flash-image": 0.039,            // 1290 output tokens × $30/M
  "gemini-3.1-flash-image-preview": 0.067,    // 1K — climbs to $0.10 at 2K, $0.15 at 4K
};

// Per-feature model override list — each entry maps a usage tag to a Settings dropdown
const MODEL_FEATURES = [
  {tag:"flashcard", label:"Flashcard generation",   desc:"New cards with all forms"},
  {tag:"sentence",  label:"Sentence aids",          desc:"Study & master sentence-aid generation"},
  {tag:"reading",   label:"Reading passages",       desc:"Reading practice generation"},
  {tag:"listening", label:"Listening passages",     desc:"Listening practice generation"},
  {tag:"wordLookup",label:"Word lookups",           desc:"Click-to-look-up Arabic words"},
  {tag:"regen",     label:"Cleanup & regen",        desc:"Card cleanup audit + form regeneration"},
  {tag:"island",    label:"Language Island",        desc:"Immersion Q&A generation (64 units)"},
  {tag:"dictation", label:"Dictation",              desc:"Dictation sentence generation"},
  {tag:"grammar",   label:"Grammar import",         desc:"Extract grammar cards from notes/PDFs — pick a vision-capable model (e.g. gpt-4o-mini) if you import screenshots"},
  {tag:"vocab",     label:"Vocab import",           desc:"Extract noun/verb flashcards from screenshots/PDFs — pick a vision-capable model (e.g. gpt-4o-mini) if you import photos"},
  {tag:"other",     label:"Topics & conversation",  desc:"Topic generation, chat replies, misc"},
];

const USAGE_LABELS = {
  flashcard:"Flashcard Generation", sentence:"Sentence / Learning Aid",
  reading:"Reading Passage", listening:"Listening Content",
  wordLookup:"Word Lookup", regen:"Form Regeneration",
  island:"Language Island", dictation:"Dictation", grammar:"Grammar Import",
  vocab:"Vocab Import",
  imageNB1:"Image · Nano Banana 1", imageNB2:"Image · Nano Banana 2",
  ttsGoogle:"Voice · Google TTS", sttWhisper:"Voice · OpenAI Whisper",
};

// Tags that aren't billed per-token. Used by UsageMeter to switch to
// flat/per-unit cost calculation.
const NON_TEXT_TAGS = new Set(["imageNB1","imageNB2","ttsGoogle","sttWhisper"]);

// Map a usage tag to the underlying image model id (for cost lookup).
const TAG_TO_IMAGE_MODEL = {
  imageNB1: "gemini-2.5-flash-image",
  imageNB2: "gemini-3.1-flash-image-preview",
};

// ─────────────────────────────────────────────────────────────
// AL-ARABIYYA BAYNA YADAYK STYLE CONTEXT
// Distilled from a structured scan of the 4-volume curriculum.
// Threaded into every text-generation prompt so the AI mirrors the
// register, themes, character cast, and level progression of the book.
// ─────────────────────────────────────────────────────────────
const BAYNA_YADAYK_STYLE = `STYLE GUIDE — write as if the passage came out of "العربية بين يديك" (Al-Arabiyya Bayna Yadayk) or the readers of Abū al-Ḥasan ʿAlī al-Nadwī (قصص النبيين / القراءة الراشدة). The learner should not be able to tell your output apart from those books.

═══ NON-NEGOTIABLE RULES ═══

1. **Tashkeel on EVERY Arabic letter.** Full diacritics throughout (فَتْحَة، ضَمَّة، كَسْرَة، سُكُون، شَدَّة، تَنْوِين، مَدّ). No bare letters. الْكِتَابُ الْكَبِيرُ — never الكتاب الكبير. Embedded Qur'anic ayat carry their own tashkeel.

2. **Modern Standard Arabic only.** No colloquial. No code-switching. No Romanized words. No English bracketed glosses inside the Arabic.

3. **Sound like a real native, not a textbook drill.** No vocab-cramming. No artificial sentence-stuffing. If a required word doesn't fit naturally, restructure the scene — don't bend grammar to wedge it in.

4. **Cultural anchor.** Saudi / Gulf / wider Muslim daily life. Family, masjid, prayer times, marketplace, hospitality, Qur'an study, hifz, Hajj/Umrah, Mecca/Medina, school/university, hospital, neighbourhood, halaqa.

═══ THE FIVE REGISTERS (pick the one that matches the learner's level) ═══

**(A) Beginner register — Bayna Yadayk Book 1.**
Single-clause sentences, 3–6 words each. Subject + predicate or subject + verb + simple complement. Heavy use of هَذَا / هَذِهِ for introductions. Question-answer pairs: مَا اسْمُكَ؟ — اِسْمِي خَالِد. مِنْ أَيْنَ أَنْتَ؟ — أَنَا مِنْ مِصْر. Themes: name, nationality, family, profession, classroom, school, prayer, food, market. Pronouns drilled overtly. Names from the recurring cast.

**(B) Low-intermediate register — Bayna Yadayk Book 2.**
Sentences 6–12 words, with one connective per sentence (وَ، ثُمَّ، فَ، لَكِنْ). Mini-scenes: a student's daily schedule, a doctor visit, a family vacation, a market trip, a returning ḥāfiẓ. Dialogue is common, introduced with قَالَ X: "..." and replies with قَالَ Y: "...". Vocatives يَا فُلَان used naturally inside dialogue. Light cause-effect (لِأَنَّ، لِذَلِكَ). Past-tense narrative interleaved with present-tense habitual.

**(C) Intermediate register — Bayna Yadayk Book 3.**
Sentences 8–15 words, multi-clause. Topics shift to civic, religious, geographical, social. Cause-effect chains, contrast clauses (أَمَّا... فَـ). كَانَ + خَبَرها constructions. Embedded Qur'anic ayat at theme-relevant moments (use them sparingly and accurately). Vocabulary becomes more abstract: المُجْتَمَع، الحَضَارَة، التَّأْثِير، النِّظَام.

**(D) Advanced register — Bayna Yadayk Book 4.**
Sentences 10–22 words, compound and complex. Classical biographical or expository prose. Sub-headed narrative possible. Vocabulary expands into سِيرَة, history, science, agriculture, economy. الصِّفَة المُشَبَّهَة and advanced morphological forms appear naturally. Embedded ayat and hadith. Proper-noun-heavy when discussing Islamic history. Sentence rhythm can carry one main clause and two subordinates.

**(E) Al-Nadwī "وَكَانَ..." narrative register — قصص النبيين / القراءة الراشدة.**
A distinctive option for narrative passages at any level. Short sentences (5–10 words) chained by وَ at the start of each. "وَكَانَ آزَرُ يَبِيعُ الأَصْنَامَ. وَكَانَ يَسْجُدُ لَهَا. وَكَانَ النَّاسُ يَسْجُدُونَ مَعَهُ." The rhythm carries the meaning. Heavy parallelism. Embedded Qur'anic ayat at climaxes (وَقَالَ تَعَالَى: ... / ﴿...﴾). Dialogue gets one line per speech (قَالَ إِبْرَاهِيمُ: ...). Repetition is structural, not lazy — the same construction repeated three times produces a wisdom cadence. Reserved for story passages with moral resolution.

═══ RECURRING CHARACTER CAST ═══

Use these when a name is needed. Vary across passages — don't always pick the same one.

Men/boys: عَبْدُ اللَّهِ، عَمَّار، سَامِي، إِبْرَاهِيم، إِلْيَاس، خَالِد، أَحْمَد، عَلِيّ، أَمِين، عَلَاء، مُحَمَّد، صَالِح، حَمْزَة، عُمَر، نَاصِر، يَاسِر، حَسَّان، سَلْمَان، يُوسُف، أَيْمَن
Women/girls: إِيمَان، أَمَل، وَرْدَة، زَيْنَب، فَاطِمَة، عَبِير، خَدِيجَة، عَائِشَة، مَرْيَم، أَسْمَاء، رُقَيَّة، هَاجَر، سَعِيدَة، هُدَى
Family roles: الأَبُ، الأُمُّ، الجَدُّ، الجَدَّةُ، العَمُّ، الخَالُ، الأَخُ، الأُخْتُ، الزَّوْجُ، الزَّوْجَةُ، الوَلَدُ، البِنْتُ
Authority figures: المُدَرِّسُ، الأُسْتَاذُ، الشَّيْخُ، الإِمَامُ، الطَّبِيبُ، الإِدَارِيُّ
Settings the cast moves through: البَيْت، المَسْجِد، السُّوق، المَدْرَسَة، الجَامِعَة، المُسْتَشْفَى، المَطَار، المَطْعَم، الحَدِيقَة، الحَيّ، القَرْيَة، المَدِينَة.

═══ DIALOGUE CONVENTIONS ═══

• Speaker tag inline: "قَالَ خَالِد: ..." then a line break, then the speech.
• Listener vocative at the end of a question or warmth-phrase: "أَيْنَ تَذْهَبُ يَا عَلِيّ؟"
• Replies often begin with نَعَمْ، لَا، رُبَّمَا، بِالطَّبْعِ، أَيْ نَعَمْ، إِنْ شَاءَ اللهُ، الحَمْدُ لِلَّهِ.
• Pious phrases woven naturally (not stuffed): بِسْمِ اللهِ، الحَمْدُ لِلَّهِ، إِنْ شَاءَ اللهُ، بَارَكَ اللهُ فِيكَ، جَزَاكَ اللهُ خَيْرًا.

═══ CONNECTIVES & SENTENCE FLOW ═══

Use these like a native: وَ (and), فَ (so/then-immediately), ثُمَّ (then-after-a-pause), لَكِنَّ (but, with stress), وَلَكِنْ (but, neutral), لِأَنَّ (because), حَتَّى (until/even), كَيْ / لِكَيْ (in order to), بَيْنَمَا (while), عِنْدَمَا / لَمَّا (when), إِذَا (if-realis), لَوْ (if-irrealis), بَعْدَ أَنْ (after), قَبْلَ أَنْ (before).

For narrative chaining specifically, vary so the prose doesn't feel like a list. Mix: "ذَهَبَ ... ثُمَّ جَلَسَ ... فَقَالَ" with "كَانَ ... وَكَانَ ... وَلَمَّا" depending on register.

═══ THINGS THAT BREAK THE ILLUSION (avoid) ═══

✗ Sentences shaped like translated English ("هُوَ ذَهَبَ إلى المَدْرَسَة فِي الصَّبَاح وَهُوَ تَنَاوَلَ الطَّعَام بَعْدَ ذَلِك").
✗ Over-explicit pronouns where Arabic would drop them.
✗ Comma-spliced sentences without proper connectives.
✗ Inanimate plurals treated as masculine plural (must be feminine singular agreement).
✗ Mis-cased verbs after لا النافية (مرفوع) vs لا الناهية (مجزوم).
✗ Mixing tashkeel and bare letters within the same passage.
✗ Made-up phrases that no native would say. Test every line: would a real teacher in a real class actually say this?

═══ ON THE LEARNER'S VOCABULARY ═══

The passage should foreground the required vocabulary the learner needs to drill. But it should also feel like real prose — so weaving in other natural Arabic words (including words slightly beyond the learner's current set) is encouraged when it makes the passage breathe. Stay within one band of difficulty above the learner's level — no sudden classical poetry inside a beginner passage. If a learner-card has multiple forms (past/present/imperative/masdar/active-participle/plural/feminine), feel free to use whichever form fits the sentence naturally — you do not have to stick to the base form.`;


// ─────────────────────────────────────────────────────────────
// SEED DATA
// ─────────────────────────────────────────────────────────────
const SEED_DECKS = [
  {id:"d1",title:"Common Nouns",createdAt:Date.now()-86400000*3},
  {id:"d2",title:"Essential Verbs",createdAt:Date.now()-86400000*6},
];
const SEED_CARDS = {
  d1:[
    {id:"c1",wordType:"noun",english:"Book",arabicBase:"كِتَاب",
     forms:{singular:"كِتَاب",plural:"كُتُب",synonym:"مُجَلَّد",synonymPlural:"مُجَلَّدَات",antonym:"",antonymPlural:"",harf:"فِي"},status:"new"},
    {id:"c2",wordType:"noun",english:"House",arabicBase:"بَيْت",
     forms:{singular:"بَيْت",plural:"بُيُوت",synonym:"مَنْزِل",synonymPlural:"مَنَازِل",antonym:"",antonymPlural:"",harf:"فِي"},status:"weak"},
    {id:"c3",wordType:"noun",english:"Teacher",arabicBase:"مُعَلِّم",
     forms:{singular:"مُعَلِّم",plural:"مُعَلِّمُون",synonym:"أُسْتَاذ",synonymPlural:"أَسَاتِذَة",antonym:"طَالِب",antonymPlural:"طُلَّاب",harf:"مَعَ"},status:"known"},
  ],
  d2:[
    {id:"c5",wordType:"verb",english:"To write",arabicBase:"كَتَبَ",
     forms:{past:"كَتَبَ",present:"يَكْتُبُ",imperative:"اكْتُبْ",masdar:"كِتَابَة",activePart:"كَاتِب",passivePart:"مَكْتُوب",harf:"عَنْ"},status:"known"},
    {id:"c6",wordType:"verb",english:"To go",arabicBase:"ذَهَبَ",
     forms:{past:"ذَهَبَ",present:"يَذْهَبُ",imperative:"اذْهَبْ",masdar:"ذَهَاب",activePart:"ذَاهِب",passivePart:"",harf:"إِلَى"},status:"new"},
  ],
};

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&family=Outfit:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#F2EDE5;--surface:#FDFBF7;--surface2:#EAE4D9;
  --border:#DDD5C5;
  --text:#1B1714;--text2:#796E63;--text3:#A8998D;
  --accent:#9B3A0C;--accent2:#C04A10;--accent-bg:#FEF0E6;--accent-border:#EFC9B0;
  --know:#1A6440;--know-bg:#EAF6EF;--know-border:#A5D9BC;
  --weak:#AE1F1F;--weak-bg:#FEF0F0;--weak-border:#EBB8B8;
  --read:#1A4A8B;--read-bg:#EEF3FC;--read-border:#B8CFF0;
  --listen:#5B2D8B;--listen-bg:#F3EEFE;--listen-border:#C9AEF0;
  --info:#1A6B6B;--info-bg:#EAF6F6;--info-border:#A5D9D9;
  --harf:#6B4A1A;--harf-bg:#FDF5E6;--harf-border:#E8D4A0;
  --r:14px;--rs:10px;--rxs:8px;
}
[data-theme="dark"]{
  --bg:#1A1816;--surface:#252220;--surface2:#302C28;
  --border:#3D3832;
  --text:#E8E2D8;--text2:#A09889;--text3:#6E645A;
  --accent:#E8733A;--accent2:#F08A52;--accent-bg:#3A2518;--accent-border:#5C3A22;
  --know:#38B07A;--know-bg:#1A2E24;--know-border:#285C40;
  --weak:#E84C4C;--weak-bg:#2E1A1A;--weak-border:#5C2828;
  --read:#5A9CE8;--read-bg:#1A2430;--read-border:#2A4060;
  --listen:#A06CE8;--listen-bg:#241A30;--listen-border:#3C2860;
  --info:#38B0B0;--info-bg:#1A2E2E;--info-border:#285C5C;
  --harf:#D4A852;--harf-bg:#2E2818;--harf-border:#5C4E28;
}
@media(prefers-reduced-motion:reduce){
  .card-appear,.gen-appear,.pop-appear,.screen,.spin,.overlay,.drawer{animation:none!important;transition:none!important}
}
html,body,#root{height:100%;background:var(--bg);font-family:'Outfit',sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
.app{max-width:520px;margin:0 auto;min-height:100vh}
@media(min-width:768px){.app{max-width:600px}}
@media(min-width:1024px){.app{max-width:680px}}
.screen{animation:sIn .22s ease;padding-bottom:48px;min-height:100vh}
@keyframes sIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.card-appear{animation:cIn .3s cubic-bezier(.2,0,.2,1)}
@keyframes cIn{from{opacity:0;transform:perspective(800px) rotateY(-20deg) scale(.97)}to{opacity:1;transform:perspective(800px) rotateY(0) scale(1)}}
.gen-appear{animation:gIn .28s ease}
@keyframes gIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.spin{animation:spin .9s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.btn{border:none;cursor:pointer;border-radius:var(--rs);font-family:'Outfit',sans-serif;font-weight:500;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;gap:7px}
.btn:active{transform:scale(.97)}
.btn-primary{background:var(--accent);color:#fff;padding:13px 20px;font-size:14px;font-weight:600}
.btn-primary:hover{background:var(--accent2)}
.btn-primary:disabled{opacity:.52;cursor:not-allowed;transform:none}
.btn-ghost{background:var(--surface2);color:var(--text2);padding:9px;border-radius:50%}
.btn-ghost:hover{background:var(--border);color:var(--text)}
.btn-sm{padding:7px 11px;font-size:12.5px;font-weight:600;border-radius:var(--rxs)}
.btn-read{background:var(--read);color:#fff;font-weight:600}
.btn-read:hover{background:#1c58a8}
.btn-read:disabled{opacity:.52;cursor:not-allowed}
.btn-listen{background:var(--listen);color:#fff;font-weight:600}
.btn-listen:hover{background:#6f38ad}
.btn-listen:disabled{opacity:.52;cursor:not-allowed}
.chip{cursor:pointer;border-radius:100px;padding:7px 13px;font-size:12.5px;font-weight:500;border:1.5px solid var(--border);background:var(--surface);color:var(--text2);transition:all .15s;font-family:'Outfit',sans-serif;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.chip:hover:not(.chip-on){border-color:var(--accent);color:var(--accent)}
.chip-on{background:var(--accent);border-color:var(--accent);color:#fff}
.input{width:100%;border:1.5px solid var(--border);border-radius:var(--rs);padding:11px 13px;font-family:'Outfit',sans-serif;font-size:14px;color:var(--text);background:var(--surface);outline:none;transition:border-color .15s;appearance:none}
.input:focus{border-color:var(--accent)}
textarea.input{resize:vertical;min-height:110px;line-height:1.7}
.lbl{font-size:12px;font-weight:600;color:var(--text2);display:block;margin-bottom:7px}
.ar{direction:rtl;font-family:'Scheherazade New','Amiri','Traditional Arabic',serif;line-height:1.6}
.ar-word{cursor:pointer;border-radius:4px;padding:1px 3px;transition:background .12s;display:inline}
.ar-word:hover{background:rgba(155,58,12,.14)}
.ar-word.hl{background:rgba(155,58,12,.18);font-weight:600}
.card-row{display:flex;align-items:flex-start;background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rs);padding:13px 14px;gap:11px;transition:background .15s}
.card-row:hover{background:#F8F4EE}
.progress-track{height:3px;background:var(--surface2);border-radius:100px;overflow:hidden}
.progress-fill{height:100%;border-radius:100px;transition:width .5s ease}
.tag{display:inline-flex;align-items:center;padding:2px 8px;border-radius:100px;font-size:11px;font-weight:600}
.tag-weak{background:var(--weak-bg);color:var(--weak);border:1px solid var(--weak-border)}
.tag-know{background:var(--know-bg);color:var(--know);border:1px solid var(--know-border)}
.tag-new{background:var(--surface2);color:var(--text3);border:1px solid var(--border)}
.divider{border:none;border-top:1px solid var(--border);margin:16px 0}
.chk{width:18px;height:18px;border-radius:5px;border:1.5px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;flex-shrink:0}
.chk.on{background:var(--accent);border-color:var(--accent)}
.sec{font-size:10.5px;font-weight:700;color:var(--text3);letter-spacing:.13em;text-transform:uppercase;margin-bottom:10px}
.pop-appear{animation:popIn .38s cubic-bezier(.34,1.56,.64,1)}
@keyframes popIn{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:scale(1)}}
/* Flashcard flip — front rotates out as user taps, back rotates in. Mimics a physical card flip without two-faced complexity. */
.card-flip-out{animation:cFlipOut .28s cubic-bezier(.4,0,.7,.2) forwards;transform-origin:center center;will-change:transform,opacity}
.card-flip-in{animation:cFlipIn .55s cubic-bezier(.2,.6,.25,1);transform-origin:center center;will-change:transform,opacity}
@keyframes cFlipOut{from{opacity:1;transform:perspective(1100px) rotateY(0) scale(1)}to{opacity:0;transform:perspective(1100px) rotateY(85deg) scale(.94)}}
@keyframes cFlipIn{from{opacity:0;transform:perspective(1100px) rotateY(-90deg) scale(.93)}55%{opacity:1;transform:perspective(1100px) rotateY(12deg) scale(1.015)}to{opacity:1;transform:perspective(1100px) rotateY(0) scale(1)}}
/* True 2-faced flippable card. Click anywhere on the card to toggle. */
.flip-card{perspective:1400px;width:100%;cursor:pointer}
.flip-card-inner{position:relative;width:100%;min-height:230px;transition:transform .65s cubic-bezier(.2,.6,.25,1);transform-style:preserve-3d}
.flip-card.is-flipped .flip-card-inner{transform:rotateY(180deg)}
.flip-card-face{position:absolute;top:0;left:0;width:100%;min-height:230px;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:var(--surface);border:1.5px solid var(--border);border-radius:var(--r);box-shadow:0 5px 24px rgba(0,0,0,0.08);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px 22px}
.flip-card-back{transform:rotateY(180deg)}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.44);z-index:100;display:flex;align-items:flex-end;justify-content:center;animation:ovIn .2s ease}
@keyframes ovIn{from{opacity:0}to{opacity:1}}
.drawer{background:var(--surface);border-radius:20px 20px 0 0;width:100%;max-width:680px;padding:22px 20px 36px;animation:drIn .25s cubic-bezier(.2,0,.2,1)}
@keyframes drIn{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}
.seg{display:flex;background:var(--surface2);border-radius:var(--rs);padding:3px;gap:2px}
.seg-opt{flex:1;text-align:center;padding:7px 4px;font-size:12px;font-weight:500;border-radius:8px;cursor:pointer;transition:all .15s;color:var(--text2);border:none;background:transparent;font-family:'Outfit',sans-serif}
.seg-opt.on{background:var(--surface);color:var(--text);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.1)}
.module-card{border-radius:var(--r);padding:16px 18px;border:1.5px solid;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:14px;background:var(--surface)}
.module-card:hover{transform:translateX(2px)}
.scene-card{background:linear-gradient(135deg,#1a1a2e,#16213e 50%,#0f3460);border-radius:var(--rs);overflow:hidden;position:relative}
.scene-inner{padding:18px;position:relative;z-index:1}
.scene-stars{position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,.15) 1px,transparent 1px);background-size:20px 20px;opacity:.4}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.toast-container{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:200;display:flex;flex-direction:column;gap:8px;max-width:400px;width:calc(100% - 32px);pointer-events:none}
.toast{padding:12px 16px;border-radius:var(--rs);font-size:13px;font-weight:500;pointer-events:auto;animation:toastIn .3s ease;box-shadow:0 4px 16px rgba(0,0,0,.15);display:flex;align-items:center;gap:8px}
.toast-success{background:var(--know-bg);color:var(--know);border:1px solid var(--know-border)}
.toast-error{background:var(--weak-bg);color:var(--weak);border:1px solid var(--weak-border)}
.toast-info{background:var(--info-bg);color:var(--info);border:1px solid var(--info-border)}
@keyframes toastIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 5px;background:var(--surface2);border:1px solid var(--border);border-radius:4px;font-size:10px;font-weight:600;color:var(--text3);font-family:'Outfit',sans-serif}
.search-input{width:100%;border:1.5px solid var(--border);border-radius:var(--rs);padding:9px 13px 9px 36px;font-family:'Outfit',sans-serif;font-size:13.5px;color:var(--text);background:var(--surface);outline:none;transition:border-color .15s}
.search-input:focus{border-color:var(--accent)}
.search-input::placeholder{color:var(--text3)}
.search-overlay{position:fixed;inset:0;z-index:150;background:var(--bg);animation:sIn .15s ease;display:flex;flex-direction:column}
.search-overlay .search-header{padding:16px 20px;display:flex;align-items:center;gap:10;border-bottom:1px solid var(--border)}
.search-overlay .search-results{flex:1;overflow-y:auto;padding:8px 20px}
.search-result{display:flex;align-items:center;gap:12;padding:12px 14px;border-radius:var(--rs);cursor:pointer;transition:background .12s;border:1px solid transparent}
.search-result:hover{background:var(--surface);border-color:var(--border)}
.chat-bubble{padding:12px 15px;border-radius:16px;max-width:85%;line-height:1.6;font-size:14px;animation:gIn .2s ease}
.chat-ai{background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px;align-self:flex-start}
.chat-user{background:var(--accent);color:#fff;border-bottom-right-radius:4px;align-self:flex-end}
.stat-card{background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rs);padding:12px 14px;text-align:center;flex:1;min-width:0}
.stat-num{font-size:22px;font-weight:700;line-height:1}
.stat-label{font-size:10.5px;color:var(--text3);margin-top:4px;font-weight:500;text-transform:uppercase;letter-spacing:.05em}
.onboarding-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;animation:ovIn .3s ease}
.onboarding-card{background:var(--surface);border-radius:20px;padding:32px 24px;max-width:400px;width:calc(100% - 40px);animation:popIn .4s cubic-bezier(.34,1.56,.64,1);text-align:center}
.onboarding-dots{display:flex;justify-content:center;gap:6px;margin:20px 0}
.onboarding-dot{width:8px;height:8px;border-radius:50%;background:var(--border);transition:all .2s}
.onboarding-dot.active{background:var(--accent);width:20px;border-radius:4px}
@keyframes pulse{0%,100%{box-shadow:0 0 0 4px var(--weak-bg)}50%{box-shadow:0 0 0 10px var(--weak-bg)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes loadbar{0%{width:0%}40%{width:55%}80%{width:88%}100%{width:96%}}
.bar-chart{display:flex;align-items:flex-end;gap:4px;height:80px;padding:4px 0}
.bar-col{display:flex;flex-direction:column;align-items:center;flex:1;gap:2px}
.bar-fill{width:100%;border-radius:3px 3px 0 0;min-height:1px;transition:height .3s ease}
.bar-label{font-size:9px;color:var(--text3);font-weight:500}
.rating-stars{display:flex;gap:6px;justify-content:center}
.rating-star{width:36px;height:36px;border-radius:50%;border:2px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;font-size:16px}
.rating-star.on{border-color:var(--accent);background:var(--accent-bg)}
.insight-card{display:flex;align-items:flex-start;gap:10px;padding:10px 13px;border-radius:var(--rxs);background:var(--surface);border:1px solid var(--border);font-size:13px;line-height:1.5;color:var(--text2)}
.insight-card.warning{border-color:var(--weak-border);background:var(--weak-bg)}
.insight-card.success{border-color:var(--know-border);background:var(--know-bg)}
.test-option{display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--surface);border:1.5px solid var(--border);border-radius:var(--rs);cursor:pointer;transition:all .15s}
.test-option:hover{border-color:var(--accent);background:var(--accent-bg)}
`;

// ─────────────────────────────────────────────────────────────
// API + USAGE TRACKING
// Production: calls go through /api/claude (Vercel serverless → OpenRouter)
// API key lives in Vercel env vars — never exposed to the browser
// Model is toggled in Settings and stored in module-level ref below
// ─────────────────────────────────────────────────────────────

// Module-level model refs — updated by root App when settings change.
// Avoids threading model as a prop through every screen component.
let _defaultModel = "openai/gpt-4o-mini";
let _modelByTag = {}; // per-feature override: tag -> modelId
let _imageModel = "gemini-2.5-flash-image";
let _orKey = ""; // OpenRouter key — synced from settings
let _gKey = ""; // Google AI Studio key for Nano Banana image gen — synced from settings
let _ttsKey = ""; // Google Cloud TTS key (optional, separate from AI Studio key)
let _ttsVoice = "ar-XA-Wavenet-C";
let _ttsSpeed = 0.92;
let _sttKey = ""; // OpenAI key, sent to /api/stt for Whisper
let _sttEnabled = false; // user has explicitly opted in to enhanced STT
let _convSilenceMs = 2500;
let _convFuzzyThreshold = 0.8;
let _autoGenerateImage = false; // opt-in per learning aid; off by default

function pickModelForTag(tag){return _modelByTag[tag]||_defaultModel;}

async function callClaude(prompt, maxTokens=1500, tag="other", trackFn=null, timeoutMs=null) {
  // Optional client-side timeout so a hung request fails fast instead of
  // leaving the UI spinning forever (used by quick interactive calls like
  // word lookups).
  const ctrl = timeoutMs ? new AbortController() : null;
  const timer = ctrl ? setTimeout(()=>ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch("/api/claude", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model: pickModelForTag(tag),
        max_tokens: maxTokens,
        messages:[{role:"user",content:prompt}],
        ..._orKey ? {apiKey:_orKey} : {},
      }),
      ...(ctrl ? {signal:ctrl.signal} : {}),
    });
    const d = await res.json();
    if(d.error) throw new Error(typeof d.error==="string"?d.error:(d.error.message||"AI request failed"));
    // api/claude.js normalises OpenRouter response → {content:[{type:"text",text}], usage:{input_tokens, output_tokens}}
    const outputText = d.content?.find(b=>b.type==="text")?.text || "";
    if(!outputText) throw new Error("Empty response from AI — check your API key in Settings.");
    if (trackFn) {
      trackFn(tag, prompt.length, outputText.length,
        d.usage?.input_tokens  || Math.ceil(prompt.length/4),
        d.usage?.output_tokens || Math.ceil(outputText.length/4)
      );
    }
    return outputText;
  } catch(e) {
    if(e.name==="AbortError") throw new Error("Lookup timed out — please try again.");
    throw e;
  } finally {
    if(timer) clearTimeout(timer);
  }
}

// Vision variant of callClaude — `content` is an OpenAI-style content array
// (text + image_url parts). api/claude.js passes `messages` through to
// OpenRouter untouched, so vision-capable models (gpt-4o-mini default)
// receive the images as-is. Used by the Grammar Import feature to read
// screenshot pages of the learner's notes.
async function callClaudeVision(content, maxTokens=3000, tag="other", trackFn=null) {
  const res = await fetch("/api/claude", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model: pickModelForTag(tag),
      max_tokens: maxTokens,
      messages:[{role:"user",content}],
      ..._orKey ? {apiKey:_orKey} : {},
    }),
  });
  const d = await res.json();
  if(d.error) throw new Error(typeof d.error==="string"?d.error:(d.error.message||"AI request failed"));
  const outputText = d.content?.find(b=>b.type==="text")?.text || "";
  if(!outputText) throw new Error("Empty response from AI — check your API key in Settings.");
  if (trackFn) {
    const promptChars = content.filter(p=>p.type==="text").reduce((n,p)=>n+p.text.length,0);
    trackFn(tag, promptChars, outputText.length,
      d.usage?.input_tokens || Math.ceil(promptChars/4),
      d.usage?.output_tokens || Math.ceil(outputText.length/4));
  }
  return outputText;
}

// ─────────────────────────────────────────────────────────────
// THE GENERATION GATEWAY — client side (Phase 3)
// Routes structured generation through /api/generate, which owns auth +
// entitlement + cache + usage logging server-side. Sends the Firebase ID
// token so the gateway can identify the user. Returns {payload, cached, usage};
// a cache hit costs nothing (no model call), so usage is only metered on a miss.
// Throws err.paywall=true on a 402 (wired to a paywall UI in Phase 6).
// ─────────────────────────────────────────────────────────────
async function callGenerate({kind, inputs, model=null, maxTokens=1024, personalized=false, noCache=false, tag="other", trackFn=null}){
  let token="";
  try { if(auth.currentUser) token=await auth.currentUser.getIdToken(); } catch {}
  const res=await fetch("/api/generate",{
    method:"POST",
    headers:{"Content-Type":"application/json",...(token?{Authorization:`Bearer ${token}`}:{})},
    body:JSON.stringify({
      kind, inputs,
      model: model||pickModelForTag(tag),
      maxTokens, personalized, noCache,
      ..._orKey ? {apiKey:_orKey} : {},
    }),
  });
  let d; try { d=await res.json(); } catch { throw new Error("The generation service returned an unexpected response."); }
  if(res.status===402){ const e=new Error("Upgrade required to generate this content."); e.paywall=true; e.reason=d.reason; throw e; }
  if(!res.ok||d.error) throw new Error(typeof d.error==="string"?d.error:(d.error?.message||"Generation failed"));
  if(trackFn && !d.cached && d.usage){
    trackFn(tag, 0, 0, d.usage.input_tokens||0, d.usage.output_tokens||0);
  }
  return d;
}

/**
 * Calls the LLM expecting JSON back, validates tashkeel on Arabic text,
 * and retries once with a stronger prompt if tashkeel is insufficient.
 */
async function callClaudeWithTashkeel(prompt, maxTokens=1500, tag="other", trackFn=null) {
  const raw = await callClaude(prompt, maxTokens, tag, trackFn);
  let parsed;
  try { parsed = extractJSON(raw); } catch { return raw; } // not JSON, return as-is

  if (hasSufficientTashkeel(parsed, 0.5)) return raw;

  // Retry with reinforced tashkeel instruction
  const retryPrompt = prompt + `

⚠️ YOUR PREVIOUS RESPONSE HAD MISSING TASHKEEL. THIS IS A RETRY.
You MUST add full tashkeel (حَرَكَات) to EVERY Arabic letter: fatha فَتْحَة, damma ضَمَّة, kasra كَسْرَة, sukun سُكُون, shadda شَدَّة, tanween تَنْوِين.
NO bare Arabic letters are acceptable. Every ب must be بَ بُ بِ بْ etc.
Example: الْكِتَابُ الْكَبِيرُ not الكتاب الكبير.`;
  return callClaude(retryPrompt, maxTokens, tag, trackFn);
}

// Robust JSON extractor — handles LLM responses that wrap JSON in markdown or extra text
function extractJSON(raw) {
  const clean = raw.replace(/```json|```/g,"").trim();
  try { return JSON.parse(clean); } catch {}
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  // Try to fix truncated JSON (missing closing brackets)
  let fixed = clean;
  for(let i=0;i<5;i++){
    const opens=((fixed.match(/\[/g)||[]).length)-((fixed.match(/\]/g)||[]).length);
    const braces=((fixed.match(/\{/g)||[]).length)-((fixed.match(/\}/g)||[]).length);
    if(opens<=0&&braces<=0) break;
    // Remove trailing incomplete object/entry
    fixed=fixed.replace(/,?\s*\{[^}]*$/,"");
    if(braces>0) fixed+="}";
    if(opens>0) fixed+="]";
    try { return JSON.parse(fixed); } catch {}
  }
  throw new Error("JSON extraction failed — the AI response may have been cut off. Try fewer words per batch.");
}

// ─────────────────────────────────────────────────────────────
// Fuzzy string matching for speech-to-text vocabulary detection.
// STT mis-hears Arabic constantly, so exact matching is far too strict.
// Levenshtein distance + 80%-similarity threshold lets "close enough" count.
// ─────────────────────────────────────────────────────────────
function stripArabicDiacritics(s){return (s||"").replace(/[ً-ٰٟٱ]/g,"");}
function normalizeForMatch(s){return stripArabicDiacritics((s||"").toLowerCase().trim()).replace(/\s+/g," ");}
function levenshtein(a,b){
  if(!a||!b) return Math.max(a?.length||0,b?.length||0);
  if(a===b) return 0;
  const m=a.length, n=b.length;
  if(m===0||n===0) return Math.max(m,n);
  let prev=Array(n+1).fill(0); for(let j=0;j<=n;j++) prev[j]=j;
  let curr=Array(n+1).fill(0);
  for(let i=1;i<=m;i++){
    curr[0]=i;
    for(let j=1;j<=n;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      curr[j]=Math.min(prev[j]+1, curr[j-1]+1, prev[j-1]+cost);
    }
    [prev,curr]=[curr,prev];
  }
  return prev[n];
}
function similarity(a,b){
  const A=normalizeForMatch(a), B=normalizeForMatch(b);
  if(!A||!B) return 0;
  if(A===B) return 1;
  const dist=levenshtein(A,B);
  const maxLen=Math.max(A.length,B.length);
  return maxLen===0?1:1-(dist/maxLen);
}
// Fuzzy contains: returns true if `needle` appears in `haystack` with at least
// `threshold` similarity to some sliding window of equal length.
function fuzzyContains(haystack,needle,threshold=0.8){
  const H=normalizeForMatch(haystack), N=normalizeForMatch(needle);
  if(!H||!N) return false;
  if(H.includes(N)) return true;
  if(N.length<=2) return false; // too short to safely fuzzy-match
  // Tokenize haystack and compare each token + adjacent bigrams to needle
  const tokens=H.split(/\s+/);
  for(let i=0;i<tokens.length;i++){
    if(similarity(tokens[i],N)>=threshold) return true;
    if(i<tokens.length-1){
      const bi=tokens[i]+" "+tokens[i+1];
      if(similarity(bi,N)>=threshold) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// Text-to-Speech adapter (Google Cloud TTS via /api/tts proxy)
// ─────────────────────────────────────────────────────────────
// Pipeline:
//  1. Cleaned text → hashKey
//  2. Check localStorage cache (keeps 30 days, LRU-trimmed at 60 entries)
//  3. POST to /api/tts; on success, play returned base64 MP3 via <audio>
//  4. On {noKey:true} or any failure, fall back to window.speechSynthesis
// Speaker selection + caching live here so the call sites stay one-liners.
let _ttsCacheTrimmed = false;
const TTS_CACHE_PREFIX = "arabic_fc_tts_";
const TTS_CACHE_MAX = 60;
const TTS_CACHE_TTL = 30*24*60*60*1000;
function ttsHash(s){let h=5381;for(let i=0;i<s.length;i++) h=((h<<5)+h)^s.charCodeAt(i);return (h>>>0).toString(36);}
function ttsCacheRead(key){
  try{
    const raw=localStorage.getItem(TTS_CACHE_PREFIX+key); if(!raw) return null;
    const o=JSON.parse(raw);
    if(Date.now()-(o.t||0)>TTS_CACHE_TTL){localStorage.removeItem(TTS_CACHE_PREFIX+key);return null;}
    return o.audio||null;
  }catch{return null;}
}
function ttsCacheWrite(key,audio){
  try{
    localStorage.setItem(TTS_CACHE_PREFIX+key,JSON.stringify({audio,t:Date.now()}));
    if(!_ttsCacheTrimmed){
      _ttsCacheTrimmed=true;
      // LRU-ish trim: keep at most TTS_CACHE_MAX, drop oldest by timestamp
      const keys=Object.keys(localStorage).filter(k=>k.startsWith(TTS_CACHE_PREFIX));
      if(keys.length>TTS_CACHE_MAX){
        const entries=keys.map(k=>{try{return [k,JSON.parse(localStorage.getItem(k)).t||0];}catch{return [k,0];}}).sort((a,b)=>a[1]-b[1]);
        entries.slice(0,entries.length-TTS_CACHE_MAX).forEach(([k])=>localStorage.removeItem(k));
      }
    }
  }catch{/* localStorage may be full or disabled; ignore */}
}
// Voice usage tracker injected by the App root (kept on a module ref so the
// module-level synthesizeArabic / transcribeAudio helpers can record cost
// against the global usage state).
let _voiceTracker = null;

// Live <audio> element so we can stop a playing clip when a new one starts.
// _ttsRequestId is bumped on every new synthesize call AND on external stop —
// any in-flight callback checks `myId === _ttsRequestId` before doing anything,
// so rapid taps cleanly cancel rather than pile up.
let _ttsAudioEl=null;
let _ttsRequestId=0;
function _killCurrentAudio(){
  if(_ttsAudioEl){
    try{_ttsAudioEl.pause();_ttsAudioEl.removeAttribute("src");_ttsAudioEl.load();}catch{}
    _ttsAudioEl=null;
  }
  if(typeof window!=="undefined"&&window.speechSynthesis) window.speechSynthesis.cancel();
}
function stopTtsAudio(){
  _ttsRequestId++; // invalidate any pending synthesize() calls
  _killCurrentAudio();
}
// Strip translation parentheses and any leftover correction tags before speaking.
function cleanArabicForSpeech(text){
  if(!text) return "";
  return text
    .replace(/\n?\(.*?\)\s*$/s,"")
    .replace(/\[تَصْحِيح.*?\]/gs,"")
    .replace(/\[تصحيح.*?\]/gs,"")
    .trim();
}
function browserSpeak(text,onEnd){
  if(!window.speechSynthesis||!text){onEnd?.();return;}
  window.speechSynthesis.cancel();
  const utt=new SpeechSynthesisUtterance(text);
  utt.lang="ar-SA"; utt.rate=0.85;
  const v=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith("ar")); if(v) utt.voice=v;
  utt.onend=()=>onEnd?.(); utt.onerror=()=>onEnd?.();
  window.speechSynthesis.speak(utt);
}
async function synthesizeArabic(rawText,opts={}){
  const text=cleanArabicForSpeech(rawText);
  if(!text){opts.onEnd?.();return;}
  const voice=opts.voice||_ttsVoice||"ar-XA-Wavenet-C";
  const speed=opts.speed??_ttsSpeed??0.92;
  const {onStart,onEnd}=opts;
  // Claim this synthesize as the active request, kill any previous audio.
  // Every async branch below checks `myId === _ttsRequestId` before acting
  // so superseded calls become no-ops (no overlapping playback, no double
  // onStart/onEnd callbacks).
  const myId=++_ttsRequestId;
  _killCurrentAudio();
  const isCurrent=()=>myId===_ttsRequestId;
  const cacheKey=ttsHash(`${voice}|${speed}|${text}`);
  const cached=ttsCacheRead(cacheKey);
  const play=(src)=>{
    if(!isCurrent()){onEnd?.();return;}
    const a=new Audio(src); _ttsAudioEl=a;
    a.onplay=()=>{if(isCurrent()) onStart?.();};
    a.onended=()=>{if(isCurrent()){_ttsAudioEl=null;onEnd?.();}};
    a.onerror=()=>{if(isCurrent()){_ttsAudioEl=null;browserSpeak(text,onEnd);}};
    a.play().catch(()=>{if(isCurrent()){_ttsAudioEl=null;browserSpeak(text,onEnd);}});
  };
  if(cached){play(cached);return;}
  try{
    // Prefer the dedicated Google Cloud TTS key, fall back to AI Studio key
    // (works if Cloud TTS is enabled on the same project), then to nothing.
    const apiKey=_ttsKey||_gKey||"";
    const res=await fetch("/api/tts",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({text,voice,speed,...(apiKey?{apiKey}:{})})});
    if(!isCurrent()) return;
    const data=await res.json();
    if(!isCurrent()) return;
    if(data.noKey||!data.audio){browserSpeak(text,onEnd);onStart?.();return;}
    ttsCacheWrite(cacheKey,data.audio);
    // Track only NEW synthesis (cache hits cost nothing).
    if(_voiceTracker) _voiceTracker("ttsGoogle", text.length, 0);
    play(data.audio);
  }catch{
    if(isCurrent()){browserSpeak(text,onEnd); onStart?.();}
  }
}

// Fetch a playable TTS source (data URL) WITHOUT auto-playing, at neutral
// speed — so a player can control speed live via audio.playbackRate (Phase 4
// dictation). Returns the src string, or null when no TTS key (caller falls
// back to browserSpeak). Reuses the same on-disk cache as synthesizeArabic.
async function getTtsSrc(rawText){
  const text=cleanArabicForSpeech(rawText);
  if(!text) return null;
  const voice=_ttsVoice||"ar-XA-Wavenet-C";
  const speed=1.0; // neutral; playback rate is applied client-side
  const cacheKey=ttsHash(`${voice}|${speed}|${text}`);
  const cached=ttsCacheRead(cacheKey);
  if(cached) return cached;
  try{
    const apiKey=_ttsKey||_gKey||"";
    const res=await fetch("/api/tts",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({text,voice,speed,...(apiKey?{apiKey}:{})})});
    const data=await res.json();
    if(data.noKey||!data.audio) return null;
    ttsCacheWrite(cacheKey,data.audio);
    if(_voiceTracker) _voiceTracker("ttsGoogle", text.length, 0);
    return data.audio;
  }catch{ return null; }
}
// Change the speed of the CURRENTLY PLAYING TTS clip live, without restarting
// (Phase 4 acceptance for Listening). Works for the Google-TTS <audio> path;
// returns false if there's no live element (caller may fall back to restart).
function setTtsPlaybackRate(rate){
  if(_ttsAudioEl){ try{ _ttsAudioEl.playbackRate=rate; return true; }catch{} }
  return false;
}

// Word-level diff for dictation correction. Aligns target vs. user tokens via
// LCS on diacritic-insensitive forms, so "close enough" Arabic counts. Returns
// ordered ops ({ok|missing|extra}) + a score for the reveal-after-write UI.
function diffTokens(target,user){
  const tok=(s)=>(s||"").trim().split(/\s+/).filter(Boolean);
  const T=tok(target), U=tok(user);
  const nT=T.map(normalizeForMatch), nU=U.map(normalizeForMatch);
  const m=nT.length,n=nU.length;
  const dp=Array.from({length:m+1},()=>new Array(n+1).fill(0));
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)
    dp[i][j]=nT[i]===nU[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
  const ops=[]; let i=0,j=0;
  while(i<m&&j<n){
    if(nT[i]===nU[j]){ops.push({type:"ok",t:T[i],u:U[j]});i++;j++;}
    else if(dp[i+1][j]>=dp[i][j+1]){ops.push({type:"missing",t:T[i]});i++;}
    else {ops.push({type:"extra",u:U[j]});j++;}
  }
  while(i<m) ops.push({type:"missing",t:T[i++]});
  while(j<n) ops.push({type:"extra",u:U[j++]});
  const matched=ops.filter(o=>o.type==="ok").length;
  return {ops,matched,total:m,score:m?Math.round((matched/m)*100):0};
}

// Send a recorded audio Blob to /api/stt for transcription.
// Returns transcript string, or null when the proxy can't transcribe (no key
// configured / network failure) so the caller can fall back to browser STT.
// Returns {transcript, error, noKey, disabled} so the caller can show the real
// reason a transcription failed instead of a generic "out of credit" guess.
async function transcribeAudio(blob, durationSec=null){
  if(!_sttEnabled||!_sttKey) return {transcript:null,disabled:true};
  try{
    const buf=await blob.arrayBuffer();
    let bin=""; const bytes=new Uint8Array(buf);
    for(let i=0;i<bytes.length;i++) bin+=String.fromCharCode(bytes[i]);
    const audio=btoa(bin);
    const res=await fetch("/api/stt",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({audio,mime:blob.type||"audio/webm",language:"ar",openaiKey:_sttKey})});
    const data=await res.json();
    if(data.noKey) return {transcript:null,noKey:true};
    if(data.error) return {transcript:null,error:data.error}; // surface the real Whisper/Deepgram error
    if(!data.transcript) return {transcript:null};
    // Track usage. Prefer measured durationSec; if not provided, estimate
    // from blob size (~16kB/sec for opus). Whisper bills per second, rounded.
    if(_voiceTracker){
      const secs = Math.max(1, Math.round(durationSec || (blob.size/16000)));
      _voiceTracker("sttWhisper", secs, 0);
    }
    return {transcript:data.transcript};
  }catch(e){return {transcript:null,error:e.message};}
}

// Image generation via Nano Banana (Gemini Flash Image) — through /api/image proxy
// Returns image URL (base64 data URL) or null (app shows scene description as fallback)
async function generateImage(prompt, trackFn=null) {
  const model = _imageModel || "gemini-2.5-flash-image";
  try {
    const res = await fetch("/api/image", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model,
        prompt:`${prompt} Style: minimalist flat sticker illustration, single bold subject centered on a plain white background, vivid simple colors, thick clean outlines, slightly exaggerated for memorability, no text or letters anywhere in the image. STRICT RELIGIOUS CONSTRAINT — non-negotiable: absolutely NO eyes anywhere in the image. No human faces, no animal faces, no eyes of any kind (no dots, no slits, no glint, no abstract eye shapes). If a person or animal must appear, depict only from behind or as a featureless silhouette with no facial features at all. Prefer objects, symbols, scenery, or hands over people and animals.`,
        ..._gKey ? {apiKey:_gKey} : {},
      }),
    });
    const data = await res.json();
    if (data.noKey) return null;
    const url = data.data?.[0]?.url || null;
    if (url && trackFn) {
      const tag = model.includes("3.1") ? "imageNB2" : "imageNB1";
      trackFn(tag, 0, 0, 0, 0);
    }
    return url;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────
// SHARED COMPONENTS
// ─────────────────────────────────────────────────────────────
function Hdr({title,sub,onBack,right}) {
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"24px 20px 0"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        {onBack&&<button className="btn btn-ghost" onClick={onBack} style={{width:34,height:34,flexShrink:0}}><ArrowLeft size={16}/></button>}
        <div>
          {sub&&<div className="sec" style={{margin:0,marginBottom:3}}>{sub}</div>}
          <div style={{fontFamily:"Lora,serif",fontSize:21,fontWeight:600,lineHeight:1.2}}>{title}</div>
        </div>
      </div>
      {right||<div/>}
    </div>
  );
}

function Seg({options,value,onChange}) {
  return (
    <div className="seg">
      {options.map(o=>(
        <button key={o.value} className={`seg-opt ${value===o.value?"on":""}`} onClick={()=>onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

function SceneCard({imagePrompt,word}) {
  return (
    <div className="scene-card">
      <div className="scene-stars"/>
      <div className="scene-inner">
        <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}>
          <ImageIcon size={13} color="rgba(255,255,255,.6)"/>
          <span style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,.6)",letterSpacing:".12em",textTransform:"uppercase"}}>Visual Scene</span>
          <span style={{fontSize:10,color:"rgba(255,255,255,.35)",marginRight:"auto"}}>· {word}</span>
          <span style={{fontSize:10,color:"rgba(255,255,255,.4)",background:"rgba(255,255,255,.08)",padding:"2px 7px",borderRadius:100,border:"1px solid rgba(255,255,255,.12)"}}>Nano Banana ready</span>
        </div>
        <div style={{fontSize:13.5,color:"rgba(255,255,255,.88)",lineHeight:1.75,fontStyle:"italic"}}>{imagePrompt}</div>
        <div style={{marginTop:10,fontSize:11,color:"rgba(255,255,255,.35)"}}>Prompt ready for Nano Banana in your deployed app</div>
      </div>
    </div>
  );
}

function ClickableArabic({text,highlightWords=[],onWordClick,fontSize=20}) {
  const words = text.split(/\s+/).filter(Boolean);
  const strip=s=>s.replace(/[\u064B-\u065F\u0670]/g,"");
  const hlStripped=highlightWords.map(hw=>hw?strip(hw):"");
  return (
    <div className="ar" style={{fontSize,lineHeight:1.8,direction:"rtl"}}>
      {words.map((w,i)=>{
        const clean=w.replace(/[.,،؟!:؛"]/g,"");
        const cleanS=strip(clean);
        const isHL=hlStripped.some(hw=>hw&&cleanS&&(cleanS===hw||cleanS.includes(hw)||hw.includes(cleanS)));
        return (
          <span key={i}>
            <span className={`ar-word${isHL?" hl":""}`} onClick={(e)=>{e.stopPropagation();onWordClick&&onWordClick(clean,text);}} title="Tap to look up">{w}</span>{" "}
          </span>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// WORD POPUP
// ─────────────────────────────────────────────────────────────
function WordPopup({word,context,decks,cardStates,onClose,onAddToFlashcard,trackUsage}) {
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [addOpen,setAddOpen]=useState(false);
  const [targetDeck,setTargetDeck]=useState(decks[0]?.id||"");
  const [added,setAdded]=useState(false);

  useEffect(()=>{
    if(!word) return;
    let cancelled=false;
    // NOTE: this is a plain bilingual DICTIONARY lookup — deliberately NOT
    // wrapped in BAYNA_YADAYK_STYLE. That style guide is for generating
    // passages ("Modern Standard Arabic only, no colloquial") and, when bolted
    // onto a lookup, made the model REFUSE colloquial words, proper nouns, and
    // anything it judged "outside the register" — i.e. the "this word isn't
    // available" reports even for words Google translates fine.
    const buildPrompt=(force)=>`You are an expert Arabic→English lexicographer. A learner tapped a single word and wants its meaning.

Word tapped: "${word}"
Sentence it appeared in: "${context}"

RULES:
- ALWAYS give your best-effort English meaning. NEVER reply that the word is unavailable, unknown, not found, not a real word, or outside any curriculum/register. Every Arabic string is translatable.
- Handle ANY register: Modern Standard, Classical, Qur'anic, or colloquial/dialect — translate it regardless.
- If the word carries attached prefixes (و=and, ف=so, ب=with/in, ك=like, ل=for, ال=the, س=will) or a suffix pronoun, analyse the core word and translate that.
- If it is a name or place, transliterate it and say so.
- If genuinely uncertain, give the most likely meaning from the root + context and append " (approx.)".${force?`\n- Your previous attempt did NOT give a real translation. You MUST output an actual English meaning now.`:""}

Return ONLY valid JSON, no markdown. Put full tashkeel on Arabic text:
{"word":"${word}","root":"3-letter Arabic root with tashkeel like كَتَبَ, or empty","rootMeaning":"short root meaning or empty","meaning":"English meaning — REQUIRED, must never be empty or a refusal","partOfSpeech":"noun/verb/adjective/particle/proper noun/etc","note":"one short usage tip or empty"}`;
    // Did the model dodge instead of translating?
    const looksLikeRefusal=(m)=>{
      if(!m||!m.trim()) return true;
      return /not? available|unavailable|isn'?t available|not found|cannot? find|can'?t find|\bunknown\b|no (clear |exact )?(meaning|translation)|n\/a|not a (real|standard|valid) word|unable to|outside (the |this )?(register|curriculum|level)/i.test(m);
    };
    (async()=>{
      try {
        let parsed={};
        try {
          const raw=await callClaude(buildPrompt(false),200,"wordLookup",trackUsage,15000);
          parsed=extractJSON(raw);
        } catch(e) { if(e?.message?.includes("timed out")) throw e; }
        // One forceful retry if the model refused or returned no meaning.
        if(looksLikeRefusal(parsed?.meaning)){
          try {
            const raw2=await callClaude(buildPrompt(true),200,"wordLookup",trackUsage,15000);
            const p2=extractJSON(raw2);
            if(p2?.meaning && !looksLikeRefusal(p2.meaning)) parsed=p2;
            else if(p2?.meaning) parsed=p2; // still take whatever it gave over nothing
          } catch {}
        }
        if(cancelled) return;
        // Guard against a parse that succeeded but lacks the meaning field.
        setData({word,root:"",rootMeaning:"",meaning:"",partOfSpeech:"",note:"",...parsed});
      } catch(e) {
        if(cancelled) return;
        setData({word,root:"",rootMeaning:"",meaning:e?.message?.includes("timed out")?"Lookup timed out — tap again to retry":"Couldn't load — tap the word again",partOfSpeech:"",note:""});
      } finally { if(!cancelled) setLoading(false); }
    })();
    return ()=>{cancelled=true;};
  },[word]);

  const doAdd=()=>{
    if(!data||!targetDeck) return;
    const card={id:`c${Date.now()}`,wordType:data.partOfSpeech?.toLowerCase().includes("verb")?"verb":"noun",english:data.meaning,arabicBase:data.word,forms:{singular:data.word},status:"new"};
    onAddToFlashcard(targetDeck,card);
    setAdded(true);
    setTimeout(onClose,1000);
  };

  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="drawer" style={{maxHeight:"78vh",overflowY:"auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
          <div className="ar" style={{fontSize:38,color:"var(--accent)"}}>{word}</div>
          <button className="btn btn-ghost" onClick={onClose} style={{width:32,height:32}}><X size={14}/></button>
        </div>
        {loading ? (
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:10,padding:"16px 0"}}>
            <RefreshCw size={18} className="spin" color="var(--accent)"/>
            <div style={{fontSize:13,color:"var(--text2)",fontWeight:500}}>Looking up root, meaning & usage…</div>
            <div style={{fontSize:11,color:"var(--text3)"}}>Usually 1-2 seconds</div>
          </div>
        ) : (
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {data.root&&(
              <div style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rxs)",padding:"10px 13px"}}>
                <div style={{fontSize:10,fontWeight:700,color:"var(--accent)",letterSpacing:".12em",textTransform:"uppercase",marginBottom:5}}>Root · جذر</div>
                <div className="ar" style={{fontSize:24,color:"var(--accent)",marginBottom:3}}>{data.root}</div>
                {data.rootMeaning&&<div style={{fontSize:13,color:"var(--text2)"}}>{data.rootMeaning}</div>}
              </div>
            )}
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"var(--text3)",letterSpacing:".12em",textTransform:"uppercase",marginBottom:5}}>Meaning</div>
              <div style={{fontSize:16,fontWeight:600,color:"var(--text)"}}>{data.meaning}</div>
              {data.partOfSpeech&&<div style={{fontSize:12,color:"var(--text3)",marginTop:2,textTransform:"capitalize"}}>{data.partOfSpeech}</div>}
            </div>
            {data.note&&<div style={{background:"var(--surface2)",borderRadius:"var(--rxs)",padding:"9px 12px",fontSize:13,color:"var(--text2)",lineHeight:1.65}}>💡 {data.note}</div>}
            <div className="divider" style={{margin:"4px 0"}}/>
            {added ? (
              <div style={{textAlign:"center",padding:"10px 0",color:"var(--know)",fontWeight:600,fontSize:14}}><Check size={16} style={{marginRight:6}}/>Added!</div>
            ) : !addOpen ? (
              <button className="btn btn-primary" onClick={()=>setAddOpen(true)} style={{width:"100%",padding:"12px",borderRadius:"var(--rs)",fontSize:13.5}}><PlusCircle size={14}/> Add to Flashcards</button>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div className="sec" style={{margin:0}}>Add to which deck?</div>
                <select className="input" value={targetDeck} onChange={e=>setTargetDeck(e.target.value)}>
                  {decks.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}
                </select>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn" onClick={()=>setAddOpen(false)} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"11px"}}>Cancel</button>
                  <button className="btn btn-primary" onClick={doAdd} style={{flex:2,padding:"11px",borderRadius:"var(--rs)",fontSize:13.5}}><Check size={14}/> Add Card</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// USAGE METER component
// ─────────────────────────────────────────────────────────────
function UsageMeter({usage, settings, onReset}) {
  const [open,setOpen]=useState(false);
  const [showCalc,setShowCalc]=useState(false);
  // Resolve which text model is being used per usage tag. Per-feature
  // overrides (settings.models[tag]) win; otherwise the global default.
  // All cost numbers, daily projections, and "via X" indicators flow from
  // this single resolver — so changing the dropdowns above instantly
  // re-prices everything.
  const modelForTag=(tag)=>{
    return settings?.models?.[tag] || settings?.model || "openai/gpt-4o-mini";
  };
  const priceForTag=(tag)=>{
    return MODEL_PRICES[modelForTag(tag)] || PRICE_FALLBACK;
  };
  // Display-friendly short model name ("claude-sonnet-4-5" not "anthropic/...").
  const shortModel=(m)=>m?(m.split("/").pop()||m):"—";
  const costForTag=(tag,v)=>{
    const imgModel=TAG_TO_IMAGE_MODEL[tag];
    if(imgModel) return v.calls*(IMAGE_PRICES[imgModel]||0);
    if(tag==="ttsGoogle") return v.inputTokens * TTS_PRICE_PER_CHAR;     // inputTokens = chars
    if(tag==="sttWhisper") return v.inputTokens * STT_PRICE_PER_SECOND;  // inputTokens = seconds
    const p = priceForTag(tag);
    return v.inputTokens*p.in/1_000_000 + v.outputTokens*p.out/1_000_000;
  };
  // Provider label for non-text tags so the user can see where each row's
  // cost flows even without a text model.
  const providerForTag=(tag)=>{
    if(tag==="imageNB1") return "nano banana 1";
    if(tag==="imageNB2") return "nano banana 2";
    if(tag==="ttsGoogle") return "google tts";
    if(tag==="sttWhisper") return "whisper";
    return shortModel(modelForTag(tag));
  };
  // For the header summary, only count tokens from real text tags.
  const totalInputTok  = Object.entries(usage.byTag).filter(([t])=>!NON_TEXT_TAGS.has(t)).reduce((s,[,v])=>s+v.inputTokens,0);
  const totalOutputTok = Object.entries(usage.byTag).filter(([t])=>!NON_TEXT_TAGS.has(t)).reduce((s,[,v])=>s+v.outputTokens,0);
  const totalCost = Object.entries(usage.byTag).reduce((s,[t,v])=>s+costForTag(t,v),0);
  const totalCalls = Object.values(usage.byTag).reduce((s,v)=>s+v.calls,0);

  const barColor = totalCost<0.10?"var(--know)":totalCost<0.50?"#C07000":"var(--weak)";
  const activeModel = settings?.model || "openai/gpt-4o-mini";
  const unitsLabel=(tag,v)=>{
    if(NON_TEXT_TAGS.has(tag)){
      if(tag==="ttsGoogle") return `${v.inputTokens.toLocaleString()} ch`;
      if(tag==="sttWhisper") return `${Math.round(v.inputTokens)}s`;
      return "—";
    }
    return (v.inputTokens+v.outputTokens).toLocaleString();
  };

  // Daily-use calculator presets. inputs / outputs / images / chars / seconds
  // per single action. Adjust to roughly match observed averages.
  const ACTIONS = [
    {key:"flashcards", label:"New flashcards", tag:"flashcard", tokenIn:300, tokenOut:600, perDay:10},
    {key:"sentences",  label:"Sentence aids",  tag:"sentence",  tokenIn:200, tokenOut:300, perDay:10},
    {key:"lookups",    label:"Word lookups",   tag:"wordLookup",tokenIn:80,  tokenOut:120, perDay:15},
    {key:"reading",    label:"Reading passages", tag:"reading", tokenIn:300, tokenOut:1500,perDay:1},
    {key:"listening",  label:"Listening passages",tag:"listening",tokenIn:300,tokenOut:1200,perDay:1},
    {key:"convoTurns", label:"Conversation turns", tag:"other", tokenIn:400, tokenOut:500, perDay:20},
    {key:"islandBatches", label:"Language Island batches", tag:"island", tokenIn:300, tokenOut:900, perDay:3},
    {key:"dictationSets", label:"Dictation sets", tag:"dictation", tokenIn:200, tokenOut:500, perDay:2},
    // Grammar import: one batch ≈ a few pages of notes (text or vision).
    // Occasional-use feature, so the default assumes ~1 batch/day.
    {key:"grammarBatches", label:"Grammar import batches", tag:"grammar", tokenIn:2200, tokenOut:1800, perDay:1},
    {key:"images",     label:"Nano Banana images", tag:"imageNB1", perDay:5},
    {key:"ttsPlays",   label:"TTS plays (~120 ch each, first-time only)", tag:"ttsGoogle", chars:120, perDay:10},
    {key:"sttMinutes", label:"Whisper STT minutes", tag:"sttWhisper", seconds:60, perDay:5},
  ];
  const [counts,setCounts]=useState(()=>Object.fromEntries(ACTIONS.map(a=>[a.key,a.perDay])));
  const calcOne = (a)=>{
    const n = counts[a.key] || 0;
    if(a.tag==="imageNB1") return n*(IMAGE_PRICES["gemini-2.5-flash-image"]||0.039);
    if(a.tag==="ttsGoogle") return n*(a.chars||120)*TTS_PRICE_PER_CHAR;
    if(a.tag==="sttWhisper") return n*(a.seconds||60)*STT_PRICE_PER_SECOND;
    const p=priceForTag(a.tag);
    return n*(a.tokenIn*p.in + a.tokenOut*p.out)/1_000_000;
  };
  const dailyTotal = ACTIONS.reduce((s,a)=>s+calcOne(a),0);

  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}} onClick={()=>setOpen(v=>!v)}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <DollarSign size={15} color={barColor}/>
          <div>
            <div className="sec" style={{margin:0,color:barColor}}>AI Credit Usage</div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--text)",marginTop:1}}>
              ~${totalCost.toFixed(4)}
              <span style={{fontSize:11,fontWeight:400,color:"var(--text3)",marginLeft:6}}>{totalCalls} calls · priced for {activeModel.split("/").pop()}</span>
            </div>
          </div>
        </div>
        {open?<ChevronUp size={15} color="var(--text3)"/>:<ChevronDown size={15} color="var(--text3)"/>}
      </div>

      {open&&(
        <div style={{borderTop:"1px solid var(--border)",padding:"12px 16px",display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:4,display:"grid",gridTemplateColumns:"1.3fr 50px 60px 60px 60px",gap:4}}>
            <span>Feature</span><span style={{textAlign:"right"}}>Calls</span><span style={{textAlign:"right"}}>Units</span><span style={{textAlign:"right"}}>Avg</span><span style={{textAlign:"right"}}>Cost</span>
          </div>
          {Object.entries(usage.byTag).filter(([t,v])=>v.calls>0 || t==="sttWhisper" || t==="ttsGoogle").map(([tag,v])=>{
            const cost = costForTag(tag,v);
            const avg = v.calls>0 ? cost/v.calls : 0;
            const isTextTag = !NON_TEXT_TAGS.has(tag);
            const overridden = isTextTag && !!settings?.models?.[tag];
            return (
              <div key={tag} style={{display:"grid",gridTemplateColumns:"1.3fr 50px 60px 60px 60px",gap:4,fontSize:12.5,color:"var(--text2)",alignItems:"center"}}>
                <div style={{minWidth:0}}>
                  <div style={{color:"var(--text)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{USAGE_LABELS[tag]||tag}</div>
                  <div style={{fontSize:10,color:overridden?"var(--accent)":"var(--text3)",fontFamily:"monospace",marginTop:1}}>
                    via {providerForTag(tag)}{overridden?" (override)":""}
                  </div>
                </div>
                <span style={{textAlign:"right",color:"var(--text3)"}}>{v.calls}</span>
                <span style={{textAlign:"right",color:"var(--text3)"}}>{unitsLabel(tag,v)}</span>
                <span style={{textAlign:"right",color:"var(--text3)",fontSize:11.5,fontFamily:"monospace"}}>${avg<0.01?avg.toFixed(4):avg.toFixed(3)}</span>
                <span style={{textAlign:"right",fontWeight:600,color:"var(--accent)"}}>${cost.toFixed(4)}</span>
              </div>
            );
          })}
          <div className="divider" style={{margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700}}>
            <span>Total (est.)</span>
            <span style={{color:barColor}}>${totalCost.toFixed(4)}</span>
          </div>

          {/* Tracking window + reset */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11.5,color:"var(--text3)",marginTop:2}}>
            <span>
              Tracking since {usage.trackingSince
                ? new Date(usage.trackingSince).toLocaleDateString(undefined,{month:"short",day:"numeric"}) + ", " + new Date(usage.trackingSince).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})
                : "first call"}
            </span>
            {onReset&&(
              <button onClick={onReset} style={{background:"transparent",border:"none",color:"var(--weak)",fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 8px",borderRadius:"var(--rxs)"}}>
                ⟲ Reset counters
              </button>
            )}
          </div>

          {/* Provider billing block */}
          <div style={{marginTop:6,padding:"10px 12px",background:"var(--info-bg)",border:"1px solid var(--info-border)",borderRadius:"var(--rxs)"}}>
            <div style={{fontSize:11,fontWeight:700,color:"var(--info)",letterSpacing:".08em",textTransform:"uppercase",marginBottom:6}}>Where you're billed</div>
            <div style={{display:"flex",flexDirection:"column",gap:4,fontSize:12,color:"var(--text2)"}}>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Text generation</span><a href="https://openrouter.ai/credits" target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",fontWeight:600}}>OpenRouter →</a></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Nano Banana images</span><a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",fontWeight:600}}>Google AI Studio →</a></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Google TTS voice</span><a href="https://console.cloud.google.com/billing" target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",fontWeight:600}}>Google Cloud →</a></div>
              <div style={{display:"flex",justifyContent:"space-between"}}><span>Whisper STT</span><a href="https://platform.openai.com/usage" target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",fontWeight:600}}>OpenAI →</a></div>
            </div>
          </div>

          {/* Daily-use calculator */}
          <div style={{marginTop:4,border:"1px solid var(--border)",borderRadius:"var(--rxs)",overflow:"hidden"}}>
            <div onClick={()=>setShowCalc(v=>!v)} style={{padding:"10px 12px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",background:"var(--surface2)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>
                💡 Daily-use calculator
                <span style={{fontSize:11,fontWeight:400,color:"var(--text3)",marginLeft:8}}>~${dailyTotal.toFixed(3)}/day · ~${(dailyTotal*30).toFixed(2)}/month</span>
              </div>
              {showCalc?<ChevronUp size={13} color="var(--text3)"/>:<ChevronDown size={13} color="var(--text3)"/>}
            </div>
            {showCalc&&(
              <div style={{padding:"10px 12px",display:"flex",flexDirection:"column",gap:6}}>
                {ACTIONS.map(a=>{
                  const isTextTag = !NON_TEXT_TAGS.has(a.tag);
                  const overridden = isTextTag && !!settings?.models?.[a.tag];
                  return (
                    <div key={a.key} style={{display:"grid",gridTemplateColumns:"1fr 60px 70px",gap:6,fontSize:12,alignItems:"center"}}>
                      <div style={{minWidth:0}}>
                        <div style={{color:"var(--text2)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{a.label}</div>
                        <div style={{fontSize:10,color:overridden?"var(--accent)":"var(--text3)",fontFamily:"monospace",marginTop:1}}>
                          via {providerForTag(a.tag)}{overridden?" (override)":""}
                        </div>
                      </div>
                      <input type="number" min="0" step="1" value={counts[a.key]} onChange={e=>setCounts(p=>({...p,[a.key]:Math.max(0,parseInt(e.target.value||"0",10))}))}
                        style={{padding:"4px 6px",fontSize:12,border:"1px solid var(--border)",borderRadius:4,background:"var(--surface)",textAlign:"right",fontFamily:"monospace"}}/>
                      <span style={{textAlign:"right",fontWeight:600,color:"var(--accent)",fontFamily:"monospace"}}>${calcOne(a).toFixed(4)}</span>
                    </div>
                  );
                })}
                <div className="divider" style={{margin:"4px 0"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,fontWeight:700}}>
                  <span>Daily total</span><span style={{color:"var(--accent)"}}>${dailyTotal.toFixed(3)}</span>
                </div>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12.5,fontWeight:700}}>
                  <span>Monthly (×30)</span><span style={{color:"var(--accent)"}}>${(dailyTotal*30).toFixed(2)}</span>
                </div>
                <div style={{fontSize:10.5,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>
                  Each row is priced by the model assigned to that feature (default: <span style={{fontFamily:"monospace",color:"var(--text2)"}}>{activeModel.split("/").pop()}</span>). Change a per-feature dropdown higher up to see the impact ripple through here in real time — no save needed.
                </div>
              </div>
            )}
          </div>

          <div style={{fontSize:11,color:"var(--text3)",lineHeight:1.6}}>
            Text cost uses your selected model's OpenRouter pricing. Image: $0.039 (NB1) / $0.067 (NB2 at 1K). TTS: $16/1M chars (Google Wavenet, cached after first play). STT: $0.006/min (OpenAI Whisper). Verify at openrouter.ai/models, ai.google.dev/pricing, cloud.google.com/text-to-speech/pricing, openai.com/api/pricing.
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HOME
// ─────────────────────────────────────────────────────────────
// "3 days ago" / "Today" / "Never studied" — used on deck cards + rotation sort.
function daysAgoLabel(ts){
  if(!ts) return "Never studied";
  const days=Math.floor((Date.now()-ts)/86400000);
  if(days<=0) return "Studied today";
  if(days===1) return "Studied yesterday";
  return `Studied ${days}d ago`;
}

// Shared deck-card renderer for the Home lists (vocab + grammar sections).
// Shows weak/known/new pills so untouched cards are visible at a glance.
function renderDeckCard(deck,cardStates,onOpenDeck,isGrammar=false){
  const dc=cardStates[deck.id]||[];
  const weak=dc.filter(c=>c.status==="weak").length;
  const known=dc.filter(c=>c.status==="known").length;
  const newC=dc.length-weak-known;
  const pct=dc.length>0?Math.round((known/dc.length)*100):0;
  return (
    <button key={deck.id} className="btn" onClick={()=>onOpenDeck(deck)}
      style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px",textAlign:"left",width:"100%",flexDirection:"column",alignItems:"stretch",gap:8}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <span style={{fontWeight:600,fontSize:15,color:"var(--text)",display:"flex",alignItems:"center",gap:6}}>
          {isGrammar&&<span className="ar" style={{fontSize:13,color:"var(--harf)",background:"var(--harf-bg)",border:"1px solid var(--harf-border)",borderRadius:100,padding:"1px 8px"}}>قواعد</span>}
          {deck.title}
        </span>
        <ChevronRight size={15} color="var(--text3)"/>
      </div>
      <div style={{display:"flex",gap:7,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:12.5,color:"var(--text3)"}}>{dc.length} cards</span>
        {weak>0&&<span className="tag tag-weak">{weak} weak</span>}
        {known>0&&<span className="tag tag-know">{known} known</span>}
        {newC>0&&<span style={{fontSize:11,fontWeight:600,color:"var(--text3)",background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:100,padding:"2px 9px"}}>{newC} new</span>}
        {!isGrammar&&<span style={{fontSize:11,color:"var(--text3)",marginLeft:"auto"}}>{daysAgoLabel(deck.lastStudiedAt)}</span>}
      </div>
      <div className="progress-track"><div className="progress-fill" style={{width:`${pct}%`,background:"var(--know)"}}/></div>
    </button>
  );
}

function HomeScreen({decks,cardStates,onOpenDeck,onSettings,onCreateDeck,onReading,onListening,onConversation,onDictation,onCapsules,onSearch,onProgress,onMasterReview,onGuide,onPresets,onGrammarImport,onVocabImport,darkMode,onToggleDark,studyLog}) {
  const [deckSort,setDeckSort]=useState(()=>localStorage.getItem("arabic_fc_deck_sort")||"newest");
  useEffect(()=>{localStorage.setItem("arabic_fc_deck_sort",deckSort);},[deckSort]);
  const sortDecks=(arr)=>{
    const copy=[...arr];
    if(deckSort==="oldest") return copy.sort((a,b)=>a.createdAt-b.createdAt);
    if(deckSort==="az") return copy.sort((a,b)=>a.title.localeCompare(b.title));
    if(deckSort==="stale") return copy.sort((a,b)=>(a.lastStudiedAt||0)-(b.lastStudiedAt||0)); // never-studied first
    return copy.sort((a,b)=>b.createdAt-a.createdAt); // newest first (default)
  };
  const vocabDecks=sortDecks(decks.filter(d=>d.deckType!=="grammar"));
  const grammarDecks=sortDecks(decks.filter(d=>d.deckType==="grammar"));
  const importRef=useRef(null);
  const handleImport=(e)=>{
    const file=e.target.files?.[0];
    if(!file) return;
    const reader=new FileReader();
    reader.onload=(ev)=>{
      try {
        const data=JSON.parse(ev.target.result);
        if(data.deck&&data.cards){
          const newDeckId=`d${Date.now()}`;
          const newCards=data.cards.map((c,i)=>({...c,id:`c${Date.now()+i+1}`}));
          window.dispatchEvent(new CustomEvent("importDeck",{detail:{deck:{...data.deck,id:newDeckId,createdAt:Date.now()},cards:newCards}}));
          showToast(`Imported "${data.deck.title}" with ${newCards.length} cards`,"success");
        } else { showToast("Invalid deck file format","error"); }
      } catch { showToast("Failed to parse file","error"); }
    };
    reader.readAsText(file);
    e.target.value="";
  };

  // Dashboard stats — vocab and grammar counted separately so a mastered
  // grammar deck doesn't inflate the vocabulary "known" number.
  const vocabCardStates=Object.fromEntries(vocabDecks.map(d=>[d.id,cardStates[d.id]||[]]));
  const vocabCards=Object.values(vocabCardStates).flat();
  const totalCards=vocabCards.length;
  const knownCount=vocabCards.filter(c=>c.status==="known").length;
  const weakCount=vocabCards.filter(c=>c.status==="weak").length;
  const newCount=vocabCards.filter(c=>c.status==="new"||!c.status).length;
  const totalInstances=countWordInstances(vocabCardStates);
  const dueCount=getDueCount(vocabCards);

  const grammarCards=grammarDecks.flatMap(d=>cardStates[d.id]||[]);
  const grammarKnown=grammarCards.filter(c=>c.status==="known").length;
  const grammarWeak=grammarCards.filter(c=>c.status==="weak").length;
  const grammarNew=grammarCards.filter(c=>c.status==="new"||!c.status).length;

  return (
    <div className="screen">
      <div style={{padding:"26px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div>
          <div className="sec" style={{margin:0,marginBottom:4}}>Arabic Study</div>
          <div style={{fontFamily:"Lora,serif",fontSize:26,fontWeight:600}}>My Decks</div>
          <div className="ar" style={{fontSize:15,color:"var(--text3)",marginTop:4}}>بِسْمِ اللهِ</div>
        </div>
        <div style={{display:"flex",gap:6}}>
          <button className="btn btn-ghost" onClick={onSearch} style={{width:36,height:36}} title="Search all cards"><Search size={16}/></button>
          <button className="btn btn-ghost" onClick={onGuide} style={{width:36,height:36}} title="Help & tips"><HelpCircle size={17}/></button>
          <button className="btn btn-ghost" onClick={onToggleDark} style={{width:36,height:36}} title={darkMode?"Light mode":"Dark mode"}>{darkMode?<Sun size={16}/>:<Moon size={16}/>}</button>
          <button className="btn btn-ghost" onClick={onSettings} style={{width:36,height:36}}><Settings size={17}/></button>
        </div>
      </div>

      <div style={{padding:"14px 20px 0"}}>
        <TipBanner id="home-welcome" title="New here? Start with the basics">
          Create a deck and add words, then tap <b>Master Review</b> to study. The practice modules and <b>Immersion Capsules</b> use your own vocabulary. Tap the <b>?</b> up top anytime for a full guide.
        </TipBanner>
      </div>

      {/* Dashboard Stats */}
      {totalCards>0&&(
        <div style={{padding:"16px 20px 0"}}>
          <div style={{display:"flex",gap:8,marginBottom:8}}>
            <div className="stat-card"><div className="stat-num" style={{color:"var(--text)"}}>{totalCards}</div><div className="stat-label">Cards</div></div>
            <div className="stat-card"><div className="stat-num" style={{color:"var(--know)"}}>{knownCount}</div><div className="stat-label">Known</div></div>
            <div className="stat-card"><div className="stat-num" style={{color:"var(--weak)"}}>{weakCount}</div><div className="stat-label">Weak</div></div>
            <div className="stat-card"><div className="stat-num" style={{color:"var(--text3)"}}>{newCount}</div><div className="stat-label">New</div></div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <div className="stat-card" style={{display:"flex",alignItems:"center",gap:8,textAlign:"left"}}>
              <Hash size={14} color="var(--accent)"/>
              <div><div style={{fontSize:14,fontWeight:700,color:"var(--accent)"}}>{totalInstances}</div><div className="stat-label" style={{marginTop:1}}>Word instances</div></div>
            </div>
            {dueCount>0&&(
              <div className="stat-card" style={{display:"flex",alignItems:"center",gap:8,textAlign:"left",borderColor:"var(--info-border)",background:"var(--info-bg)"}}>
                <Clock size={14} color="var(--info)"/>
                <div><div style={{fontSize:14,fontWeight:700,color:"var(--info)"}}>{dueCount}</div><div className="stat-label" style={{marginTop:1,color:"var(--info)"}}>Due now</div></div>
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{padding:"16px 20px 0"}}>
        {/* Master Review — prominent */}
        {totalCards>0&&(
          <div style={{marginBottom:16}}>
            <button className="btn btn-primary" onClick={onMasterReview} style={{width:"100%",padding:"16px",borderRadius:"var(--r)",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
              <BookOpen size={18}/> Master Review
              <span style={{fontSize:12,opacity:.8,marginLeft:4}}>
                {dueCount>0?`${dueCount} due`:weakCount>0?`${weakCount} weak`:`${totalCards} cards`}
              </span>
            </button>
          </div>
        )}

        <div className="sec">Practice Modules</div>
        <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:22}}>
          <div className="module-card" style={{borderColor:"var(--read-border)",background:"var(--read-bg)"}} onClick={onReading}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--read)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><FileText size={19} color="white"/></div>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14.5,color:"var(--read)"}}>Reading</div><div style={{fontSize:12.5,color:"var(--text2)",marginTop:2}}>AI passages from your flashcard vocabulary</div></div>
            <ChevronRight size={15} color="var(--read)"/>
          </div>
          <div className="module-card" style={{borderColor:"var(--listen-border)",background:"var(--listen-bg)"}} onClick={onListening}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--listen)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Headphones size={19} color="white"/></div>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14.5,color:"var(--listen)"}}>Listening</div><div style={{fontSize:12.5,color:"var(--text2)",marginTop:2}}>Audio practice from your vocabulary</div></div>
            <ChevronRight size={15} color="var(--listen)"/>
          </div>
          <div className="module-card" style={{borderColor:"var(--accent-border)",background:"var(--accent-bg)"}} onClick={onConversation}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><MessageCircle size={19} color="white"/></div>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14.5,color:"var(--accent)"}}>Conversation</div><div style={{fontSize:12.5,color:"var(--text2)",marginTop:2}}>AI chat practice using your vocabulary</div></div>
            <ChevronRight size={15} color="var(--accent)"/>
          </div>
          <div className="module-card" style={{borderColor:"#0F766E55",background:"#0F766E12"}} onClick={onDictation}>
            <div style={{width:40,height:40,borderRadius:12,background:"#0F766E",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><PenLine size={19} color="white"/></div>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14.5,color:"#0F766E"}}>Dictation</div><div style={{fontSize:12.5,color:"var(--text2)",marginTop:2}}>Listen & write — with word-by-word correction</div></div>
            <ChevronRight size={15} color="#0F766E"/>
          </div>
          <div className="module-card" style={{borderColor:"var(--info-border)",background:"var(--info-bg)"}} onClick={onCapsules}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--info)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Globe size={19} color="white"/></div>
            <div style={{flex:1}}><div style={{fontWeight:700,fontSize:14.5,color:"var(--info)"}}>Immersion Capsules</div><div style={{fontSize:12.5,color:"var(--text2)",marginTop:2}}>Language Island &amp; more — long-form immersion</div></div>
            <ChevronRight size={15} color="var(--info)"/>
          </div>
          <div className="module-card" style={{borderColor:"var(--border)"}} onClick={onProgress}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--surface2)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><BarChart3 size={19} color="var(--text2)"/></div>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14.5}}>Progress & Analytics</div>
              <div style={{fontSize:12.5,color:"var(--text2)",marginTop:2}}>Performance scores, study time, B2 tracking</div>
            </div>
            {studyLog&&(()=>{const t=sumMinutes(getEntriesForDate(studyLog,TODAY_KEY()));return t>0?<span style={{fontSize:12,color:"var(--know)",fontWeight:700}}>{t}m today</span>:null;})()}
            <ChevronRight size={15} color="var(--text3)"/>
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div className="sec" style={{margin:0}}>Flashcard Decks</div>
          <div style={{display:"flex",gap:4}}>
            {[["newest","Newest"],["oldest","Oldest"],["az","A–Z"],["stale","Stalest"]].map(([val,label])=>(
              <button key={val} onClick={()=>setDeckSort(val)} className={`chip ${deckSort===val?"chip-on":""}`} style={{padding:"3px 9px",fontSize:11}}>{label}</button>
            ))}
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <button className="btn btn-primary" onClick={onCreateDeck} style={{flex:1,padding:"13px",borderRadius:"var(--r)",fontSize:14}}>
            <Plus size={15}/> Create New Deck
          </button>
          <button className="btn" onClick={()=>importRef.current?.click()} style={{padding:"13px 16px",borderRadius:"var(--r)",fontSize:14,background:"var(--surface)",border:"1.5px solid var(--border)",color:"var(--text2)",fontWeight:600}}>
            <Upload size={14}/>
          </button>
          <input ref={importRef} type="file" accept=".json" onChange={handleImport} style={{display:"none"}}/>
        </div>
        <button className="btn" onClick={onPresets} style={{width:"100%",marginBottom:12,padding:"12px",borderRadius:"var(--r)",fontSize:13.5,background:"var(--accent-bg)",border:"1.5px solid var(--accent-border)",color:"var(--accent)",fontWeight:600,gap:7}}>
          <Download size={14}/> Browse preset decks
        </button>
        <button className="btn" onClick={onVocabImport} style={{width:"100%",marginBottom:12,padding:"12px",borderRadius:"var(--r)",fontSize:13.5,background:"var(--know-bg)",border:"1.5px solid var(--know-border)",color:"var(--know)",fontWeight:600,gap:7}}>
          <Upload size={14}/> Import vocabulary (screenshots / PDF)
        </button>
        {vocabDecks.length===0&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:14,padding:"36px 0"}}><Layers size={28} style={{opacity:.3,marginBottom:8}}/><br/>No decks yet — create one, download a preset, or import vocabulary above.</div>}
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {vocabDecks.map(deck=>renderDeckCard(deck,cardStates,onOpenDeck))}
        </div>

        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:22,marginBottom:10}}>
          <div className="sec" style={{margin:0}}>Grammar</div>
          {grammarCards.length>0&&<div style={{fontSize:11,color:"var(--text3)"}}>{grammarKnown} known · {grammarWeak} weak · {grammarNew} new</div>}
        </div>
        <button className="btn" onClick={onGrammarImport} style={{width:"100%",marginBottom:12,padding:"13px",borderRadius:"var(--r)",fontSize:13.5,background:"var(--harf-bg)",border:"1.5px solid var(--harf-border)",color:"var(--harf)",fontWeight:600,gap:7}}>
          <Upload size={14}/> Import grammar notes (PDF / images / text)
        </button>
        {grammarDecks.length===0&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:13,padding:"10px 0 20px"}}>Dump in your grammar notes — I'll turn them into concept flashcards.</div>}
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {grammarDecks.map(deck=>renderDeckCard(deck,cardStates,onOpenDeck,true))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────
function LoginScreen({onLogin,loading,error}) {
  return (
    <div className="screen" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",padding:28,textAlign:"center"}}>
      <div className="pop-appear" style={{width:"100%",maxWidth:360}}>
        <div style={{fontSize:48,marginBottom:16}}>🗂️</div>
        <div style={{fontFamily:"Lora,serif",fontSize:26,fontWeight:600,marginBottom:8}}>Arabic Flashcards</div>
        <div style={{fontSize:14,color:"var(--text2)",marginBottom:36,lineHeight:1.6}}>Sign in to save your decks, cards, and progress across all your devices.</div>
        {error&&<div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rxs)",padding:"10px 13px",fontSize:13,color:"var(--weak)",marginBottom:16}}>{error}</div>}
        <button
          className="btn btn-primary"
          onClick={onLogin}
          disabled={loading}
          style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center",gap:10}}>
          {loading
            ? <><RefreshCw size={16} className="spin"/>Signing in…</>
            : <><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.02 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.52-13.47-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/><path fill="none" d="M0 0h48v48H0z"/></svg>Continue with Google</>}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// CARD CLEANUP TOOL — audit every form on every card, scope by deck
// ─────────────────────────────────────────────────────────────
const CLEANUP_OPTIONAL_EXTRAS=new Set(["plural2","synonym","synonymPlural","antonym","antonymPlural"]);

function CardCleanupTool({decks,cardStates,setCardStates,trackUsage}) {
  const [phase,setPhase]=useState("idle"); // idle | scanning | review | done
  const [progress,setProgress]=useState({current:0,total:0});
  const [proposals,setProposals]=useState([]);
  const [error,setError]=useState("");
  const [selectedDecks,setSelectedDecks]=useState(()=>new Set(decks.map(d=>d.id)));

  const toggleCleanupDeck=id=>setSelectedDecks(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);return n;});
  const selectAllDecks=()=>setSelectedDecks(new Set(decks.map(d=>d.id)));
  const clearAllDecks=()=>setSelectedDecks(new Set());

  const candidates=(()=>{
    const out=[];
    for(const deck of decks){
      if(!selectedDecks.has(deck.id)) continue;
      for(const card of (cardStates[deck.id]||[])){
        // Audit every form present on the card — core + optional + verb conjugations
        const present=Object.keys(card.forms||{}).filter(k=>card.forms[k]);
        if(present.length) out.push({card,deckId:deck.id,formsToCheck:present});
      }
    }
    return out;
  })();

  const startScan=async()=>{
    setError("");setProposals([]);setPhase("scanning");
    setProgress({current:0,total:candidates.length});
    const all=[];
    const BATCH=3;
    for(let i=0;i<candidates.length;i+=BATCH){
      const batch=candidates.slice(i,i+BATCH);
      const cardsBlock=batch.map(({card,formsToCheck})=>{
        const formsText=formsToCheck.map(f=>`  ${f}: "${card.forms[f]}"`).join("\n");
        return `Card id="${card.id}" english="${card.english}" arabic="${card.arabicBase}" type=${card.wordType}\n${formsText}`;
      }).join("\n\n");

      const prompt=`You are auditing flashcards for an Arabic language learner (B2 level). For each form on each card, decide:
- "keep" — the form is correct, common, and pedagogically valuable
- "drop" — rare, archaic, redundant, technical, or low-value (be conservative; do NOT drop unless clearly low-value)
- "replace" — the form is wrong, has a typo, or is non-standard; provide the most common correct form

Rules:
- BE CONSERVATIVE. Default to "keep" unless there is a clear, specific issue. Do not "fix" forms that are merely stylistic preferences.
- "replace" is allowed for ANY form on ANY word type — but only when there's a real correctness issue (typo, wrong conjugation, non-standard inflection, missing tashkeel, etc.).
- "drop" is only for OPTIONAL forms (plural2, synonym, synonymPlural, antonym, antonymPlural) when they are rare/archaic/low-value. NEVER drop core forms (singular, plural, masculine, feminine, past, present, future, imperative, masdar, activePart, passivePart, harf) — for those, "keep" or "replace" only.
- Replacement values MUST have full tashkeel.

Cards:
${cardsBlock}

Return ONLY a valid JSON array, one object per card, in the same order:
[{"id":"<card-id>","decisions":{"<formKey>":{"action":"keep"} | {"action":"drop"} | {"action":"replace","value":"الكلمة المصححة بتشكيل كامل"}}}]

CRITICAL: Every Arabic word in any "value" field MUST have full tashkeel.`;

      try {
        const raw=await callClaudeWithTashkeel(prompt,1800,"regen",trackUsage);
        const parsed=extractJSON(raw);
        const arr=Array.isArray(parsed)?parsed:[parsed];
        for(const entry of arr){
          const cand=batch.find(c=>c.card.id===entry.id);
          if(!cand) continue;
          all.push({
            cardId:cand.card.id,
            deckId:cand.deckId,
            english:cand.card.english,
            arabicBase:cand.card.arabicBase,
            wordType:cand.card.wordType,
            currentForms:{...cand.card.forms},
            decisions:entry.decisions||{},
          });
        }
      } catch(e){
        console.error("Cleanup batch failed:",e);
      }
      setProgress({current:Math.min(i+BATCH,candidates.length),total:candidates.length});
    }
    const changed=all.filter(p=>Object.values(p.decisions||{}).some(d=>d.action==="drop"||d.action==="replace"));
    setProposals(changed);
    setPhase(changed.length?"review":"done");
  };

  const apply=()=>{
    setCardStates(prev=>{
      const next={...prev};
      for(const p of proposals){
        const list=next[p.deckId]||[];
        next[p.deckId]=list.map(c=>{
          if(c.id!==p.cardId) return c;
          const newForms={...c.forms};
          for(const [k,d] of Object.entries(p.decisions)){
            if(d.action==="drop") delete newForms[k];
            else if(d.action==="replace"&&d.value) newForms[k]=d.value;
          }
          return {...c,forms:newForms};
        });
      }
      return next;
    });
    showToast(`Updated ${proposals.length} card${proposals.length===1?"":"s"}`,"success");
    setPhase("done");
  };

  const reset=()=>{setPhase("idle");setProposals([]);setProgress({current:0,total:0});setError("");};

  const stats=(()=>{
    let drops=0,replaces=0;
    for(const p of proposals) for(const d of Object.values(p.decisions||{})){
      if(d.action==="drop") drops++; else if(d.action==="replace") replaces++;
    }
    return {drops,replaces};
  })();

  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
      <div className="sec">Card Cleanup</div>
      <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:10}}>
        Audit your existing cards. Strips weak/archaic optional forms (plural2, synonyms, antonyms). For verbs, also corrects wrong conjugations. Uses your OpenRouter key.
      </div>

      {phase==="idle"&&(
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
              <div style={{fontSize:11.5,fontWeight:700,color:"var(--text3)",letterSpacing:".08em",textTransform:"uppercase"}}>Decks to audit ({selectedDecks.size}/{decks.length})</div>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-sm" onClick={selectAllDecks} disabled={selectedDecks.size===decks.length} style={{background:"var(--accent-bg)",color:"var(--accent)",border:"1px solid var(--accent-border)",padding:"3px 8px",fontSize:11,opacity:selectedDecks.size===decks.length?0.5:1}}>All</button>
                <button className="btn btn-sm" onClick={clearAllDecks} disabled={selectedDecks.size===0} style={{background:"var(--surface2)",color:"var(--text2)",padding:"3px 8px",fontSize:11,opacity:selectedDecks.size===0?0.5:1}}>Clear</button>
              </div>
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:5,maxHeight:160,overflowY:"auto",padding:"4px 0"}}>
              {decks.map(d=>{
                const on=selectedDecks.has(d.id);
                const count=(cardStates[d.id]||[]).length;
                return (
                  <button key={d.id} className={`chip ${on?"chip-on":""}`} onClick={()=>toggleCleanupDeck(d.id)} style={{fontSize:11.5,padding:"4px 9px"}}>
                    {d.title} <span style={{opacity:.7}}>· {count}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <button className="btn btn-primary" onClick={startScan} disabled={!candidates.length}
            style={{width:"100%",padding:12,borderRadius:"var(--rs)",fontSize:13,opacity:candidates.length?1:0.5}}>
            <Sparkles size={14}/> Scan {candidates.length} card{candidates.length===1?"":"s"}
          </button>
        </div>
      )}

      {phase==="scanning"&&(
        <div style={{textAlign:"center",padding:"14px 0",color:"var(--text2)",fontSize:13}}>
          <RefreshCw size={14} className="spin" style={{marginRight:8,verticalAlign:"middle"}}/>
          Reviewing card {progress.current} of {progress.total}…
        </div>
      )}

      {phase==="review"&&(
        <div>
          <div style={{background:"var(--info-bg)",border:"1px solid var(--info-border)",borderRadius:"var(--rs)",padding:"10px 12px",marginBottom:10,fontSize:13}}>
            <strong>{proposals.length}</strong> card{proposals.length===1?"":"s"} flagged · <strong>{stats.drops}</strong> drop{stats.drops===1?"":"s"} · <strong>{stats.replaces}</strong> correction{stats.replaces===1?"":"s"}
          </div>
          <div style={{maxHeight:340,overflowY:"auto",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"8px 10px",marginBottom:10}}>
            {proposals.map(p=>(
              <div key={p.cardId} style={{padding:"8px 0",borderBottom:"1px solid var(--border)"}}>
                <div style={{fontWeight:600,fontSize:13}}>{p.english} <span className="ar" style={{color:"var(--accent)"}}>· {p.arabicBase}</span></div>
                <div style={{display:"flex",flexDirection:"column",gap:3,marginTop:4}}>
                  {Object.entries(p.decisions).filter(([,d])=>d.action!=="keep").map(([k,d])=>(
                    <div key={k} style={{fontSize:12,color:"var(--text3)"}}>
                      <span style={{display:"inline-block",minWidth:90,fontWeight:500,color:"var(--text2)"}}>{FORM_LABELS[k]||k}:</span>
                      <span className="ar" style={{textDecoration:d.action==="drop"?"line-through":"none",opacity:0.7}}> {p.currentForms[k]}</span>
                      {d.action==="drop"&&<span style={{color:"var(--weak)",marginRight:5}}> ✗ drop</span>}
                      {d.action==="replace"&&<span style={{color:"var(--know)",marginRight:5}}> → <span className="ar">{d.value}</span> ✏ correct</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn" onClick={reset} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"10px",borderRadius:"var(--rs)",fontSize:13}}>Cancel</button>
            <button className="btn btn-primary" onClick={apply} style={{flex:2,padding:"10px",borderRadius:"var(--rs)",fontSize:13}}>
              <Check size={14}/> Apply All
            </button>
          </div>
        </div>
      )}

      {phase==="done"&&(
        <div style={{background:"var(--know-bg)",border:"1px solid var(--know-border)",borderRadius:"var(--rs)",padding:"12px",fontSize:13,color:"var(--know)",textAlign:"center"}}>
          {proposals.length===0?"All cards look good — no changes needed.":`Applied changes to ${proposals.length} card${proposals.length===1?"":"s"}.`}
          <div style={{marginTop:8}}>
            <button className="btn btn-ghost" onClick={reset} style={{fontSize:12,color:"var(--text3)"}}>Run again</button>
          </div>
        </div>
      )}

      {error&&<div style={{color:"var(--weak)",fontSize:12,marginTop:8}}>{error}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DUPLICATE FINDER — exact-match dedup across all decks
// ─────────────────────────────────────────────────────────────
function stripTashkeel(s){return (s||"").replace(/[ً-ْٰ]/g,"");}

function findDuplicateGroups(decks,cardStates){
  const buckets=new Map(); // key -> [{card, deckId, deckTitle}]
  for(const deck of decks){
    for(const card of (cardStates[deck.id]||[])){
      const ar=stripTashkeel(card.arabicBase||"").trim();
      const en=(card.english||"").trim().toLowerCase();
      if(!ar&&!en) continue;
      const key=`${ar}|${en}`;
      if(!buckets.has(key)) buckets.set(key,[]);
      buckets.get(key).push({card,deckId:deck.id,deckTitle:deck.title});
    }
  }
  // Only groups with >1 entry are duplicates
  const groups=[];
  for(const [key,entries] of buckets){
    if(entries.length>1) groups.push({key,entries});
  }
  return groups;
}

function scoreCardForKeep(card){
  const statusPts=card.status==="known"?300:card.status==="weak"?200:100;
  const formsPts=Object.values(card.forms||{}).filter(Boolean).length*5;
  const srsPts=card.srsLastReview?20:0;
  const streakPts=(card.srsStreak||0)*3;
  return statusPts+formsPts+srsPts+streakPts;
}

function DuplicateFinder({decks,cardStates,setCardStates}) {
  const [phase,setPhase]=useState("idle"); // idle | review | done
  const [keepIds,setKeepIds]=useState({}); // groupKey -> cardId to keep

  const groups=phase==="idle"?[]:findDuplicateGroups(decks,cardStates);
  const totalDuplicates=groups.reduce((s,g)=>s+g.entries.length-1,0);

  const startScan=()=>{
    const found=findDuplicateGroups(decks,cardStates);
    if(!found.length){setPhase("done");return;}
    // Default: keep the highest-scored card per group
    const defaults={};
    for(const g of found){
      const winner=[...g.entries].sort((a,b)=>scoreCardForKeep(b.card)-scoreCardForKeep(a.card))[0];
      defaults[g.key]=winner.card.id;
    }
    setKeepIds(defaults);
    setPhase("review");
  };

  const apply=()=>{
    setCardStates(prev=>{
      const next={...prev};
      for(const g of groups){
        const keep=keepIds[g.key];
        for(const e of g.entries){
          if(e.card.id===keep) continue;
          next[e.deckId]=(next[e.deckId]||[]).filter(c=>c.id!==e.card.id);
        }
      }
      return next;
    });
    showToast(`Removed ${totalDuplicates} duplicate${totalDuplicates===1?"":"s"}`,"success");
    setPhase("done");
  };

  const reset=()=>{setPhase("idle");setKeepIds({});};

  // Initial scan count for the idle button
  const initialGroups=findDuplicateGroups(decks,cardStates);
  const initialDupes=initialGroups.reduce((s,g)=>s+g.entries.length-1,0);

  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
      <div className="sec">Duplicate Finder</div>
      <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:10}}>
        Finds cards with the same Arabic word and English meaning across all decks. Picks the most-mastered copy to keep; you can override per group before applying.
      </div>

      {phase==="idle"&&(
        <button className="btn btn-primary" onClick={startScan} disabled={!initialGroups.length}
          style={{width:"100%",padding:12,borderRadius:"var(--rs)",fontSize:13,opacity:initialGroups.length?1:0.5}}>
          <Search size={14}/> {initialGroups.length?`Find ${initialDupes} duplicate${initialDupes===1?"":"s"} across ${initialGroups.length} group${initialGroups.length===1?"":"s"}`:"No duplicates found"}
        </button>
      )}

      {phase==="review"&&(
        <div>
          <div style={{background:"var(--info-bg)",border:"1px solid var(--info-border)",borderRadius:"var(--rs)",padding:"10px 12px",marginBottom:10,fontSize:13}}>
            <strong>{groups.length}</strong> group{groups.length===1?"":"s"} · <strong>{totalDuplicates}</strong> card{totalDuplicates===1?"":"s"} will be removed (the un-selected ones)
          </div>
          <div style={{maxHeight:380,overflowY:"auto",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"8px 10px",marginBottom:10}}>
            {groups.map(g=>(
              <div key={g.key} style={{padding:"8px 0",borderBottom:"1px solid var(--border)"}}>
                <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",letterSpacing:".05em",textTransform:"uppercase",marginBottom:5}}>
                  {g.entries[0].card.english} <span className="ar" style={{color:"var(--accent)",fontSize:14,letterSpacing:0,textTransform:"none"}}>· {g.entries[0].card.arabicBase}</span>
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:4}}>
                  {g.entries.map(e=>{
                    const isKeep=keepIds[g.key]===e.card.id;
                    const formsCount=Object.values(e.card.forms||{}).filter(Boolean).length;
                    return (
                      <div key={e.card.id} onClick={()=>setKeepIds(p=>({...p,[g.key]:e.card.id}))}
                        style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",borderRadius:"var(--rxs)",cursor:"pointer",border:`1.5px solid ${isKeep?"var(--know)":"var(--border)"}`,background:isKeep?"var(--know-bg)":"transparent"}}>
                        <div className={`chk ${isKeep?"on":""}`} style={{width:14,height:14,borderColor:isKeep?"var(--know)":"var(--border)",background:isKeep?"var(--know)":"transparent"}}>{isKeep&&<Check size={9} color="white"/>}</div>
                        <div style={{flex:1,fontSize:12}}>
                          <span style={{fontWeight:isKeep?600:400,color:isKeep?"var(--know)":"var(--text2)"}}>{isKeep?"Keep":"Delete"}</span>
                          <span style={{color:"var(--text3)",marginLeft:6}}>· {e.deckTitle}</span>
                          {e.card.status&&<span className={`tag tag-${e.card.status}`} style={{fontSize:9,marginLeft:6}}>{e.card.status}</span>}
                          <span style={{color:"var(--text3)",fontSize:11,marginLeft:6}}>{formsCount} forms</span>
                          {e.card.srsStreak>0&&<span style={{color:"var(--know)",fontSize:11,marginLeft:6}}>🔥{e.card.srsStreak}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn" onClick={reset} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"10px",borderRadius:"var(--rs)",fontSize:13}}>Cancel</button>
            <button className="btn btn-primary" onClick={apply} style={{flex:2,padding:"10px",borderRadius:"var(--rs)",fontSize:13}}>
              <Trash2 size={14}/> Delete {totalDuplicates} Duplicate{totalDuplicates===1?"":"s"}
            </button>
          </div>
        </div>
      )}

      {phase==="done"&&(
        <div style={{background:"var(--know-bg)",border:"1px solid var(--know-border)",borderRadius:"var(--rs)",padding:"12px",fontSize:13,color:"var(--know)",textAlign:"center"}}>
          {initialGroups.length===0?"No duplicates found — your decks look clean.":"Duplicates removed."}
          <div style={{marginTop:8}}>
            <button className="btn btn-ghost" onClick={reset} style={{fontSize:12,color:"var(--text3)"}}>Run again</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PROFILE PANEL (Phase 1) — edit working level, personalization mode,
// and personal context; or retake the placement / full onboarding.
// ─────────────────────────────────────────────────────────────
function ProfilePanel({profile,setProfile,onRetake}) {
  const base={displayName:"",workingLevel:"book1",personalizationOn:false,personalContext:emptyContext(),nativeLanguage:""};
  const norm=(p)=>({...base,...(p||{}),personalContext:{...emptyContext(),...(p?.personalContext||{})}});
  const [local,setLocal]=useState(()=>norm(profile));
  const [open,setOpen]=useState(false);
  const synced=useRef(!!profile);
  // If the profile arrives from Firestore after this panel mounted, sync the
  // edit buffer once (without clobbering in-progress typing).
  useEffect(()=>{ if(profile&&!synced.current){ synced.current=true; setLocal(norm(profile)); } },[profile]);
  // Persist immediately — no separate Save step to forget. (App debounces the
  // Firestore write.) `nativeLanguage` mirrors the context field.
  const persist=(next)=>setProfile({...next,nativeLanguage:next.personalContext?.nativeLanguage||next.nativeLanguage||""});
  const setNow=(k,v)=>{ const next={...local,[k]:v}; setLocal(next); persist(next); };          // discrete controls
  const setCtxNow=(k,v)=>{ const next={...local,personalContext:{...local.personalContext,[k]:v}}; setLocal(next); persist(next); };
  const setLocalOnly=(k,v)=>setLocal(p=>({...p,[k]:v}));                                          // text → local, commit on blur
  const setCtxLocal=(k,v)=>setLocal(p=>({...p,personalContext:{...p.personalContext,[k]:v}}));
  const save=()=>{ persist(local); showToast("Profile saved","success"); };
  const lv=levelById(local.workingLevel);
  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setOpen(v=>!v)}>
        <div>
          <div className="sec" style={{margin:0}}>Profile & Personalization</div>
          <div style={{fontSize:13,marginTop:3}}>
            <span style={{fontWeight:700}}>{lv.label}</span>
            <span style={{color:"var(--text3)"}}> · {lv.cefr}</span>
            <span style={{color:local.personalizationOn?"var(--accent)":"var(--text3)",fontWeight:600}}> · {local.personalizationOn?"Personalized":"General"}</span>
          </div>
        </div>
        {open?<ChevronUp size={15} color="var(--text3)"/>:<ChevronDown size={15} color="var(--text3)"/>}
      </div>

      {open&&(
        <div style={{borderTop:"1px solid var(--border)",marginTop:12,paddingTop:14,display:"flex",flexDirection:"column",gap:12}}>
          <div>
            <label className="lbl" style={{marginBottom:3}}>Name</label>
            <input className="input" value={local.displayName} onChange={e=>setLocalOnly("displayName",e.target.value)} onBlur={save} placeholder="Your name"/>
          </div>
          <div>
            <label className="lbl" style={{marginBottom:3}}>Working level <span style={{color:"var(--text3)",fontWeight:400,textTransform:"none",letterSpacing:0}}>· saved instantly</span></label>
            <select className="input" value={local.workingLevel} onChange={e=>setNow("workingLevel",e.target.value)}>
              {WORKING_LEVELS.map(l=><option key={l.id} value={l.id}>{l.label} · {l.cefr} (Book {l.book})</option>)}
            </select>
            <div style={{fontSize:11.5,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>{lv.desc}</div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700}}>Personalized mode <span style={{fontSize:11,color:"var(--accent)"}}>· Paid</span></div>
              <div style={{fontSize:11.5,color:"var(--text3)",marginTop:2,lineHeight:1.5}}>Generate content from your known vocabulary + context. Off = shared free preset library.</div>
            </div>
            <div className={`chk ${local.personalizationOn?"on":""}`} onClick={()=>setNow("personalizationOn",!local.personalizationOn)}>{local.personalizationOn&&<Check size={11} color="white"/>}</div>
          </div>
          <div className="divider"/>
          <div className="sec" style={{margin:0}}>Personal context</div>
          {CONTEXT_FIELDS.map(f=>(
            <div key={f.key}>
              <label className="lbl" style={{marginBottom:3}}>{f.label}</label>
              {f.type==="select"
                ? <select className="input" value={local.personalContext[f.key]||""} onChange={e=>setCtxNow(f.key,e.target.value)}>
                    <option value="">Select…</option>
                    {f.options.map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                : f.type==="textarea"
                ? <textarea className="input" value={local.personalContext[f.key]||""} onChange={e=>setCtxLocal(f.key,e.target.value)} onBlur={save} placeholder={f.placeholder} rows={2} style={{resize:"vertical"}}/>
                : <input className="input" value={local.personalContext[f.key]||""} onChange={e=>setCtxLocal(f.key,e.target.value)} onBlur={save} placeholder={f.placeholder}/>}
            </div>
          ))}
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button className="btn btn-primary" onClick={save} style={{flex:2,padding:"11px",borderRadius:"var(--rs)",fontSize:13.5}}>Save profile</button>
            <button className="btn" onClick={onRetake} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"11px",borderRadius:"var(--rs)",fontSize:13}}>Replay onboarding</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Personal backup export — base words only (arabicBase + english + wordType),
// no forms/SRS/status. Forms are regeneratable from the base word on demand,
// so they're deliberately left out to keep this a lean, human-readable backup
// rather than a full state dump.
function ExportDataPanel({decks,cardStates}) {
  const totalCards=Object.values(cardStates||{}).reduce((s,arr)=>s+(arr?.length||0),0);
  const doExport=()=>{
    const payload={
      exportedAt:new Date().toISOString(),
      deckCount:decks.length,
      cardCount:totalCards,
      decks:decks.map(d=>({
        title:d.title,
        cards:(cardStates[d.id]||[]).map(c=>({english:c.english,arabic:c.arabicBase,type:c.wordType})),
      })),
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`arabic-flashcards-export-${new Date().toISOString().slice(0,10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Exported ${totalCards} cards across ${decks.length} decks`,"success");
  };
  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
      <div className="sec">Export Flashcards</div>
      <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:10}}>
        Downloads a JSON backup of every deck and card — English meaning + the base Arabic word only (singular for nouns, third-person-masculine-past for verbs). Forms, SRS progress, and status aren't included; regenerate those from the base word if you ever need to restore.
      </div>
      <button className="btn btn-primary" onClick={doExport} disabled={!totalCards}
        style={{width:"100%",padding:12,borderRadius:"var(--rs)",fontSize:13,opacity:totalCards?1:0.5}}>
        <Download size={14}/> Export {totalCards} card{totalCards===1?"":"s"} as JSON
      </button>
    </div>
  );
}

function SettingsScreen({settings,setSettings,onBack,usage,user,onSignOut,onReplayOnboarding,profile,setProfile,studyLog,onUpdateTargets,decks,cardStates,setCardStates,trackUsage,onResetUsage}) {
  const [local,setLocal]=useState(settings);
  const [saved,setSaved]=useState(false);
  const set=(k,v)=>setLocal(p=>({...p,[k]:v}));
  const save=()=>{
    setSettings(local);
    setSaved(true);setTimeout(()=>setSaved(false),2500);
    showToast("Settings saved","success");
  };
  return (
    <div className="screen">
      <Hdr title="Settings" onBack={onBack}/>
      <div style={{padding:"22px 20px 0",display:"flex",flexDirection:"column",gap:20}}>
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div className="sec">Account</div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {user?.photoURL
              ? <img src={user.photoURL} referrerPolicy="no-referrer" style={{width:38,height:38,borderRadius:"50%",objectFit:"cover"}}/>
              : <div style={{width:38,height:38,borderRadius:"50%",background:"var(--accent-bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>👤</div>}
            <div style={{flex:1}}>
              <div style={{fontWeight:600,fontSize:14}}>{user?.displayName||user?.email||"Signed in"}</div>
              <div style={{fontSize:12,color:"var(--know)"}}>● Connected via Google</div>
            </div>
            <button className="btn btn-ghost" onClick={onSignOut} style={{fontSize:12,color:"var(--text3)",padding:"6px 10px",borderRadius:"var(--rxs)"}}>Sign out</button>
          </div>
        </div>

        <ProfilePanel profile={profile} setProfile={setProfile} onRetake={onReplayOnboarding}/>

        {/* Pass `local` (the in-edit settings) so cost previews react as you
            change model dropdowns above, before you've hit Save. */}
        <UsageMeter usage={usage} settings={local} onReset={onResetUsage}/>

        {/* AI Models — default + per-feature overrides */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div className="sec">AI Model · Default (OpenRouter)</div>
          <select className="input" value={local.model} onChange={e=>set("model",e.target.value)} style={{marginBottom:8}}>
            {OR_MODELS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div style={{fontSize:11.5,color:"var(--text3)",lineHeight:1.65,marginBottom:14}}>
            Used wherever you haven't picked a per-feature override below. Pricing at <strong>openrouter.ai/models</strong>.
          </div>

          <div className="sec" style={{marginTop:6}}>Per-Feature Override</div>
          <div style={{fontSize:11.5,color:"var(--text3)",lineHeight:1.65,marginBottom:10}}>
            Use a stronger model where it matters (new cards, cleanup) and a cheaper one where you can save (reading, conversation). "(Use default)" falls back to the model above.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {MODEL_FEATURES.map(f=>{
              const cur=local.models?.[f.tag]||"";
              return (
                <div key={f.tag}>
                  <label className="lbl" style={{marginBottom:3}}>{f.label} <span style={{color:"var(--text3)",fontWeight:400,letterSpacing:0,textTransform:"none"}}>· {f.desc}</span></label>
                  <select className="input" value={cur} onChange={e=>set("models",{...(local.models||{}),[f.tag]:e.target.value||undefined})} style={{fontSize:13}}>
                    <option value="">(Use default)</option>
                    {OR_MODELS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        </div>

        {/* Image model */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div className="sec">Image Model · via Google AI Studio</div>
          <select className="input" value={local.imageModel||"gemini-2.5-flash-image"} onChange={e=>set("imageModel",e.target.value)} style={{marginBottom:8}}>
            {IMAGE_MODELS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div style={{fontSize:11.5,color:"var(--text3)",lineHeight:1.65,marginBottom:12}}>
            Used for the optional mnemonic image on flashcards. Requires the Google AI Studio API key below.
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,paddingTop:10,borderTop:"1px solid var(--border)"}}>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Auto-generate images</div>
              <div style={{fontSize:11.5,color:"var(--text3)",marginTop:2,lineHeight:1.5}}>When on, every "Generate Learning Aid" tap also draws an image (~$0.039 each). When off (default), you'll see an "Add image" button on each card so you only spend when you want to.</div>
            </div>
            <div className={`chk ${local.autoGenerateImage?"on":""}`} onClick={()=>set("autoGenerateImage",!local.autoGenerateImage)}>{local.autoGenerateImage&&<Check size={11} color="white"/>}</div>
          </div>
        </div>

        {/* API keys */}
        <div style={{background:"var(--info-bg)",border:"1.5px solid var(--info-border)",borderRadius:"var(--r)",padding:"14px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}><Info size={14} color="var(--info)"/><div className="sec" style={{margin:0,color:"var(--info)"}}>API Keys</div></div>
          <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.7,marginBottom:12}}>
            Your API keys are stored securely in your account. Each user needs their own keys.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <span style={{fontSize:14}}>🔑</span>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>OpenRouter API Key</div>
                  <span style={{fontSize:10,fontWeight:600,color:"var(--weak)",background:"var(--weak-bg)",border:"1px solid var(--weak-border)",padding:"1px 6px",borderRadius:100}}>Required</span>
                  {local.orKey?.trim()
                    ? <span style={{fontSize:10,fontWeight:600,color:"var(--know)"}}>● set</span>
                    : <span style={{fontSize:10,fontWeight:600,color:"var(--text3)"}}>○ not set</span>}
                </div>
                <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"var(--accent)",textDecoration:"none",fontWeight:600}}>Get key →</a>
              </div>
              <input
                className="input"
                type="password"
                placeholder="sk-or-..."
                value={local.orKey||""}
                onChange={e=>set("orKey",e.target.value)}
                style={{fontSize:12,padding:"8px 10px",fontFamily:"monospace"}}
              />
              <div style={{fontSize:11,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>Powers all text generation: flashcards, sentences, reading, listening, conversation.</div>
            </div>
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <span style={{fontSize:14}}>🖼</span>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Google AI Studio API Key</div>
                  <span style={{fontSize:10,fontWeight:600,color:"var(--text3)",background:"var(--surface2)",border:"1px solid var(--border)",padding:"1px 6px",borderRadius:100}}>Optional</span>
                  {local.gKey?.trim()
                    ? <span style={{fontSize:10,fontWeight:600,color:"var(--know)"}}>● set</span>
                    : <span style={{fontSize:10,fontWeight:600,color:"var(--text3)"}}>○ not set</span>}
                </div>
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"var(--accent)",textDecoration:"none",fontWeight:600}}>Get key →</a>
              </div>
              <input
                className="input"
                type="password"
                placeholder="AIza..."
                value={local.gKey||""}
                onChange={e=>set("gKey",e.target.value)}
                style={{fontSize:12,padding:"8px 10px",fontFamily:"monospace"}}
              />
              <div style={{fontSize:11,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>Enables Nano Banana mnemonic images on flashcards. ~$0.04 per image. App works fine without it.</div>
            </div>
          </div>
        </div>

        {/* Voice & STT */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}><Volume2 size={14} color="var(--accent)"/><div className="sec" style={{margin:0}}>Voice (TTS & STT)</div></div>
          <div style={{fontSize:12,color:"var(--text3)",lineHeight:1.6,marginBottom:12}}>
            When set, Arabic playback uses Google Cloud Wavenet voices (better tashkeel handling) and speech-to-text uses OpenAI Whisper (much better Arabic accuracy). Without keys, the app falls back to the browser's built-in voices/recognition.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {/* TTS voice */}
            <div>
              <label className="lbl" style={{marginBottom:5}}>TTS Voice</label>
              <select className="input" value={local.ttsVoice||"ar-XA-Wavenet-C"} onChange={e=>set("ttsVoice",e.target.value)} style={{fontSize:13}}>
                <option value="ar-XA-Wavenet-A">Wavenet-A · female</option>
                <option value="ar-XA-Wavenet-B">Wavenet-B · male</option>
                <option value="ar-XA-Wavenet-C">Wavenet-C · male (recommended)</option>
                <option value="ar-XA-Wavenet-D">Wavenet-D · female</option>
              </select>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:4}}>Used by Google Cloud TTS. Falls back to browser voice if no Cloud TTS key.</div>
            </div>
            {/* TTS speed */}
            <div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <label className="lbl" style={{margin:0}}>TTS Speed</label>
                <span style={{fontSize:11,color:"var(--text3)",fontFamily:"monospace"}}>{(local.ttsSpeed??0.92).toFixed(2)}×</span>
              </div>
              <input type="range" min="0.7" max="1.2" step="0.02" value={local.ttsSpeed??0.92} onChange={e=>set("ttsSpeed",parseFloat(e.target.value))} style={{width:"100%"}}/>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:2}}>0.92× is the default — clear MSA pacing for learners.</div>
            </div>
            {/* Google TTS key */}
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <span style={{fontSize:14}}>🎙</span>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Google Cloud TTS Key</div>
                  <span style={{fontSize:10,fontWeight:600,color:"var(--text3)",background:"var(--surface2)",border:"1px solid var(--border)",padding:"1px 6px",borderRadius:100}}>Optional</span>
                  {local.ttsKey?.trim()
                    ? <span style={{fontSize:10,fontWeight:600,color:"var(--know)"}}>● set</span>
                    : <span style={{fontSize:10,fontWeight:600,color:"var(--text3)"}}>○ not set</span>}
                </div>
                <a href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com" target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"var(--accent)",textDecoration:"none",fontWeight:600}}>Enable API →</a>
              </div>
              <input className="input" type="password" placeholder="AIza... (or leave blank to use AI Studio key)" value={local.ttsKey||""} onChange={e=>set("ttsKey",e.target.value)} style={{fontSize:12,padding:"8px 10px",fontFamily:"monospace"}}/>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>Free tier covers 1M chars/month — personal use is effectively free with caching.</div>
            </div>
            {/* Enhanced STT toggle */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10}}>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Enhanced STT (Whisper)</div>
                <div style={{fontSize:11,color:"var(--text3)",marginTop:2,lineHeight:1.5}}>When on, your mic audio is sent to OpenAI Whisper for Arabic transcription instead of the browser. Much higher accuracy. Costs ~$0.006/minute.</div>
              </div>
              <div className={`chk ${local.sttEnabled?"on":""}`} onClick={()=>set("sttEnabled",!local.sttEnabled)}>{local.sttEnabled&&<Check size={11} color="white"/>}</div>
            </div>
            {/* OpenAI key for STT */}
            <div>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <span style={{fontSize:14}}>🎧</span>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>OpenAI API Key (Whisper)</div>
                  <span style={{fontSize:10,fontWeight:600,color:"var(--text3)",background:"var(--surface2)",border:"1px solid var(--border)",padding:"1px 6px",borderRadius:100}}>Optional</span>
                  {local.sttKey?.trim()
                    ? <span style={{fontSize:10,fontWeight:600,color:"var(--know)"}}>● set</span>
                    : <span style={{fontSize:10,fontWeight:600,color:"var(--text3)"}}>○ not set</span>}
                </div>
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"var(--accent)",textDecoration:"none",fontWeight:600}}>Get key →</a>
              </div>
              <input className="input" type="password" placeholder="sk-..." value={local.sttKey||""} onChange={e=>set("sttKey",e.target.value)} style={{fontSize:12,padding:"8px 10px",fontFamily:"monospace"}}/>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:4,lineHeight:1.5}}>Powers Enhanced STT. No effect unless the toggle above is on.</div>
            </div>
          </div>
        </div>

        {/* Conversation tunables */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}><MessageCircle size={14} color="var(--accent)"/><div className="sec" style={{margin:0}}>Conversation</div></div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <label className="lbl" style={{margin:0}}>Silence Threshold</label>
                <span style={{fontSize:11,color:"var(--text3)",fontFamily:"monospace"}}>{((local.convSilenceMs??2500)/1000).toFixed(1)}s</span>
              </div>
              <input type="range" min="800" max="5000" step="100" value={local.convSilenceMs??2500} onChange={e=>set("convSilenceMs",parseInt(e.target.value,10))} style={{width:"100%"}}/>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:2}}>How long the mic waits in silence before auto-submitting your turn. Higher = more forgiving of natural mid-thought pauses. Default: 2.5s. Max: 5.0s.</div>
            </div>
            <div>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <label className="lbl" style={{margin:0}}>Vocabulary Match Strictness</label>
                <span style={{fontSize:11,color:"var(--text3)",fontFamily:"monospace"}}>{Math.round((local.convFuzzyThreshold??0.8)*100)}%</span>
              </div>
              <input type="range" min="0.6" max="0.95" step="0.05" value={local.convFuzzyThreshold??0.8} onChange={e=>set("convFuzzyThreshold",parseFloat(e.target.value))} style={{width:"100%"}}/>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:2}}>Lower = more forgiving (STT typos still count). Higher = stricter exact-match. Default: 80%.</div>
            </div>
          </div>
        </div>

        {/* Study Targets */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div className="sec">Study Targets</div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div>
              <label className="lbl">Daily Target (minutes)</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[15,30,45,60,90,120,180].map(n=>(
                  <button key={n} className={`chip ${(studyLog?.targets?.dailyMinutes||30)===n?"chip-on":""}`}
                    onClick={()=>onUpdateTargets({...(studyLog?.targets||{}),dailyMinutes:n})}
                    style={{flex:1,justifyContent:"center",padding:"8px 0",fontSize:12,minWidth:42}}>{n>=60?`${n/60}h`:n}</button>
                ))}
              </div>
            </div>
            <div>
              <label className="lbl">Weekly Target (hours)</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {[60,150,210,300,420,600,840].map(n=>(
                  <button key={n} className={`chip ${(studyLog?.targets?.weeklyMinutes||150)===n?"chip-on":""}`}
                    onClick={()=>onUpdateTargets({...(studyLog?.targets||{}),weeklyMinutes:n})}
                    style={{flex:1,justifyContent:"center",padding:"8px 0",fontSize:12,minWidth:42}}>{n>=60?`${Math.round(n/60*10)/10}h`:n+"m"}</button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <SRSSettingsPanel srsSettings={local.srs} onChange={srs=>set("srs",srs)}/>

        <CardCleanupTool decks={decks} cardStates={cardStates} setCardStates={setCardStates} trackUsage={trackUsage}/>

        <DuplicateFinder decks={decks} cardStates={cardStates} setCardStates={setCardStates}/>

        <ExportDataPanel decks={decks} cardStates={cardStates}/>

        <button className="btn btn-primary" onClick={save} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:15}}>
          {saved?<><Check size={16}/>Saved</>:<><Save size={15}/>Save Settings</>}
        </button>

        <button className="btn" onClick={onReplayOnboarding} style={{width:"100%",padding:12,borderRadius:"var(--r)",fontSize:13,background:"var(--surface2)",color:"var(--text2)"}}>
          <HelpCircle size={14}/> Replay Onboarding Guide
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CREATE DECK
// ─────────────────────────────────────────────────────────────
function CreateDeckScreen({onBack,onCreate}) {
  const [title,setTitle]=useState("");
  const [unitId,setUnitId]=useState("");
  return (
    <div className="screen">
      <Hdr title="New Deck" sub="Create" onBack={onBack}/>
      <div style={{padding:"22px 20px 0"}}>
        <label className="lbl">Deck Title</label>
        <input className="input" placeholder="e.g. Common Nouns, Chapter 3 Verbs…" value={title} onChange={e=>setTitle(e.target.value)} autoFocus onKeyDown={e=>e.key==="Enter"&&title.trim()&&onCreate(title.trim(),unitId||null)}/>
        <label className="lbl" style={{marginTop:16}}>Curriculum unit <span style={{color:"var(--text3)",fontWeight:400,textTransform:"none",letterSpacing:0}}>· optional</span></label>
        <select className="input" value={unitId} onChange={e=>setUnitId(e.target.value)}>
          <option value="">No unit (general deck)</option>
          {BOOKS.map(b=>(
            <optgroup key={b.n} label={b.name}>
              {b.units.map((u,i)=><option key={`${b.n}-${i+1}`} value={`${b.n}-${i+1}`}>{i+1}. {u[1]} · {u[0]}</option>)}
            </optgroup>
          ))}
        </select>
        <div style={{fontSize:11.5,color:"var(--text3)",marginTop:5,lineHeight:1.5}}>Linking a deck to a unit makes its cards count toward that unit & level — used by practice modules and personalization.</div>
        <button className="btn btn-primary" onClick={()=>title.trim()&&onCreate(title.trim(),unitId||null)} disabled={!title.trim()} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:15,marginTop:18}}>
          <Plus size={15}/> Create & Add Cards
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ADD CARDS — with per-card delete in preview
// ─────────────────────────────────────────────────────────────
function AddCardsScreen({deck,onBack,onSave,trackUsage}) {
  const [inputLang,setInputLang]=useState("english");
  const [wordType,setWordType]=useState("noun");
  const [selForms,setSelForms]=useState(["singular","plural","harf"]);
  const [words,setWords]=useState("");
  const [generating,setGenerating]=useState(false);
  const [genProgress,setGenProgress]=useState("");
  const [preview,setPreview]=useState(null);
  const [err,setErr]=useState("");
  const avail=FORMS_BY_TYPE[wordType]||FORMS_BY_TYPE.other;
  const wordList=words.split("\n").map(w=>w.trim()).filter(Boolean);
  const toggleForm=f=>{setSelForms(p=>p.includes(f)?p.filter(x=>x!==f):[...p,f]);setPreview(null);};
  const changeType=t=>{setWordType(t);const defaults=FORMS_BY_TYPE[t]?.slice(0,3)||[];setSelForms([...defaults,"harf"]);setPreview(null);};

  const generate=async()=>{
    if(!wordList.length){setErr("Enter at least one word.");return;}
    if(!selForms.length){setErr("Select at least one form.");return;}
    setErr("");setGenerating(true);setPreview(null);setGenProgress("");
    const isEn=inputLang==="english";
    const formsDesc=selForms.map(f=>`"${f}" (${FORM_LABELS[f]})`).join(", ");
    const BATCH=3;
    const chunks=[];
    for(let i=0;i<wordList.length;i+=BATCH) chunks.push(wordList.slice(i,i+BATCH));
    const allCards=[];
    let failed=0;
    for(let ci=0;ci<chunks.length;ci++){
      const chunk=chunks[ci];
      setGenProgress(`Batch ${ci+1}/${chunks.length} (${allCards.length} cards done)…`);
      try {
        const raw=await callClaudeWithTashkeel(
          `Expert Arabic linguist creating flashcards.
Input: ${isEn?"English":"Arabic"} | Type: ${wordType} | Words: ${chunk.join(", ")}
Required forms: ${formsDesc}

Notes on special fields:
- "plural2": a second plural form if the word has one (e.g. جمع تكسير vs جمع مؤنث سالم). Use "" if only one plural exists.
- "harf": the single most common Arabic preposition/particle used with this word (e.g. فِي / إِلَى / مَعَ / عَنْ / مِنْ)
- "synonymPlural": plural of the synonym if provided
- "antonymPlural": plural of the antonym if provided

Return ONLY valid JSON array, no markdown:
[{"english":"...","arabicBase":"Arabic with diacritics","wordType":"${wordType}","forms":{${selForms.map(f=>`"${f}":"Arabic with diacritics or empty string"`).join(",")}}}]

Rules: exactly ${chunk.length} objects in same order.
- The "forms" object MUST contain ONLY these keys: ${selForms.map(f=>`"${f}"`).join(", ")}. Do NOT add any other keys (e.g. no extra forms, conjugations, particles, or variants the user did not request).
- Use "" for any form that does not naturally exist or is extremely rare/unnatural (e.g. no synonym, no antonym, no plural for an uncountable noun). Do NOT invent or force rare forms — only include commonly used ones.
CRITICAL: Every Arabic word MUST have full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين) — no bare letters.`,
          Math.min(4000, chunk.length*600),"flashcard",trackUsage
        );
        const parsed=extractJSON(raw);
        allCards.push(...(Array.isArray(parsed)?parsed:[parsed]));
      } catch(e){ console.error(`Batch ${ci+1} failed:`,e); failed++; }
    }
    if(allCards.length>0){
      setPreview(allCards);
      if(failed>0) setErr(`${failed} batch${failed>1?"es":""} failed — ${allCards.length} cards generated successfully. You can save these and retry the rest.`);
    } else {
      setErr("Generation failed — check your OpenRouter API key in Settings and try again.");
    }
    setGenerating(false);setGenProgress("");
  };

  // Delete a card from preview before saving
  const removeFromPreview=(idx)=>setPreview(p=>p.filter((_,i)=>i!==idx));

  const save=()=>{
    if(!preview?.length) return;
    const allowed=new Set(selForms);
    onSave(preview.map((c,i)=>({
      ...c,
      id:`c${Date.now()}-${i}`,
      status:"new",
      forms:Object.fromEntries(Object.entries(c.forms||{}).filter(([k,v])=>v&&allowed.has(k))),
    })));
  };

  return (
    <div className="screen">
      <Hdr title="Add Cards" sub={deck.title} onBack={onBack}/>
      <div style={{padding:"20px 20px 0",display:"flex",flexDirection:"column",gap:16}}>
        <div>
          <div className="sec">Input Language</div>
          <div style={{display:"flex",gap:8}}>
            {[["english","🇬🇧 English"],["arabic","🇸🇦 Arabic"]].map(([v,label])=>(
              <button key={v} className={`chip ${inputLang===v?"chip-on":""}`} style={{flex:1,justifyContent:"center",padding:"10px 0"}} onClick={()=>{setInputLang(v);setPreview(null);}}>{label}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="sec">Word Type</div>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            {["noun","verb","adjective","other"].map(t=>(
              <button key={t} className={`chip ${wordType===t?"chip-on":""}`} style={{textTransform:"capitalize"}} onClick={()=>changeType(t)}>{t}</button>
            ))}
          </div>
        </div>
        <div>
          <div className="sec">Forms to Generate</div>
          <div style={{display:"flex",flexDirection:"column",gap:9}}>
            {avail.map(f=>{
              const on=selForms.includes(f);
              const isHarf=f==="harf";
              return (
                <div key={f} onClick={()=>toggleForm(f)} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}}>
                  <div className={`chk ${on?"on":""}`}>{on&&<Check size={11} color="white"/>}</div>
                  <div style={{fontSize:13.5,fontWeight:on?600:400,color:on?"var(--text)":"var(--text2)"}}>
                    {FORM_LABELS[f]}
                    <span className="ar" style={{fontSize:13,color:isHarf?"var(--harf)":"var(--text3)",marginRight:5}}> · {FORM_ARABIC[f]}</span>
                    {isHarf&&<span style={{fontSize:11,background:"var(--harf-bg)",color:"var(--harf)",padding:"1px 6px",borderRadius:100,border:"1px solid var(--harf-border)",marginRight:5}}>e.g. فِي · إِلَى · مَعَ</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div>
          <label className="lbl">Words — one per line {wordList.length>0&&<span style={{color:"var(--text3)",fontWeight:400}}>({wordList.length})</span>}</label>
          <textarea className="input" value={words} onChange={e=>{setWords(e.target.value);setPreview(null);}}
            placeholder={inputLang==="english"?"book\nhouse\nteacher":"كتاب\nبيت\nمعلم"}
            style={{direction:inputLang==="arabic"?"rtl":"ltr",fontFamily:inputLang==="arabic"?"'Scheherazade New',serif":"inherit",fontSize:inputLang==="arabic"?20:14,minHeight:120}}/>
        </div>
        {err&&<div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rxs)",padding:"10px 13px",fontSize:13,color:"var(--weak)"}}>{err}</div>}
        <button className="btn btn-primary" onClick={generate} disabled={generating||!wordList.length||!selForms.length} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:14}}>
          {generating?<><RefreshCw size={14} className="spin"/>{genProgress||`Generating ${wordList.length} cards…`}</>:<><Sparkles size={14}/>Generate {wordList.length||""} Card{wordList.length!==1?"s":""}</>}
        </button>

        {/* PREVIEW with per-card delete */}
        {preview&&(
          <div className="gen-appear">
            <div className="divider" style={{margin:"4px 0 14px"}}/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div className="sec" style={{margin:0}}>Preview — {preview.length} card{preview.length!==1?"s":""} ready</div>
              <span style={{fontSize:12,color:"var(--text3)"}}>Tap ✕ to remove before saving</span>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:14}}>
              {preview.map((c,i)=>(
                <div key={i} style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"13px 15px",position:"relative"}}>
                  {/* Remove button */}
                  <button onClick={()=>removeFromPreview(i)}
                    style={{position:"absolute",top:9,right:9,width:24,height:24,borderRadius:"50%",background:"var(--weak-bg)",border:"1px solid var(--weak-border)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--weak)"}}>
                    <X size={11}/>
                  </button>
                  <div style={{paddingRight:30}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div>
                        <div style={{fontWeight:600,fontSize:14.5}}>{c.english}</div>
                        <div className="ar" style={{fontSize:24,color:"var(--accent)"}}>{c.arabicBase}</div>
                      </div>
                      <span style={{fontSize:11,background:"var(--surface2)",color:"var(--text3)",padding:"2px 8px",borderRadius:100,textTransform:"capitalize",flexShrink:0,marginRight:4}}>{c.wordType}</span>
                    </div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                      {Object.entries(c.forms||{}).filter(([,v])=>v).map(([k,v])=>(
                        <span key={k} style={{fontSize:11.5,background:k==="harf"?"var(--harf-bg)":"var(--accent-bg)",color:k==="harf"?"var(--harf)":"var(--accent)",padding:"3px 9px",borderRadius:100,border:`1px solid ${k==="harf"?"var(--harf-border)":"var(--accent-border)"}`,display:"inline-flex",alignItems:"center",gap:4}}>
                          {FORM_LABELS[k]}: <span className="ar" style={{fontSize:13}}>{v}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {preview.length>0 ? (
              <button className="btn btn-primary" onClick={save} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:14,background:"var(--know)"}}>
                <Plus size={15}/> Save {preview.length} Card{preview.length!==1?"s":""} to Deck
              </button>
            ) : (
              <div style={{textAlign:"center",color:"var(--text3)",fontSize:13,padding:"12px 0"}}>All cards removed. Generate again.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// DECK SCREEN — with edit/delete deck
// ─────────────────────────────────────────────────────────────
function DeckScreen({deck,cards,onStartStudy,onBack,onAddCards,onImportMore,onEditCard,onDeleteCard,onRenameDeck,onDeleteDeck,onSetDeckUnit,onSetDeckLastStudied,savedIdx}) {
  const [deckMenu,setDeckMenu]=useState(false);
  const [renaming,setRenaming]=useState(false);
  const [linkingUnit,setLinkingUnit]=useState(false);
  const [settingStudied,setSettingStudied]=useState(false);
  const [studiedDate,setStudiedDate]=useState(()=>new Date(deck.lastStudiedAt||Date.now()).toISOString().slice(0,10));
  const [newTitle,setNewTitle]=useState(deck.title);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const linkedUnit=deck.unitId?unitById(deck.unitId):null;
  const [search,setSearch]=useState("");
  const [statusFilter,setStatusFilter]=useState("all");
  const [studyFilter,setStudyFilter]=useState("all");

  const weak=cards.filter(c=>c.status==="weak").length;
  const known=cards.filter(c=>c.status==="known").length;
  const dueCount=getDueCount(cards);
  const pct=cards.length>0?Math.round((known/cards.length)*100):0;

  const filteredCards=cards.filter(c=>{
    if(statusFilter==="due"&&c.srsNextReview&&c.srsNextReview>Date.now()) return false;
    if(statusFilter!=="all"&&statusFilter!=="due"&&c.status!==statusFilter) return false;
    if(!search.trim()) return true;
    const q=search.toLowerCase();
    return c.english.toLowerCase().includes(q)||c.arabicBase.includes(search)||
      Object.values(c.forms||{}).some(v=>v&&(v.includes(search)||v.toLowerCase().includes(q)));
  });

  const doRename=()=>{if(newTitle.trim()&&newTitle.trim()!==deck.title){onRenameDeck(deck.id,newTitle.trim());}setRenaming(false);setDeckMenu(false);};

  return (
    <div className="screen">
      <Hdr title={deck.title} sub="Deck" onBack={onBack}
        right={
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            <button className="btn btn-primary btn-sm" onClick={onAddCards}><Plus size={13}/>Add Cards</button>
            {deck.deckType!=="grammar"&&onImportMore&&(
              <button className="btn btn-ghost" onClick={onImportMore} style={{width:34,height:34}} title="Import more via screenshot/PDF"><Upload size={14}/></button>
            )}
            <button className="btn btn-ghost" onClick={()=>setDeckMenu(true)} style={{width:34,height:34}}><MoreVertical size={15}/></button>
          </div>
        }/>

      <div style={{padding:"18px 20px 0"}}>
        <div onClick={()=>{setDeckMenu(true);setLinkingUnit(true);}} style={{display:"inline-flex",alignItems:"center",gap:6,marginBottom:12,cursor:"pointer",fontSize:12,padding:"5px 11px",borderRadius:100,
          background:linkedUnit?"var(--accent-bg)":"var(--surface2)",color:linkedUnit?"var(--accent)":"var(--text3)",border:`1px solid ${linkedUnit?"var(--accent-border)":"var(--border)"}`}}>
          <BookOpen size={12}/>
          {linkedUnit?<>Book {linkedUnit.book} · {linkedUnit.titleEn} <span style={{opacity:.7}}>({levelById(linkedUnit.level).cefr})</span></>:"Link to curriculum unit"}
        </div>
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"14px 16px",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
            <span style={{fontSize:13,color:"var(--text2)"}}>{cards.length} cards</span>
            <span style={{fontSize:13,fontWeight:700,color:pct>0?"var(--know)":"var(--text3)"}}>{pct}% known</span>
          </div>
          <div className="progress-track"><div className="progress-fill" style={{width:`${pct}%`,background:"var(--know)"}}/></div>
          <div style={{display:"flex",gap:18,marginTop:10}}>
            {[{l:"New",v:cards.filter(c=>c.status==="new").length,c:"var(--text3)"},{l:"Known",v:known,c:"var(--know)"},{l:"Weak",v:weak,c:"var(--weak)"}].map(s=>(
              <div key={s.l}><div style={{fontSize:20,fontWeight:700,color:s.c}}>{s.v}</div><div style={{fontSize:11,color:"var(--text3)"}}>{s.l}</div></div>
            ))}
          </div>
        </div>
        {cards.length>0&&(()=>{
          const newCount=cards.filter(c=>c.status==="new"||!c.status).length;
          const now=Date.now();
          const dueC=cards.filter(c=>c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now).length;
          const studyCounts={all:cards.length,new:newCount,weak,known,due:dueC};
          const studyCount=studyCounts[studyFilter]||cards.length;
          const filterSavedIdx=savedIdx?.[studyFilter]||0;
          return (
            <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
              <div className="sec">Study Filter</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:4}}>
                {[["all",`All (${cards.length})`],["new",`New (${newCount})`],["weak",`Weak (${weak})`],["known",`Known (${known})`],["due",`Due (${dueC})`]].map(([k,label])=>(
                  <button key={k} className={`chip ${studyFilter===k?"chip-on":""}`} onClick={()=>setStudyFilter(k)} style={{padding:"5px 11px",fontSize:12}}>{label}</button>
                ))}
              </div>
              {filterSavedIdx>0&&filterSavedIdx<studyCount&&(
                <button className="btn btn-primary" onClick={()=>onStartStudy(studyFilter,false)} style={{width:"100%",padding:"13px",borderRadius:"var(--r)",fontSize:14}}>
                  <BookOpen size={16}/> Resume (Card {filterSavedIdx+1}/{studyCount})
                </button>
              )}
              <button className="btn btn-primary" onClick={()=>onStartStudy(studyFilter,true)} disabled={!studyCount}
                style={{width:"100%",padding:"13px",borderRadius:"var(--r)",fontSize:14,opacity:studyCount?1:0.5}}>
                <BookOpen size={16}/> Study {studyFilter==="all"?"All":studyFilter.charAt(0).toUpperCase()+studyFilter.slice(1)} ({studyCount})
              </button>
            </div>
          );
        })()}
        {cards.length>0&&(
          <div style={{marginBottom:12}}>
            <div style={{position:"relative",marginBottom:10}}>
              <svg style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",opacity:.4}} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input className="search-input" placeholder="Search cards…" value={search} onChange={e=>setSearch(e.target.value)}/>
              {search&&(
                <div style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",fontSize:11,color:"var(--text3)",background:"var(--surface2)",padding:"2px 8px",borderRadius:100,fontWeight:600}}>
                  {filteredCards.length} match{filteredCards.length===1?"":"es"}
                </div>
              )}
            </div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {[["all",`All (${cards.length})`],["new","New"],["weak","Weak"],["known","Known"],["due",`Due (${dueCount})`]].map(([k,label])=>(
                <button key={k} className={`chip ${statusFilter===k?"chip-on":""}`} onClick={()=>setStatusFilter(k)} style={{padding:"5px 11px",fontSize:12}}>{label}</button>
              ))}
            </div>
          </div>
        )}
        <div className="sec">{cards.length>0?`${filteredCards.length===cards.length?"All Cards":filteredCards.length+" matching"} (${cards.length} total)`:"No cards yet"}</div>
        {cards.length===0&&<div style={{textAlign:"center",padding:"36px 0",color:"var(--text3)",fontSize:14}}><Layers size={28} style={{opacity:.3,marginBottom:8}}/><br/>Tap "Add Cards" to generate flashcards</div>}
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {filteredCards.map(c=>(
            <div key={c.id} className="card-row">
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
                  <span style={{fontWeight:600,fontSize:14}}>{c.english}</span>
                  <span className={`tag tag-${c.status}`}>{c.status}</span>
                  {c.srsNextReview&&(
                    <span style={{fontSize:10,color:c.srsNextReview<=Date.now()?"var(--info)":"var(--text3)"}}>
                      {c.srsNextReview<=Date.now()?"Due now":
                        `Next: ${new Date(c.srsNextReview).toLocaleDateString(undefined,{month:"short",day:"numeric"})}`}
                    </span>
                  )}
                </div>
                <div className="ar" style={{fontSize:20,color:"var(--accent)",marginBottom:4}}>{c.arabicBase}</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:5,direction:"rtl"}}>
                  {c.forms.harf&&(
                    <span style={{fontSize:12.5,background:"var(--harf-bg)",color:"var(--harf)",padding:"3px 10px",borderRadius:100,border:"1px solid var(--harf-border)",display:"inline-flex",alignItems:"center",gap:4}}>
                      حرف: <span className="ar" style={{fontSize:15,fontWeight:500}}>{c.forms.harf}</span>
                    </span>
                  )}
                  {(FORMS_BY_TYPE[c.wordType]||FORMS_BY_TYPE.other).filter(k=>k!=="harf"&&c.forms[k]).map(k=>(
                    <span key={k} style={{fontSize:12,color:"var(--text3)",background:"var(--surface2)",padding:"3px 9px",borderRadius:100,display:"inline-flex",alignItems:"center",gap:4}}>
                      {FORM_LABELS[k]}: <span className="ar" style={{fontSize:14,fontWeight:500,color:"var(--text2)"}}>{c.forms[k]}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,flexShrink:0}}>
                <button className="btn btn-sm" onClick={()=>onEditCard(c)} style={{background:"var(--surface2)",color:"var(--text2)"}}><Edit3 size={13}/></button>
                <button className="btn btn-sm" onClick={()=>onDeleteCard(c.id)} style={{background:"var(--weak-bg)",color:"var(--weak)"}}><Trash2 size={13}/></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Deck options drawer */}
      {deckMenu&&(
        <div className="overlay" onClick={e=>{if(e.target===e.currentTarget){setDeckMenu(false);setRenaming(false);setConfirmDelete(false);setLinkingUnit(false);setSettingStudied(false);}}}>
          <div className="drawer">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div style={{fontFamily:"Lora,serif",fontSize:17,fontWeight:600}}>Deck Options</div>
              <button className="btn btn-ghost" onClick={()=>{setDeckMenu(false);setRenaming(false);setConfirmDelete(false);setLinkingUnit(false);setSettingStudied(false);}} style={{width:30,height:30}}><X size={13}/></button>
            </div>

            {!renaming&&!confirmDelete&&!linkingUnit&&!settingStudied&&(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button className="btn" onClick={()=>setRenaming(true)}
                  style={{background:"var(--surface2)",color:"var(--text)",padding:"13px 16px",borderRadius:"var(--rs)",justifyContent:"flex-start",gap:12,fontSize:14}}>
                  <Pencil size={15} color="var(--text2)"/> Rename Deck
                </button>
                <button className="btn" onClick={()=>setLinkingUnit(true)}
                  style={{background:"var(--surface2)",color:"var(--text)",padding:"13px 16px",borderRadius:"var(--rs)",justifyContent:"flex-start",gap:12,fontSize:14}}>
                  <BookOpen size={15} color="var(--text2)"/> {linkedUnit?"Change Curriculum Unit":"Link to Curriculum Unit"}
                </button>
                {deck.deckType!=="grammar"&&(
                  <button className="btn" onClick={()=>{setStudiedDate(new Date(deck.lastStudiedAt||Date.now()).toISOString().slice(0,10));setSettingStudied(true);}}
                    style={{background:"var(--surface2)",color:"var(--text)",padding:"13px 16px",borderRadius:"var(--rs)",justifyContent:"flex-start",gap:12,fontSize:14}}>
                    <Clock size={15} color="var(--text2)"/> Set Last Studied Date <span style={{marginLeft:"auto",fontSize:11.5,color:"var(--text3)",fontWeight:400}}>{daysAgoLabel(deck.lastStudiedAt)}</span>
                  </button>
                )}
                <button className="btn" onClick={()=>{
                  const data=JSON.stringify({deck,cards},null,2);
                  const blob=new Blob([data],{type:"application/json"});
                  const url=URL.createObjectURL(blob);
                  const a=document.createElement("a");
                  a.href=url;a.download=`${deck.title.replace(/[^a-zA-Z0-9]/g,"_")}_flashcards.json`;
                  a.click();URL.revokeObjectURL(url);
                  showToast(`Exported ${cards.length} cards`,"success");
                  setDeckMenu(false);
                }}
                  style={{background:"var(--surface2)",color:"var(--text)",padding:"13px 16px",borderRadius:"var(--rs)",justifyContent:"flex-start",gap:12,fontSize:14}}>
                  <Download size={15} color="var(--text2)"/> Export Deck (JSON)
                </button>
                <button className="btn" onClick={()=>setConfirmDelete(true)}
                  style={{background:"var(--weak-bg)",color:"var(--weak)",padding:"13px 16px",borderRadius:"var(--rs)",justifyContent:"flex-start",gap:12,fontSize:14,border:"1px solid var(--weak-border)"}}>
                  <Trash2 size={15}/> Delete Deck
                </button>
              </div>
            )}

            {renaming&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <label className="lbl">New deck name</label>
                <input className="input" value={newTitle} onChange={e=>setNewTitle(e.target.value)} autoFocus onKeyDown={e=>e.key==="Enter"&&doRename()}/>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn" onClick={()=>setRenaming(false)} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px"}}>Cancel</button>
                  <button className="btn btn-primary" onClick={doRename} disabled={!newTitle.trim()} style={{flex:2,padding:"12px",borderRadius:"var(--rs)"}}><Check size={14}/> Save Name</button>
                </div>
              </div>
            )}

            {linkingUnit&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <label className="lbl">Curriculum unit</label>
                <div style={{fontSize:12,color:"var(--text3)",lineHeight:1.5,marginTop:-4}}>Links every card in this deck to a unit & level. Cards can still be studied normally.</div>
                <select className="input" value={deck.unitId||""} onChange={e=>{onSetDeckUnit(deck.id,e.target.value||null);showToast(e.target.value?`Linked to ${unitLabel(e.target.value)}`:"Unit link removed","success");setLinkingUnit(false);setDeckMenu(false);}}>
                  <option value="">No unit (general deck)</option>
                  {BOOKS.map(b=>(
                    <optgroup key={b.n} label={b.name}>
                      {b.units.map((u,i)=><option key={`${b.n}-${i+1}`} value={`${b.n}-${i+1}`}>{i+1}. {u[1]} · {u[0]}</option>)}
                    </optgroup>
                  ))}
                </select>
                <button className="btn" onClick={()=>setLinkingUnit(false)} style={{background:"var(--surface2)",color:"var(--text2)",padding:"12px"}}>Cancel</button>
              </div>
            )}

            {settingStudied&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <label className="lbl">Last studied</label>
                <div style={{fontSize:12,color:"var(--text3)",lineHeight:1.5,marginTop:-4}}>Overrides what the app tracked automatically — use this if you studied this deck before the rotation feature existed, or outside the app. The Rotation queue in Master Review uses this date to decide what's stalest.</div>
                <input type="date" className="input" value={studiedDate} max={new Date().toISOString().slice(0,10)} onChange={e=>setStudiedDate(e.target.value)}/>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn" onClick={()=>{onSetDeckLastStudied(deck.id,null);showToast("Marked as never studied","success");setSettingStudied(false);setDeckMenu(false);}}
                    style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)",fontSize:12.5}}>Clear (never studied)</button>
                  <button className="btn btn-primary" onClick={()=>{onSetDeckLastStudied(deck.id,new Date(studiedDate+"T12:00:00").getTime());showToast("Last studied date updated","success");setSettingStudied(false);setDeckMenu(false);}}
                    disabled={!studiedDate} style={{flex:1,padding:"12px",borderRadius:"var(--rs)"}}><Check size={14}/> Save</button>
                </div>
              </div>
            )}

            {confirmDelete&&(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                <div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rxs)",padding:"12px 14px",fontSize:13.5,color:"var(--weak)",lineHeight:1.65}}>
                  ⚠ Delete <strong>"{deck.title}"</strong> and all {cards.length} cards? This cannot be undone.
                </div>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn" onClick={()=>setConfirmDelete(false)} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px"}}>Cancel</button>
                  <button className="btn" onClick={()=>{onDeleteDeck(deck.id);setDeckMenu(false);}} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",background:"var(--weak)",color:"white",fontSize:13.5,fontWeight:600}}>
                    <Trash2 size={14}/> Delete
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// EDIT CARD — with harf, synonym/antonym plurals, auto-regen on type switch
// ─────────────────────────────────────────────────────────────
function EditCardScreen({card,onBack,onSave,trackUsage}) {
  const [local,setLocal]=useState({...card,forms:{...card.forms}});
  const [prevType,setPrevType]=useState(card.wordType);
  const [regenPending,setRegenPending]=useState(false);
  const [regening,setRegening]=useState(false);

  const allForms=FORMS_BY_TYPE[local.wordType]||FORMS_BY_TYPE.other;
  const setField=(k,v)=>setLocal(p=>({...p,[k]:v}));
  const setForm=(k,v)=>setLocal(p=>({...p,forms:{...p.forms,[k]:v}}));

  const changeType=(t)=>{
    setField("wordType",t);
    if(t!==prevType) setRegenPending(true);
  };

  const autoRegen=async()=>{
    setRegening(true);
    const forms=FORMS_BY_TYPE[local.wordType]||[];
    const formsDesc=forms.map(f=>`"${f}" (${FORM_LABELS[f]})`).join(", ");
    try {
      const raw=await callClaudeWithTashkeel(
        `Arabic linguist. This is a ${local.wordType}: "${local.english}" / "${local.arabicBase}"
Generate all relevant Arabic forms. Return ONLY valid JSON object (just the forms, no wrapper):
{${forms.map(f=>`"${f}":"Arabic with diacritics or empty string"`).join(",")}}

For "harf": the single most common Arabic preposition used with this ${local.wordType}.
CRITICAL: Every Arabic word MUST have full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين) — no bare letters.`,
        800,"regen",trackUsage
      );
      const clean=raw.replace(/```json|```/g,"").trim();
      const parsed=JSON.parse(clean);
      setLocal(p=>({...p,forms:parsed}));
      setPrevType(local.wordType);
      setRegenPending(false);
    } catch { alert("Regeneration failed — try again."); }
    finally { setRegening(false); }
  };

  return (
    <div className="screen">
      <Hdr title="Edit Card" sub={local.english} onBack={onBack}
        right={<button className="btn btn-primary btn-sm" onClick={()=>onSave(local)}><Check size={13}/>Save</button>}/>
      <div style={{padding:"20px 20px 0",display:"flex",flexDirection:"column",gap:15}}>
        <div><label className="lbl">English Headword</label><input className="input" value={local.english} onChange={e=>setField("english",e.target.value)}/></div>
        <div><label className="lbl">Arabic Base Word</label><input className="input ar" value={local.arabicBase} onChange={e=>setField("arabicBase",e.target.value)} style={{fontSize:22,direction:"rtl"}}/></div>

        <div>
          <label className="lbl">Word Type</label>
          <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
            {["noun","verb","adjective","other"].map(t=>(
              <button key={t} className={`chip ${local.wordType===t?"chip-on":""}`} style={{textTransform:"capitalize"}} onClick={()=>changeType(t)}>{t}</button>
            ))}
          </div>
        </div>

        {/* Auto-regen prompt when type changes */}
        {regenPending&&(
          <div className="gen-appear" style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
            <div style={{fontSize:13.5,color:"var(--accent)",fontWeight:600,marginBottom:8}}>
              Word type changed to <span style={{textTransform:"capitalize"}}>{local.wordType}</span> — regenerate forms?
            </div>
            <div style={{fontSize:12.5,color:"var(--text2)",marginBottom:10}}>
              AI will generate all {local.wordType} forms ({FORMS_BY_TYPE[local.wordType]?.map(f=>FORM_LABELS[f]).join(", ")}) for <span className="ar" style={{fontSize:15}}>{local.arabicBase}</span>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button className="btn" onClick={()=>setRegenPending(false)} style={{flex:1,background:"var(--surface)",color:"var(--text2)",padding:"10px",fontSize:13}}>Keep existing</button>
              <button className="btn btn-primary" onClick={autoRegen} disabled={regening} style={{flex:2,padding:"10px",borderRadius:"var(--rxs)",fontSize:13}}>
                {regening?<><RefreshCw size={13} className="spin"/>Regenerating…</>:<><Sparkles size={13}/>Generate {local.wordType} Forms</>}
              </button>
            </div>
          </div>
        )}

        <div className="divider" style={{margin:"2px 0"}}/><div className="sec">Arabic Forms</div>

        {/* Harf first */}
        {allForms.includes("harf")&&(
          <div style={{background:"var(--harf-bg)",border:"1px solid var(--harf-border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
            <label className="lbl" style={{color:"var(--harf)"}}>
              {FORM_LABELS["harf"]} · <span className="ar" style={{fontSize:13,fontWeight:400}}>{FORM_ARABIC["harf"]}</span>
              <span style={{fontSize:11,fontWeight:400,color:"var(--text3)",marginRight:6}}> — e.g. فِي · إِلَى · مَعَ · عَنْ · مِنْ</span>
            </label>
            <input className="input ar" style={{fontSize:22,direction:"rtl",borderColor:"var(--harf-border)"}} placeholder="e.g. فِي" value={local.forms["harf"]||""} onChange={e=>setForm("harf",e.target.value)}/>
          </div>
        )}

        {allForms.filter(f=>f!=="harf").map(f=>(
          <div key={f}>
            <label className="lbl">{FORM_LABELS[f]}<span className="ar" style={{fontSize:12,color:"var(--text3)",fontWeight:400,marginRight:5}}> · {FORM_ARABIC[f]}</span></label>
            <input className="input ar" style={{fontSize:19,direction:"rtl"}} placeholder="leave blank if not applicable" value={local.forms[f]||""} onChange={e=>setForm(f,e.target.value)}/>
          </div>
        ))}

        <button className="btn btn-primary" onClick={()=>onSave(local)} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:14,marginTop:4}}>
          <Check size={15}/> Save Changes
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// STUDY SCREEN
// ─────────────────────────────────────────────────────────────
function StudyScreen({cards,currentIndex,onSwipe,onBack,canUndo,onExit,trackUsage,decks,cardStates,onAddToFlashcard,activeFormOverride,onToggleWeakForm}) {
  const [flipped,setFlipped]=useState(false);
  const [selForm,setSelForm]=useState(null);
  const [gen,setGen]=useState(null);
  const [genLoading,setGenLoading]=useState(false);
  const [imgLoading,setImgLoading]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const genRef=useRef(0); // prevent duplicate/stale generation
  const [playingEx,setPlayingEx]=useState(-1); // grammar example audio index
  const card=cards[currentIndex];
  const isGrammar=card.wordType==="grammar";
  const grammar=card.grammar||{explanation:"",examples:[]};
  const availForms=Object.entries(card.forms||{}).filter(([,v])=>v);
  // A pending inflectional weak form (e.g. failed "plural" last time) means
  // THIS review should test that form as the primary answer, not the base word.
  const testForm=pendingTestForm(card);

  useEffect(()=>{
    genRef.current++;
    // Reference-chip default: the pending test form if any, else the first
    // available form — same as before, just scoped to inflectional forms now.
    setFlipped(false);setSelForm(testForm||availForms[0]?.[0]||null);setGen(null);setGenLoading(false);setImgLoading(false);
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    stopTtsAudio();
    setPlaying(false);setPlayingEx(-1);
  },[currentIndex]);

  const generate=async(prevSentence=null)=>{
    if(!selForm||genLoading) return;
    const id=++genRef.current;
    const arabicForm=card.forms[selForm];
    const formLabel=FORM_LABELS[selForm]||selForm;
    setGenLoading(true);setGen(null);
    try {
      const avoidClause=prevSentence?`\nDo NOT reuse or closely resemble this previous sentence: "${prevSentence}"`:"";
      // Pull a wide pool of words the user has studied, shuffled fresh each time
      const learnedPool=Object.values(cardStates).flat().filter(c=>c.status==="known"||c.status==="weak");
      const learnedSample=[...learnedPool].sort(()=>Math.random()-0.5).slice(0,60).map(c=>c.arabicBase).join("، ");
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

You are creating a flashcard learning aid in this register.

Word: "${card.english}" · Arabic form "${arabicForm}" (${formLabel})

Generate:
1) ONE short Arabic sentence (6-12 words) using EXACTLY: ${arabicForm}
2) English translation
3) A short mnemonic image idea (1-2 sentences) — ONE single iconic subject that visually captures the word's meaning. Think simple sticker-style flashcard art, not a busy scene. RELIGIOUS CONSTRAINT: do NOT describe people's faces, animal faces, or eyes of any kind. Prefer objects, symbols, scenery, hands, or back-views/silhouettes. Never mention eyes. No Arabic text in the image.${avoidClause}

QUALITY RULES — non-negotiable:
- The sentence MUST sound natural and useful — like something a native speaker would actually say in daily life (at home, in the masjid, at the market, with family, while travelling). Bayna-Yadayk register: warm, contextual, culturally specific. Never textbook-stiff filler.
- Weave in as many of the learner's already-studied words as fits naturally (do NOT force them — natural use only). Pool: ${learnedSample||"(none yet)"}
- Grammatically correct and idiomatic Modern Standard Arabic.

CRITICAL: Every single Arabic word MUST have full tashkeel — no bare letters.
Return ONLY valid JSON: {"sentence":"...","translation":"...","imagePrompt":"..."}`,
        900,"sentence",trackUsage
      );
      if(id!==genRef.current) return;
      const parsed=extractJSON(raw);
      setGen({...parsed,imageUrl:null});
      setGenLoading(false);
      // Image generation is opt-in (Settings → Image Model → "Auto-generate
      // images"). When off, we show an "Add image" button on the card and
      // only spend the $0.039 if the user explicitly asks for it.
      if(_autoGenerateImage){
        setImgLoading(true);
        const url=await generateImage(parsed.imagePrompt,trackUsage);
        if(id!==genRef.current) return;
        setGen(prev=>prev?{...prev,imageUrl:url}:prev);
        setImgLoading(false);
      }
    } catch (err) {
      if(id!==genRef.current) return;
      // Visible failure with a retry path, instead of a silent fallback
      // that hides "your API key is empty / out of credits / model down."
      setGen({sentence:arabicForm,translation:card.english,imagePrompt:`A warm everyday scene representing "${card.english}" in Arabic-speaking daily life, natural lighting.`,imageUrl:null,error:err?.message||"Generation failed"});
      setGenLoading(false);setImgLoading(false);
      showToast(`Couldn't generate: ${err?.message||"unknown error"} — check your OpenRouter key in Settings.`,"error");
    }
  };

  // Keyboard shortcuts for study
  useEffect(()=>{
    const handler=(e)=>{
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
      if(e.key===" "||e.key==="Enter"){e.preventDefault();if(!flipped) setFlipped(true);}
      if(flipped&&e.key==="ArrowLeft"){e.preventDefault();onSwipe("left",card.id,testForm||selForm);}
      if(flipped&&e.key==="ArrowRight"){e.preventDefault();onSwipe("right",card.id,testForm||selForm);}
      if(e.key==="ArrowUp"&&canUndo){e.preventDefault();onBack();}
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[flipped,card?.id,currentIndex,selForm]);

  // Stop audio on unmount or screen change
  useEffect(()=>()=>{stopTtsAudio();},[]);

  const playAudio=()=>{
    if(!gen?.sentence) return;
    if(playing){stopTtsAudio();setPlaying(false);return;}
    synthesizeArabic(gen.sentence,{onStart:()=>setPlaying(true),onEnd:()=>setPlaying(false)});
  };

  return (
    <div className="screen" style={{display:"flex",flexDirection:"column",padding:"18px 18px 20px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <button className="btn btn-ghost" onClick={onExit} style={{width:32,height:32}}><X size={14}/></button>
        <span style={{fontSize:13,color:"var(--text2)",fontWeight:600}}>{currentIndex+1} <span style={{color:"var(--text3)",fontWeight:400}}>/ {cards.length}</span></span>
        <button className="btn btn-ghost" onClick={onBack} disabled={!canUndo} title="Undo last swipe" style={{width:32,height:32,opacity:canUndo?1:0.3}}><ArrowLeft size={14}/></button>
      </div>
      <div className="progress-track" style={{marginBottom:16}}><div className="progress-fill" style={{width:`${((currentIndex+1)/cards.length)*100}%`,background:"var(--accent)"}}/></div>

      <div style={{flex:1,display:"flex",flexDirection:"column",gap:13,overflowY:"auto"}}>
        {/* True 2-faced flip card — click anywhere on the card to toggle */}
        <div key={`flip${currentIndex}`} className={`flip-card ${flipped?'is-flipped':''}`} onClick={()=>setFlipped(f=>!f)}>
          <div className="flip-card-inner">
            {/* Front face — English (or grammar concept) */}
            <div className="flip-card-face">
              <div className="sec" style={{marginBottom:16}}>{isGrammar?<>Grammar · <span className="ar">قَوَاعِد</span></>:testForm?`English · Give the ${FORM_LABELS[testForm]||testForm}`:"English"}</div>
              <div style={{fontFamily:"Lora,serif",fontSize:isGrammar?(card.english.length>40?22:28):38,fontWeight:600,lineHeight:1.25}}>{card.english}</div>
              {isGrammar&&card.arabicBase&&<div className="ar" style={{fontSize:24,color:"var(--harf)",marginTop:10}}>{card.arabicBase}</div>}
              <div style={{fontSize:12,color:"var(--text3)",marginTop:20,fontWeight:500}}>{isGrammar?"Recall the rule, then tap to check ↓":testForm?`Tap to reveal the ${FORM_LABELS[testForm]||testForm} ↓`:"Tap to reveal Arabic ↓"}</div>
            </div>
            {/* Back face — Arabic (or grammar rule) */}
            <div className="flip-card-face flip-card-back">
              <div className="sec" style={{marginBottom:5}}>{isGrammar?"The Rule":testForm?<>Arabic · <span style={{color:"var(--weak)"}}>{FORM_LABELS[testForm]||testForm} (retest)</span></>:<>Arabic · <span style={{textTransform:"capitalize"}}>{card.wordType}</span></>}</div>
              {isGrammar?(
                <>
                  {card.arabicBase&&<div className="ar" style={{fontSize:30,color:"var(--text)"}}>{card.arabicBase}</div>}
                  <div style={{fontSize:14,color:"var(--text2)",lineHeight:1.55,maxHeight:120,overflowY:"auto",padding:"0 4px"}}>{grammar.explanation}</div>
                </>
              ):testForm?(
                <>
                  <div className="ar" style={{fontSize:42,color:"var(--text)"}}>{card.forms[testForm]}</div>
                  <div style={{fontSize:13,color:"var(--text3)"}}>{card.english} · {FORM_LABELS[testForm]||testForm}</div>
                </>
              ):(
                <>
                  <div className="ar" style={{fontSize:42,color:"var(--text)"}}>{card.arabicBase}</div>
                  <div style={{fontSize:13,color:"var(--text3)"}}>{card.english}</div>
                </>
              )}
              {card.srsStreak>0&&(
                <div style={{display:"inline-flex",alignItems:"center",gap:4,marginTop:6,fontSize:11,color:"var(--know)"}}>
                  {"🔥".repeat(Math.min(card.srsStreak,5))} {card.srsStreak} streak
                </div>
              )}
              {card.forms?.harf&&(
                <div style={{display:"inline-flex",alignItems:"center",gap:5,marginTop:7,background:"var(--harf-bg)",border:"1px solid var(--harf-border)",borderRadius:100,padding:"3px 11px"}}>
                  <span style={{fontSize:11.5,color:"var(--harf)"}}>حرف الجر</span>
                  <span className="ar" style={{fontSize:17,color:"var(--harf)",fontWeight:600}}>{card.forms.harf}</span>
                </div>
              )}
              <div style={{fontSize:11,color:"var(--text3)",marginTop:14,fontWeight:500}}>↻ Tap to flip back</div>
            </div>
          </div>
        </div>
        {/* Expanded back content — GRAMMAR cards: full explanation + examples with audio */}
        {flipped&&isGrammar&&(
          <div className="gen-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"18px 17px",boxShadow:"0 5px 24px rgba(0,0,0,0.08)",display:"flex",flexDirection:"column",gap:12}}>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"var(--harf)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:7}}>✦ The Concept</div>
              <div style={{fontSize:14.5,color:"var(--text)",lineHeight:1.65,whiteSpace:"pre-wrap"}}>{grammar.explanation}</div>
            </div>
            {(grammar.examples||[]).length>0&&(
              <div style={{display:"flex",flexDirection:"column",gap:9}}>
                <div style={{fontSize:10,fontWeight:700,color:"var(--accent)",letterSpacing:".1em",textTransform:"uppercase"}}>✦ Examples</div>
                {grammar.examples.map((ex,i)=>(
                  <div key={i} style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rs)",padding:"11px 13px"}}>
                    <div style={{display:"flex",alignItems:"flex-start",gap:9}}>
                      <div style={{flex:1}}>
                        <ClickableArabic text={ex.ar} highlightWords={card.arabicBase?[card.arabicBase]:[]} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={20}/>
                        <div style={{fontSize:12.5,color:"var(--text2)",fontStyle:"italic",marginTop:5}}>{ex.en}</div>
                      </div>
                      <button className="btn btn-ghost" title="Play audio"
                        onClick={(e)=>{e.stopPropagation();
                          if(playingEx===i){stopTtsAudio();setPlayingEx(-1);return;}
                          stopTtsAudio();
                          synthesizeArabic(ex.ar,{onStart:()=>setPlayingEx(i),onEnd:()=>setPlayingEx(-1)});
                        }}
                        style={{width:34,height:34,flexShrink:0,color:playingEx===i?"white":"var(--accent)",background:playingEx===i?"var(--accent)":"transparent",border:"1.5px solid var(--accent)",borderRadius:"50%"}}>
                        <Volume2 size={14}/>
                      </button>
                    </div>
                  </div>
                ))}
                <div style={{fontSize:11,color:"var(--text3)"}}>💡 Tap any Arabic word to look it up</div>
              </div>
            )}
          </div>
        )}
        {/* Expanded back content (forms, generate, audio) — only when flipped */}
        {flipped&&!isGrammar&&(
          <div className="gen-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"18px 17px",boxShadow:"0 5px 24px rgba(0,0,0,0.08)"}}>
            <div className="sec">Select a form</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:12}}>
              {availForms
                .filter(([k])=>k!=="harf")
                .sort((a,b)=>{
                  const order=["past","present","future","imperative","masdar","activePart","passivePart","singular","plural","plural2","masculine","feminine","synonym","synonymPlural","antonym","antonymPlural"];
                  return (order.indexOf(a[0])===-1?99:order.indexOf(a[0]))-(order.indexOf(b[0])===-1?99:order.indexOf(b[0]));
                })
                .map(([key,val])=>{
                  const isWeak=(card.weakForms||[]).includes(key);
                  const canFlag=INFLECTIONAL_FORMS.has(key);
                  return (
                  <button key={key} className={`chip ${selForm===key?"chip-on":""}`} onClick={()=>{setSelForm(key);setGen(null);}} style={{padding:"8px 14px"}}>
                    {canFlag&&<span onClick={(e)=>{e.stopPropagation();onToggleWeakForm?.(card.id,key);}}
                      title={isWeak?"Marked weak — tap to clear":"Tap to flag this form weak"}
                      style={{color:isWeak?(selForm===key?"rgba(255,200,200,.9)":"var(--weak)"):(selForm===key?"rgba(255,255,255,.4)":"var(--border)"),fontSize:13,marginRight:1,cursor:"pointer"}}>{isWeak?"●":"○"}</span>}
                    {FORM_LABELS[key]}<span className="ar" style={{fontSize:16,color:selForm===key?"rgba(255,255,255,.75)":"var(--text2)",fontWeight:500}}>· {val}</span>
                  </button>
                  );
                })}
            </div>
            {selForm&&(
              <div style={{textAlign:"center",background:"var(--accent-bg)",borderRadius:"var(--rxs)",padding:"9px 13px",marginBottom:12}}>
                <div style={{fontSize:11,color:"var(--text3)",marginBottom:3}}>{FORM_LABELS[selForm]} · <span className="ar" style={{fontSize:12}}>{FORM_ARABIC[selForm]}</span></div>
                <div className="ar" style={{fontSize:28,color:"var(--accent)",fontWeight:500}}>{card.forms[selForm]}</div>
              </div>
            )}
            <button className="btn btn-primary" onClick={generate} disabled={genLoading||!selForm} style={{width:"100%",padding:"12px",borderRadius:"var(--rs)",fontSize:14,marginBottom:gen?12:0}}>
              {genLoading?<><RefreshCw size={14} className="spin"/>Generating…</>:<><Sparkles size={14}/>Generate Learning Aid</>}
            </button>
            {gen&&!genLoading&&(
              <div className="gen-appear" style={{display:"flex",flexDirection:"column",gap:10}}>
                {gen.error&&(
                  <div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rs)",padding:"10px 13px",display:"flex",alignItems:"center",gap:10,fontSize:13}}>
                    <span style={{fontSize:18}}>⚠️</span>
                    <div style={{flex:1,color:"var(--weak)",lineHeight:1.5}}>
                      <div style={{fontWeight:600,marginBottom:2}}>Couldn't generate fully</div>
                      <div style={{fontSize:12,color:"var(--text3)"}}>{gen.error}</div>
                    </div>
                    <button className="btn" onClick={()=>generate(null)} style={{background:"var(--weak)",color:"white",fontSize:12,padding:"6px 12px",borderRadius:"var(--rxs)"}}>
                      <RefreshCw size={12}/> Retry
                    </button>
                  </div>
                )}
                {/* Image — Nano Banana generated, skeleton while loading, or scene description fallback */}
                {imgLoading?(
                  <div style={{position:"relative",width:"100%",aspectRatio:"1",background:"linear-gradient(110deg,var(--surface2) 30%,var(--border) 50%,var(--surface2) 70%)",backgroundSize:"200% 100%",animation:"shimmer 2s linear infinite",border:"1px solid var(--border)",borderRadius:"var(--rs)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8}}>
                    <RefreshCw size={20} className="spin" color="var(--text3)"/>
                    <div style={{fontSize:12,color:"var(--text3)",fontWeight:500}}>Drawing with Nano Banana…</div>
                    <div style={{fontSize:10,color:"var(--text3)",opacity:.7}}>usually 3-5 seconds</div>
                  </div>
                ):gen.imageUrl?(
                  <div style={{position:"relative"}}>
                    <img src={gen.imageUrl} alt={`Scene for ${card.english}`} style={{width:"100%",display:"block",borderRadius:"var(--rs)",border:"1px solid var(--border)"}}/>
                    <button
                      onClick={async()=>{
                        if(!gen.imagePrompt) return;
                        setImgLoading(true);
                        const url=await generateImage(gen.imagePrompt,trackUsage);
                        setGen(prev=>prev?{...prev,imageUrl:url}:prev);
                        setImgLoading(false);
                      }}
                      title={`Regenerate this image · costs ~$${(IMAGE_PRICES[_imageModel]||0.039).toFixed(3)}`}
                      style={{position:"absolute",top:8,right:8,width:32,height:32,borderRadius:"50%",background:"rgba(0,0,0,.55)",color:"white",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}>
                      <RefreshCw size={14}/>
                    </button>
                  </div>
                ):gen.imagePrompt?(
                  // No image yet — opt-in button so the user only spends
                  // ~$0.039 when they actually want a picture for this card.
                  <button
                    onClick={async()=>{
                      if(!gen.imagePrompt) return;
                      setImgLoading(true);
                      const url=await generateImage(gen.imagePrompt,trackUsage);
                      setGen(prev=>prev?{...prev,imageUrl:url}:prev);
                      setImgLoading(false);
                    }}
                    style={{background:"var(--surface2)",border:"1px dashed var(--border)",borderRadius:"var(--rs)",padding:"14px 16px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:13,color:"var(--text2)",fontWeight:500,width:"100%"}}>
                    <ImageIcon size={15}/> Add a mnemonic image
                    <span style={{fontSize:11,color:"var(--text3)",fontWeight:400,fontFamily:"monospace"}}>~${(IMAGE_PRICES[_imageModel]||0.039).toFixed(3)}</span>
                  </button>
                ):null}
                <div style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
                  <div style={{fontSize:10,fontWeight:700,color:"var(--accent)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:7}}>✦ Example Sentence</div>
                  <ClickableArabic text={gen.sentence} highlightWords={[card.forms[selForm]||card.arabicBase]} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={22}/>
                  <div style={{fontSize:11,color:"var(--text3)",marginTop:4,marginBottom:6}}>💡 Tap any word to look it up</div>
                  <div style={{fontSize:13,color:"var(--text2)",fontStyle:"italic"}}>{gen.translation}</div>
                </div>
                <button className="btn" onClick={playAudio}
                  style={{background:playing?"var(--accent)":"transparent",color:playing?"white":"var(--accent)",border:"1.5px solid var(--accent)",borderRadius:"var(--rs)",padding:"11px",width:"100%",fontSize:13.5,fontWeight:600}}>
                  <Volume2 size={15}/> {playing?"Playing… (tap to stop)":"▶ Play Arabic Audio"}
                </button>
                <button className="btn" onClick={()=>generate(gen?.sentence)} style={{background:"transparent",color:"var(--text3)",fontSize:12,padding:"4px",width:"100%"}}><RefreshCw size={11}/>Fresh example</button>
              </div>
            )}
          </div>
        )}
        {flipped&&(
          <div style={{display:"flex",gap:10}}>
            <button className="btn" onClick={()=>onSwipe("left",card.id,testForm||selForm)} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--weak-bg)",color:"var(--weak)",border:"1.5px solid var(--weak-border)",fontWeight:600,fontSize:13.5}}>← Needs Practice</button>
            <button className="btn" onClick={()=>onSwipe("right",card.id,testForm||selForm)} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--know-bg)",color:"var(--know)",border:"1.5px solid var(--know-border)",fontWeight:600,fontSize:13.5}}>Know It →</button>
          </div>
        )}
        {!flipped&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:12.5,marginTop:"auto"}}>Tap the card to reveal Arabic · <span className="kbd">Space</span></div>}
        {flipped&&(
          <div style={{textAlign:"center",color:"var(--text3)",fontSize:11,marginTop:4,display:"flex",justifyContent:"center",gap:12}}>
            <span><span className="kbd">←</span> Weak</span>
            <span><span className="kbd">→</span> Know</span>
            <span><span className="kbd">↑</span> Back</span>
          </div>
        )}
      </div>
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks||[]} cardStates={cardStates||{}} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// COMPLETE
// ─────────────────────────────────────────────────────────────
function CompleteScreen({known,weak,onBack}) {
  const total=known+weak;
  const pct=total>0?Math.round((known/total)*100):0;
  return (
    <div className="screen" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",padding:28,textAlign:"center"}}>
      <div className="pop-appear" style={{width:"100%",maxWidth:340}}>
        <div style={{fontSize:52,marginBottom:14}}>{pct>=80?"🌟":pct>=50?"✦":"💪"}</div>
        <div style={{fontFamily:"Lora,serif",fontSize:26,fontWeight:600,marginBottom:8}}>Session Complete</div>
        <div style={{fontSize:14,color:"var(--text2)",marginBottom:16}}>
          <span style={{color:"var(--know)",fontWeight:700}}>{known} known</span> · <span style={{color:"var(--weak)",fontWeight:700}}>{weak} need practice</span>
        </div>
        {/* Accuracy bar */}
        <div style={{marginBottom:24}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"var(--text3)",marginBottom:4}}>
            <span>Accuracy</span><span style={{fontWeight:700,color:pct>=70?"var(--know)":"var(--weak)"}}>{pct}%</span>
          </div>
          <div className="progress-track" style={{height:6}}>
            <div className="progress-fill" style={{width:`${pct}%`,background:pct>=70?"var(--know)":"var(--weak)"}}/>
          </div>
        </div>
        <div style={{fontSize:12.5,color:"var(--text3)",marginBottom:24,lineHeight:1.6}}>
          {pct>=80?"Excellent recall! Cards will be spaced further apart."
           :pct>=50?"Good progress. Weak cards will appear sooner in your next session."
           :"Keep practicing! Weak cards are scheduled for immediate review."}
        </div>
        <button className="btn btn-primary" onClick={onBack} style={{width:"100%",padding:"14px 28px",borderRadius:"var(--r)",fontSize:15}}>Back to Deck</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SHARED: Multi-deck + multi-card selector (used by Reading & Listening)
// ─────────────────────────────────────────────────────────────
function MultiDeckCardSelector({decks:allDecks,cardStates,selDeckIds,setSelDeckIds,selCardIds,setSelCardIds,accentVar,accentBgVar,accentBorderVar,onReset}) {
  // Grammar-rule decks aren't vocabulary — keep them out of the vocab-driven
  // modules (reading/listening/conversation) so passages stay word-grounded.
  const decks=allDecks.filter(d=>d.deckType!=="grammar");
  const [showDeckPicker,setShowDeckPicker]=useState(true);
  const [showCardPicker,setShowCardPicker]=useState(false);

  // All cards pooled from selected decks (stable, deduped by id)
  const pooledCards = decks
    .filter(d=>selDeckIds.has(d.id))
    .flatMap(d=>(cardStates[d.id]||[]).map(c=>({...c,_deckTitle:d.title})));

  const toggleDeck=(id)=>{
    setSelDeckIds(prev=>{
      const n=new Set(prev);
      if(n.has(id)){
        if(n.size===1) return n; // keep at least one
        n.delete(id);
        // deselect cards from that deck
        const dcIds=new Set((cardStates[id]||[]).map(c=>c.id));
        setSelCardIds(p=>{const s=new Set(p);dcIds.forEach(cid=>s.delete(cid));return s;});
      } else {
        n.add(id);
        // auto-select all cards from newly added deck
        const newIds=(cardStates[id]||[]).map(c=>c.id);
        setSelCardIds(p=>new Set([...p,...newIds]));
      }
      onReset&&onReset();
      return n;
    });
  };

  const toggleCard=(id)=>setSelCardIds(p=>{const n=new Set(p);n.has(id)?n.delete(id):n.add(id);onReset&&onReset();return n;});
  const selectAllCards=()=>{setSelCardIds(new Set(pooledCards.map(c=>c.id)));onReset&&onReset();};
  const clearAllCards=()=>{setSelCardIds(new Set());onReset&&onReset();};
  const selectAllDecks=()=>{
    setSelDeckIds(new Set(decks.map(d=>d.id)));
    setSelCardIds(new Set(decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id))));
    onReset&&onReset();
  };
  const clearAllDecks=()=>{
    setSelDeckIds(new Set());
    setSelCardIds(new Set());
    onReset&&onReset();
  };
  const selectByStatus=(status)=>{setSelCardIds(new Set(pooledCards.filter(c=>status==="new"?(c.status==="new"||!c.status):c.status===status).map(c=>c.id)));onReset&&onReset();};
  const weakCount=pooledCards.filter(c=>c.status==="weak").length;
  const knownCount=pooledCards.filter(c=>c.status==="known").length;
  const newCount=pooledCards.filter(c=>c.status==="new"||!c.status).length;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {/* Deck picker */}
      <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",overflow:"hidden"}}>
        <div style={{padding:"11px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",borderBottom:showDeckPicker?"1px solid var(--border)":"none"}} onClick={()=>setShowDeckPicker(v=>!v)}>
          <div>
            <div style={{fontSize:13.5,fontWeight:600,color:"var(--text)"}}>Decks</div>
            <div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{selDeckIds.size} of {decks.length} selected · {pooledCards.length} cards pooled</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontSize:11,background:`var(${accentBgVar})`,color:`var(${accentVar})`,padding:"2px 8px",borderRadius:100,border:`1px solid var(${accentBorderVar})`}}>{selDeckIds.size} deck{selDeckIds.size!==1?"s":""}</span>
            {showDeckPicker?<ChevronUp size={14} color="var(--text3)"/>:<ChevronDown size={14} color="var(--text3)"/>}
          </div>
        </div>
        {showDeckPicker&&(
          <div style={{padding:"10px 14px",display:"flex",flexDirection:"column",gap:7}}>
            <div style={{display:"flex",gap:6,marginBottom:3}}>
              <button className="btn btn-sm" onClick={selectAllDecks} disabled={selDeckIds.size===decks.length} style={{background:`var(${accentBgVar})`,color:`var(${accentVar})`,border:`1px solid var(${accentBorderVar})`,opacity:selDeckIds.size===decks.length?0.5:1}}>Select All</button>
              <button className="btn btn-sm" onClick={clearAllDecks} disabled={selDeckIds.size===0} style={{background:"var(--surface2)",color:"var(--text2)",opacity:selDeckIds.size===0?0.5:1}}>Clear All</button>
            </div>
            {decks.map(d=>{
              const on=selDeckIds.has(d.id);
              const count=(cardStates[d.id]||[]).length;
              return (
                <div key={d.id} onClick={()=>toggleDeck(d.id)} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",padding:"8px 10px",borderRadius:"var(--rxs)",border:`1.5px solid ${on?`var(${accentVar})`:"var(--border)"}`,background:on?`var(${accentBgVar})`:"transparent",transition:"all .13s"}}>
                  <div className={`chk ${on?"on":""}`} style={{width:17,height:17}}>{on&&<Check size={10} color="white"/>}</div>
                  <div style={{flex:1}}>
                    <span style={{fontSize:13.5,fontWeight:600,color:on?`var(${accentVar})`:"var(--text)"}}>{d.title}</span>
                  </div>
                  <span style={{fontSize:11.5,color:"var(--text3)"}}>{count} cards</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Card picker — pooled from all selected decks */}
      {pooledCards.length>0&&(
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",overflow:"hidden"}}>
          <div style={{padding:"11px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",borderBottom:showCardPicker?"1px solid var(--border)":"none"}} onClick={()=>setShowCardPicker(v=>!v)}>
            <div>
              <div style={{fontSize:13.5,fontWeight:600,color:"var(--text)"}}>Cards</div>
              <div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{selCardIds.size} of {pooledCards.length} selected</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:11,background:`var(${accentBgVar})`,color:`var(${accentVar})`,padding:"2px 8px",borderRadius:100,border:`1px solid var(${accentBorderVar})`}}>{selCardIds.size} cards</span>
              {showCardPicker?<ChevronUp size={14} color="var(--text3)"/>:<ChevronDown size={14} color="var(--text3)"/>}
            </div>
          </div>
          {showCardPicker&&(
            <div style={{padding:"10px 14px"}}>
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                <button className="btn btn-sm" onClick={selectAllCards} style={{background:`var(${accentBgVar})`,color:`var(${accentVar})`,border:`1px solid var(${accentBorderVar})`}}>All ({pooledCards.length})</button>
                {weakCount>0&&<button className="btn btn-sm" onClick={()=>selectByStatus("weak")} style={{background:"var(--weak-bg)",color:"var(--weak)",border:"1px solid var(--weak-border)"}}>Weak ({weakCount})</button>}
                {knownCount>0&&<button className="btn btn-sm" onClick={()=>selectByStatus("known")} style={{background:"var(--know-bg)",color:"var(--know)",border:"1px solid var(--know-border)"}}>Known ({knownCount})</button>}
                {newCount>0&&<button className="btn btn-sm" onClick={()=>selectByStatus("new")} style={{background:"var(--surface2)",color:"var(--text3)",border:"1px solid var(--border)"}}>New ({newCount})</button>}
                <button className="btn btn-sm" onClick={clearAllCards} style={{background:"var(--surface2)",color:"var(--text2)"}}>Clear</button>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:260,overflowY:"auto"}}>
                {/* Group by deck */}
                {decks.filter(d=>selDeckIds.has(d.id)).map(d=>{
                  const dc=cardStates[d.id]||[];
                  if(!dc.length) return null;
                  return (
                    <div key={d.id}>
                      <div style={{fontSize:10,fontWeight:700,color:"var(--text3)",letterSpacing:".1em",textTransform:"uppercase",padding:"6px 4px 4px"}}>{d.title}</div>
                      {dc.map(c=>{
                        const on=selCardIds.has(c.id);
                        return (
                          <div key={c.id} onClick={()=>toggleCard(c.id)} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",padding:"7px 4px",borderRadius:"var(--rxs)",background:on?`var(${accentBgVar})`:"transparent",transition:"background .12s"}}>
                            <div className={`chk ${on?"on":""}`} style={{width:16,height:16}}>{on&&<Check size={10} color="white"/>}</div>
                            <div style={{flex:1}}>
                              <span style={{fontSize:13.5,fontWeight:600,color:"var(--text)"}}>{c.english}</span>
                              <span className="ar" style={{fontSize:16,color:`var(${accentVar})`,marginRight:8}}> · {c.arabicBase}</span>
                            </div>
                            {c.status&&c.status!=="new"&&<span className={`tag tag-${c.status}`} style={{fontSize:10}}>{c.status==="weak"?"Weak":"Known"}</span>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// READING — multi-deck + multi-card pool
// ─────────────────────────────────────────────────────────────
function ReadingScreen({decks,cardStates,onBack,onFinish,onAddToFlashcard,trackUsage,onLogStudy,master,masterPool}) {
  const SCREEN_NAME=master?"masterReading":"reading";
  const saved=useRef(loadScreen(SCREEN_NAME)||{}).current;
  const screenStart=useRef(Date.now());
  useEffect(()=>{screenStart.current=Date.now();return ()=>{
    const mins=Math.max(1,Math.round((Date.now()-screenStart.current)/60000));
    if(mins>=1&&onLogStudy) onLogStudy({type:"app",module:"reading",minutes:mins});
  };},[]);
  const [showSettings,setShowSettings]=useState(false);
  const [settings,setSettings]=useState(saved.settings||{length:"short",difficulty:"beginner",showTranslation:false,highlightVocab:true});
  const setSetting=(k,v)=>setSettings(p=>({...p,[k]:v}));

  // Multi-deck selection — all decks selected by default (or restored)
  const [selDeckIds,setSelDeckIds]=useState(()=>new Set(saved.selDeckIds||decks.map(d=>d.id)));
  const allInitCards=decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id));
  const [selCardIds,setSelCardIds]=useState(()=>new Set(saved.selCardIds||allInitCards));

  const [passage,setPassage]=useState(saved.passage||null);
  const [generating,setGenerating]=useState(false);
  const [showTranslation,setShowTranslation]=useState(false);
  const passageRef=useRef(null);
  const [wordPopup,setWordPopup]=useState(null);
  const [showMiniRating,setShowMiniRating]=useState(false);
  const [topics,setTopics]=useState(saved.topics||[]);
  const [activeTopic,setActiveTopic]=useState(saved.activeTopic||"");
  const [topicsLoading,setTopicsLoading]=useState(false);

  // Persist screen state on change
  useEffect(()=>{
    saveScreen(SCREEN_NAME,{settings,selDeckIds:[...selDeckIds],selCardIds:[...selCardIds],passage,topics,activeTopic});
  },[settings,selDeckIds,selCardIds,passage,topics,activeTopic,SCREEN_NAME]);

  const handleNextPassage=()=>{
    if(passage){setShowMiniRating(true);} else generateWithTopic(activeTopic);
  };
  const submitMiniRating=(rating)=>{
    if(rating&&onLogStudy) onLogStudy({type:"app",module:"reading",minutes:0,rating,master:!!master});
    setShowMiniRating(false);generateWithTopic(activeTopic);
  };

  // Derive selected cards from pool
  const now=Date.now();
  const allPooled = decks.filter(d=>selDeckIds.has(d.id)).flatMap(d=>(cardStates[d.id]||[])).filter(c=>selCardIds.has(c.id));
  const selectedCards = master&&masterPool&&masterPool!=="all"
    ? allPooled.filter(c=>masterPool==="weak"?c.status==="weak":masterPool==="due"?(c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now):true)
    : allPooled;

  const deckNames = decks.filter(d=>selDeckIds.has(d.id)).map(d=>d.title).join(" + ");
  const poolLabel = master?(masterPool==="weak"?"weak":masterPool==="due"?"due":"all"):"";

  // Generate topics from selected vocab, then auto-generate first passage
  const generateTopics=async()=>{
    if(!selectedCards.length){showToast("Select at least one card.","error");return;}
    setTopicsLoading(true);
    const vocabSample=[...selectedCards].sort(()=>Math.random()-0.5).slice(0,25).map(c=>c.english).join(", ");
    let t;
    try {
      const raw=await callClaude(`Generate 5 short reading topic titles (5-8 words each, in English) for an Arabic learner. Use themes typical of the Al-Arabiyya Bayna Yadayk curriculum — everyday Arab/Muslim life: family, food, the masjid, the market, neighbors, travel, prayer times, hospitality, school, work, holidays. Topics should naturally use these vocabulary words: ${vocabSample}. Return ONLY a JSON array: ["topic1","topic2","topic3","topic4","topic5"]`,200,"other",trackUsage);
      const parsed=extractJSON(raw);
      t=Array.isArray(parsed)?parsed:["Daily life","A trip to the market","School and learning","Family gathering","City exploration"];
    } catch {
      t=["Daily life","A trip to the market","School and learning","Family gathering","City exploration"];
    }
    setTopics(t);setActiveTopic("");setTopicsLoading(false);
  };

  const switchTopic=(topic)=>{
    setActiveTopic(topic);setPassage(null);
  };

  const generateWithTopic=async(topic)=>{
    if(!selectedCards.length) return;
    setGenerating(true);setPassage(null);setShowTranslation(settings.showTranslation);
    const baseLenMap={short:"60-80",medium:"110-140",long:"180-220"};
    const MAX_VOCAB=20;
    let vocabCards=selectedCards;
    if(vocabCards.length>MAX_VOCAB) vocabCards=[...vocabCards].sort(()=>Math.random()-0.5).slice(0,MAX_VOCAB);
    const scaleFactor=Math.max(1,vocabCards.length/10);
    const scaleLen=(range)=>{const[lo,hi]=range.split("-").map(Number);return `${Math.round(lo*scaleFactor)}-${Math.round(hi*scaleFactor)}`;};
    const targetLen=scaleLen(baseLenMap[settings.length]||"110-140");
    // Token budget scales with difficulty — advanced passages need more headroom
    // because tashkeel-heavy + complex syntax burns tokens fast, and the JSON
    // wrapper truncates if we're stingy. Generous ceiling for advanced.
    const diffMult=settings.difficulty==="advanced"?2.0:settings.difficulty==="intermediate"?1.5:1.0;
    const maxTok=Math.min(8000,Math.max(2200,Math.round(vocabCards.length*120*diffMult)));
    const topicClause=topic?`\nTopic/theme: "${topic}" — write the passage about this topic.`:"";
    // Bonus pool of words the learner has already studied — the LLM may use these
    // naturally, but they must NOT appear in vocabUsed (which drives highlighting).
    const learnedPool=Object.values(cardStates).flat().filter(c=>c.status==="known"||c.status==="weak");
    const learnedSample=[...learnedPool].sort(()=>Math.random()-0.5).slice(0,80).map(c=>c.arabicBase).join("، ");
    // Required vocab — pass ALL forms the card has, so the LLM can pick the
    // form that fits the sentence (past/present/imperative/masdar/plural/etc.)
    // rather than awkwardly forcing the base form everywhere.
    const formsBlock=vocabCards.map(c=>{
      const formStrs=Object.entries(c.forms||{}).filter(([k,v])=>v&&k!=="harf").map(([k,v])=>`${k}=${v}`).join(", ");
      return `• ${c.arabicBase} (${c.english}) — any of: ${formStrs||c.arabicBase}`;
    }).join("\n");
    try {
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

═══ PASSAGE BRIEF ═══

Deck: ${deckNames}
Target length: ~${targetLen} words
Difficulty register: ${settings.difficulty} (use the matching register from the style guide above)${topicClause}

REQUIRED VOCABULARY — every base entry must appear in the passage at least once. Use ANY form that fits the sentence naturally, BUT bias strongly toward the forms native speakers actually use in everyday MSA (past, present, imperative, masdar, singular, plural, feminine where applicable) — those should cover ~90–95% of your choices. Reach for less common forms (passive participle, less common synonyms/antonyms, broken-plural variants) ONLY when the sentence truly calls for it. Never use a rare form just because it appears in the form list — if it would feel forced or textbook-y, use the common form instead:
${formsBlock}

EXTRA VOCABULARY YOU MAY WEAVE IN (no obligation, do NOT force):
${learnedSample||"(none)"}

ADDITIONAL VOCABULARY BEYOND THE DECK is welcome when the prose needs it — stay within one register-band above the learner's level. Real prose beats stuck-on-deck prose. But never use a word so far above the learner's level that the passage becomes unreadable.

═══ OUTPUT CONTRACT ═══

Return ONLY valid JSON. Put "vocabUsed" FIRST so it survives even if the body is truncated.

{
  "vocabUsed": [...],   // ONLY the base forms (arabicBase) from the REQUIRED VOCABULARY list that you actually used. Do NOT include extra-vocabulary words. Do NOT include bonus-pool words. Used for in-passage highlighting — be precise.
  "arabic": "...",      // The passage itself, fully tashkeel'd, ~${targetLen} words
  "translation": "..."  // Faithful English translation
}

REMINDERS — non-negotiable:
- Every Arabic letter carries tashkeel. No bare letters anywhere.
- Read it back to yourself: does it sound like a real Bayna-Yadayk passage or an Al-Nadwī narrative? If yes, ship. If not, restructure.
- Coherent scene, named character(s) from the recurring cast, real setting, natural flow.
- Grammatically correct idiomatic MSA — case endings, agreement, mood after لا النافية vs لا الناهية all correct.`,
        maxTok,"reading",trackUsage
      );
      setPassage(extractJSON(raw));
      setTimeout(()=>passageRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),120);
      showToast("Passage ready","success");
    } catch (err) {
      setPassage({arabic:"حَدَثَ خَطَأٌ. يُرْجَى الْمُحَاوَلَةُ مَرَّةً أُخْرَى.",translation:"A generation error occurred.",vocabUsed:[]});
      showToast(`Couldn't generate passage: ${err?.message||"unknown error"}`,"error");
    } finally { setGenerating(false); }
  };

  return (
    <div className="screen">
      <Hdr title={master?"Master Reading":"Reading"} sub="Practice" onBack={onBack}
        right={<button className="btn btn-ghost" onClick={()=>setShowSettings(v=>!v)} style={{width:34,height:34}}><Sliders size={15}/></button>}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:16}}>
        {showSettings&&(
          <div className="gen-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 16px"}}>
            <div className="sec" style={{marginBottom:12}}>Module Settings</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div><label className="lbl">Passage Length</label><Seg options={[{value:"short",label:"Short"},{value:"medium",label:"Medium"},{value:"long",label:"Long"}]} value={settings.length} onChange={v=>setSetting("length",v)}/></div>
              <div><label className="lbl">Difficulty</label><Seg options={[{value:"beginner",label:"Beginner"},{value:"intermediate",label:"Intermediate"},{value:"advanced",label:"Advanced"}]} value={settings.difficulty} onChange={v=>setSetting("difficulty",v)}/></div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13.5,color:"var(--text2)"}}>Show translation by default</span>
                <div className={`chk ${settings.showTranslation?"on":""}`} onClick={()=>setSetting("showTranslation",!settings.showTranslation)}>{settings.showTranslation&&<Check size={11} color="white"/>}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13.5,color:"var(--text2)"}}>Highlight vocabulary</span>
                <div className={`chk ${settings.highlightVocab?"on":""}`} onClick={()=>setSetting("highlightVocab",!settings.highlightVocab)}>{settings.highlightVocab&&<Check size={11} color="white"/>}</div>
              </div>
            </div>
          </div>
        )}

        {!master&&<MultiDeckCardSelector
          decks={decks} cardStates={cardStates}
          selDeckIds={selDeckIds} setSelDeckIds={setSelDeckIds}
          selCardIds={selCardIds} setSelCardIds={setSelCardIds}
          accentVar="--read" accentBgVar="--read-bg" accentBorderVar="--read-border"
          onReset={()=>{setPassage(null);setTopics([]);setActiveTopic("");}}
        />}
        {master&&<div style={{background:"var(--read-bg)",border:"1px solid var(--read-border)",borderRadius:"var(--rs)",padding:"10px 14px",fontSize:13,color:"var(--read)",fontWeight:500}}>Using {selectedCards.length} {poolLabel} vocabulary words · Master session</div>}

        {!topics.length?(
          <button className="btn btn-read" onClick={generateTopics} disabled={generating||topicsLoading||!selectedCards.length} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
            {topicsLoading?<><RefreshCw size={14} className="spin"/>Finding topics…</>:<><FileText size={15}/>Choose Topic for {selectedCards.length} Cards</>}
          </button>
        ):(
          <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"10px 12px"}}>
            <div className="sec" style={{marginBottom:6}}>Topic {!activeTopic&&<span style={{color:"var(--accent)",fontWeight:400,letterSpacing:0,textTransform:"none"}}>— pick one to generate</span>}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {topics.map((t,i)=>(
                <button key={i} className={`chip ${activeTopic===t?"chip-on":""}`} onClick={()=>switchTopic(t)} disabled={generating}
                  style={{fontSize:12,padding:"5px 11px"}}>{i===0?"⭐ ":""}{t}</button>
              ))}
            </div>
            {activeTopic&&!passage&&!generating&&(
              <button className="btn btn-read" onClick={()=>generateWithTopic(activeTopic)} style={{width:"100%",padding:"12px",borderRadius:"var(--rs)",fontSize:13,marginTop:10}}>
                <FileText size={14}/> Generate: {activeTopic}
              </button>
            )}
            {generating&&(
              <div style={{background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"16px",display:"flex",flexDirection:"column",alignItems:"center",gap:10,marginTop:10}}>
                <RefreshCw size={20} className="spin" color="var(--read)"/>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--text)"}}>Writing your passage…</div>
                <div style={{fontSize:11.5,color:"var(--text3)",textAlign:"center",lineHeight:1.5}}>Usually 8-15 seconds depending on length.<br/>Sit tight — full tashkeel takes a moment.</div>
                <div style={{width:"100%",height:3,background:"var(--border)",borderRadius:2,overflow:"hidden",marginTop:4}}>
                  <div style={{height:"100%",background:"var(--read)",animation:"loadbar 12s linear forwards"}}/>
                </div>
              </div>
            )}
          </div>
        )}

        {passage&&!generating&&(
          <div ref={passageRef} className="gen-appear" style={{display:"flex",flexDirection:"column",gap:12,scrollMarginTop:14}}>
            <div style={{background:"var(--surface)",border:"1.5px solid var(--read-border)",borderRadius:"var(--r)",padding:"20px 18px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div className="sec" style={{margin:0,color:"var(--read)"}}>Arabic Passage</div>
                {passage.vocabUsed?.length>0&&settings.highlightVocab&&(
                  <span style={{fontSize:11,color:"var(--read)",background:"var(--read-bg)",padding:"2px 8px",borderRadius:100,border:"1px solid var(--read-border)"}}>{passage.vocabUsed.length} vocab words</span>
                )}
              </div>
              <ClickableArabic text={passage.arabic} highlightWords={settings.highlightVocab?(passage.vocabUsed||[]):[]} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={20}/>
              <div style={{marginTop:12,fontSize:12,color:"var(--text3)"}}>💡 Tap any Arabic word to look it up</div>
            </div>
            <button className="btn" onClick={()=>setShowTranslation(v=>!v)}
              style={{background:"transparent",color:"var(--read)",border:"1.5px solid var(--read-border)",borderRadius:"var(--rs)",padding:"10px",width:"100%",fontSize:13,fontWeight:600}}>
              {showTranslation?<><EyeOff size={14}/>Hide Translation</>:<><Globe size={14}/>Show English Translation</>}
            </button>
            {showTranslation&&(
              <div className="gen-appear" style={{background:"var(--read-bg)",border:"1px solid var(--read-border)",borderRadius:"var(--rs)",padding:"16px"}}>
                <div className="sec" style={{margin:0,marginBottom:8,color:"var(--read)"}}>English Translation</div>
                <div style={{fontSize:14,color:"var(--text2)",lineHeight:1.75}}>{passage.translation}</div>
              </div>
            )}
            <div style={{display:"flex",gap:8}}>
              <button className="btn" onClick={()=>window.scrollTo(0,0)} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"11px",borderRadius:"var(--rs)",fontSize:13,fontWeight:600}}>
                <SkipBack size={14}/> Read Again
              </button>
              <button className="btn btn-read" onClick={handleNextPassage} style={{flex:2,padding:"11px",borderRadius:"var(--rs)",fontSize:13}}>
                <RefreshCw size={14}/> Next Passage
              </button>
            </div>
            <button className="btn" onClick={onFinish} style={{width:"100%",padding:"11px",borderRadius:"var(--rs)",fontSize:13,fontWeight:600,background:"var(--know-bg)",color:"var(--know)",border:"1.5px solid var(--know-border)"}}>
              <CheckCircle2 size={14}/> Finish Session
            </button>
          </div>
        )}
      </div>
      {showMiniRating&&(
        <div className="overlay" onClick={e=>{if(e.target===e.currentTarget) submitMiniRating(null);}}>
          <div className="drawer" style={{textAlign:"center",padding:"24px 20px 32px"}}>
            <div style={{fontSize:15,fontWeight:600,marginBottom:4}}>How was that passage?</div>
            <div style={{fontSize:12,color:"var(--text3)",marginBottom:16}}>Quick rate before the next one</div>
            <div className="rating-stars" style={{marginBottom:16}}>
              {[1,2,3,4,5].map(n=><div key={n} className="rating-star" onClick={()=>submitMiniRating(n)}>{n<=2?"😓":n===3?"😐":n===4?"🙂":"🌟"}</div>)}
            </div>
            <button className="btn" onClick={()=>submitMiniRating(null)} style={{background:"var(--surface2)",color:"var(--text3)",padding:"10px 20px",borderRadius:"var(--rs)",fontSize:13}}>Skip — just give me another</button>
          </div>
        </div>
      )}
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LISTENING — multi-deck + multi-card pool
// ─────────────────────────────────────────────────────────────
function ListeningScreen({decks,cardStates,onBack,onFinish,onAddToFlashcard,trackUsage,onLogStudy,master,masterPool}) {
  const SCREEN_NAME=master?"masterListening":"listening";
  const saved=useRef(loadScreen(SCREEN_NAME)||{}).current;
  const screenStart=useRef(Date.now());
  useEffect(()=>{screenStart.current=Date.now();return ()=>{
    const mins=Math.max(1,Math.round((Date.now()-screenStart.current)/60000));
    if(mins>=1&&onLogStudy) onLogStudy({type:"app",module:"listening",minutes:mins});
  };},[]);
  const [showSettings,setShowSettings]=useState(false);
  const [settings,setSettings]=useState(saved.settings||{length:"short",difficulty:"beginner",speed:0.82,showArabicDefault:false,showEnglishDefault:false,highlightVocab:true});
  const setSetting=(k,v)=>setSettings(p=>({...p,[k]:v}));

  const [selDeckIds,setSelDeckIds]=useState(()=>new Set(saved.selDeckIds||decks.map(d=>d.id)));
  const allInitCards=decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id));
  const [selCardIds,setSelCardIds]=useState(()=>new Set(saved.selCardIds||allInitCards));

  const [content,setContent]=useState(saved.content||null);
  const [generating,setGenerating]=useState(false);
  const [showArabic,setShowArabic]=useState(false);
  const contentRef=useRef(null);
  const [showEnglish,setShowEnglish]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const [showMiniRating,setShowMiniRating]=useState(false);
  const [topics,setTopics]=useState(saved.topics||[]);
  const [activeTopic,setActiveTopic]=useState(saved.activeTopic||"");
  const [topicsLoading,setTopicsLoading]=useState(false);

  useEffect(()=>{
    saveScreen(SCREEN_NAME,{settings,selDeckIds:[...selDeckIds],selCardIds:[...selCardIds],content,topics,activeTopic});
  },[settings,selDeckIds,selCardIds,content,topics,activeTopic,SCREEN_NAME]);

  const handleNextPassage=()=>{if(content){setShowMiniRating(true);}else generateWithTopic(activeTopic);};
  const submitMiniRating=(rating)=>{if(rating&&onLogStudy) onLogStudy({type:"app",module:"listening",minutes:0,rating,master:!!master});setShowMiniRating(false);generateWithTopic(activeTopic);};

  useEffect(()=>()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();},[]);

  const now2=Date.now();
  const allPooled2=decks.filter(d=>selDeckIds.has(d.id)).flatMap(d=>(cardStates[d.id]||[])).filter(c=>selCardIds.has(c.id));
  const selectedCards=master&&masterPool&&masterPool!=="all"
    ?allPooled2.filter(c=>masterPool==="weak"?c.status==="weak":masterPool==="due"?(c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now2):true)
    :allPooled2;
  const poolLabel2=master?(masterPool==="weak"?"weak":masterPool==="due"?"due":"all"):"";
  const deckNames=decks.filter(d=>selDeckIds.has(d.id)).map(d=>d.title).join(" + ");

  const generateTopics=async()=>{
    if(!selectedCards.length){showToast("Select at least one card.","error");return;}
    setTopicsLoading(true);
    const vocabSample=[...selectedCards].sort(()=>Math.random()-0.5).slice(0,25).map(c=>c.english).join(", ");
    let t;
    try {
      const raw=await callClaude(`Generate 5 short listening topic titles (5-8 words, English) for an Arabic learner. Use themes typical of the Al-Arabiyya Bayna Yadayk curriculum — everyday Arab/Muslim life: family meals, the masjid, neighbors, the market, hospitality, travel, prayer, daily routines. Topics should naturally use these vocabulary words: ${vocabSample}. Return ONLY JSON: ["t1","t2","t3","t4","t5"]`,200,"other",trackUsage);
      t=extractJSON(raw);
    } catch {t=["Daily routine","At the market","Weather talk","Neighborhood life","School day"];}
    setTopics(t);setActiveTopic("");setTopicsLoading(false);
  };

  const switchTopic=(topic)=>{setActiveTopic(topic);setContent(null);};

  const generateWithTopic=async(topic)=>{
    if(window.speechSynthesis) window.speechSynthesis.cancel();setPlaying(false);
    if(!selectedCards.length) return;
    setGenerating(true);setContent(null);setShowArabic(settings.showArabicDefault);setShowEnglish(settings.showEnglishDefault);
    const baseLenMap={short:"50-70",medium:"90-120",long:"160-200"};
    const MAX_VOCAB=20;let vocabCards=selectedCards;
    if(vocabCards.length>MAX_VOCAB) vocabCards=[...vocabCards].sort(()=>Math.random()-0.5).slice(0,MAX_VOCAB);
    const scaleFactor=Math.max(1,vocabCards.length/10);
    const scaleLen=(range)=>{const[lo,hi]=range.split("-").map(Number);return `${Math.round(lo*scaleFactor)}-${Math.round(hi*scaleFactor)}`;};
    const targetLen=scaleLen(baseLenMap[settings.length]||"90-120");
    // Same difficulty-aware token sizing as reading — listening passages also
    // truncate JSON when the LLM has to cram tashkeel-heavy advanced prose.
    const diffMult=settings.difficulty==="advanced"?2.0:settings.difficulty==="intermediate"?1.5:1.0;
    const maxTok=Math.min(8000,Math.max(2000,Math.round(vocabCards.length*120*diffMult)));
    const topicClause=topic?`\nTopic/theme: "${topic}" — write about this topic.`:"";
    // Bonus pool — usable naturally but NOT to be highlighted (never in vocabUsed)
    const learnedPool=Object.values(cardStates).flat().filter(c=>c.status==="known"||c.status==="weak");
    const learnedSample=[...learnedPool].sort(()=>Math.random()-0.5).slice(0,80).map(c=>c.arabicBase).join("، ");
    // Pass ALL forms each card has — let the LLM pick whatever form fits the
    // spoken rhythm best.
    const formsBlock=vocabCards.map(c=>{
      const formStrs=Object.entries(c.forms||{}).filter(([k,v])=>v&&k!=="harf").map(([k,v])=>`${k}=${v}`).join(", ");
      return `• ${c.arabicBase} (${c.english}) — any of: ${formStrs||c.arabicBase}`;
    }).join("\n");
    try {
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

═══ LISTENING-PASSAGE BRIEF (read aloud — write for the ear) ═══

Deck: ${deckNames}
Target length: ~${targetLen} words
Difficulty register: ${settings.difficulty} (use the matching register from the style guide above)${topicClause}

REQUIRED VOCABULARY — every base entry must appear at least once. Use ANY form that fits the spoken rhythm, BUT bias strongly toward the forms native speakers actually use in everyday MSA speech (past, present, imperative, masdar, singular, plural, feminine where applicable) — those should cover ~90–95% of your choices. Reach for less common forms (passive participle, less common synonyms/antonyms, broken-plural variants) ONLY when the sentence truly calls for it. Never use a rare form just because it appears in the form list — if it would feel forced or textbook-y, use the common form instead:
${formsBlock}

EXTRA VOCABULARY YOU MAY WEAVE IN (no obligation):
${learnedSample||"(none)"}

ADDITIONAL VOCABULARY BEYOND THE DECK is welcome when the prose needs it — stay within one register-band above the learner's level. Real-sounding speech beats stuck-on-deck speech.

SPOKEN-PASSAGE RULES:
- Short clauses, natural rhythm of speech.
- Vocatives (يَا ...) when characters address each other.
- Real grounding details (a time, a place, a small action).
- 1-2 characters from the cast above.
- Theme fits the learner's level band per the style guide.

═══ OUTPUT CONTRACT ═══

Return ONLY valid JSON. Put "vocabUsed" FIRST so it survives even if the body truncates.

{
  "vocabUsed": [...],   // ONLY the base forms from REQUIRED VOCABULARY that you actually used. Do NOT include extra-vocabulary or bonus-pool words.
  "arabic": "...",      // Fully tashkeel'd Arabic passage, ~${targetLen} words
  "translation": "..."  // Faithful English translation
}

REMINDERS:
- Every Arabic letter carries tashkeel. No bare letters.
- Read it aloud in your head: does it flow like real speech, or like written paragraphs broken up? If the latter, restructure.
- Grammatically correct idiomatic MSA — case endings, agreement, mood after لا النافية vs لا الناهية.`,
        maxTok,"listening",trackUsage
      );
      const parsed=extractJSON(raw);
      setContent(parsed);
      setTimeout(()=>contentRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),120);
      showToast("Listening passage ready","success");
      // Auto-play audio
      setTimeout(()=>{if(parsed.arabic) doPlay(settings.speed);},300);
    } catch (err) {
      setContent({arabic:"حَدَثَ خَطَأٌ.",translation:"An error occurred."});
      showToast(`Couldn't generate: ${err?.message||"unknown error"}`,"error");
    } finally { setGenerating(false); }
  };

  const doPlay=(rate)=>{
    if(!content?.arabic) return;
    // Render TTS at neutral speed and apply the chosen rate via playbackRate, so
    // changing speed later is LIVE (no regeneration / restart) and caches hit.
    const r=rate||settings.speed;
    synthesizeArabic(content.arabic,{speed:1.0,onStart:()=>{setPlaying(true);setTtsPlaybackRate(r);},onEnd:()=>setPlaying(false)});
  };

  const togglePlay=()=>{
    if(!content?.arabic) return;
    if(playing){stopTtsAudio();setPlaying(false);}
    else doPlay(settings.speed);
  };

  return (
    <div className="screen">
      <Hdr title={master?"Master Listening":"Listening"} sub="Practice" onBack={onBack}
        right={<button className="btn btn-ghost" onClick={()=>setShowSettings(v=>!v)} style={{width:34,height:34}}><Sliders size={15}/></button>}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:16}}>
        {showSettings&&(
          <div className="gen-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 16px"}}>
            <div className="sec" style={{marginBottom:12}}>Module Settings</div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div><label className="lbl">Passage Length</label><Seg options={[{value:"short",label:"Short"},{value:"medium",label:"Medium"},{value:"long",label:"Long"}]} value={settings.length} onChange={v=>setSetting("length",v)}/></div>
              <div><label className="lbl">Difficulty</label><Seg options={[{value:"beginner",label:"Beginner"},{value:"intermediate",label:"Intermediate"},{value:"advanced",label:"Advanced"}]} value={settings.difficulty} onChange={v=>setSetting("difficulty",v)}/></div>
              <div>
                <label className="lbl">Audio Speed — {Math.round(settings.speed*100)}%</label>
                <input type="range" min="0.5" max="1.2" step="0.05" value={settings.speed} onChange={e=>{const v=parseFloat(e.target.value);setSetting("speed",v);setTtsPlaybackRate(v);/* live, no restart */}} style={{width:"100%",accentColor:"var(--listen)"}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--text3)",marginTop:3}}><span>Slow</span><span>Normal</span><span>Fast</span></div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13.5,color:"var(--text2)"}}>Show Arabic text by default</span>
                <div className={`chk ${settings.showArabicDefault?"on":""}`} onClick={()=>setSetting("showArabicDefault",!settings.showArabicDefault)}>{settings.showArabicDefault&&<Check size={11} color="white"/>}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13.5,color:"var(--text2)"}}>Show English by default</span>
                <div className={`chk ${settings.showEnglishDefault?"on":""}`} onClick={()=>setSetting("showEnglishDefault",!settings.showEnglishDefault)}>{settings.showEnglishDefault&&<Check size={11} color="white"/>}</div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:13.5,color:"var(--text2)"}}>Highlight vocabulary</span>
                <div className={`chk ${settings.highlightVocab?"on":""}`} onClick={()=>setSetting("highlightVocab",!settings.highlightVocab)}>{settings.highlightVocab&&<Check size={11} color="white"/>}</div>
              </div>
            </div>
          </div>
        )}

        {!master&&<MultiDeckCardSelector
          decks={decks} cardStates={cardStates}
          selDeckIds={selDeckIds} setSelDeckIds={setSelDeckIds}
          selCardIds={selCardIds} setSelCardIds={setSelCardIds}
          accentVar="--listen" accentBgVar="--listen-bg" accentBorderVar="--listen-border"
          onReset={()=>{setContent(null);setTopics([]);setActiveTopic("");if(window.speechSynthesis) window.speechSynthesis.cancel();setPlaying(false);}}
        />}
        {master&&<div style={{background:"var(--listen-bg)",border:"1px solid var(--listen-border)",borderRadius:"var(--rs)",padding:"10px 14px",fontSize:13,color:"var(--listen)",fontWeight:500}}>Using {selectedCards.length} {poolLabel2} vocabulary words · Master session</div>}

        {!topics.length?(
          <button className="btn btn-listen" onClick={generateTopics} disabled={generating||topicsLoading||!selectedCards.length} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
            {topicsLoading?<><RefreshCw size={14} className="spin"/>Finding topics…</>:<><Headphones size={15}/>Choose Topic for {selectedCards.length} Cards</>}
          </button>
        ):(
          <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"10px 12px"}}>
            <div className="sec" style={{marginBottom:6}}>Topic {!activeTopic&&<span style={{color:"var(--listen)",fontWeight:400,letterSpacing:0,textTransform:"none"}}>— pick one to generate</span>}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {topics.map((t,i)=>(
                <button key={i} className={`chip ${activeTopic===t?"chip-on":""}`} onClick={()=>switchTopic(t)} disabled={generating}
                  style={{fontSize:12,padding:"5px 11px"}}>{i===0?"⭐ ":""}{t}</button>
              ))}
            </div>
            {activeTopic&&!content&&!generating&&(
              <button className="btn btn-listen" onClick={()=>generateWithTopic(activeTopic)} style={{width:"100%",padding:"12px",borderRadius:"var(--rs)",fontSize:13,marginTop:10}}>
                <Headphones size={14}/> Generate: {activeTopic}
              </button>
            )}
            {generating&&(
              <div style={{background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"16px",display:"flex",flexDirection:"column",alignItems:"center",gap:10,marginTop:10}}>
                <RefreshCw size={20} className="spin" color="var(--listen)"/>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--text)"}}>Composing your listening passage…</div>
                <div style={{fontSize:11.5,color:"var(--text3)",textAlign:"center",lineHeight:1.5}}>Usually 8-15 seconds. We'll auto-play it when ready.</div>
                <div style={{width:"100%",height:3,background:"var(--border)",borderRadius:2,overflow:"hidden",marginTop:4}}>
                  <div style={{height:"100%",background:"var(--listen)",animation:"loadbar 12s linear forwards"}}/>
                </div>
              </div>
            )}
          </div>
        )}

        {content&&!generating&&(
          <div ref={contentRef} className="gen-appear" style={{display:"flex",flexDirection:"column",gap:12,scrollMarginTop:14}}>
            <div style={{background:"var(--listen-bg)",border:"1.5px solid var(--listen-border)",borderRadius:"var(--r)",padding:"20px 18px",textAlign:"center"}}>
              <div className="sec" style={{margin:0,marginBottom:14,color:"var(--listen)"}}>Listening Exercise</div>
              <div style={{display:"flex",justifyContent:"center",gap:12,marginBottom:16}}>
                <button onClick={()=>{window.speechSynthesis.cancel();setPlaying(false);setTimeout(()=>doPlay(settings.speed),80);}}
                  style={{width:44,height:44,borderRadius:"50%",background:"var(--surface2)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"var(--text2)"}} title="Replay">
                  <SkipBack size={18}/>
                </button>
                <button onClick={togglePlay}
                  style={{width:64,height:64,borderRadius:"50%",background:playing?"var(--weak)":"var(--listen)",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:"white",boxShadow:"0 4px 20px rgba(91,45,139,.35)"}}>
                  {playing?<Pause size={26}/>:<Play size={26} style={{marginLeft:3}}/>}
                </button>
              </div>
              <div style={{fontSize:12.5,color:"var(--text3)"}}>{playing?"Playing…":"Tap play to start"}</div>
              <div style={{display:"flex",justifyContent:"center",gap:6,marginTop:12}}>
                {[{v:0.6,l:"0.6×"},{v:0.82,l:"0.8×"},{v:1.0,l:"1.0×"},{v:1.2,l:"1.2×"}].map(s=>(
                  <button key={s.v} onClick={()=>{setSetting("speed",s.v);setTtsPlaybackRate(s.v);/* live; keeps playing */}}
                    style={{padding:"5px 10px",borderRadius:100,fontSize:12,fontWeight:600,border:`1.5px solid ${settings.speed===s.v?"var(--listen)":"var(--border)"}`,background:settings.speed===s.v?"var(--listen)":"transparent",color:settings.speed===s.v?"white":"var(--text2)",cursor:"pointer",transition:"all .15s"}}>
                    {s.l}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn" onClick={()=>setShowArabic(v=>!v)}
              style={{background:"transparent",color:"var(--listen)",border:"1.5px solid var(--listen-border)",borderRadius:"var(--rs)",padding:"10px",width:"100%",fontSize:13,fontWeight:600}}>
              {showArabic?<><EyeOff size={14}/>Hide Arabic Text</>:<><Eye size={14}/>Show Arabic Text</>}
            </button>
            {showArabic&&(
              <div className="gen-appear" style={{background:"var(--surface)",border:"1.5px solid var(--listen-border)",borderRadius:"var(--r)",padding:"18px 17px"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div className="sec" style={{margin:0,color:"var(--listen)"}}>Arabic Text</div>
                  {content.vocabUsed?.length>0&&settings.highlightVocab&&(
                    <span style={{fontSize:11,color:"var(--listen)",background:"var(--listen-bg)",padding:"2px 8px",borderRadius:100,border:"1px solid var(--listen-border)"}}>{content.vocabUsed.length} vocab words</span>
                  )}
                </div>
                <ClickableArabic text={content.arabic} highlightWords={settings.highlightVocab?(content.vocabUsed||[]):[]} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={20}/>
                <div style={{marginTop:10,fontSize:12,color:"var(--text3)"}}>💡 Tap any word to look it up</div>
              </div>
            )}
            <button className="btn" onClick={()=>setShowEnglish(v=>!v)}
              style={{background:"transparent",color:"var(--text2)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"10px",width:"100%",fontSize:13,fontWeight:600}}>
              {showEnglish?<><EyeOff size={14}/>Hide Translation</>:<><Globe size={14}/>Show English Translation</>}
            </button>
            {showEnglish&&(
              <div className="gen-appear" style={{background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"14px 16px"}}>
                <div className="sec" style={{margin:0,marginBottom:8}}>English Translation</div>
                <div style={{fontSize:14,color:"var(--text2)",lineHeight:1.75}}>{content.translation}</div>
              </div>
            )}
            <div style={{display:"flex",gap:8}}>
              <button className="btn" onClick={()=>{window.speechSynthesis.cancel();setPlaying(false);setTimeout(()=>doPlay(settings.speed),80);}}
                style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"11px",borderRadius:"var(--rs)",fontSize:13,fontWeight:600}}>
                <SkipBack size={14}/> Listen Again
              </button>
              <button className="btn btn-listen" onClick={handleNextPassage} style={{flex:2,padding:"11px",borderRadius:"var(--rs)",fontSize:13}}>
                <RefreshCw size={14}/> Next Passage
              </button>
            </div>
            <button className="btn" onClick={onFinish} style={{width:"100%",padding:"11px",borderRadius:"var(--rs)",fontSize:13,fontWeight:600,background:"var(--know-bg)",color:"var(--know)",border:"1.5px solid var(--know-border)"}}>
              <CheckCircle2 size={14}/> Finish Session
            </button>
          </div>
        )}
      </div>
      {showMiniRating&&(
        <div className="overlay" onClick={e=>{if(e.target===e.currentTarget) submitMiniRating(null);}}>
          <div className="drawer" style={{textAlign:"center",padding:"24px 20px 32px"}}>
            <div style={{fontSize:15,fontWeight:600,marginBottom:4}}>How was that passage?</div>
            <div style={{fontSize:12,color:"var(--text3)",marginBottom:16}}>Quick rate before the next one</div>
            <div className="rating-stars" style={{marginBottom:16}}>
              {[1,2,3,4,5].map(n=><div key={n} className="rating-star" onClick={()=>submitMiniRating(n)}>{n<=2?"😓":n===3?"😐":n===4?"🙂":"🌟"}</div>)}
            </div>
            <button className="btn" onClick={()=>submitMiniRating(null)} style={{background:"var(--surface2)",color:"var(--text3)",padding:"10px 20px",borderRadius:"var(--rs)",fontSize:13}}>Skip — just give me another</button>
          </div>
        </div>
      )}
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GLOBAL SEARCH
// ─────────────────────────────────────────────────────────────
function GlobalSearch({decks,cardStates,onClose,onSelectCard}) {
  const [query,setQuery]=useState("");
  const inputRef=useRef(null);
  useEffect(()=>{inputRef.current?.focus();},[]);
  useEffect(()=>{
    const handler=(e)=>{if(e.key==="Escape") onClose();};
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[onClose]);

  const results=[];
  if(query.trim().length>=1){
    const q=query.toLowerCase();
    for(const deck of decks){
      for(const card of (cardStates[deck.id]||[])){
        const matchFields=[];
        if(card.english.toLowerCase().includes(q)) matchFields.push("english");
        if(card.arabicBase.includes(query)) matchFields.push("arabicBase");
        if(card.forms){
          for(const [k,v] of Object.entries(card.forms)){
            if(v&&(v.includes(query)||v.toLowerCase().includes(q))) matchFields.push(k);
          }
        }
        if(matchFields.length) results.push({card,deck,matchFields});
        if(results.length>=30) break;
      }
      if(results.length>=30) break;
    }
  }

  return (
    <div className="search-overlay">
      <div className="search-header">
        <Search size={18} color="var(--text3)"/>
        <input ref={inputRef} className="input" placeholder="Search all cards (English or Arabic)…" value={query} onChange={e=>setQuery(e.target.value)}
          style={{border:"none",padding:"8px 0",fontSize:16,background:"transparent",flex:1}}/>
        <button className="btn btn-ghost" onClick={onClose} style={{width:32,height:32}}><X size={14}/></button>
      </div>
      <div className="search-results">
        {query.trim().length<1&&(
          <div style={{textAlign:"center",padding:"48px 20px",color:"var(--text3)"}}>
            <Search size={32} style={{opacity:.3,marginBottom:10}}/><br/>
            <div style={{fontSize:14}}>Type to search across all decks</div>
            <div style={{fontSize:12,marginTop:4}}>Search by English, Arabic, forms, synonyms, antonyms…</div>
          </div>
        )}
        {query.trim().length>=1&&results.length===0&&(
          <div style={{textAlign:"center",padding:"48px 20px",color:"var(--text3)",fontSize:14}}>No cards match "{query}"</div>
        )}
        {results.map(({card,deck,matchFields})=>(
          <div key={card.id} className="search-result" onClick={()=>onSelectCard(card,deck)}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:2}}>
                <span style={{fontWeight:600,fontSize:14}}>{card.english}</span>
                <span className={`tag tag-${card.status}`} style={{fontSize:10}}>{card.status}</span>
              </div>
              <div className="ar" style={{fontSize:18,color:"var(--accent)"}}>{card.arabicBase}</div>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:2}}>
                {deck.title} · matched: {matchFields.map(f=>FORM_LABELS[f]||f).join(", ")}
              </div>
            </div>
            <ChevronRight size={14} color="var(--text3)"/>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ONBOARDING
// ─────────────────────────────────────────────────────────────
// Short, capture-focused intro shown at the START of onboarding. The detailed
// feature walkthrough (ONBOARDING_STEPS) lives in the always-available Help &
// Tips guide instead of being forced up front — so setup stays quick and
// guidance is continuous.
const INTRO_SLIDES=[
  {icon:"🗂️",title:"Welcome",body:"Learn Modern Standard Arabic through flashcards, spaced repetition, and immersive practice — tailored to you. Let's set up your profile; it takes about two minutes."},
  {icon:"🧭",title:"Why we ask a few questions",body:"We'll learn a little about you and check your level, so your reading, listening, dictation, and immersion content can be personalized. You can change anything later — and the ? button on the home screen has tips for every feature."},
];

// ── In-app tips / coach marks (persistent dismissal) ──────────────
// First-visit tips guide students through the app. Seen-state lives in
// localStorage so it works without the cloud and survives reloads.
const TIPS_KEY="arabic_fc_tips_seen";
function getTipsSeen(){try{return new Set(JSON.parse(localStorage.getItem(TIPS_KEY)||"[]"));}catch{return new Set();}}
function markTipSeen(id){try{const s=getTipsSeen();s.add(id);localStorage.setItem(TIPS_KEY,JSON.stringify([...s]));}catch{}}
function resetTips(){try{localStorage.removeItem(TIPS_KEY);}catch{}}
function TipBanner({id,title,children}){
  const [show,setShow]=useState(()=>!getTipsSeen().has(id));
  if(!show) return null;
  const dismiss=()=>{markTipSeen(id);setShow(false);};
  return (
    <div style={{background:"var(--info-bg)",border:"1px solid var(--info-border)",borderRadius:"var(--rs)",padding:"11px 13px",display:"flex",gap:10,alignItems:"flex-start",marginBottom:12}}>
      <Info size={15} color="var(--info)" style={{flexShrink:0,marginTop:1}}/>
      <div style={{flex:1,fontSize:12.5,color:"var(--text2)",lineHeight:1.55}}>
        {title&&<div style={{fontWeight:700,color:"var(--info)",marginBottom:2}}>{title}</div>}
        {children}
      </div>
      <button onClick={dismiss} title="Dismiss" style={{background:"none",border:"none",color:"var(--text3)",cursor:"pointer",flexShrink:0,padding:0,lineHeight:1}}><X size={14}/></button>
    </div>
  );
}

// Help & Tips — always-available guide. Reuses the feature walkthrough and lets
// the student replay onboarding or re-enable the in-app tips.
function GuideScreen({onBack,onReplayOnboarding,onResetTips}){
  return (
    <div className="screen">
      <Hdr title="Help & Tips" sub="Guide" onBack={onBack}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:10}}>
        <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:2}}>A quick guide to every part of the app. Tap below to set up your profile again or bring back the in-app tips.</div>
        <div style={{display:"flex",gap:8,marginBottom:6}}>
          <button className="btn btn-primary" onClick={onReplayOnboarding} style={{flex:2,padding:"12px",borderRadius:"var(--r)",fontSize:14}}><RotateCcw size={15}/> Replay onboarding</button>
          <button className="btn" onClick={onResetTips} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)",fontSize:13}}>Reset tips</button>
        </div>
        {ONBOARDING_STEPS.map((s,i)=>(
          <div key={i} className="module-card" style={{alignItems:"flex-start",cursor:"default"}}>
            <div style={{fontSize:24,flexShrink:0,lineHeight:1.2}}>{s.icon}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14}}>{s.title}</div>
              <div style={{fontSize:12.5,color:"var(--text2)",marginTop:3,lineHeight:1.55}}>{s.body}</div>
            </div>
          </div>
        ))}
        <div style={{height:20}}/>
      </div>
    </div>
  );
}

const ONBOARDING_STEPS=[
  {icon:"🗂️",title:"Welcome to Arabic Flashcards",body:"Your all-in-one Arabic learning app. AI-powered flashcards with full tashkeel, spaced repetition, reading, listening, conversation, and progress tracking toward B2."},
  {icon:"📇",title:"How Flashcards Work",body:"Create decks and add English or Arabic words. The AI generates all forms — singular, plural, synonyms, antonyms, verb conjugations, and the common preposition (harf) — all with full diacritics."},
  {icon:"🎯",title:"Master Review",body:"The Master Review button on your home screen is your daily study hub. It works like Anki — due cards first, then weak, then new. Choose 20 to 200 cards per session. You can also launch Master Reading, Listening, and Speaking from here."},
  {icon:"🔁",title:"Spaced Repetition",body:"Known cards come back in 1 day, then 3, then 7, and so on. Weak cards reset to immediate review. Each form (singular, plural, etc.) is tracked separately — if you fail on plural, it shows plural first next time."},
  {icon:"📖",title:"Practice Modules",body:"Reading generates AI passages. Listening creates audio exercises. Conversation lets you chat with AI — all using your vocabulary. Tap any Arabic word to look it up and save it. \"Finish Session\" lets you rate how it went."},
  {icon:"📊",title:"Progress & Performance",body:"Two views: Performance tracks your skill scores (from master sessions only), B2 vocab progress, and insights. Progress tracks study time, daily/weekly targets, and module activity. Log outside study too."},
  {icon:"🚀",title:"Ready to Start!",body:"Create a deck, add words, then hit Master Review. Set your daily target in Settings. The app tracks everything — you focus on learning Arabic."},
];

// ─────────────────────────────────────────────────────────────
// PROFILE / PLACEMENT (Phase 1) — working levels mapped to the four
// Al-ʿArabiyyah Bayna Yadayk books, the personal-context form, and a
// self-contained placement bank. The placement uses NO AI (it's a fixed
// graded quiz), so it stays in the free tier per product rule R1.
// ─────────────────────────────────────────────────────────────
// CEFR bands per Bayna Yadayk book — you're working WITHIN the band while
// studying that book, reaching its upper bound on completion (completing Book 1
// ≈ A2, Book 2 ≈ B1, Book 3 ≈ B2, Book 4 ≈ C1 entry).
const WORKING_LEVELS=[
  {id:"book1",label:"Beginner",cefr:"A1–A2",book:1,desc:"Foundations — greetings, family, daily life. Completing Book 1 ≈ A2."},
  {id:"book2",label:"Elementary",cefr:"A2–B1",book:2,desc:"Social & civic life — health, city life, work. Completing Book 2 ≈ B1."},
  {id:"book3",label:"Intermediate",cefr:"B1–B2",book:3,desc:"Society, faith & culture; longer texts. Completing Book 3 ≈ B2."},
  {id:"book4",label:"Advanced",cefr:"B2–C1",book:4,desc:"Abstract & advanced topics; near-native phrasing. Book 4 ≈ C1 entry."},
];
const levelById=(id)=>WORKING_LEVELS.find(l=>l.id===id)||WORKING_LEVELS[0];

// ─────────────────────────────────────────────────────────────
// CURRICULUM (Phase 2) — the 64 units (4 books × 16). Derived from the
// vendored Language Island data so there is ONE source of truth, not a
// duplicate list. Units are fixed reference data, so they live as a constant
// (queried like the app's other seed constants) with stable ids that future
// content/cache rows can reference. `id` matches Language Island's "<book>-<unit>" key.
// ─────────────────────────────────────────────────────────────
const BOOK_WORKING_LEVEL={1:"book1",2:"book2",3:"book3",4:"book4"};
const UNITS=BOOKS.flatMap((b)=>b.units.map((u,i)=>({
  id:`${b.n}-${i+1}`,
  globalNo:(b.n-1)*16+(i+1),   // 1..64
  book:b.n, index:i+1,
  titleAr:u[0], titleEn:u[1],
  level:BOOK_WORKING_LEVEL[b.n],
  verified:true,               // all 64 titles transcribed from the official 2nd-edition TOCs
})));
const unitById=(id)=>UNITS.find((u)=>u.id===id)||null;
const unitsForLevel=(lvl)=>UNITS.filter((u)=>u.level===lvl);
const unitLabel=(id)=>{const u=unitById(id);return u?`${u.titleEn} · ${u.titleAr}`:"";};

// ── Reconcile EXISTING decks/cards with the curriculum (no duplication) ──
// A deck may carry an optional `unitId`/`level`; its cards inherit them (a card
// can override per-card). These helpers make existing flashcards queryable by
// unit/level and derive the learner's known vocabulary for personalization.
function collectVocab(cards){
  const out=new Set();
  (cards||[]).forEach((c)=>{
    if(c?.arabicBase) out.add(c.arabicBase);
    if(c?.forms) Object.values(c.forms).forEach((v)=>{if(v&&typeof v==="string") out.add(v);});
  });
  return [...out];
}
function allCardsWithUnit(decks,cardStates){
  const byId={}; (decks||[]).forEach((d)=>{byId[d.id]=d;});
  return Object.entries(cardStates||{}).flatMap(([deckId,arr])=>(arr||[]).map((c)=>{
    const d=byId[deckId];
    const uId=c.unitId||d?.unitId||null;
    const level=c.level||d?.level||(uId?unitById(uId)?.level:null)||null;
    return {...c,deckId,unitId:uId,level};
  }));
}
function cardsForCurriculum(decks,cardStates,{unitId=null,level=null}={}){
  return allCardsWithUnit(decks,cardStates).filter((c)=>
    (!unitId||c.unitId===unitId)&&(!level||c.level===level));
}
// The learner's KNOWN vocabulary (feeds Phase 5 personalization). Defaults to
// cards they've engaged with (known/weak); optionally scoped to a unit/level.
function knownVocab(decks,cardStates,{unitId=null,level=null,statuses=["known","weak"]}={}){
  return collectVocab(
    cardsForCurriculum(decks,cardStates,{unitId,level}).filter((c)=>
      c.wordType!=="grammar"&&statuses.includes(c.status||"new")) // grammar-rule cards aren't vocabulary
  );
}

// Personalization engine (Phase 5): turn the learner's profile context into a
// prompt clause the gateway appends when personalized mode is on. Returns ""
// when there's nothing to personalize with (→ behaves like general mode).
function buildPersona(profile){
  const c=profile?.personalContext||{};
  const bits=[];
  if(c.occupation) bits.push(`works as ${c.occupation}`);
  if(c.region) bits.push(`is based in ${c.region}`);
  if(c.ageBand) bits.push(`is in the ${c.ageBand} age range`);
  if(c.reason) bits.push(`is learning Arabic mainly for ${c.reason}`);
  if(c.interests) bits.push(`is interested in ${c.interests}`);
  if(c.favoriteTopics) bits.push(`enjoys topics like ${c.favoriteTopics}`);
  if(c.goals) bits.push(`has the goal: ${c.goals}`);
  if(c.nativeLanguage) bits.push(`is a native ${c.nativeLanguage} speaker`);
  if(!bits.length) return "";
  return `The learner ${bits.join(", ")}. Where natural, tailor examples, names, and scenarios to this person's life, interests, and goals — but keep the chosen topic and level unchanged and don't force irrelevant references.`;
}

// ─────────────────────────────────────────────────────────────
// PRESET LIBRARY — central starter decks available to EVERY user,
// independent of their own cloud data. Bundled here so they always exist
// (offline-safe); `fetchCentralPresets()` additionally merges a Firestore
// `preset_decks` collection when present, so the team can publish/update
// presets centrally without an app deploy. "Download" copies a preset into
// the user's own decks (new ids) where it becomes editable + cloud-synced.
// ─────────────────────────────────────────────────────────────
const PRESET_DECKS=[
  {id:"preset-greetings", title:"Greetings & Introductions", unitId:"1-1", level:"book1",
   cards:[
     {wordType:"noun",english:"Name",arabicBase:"اِسْم",forms:{singular:"اِسْم",plural:"أَسْمَاء"}},
     {wordType:"noun",english:"Friend",arabicBase:"صَدِيق",forms:{singular:"صَدِيق",plural:"أَصْدِقَاء"}},
     {wordType:"noun",english:"Peace / greeting",arabicBase:"سَلَام",forms:{singular:"سَلَام"}},
     {wordType:"noun",english:"Morning",arabicBase:"صَبَاح",forms:{singular:"صَبَاح",harf:"فِي"}},
     {wordType:"noun",english:"Evening",arabicBase:"مَسَاء",forms:{singular:"مَسَاء",harf:"فِي"}},
     {wordType:"noun",english:"Country",arabicBase:"بَلَد",forms:{singular:"بَلَد",plural:"بِلَاد",harf:"مِنْ"}},
   ]},
  {id:"preset-family", title:"The Family", unitId:"1-2", level:"book1",
   cards:[
     {wordType:"noun",english:"Father",arabicBase:"أَب",forms:{singular:"أَب",plural:"آبَاء"}},
     {wordType:"noun",english:"Mother",arabicBase:"أُمّ",forms:{singular:"أُمّ",plural:"أُمَّهَات"}},
     {wordType:"noun",english:"Son",arabicBase:"اِبْن",forms:{singular:"اِبْن",plural:"أَبْنَاء"}},
     {wordType:"noun",english:"Daughter",arabicBase:"بِنْت",forms:{singular:"بِنْت",plural:"بَنَات"}},
     {wordType:"noun",english:"Brother",arabicBase:"أَخ",forms:{singular:"أَخ",plural:"إِخْوَة"}},
     {wordType:"noun",english:"Sister",arabicBase:"أُخْت",forms:{singular:"أُخْت",plural:"أَخَوَات"}},
   ]},
  {id:"preset-food", title:"Food & Drink", unitId:"1-5", level:"book1",
   cards:[
     {wordType:"noun",english:"Bread",arabicBase:"خُبْز",forms:{singular:"خُبْز"}},
     {wordType:"noun",english:"Water",arabicBase:"مَاء",forms:{singular:"مَاء"}},
     {wordType:"noun",english:"Meat",arabicBase:"لَحْم",forms:{singular:"لَحْم",plural:"لُحُوم"}},
     {wordType:"noun",english:"Rice",arabicBase:"أَرُزّ",forms:{singular:"أَرُزّ"}},
     {wordType:"noun",english:"Apple",arabicBase:"تُفَّاحَة",forms:{singular:"تُفَّاحَة",plural:"تُفَّاح"}},
     {wordType:"noun",english:"Milk",arabicBase:"حَلِيب",forms:{singular:"حَلِيب"}},
   ]},
];
// Best-effort central layer. Returns [] (and never throws) if the collection is
// absent / rules block it / offline — bundled presets still show.
async function fetchCentralPresets(){
  try{
    const snap=await getDocs(collection(db,"preset_decks"));
    const out=[];
    snap.forEach(d=>{ const v=d.data(); if(v&&Array.isArray(v.cards)) out.push({id:d.id,...v}); });
    return out;
  }catch{ return []; }
}
// Copy a preset into a brand-new user deck (fresh ids, status reset, unit link
// preserved). Reuses the existing "importDeck" channel the app already handles.
function downloadPreset(pd){
  const now=Date.now();
  const cards=(pd.cards||[]).map((c,i)=>({...c,id:`c${now+i+1}`,status:"new"}));
  const deck={id:`d${now}`,title:pd.title,createdAt:now,...(pd.unitId?{unitId:pd.unitId,level:pd.level||(unitById(pd.unitId)?.level)}:{})};
  window.dispatchEvent(new CustomEvent("importDeck",{detail:{deck,cards}}));
  return cards.length;
}

const CONTEXT_FIELDS=[
  {key:"occupation",label:"Occupation",type:"text",placeholder:"e.g. Software engineer"},
  {key:"ageBand",label:"Age band",type:"select",options:["Under 18","18–24","25–34","35–44","45–54","55+"]},
  {key:"reason",label:"Main reason for learning",type:"select",options:["Understand the Qur'an & Islam","Travel","Work / business","Family / heritage","Academic study","General interest"]},
  {key:"interests",label:"Interests & hobbies",type:"text",placeholder:"e.g. football, cooking, history"},
  {key:"favoriteTopics",label:"Topics you enjoy reading about",type:"text",placeholder:"e.g. science, travel, sports, food"},
  {key:"goals",label:"Your specific goal",type:"textarea",placeholder:"e.g. read the Qur'an with understanding, talk with my in-laws"},
  {key:"dailyGoal",label:"Daily study time",type:"select",options:["5–10 min","15–30 min","30–60 min","60+ min"]},
  {key:"region",label:"Region / country",type:"text",placeholder:"e.g. Canada"},
  {key:"nativeLanguage",label:"Native language",type:"text",placeholder:"e.g. English"},
];
const emptyContext=()=>Object.fromEntries(CONTEXT_FIELDS.map(f=>[f.key,""]));

// 4 tiers × 3 questions, increasing difficulty. `a` is the index of the
// correct option. The placement walks tier by tier and stops as soon as a
// learner clearly hits their ceiling (lightly adaptive — see Onboarding).
const PLACEMENT_TIERS=[
  [ // Tier 1 → book1 (A0–A1)
    {id:"t1q1",q:"What does «بَيْت» mean?",options:["Car","House","Book","Water"],a:1},
    {id:"t1q2",q:"Which word means “water”?",options:["نَار","بَاب","مَاء","قَلَم"],a:2},
    {id:"t1q3",q:"«السَّلامُ عَلَيكُم» is used to…",options:["Order food","Count numbers","Greet someone","Say the time"],a:2},
  ],
  [ // Tier 2 → book2 (A2)
    {id:"t2q1",q:"The correct plural of «كِتاب» (book) is:",options:["كاتِب","كُتُب","مَكتَب","كِتابة"],a:1},
    {id:"t2q2",q:"«ذَهَبْتُ إلى السُّوقِ أمسِ» — when did it happen?",options:["Tomorrow","Right now","Yesterday (past)","Never"],a:2},
    {id:"t2q3",q:"Which sentence means “I want to eat”?",options:["هو يَشرَبُ الماء","أُريدُ أن آكُلَ","أَكَلْتُ كثيراً","لا أُحِبُّ الطعام"],a:1},
  ],
  [ // Tier 3 → book3 (B1)
    {id:"t3q1",q:"In «رَغمَ أنَّهُ مُتعَب، أكمَلَ عَمَلَهُ», «رَغمَ أنَّ» means:",options:["Because","Although","After","If"],a:1},
    {id:"t3q2",q:"The maṣdar (verbal noun) of «دَرَسَ» is:",options:["دارِس","مَدرَسة","دِراسة","يَدرُسُ"],a:2},
    {id:"t3q3",q:"«إذا اجتَهَدتَ، نَجَحتَ» expresses:",options:["A command","A question","Negation","A condition"],a:3},
  ],
  [ // Tier 4 → book4 (B2+)
    {id:"t4q1",q:"«تَتَّسِمُ هذهِ القَضيّةُ بالتَّعقيدِ» — «تَتَّسِمُ بـ» means:",options:["Is characterized by","Is unaware of","Travels to","Disagrees with"],a:0},
    {id:"t4q2",q:"The most formal/eloquent equivalent of “however” is:",options:["وبعدين","يعني","بَيدَ أنَّ","طَيّب"],a:2},
    {id:"t4q3",q:"In «لولا العِلمُ لَما تَقَدَّمَتِ الأُمَمُ», «لولا» signals:",options:["A greeting","A hypothetical (if not for)","A simple past","A direct order"],a:1},
  ],
];

// Walk the placement results tier by tier. A tier is "passed" with ≥2/3.
// Stop at the first tier the learner fails; their level is the last passed
// tier (or book1 if they fail tier 1 → clear A0 early-out).
function scorePlacement(answers){
  let placed=0; // highest tier passed (1-based); 0 = failed tier 1
  for(let t=0;t<PLACEMENT_TIERS.length;t++){
    const reached=PLACEMENT_TIERS[t].some(q=>q.id in answers);
    if(!reached) break; // tier never asked (adaptive stop)
    const correct=PLACEMENT_TIERS[t].filter(q=>answers[q.id]===q.a).length;
    if(correct>=2) placed=t+1; else break; // need 2/3 to clear a tier
  }
  return WORKING_LEVELS[placed===0?0:placed-1].id; // book1 floor; else the last cleared tier
}

function Onboarding({onComplete,initialProfile}) {
  // phase: welcome → context → placement → result → personalize
  const [phase,setPhase]=useState("welcome");
  const [step,setStep]=useState(0); // welcome carousel index
  const [ctx,setCtx]=useState(()=>({...emptyContext(),...(initialProfile?.personalContext||{})}));
  const [displayName,setDisplayName]=useState(initialProfile?.displayName||"");
  const [personalizationOn,setPersonalizationOn]=useState(initialProfile?.personalizationOn??false);
  const [addStarter,setAddStarter]=useState(true);

  // Placement state (lightly adaptive)
  const [tier,setTier]=useState(0);
  const [qInTier,setQInTier]=useState(0);
  const [answers,setAnswers]=useState({});
  const [picked,setPicked]=useState(null);

  const setField=(k,v)=>setCtx(p=>({...p,[k]:v}));

  const finish=(resultLevel,ans)=>{
    // Optional starter deck for the placed level (a free preset → their decks).
    if(addStarter){
      const starter=PRESET_DECKS.find(d=>d.level===resultLevel)||PRESET_DECKS[0];
      if(starter) downloadPreset(starter);
    }
    onComplete({
      profile:{
        displayName:displayName.trim(),
        workingLevel:resultLevel,
        personalizationOn,
        personalContext:ctx,
        nativeLanguage:ctx.nativeLanguage||"",
      },
      placement:{ answers:ans, resultLevel, takenAt:Date.now() },
    });
  };

  const answerQuestion=()=>{
    if(picked===null) return;
    const q=PLACEMENT_TIERS[tier][qInTier];
    const nextAnswers={...answers,[q.id]:picked};
    setAnswers(nextAnswers);
    setPicked(null);
    // advance within tier
    if(qInTier<PLACEMENT_TIERS[tier].length-1){ setQInTier(qInTier+1); return; }
    // tier complete — evaluate
    const correct=PLACEMENT_TIERS[tier].filter(x=>nextAnswers[x.id]===x.a).length;
    const passed=correct>=2;
    if(passed && tier<PLACEMENT_TIERS.length-1){ setTier(tier+1); setQInTier(0); return; }
    // stop: ceiling reached or finished top tier
    setPhase("result");
  };

  const resultLevelId=scorePlacement(answers);

  // ---- WELCOME (short intro → leads into profile capture) ----
  if(phase==="welcome"){
    const s=INTRO_SLIDES[step];
    const last=step===INTRO_SLIDES.length-1;
    return (
      <div className="onboarding-overlay">
        <div className="onboarding-card">
          <div style={{fontSize:48,marginBottom:16}}>{s.icon}</div>
          <div style={{fontFamily:"Lora,serif",fontSize:22,fontWeight:600,marginBottom:10}}>{s.title}</div>
          <div style={{fontSize:14,color:"var(--text2)",lineHeight:1.7,marginBottom:8}}>{s.body}</div>
          <div className="onboarding-dots">
            {INTRO_SLIDES.map((_,i)=><div key={i} className={`onboarding-dot ${i===step?"active":""}`}/>)}
          </div>
          <div style={{display:"flex",gap:8,marginTop:8}}>
            {step>0&&<button className="btn" onClick={()=>setStep(v=>v-1)} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Back</button>}
            {!last
              ? <button className="btn btn-primary" onClick={()=>setStep(v=>v+1)} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Next</button>
              : <button className="btn btn-primary" onClick={()=>setPhase("context")} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Set up my profile</button>}
          </div>
        </div>
      </div>
    );
  }

  // ---- PERSONAL-CONTEXT FORM ----
  if(phase==="context"){
    return (
      <div className="onboarding-overlay">
        <div className="onboarding-card" style={{textAlign:"left",maxHeight:"86vh",overflowY:"auto"}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:40,marginBottom:10}}>🧭</div>
            <div style={{fontFamily:"Lora,serif",fontSize:21,fontWeight:600,marginBottom:6}}>Tell us about you</div>
            <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:18}}>This personalizes your practice later. Everything is optional and editable in Settings.</div>
          </div>
          <label className="lbl" style={{marginBottom:3}}>Your name</label>
          <input className="input" value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="e.g. Muhammed" style={{marginBottom:12}}/>
          {CONTEXT_FIELDS.map(f=>(
            <div key={f.key} style={{marginBottom:12}}>
              <label className="lbl" style={{marginBottom:3}}>{f.label}</label>
              {f.type==="select"
                ? <select className="input" value={ctx[f.key]} onChange={e=>setField(f.key,e.target.value)}>
                    <option value="">Select…</option>
                    {f.options.map(o=><option key={o} value={o}>{o}</option>)}
                  </select>
                : f.type==="textarea"
                ? <textarea className="input" value={ctx[f.key]} onChange={e=>setField(f.key,e.target.value)} placeholder={f.placeholder} rows={2} style={{resize:"vertical"}}/>
                : <input className="input" value={ctx[f.key]} onChange={e=>setField(f.key,e.target.value)} placeholder={f.placeholder}/>}
            </div>
          ))}
          <div style={{display:"flex",gap:8,marginTop:8}}>
            <button className="btn" onClick={()=>setPhase("welcome")} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Back</button>
            <button className="btn btn-primary" onClick={()=>{setTier(0);setQInTier(0);setAnswers({});setPicked(null);setPhase("placement");}} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Continue</button>
          </div>
        </div>
      </div>
    );
  }

  // ---- PLACEMENT ASSESSMENT ----
  if(phase==="placement"){
    const q=PLACEMENT_TIERS[tier][qInTier];
    const answeredCount=Object.keys(answers).length;
    return (
      <div className="onboarding-overlay">
        <div className="onboarding-card" style={{textAlign:"left"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <span className="sec" style={{margin:0}}>Placement · {WORKING_LEVELS[tier].cefr}</span>
            <span style={{fontSize:12,color:"var(--text3)"}}>Q{answeredCount+1}</span>
          </div>
          <div className="progress-track" style={{marginBottom:18}}><div className="progress-fill" style={{width:`${(answeredCount/(PLACEMENT_TIERS.length*3))*100}%`,background:"var(--accent)"}}/></div>
          <div style={{fontSize:15.5,fontWeight:600,lineHeight:1.6,marginBottom:16}}>{q.q}</div>
          <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:18}}>
            {q.options.map((opt,i)=>{
              const on=picked===i;
              const isArabic=/[؀-ۿ]/.test(opt);
              return (
                <button key={i} onClick={()=>setPicked(i)}
                  className="btn"
                  style={{textAlign:isArabic?"right":"left",justifyContent:isArabic?"flex-end":"flex-start",padding:"13px 15px",borderRadius:"var(--rs)",
                    border:`1.5px solid ${on?"var(--accent)":"var(--border)"}`,background:on?"var(--accent-bg)":"var(--surface)",
                    color:"var(--text)",fontSize:isArabic?17:14,fontWeight:on?600:500,
                    ...(isArabic?{fontFamily:"'Scheherazade New','Amiri',serif",direction:"rtl"}:{})}}>
                  {opt}
                </button>
              );
            })}
          </div>
          <button className="btn btn-primary" disabled={picked===null} onClick={answerQuestion} style={{width:"100%",padding:"13px",borderRadius:"var(--rs)",fontSize:14,opacity:picked===null?.5:1}}>
            {answeredCount===PLACEMENT_TIERS.length*3-1?"See my level":"Next question"}
          </button>
          <div style={{fontSize:11.5,color:"var(--text3)",textAlign:"center",marginTop:10}}>The quiz adapts — it stops once we've found your level.</div>
        </div>
      </div>
    );
  }

  // ---- RESULT ----
  if(phase==="result"){
    const lv=levelById(resultLevelId);
    return (
      <div className="onboarding-overlay">
        <div className="onboarding-card">
          <div style={{fontSize:46,marginBottom:12}}>🎯</div>
          <div style={{fontFamily:"Lora,serif",fontSize:21,fontWeight:600,marginBottom:6}}>You're at {lv.label}</div>
          <div style={{display:"inline-block",background:"var(--accent-bg)",color:"var(--accent)",border:"1px solid var(--accent-border)",borderRadius:"var(--rxs)",padding:"4px 12px",fontSize:13,fontWeight:700,marginBottom:14}}>
            {lv.cefr} · Book {lv.book}
          </div>
          <div style={{fontSize:14,color:"var(--text2)",lineHeight:1.7,marginBottom:18}}>{lv.desc} We'll show you level-appropriate content. You can change this anytime in Settings.</div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn" onClick={()=>{setTier(0);setQInTier(0);setAnswers({});setPicked(null);setPhase("placement");}} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Retake</button>
            <button className="btn btn-primary" onClick={()=>setPhase("personalize")} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Continue</button>
          </div>
        </div>
      </div>
    );
  }

  // ---- PERSONALIZATION TOGGLE ----
  const lv=levelById(resultLevelId);
  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card" style={{textAlign:"left"}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:42,marginBottom:10}}>✨</div>
          <div style={{fontFamily:"Lora,serif",fontSize:21,fontWeight:600,marginBottom:6}}>Choose your mode</div>
          <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:18}}>How should we pick your practice content?</div>
        </div>
        <button onClick={()=>setPersonalizationOn(false)} className="btn" style={{width:"100%",textAlign:"left",flexDirection:"column",alignItems:"stretch",gap:4,padding:"14px",borderRadius:"var(--rs)",marginBottom:10,border:`1.5px solid ${!personalizationOn?"var(--accent)":"var(--border)"}`,background:!personalizationOn?"var(--accent-bg)":"var(--surface)"}}>
          <div style={{fontWeight:700,fontSize:14}}>General <span style={{fontSize:11,color:"var(--know)",fontWeight:700}}>· Free</span></div>
          <div style={{fontSize:12.5,color:"var(--text2)",lineHeight:1.5}}>Shared preset library at your level. No AI cost.</div>
        </button>
        <button onClick={()=>setPersonalizationOn(true)} className="btn" style={{width:"100%",textAlign:"left",flexDirection:"column",alignItems:"stretch",gap:4,padding:"14px",borderRadius:"var(--rs)",marginBottom:16,border:`1.5px solid ${personalizationOn?"var(--accent)":"var(--border)"}`,background:personalizationOn?"var(--accent-bg)":"var(--surface)"}}>
          <div style={{fontWeight:700,fontSize:14}}>Personalized <span style={{fontSize:11,color:"var(--accent)",fontWeight:700}}>· Paid</span></div>
          <div style={{fontSize:12.5,color:"var(--text2)",lineHeight:1.5}}>Content built from your known vocabulary, level, and context. Requires a Pro plan (set up later).</div>
        </button>
        <div onClick={()=>setAddStarter(v=>!v)} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:"var(--rs)",border:"1.5px solid var(--border)",background:"var(--surface)",cursor:"pointer",marginBottom:16}}>
          <div className={`chk ${addStarter?"on":""}`}>{addStarter&&<Check size={11} color="white"/>}</div>
          <div style={{flex:1}}>
            <div style={{fontSize:13.5,fontWeight:700}}>Add a starter deck for my level</div>
            <div style={{fontSize:11.5,color:"var(--text3)",marginTop:1}}>A free, ready-made {lv.label} deck to begin — you can add more anytime from the Preset Library.</div>
          </div>
        </div>
        <button className="btn btn-primary" onClick={()=>finish(resultLevelId,answers)} style={{width:"100%",padding:"13px",borderRadius:"var(--rs)",fontSize:14}}>Finish setup · {lv.label}</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CONVERSATION MODULE
// ─────────────────────────────────────────────────────────────
function ConversationScreen({decks,cardStates,onBack,onFinish,trackUsage,onLogStudy,onAddToFlashcard,master,masterPool}) {
  const SCREEN_NAME=master?"masterSpeaking":"conversation";
  const saved=useRef(loadScreen(SCREEN_NAME)||{}).current;
  const screenStart=useRef(Date.now());
  useEffect(()=>{screenStart.current=Date.now();return ()=>{
    const mins=Math.max(1,Math.round((Date.now()-screenStart.current)/60000));
    if(mins>=1&&onLogStudy) onLogStudy({type:"app",module:"speaking",minutes:mins});
  };},[]);
  const [selDeckIds,setSelDeckIds]=useState(()=>new Set(saved.selDeckIds||decks.map(d=>d.id)));
  const allInitCards=decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id));
  const [selCardIds,setSelCardIds]=useState(()=>new Set(saved.selCardIds||allInitCards));

  // Phase: setup → topics → mission → chat → score → review
  const [phase,setPhase]=useState(saved.phase||"setup");
  const [messages,setMessages]=useState(saved.messages||[]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  // Voice mode is a per-entry default — every fresh visit to the conversation
  // screen starts hands-free, regardless of what the user toggled last
  // session. We intentionally do NOT persist this to the screen save blob
  // (see saveScreen call below) so old "false" values don't haunt new entries.
  const [voiceMode,setVoiceMode]=useState(true);
  const [listening,setListening]=useState(false);
  const [speaking,setSpeaking]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const [topics,setTopics]=useState(saved.topics||[]);
  const [selectedTopic,setSelectedTopic]=useState(saved.selectedTopic||"");
  const [missionWords,setMissionWords]=useState(saved.missionWords||[]);
  const [usedMissionWords,setUsedMissionWords]=useState(new Set(saved.usedMissionWords||[]));
  const [corrections,setCorrections]=useState(saved.corrections||[]);
  const [sessionRating,setSessionRatingLocal]=useState(0);

  // End-of-session generated feedback (rephrasings + missed opportunities)
  const [sessionFeedback,setSessionFeedback]=useState(saved.sessionFeedback||null);
  const [feedbackLoading,setFeedbackLoading]=useState(false);
  // User preferences: show what the mic heard? show old-style inline corrections?
  const [showVoiceTranscript,setShowVoiceTranscript]=useState(!!saved.showVoiceTranscript); // default off

  useEffect(()=>{
    // voiceMode intentionally omitted — see voiceMode useState comment above.
    saveScreen(SCREEN_NAME,{
      selDeckIds:[...selDeckIds],selCardIds:[...selCardIds],
      phase,messages,topics,selectedTopic,
      missionWords,usedMissionWords:[...usedMissionWords],corrections,
      sessionFeedback,showVoiceTranscript,
    });
  },[selDeckIds,selCardIds,phase,messages,topics,selectedTopic,missionWords,usedMissionWords,corrections,sessionFeedback,showVoiceTranscript,SCREEN_NAME]);
  const chatRef=useRef(null);
  const recognitionRef=useRef(null);
  const silenceTimerRef=useRef(null);
  const voiceTranscriptRef=useRef("");
  // Refs that mirror state so the hands-free auto-listen chain (fired from
  // an audio.onended callback) reads the latest values instead of a stale
  // closure captured when speakArabic was set up.
  const voiceModeRef=useRef(voiceMode);
  const phaseRef=useRef(phase);
  const listeningRef=useRef(false);
  const loadingRef=useRef(false);
  const handsFreeAbortedRef=useRef(false); // set when user manually stops mid-chain
  useEffect(()=>{voiceModeRef.current=voiceMode;},[voiceMode]);
  useEffect(()=>{phaseRef.current=phase;},[phase]);
  useEffect(()=>{listeningRef.current=listening;},[listening]);
  useEffect(()=>{loadingRef.current=loading;},[loading]);
  // Resuming an existing chat (messages already in state) won't trigger the
  // hands-free chain via speakArabic.onEnd because no fresh audio plays.
  // So when we mount into the chat phase with voice mode on, kick off the
  // mic ourselves after a short beat. Once-per-mount via the guard ref.
  const handsFreeBootedRef=useRef(false);
  useEffect(()=>{
    if(handsFreeBootedRef.current) return;
    if(phase!=="chat") return;
    if(!voiceMode) return;
    if(loading||listening||speaking) return;
    if(!messages.length) return; // brand-new chat — startWithTopic will own the chain
    handsFreeBootedRef.current=true;
    setTimeout(()=>{
      if(phaseRef.current==="chat"&&voiceModeRef.current&&!listeningRef.current&&!loadingRef.current){
        startListening();
      }
    },500);
  },[phase,voiceMode,messages.length,loading,listening,speaking]);
  // Pulled from settings (synced via module refs) so the sliders in Settings
  // take effect on the next mic press without remounting this screen.
  const SILENCE_MS=_convSilenceMs||2500;
  const FUZZY_THRESHOLD=_convFuzzyThreshold||0.8;

  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  const hasSpeechRecog=!!SpeechRecognition;

  const now3=Date.now();
  const allPooled3=decks.filter(d=>selDeckIds.has(d.id)).flatMap(d=>(cardStates[d.id]||[])).filter(c=>selCardIds.has(c.id));
  const selectedCards=master&&masterPool&&masterPool!=="all"
    ?allPooled3.filter(c=>masterPool==="weak"?c.status==="weak":masterPool==="due"?(c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now3):true)
    :allPooled3;
  const poolLabel3=master?(masterPool==="weak"?"weak":masterPool==="due"?"due":"all"):"";

  const scrollBottom=()=>setTimeout(()=>chatRef.current?.scrollTo(0,chatRef.current.scrollHeight),50);

  // Speak the AI's reply, then auto-hand the turn back to the user by
  // re-arming the mic. This is the heart of the hands-free flow: you talk,
  // it listens; it talks, the mic restarts when it's done — no taps in
  // between. Aborts cleanly if the user finished the session, navigated
  // away, manually stopped, or is still mid-AI-fetch.
  const speakArabic=(text)=>{
    if(!text) return;
    handsFreeAbortedRef.current=false;
    synthesizeArabic(text,{
      onStart:()=>setSpeaking(true),
      onEnd:()=>{
        setSpeaking(false);
        // Only chain to listening if we're still in the chat phase with voice
        // mode on and we aren't already listening / waiting for the AI.
        if(!voiceModeRef.current) return;
        if(phaseRef.current!=="chat") return;
        if(listeningRef.current) return;
        if(loadingRef.current) return;
        if(handsFreeAbortedRef.current) return;
        // Small gap so the AI's last syllable doesn't leak into the mic.
        setTimeout(()=>{
          if(voiceModeRef.current&&phaseRef.current==="chat"&&!listeningRef.current&&!loadingRef.current&&!handsFreeAbortedRef.current){
            startListening();
          }
        },350);
      },
    });
  };

  // Two listening pipelines, picked dynamically by `startListening` below:
  //  1. Web Speech API (default — free, instant interim results, browser-limited
  //     accuracy on Arabic). Auto-stops after SILENCE_MS of silence via timer.
  //  2. MediaRecorder + /api/stt (when Enhanced STT is toggled on and an
  //     OpenAI key is set). Records audio, watches RMS volume for silence,
  //     stops, posts the blob to Whisper, then submits the transcript.
  //
  // Both paths feed into sendMessage(transcript,{fromVoice:true}) so the rest
  // of the screen — mission-word tracking, hidden bubbles, end-of-session
  // feedback — works identically.
  const [transcribing,setTranscribing]=useState(false);
  const clearSilenceTimer=()=>{if(silenceTimerRef.current){clearTimeout(silenceTimerRef.current);silenceTimerRef.current=null;}};
  const armSilenceTimer=()=>{
    clearSilenceTimer();
    silenceTimerRef.current=setTimeout(()=>{
      const t=voiceTranscriptRef.current.trim();
      try{recognitionRef.current?.stop();}catch{}
      setListening(false);
      if(t) sendMessage(t,{fromVoice:true});
      voiceTranscriptRef.current="";
    },SILENCE_MS);
  };
  // ── Pipeline 2: MediaRecorder → /api/stt (OpenAI Whisper)
  // Uses an AudioContext analyser to watch RMS volume; once the user has
  // produced speech and then stayed below the silence threshold for
  // SILENCE_MS, the recording stops and the blob is sent for transcription.
  const startWhisperListening=async()=>{
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio:true}); }
    catch { showToast("Microphone access denied","error"); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const SILENCE_RMS = 0.018; // empirical — below this counts as silence

    // Pick a supported MIME type. webm/opus is widely supported; Safari needs mp4.
    const tryTypes = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg;codecs=opus"];
    const mimeType = tryTypes.find(t=>window.MediaRecorder?.isTypeSupported?.(t)) || "";
    const recorder = new MediaRecorder(stream, mimeType ? {mimeType} : {});
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

    let stopped = false;
    let speechDetected = false;
    let silenceStartedAt = null;
    const recordingStartedAt = Date.now();
    const cleanup = () => {
      stream.getTracks().forEach(t=>t.stop());
      ctx.close().catch(()=>{});
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { recorder.stop(); } catch {}
    };
    recognitionRef.current = { stop };

    recorder.onstop = async () => {
      cleanup();
      setListening(false);
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
      const durationSec = (Date.now() - recordingStartedAt) / 1000;
      if (blob.size < 800) return; // user didn't really say anything
      setTranscribing(true);
      try {
        const result = await transcribeAudio(blob, durationSec);
        if (result.transcript && result.transcript.trim()) {
          sendMessage(result.transcript.trim(), { fromVoice: true });
        } else if (result.error) {
          showToast(`Transcription failed: ${result.error}`,"error",5000);
        } else if (result.disabled || result.noKey) {
          showToast("Enhanced STT is off or missing an OpenAI key — enable it in Settings","error",5000);
        } else {
          showToast("Couldn't transcribe — no speech detected, try again","error");
        }
      } finally { setTranscribing(false); }
    };

    recorder.start();
    setListening(true);

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i=0; i<buf.length; i++) { const v=(buf[i]-128)/128; sum += v*v; }
      const rms = Math.sqrt(sum / buf.length);
      if (rms > SILENCE_RMS) { speechDetected = true; silenceStartedAt = null; }
      else if (speechDetected) {
        if (silenceStartedAt === null) silenceStartedAt = Date.now();
        else if (Date.now() - silenceStartedAt >= SILENCE_MS) { stop(); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // ── Pipeline 1: browser Web Speech API
  const startWebSpeechListening=()=>{
    if(!SpeechRecognition){showToast("Speech recognition not supported","error");return;}
    voiceTranscriptRef.current="";
    if(!showVoiceTranscript) setInput("");
    const r=new SpeechRecognition();recognitionRef.current=r;
    r.lang="ar-SA";r.interimResults=true;r.continuous=true;r.maxAlternatives=1;
    r.onstart=()=>{setListening(true);armSilenceTimer();};
    r.onresult=(e)=>{
      const full=Array.from(e.results).map(x=>x[0].transcript).join("");
      voiceTranscriptRef.current=full;
      if(showVoiceTranscript) setInput(full);
      armSilenceTimer();
    };
    r.onerror=(e)=>{
      clearSilenceTimer();
      setListening(false);
      if(e.error==="no-speech") showToast("No speech detected","info");
      else if(e.error!=="aborted") showToast(`Mic error: ${e.error}`,"error");
    };
    r.onend=()=>{clearSilenceTimer();setListening(false);};
    r.start();
  };

  // Dispatcher: picks the pipeline based on user settings. Both paths share
  // the same "tap mic again to stop early" handling. Tapping during AI
  // speech acts as a natural barge-in: cuts off the AI audio and opens the
  // mic immediately.
  const startListening=()=>{
    if(listening){
      clearSilenceTimer();
      try{recognitionRef.current?.stop();}catch{}
      const t=voiceTranscriptRef.current.trim();
      setListening(false);
      if(t) sendMessage(t,{fromVoice:true});
      voiceTranscriptRef.current="";
      return;
    }
    // Barge-in: silence any AI speech so the mic doesn't pick it up.
    if(speaking){ stopTtsAudio(); setSpeaking(false); }
    const useWhisper = _sttEnabled && _sttKey;
    if (useWhisper) startWhisperListening();
    else startWebSpeechListening();
  };

  useEffect(()=>()=>{
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    clearSilenceTimer();
    try{recognitionRef.current?.stop();}catch{}
  },[]);

  // Fuzzy mission-word detection: STT mangles spelling, so exact match is too
  // strict. Compare each mission word against the user's transcript using
  // diacritic-stripped, lowercased normalization + Levenshtein similarity.
  const checkMissionWords=(text)=>{
    missionWords.forEach(mw=>{
      const arHit=fuzzyContains(text,mw.arabicBase,FUZZY_THRESHOLD);
      const enHit=fuzzyContains(text,mw.english,FUZZY_THRESHOLD);
      if(arHit||enHit){
        setUsedMissionWords(p=>{const n=new Set(p);n.add(mw.id);return n;});
      }
    });
  };

  // Step 1: Generate topics
  const generateTopics=async()=>{
    if(!selectedCards.length){showToast("Select at least one card.","error");return;}
    setLoading(true);setPhase("topics");
    const vocabSample=selectedCards.sort(()=>Math.random()-0.5).slice(0,20);
    const vocabList=vocabSample.map(c=>`${c.english} (${c.arabicBase})`).join(", ");
    // Pick mission words (5-8 random from selection)
    const mission=selectedCards.sort(()=>Math.random()-0.5).slice(0,Math.min(8,Math.max(5,Math.floor(selectedCards.length/5))));
    setMissionWords(mission);
    try {
      const raw=await callClaude(
        `Help an Arabic learner pick a conversation topic. Use themes typical of the Al-Arabiyya Bayna Yadayk curriculum — everyday Arab/Muslim life: family, food, masjid, neighbors, market, hospitality, travel, prayer, school, work, holidays. Avoid generic abstractions.

Vocabulary available: ${vocabList}

Return exactly 4 conversation topics (5-8 word titles, English) that would naturally use many of these words.

Return ONLY valid JSON array: ["topic 1","topic 2","topic 3","topic 4"]`,
        180,"other",trackUsage
      );
      const parsed=extractJSON(raw);
      setTopics(Array.isArray(parsed)?parsed:["Daily life","At the market","Travel plans","My neighborhood"]);
    } catch {
      setTopics(["Daily life","At the market","Travel plans","My neighborhood"]);
    } finally { setLoading(false); }
  };

  // Step 2: Start conversation with selected topic
  const startWithTopic=async(topic)=>{
    setSelectedTopic(topic);setPhase("chat");setLoading(true);setMessages([]);setUsedMissionWords(new Set());setCorrections([]);setSessionFeedback(null);
    const missionList=missionWords.map(c=>`${c.english} (${c.arabicBase})`).join(", ");
    const learnedPool=Object.values(cardStates).flat().filter(c=>c.status==="known"||c.status==="weak");
    const learnedSample=[...learnedPool].sort(()=>Math.random()-0.5).slice(0,60).map(c=>c.arabicBase).join("، ");
    try {
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

You are a patient native Arabic speaker opening a conversation with a learner in this register.

Topic for this conversation: "${topic}"
Key vocabulary the learner should practice (mission words): ${missionList}

Open the conversation about "${topic}" in Arabic. Use 2-3 of the mission words. Keep it 2-3 short, natural sentences a real native speaker would actually say in this situation. If you address the learner, use a vocative like "يَا صَدِيقِي / يَا أَخِي". End by inviting the learner to respond (a question or open prompt).

Then, on a new line, give a short English translation in parentheses.

NON-NEGOTIABLE RULES:
- Speak like a warm, patient friend — never like a textbook drill. Use cultural specifics from the Arab world where natural (food, family, prayer times, daily routines, places).
- Weave the learner's already-studied words in only where they fit naturally — do NOT force them. Bonus pool: ${learnedSample||"(none)"}
- Every Arabic word MUST have full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين).
- Plain text only — no JSON.`,
        450,"other",trackUsage
      );
      setMessages([{role:"ai",text:raw}]);
      if(voiceMode) speakArabic(raw);
    } catch {
      setMessages([{role:"ai",text:"مَرْحَبًا! هَيَّا نَتَحَدَّثُ.\n\n(Hello! Let's talk.)"}]);
    } finally { setLoading(false);scrollBottom(); }
  };

  // Send a user message. Inline corrections are NOT requested — corrections
  // are collected at end-of-session via generateSessionFeedback() so the
  // conversation flow isn't interrupted by red-flag callouts.
  const sendMessage=async(overrideText,opts={})=>{
    const userMsg=(overrideText||input).trim();
    if(!userMsg||loading) return;
    const fromVoice=!!opts.fromVoice;
    setInput("");
    // hidden=true messages are kept in state for context + scoring but not
    // rendered in the chat list (so the AI doesn't visibly echo the user
    // mid-conversation). Toggle "Show what I said" surfaces them.
    const hidden=fromVoice && !showVoiceTranscript;
    setMessages(p=>[...p,{role:"user",text:userMsg,voice:fromVoice,hidden}]);
    checkMissionWords(userMsg);
    setLoading(true);scrollBottom();

    const missionList=missionWords.map(c=>`${c.english} (${c.arabicBase})`).join(", ");
    const history=messages.slice(-6).map(m=>`${m.role==="ai"?"Assistant":"User"}: ${m.text}`).join("\n");
    const learnedPool=Object.values(cardStates).flat().filter(c=>c.status==="known"||c.status==="weak");
    const learnedSample=[...learnedPool].sort(()=>Math.random()-0.5).slice(0,60).map(c=>c.arabicBase).join("، ");
    try {
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

You are a patient native Arabic speaker continuing a conversation with a learner in this register.

Topic: "${selectedTopic}"
Mission vocabulary to encourage (use where it fits): ${missionList}

Conversation so far:
${history}
User: ${userMsg}

DO NOT correct the user inline. Their Arabic may have small errors — just continue the conversation naturally and, where helpful, model the correct form by using it yourself in your reply. No "[تَصْحِيح]", no red-flag callouts, no "خطأ".

Respond in 2-3 short, natural Arabic sentences a real native speaker would say. End with a question or open prompt that invites the learner to keep talking. Then a new line, English translation in parentheses.

NON-NEGOTIABLE RULES:
- Friend, not teacher. Warmth and curiosity over correction.
- Cultural specificity where natural (food, family, prayer, places, daily life in the Arab world).
- Weave in the learner's other studied words only where they fit naturally. Bonus pool: ${learnedSample||"(none)"}
- Every Arabic word MUST have full tashkeel.
- Plain text — no JSON.`,
        500,"other",trackUsage
      );
      setMessages(p=>[...p,{role:"ai",text:raw}]);
      if(voiceMode) speakArabic(raw);
    } catch {
      setMessages(p=>[...p,{role:"ai",text:"عُذْرًا، حَدَثَ خَطَأٌ.\n\n(Sorry, an error occurred.)"}]);
    } finally { setLoading(false);scrollBottom(); }
  };

  // Generate end-of-session feedback in one batched LLM call: gentle
  // rephrasings of sentences the user produced + mission words that
  // never came up (could be queued for review).
  const generateSessionFeedback=async(userTurns,missionMissedWords)=>{
    if(!userTurns.length){setSessionFeedback({rephrasings:[],missedWords:missionMissedWords.map(m=>({english:m.english,arabic:m.arabicBase}))});return;}
    setFeedbackLoading(true);
    try {
      const turnsBlock=userTurns.map((t,i)=>`${i+1}. "${t}"`).join("\n");
      const missedList=missionMissedWords.map(m=>`${m.english} (${m.arabicBase})`).join(", ")||"(none)";
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

You are a kind Arabic tutor giving the learner a short, warm end-of-session debrief in this register.

The learner said (possibly mistranscribed by speech-to-text — be charitable about small typos and assume natural speech intent):
${turnsBlock}

Mission words they did NOT manage to use this session: ${missedList}

Produce JSON with up to 3 GENTLE rephrasings and a list of missed mission words. Pick rephrasings that genuinely improve fluency, grammar, or natural register — NOT trivial nitpicks. Frame each suggestion warmly, like "ربما من الأفضل أن تقول…" or "طريقة طبيعية أخرى…" — never "خطأ" or red-flag language.

Return ONLY valid JSON, no markdown:
{
  "rephrasings": [
    {"original":"<what the learner said>","suggested":"<gentle rephrasing in Arabic with full tashkeel>","why":"<one short English line, encouraging tone>"}
  ],
  "missedWords": [
    {"english":"<en>","arabic":"<ar with tashkeel>"}
  ]
}

CRITICAL: Every Arabic phrase must have full tashkeel.`,
        700,"other",trackUsage
      );
      const parsed=extractJSON(raw);
      setSessionFeedback({
        rephrasings:Array.isArray(parsed?.rephrasings)?parsed.rephrasings.slice(0,3):[],
        missedWords:Array.isArray(parsed?.missedWords)?parsed.missedWords:missionMissedWords.map(m=>({english:m.english,arabic:m.arabicBase})),
      });
    } catch {
      setSessionFeedback({rephrasings:[],missedWords:missionMissedWords.map(m=>({english:m.english,arabic:m.arabicBase}))});
    } finally { setFeedbackLoading(false); }
  };

  // Finish → score. Kick off async feedback generation (rephrasings + missed
  // mission words) so the summary screen has something useful when it lands.
  const finishSession=()=>{
    handsFreeAbortedRef.current=true;
    stopTtsAudio();
    clearSilenceTimer();
    try{recognitionRef.current?.stop();}catch{}
    setListening(false); setSpeaking(false);
    setPhase("score");
    const userTurns=messages.filter(m=>m.role==="user").map(m=>m.text);
    const missed=missionWords.filter(mw=>!usedMissionWords.has(mw.id));
    generateSessionFeedback(userTurns,missed);
  };

  // Calculate score
  const missionScore=missionWords.length?Math.round(usedMissionWords.size/missionWords.length*100):0;
  const userMsgCount=messages.filter(m=>m.role==="user").length;
  const finalScore=sessionRating?Math.round((missionScore*0.5+sessionRating*20*0.3+(Math.min(userMsgCount,10)/10*100)*0.2)):missionScore;

  const submitScore=()=>{
    const score=finalScore;
    if(onLogStudy) onLogStudy({type:"app",module:"speaking",minutes:0,rating:sessionRating||3,master:!!master,
      speakingScore:score,missionWordsUsed:usedMissionWords.size,missionWordsTotal:missionWords.length,corrections:corrections.length});
    if(onFinish) onFinish();
    else onBack();
  };

  const handleBubbleTap=(msg)=>{if(msg.role==="ai"&&!speaking) speakArabic(msg.text);else if(speaking){window.speechSynthesis.cancel();setSpeaking(false);}};

  // ── SETUP PHASE ──
  if(phase==="setup") return (
    <div className="screen" style={{display:"flex",flexDirection:"column",paddingBottom:0}}>
      <Hdr title={master?"Master Speaking":"Conversation"} sub="Practice" onBack={onBack}/>
      <div style={{flex:1,display:"flex",flexDirection:"column",padding:"12px 20px 0",overflow:"hidden"}}>
        <div style={{display:"flex",flexDirection:"column",gap:14,flex:1,overflowY:"auto"}}>
          <div style={{fontSize:13.5,color:"var(--text2)",lineHeight:1.6}}>
            AI-driven conversation practice. Pick your words, get a topic, then complete your mission words during the chat.
          </div>
          <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div><div style={{fontSize:13.5,fontWeight:600}}>Voice Mode</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{hasSpeechRecog?"Mic + audio":"Text-to-speech only"}</div></div>
            <div className={`chk ${voiceMode?"on":""}`} onClick={()=>setVoiceMode(v=>!v)}>{voiceMode&&<Check size={11} color="white"/>}</div>
          </div>
          {!master&&<MultiDeckCardSelector decks={decks} cardStates={cardStates} selDeckIds={selDeckIds} setSelDeckIds={setSelDeckIds} selCardIds={selCardIds} setSelCardIds={setSelCardIds} accentVar="--accent" accentBgVar="--accent-bg" accentBorderVar="--accent-border" onReset={()=>{}}/>}
          {master&&<div style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rs)",padding:"10px 14px",fontSize:13,color:"var(--accent)",fontWeight:500}}>Using {selectedCards.length} {poolLabel3} vocabulary words · Master session</div>}
          <button className="btn btn-primary" onClick={generateTopics} disabled={loading||!selectedCards.length} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
            {loading?<><RefreshCw size={14} className="spin"/>Generating topics…</>:<><MessageCircle size={15}/> Choose Topic & Start</>}
          </button>
        </div>
      </div>
    </div>
  );

  // ── TOPIC SELECTION ──
  if(phase==="topics") return (
    <div className="screen" style={{display:"flex",flexDirection:"column",paddingBottom:0}}>
      <Hdr title="Pick a Topic" sub="Conversation" onBack={()=>setPhase("setup")}/>
      <div style={{padding:"16px 20px",display:"flex",flexDirection:"column",gap:12}}>
        <div style={{fontSize:13.5,color:"var(--text2)",lineHeight:1.6}}>AI generated these topics based on your vocabulary. Pick one:</div>
        {loading?<div style={{textAlign:"center",padding:20,color:"var(--text3)"}}><RefreshCw size={16} className="spin"/></div>:
          topics.map((t,i)=>(
            <div key={i} className="test-option" onClick={()=>startWithTopic(t)}>
              <div style={{width:36,height:36,borderRadius:10,background:"var(--accent-bg)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{["💬","🏪","✈️","🏠"][i]||"💬"}</div>
              <div style={{flex:1,fontWeight:600,fontSize:14}}>{t}</div>
              <ChevronRight size={14} color="var(--text3)"/>
            </div>
          ))
        }
        <div className="divider"/>
        <div className="sec">Your Mission Words ({missionWords.length})</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
          {missionWords.map(mw=>(
            <span key={mw.id} style={{fontSize:12,padding:"4px 10px",borderRadius:100,background:"var(--accent-bg)",border:"1px solid var(--accent-border)",color:"var(--accent)",fontWeight:500}}>
              {mw.english} · <span className="ar" style={{fontSize:14}}>{mw.arabicBase}</span>
            </span>
          ))}
        </div>
        <div style={{fontSize:12,color:"var(--text3)"}}>Try to use these words during the conversation for a higher score.</div>
      </div>
    </div>
  );

  // ── SCORE PHASE ──
  if(phase==="score") return (
    <div className="screen" style={{display:"flex",flexDirection:"column"}}>
      <Hdr title="Session Score" sub="Speaking" onBack={submitScore}/>
      <div style={{padding:"20px",display:"flex",flexDirection:"column",gap:16,flex:1,overflowY:"auto"}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:48,marginBottom:8}}>{missionScore>=80?"🌟":missionScore>=50?"💬":"💪"}</div>
          <div style={{fontFamily:"Lora,serif",fontSize:24,fontWeight:600}}>{missionScore}% Mission</div>
          <div style={{fontSize:13,color:"var(--text3)",marginTop:4}}>{usedMissionWords.size} of {missionWords.length} target words used · {userMsgCount} messages sent</div>
        </div>
        {/* Mission words result */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px"}}>
          <div className="sec">Mission Words</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
            {missionWords.map(mw=>{
              const used=usedMissionWords.has(mw.id);
              return <span key={mw.id} style={{fontSize:12,padding:"4px 10px",borderRadius:100,background:used?"var(--know-bg)":"var(--surface2)",border:`1px solid ${used?"var(--know-border)":"var(--border)"}`,color:used?"var(--know)":"var(--text3)",fontWeight:500}}>
                {used?"✓ ":""}{mw.english} · <span className="ar" style={{fontSize:13}}>{mw.arabicBase}</span>
              </span>;
            })}
          </div>
        </div>
        {/* Gentle end-of-session feedback (rephrasings + missed mission words) */}
        {(feedbackLoading||sessionFeedback)&&(
          <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px"}}>
            <div className="sec">Gentle Suggestions</div>
            {feedbackLoading?(
              <div style={{fontSize:13,color:"var(--text3)",display:"flex",alignItems:"center",gap:8,padding:"8px 0"}}>
                <RefreshCw size={14} className="spin"/> Putting together a kind debrief…
              </div>
            ):(
              <>
                {sessionFeedback.rephrasings?.length>0?(
                  <div style={{display:"flex",flexDirection:"column",gap:12}}>
                    {sessionFeedback.rephrasings.map((r,i)=>(
                      <div key={i} style={{fontSize:13,lineHeight:1.65,padding:"8px 10px",background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rxs)"}}>
                        <div style={{fontSize:11,color:"var(--text3)",marginBottom:3}}>You said:</div>
                        <div style={{color:"var(--text2)",marginBottom:6}} dir={/[؀-ۿ]/.test(r.original)?"rtl":"ltr"}>{r.original}</div>
                        <div style={{fontSize:11,color:"var(--accent)",marginBottom:3,fontWeight:600}}>Another natural way:</div>
                        <div className="ar" style={{fontSize:16,color:"var(--text)",marginBottom:4}}>{r.suggested}</div>
                        {r.why&&<div style={{fontSize:11.5,color:"var(--text3)",fontStyle:"italic"}}>{r.why}</div>}
                      </div>
                    ))}
                  </div>
                ):(
                  <div style={{fontSize:13,color:"var(--text3)",padding:"6px 0"}}>Nothing to suggest — you sounded natural this round.</div>
                )}
                {sessionFeedback.missedWords?.length>0&&(
                  <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--border)"}}>
                    <div style={{fontSize:11.5,color:"var(--text3)",marginBottom:6}}>Words to try next time:</div>
                    <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                      {sessionFeedback.missedWords.map((w,i)=>(
                        <span key={i} style={{fontSize:12,padding:"3px 9px",borderRadius:100,background:"var(--surface2)",border:"1px solid var(--border)",color:"var(--text2)"}}>
                          {w.english} · <span className="ar" style={{fontSize:13}}>{w.arabic}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {/* Self rating */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px",textAlign:"center"}}>
          <div className="sec">How did you feel?</div>
          <div className="rating-stars" style={{marginBottom:8}}>
            {[1,2,3,4,5].map(n=><div key={n} className={`rating-star ${sessionRating>=n?"on":""}`} onClick={()=>setSessionRatingLocal(n)}>{n<=2?"😓":n===3?"😐":n===4?"🙂":"🌟"}</div>)}
          </div>
        </div>
        <button className="btn btn-primary" onClick={submitScore} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
          <CheckCircle2 size={15}/> Save & {onFinish?"Finish":"Exit"}
        </button>
        {/* Review conversation */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px"}}>
          <div className="sec">Conversation Review</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:300,overflowY:"auto"}}>
            {messages.map((m,i)=>(
              <div key={i} style={{fontSize:13,lineHeight:1.6,padding:"6px 0",borderBottom:"1px solid var(--border)"}}>
                <span style={{fontWeight:600,color:m.role==="ai"?"var(--accent)":"var(--text2)",fontSize:11}}>{m.role==="ai"?"AI":"You"}:</span>
                <div className={m.role==="ai"?"ar":""} style={m.role==="ai"?{fontSize:15,direction:"rtl"}:{}}>{m.text}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );

  // ── CHAT PHASE ──
  return (
    <div className="screen" style={{display:"flex",flexDirection:"column",paddingBottom:0}}>
      <Hdr title={selectedTopic||"Conversation"} sub={master?"Master Speaking":"Speaking"} onBack={()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();clearSilenceTimer();try{recognitionRef.current?.stop();}catch{}onBack();}}
        right={
          <div style={{display:"flex",gap:6}}>
            {voiceMode&&(
              <button className={`btn btn-sm ${showVoiceTranscript?"btn-primary":""}`} onClick={()=>setShowVoiceTranscript(v=>!v)}
                title={showVoiceTranscript?"Hide what the mic hears":"Show what the mic hears"}
                style={showVoiceTranscript?{}:{background:"var(--surface2)",color:"var(--text2)"}}>
                {showVoiceTranscript?"Show 👁":"Hide 🙈"}
              </button>
            )}
            <button className={`btn btn-sm ${voiceMode?"btn-primary":""}`} onClick={()=>{
              const next=!voiceMode;
              setVoiceMode(next);
              if(!next){
                // Turning voice mode off mid-chain: abort everything.
                handsFreeAbortedRef.current=true;
                stopTtsAudio();
                clearSilenceTimer();
                try{recognitionRef.current?.stop();}catch{}
                setSpeaking(false); setListening(false);
              } else {
                handsFreeAbortedRef.current=false;
              }
            }}
              style={voiceMode?{}:{background:"var(--surface2)",color:"var(--text2)"}}>
              {voiceMode?<><Volume2 size={13}/></>:<><Mic size={13}/></>}
            </button>
            <button className="btn btn-sm" onClick={finishSession} style={{background:"var(--know-bg)",color:"var(--know)",border:"1px solid var(--know-border)"}}>
              <CheckCircle2 size={13}/> Finish
            </button>
          </div>
        }/>
      <div style={{flex:1,display:"flex",flexDirection:"column",padding:"0 20px",overflow:"hidden"}}>
        {/* Turn-status banner — only when voice mode is on, so the user
            knows whether to wait or speak without staring at the mic icon. */}
        {voiceMode&&(
          <div style={{padding:"6px 0",display:"flex",justifyContent:"center"}}>
            <div style={{display:"inline-flex",alignItems:"center",gap:8,padding:"4px 12px",borderRadius:100,fontSize:11.5,fontWeight:600,
              background:speaking?"var(--accent-bg)":listening?"var(--weak-bg)":loading||transcribing?"var(--surface2)":"var(--surface2)",
              border:`1px solid ${speaking?"var(--accent-border)":listening?"var(--weak-border)":"var(--border)"}`,
              color:speaking?"var(--accent)":listening?"var(--weak)":"var(--text3)"}}>
              {speaking?<><Volume2 size={11}/> AI is speaking…</>
                :listening?<><Mic size={11}/> Your turn — speak naturally</>
                :transcribing?<><RefreshCw size={11} className="spin"/> Transcribing…</>
                :loading?<><RefreshCw size={11} className="spin"/> Thinking…</>
                :<><Mic size={11} style={{opacity:.5}}/> Hands-free · waiting</>
              }
            </div>
          </div>
        )}
        {/* Mission words bar */}
        <div style={{padding:"8px 0",display:"flex",gap:5,flexWrap:"wrap",borderBottom:"1px solid var(--border)"}}>
          {missionWords.map(mw=>{
            const used=usedMissionWords.has(mw.id);
            return <span key={mw.id} style={{fontSize:11,padding:"2px 8px",borderRadius:100,background:used?"var(--know-bg)":"var(--surface2)",border:`1px solid ${used?"var(--know-border)":"var(--border)"}`,color:used?"var(--know)":"var(--text3)",fontWeight:500,transition:"all .2s"}}>
              {used?"✓ ":""}<span className="ar" style={{fontSize:12}}>{mw.arabicBase}</span>
            </span>;
          })}
          <span style={{fontSize:10,color:"var(--text3)",alignSelf:"center",marginLeft:"auto"}}>{usedMissionWords.size}/{missionWords.length}</span>
        </div>
        {/* Chat messages — hide voice transcripts unless the user toggled "show" */}
        <div ref={chatRef} style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,paddingTop:10,paddingBottom:12}}>
          {messages.map((m,i)=>{
            if(m.role==="user"&&m.hidden&&!showVoiceTranscript) return null;
            return (
              <div key={i} className={`chat-bubble chat-${m.role==="ai"?"ai":"user"}`} style={m.role==="ai"&&voiceMode?{cursor:"pointer"}:{}}>
                {m.role==="ai"?(
                  <div onClick={voiceMode?()=>handleBubbleTap(m):undefined}>
                    <ClickableArabic text={m.text} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={18}/>
                    <div style={{fontSize:11,color:"var(--text3)",marginTop:4}}>Tap any word to look it up{voiceMode&&(speaking?" · 🔊":" · 🔈")}</div>
                  </div>
                ):(
                  <div>
                    {m.voice&&<div style={{fontSize:10,color:"var(--text3)",marginBottom:2,opacity:.7}}>🎙 transcribed</div>}
                    {m.text}
                  </div>
                )}
              </div>
            );
          })}
          {listening&&(
            <div style={{alignSelf:"center",padding:"6px 14px",color:"var(--text3)",fontSize:12,background:"var(--surface2)",borderRadius:100,display:"flex",alignItems:"center",gap:6}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:"var(--weak)",display:"inline-block",animation:"pulse 1.2s infinite"}}/>
              Listening{_sttEnabled&&_sttKey?" (Whisper)":""}… pause for {Math.round(SILENCE_MS/100)/10}s to send
            </div>
          )}
          {transcribing&&(
            <div style={{alignSelf:"center",padding:"6px 14px",color:"var(--accent)",fontSize:12,background:"var(--accent-bg)",borderRadius:100,display:"flex",alignItems:"center",gap:6}}>
              <RefreshCw size={11} className="spin"/> Transcribing with Whisper…
            </div>
          )}
          {loading&&<div style={{alignSelf:"flex-start",padding:"8px 12px",color:"var(--text3)",fontSize:13}}><RefreshCw size={13} className="spin" style={{marginRight:6}}/>Thinking…</div>}
        </div>
        {/* Input bar */}
        <div style={{padding:"10px 0 16px",display:"flex",gap:8,borderTop:"1px solid var(--border)",alignItems:"center"}}>
          <input className="input" value={input} onChange={e=>setInput(e.target.value)} placeholder={listening?`Listening… (pause ${(SILENCE_MS/1000).toFixed(1)}s to send)`:voiceMode?"Tap mic, or type Arabic / English…":"Type Arabic or English…"}
            onKeyDown={e=>e.key==="Enter"&&input.trim()&&sendMessage()} style={{flex:1,fontSize:15,padding:"12px 14px"}}
            dir={/[\u0600-\u06FF]/.test(input)?"rtl":"ltr"}/>
          {voiceMode&&hasSpeechRecog&&(
            <button className="btn" onClick={startListening}
              style={{width:48,height:48,borderRadius:"50%",flexShrink:0,background:listening?"var(--weak)":"var(--accent)",color:"white",border:"none",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:listening?"0 0 0 4px var(--weak-bg)":"none",animation:listening?"pulse 1.5s infinite":"none"}}>
              <Mic size={20}/>
            </button>
          )}
          <button className="btn btn-primary" onClick={()=>sendMessage()} disabled={loading||!input.trim()} style={{padding:"12px 16px",borderRadius:"var(--rs)"}}>
            <Send size={16}/>
          </button>
        </div>
      </div>
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MASTER REVIEW — Anki-style across all decks
// ─────────────────────────────────────────────────────────────
function MasterReviewScreen({decks,cardStates,onBack,onSwipeCard,onUndoSwipe,onDeckTouched,onToggleWeakForm,trackUsage,onAddToFlashcard,studyLog,onLogStudy,onMasterReading,onMasterListening,onMasterSpeaking}) {
  const SCREEN_NAME="masterReview";
  const saved=useRef(loadScreen(SCREEN_NAME)||{}).current;
  const [started,setStarted]=useState(saved.started||false);
  const [mode,setMode]=useState(saved.mode||"smart");
  const [limit,setLimit]=useState(saved.limit||50);
  const [masterModulePool,setMasterModulePool]=useState(saved.masterModulePool||"all");
  const [sessionCards,setSessionCards]=useState(()=>hydrateSessionCards(saved.sessionCards,cardStates));
  // Clamp in case a card in the saved session was deleted while paused —
  // hydration drops it, which can shorten the array out from under a saved index.
  const [idx,setIdx]=useState(()=>{
    const len=hydrateSessionCards(saved.sessionCards,cardStates).length;
    const savedIdx=typeof saved.idx==="number"?saved.idx:0;
    return len?Math.min(savedIdx,len-1):0;
  });
  const [results,setResults]=useState(saved.results||{known:0,weak:0});
  const [flipped,setFlipped]=useState(false);
  const [gen,setGen]=useState(null);
  const [genLoading,setGenLoading]=useState(false);
  const [imgLoading,setImgLoading]=useState(false);
  const [mPlaying,setMPlaying]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const genRef=useRef(0);
  const [selForm,setSelForm]=useState(null);
  const startRef=useRef(null);
  // Persist session for resume
  const [savedSession,setSavedSession]=useState(()=>saved.savedSession
    ?{...saved.savedSession,cards:hydrateSessionCards(saved.savedSession.cards,cardStates)}
    :null); // {cards,idx,results,mode}
  // Undo history: snapshots of {prevCard, prevIdx, prevResults, deckId}
  const swipeHist=useRef([]);
  // Per-deck rated-card counts THIS sitting — Master Review pools many decks
  // into one session, so "studied" has to be tracked per deck, not per session.
  const touchCounts=useRef({});
  // How many ratings actually mark a given deck "studied" this sitting — normally
  // DECK_TOUCH_THRESHOLD, but capped to however many of that deck's cards are
  // actually in this session. Without this, any deck smaller than the threshold
  // (or one that got cut short by `limit`) could never be rated enough times to
  // count, so its lastStudiedAt never updates — it stays "stalest" forever and
  // keeps re-claiming the front of every future rotation, starving other decks.
  const touchGoals=useRef({});

  // Persist screen state only while a session is active or pausable; otherwise leave storage cleared
  useEffect(()=>{
    if(started||savedSession){
      saveScreen(SCREEN_NAME,{
        started,mode,limit,masterModulePool,
        sessionCards:deflateSessionCards(sessionCards),
        idx,results,
        savedSession:savedSession?{...savedSession,cards:deflateSessionCards(savedSession.cards)}:null,
      });
    }
  },[started,mode,limit,masterModulePool,sessionCards,idx,results,savedSession]);

  // Grammar-rule cards are studied from their own deck (their study UI lives
  // in StudyScreen); keep them out of the master-review vocab queue.
  const allCards=Object.values(cardStates).flat().filter(c=>c.wordType!=="grammar");
  const now=Date.now();
  const dueCards=allCards.filter(c=>c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now);
  const weakCards=allCards.filter(c=>c.status==="weak");
  const newCards=allCards.filter(c=>c.status==="new"||!c.status);
  const knownCards=allCards.filter(c=>c.status==="known");
  const vocabDeckCount=decks.filter(d=>d.deckType!=="grammar").length;
  const neverStudiedDeckCount=decks.filter(d=>d.deckType!=="grammar"&&!d.lastStudiedAt).length;

  const start=(m)=>{
    const startMode=m||mode;
    let pool=[];
    if(startMode==="smart"){
      // Anki-style: due first, then weak, then new
      pool=[...sortByDueDate(dueCards),...weakCards.filter(c=>!dueCards.includes(c)),...newCards];
    } else if(startMode==="due") pool=[...sortByDueDate(dueCards)];
    else if(startMode==="weak") pool=[...weakCards];
    else if(startMode==="new") pool=[...newCards];
    else if(startMode==="rotation"){
      // Cycle through every deck evenly instead of letting due-dates decide —
      // whole decks pulled stalest-first (never-studied decks first), each
      // deck's own cards kept in their natural/creation order (deliberately
      // NOT due/weak-sorted — the point of Rotation is going through a deck
      // top-to-bottom for context and coverage, not an optimized queue).
      // Once this fills `limit`, later (fresher) decks don't make the cut.
      const staleDecks=[...decks].filter(d=>d.deckType!=="grammar").sort((a,b)=>(a.lastStudiedAt||0)-(b.lastStudiedAt||0));
      for(const deck of staleDecks) pool.push(...(cardStates[deck.id]||[]).filter(c=>c.wordType!=="grammar"));
    }
    else pool=[...sortByDueDate(allCards)];
    pool=pool.slice(0,limit);
    if(!pool.length){showToast("No cards available for this mode","error");return;}
    // Tag each card with its deckId for proper state updates
    const tagged=[];
    for(const deck of decks){
      const deckCards=new Set((cardStates[deck.id]||[]).map(c=>c.id));
      pool.forEach(c=>{if(deckCards.has(c.id)&&!tagged.find(t=>t.id===c.id)) tagged.push({...c,_deckId:deck.id});});
    }
    setSessionCards(tagged);setIdx(0);setResults({known:0,weak:0});setFlipped(false);setStarted(true);
    setSavedSession(null);swipeHist.current=[];touchCounts.current={};touchGoals.current=deckTouchGoals(tagged);startRef.current=Date.now();
  };

  const resumeSession=()=>{
    if(!savedSession) return;
    touchGoals.current=deckTouchGoals(savedSession.cards);
    setSessionCards(savedSession.cards);setIdx(savedSession.idx);setResults(savedSession.results);
    setFlipped(false);setSelForm(null);setStarted(true);startRef.current=Date.now();
  };

  const handleSwipe=(dir)=>{
    const card=sessionCards[idx];
    const ns=dir==="right"?"known":"weak";
    // Snapshot for undo BEFORE mutating
    const prevDeckCards=cardStates[card._deckId]||[];
    const prevCard=prevDeckCards.find(c=>c.id===card.id);
    if(prevCard){
      swipeHist.current.push({
        prevCard:JSON.parse(JSON.stringify(prevCard)),
        prevIdx:idx,
        prevResults:{...results},
        deckId:card._deckId,
      });
    }
    const newResults={...results,[ns]:results[ns]+1};
    setResults(newResults);
    // Grade whatever form the card actually ASKED for (testForm), not
    // whichever reference chip the user happened to be peeking at — those
    // are independent (see "Select a form" section below the flip card).
    onSwipeCard(card._deckId,card.id,ns,pendingTestForm(card)||selForm);
    touchCounts.current[card._deckId]=(touchCounts.current[card._deckId]||0)+1;
    const touchGoal=touchGoals.current[card._deckId]||DECK_TOUCH_THRESHOLD;
    if(touchCounts.current[card._deckId]===touchGoal&&onDeckTouched) onDeckTouched(card._deckId);
    if(idx<sessionCards.length-1){
      const nextIdx=idx+1;
      setIdx(nextIdx);setFlipped(false);setSelForm(null);setGen(null);setGenLoading(false);
      if(window.speechSynthesis) window.speechSynthesis.cancel();setMPlaying(false);
      // Save for resume
      setSavedSession({cards:sessionCards,idx:nextIdx,results:newResults});
    } else {
      if(startRef.current){
        const mins=Math.max(1,Math.round((Date.now()-startRef.current)/60000));
        onLogStudy({type:"app",module:"vocab",minutes:mins,subtype:"master-review"});
      }
      setStarted(false);setMode("done");setSavedSession(null);
      saveScreen(SCREEN_NAME,null);saveSession(null);
    }
  };

  const undoMasterSwipe=()=>{
    const snap=swipeHist.current.pop();
    if(!snap) return;
    if(onUndoSwipe) onUndoSwipe(snap.deckId,snap.prevCard);
    setIdx(snap.prevIdx);
    setResults(snap.prevResults);
    setFlipped(false);setSelForm(null);setGen(null);setGenLoading(false);
    if(window.speechSynthesis) window.speechSynthesis.cancel();setMPlaying(false);
    setSavedSession({cards:sessionCards,idx:snap.prevIdx,results:snap.prevResults});
  };

  // Keyboard shortcuts
  useEffect(()=>{
    if(!started) return;
    const handler=(e)=>{
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
      if((e.key===" "||e.key==="Enter")&&!flipped){e.preventDefault();setFlipped(true);}
      if(flipped&&e.key==="ArrowLeft"){e.preventDefault();handleSwipe("left");}
      if(flipped&&e.key==="ArrowRight"){e.preventDefault();handleSwipe("right");}
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[started,flipped,idx,selForm]);

  const card=sessionCards[idx];

  // Results screen
  if(mode==="done"){
    const total=results.known+results.weak;
    const pct=total?Math.round(results.known/total*100):0;
    return (
      <div className="screen" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",padding:28,textAlign:"center"}}>
        <div className="pop-appear" style={{width:"100%",maxWidth:340}}>
          <div style={{fontSize:52,marginBottom:14}}>{pct>=80?"🌟":pct>=50?"✦":"💪"}</div>
          <div style={{fontFamily:"Lora,serif",fontSize:24,fontWeight:600,marginBottom:8}}>Master Review Complete</div>
          <div style={{fontSize:14,color:"var(--text2)",marginBottom:16}}>
            <span style={{color:"var(--know)",fontWeight:700}}>{results.known} known</span> · <span style={{color:"var(--weak)",fontWeight:700}}>{results.weak} weak</span>
          </div>
          <div className="progress-track" style={{height:6,marginBottom:24}}>
            <div className="progress-fill" style={{width:`${pct}%`,background:pct>=70?"var(--know)":"var(--weak)"}}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button className="btn" onClick={()=>{saveScreen(SCREEN_NAME,null);saveSession(null);setMode("smart");}} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"13px",borderRadius:"var(--rs)",fontWeight:600}}>Review Again</button>
            <button className="btn btn-primary" onClick={()=>{saveScreen(SCREEN_NAME,null);saveSession(null);onBack();}} style={{flex:1,padding:"13px",borderRadius:"var(--rs)"}}> Home</button>
          </div>
        </div>
      </div>
    );
  }

  // Generate learning aid for master review cards
  const generateAid=async()=>{
    if(!selForm||genLoading||!card) return;
    const id=++genRef.current;
    const arabicForm=card.forms?.[selForm];if(!arabicForm) return;
    setGenLoading(true);setGen(null);
    // Pull a wide pool of words the user has studied, shuffled fresh each time
    const learnedPool=Object.values(cardStates).flat().filter(c=>c.status==="known"||c.status==="weak");
    const learnedSample=[...learnedPool].sort(()=>Math.random()-0.5).slice(0,60).map(c=>c.arabicBase).join("، ");
    try {
      const raw=await callClaudeWithTashkeel(
        `${BAYNA_YADAYK_STYLE}

You are creating a master-review sentence aid in this register.
Word: "${card.english}" · Arabic form "${arabicForm}" (${FORM_LABELS[selForm]||selForm})
Generate:
1) ONE short Arabic sentence (6-12 words) using EXACTLY: ${arabicForm}
2) English translation
3) A short mnemonic image idea (1-2 sentences) — ONE single iconic subject that visually captures the word's meaning. Think simple sticker-style flashcard art, not a busy scene. RELIGIOUS CONSTRAINT: do NOT describe people's faces, animal faces, or eyes of any kind. Prefer objects, symbols, scenery, hands, or back-views/silhouettes. Never mention eyes. No Arabic text in the image.

QUALITY RULES — non-negotiable:
- Sentence sounds like a real native speaker in daily life (home, masjid, market, with family) — never textbook filler.
- Weave in as many of the learner's already-studied words as fits naturally (do NOT force them). Pool: ${learnedSample||"(none yet)"}
- Grammatically correct and idiomatic Modern Standard Arabic.

CRITICAL: Every Arabic word MUST have full tashkeel.
Return ONLY valid JSON: {"sentence":"...","translation":"...","imagePrompt":"..."}`,
        350,"sentence",trackUsage
      );
      if(id!==genRef.current) return;
      const parsed=extractJSON(raw);
      setGen({...parsed,imageUrl:null});
      setGenLoading(false);
      // Image generation is opt-in (Settings → Image Model → "Auto-generate
      // images"), same as the per-deck study screen.
      if(_autoGenerateImage){
        setImgLoading(true);
        const url=await generateImage(parsed.imagePrompt,trackUsage);
        if(id!==genRef.current) return;
        setGen(prev=>prev?{...prev,imageUrl:url}:prev);
        setImgLoading(false);
      }
    } catch (err) {
      if(id!==genRef.current) return;
      setGen({sentence:arabicForm,translation:card.english,imagePrompt:`A warm everyday scene representing "${card.english}" in Arabic-speaking daily life, natural lighting.`,imageUrl:null,error:err?.message||"Generation failed"});
      setGenLoading(false);setImgLoading(false);
      showToast(`Couldn't generate: ${err?.message||"unknown error"} — check your OpenRouter key in Settings.`,"error");
    }
  };
  const playMasterAudio=()=>{
    if(!gen?.sentence) return;
    if(mPlaying){stopTtsAudio();setMPlaying(false);return;}
    synthesizeArabic(gen.sentence,{onStart:()=>setMPlaying(true),onEnd:()=>setMPlaying(false)});
  };

  // Active study
  if(started&&card){
    const availForms=Object.entries(card.forms||{}).filter(([,v])=>v);
    const testForm=pendingTestForm(card);
    if(!selForm&&availForms.length){
      setTimeout(()=>setSelForm(testForm||availForms[0]?.[0]||null),0);
    }
    // Rotation groups whole decks together in session order, so "which deck
    // am I in, how far through it" is meaningful here (unlike Smart/Due/Weak,
    // which jumble cards from many decks and would make this flicker).
    let deckBreadcrumb=null;
    if(mode==="rotation"&&card._deckId){
      const cardDeck=decks.find(d=>d.id===card._deckId);
      if(cardDeck){
        const deckCardsInSession=sessionCards.filter(c=>c._deckId===card._deckId);
        deckBreadcrumb={title:cardDeck.title,pos:deckCardsInSession.findIndex(c=>c.id===card.id)+1,total:deckCardsInSession.length};
      }
    }
    return (
      <div className="screen" style={{display:"flex",flexDirection:"column",padding:"18px 18px 20px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <button className="btn btn-ghost" onClick={()=>setStarted(false)} title="Pause — resume from the menu anytime" style={{width:32,height:32}}><X size={14}/></button>
          <span style={{fontSize:13,color:"var(--text2)",fontWeight:600}}>{idx+1} / {sessionCards.length}</span>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <button className="btn btn-ghost" onClick={undoMasterSwipe} disabled={!swipeHist.current.length} title="Undo last swipe" style={{width:32,height:32,opacity:swipeHist.current.length?1:0.3}}><ArrowLeft size={14}/></button>
            <span style={{fontSize:12,color:"var(--text3)"}}><span style={{color:"var(--know)"}}>{results.known}✓</span> <span style={{color:"var(--weak)"}}>{results.weak}✗</span></span>
          </div>
        </div>
        <div className="progress-track" style={{marginBottom:deckBreadcrumb?8:16}}><div className="progress-fill" style={{width:`${((idx+1)/sessionCards.length)*100}%`,background:"var(--accent)"}}/></div>
        {deckBreadcrumb&&(
          <div style={{fontSize:12,fontWeight:600,color:"var(--text2)",marginBottom:16,display:"flex",alignItems:"center",gap:6}}>
            <Layers size={12} color="var(--text3)"/> {deckBreadcrumb.title}
            <span style={{color:"var(--text3)",fontWeight:400}}>· card {deckBreadcrumb.pos}/{deckBreadcrumb.total} of this deck</span>
          </div>
        )}

        <div style={{flex:1,display:"flex",flexDirection:"column",gap:13,overflowY:"auto"}}>
          {/* True 2-faced flip card — click anywhere on the card to toggle */}
          <div key={`flip${idx}`} className={`flip-card ${flipped?'is-flipped':''}`} onClick={()=>setFlipped(f=>!f)}>
            <div className="flip-card-inner">
              <div className="flip-card-face">
                <div className="sec" style={{marginBottom:16}}>{testForm?`English · Give the ${FORM_LABELS[testForm]||testForm}`:"English"}</div>
                <div style={{fontFamily:"Lora,serif",fontSize:36,fontWeight:600,lineHeight:1.2}}>{card.english}</div>
                <div style={{fontSize:12,color:"var(--text3)",marginTop:20}}>Tap to reveal · <span className="kbd">Space</span></div>
              </div>
              <div className="flip-card-face flip-card-back">
                <div className="sec" style={{marginBottom:5}}>{testForm?<>Arabic · <span style={{color:"var(--weak)"}}>{FORM_LABELS[testForm]||testForm} (retest)</span></>:<>Arabic · <span style={{textTransform:"capitalize"}}>{card.wordType}</span></>}</div>
                <div className="ar" style={{fontSize:40,color:"var(--text)"}}>{testForm?card.forms[testForm]:card.arabicBase}</div>
                <div style={{fontSize:13,color:"var(--text3)"}}>{card.english}{testForm?` · ${FORM_LABELS[testForm]||testForm}`:""}</div>
                {card.srsStreak>0&&<div style={{display:"inline-flex",alignItems:"center",gap:4,marginTop:6,fontSize:11,color:"var(--know)"}}>{"🔥".repeat(Math.min(card.srsStreak,5))} {card.srsStreak} streak</div>}
                {card.forms?.harf&&<div style={{display:"inline-flex",alignItems:"center",gap:5,marginTop:7,background:"var(--harf-bg)",border:"1px solid var(--harf-border)",borderRadius:100,padding:"3px 11px"}}><span className="ar" style={{fontSize:17,color:"var(--harf)",fontWeight:600}}>{card.forms.harf}</span></div>}
                <div style={{fontSize:11,color:"var(--text3)",marginTop:14,fontWeight:500}}>↻ Tap to flip back</div>
              </div>
            </div>
          </div>
          {flipped&&(
            <div className="gen-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"18px 17px",boxShadow:"0 5px 24px rgba(0,0,0,0.08)"}}>
              <div className="sec">Select a form</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:12}}>
                {availForms
                  .filter(([k])=>k!=="harf")
                  .sort((a,b)=>{
                    const order=["past","present","future","imperative","masdar","activePart","passivePart","singular","plural","plural2","masculine","feminine","synonym","synonymPlural","antonym","antonymPlural"];
                    return (order.indexOf(a[0])===-1?99:order.indexOf(a[0]))-(order.indexOf(b[0])===-1?99:order.indexOf(b[0]));
                  })
                  .map(([key,val])=>{
                    const isWeak=(card.weakForms||[]).includes(key);
                    const canFlag=INFLECTIONAL_FORMS.has(key);
                    return (
                    <button key={key} className={`chip ${selForm===key?"chip-on":""}`} onClick={()=>{setSelForm(key);setGen(null);}} style={{padding:"8px 14px"}}>
                      {canFlag&&<span onClick={(e)=>{e.stopPropagation();onToggleWeakForm?.(card._deckId,card.id,key);}}
                        title={isWeak?"Marked weak — tap to clear":"Tap to flag this form weak"}
                        style={{color:isWeak?(selForm===key?"rgba(255,200,200,.9)":"var(--weak)"):(selForm===key?"rgba(255,255,255,.4)":"var(--border)"),fontSize:13,marginRight:1,cursor:"pointer"}}>{isWeak?"●":"○"}</span>}
                      {FORM_LABELS[key]||key}<span className="ar" style={{fontSize:16,color:selForm===key?"rgba(255,255,255,.75)":"var(--text2)",fontWeight:500}}>· {val}</span>
                    </button>
                    );
                  })}
              </div>
              {selForm&&card.forms[selForm]&&(
                <div style={{textAlign:"center",background:"var(--accent-bg)",borderRadius:"var(--rxs)",padding:"9px 13px",marginBottom:12}}>
                  <div style={{fontSize:11,color:"var(--text3)",marginBottom:3}}>{FORM_LABELS[selForm]}</div>
                  <div className="ar" style={{fontSize:28,color:"var(--accent)",fontWeight:500}}>{card.forms[selForm]}</div>
                </div>
              )}
              <button className="btn btn-primary" onClick={generateAid} disabled={genLoading||!selForm} style={{width:"100%",padding:"10px",borderRadius:"var(--rs)",fontSize:13,marginBottom:gen?10:0}}>
                {genLoading?<><RefreshCw size={13} className="spin"/>Generating…</>:<><Sparkles size={13}/>Generate Learning Aid</>}
              </button>
              {gen&&!genLoading&&(
                <div className="gen-appear" style={{display:"flex",flexDirection:"column",gap:8}}>
                  {gen.error&&(
                    <div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rs)",padding:"10px 13px",display:"flex",alignItems:"center",gap:10,fontSize:13}}>
                      <span style={{fontSize:18}}>⚠️</span>
                      <div style={{flex:1,color:"var(--weak)",lineHeight:1.5}}>
                        <div style={{fontWeight:600,marginBottom:2}}>Couldn't generate fully</div>
                        <div style={{fontSize:12,color:"var(--text3)"}}>{gen.error}</div>
                      </div>
                      <button className="btn" onClick={generateAid} style={{background:"var(--weak)",color:"white",fontSize:12,padding:"6px 12px",borderRadius:"var(--rxs)"}}>
                        <RefreshCw size={12}/> Retry
                      </button>
                    </div>
                  )}
                  {/* Image — Nano Banana generated, skeleton while loading, or opt-in button */}
                  {imgLoading?(
                    <div style={{position:"relative",width:"100%",aspectRatio:"1",background:"linear-gradient(110deg,var(--surface2) 30%,var(--border) 50%,var(--surface2) 70%)",backgroundSize:"200% 100%",animation:"shimmer 2s linear infinite",border:"1px solid var(--border)",borderRadius:"var(--rs)",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:8}}>
                      <RefreshCw size={20} className="spin" color="var(--text3)"/>
                      <div style={{fontSize:12,color:"var(--text3)",fontWeight:500}}>Drawing with Nano Banana…</div>
                      <div style={{fontSize:10,color:"var(--text3)",opacity:.7}}>usually 3-5 seconds</div>
                    </div>
                  ):gen.imageUrl?(
                    <div style={{position:"relative"}}>
                      <img src={gen.imageUrl} alt={`Scene for ${card.english}`} style={{width:"100%",display:"block",borderRadius:"var(--rs)",border:"1px solid var(--border)"}}/>
                      <button
                        onClick={async()=>{
                          if(!gen.imagePrompt) return;
                          setImgLoading(true);
                          const url=await generateImage(gen.imagePrompt,trackUsage);
                          setGen(prev=>prev?{...prev,imageUrl:url}:prev);
                          setImgLoading(false);
                        }}
                        title={`Regenerate this image · costs ~$${(IMAGE_PRICES[_imageModel]||0.039).toFixed(3)}`}
                        style={{position:"absolute",top:8,right:8,width:32,height:32,borderRadius:"50%",background:"rgba(0,0,0,.55)",color:"white",border:"none",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",backdropFilter:"blur(4px)"}}>
                        <RefreshCw size={14}/>
                      </button>
                    </div>
                  ):gen.imagePrompt?(
                    <button
                      onClick={async()=>{
                        if(!gen.imagePrompt) return;
                        setImgLoading(true);
                        const url=await generateImage(gen.imagePrompt,trackUsage);
                        setGen(prev=>prev?{...prev,imageUrl:url}:prev);
                        setImgLoading(false);
                      }}
                      style={{background:"var(--surface2)",border:"1px dashed var(--border)",borderRadius:"var(--rs)",padding:"12px 14px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,fontSize:12.5,color:"var(--text2)",fontWeight:500,width:"100%"}}>
                      <ImageIcon size={14}/> Add a mnemonic image
                      <span style={{fontSize:11,color:"var(--text3)",fontWeight:400,fontFamily:"monospace"}}>~${(IMAGE_PRICES[_imageModel]||0.039).toFixed(3)}</span>
                    </button>
                  ):null}
                  <div style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rs)",padding:"10px 12px"}}>
                    <div style={{fontSize:10,fontWeight:700,color:"var(--accent)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:5}}>Example Sentence</div>
                    <ClickableArabic text={gen.sentence} highlightWords={[card.forms[selForm]||card.arabicBase]} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={20}/>
                    <div style={{fontSize:11,color:"var(--text3)",marginTop:3}}>Tap any word to look it up</div>
                    <div style={{fontSize:12.5,color:"var(--text2)",fontStyle:"italic",marginTop:4}}>{gen.translation}</div>
                  </div>
                  <button className="btn" onClick={playMasterAudio}
                    style={{background:mPlaying?"var(--accent)":"transparent",color:mPlaying?"white":"var(--accent)",border:"1.5px solid var(--accent)",borderRadius:"var(--rs)",padding:"9px",width:"100%",fontSize:13,fontWeight:600}}>
                    <Volume2 size={14}/> {mPlaying?"Playing…":"Play Audio"}
                  </button>
                </div>
              )}
            </div>
          )}
          {flipped&&(
            <div style={{display:"flex",gap:10}}>
              <button className="btn" onClick={()=>handleSwipe("left")} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--weak-bg)",color:"var(--weak)",border:"1.5px solid var(--weak-border)",fontWeight:600,fontSize:13.5}}>← Weak</button>
              <button className="btn" onClick={()=>handleSwipe("right")} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--know-bg)",color:"var(--know)",border:"1.5px solid var(--know-border)",fontWeight:600,fontSize:13.5}}>Know It →</button>
            </div>
          )}
          {flipped&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:11,marginTop:4,display:"flex",justifyContent:"center",gap:12}}>
            <span><span className="kbd">←</span> Weak</span><span><span className="kbd">→</span> Know</span>
          </div>}
        </div>
        {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
      </div>
    );
  }

  // Mode picker
  return (
    <div className="screen">
      <Hdr title="Master Review" sub="All Decks" onBack={onBack}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div style={{fontSize:13.5,color:"var(--text2)",lineHeight:1.6}}>
          Review cards from all your decks in one session. Like Anki — due cards first, then weak, then new.
        </div>

        {/* Card limit */}
        <div>
          <div className="sec">Cards Per Session</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {[20,50,100,150,200,999].map(n=>(
              <button key={n} className={`chip ${limit===n?"chip-on":""}`} onClick={()=>setLimit(n)} style={{flex:1,justifyContent:"center",padding:"8px 0",fontSize:12,minWidth:48}}>
                {n>=999?"All":n}
              </button>
            ))}
          </div>
        </div>

        {/* Mode selection */}
        <div className="sec">Review Mode</div>
        {savedSession&&(
          <button className="btn btn-primary" onClick={resumeSession} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14,marginBottom:8}}>
            <BookOpen size={15}/> Resume (Card {savedSession.idx+1}/{savedSession.cards.length}) · {savedSession.results.known}✓ {savedSession.results.weak}✗
          </button>
        )}
        <div className="test-option" onClick={()=>{setMode("smart");start("smart");}}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--accent-bg)",display:"flex",alignItems:"center",justifyContent:"center"}}><Zap size={18} color="var(--accent)"/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14}}>Smart Review</div>
            <div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>Due ({dueCards.length}) → Weak ({weakCards.length}) → New ({newCards.length})</div>
          </div>
        </div>
        <div className="test-option" onClick={()=>{setMode("rotation");start("rotation");}}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--know-bg)",display:"flex",alignItems:"center",justifyContent:"center"}}><RotateCcw size={18} color="var(--know)"/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14}}>Rotation</div>
            <div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>Cycles every deck evenly, staleest first · {vocabDeckCount} decks{neverStudiedDeckCount?`, ${neverStudiedDeckCount} never studied`:""}</div>
          </div>
        </div>
        {dueCards.length>0&&(
          <div className="test-option" onClick={()=>{setMode("due");start("due");}}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--info-bg)",display:"flex",alignItems:"center",justifyContent:"center"}}><Clock size={18} color="var(--info)"/></div>
            <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>Due Cards Only</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{dueCards.length} cards past their review date</div></div>
          </div>
        )}
        {weakCards.length>0&&(
          <div className="test-option" onClick={()=>{setMode("weak");start("weak");}}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--weak-bg)",display:"flex",alignItems:"center",justifyContent:"center"}}><Target size={18} color="var(--weak)"/></div>
            <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>Weak Cards Only</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{weakCards.length} cards marked weak</div></div>
          </div>
        )}
        {newCards.length>0&&(
          <div className="test-option" onClick={()=>{setMode("new");start("new");}}>
            <div style={{width:40,height:40,borderRadius:12,background:"var(--surface2)",display:"flex",alignItems:"center",justifyContent:"center"}}><Plus size={18} color="var(--text3)"/></div>
            <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>New Cards Only</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{newCards.length} unreviewed cards</div></div>
          </div>
        )}
        <div className="test-option" onClick={()=>{setMode("all");start("all");}}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--surface2)",display:"flex",alignItems:"center",justifyContent:"center"}}><Layers size={18} color="var(--text2)"/></div>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>All Cards</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>{allCards.length} total across all decks</div></div>
        </div>

        {/* Queue breakdown */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
          <div className="sec">Queue Breakdown</div>
          <div style={{display:"flex",gap:16,fontSize:13}}>
            <div><span style={{fontWeight:700,color:"var(--info)"}}>{dueCards.length}</span> <span style={{color:"var(--text3)"}}>due</span></div>
            <div><span style={{fontWeight:700,color:"var(--weak)"}}>{weakCards.length}</span> <span style={{color:"var(--text3)"}}>weak</span></div>
            <div><span style={{fontWeight:700,color:"var(--text3)"}}>{newCards.length}</span> <span style={{color:"var(--text3)"}}>new</span></div>
            <div><span style={{fontWeight:700,color:"var(--know)"}}>{knownCards.length}</span> <span style={{color:"var(--text3)"}}>known</span></div>
          </div>
        </div>

        {/* Master Module Sessions */}
        <div className="sec" style={{marginTop:4}}>Master Practice Sessions</div>
        <div style={{fontSize:12,color:"var(--text3)",marginBottom:8,lineHeight:1.5}}>
          These sessions count toward your skill scores. Choose a card pool:
        </div>
        {/* Card pool selector for modules */}
        <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
          {[["all",`All (${allCards.length})`],["weak",`Weak (${weakCards.length})`],["due",`Due (${dueCards.length})`]].map(([k,label])=>(
            <button key={k} className={`chip ${masterModulePool===k?"chip-on":""}`} onClick={()=>setMasterModulePool(k)} style={{flex:1,justifyContent:"center",padding:"7px 0",fontSize:12}}>{label}</button>
          ))}
        </div>
        <div className="test-option" onClick={()=>onMasterReading(masterModulePool)}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--read)",display:"flex",alignItems:"center",justifyContent:"center"}}><FileText size={18} color="white"/></div>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--read)"}}>Master Reading</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>AI passage from {masterModulePool==="all"?"all":masterModulePool} cards</div></div>
        </div>
        <div className="test-option" onClick={()=>onMasterListening(masterModulePool)}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--listen)",display:"flex",alignItems:"center",justifyContent:"center"}}><Headphones size={18} color="white"/></div>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--listen)"}}>Master Listening</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>Audio from {masterModulePool==="all"?"all":masterModulePool} cards</div></div>
        </div>
        <div className="test-option" onClick={()=>onMasterSpeaking(masterModulePool)}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center"}}><MessageCircle size={18} color="white"/></div>
          <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14,color:"var(--accent)"}}>Master Speaking</div><div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>Conversation from {masterModulePool==="all"?"all":masterModulePool} cards</div></div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SESSION RATING (shown after reading/listening/conversation)
// ─────────────────────────────────────────────────────────────
function SessionRating({module,onSubmit,onSkip}) {
  const [rating,setRating]=useState(0);
  return (
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget) onSkip();}}>
      <div className="drawer" style={{textAlign:"center",padding:"28px 24px 36px"}}>
        <div style={{fontSize:32,marginBottom:8}}>
          {module==="reading"?"📖":module==="listening"?"🎧":module==="writing"?"✍️":"💬"}
        </div>
        <div style={{fontFamily:"Lora,serif",fontSize:18,fontWeight:600,marginBottom:4}}>How did that session feel?</div>
        <div style={{fontSize:13,color:"var(--text3)",marginBottom:20}}>Rate your {module} session</div>
        <div className="rating-stars" style={{marginBottom:20}}>
          {[1,2,3,4,5].map(n=>(
            <div key={n} className={`rating-star ${rating>=n?"on":""}`} onClick={()=>setRating(n)}>
              {n<=2?"😓":n===3?"😐":n===4?"🙂":"🌟"}
            </div>
          ))}
        </div>
        <div style={{fontSize:12,color:"var(--text3)",marginBottom:16}}>
          {rating===0?"Tap to rate":rating<=2?"Challenging — that's okay!":rating===3?"Moderate — getting there":rating===4?"Good session!":"Excellent recall!"}
        </div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn" onClick={onSkip} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)"}}>Skip</button>
          <button className="btn btn-primary" onClick={()=>onSubmit(rating)} disabled={!rating} style={{flex:2,padding:"12px",borderRadius:"var(--rs)"}}><Check size={14}/> Save Rating</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SIMPLE BAR CHART
// ─────────────────────────────────────────────────────────────
function BarChart({data,maxVal,color1="var(--accent)",color2="var(--info)"}){
  const max=maxVal||Math.max(...data.map(d=>d.total),1);
  return (
    <div className="bar-chart">
      {data.map((d,i)=>(
        <div key={i} className="bar-col">
          <div style={{width:"100%",display:"flex",flexDirection:"column",justifyContent:"flex-end",height:"100%",gap:1}}>
            {d.manual>0&&<div className="bar-fill" style={{height:`${(d.manual/max)*100}%`,background:color2,opacity:.6}}/>}
            <div className="bar-fill" style={{height:`${(d.app/max)*100}%`,background:color1}}/>
          </div>
          <div className="bar-label">{d.label}</div>
          {d.total>0&&<div style={{fontSize:9,color:"var(--text2)",fontWeight:600}}>{d.total}m</div>}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// PROGRESS / ANALYTICS DASHBOARD
// ─────────────────────────────────────────────────────────────
function ProgressScreen({cardStates,studyLog,onBack,onLogManual}) {
  const allCards=Object.values(cardStates).flat();
  const known=allCards.filter(c=>c.status==="known").length;
  const weak=allCards.filter(c=>c.status==="weak").length;
  const newC=allCards.filter(c=>c.status==="new"||!c.status).length;
  const total=allCards.length;
  const knownPct=total?Math.round(known/total*100):0;

  const todayEntries=getEntriesForDate(studyLog,TODAY_KEY());
  const todayMin=sumMinutes(todayEntries);
  const weekData=getLast7DaysData(studyLog);
  const weekMin=sumMinutes(getEntriesForWeek(studyLog));
  const weekByMod=minutesByModule(getEntriesForWeek(studyLog));
  const dailyTarget=studyLog?.targets?.dailyMinutes||30;
  const weeklyTarget=studyLog?.targets?.weeklyMinutes||150;
  const insights=getPerformanceInsights(cardStates,studyLog);

  // Skill scores from master sessions only
  const skillScores=getModuleSkillScores(studyLog);
  const vocabProgress=getVocabProgress(cardStates);

  const [showLog,setShowLog]=useState(false);
  const [manualMin,setManualMin]=useState("");
  const [manualNote,setManualNote]=useState("");
  const [manualModule,setManualModule]=useState("manual");
  const [manualDate,setManualDate]=useState(TODAY_KEY());
  const [tab,setTab]=useState("performance"); // performance | progress

  const submitManual=()=>{
    const mins=parseInt(manualMin);
    if(!mins||mins<=0){showToast("Enter valid minutes","error");return;}
    onLogManual({type:"manual",module:manualModule,minutes:mins,notes:manualNote||undefined,date:manualDate});
    setManualMin("");setManualNote("");setShowLog(false);
    showToast(`Logged ${mins} min of ${manualDate===TODAY_KEY()?"today's":manualDate} study`,"success");
  };

  return (
    <div className="screen">
      <Hdr title="Analytics" sub="Progress & Performance" onBack={onBack}
        right={<button className="btn btn-sm" onClick={()=>setShowLog(true)} style={{background:"var(--surface2)",color:"var(--text2)"}}><PenLine size={13}/>Log</button>}/>
      <div style={{padding:"12px 20px 0"}}>
        {/* Tab toggle */}
        <Seg options={[{value:"performance",label:"Performance"},{value:"progress",label:"Progress"}]} value={tab} onChange={setTab}/>
      </div>
      <div style={{padding:"16px 20px 0",display:"flex",flexDirection:"column",gap:16}}>

        {tab==="performance"&&(
          <>
            {/* B2 Vocab Progress */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"16px"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div className="sec" style={{margin:0}}>Vocabulary → B2 Level</div>
                <span style={{fontSize:13,fontWeight:700,color:"var(--accent)"}}>{vocabProgress.pct}%</span>
              </div>
              <div className="progress-track" style={{height:10,marginBottom:8}}>
                <div className="progress-fill" style={{width:`${vocabProgress.pct}%`,background:"linear-gradient(90deg, var(--accent), var(--know))"}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                <span style={{color:"var(--accent)",fontWeight:600}}>{vocabProgress.total} cards <span style={{color:"var(--text3)",fontWeight:400}}>· {vocabProgress.known} known</span></span>
                <span style={{color:"var(--text3)"}}>B2 target: ~{B2_WORD_TARGET.toLocaleString()} words</span>
              </div>
              <div style={{fontSize:11,color:"var(--text3)",marginTop:6,lineHeight:1.5}}>
                {vocabProgress.pct>=80?"Approaching B2 vocabulary level! Focus on mastery.":
                 vocabProgress.pct>=50?"Solid progress. Over halfway to B2 vocab.":
                 vocabProgress.pct>=20?"Building foundation. Keep adding and reviewing.":
                 "Early stage. Every word counts at this point."}
              </div>
            </div>

            {/* Skill Scores from master sessions */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"16px"}}>
              <div className="sec">Skill Scores (Master Sessions Only)</div>
              <div style={{fontSize:11,color:"var(--text3)",marginBottom:12,lineHeight:1.5}}>
                Based on your session ratings when using all vocabulary. Cherry-picked sessions don't count here.
              </div>
              <div style={{display:"flex",gap:8}}>
                {[["vocab","Vocab",BookOpen,"var(--accent)"],["reading","Reading",FileText,"var(--read)"],["listening","Listen",Headphones,"var(--listen)"],["speaking","Speak",MessageCircle,"var(--accent)"]].map(([key,label,Icon,color])=>{
                  const score=skillScores[key];
                  return (
                    <div key={key} className="stat-card" style={{padding:"10px 8px"}}>
                      <Icon size={14} color={color} style={{marginBottom:4}}/>
                      <div className="stat-num" style={{fontSize:18,color:score?color:"var(--text3)"}}>{score||"—"}</div>
                      <div className="stat-label" style={{fontSize:9}}>{label}</div>
                      {score&&<div style={{width:"100%",marginTop:4}}><div className="progress-track" style={{height:3}}><div className="progress-fill" style={{width:`${score/5*100}%`,background:color}}/></div></div>}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Card status breakdown */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px"}}>
              <div className="sec">Vocabulary Status</div>
              <div style={{display:"flex",gap:6,marginBottom:10}}>
                <div style={{flex:known||0.01,height:8,borderRadius:4,background:"var(--know)",transition:"flex .5s"}}/>
                <div style={{flex:weak||0.01,height:8,borderRadius:4,background:"var(--weak)",transition:"flex .5s"}}/>
                <div style={{flex:newC||0.01,height:8,borderRadius:4,background:"var(--surface2)",transition:"flex .5s"}}/>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12}}>
                <span style={{color:"var(--know)"}}>{known} known ({knownPct}%)</span>
                <span style={{color:"var(--weak)"}}>{weak} weak</span>
                <span style={{color:"var(--text3)"}}>{newC} new</span>
              </div>
            </div>

            {/* Performance insights */}
            {insights.length>0&&(
              <div>
                <div className="sec">Insights</div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {insights.map((ins,i)=>(<div key={i} className={`insight-card ${ins.type}`}><span style={{fontSize:16,flexShrink:0}}>{ins.icon}</span><span>{ins.text}</span></div>))}
                </div>
              </div>
            )}
          </>
        )}

        {tab==="progress"&&(
          <>
            {/* Today + Week summary */}
            <div style={{display:"flex",gap:8}}>
              <div className="stat-card" style={{borderColor:todayMin>=dailyTarget?"var(--know-border)":"var(--border)"}}>
                <div className="stat-num" style={{color:todayMin>=dailyTarget?"var(--know)":"var(--text)"}}>{todayMin}</div>
                <div className="stat-label">min today</div>
                <div style={{fontSize:10,color:"var(--text3)",marginTop:2}}>/{dailyTarget}m target</div>
              </div>
              <div className="stat-card" style={{borderColor:weekMin>=weeklyTarget?"var(--know-border)":"var(--border)"}}>
                <div className="stat-num" style={{color:weekMin>=weeklyTarget?"var(--know)":"var(--text)"}}>{weekMin}</div>
                <div className="stat-label">min this week</div>
                <div style={{fontSize:10,color:"var(--text3)",marginTop:2}}>/{weeklyTarget}m target</div>
              </div>
            </div>

            {/* Daily progress bar */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:6}}>
                <span style={{color:"var(--text2)",fontWeight:600}}>Today</span>
                <span style={{color:todayMin>=dailyTarget?"var(--know)":"var(--text3)",fontWeight:700}}>{Math.min(100,Math.round(todayMin/dailyTarget*100))}%</span>
              </div>
              <div className="progress-track" style={{height:6}}><div className="progress-fill" style={{width:`${Math.min(100,todayMin/dailyTarget*100)}%`,background:todayMin>=dailyTarget?"var(--know)":"var(--accent)"}}/></div>
            </div>

            {/* 7-day chart */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px"}}>
              <div className="sec">Last 7 Days</div>
              <BarChart data={weekData}/>
              <div style={{display:"flex",gap:12,marginTop:8,justifyContent:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--text3)"}}><div style={{width:8,height:8,borderRadius:2,background:"var(--accent)"}}/> App</div>
                <div style={{display:"flex",alignItems:"center",gap:4,fontSize:11,color:"var(--text3)"}}><div style={{width:8,height:8,borderRadius:2,background:"var(--info)",opacity:.6}}/> Outside</div>
              </div>
            </div>

            {/* Module breakdown */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"14px"}}>
              <div className="sec">Module Activity (This Week)</div>
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {[["vocab","Vocabulary",BookOpen,"var(--accent)"],["reading","Reading",FileText,"var(--read)"],["listening","Listening",Headphones,"var(--listen)"],["speaking","Speaking",MessageCircle,"var(--accent)"],["manual","Outside Study",PenLine,"var(--info)"]].map(([key,label,Icon,color])=>{
                  const mins=weekByMod[key]||0;const maxMins=Math.max(...Object.values(weekByMod),1);
                  return (
                    <div key={key} style={{display:"flex",alignItems:"center",gap:10}}>
                      <Icon size={14} color={color} style={{flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:3}}>
                          <span style={{color:"var(--text)",fontWeight:500}}>{label}</span>
                          <span style={{color:"var(--text3)"}}>{mins} min</span>
                        </div>
                        <div className="progress-track" style={{height:4}}><div className="progress-fill" style={{width:`${(mins/maxMins)*100}%`,background:color}}/></div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Manual study log drawer — with retroactive date */}
      {showLog&&(
        <div className="overlay" onClick={e=>{if(e.target===e.currentTarget) setShowLog(false);}}>
          <div className="drawer">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div style={{fontFamily:"Lora,serif",fontSize:17,fontWeight:600}}>Log Study Time</div>
              <button className="btn btn-ghost" onClick={()=>setShowLog(false)} style={{width:30,height:30}}><X size={13}/></button>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <label className="lbl">Date</label>
                <input className="input" type="date" value={manualDate} onChange={e=>setManualDate(e.target.value)} max={TODAY_KEY()}/>
              </div>
              <div>
                <label className="lbl">Type</label>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {[["manual","General"],["class","Class"],["homework","Homework"],["immersion","Immersion"]].map(([v,l])=>(
                    <button key={v} className={`chip ${manualModule===v?"chip-on":""}`} onClick={()=>setManualModule(v)}>{l}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="lbl">Minutes</label>
                <input className="input" type="number" placeholder="30" value={manualMin} onChange={e=>setManualMin(e.target.value)} min="1"/>
              </div>
              <div>
                <label className="lbl">Notes (optional)</label>
                <input className="input" placeholder="e.g. Arabic class, Quran study…" value={manualNote} onChange={e=>setManualNote(e.target.value)}/>
              </div>
              <button className="btn btn-primary" onClick={submitManual} disabled={!manualMin} style={{width:"100%",padding:13,borderRadius:"var(--rs)"}}><Check size={14}/> Log Study Time</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SRS SETTINGS PANEL (used in Settings screen)
// ─────────────────────────────────────────────────────────────
const DEFAULT_SRS_SETTINGS = {
  dailyLimit: 50,
  newCardsPerDay: 10,
  weakPriority: true,
  overduePriority: true,
};

function SRSSettingsPanel({srsSettings,onChange}) {
  const s={...DEFAULT_SRS_SETTINGS,...srsSettings};
  const set=(k,v)=>onChange({...s,[k]:v});
  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
      <div className="sec">Spaced Repetition Settings</div>
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        <div>
          <label className="lbl">Daily Review Limit</label>
          <div style={{display:"flex",gap:6}}>
            {[20,50,100,150,200,300,999].map(n=>(
              <button key={n} className={`chip ${s.dailyLimit===n?"chip-on":""}`} onClick={()=>set("dailyLimit",n)} style={{flex:1,justifyContent:"center",padding:"8px 0",fontSize:12,minWidth:42}}>
                {n>=999?"All":n}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="lbl">New Cards Per Session</label>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {[5,10,20,50,100,999].map(n=>(
              <button key={n} className={`chip ${s.newCardsPerDay===n?"chip-on":""}`} onClick={()=>set("newCardsPerDay",n)} style={{flex:1,justifyContent:"center",padding:"8px 0",fontSize:12,minWidth:48}}>
                {n>=999?"All":n}
              </button>
            ))}
          </div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><span style={{fontSize:13.5,color:"var(--text2)"}}>Prioritize weak cards</span><div style={{fontSize:11,color:"var(--text3)"}}>Weak cards appear before new ones</div></div>
          <div className={`chk ${s.weakPriority?"on":""}`} onClick={()=>set("weakPriority",!s.weakPriority)}>{s.weakPriority&&<Check size={11} color="white"/>}</div>
        </div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div><span style={{fontSize:13.5,color:"var(--text2)"}}>Prioritize overdue cards</span><div style={{fontSize:11,color:"var(--text3)"}}>Most overdue cards first in queue</div></div>
          <div className={`chk ${s.overduePriority?"on":""}`} onClick={()=>set("overduePriority",!s.overduePriority)}>{s.overduePriority&&<Check size={11} color="white"/>}</div>
        </div>
      </div>
      <div className="divider"/>
      <div style={{background:"var(--info-bg)",border:"1px solid var(--info-border)",borderRadius:"var(--rxs)",padding:"12px 14px"}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}><HelpCircle size={13} color="var(--info)"/><span style={{fontSize:12,fontWeight:700,color:"var(--info)"}}>How Review Works</span></div>
        <div style={{fontSize:12,color:"var(--text2)",lineHeight:1.7}}>
          <strong>New</strong> — Cards you haven't reviewed yet. Shown after due cards.<br/>
          <strong>Weak</strong> — You marked "Needs Practice." Comes back in the same or next session.<br/>
          <strong>Known</strong> — You marked "Know It." Interval increases each time (1d → 3d → 7d → …).<br/>
          <strong>Due</strong> — Known cards whose review interval has passed. Prioritized first.<br/><br/>
          Each correct recall increases the interval. Each "weak" mark resets it. This is SM-2 spaced repetition — the more you know a card, the less often you see it.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ROOT
// ─────────────────────────────────────────────────────────────
function initUsage() {
  const tags=["flashcard","sentence","reading","listening","wordLookup","regen","island","dictation","grammar","other","imageNB1","imageNB2","ttsGoogle","sttWhisper"];
  const byTag={};
  // For text tags, the meaningful counters are tokens. For voice tags we
  // reuse the existing shape but treat inputTokens as "units" (chars for
  // TTS, seconds for STT) — costForTag below knows which formula to use.
  tags.forEach(t=>{byTag[t]={calls:0,inputTokens:0,outputTokens:0};});
  return {byTag, trackingSince: Date.now()};
}

// ─────────────────────────────────────────────────────────────
// ACTIVE SESSION PERSISTENCE — keep work-in-progress across reload/navigation
// ─────────────────────────────────────────────────────────────
// Session/screen saves must not silently fail if localStorage is near quota
// (the TTS cache alone can grow to several MB). On QuotaExceededError, drop
// the TTS cache entirely — it's disposable, just re-fetched/re-synthesized —
// and retry once before giving up.
function setLocalStorageResilient(key,value){
  try { localStorage.setItem(key,value); return true; }
  catch(e) {
    try {
      Object.keys(localStorage).filter(k=>k.startsWith(TTS_CACHE_PREFIX)).forEach(k=>localStorage.removeItem(k));
      localStorage.setItem(key,value);
      return true;
    } catch { return false; }
  }
}
const SESSION_KEY="arabic_fc_active_session";
const SCREEN_PREFIX="arabic_fc_screen_";
const SESSION_TTL_MS=30*24*60*60*1000;
const SESSION_SCREENS=new Set(["study","reading","listening","conversation","masterReading","masterListening","masterSpeaking","masterReview"]);
const SCREEN_KEYS=["study","reading","listening","conversation","masterReading","masterListening","masterSpeaking","masterReview"];

// Mirror in-progress session/screen state to Firestore so pausing on one
// device (e.g. mid-Rotation) can resume on another — these were previously
// localStorage-only, which meant a paused session never left the device it
// was paused on and silently restarted from scratch elsewhere. Debounced
// per-key so rapid swipes don't hammer Firestore on every card.
let _sessionSyncUid=null;
function setSessionSyncUser(uid){_sessionSyncUid=uid;}
const _sessionSyncTimers={};
function cloudSyncSession(key,payload){
  if(!_sessionSyncUid) return;
  clearTimeout(_sessionSyncTimers[key]);
  _sessionSyncTimers[key]=setTimeout(()=>{
    setDoc(doc(db,"users",_sessionSyncUid),payload,{merge:true}).catch(()=>{});
  },1200);
}
function loadSession(){try{const r=localStorage.getItem(SESSION_KEY);if(!r) return null;const s=JSON.parse(r);if(Date.now()-(s.savedAt||0)>SESSION_TTL_MS){localStorage.removeItem(SESSION_KEY);return null;}return s;}catch{return null;}}
function saveSession(s){
  try{
    if(s===null){localStorage.removeItem(SESSION_KEY);cloudSyncSession("activeSession",{activeSession:null});return;}
    const stamped={...s,savedAt:Date.now()};
    setLocalStorageResilient(SESSION_KEY,JSON.stringify(stamped));
    cloudSyncSession("activeSession",{activeSession:stamped});
  }catch{}
}
function loadScreen(name){try{const r=localStorage.getItem(SCREEN_PREFIX+name);if(!r) return null;const s=JSON.parse(r);if(Date.now()-(s.savedAt||0)>SESSION_TTL_MS){localStorage.removeItem(SCREEN_PREFIX+name);return null;}return s;}catch{return null;}}
function saveScreen(name,s){
  try{
    if(s===null){localStorage.removeItem(SCREEN_PREFIX+name);cloudSyncSession("screen_"+name,{screens:{[name]:null}});return;}
    const stamped={...s,savedAt:Date.now()};
    setLocalStorageResilient(SCREEN_PREFIX+name,JSON.stringify(stamped));
    cloudSyncSession("screen_"+name,{screens:{[name]:stamped}});
  }catch{}
}
function clearAllSessions(){saveSession(null);SCREEN_KEYS.forEach(n=>saveScreen(n,null));}

// Pull the cloud copies of screen/session state into localStorage if they're
// newer than (or the only copy of) what this device has — called once right
// after the main user doc loads, before anything reads loadScreen/loadSession.
function hydrateSessionsFromCloud(d){
  if(d.screens){
    for(const [name,cloudVal] of Object.entries(d.screens)){
      if(!SCREEN_KEYS.includes(name)||!cloudVal) continue;
      let localVal=null;
      try{const r=localStorage.getItem(SCREEN_PREFIX+name);if(r) localVal=JSON.parse(r);}catch{}
      if(!localVal||(cloudVal.savedAt||0)>(localVal.savedAt||0)){
        try{localStorage.setItem(SCREEN_PREFIX+name,JSON.stringify(cloudVal));}catch{}
      }
    }
  }
  if(d.activeSession){
    let localVal=null;
    try{const r=localStorage.getItem(SESSION_KEY);if(r) localVal=JSON.parse(r);}catch{}
    if(!localVal||(d.activeSession.savedAt||0)>(localVal.savedAt||0)){
      try{localStorage.setItem(SESSION_KEY,JSON.stringify(d.activeSession));}catch{}
    }
  }
}
const DECKIDX_KEY="arabic_fc_deckidx";
function loadDeckIdx(){try{return JSON.parse(localStorage.getItem(DECKIDX_KEY)||"{}");}catch{return {};}}
function saveDeckIdx(o){try{localStorage.setItem(DECKIDX_KEY,JSON.stringify(o));}catch{}}

// Mirror per-deck "which card was I on" resume position to Firestore too —
// this was previously localStorage-only, same bug class as activeSession/
// screens above: study a deck on the phone, and the desktop never hears
// about it, so its "Resume (Card X/Y)" button never appears. Written with a
// dotted field path (not a nested object) so `{merge:true}` patches just
// this one deck+filter key inside the `deckIdx` map on the server, instead
// of replacing the whole map and wiping every other deck's saved position —
// a plain nested object here would silently do exactly that.
function cloudSyncDeckIdx(key,idx){
  if(!_sessionSyncUid) return;
  const timerKey="deckIdx."+key;
  clearTimeout(_sessionSyncTimers[timerKey]);
  _sessionSyncTimers[timerKey]=setTimeout(()=>{
    setDoc(doc(db,"users",_sessionSyncUid),{[`deckIdx.${key}`]:idx},{merge:true}).catch(()=>{});
  },1200);
}
// Merge the cloud's deckIdx map into this device's local copy — cloud keys
// win per-entry (each key is one deck+filter, so there's no real "conflict"
// to resolve, just whichever device most recently studied that filter).
function hydrateDeckIdxFromCloud(d,ref){
  if(!d.deckIdx) return;
  Object.assign(ref.current,d.deckIdx);
  saveDeckIdx(ref.current);
}

// ─────────────────────────────────────────────────────────────
// DICTATION / WRITING MODULE (Phase 4)
// Listen → write what you hear → reveal + word-level correction.
// The audio player uses a real <audio> element so speed is LIVE (playbackRate,
// no restart), pause keeps position, and you can scrub — the Phase 4 audio
// acceptance, demonstrated here and reused conceptually by Listening.
// ─────────────────────────────────────────────────────────────
const DICT_TEAL="#0F766E";
function DictationAudio({text}){
  const audioRef=useRef(null);
  const [src,setSrc]=useState(null);
  const [playing,setPlaying]=useState(false);
  const [rate,setRate]=useState(0.9);
  const [cur,setCur]=useState(0);
  const [dur,setDur]=useState(0);
  const [noAudio,setNoAudio]=useState(false);
  useEffect(()=>{
    let alive=true;
    setSrc(null);setNoAudio(false);setPlaying(false);setCur(0);setDur(0);
    getTtsSrc(text).then(s=>{ if(!alive) return; if(s) setSrc(s); else setNoAudio(true); });
    return ()=>{ alive=false; try{audioRef.current?.pause();}catch{} };
  },[text]);
  // Apply speed live to the playing clip — never restarts.
  useEffect(()=>{ if(audioRef.current) audioRef.current.playbackRate=rate; },[rate,src]);

  const toggle=()=>{
    const a=audioRef.current;
    if(noAudio||!a){ browserSpeak(cleanArabicForSpeech(text)); return; }
    if(a.paused) a.play().catch(()=>{}); else a.pause(); // pause preserves position
  };
  const replay=()=>{ const a=audioRef.current; if(a&&src){ a.currentTime=0; a.play().catch(()=>{}); } else browserSpeak(cleanArabicForSpeech(text)); };
  const fmt=(s)=>{ s=Math.max(0,s||0); const m=Math.floor(s/60),ss=Math.floor(s%60); return `${m}:${ss<10?"0":""}${ss}`; };
  const SPEEDS=[0.6,0.8,0.9,1.0,1.2];

  return (
    <div style={{background:"var(--surface2)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"14px 16px"}}>
      <audio ref={audioRef} src={src||undefined} preload="auto"
        onLoadedMetadata={e=>{setDur(e.target.duration||0);e.target.playbackRate=rate;}}
        onTimeUpdate={e=>setCur(e.target.currentTime||0)}
        onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)}/>
      <div style={{display:"flex",alignItems:"center",gap:12}}>
        <button onClick={toggle} style={{width:46,height:46,borderRadius:"50%",border:"none",background:DICT_TEAL,color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          {playing?<Pause size={20}/>:<Play size={20} style={{marginLeft:2}}/>}
        </button>
        <div style={{flex:1,minWidth:0}}>
          <input type="range" min={0} max={dur||0} step="0.1" value={cur} disabled={!src}
            onChange={e=>{const a=audioRef.current; if(a) a.currentTime=parseFloat(e.target.value);}}
            style={{width:"100%",accentColor:DICT_TEAL,cursor:src?"pointer":"default"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"var(--text3)",fontVariantNumeric:"tabular-nums"}}>
            <span>{fmt(cur)}</span><span>{src?fmt(dur):(noAudio?"browser voice":"loading…")}</span>
          </div>
        </div>
        <button onClick={replay} title="Replay" style={{width:36,height:36,borderRadius:"50%",border:"1.5px solid var(--border)",background:"var(--surface)",color:"var(--text2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
          <RotateCcw size={15}/>
        </button>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10}}>
        <span style={{fontSize:11,color:"var(--text3)",marginRight:2}}>Speed</span>
        {SPEEDS.map(s=>(
          <button key={s} onClick={()=>setRate(s)} disabled={noAudio}
            style={{padding:"3px 9px",borderRadius:100,fontSize:11.5,fontWeight:600,cursor:noAudio?"default":"pointer",
              border:`1.5px solid ${rate===s?DICT_TEAL:"var(--border)"}`,background:rate===s?DICT_TEAL:"transparent",color:rate===s?"#fff":"var(--text3)",opacity:noAudio?.4:1}}>
            {s}×
          </button>
        ))}
      </div>
      {noAudio&&<div style={{fontSize:11,color:"var(--text3)",marginTop:8,lineHeight:1.5}}>Using the browser voice (no scrub/live-speed). Add a Google TTS key in Settings for full playback control.</div>}
    </div>
  );
}

function DictationScreen({decks,cardStates,profile,onBack,onFinish,trackUsage,onLogStudy}){
  const WL=levelById(profile?.workingLevel||"book1");
  const levelUnits=unitsForLevel(WL.id);
  const [phase,setPhase]=useState("setup"); // setup | practice
  const [count,setCount]=useState(5);
  const [topicMode,setTopicMode]=useState("unit"); // unit | vocab | prompt | random
  const [unitId,setUnitId]=useState(levelUnits[0]?.id||"1-1");
  const [promptText,setPromptText]=useState("");
  const [sentences,setSentences]=useState([]);
  const [idx,setIdx]=useState(0);
  const [input,setInput]=useState("");
  const [revealed,setRevealed]=useState(false);
  const [showHint,setShowHint]=useState(false);
  const [loading,setLoading]=useState(false);
  const [err,setErr]=useState("");
  const [scores,setScores]=useState([]);
  const startedAt=useRef(Date.now());
  const cur=sentences[idx];
  const result=(revealed&&cur)?diffTokens(cur.ar,input):null;

  const generate=async()=>{
    if(topicMode==="prompt"&&!promptText.trim()){ setErr("Enter a topic or prompt first."); return; }
    setLoading(true);setErr("");
    try{
      const personalized=!!profile?.personalizationOn;
      const persona=personalized?buildPersona(profile):"";
      // Topic source + vocabulary per the chosen mode. "From my words" leans
      // hardest on the deck (stayClose = new words must stay near known ones).
      let topic="", vocab=personalized?knownVocab(decks,cardStates):[], stayClose=false, unitVocab=null;
      if(topicMode==="unit"){ const u=unitById(unitId); topic=u?`${u.titleEn} (${u.titleAr})`:""; unitVocab=UNIT_VOCAB[unitId]||null; }
      else if(topicMode==="prompt"){ topic=promptText.trim(); }
      else if(topicMode==="vocab"){ vocab=knownVocab(decks,cardStates); stayClose=true; }
      // "random" → no topic; the model picks a level-appropriate everyday theme.
      const level={id:WL.id,guidance:`CEFR ${WL.cefr}. ${WL.desc} Keep each sentence short and dictation-friendly.`};
      const d=await callGenerate({kind:"dictation",inputs:{level,count,vocab,persona,topic,stayClose,unitVocab},maxTokens:700,tag:"dictation",personalized,trackFn:trackUsage});
      const arr=d.payload;
      if(!arr?.length) throw new Error("No sentences came back — try again.");
      setSentences(arr);setIdx(0);setInput("");setRevealed(false);setShowHint(false);setScores([]);startedAt.current=Date.now();setPhase("practice");
    }catch(e){ setErr(e.paywall?"Generating new dictation needs a Pro plan.":(e.message||"Generation failed")); }
    setLoading(false);
  };
  const submit=()=>{ if(!input.trim()||!cur) return; const r=diffTokens(cur.ar,input); setScores(s=>{const n=[...s];n[idx]=r.score;return n;}); setRevealed(true); };
  const next=()=>{ if(idx<sentences.length-1){ setIdx(idx+1);setInput("");setRevealed(false);setShowHint(false); } };
  const finish=()=>{
    const mins=Math.max(1,Math.round((Date.now()-startedAt.current)/60000));
    const done=scores.filter(s=>typeof s==="number");
    const avg=done.length?Math.round(done.reduce((a,b)=>a+b,0)/done.length):0;
    onLogStudy?.({type:"app",module:"writing",minutes:mins,score:avg});
    onFinish?.();
  };
  const avgScore=(()=>{const d=scores.filter(s=>typeof s==="number");return d.length?Math.round(d.reduce((a,b)=>a+b,0)/d.length):0;})();

  if(phase==="setup"){
    return (
      <div className="screen">
        <Hdr title="Dictation" sub="Writing" onBack={onBack}/>
        <div style={{padding:"22px 20px 0"}}>
          <TipBanner id="dictation-intro" title="How dictation works">
            You'll hear a sentence — play it, slow it down, or scrub back as many times as you need. Type what you hear (with tashkīl), then submit to see a word-by-word check.
          </TipBanner>
          <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"16px 18px",marginBottom:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
              <div style={{width:40,height:40,borderRadius:12,background:DICT_TEAL,display:"flex",alignItems:"center",justifyContent:"center"}}><PenLine size={19} color="#fff"/></div>
              <div><div style={{fontWeight:700,fontSize:15}}>Listen & write</div><div style={{fontSize:12.5,color:"var(--text2)"}}>Level: {WL.label} · {WL.cefr}{profile?.personalizationOn?" · personalized":""}</div></div>
            </div>
            <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.65}}>You'll hear a sentence, type what you hear (with tashkīl), then submit to reveal the correct text and a word-by-word check.</div>
          </div>
          <label className="lbl">Topic source</label>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {[["unit","Curriculum unit"],["vocab","From my words"],["prompt","Custom prompt"],["random","Surprise me"]].map(([m,label])=>(
              <button key={m} className={`chip ${topicMode===m?"chip-on":""}`} onClick={()=>{setTopicMode(m);setErr("");}} style={{padding:"6px 12px",fontSize:12.5}}>{label}</button>
            ))}
          </div>
          {topicMode==="unit"&&(
            <select className="input" value={unitId} onChange={e=>setUnitId(e.target.value)} style={{marginBottom:18}}>
              {BOOKS.map(b=>(
                <optgroup key={b.n} label={b.name}>
                  {b.units.map((u,i)=><option key={`${b.n}-${i+1}`} value={`${b.n}-${i+1}`}>{i+1}. {u[1]} · {u[0]}</option>)}
                </optgroup>
              ))}
            </select>
          )}
          {topicMode==="prompt"&&(
            <input className="input" value={promptText} onChange={e=>setPromptText(e.target.value)} placeholder="e.g. a trip to the market, my morning routine…" style={{marginBottom:18}}/>
          )}
          {topicMode==="vocab"&&(
            <div style={{fontSize:12,color:"var(--text3)",lineHeight:1.5,marginBottom:18}}>Sentences are built from your flashcard words; any new words stay close to what you already know.</div>
          )}
          {topicMode==="random"&&(
            <div style={{fontSize:12,color:"var(--text3)",lineHeight:1.5,marginBottom:18}}>We'll pick a natural everyday topic at your level.</div>
          )}
          <label className="lbl">Sentences</label>
          <div style={{display:"flex",gap:8,marginBottom:18}}>
            {[3,5,8].map(n=>(
              <button key={n} className="btn" onClick={()=>setCount(n)} style={{flex:1,padding:"11px",borderRadius:"var(--rs)",fontSize:14,fontWeight:600,
                border:`1.5px solid ${count===n?DICT_TEAL:"var(--border)"}`,background:count===n?DICT_TEAL:"var(--surface)",color:count===n?"#fff":"var(--text2)"}}>{n}</button>
            ))}
          </div>
          {err&&<div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rxs)",padding:"10px 13px",fontSize:13,color:"var(--weak)",marginBottom:14}}>{err}</div>}
          <button className="btn btn-primary" onClick={generate} disabled={loading} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:15,background:DICT_TEAL}}>
            {loading?<><RefreshCw size={16} className="spin"/> Preparing…</>:<><Play size={15}/> Start dictation</>}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <Hdr title="Dictation" sub={`${idx+1} / ${sentences.length}`} onBack={onBack}
        right={<button className="btn btn-ghost btn-sm" onClick={finish} style={{fontSize:12.5}}>Finish</button>}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:14}}>
        <div className="progress-track"><div className="progress-fill" style={{width:`${((idx+(revealed?1:0))/sentences.length)*100}%`,background:DICT_TEAL}}/></div>

        <DictationAudio text={cur?.ar||""}/>

        {!revealed&&(
          <>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <label className="lbl" style={{margin:0}}>Type what you hear</label>
              <button onClick={()=>setShowHint(h=>!h)} className="btn btn-ghost btn-sm" style={{fontSize:12,color:"var(--text3)"}}>{showHint?"Hide hint":"Hint"}</button>
            </div>
            {showHint&&cur?.en&&<div style={{fontSize:13,color:"var(--text3)",fontStyle:"italic",marginTop:-4}}>{cur.en}</div>}
            <textarea className="input ar" dir="rtl" value={input} onChange={e=>setInput(e.target.value)} rows={3}
              placeholder="…اكتب ما تسمع" style={{fontSize:20,lineHeight:1.8,resize:"vertical"}}/>
            <button className="btn btn-primary" onClick={submit} disabled={!input.trim()} style={{width:"100%",padding:13,borderRadius:"var(--r)",fontSize:14,background:DICT_TEAL,opacity:input.trim()?1:.5}}>
              <Check size={15}/> Submit & check
            </button>
          </>
        )}

        {revealed&&result&&cur&&(
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{fontSize:26,fontWeight:800,color:result.score>=80?"var(--know)":result.score>=50?DICT_TEAL:"var(--weak)"}}>{result.score}%</div>
              <div style={{fontSize:12.5,color:"var(--text2)"}}>{result.matched} / {result.total} words correct</div>
            </div>

            <div>
              <div className="sec">Correct answer</div>
              <div className="ar" dir="rtl" style={{fontSize:22,lineHeight:1.9,display:"flex",flexWrap:"wrap",gap:"4px 8px",justifyContent:"flex-end"}}>
                {result.ops.filter(o=>o.type!=="extra").map((o,i)=>(
                  <span key={i} style={o.type==="missing"?{color:"var(--weak)",textDecoration:"underline",textDecorationStyle:"wavy"}:{color:"var(--know)"}}>{o.t}</span>
                ))}
              </div>
            </div>

            <div>
              <div className="sec">You wrote</div>
              <div className="ar" dir="rtl" style={{fontSize:20,lineHeight:1.9,display:"flex",flexWrap:"wrap",gap:"4px 8px",justifyContent:"flex-end"}}>
                {result.ops.filter(o=>o.type!=="missing").map((o,i)=>(
                  <span key={i} style={o.type==="extra"?{color:"var(--weak)",textDecoration:"line-through"}:{color:"var(--know)"}}>{o.u}</span>
                ))}
                {!input.trim()&&<span style={{color:"var(--text3)"}}>(nothing)</span>}
              </div>
            </div>

            <div style={{fontSize:13,color:"var(--text2)",fontStyle:"italic"}}>{cur.en}</div>

            <div style={{display:"flex",gap:8}}>
              {idx<sentences.length-1
                ? <button className="btn btn-primary" onClick={next} style={{flex:1,padding:13,borderRadius:"var(--r)",fontSize:14,background:DICT_TEAL}}>Next <ChevronRight size={15}/></button>
                : <button className="btn btn-primary" onClick={finish} style={{flex:1,padding:13,borderRadius:"var(--r)",fontSize:14,background:DICT_TEAL}}><Check size={15}/> Finish · avg {avgScore}%</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// IMMERSION CAPSULES (Phase 5)
// A registry of long-form immersion experiences. Language Island is capsule #1;
// the registry leaves room for more (the demo home screen hinted at others).
// `screen` points at a registered route; status "soon" renders a disabled card.
// ─────────────────────────────────────────────────────────────
// Real, shipped capsules only. Add new entries here as they're built (a future
// entry would set status:"live" + a `screen` route, or status:"soon" as a
// ─────────────────────────────────────────────────────────────
// GRAMMAR IMPORT — dump a PDF / screenshots / pasted text of grammar notes;
// AI extracts the distinct concepts into flashcards (front = concept, back =
// explanation + fully-voweled examples). Saved as a deckType:"grammar" deck.
// PDF pages with selectable text are sent as text (cheap); image-only pages
// are rendered to JPEG and read by a vision model via /api/claude, which
// passes content arrays through to OpenRouter untouched. pdfjs-dist loads
// lazily (dynamic import) so it adds nothing to the main bundle.
// ─────────────────────────────────────────────────────────────
const GRAMMAR_PROMPT=`You are analyzing a learner's Arabic GRAMMAR notes from the curriculum "Al-ʿArabiyyah Bayna Yadayk" (Arabic Between Your Hands). The notes may contain explanations, tables, lists and example sentences — in English, Arabic, or both. Some input may be photographed/scanned pages.

Extract every DISTINCT grammar concept/rule the notes cover. For each concept return:
- "title": short English name, with the Arabic grammar term in parentheses when it exists (e.g. "The Nominal Sentence (الجملة الاسمية)")
- "arabicTerm": the Arabic name of the concept, fully voweled ("" if none)
- "explanation": a clear, learner-friendly explanation in English (2–5 sentences). Any Arabic inside it MUST be fully voweled.
- "examples": 2–4 example sentences as {"ar":"...","en":"..."} — prefer examples taken from the notes themselves (complete/fix them if truncated). Every Arabic word MUST carry full tashkeel — no bare letters.

Rules:
- ONE card per distinct concept — merge duplicates and repeats.
- Only concepts actually present in the notes — do NOT invent unrelated material.
- Modern Standard Arabic, Bayna-Yadayk register.
Return ONLY valid JSON: [{"title":"...","arabicTerm":"...","explanation":"...","examples":[{"ar":"...","en":"..."}]}]`;

// ─────────────────────────────────────────────────────────────
// VOCAB IMPORT — dump a PDF / screenshots of vocabulary (word lists, vocab
// tables, glossaries) and get back noun/verb/adjective flashcards, each
// normalized to its base/dictionary form. Reuses the exact same page-
// extraction + batching pipeline as Grammar Import below (extractPdfPages /
// fileToDownscaledJpeg), just with a different prompt, dedupe key, and card
// shape. Saved as an ordinary (non-grammar) deck.
// ─────────────────────────────────────────────────────────────
// The field set this IMPORT flow requests/keeps per word type — deliberately
// narrower than FORMS_BY_TYPE (which also serves the manual "Add Cards"
// screen and its fuller field set). Extraction stays conservative: only
// capture what's directly evidenced on the page, never invent synonym/
// antonym relations that aren't there.
const VOCAB_IMPORT_FIELDS = {
  noun:      ["singular","plural"],
  adjective: ["masculine","feminine","plural"],
  verb:      ["past","present","future","imperative","masdar","activePart","passivePart","harf"],
};
const VOCAB_PROMPT=`You are extracting Arabic VOCABULARY flashcards from a learner's textbook page or screenshot (curriculum register: Al-ʿArabiyyah Bayna Yadayk / Arabic Between Your Hands). The input may be a headword list, a vocab table, a glossary, or prose/example sentences — in English, Arabic, or both. Some input may be photographed/scanned pages.

Extract only words that are clearly being TAUGHT: headword lists, bolded/defined terms, vocab-table entries, and genuinely new content words that appear in example sentences on the same topic. SKIP common function words and particles (prepositions, pronouns, demonstratives, relative pronouns) unless the page is specifically teaching one of them as a vocabulary item. Use judgment — the goal is the deliberate teaching vocabulary of the page, not every Arabic word that appears on it.

For each word, classify it as "noun", "verb", or "adjective". Normalize it to its BASE / DICTIONARY form before returning it — never return the inflected form you saw in the source:
- Nouns/adjectives → the SINGULAR indefinite form (adjectives: the masculine singular).
- Verbs → the 3rd-person masculine singular PAST tense (الفعل الماضي، وزن فَعَلَ), even if the source only shows the present, imperative, or another inflection.

For each word return:
- "wordType": "noun" | "verb" | "adjective"
- "english": short English gloss
- "arabicBase": the base/dictionary form, fully voweled (see normalization above)
- "forms": an object — see field rules below

FIELD RULES (do not deviate):
- If wordType is "noun": "forms" must contain ONLY "singular" and "plural" — the one most common plural, grounded in the source or standard usage. Do NOT include harf, synonym, antonym, or any other field.
- If wordType is "adjective": "forms" must contain ONLY "masculine", "feminine", and "plural".
- If wordType is "verb": "forms" must contain ONLY "past", "present", "future", "imperative", "masdar", "activePart", "passivePart", "harf":
  - "past": 3rd-person masc. singular past (same as arabicBase)
  - "present": 3rd-person masc. singular present (يَفْعَلُ pattern)
  - "future": present tense with the future marker سَ or سَوْفَ (e.g. سَيَفْعَلُ)
  - "imperative": command form (اِفْعَلْ pattern)
  - "masdar": the verbal noun
  - "activePart": active participle (فَاعِل pattern)
  - "passivePart": passive participle (مَفْعُول pattern) — "" if the verb is intransitive/rare in the passive
  - "harf": the ONE preposition/particle commonly paired with this verb if there is a well-known one (e.g. بَحَثَ عَنْ, ذَهَبَ إِلَى) — "" if the verb takes no fixed preposition. Do NOT invent one.

CRITICAL — do not invent ungrounded data: only fill in a field if you can confidently ground it in standard Arabic usage. Use "" rather than guessing. Never add synonym/antonym/plural2/synonymPlural/antonymPlural fields for ANY word type, even if you happen to know one — they are out of scope for this extraction.

Every Arabic string MUST carry full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين) — no bare letters.

Rules:
- ONE card per distinct base word — if the same word (in any inflection) appears more than once on the page (e.g. once in a vocab list, again in an example sentence), return it ONLY ONCE.
- Modern Standard Arabic, Bayna-Yadayk register.
Return ONLY valid JSON: [{"wordType":"noun|verb|adjective","english":"...","arabicBase":"...","forms":{...}}]`;

// PDF → per-page {type:"text"|"image",source,page} items. Text-poor pages
// (scans/screenshots) are rasterized for the vision model. Every page is
// tagged with its 1-based page number + source filename so batch failures
// downstream can be reported as "which pages", not just "which batch". Each
// page is wrapped in its own try/catch — one corrupt/oversized page no
// longer aborts the whole file and silently discards every page already
// read before it; failures are collected in `pageErrors` and returned
// alongside whatever DID succeed, instead of being thrown.
async function extractPdfPages(file,onProgress){
  const pdfjs=await import("pdfjs-dist");
  const workerUrl=(await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc=workerUrl;
  const docPdf=await pdfjs.getDocument({data:await file.arrayBuffer()}).promise;
  const maxPages=Math.min(docPdf.numPages,60);
  const pages=[];
  const pageErrors=[];
  for(let i=1;i<=maxPages;i++){
    onProgress&&onProgress(`Reading "${file.name}" — page ${i}/${maxPages}…`);
    try{
      const page=await docPdf.getPage(i);
      const tc=await page.getTextContent();
      const text=tc.items.map(it=>it.str).join(" ").replace(/\s+/g," ").trim();
      if(text.length>=120){
        pages.push({type:"text",text,source:file.name,page:i});
      } else {
        const vp=page.getViewport({scale:1.6});
        const canvas=document.createElement("canvas");
        canvas.width=vp.width;canvas.height=vp.height;
        await page.render({canvasContext:canvas.getContext("2d"),viewport:vp}).promise;
        pages.push({type:"image",dataUrl:canvas.toDataURL("image/jpeg",0.82),source:file.name,page:i});
      }
    }catch(err){
      pageErrors.push(`"${file.name}" page ${i} couldn't be read: ${err?.message||"unknown error"}`);
    }
  }
  if(docPdf.numPages>maxPages) pageErrors.push(`"${file.name}" has ${docPdf.numPages} pages — only the first ${maxPages} were imported (pages ${maxPages+1}–${docPdf.numPages} were skipped).`);
  return {pages,pageErrors};
}

// Human-readable label for a batch's page range, e.g. `"notes.pdf" p.3–7`.
// Shared by Grammar/Vocab import so a retry button can re-label a batch
// outside the run() closure that originally built it.
function labelForBatch(b){
  const bySrc=new Map();
  for(const {source,page} of b.pages||[]) { if(!bySrc.has(source)) bySrc.set(source,[]); if(page!=null) bySrc.get(source).push(page); }
  return [...bySrc.entries()].map(([src,pgs])=>pgs.length?`"${src}" p.${Math.min(...pgs)}${Math.min(...pgs)!==Math.max(...pgs)?`–${Math.max(...pgs)}`:""}`:`"${src}"`).join(", ")||`batch`;
}

// Send one batch to Claude and return its parsed concept/card array. Shared
// by the initial run() loop and the per-warning retry so both paths fail
// and succeed identically.
async function generateConceptsForBatch(b,trackUsage){
  const raw=b.type==="text"
    ?await callClaude(`${GRAMMAR_PROMPT}\n\nTHE LEARNER'S NOTES:\n\n${b.text}`,3000,"grammar",trackUsage)
    :await callClaudeVision([{type:"text",text:GRAMMAR_PROMPT+"\n\nThe learner's notes are in the attached page image(s)."},...b.images.map(u=>({type:"image_url",image_url:{url:u}}))],3000,"grammar",trackUsage);
  const arr=extractJSON(raw);
  if(!Array.isArray(arr)) throw new Error("Response was not a list");
  return arr;
}
async function generateVocabForBatch(b,trackUsage){
  const raw=b.type==="text"
    ?await callClaudeWithTashkeel(`${VOCAB_PROMPT}\n\nTHE LEARNER'S PAGE:\n\n${b.text}`,4500,"vocab",trackUsage)
    :await callClaudeVision([{type:"text",text:VOCAB_PROMPT+"\n\nThe learner's page is in the attached image(s)."},...b.images.map(u=>({type:"image_url",image_url:{url:u}}))],4500,"vocab",trackUsage);
  const arr=extractJSON(raw);
  if(!Array.isArray(arr)) throw new Error("Response was not a list");
  return arr;
}

// Downscale a photographed page so vision requests stay small.
function fileToDownscaledJpeg(file,maxDim=1400){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const scale=Math.min(1,maxDim/Math.max(img.width,img.height));
      const canvas=document.createElement("canvas");
      canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);
      canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg",0.85));
    };
    img.onerror=(e)=>{URL.revokeObjectURL(img.src);reject(e);};
    img.src=URL.createObjectURL(file);
  });
}

function GrammarImportScreen({onBack,trackUsage,onSave,targetDeck}){
  const [stage,setStage]=useState("input"); // input | working | preview
  const [pasted,setPasted]=useState("");
  const [files,setFiles]=useState([]);
  const [progress,setProgress]=useState("");
  const [concepts,setConcepts]=useState([]);
  const [warnings,setWarnings]=useState([]);
  const [deckTitle,setDeckTitle]=useState(targetDeck?targetDeck.title:"Grammar — Bayna Yadayk");
  const [expanded,setExpanded]=useState(-1);
  const fileRef=useRef(null);
  const cancelRef=useRef(false);

  useEffect(()=>()=>{cancelRef.current=true;},[]);

  const normalizeConcept=(c)=>({
    title:String(c?.title||"").trim(),
    arabicTerm:String(c?.arabicTerm||"").trim(),
    explanation:String(c?.explanation||"").trim(),
    examples:Array.isArray(c?.examples)?c.examples.filter(e=>e&&e.ar).map(e=>({ar:String(e.ar).trim(),en:String(e.en||"").trim()})).slice(0,4):[],
  });

  const run=async()=>{
    if(!pasted.trim()&&files.length===0){showToast("Add a PDF, images, or paste your notes first.","error");return;}
    setStage("working");setWarnings([]);cancelRef.current=false;
    const warns=[]; // collected from page-extraction AND batch failures, shown even on total failure
    try{
      // 1) Collect pages from every source
      let pages=[];
      if(pasted.trim()) pages.push({type:"text",text:pasted.trim(),source:"pasted text"});
      for(const f of files){
        if(cancelRef.current) return;
        if(f.type==="application/pdf"||/\.pdf$/i.test(f.name)){
          const {pages:pdfPages,pageErrors}=await extractPdfPages(f,setProgress);
          pages.push(...pdfPages); warns.push(...pageErrors.map(message=>({id:Math.random().toString(36).slice(2),message,batch:null})));
        } else if(f.type.startsWith("image/")){
          setProgress(`Preparing image "${f.name}"…`);
          pages.push({type:"image",dataUrl:await fileToDownscaledJpeg(f),source:f.name});
        } else {
          setProgress(`Reading "${f.name}"…`);
          pages.push({type:"text",text:await f.text(),source:f.name}); // .txt / .md / pasted docs
        }
      }
      // 2) Batch: text chunks ~6k chars; images 3 per request. Each batch
      // carries the {source,page} list of every page folded into it, so a
      // failure can be reported as real pages, not an anonymous batch index.
      const batches=[];
      let buf="",bufPages=[];
      for(const p of pages.filter(p=>p.type==="text")){
        if(buf&&buf.length+p.text.length>6000){batches.push({type:"text",text:buf,pages:bufPages});buf="";bufPages=[];}
        buf+=(buf?"\n\n---PAGE---\n\n":"")+p.text; bufPages.push({source:p.source,page:p.page});
        while(buf.length>6000){batches.push({type:"text",text:buf.slice(0,6000),pages:bufPages});buf=buf.slice(6000);bufPages=[];}
      }
      if(buf.trim()) batches.push({type:"text",text:buf,pages:bufPages});
      const imgs=pages.filter(p=>p.type==="image");
      for(let i=0;i<imgs.length;i+=3){
        const chunk=imgs.slice(i,i+3);
        batches.push({type:"images",images:chunk.map(p=>p.dataUrl),pages:chunk.map(p=>({source:p.source,page:p.page}))});
      }
      if(batches.length===0&&warns.length===0) throw new Error("Nothing readable found in the input.");

      // 3) Generate per batch, accumulate + dedupe by title
      const seen=new Map();
      for(let i=0;i<batches.length;i++){
        if(cancelRef.current) return;
        const b=batches[i];
        setProgress(`Analyzing ${b.type==="images"?"screenshot":"notes"} batch ${i+1}/${batches.length} (${labelForBatch(b)}) — ${seen.size} concepts so far…`);
        try{
          const arr=await generateConceptsForBatch(b,trackUsage);
          for(const rawC of arr){
            const c=normalizeConcept(rawC);
            if(!c.title||!c.explanation) continue;
            const key=c.title.toLowerCase().replace(/[^a-z؀-ۿ]+/g,"");
            const prev=seen.get(key);
            // keep the richer duplicate (longer explanation / more examples)
            if(!prev||c.explanation.length+c.examples.length*50>prev.explanation.length+prev.examples.length*50) seen.set(key,c);
          }
        }catch(err){
          warns.push({id:Math.random().toString(36).slice(2),message:`${labelForBatch(b)} failed: ${err?.message||"unknown error"}`,batch:b});
        }
      }
      if(cancelRef.current) return;
      const found=[...seen.values()];
      // Land on the preview stage even with zero results, as long as we have
      // SOMETHING to show — otherwise a fully-failed import just bounces back
      // to input with a single toast, discarding every other batch's error.
      if(found.length===0&&warns.length===0) throw new Error("No grammar concepts could be extracted — try clearer pages or paste the text directly.");
      setConcepts(found);setWarnings(warns);setStage("preview");
    }catch(err){
      if(cancelRef.current) return;
      showToast(err?.message||"Import failed","error");
      setStage("input");
    }
  };

  // Re-send a single failed batch (kept on its warning) without re-reading
  // any files. On success its concepts merge in and the warning clears; on
  // a repeat failure the warning stays, retryable again.
  const retry=async(w)=>{
    if(!w.batch||w.retrying) return;
    setWarnings(p=>p.map(x=>x.id===w.id?{...x,retrying:true}:x));
    try{
      const arr=await generateConceptsForBatch(w.batch,trackUsage);
      const fresh=arr.map(normalizeConcept).filter(c=>c.title&&c.explanation);
      setConcepts(prev=>{
        const seen=new Map(prev.map(c=>[c.title.toLowerCase().replace(/[^a-z؀-ۿ]+/g,""),c]));
        for(const c of fresh){
          const key=c.title.toLowerCase().replace(/[^a-z؀-ۿ]+/g,"");
          const prevC=seen.get(key);
          if(!prevC||c.explanation.length+c.examples.length*50>prevC.explanation.length+prevC.examples.length*50) seen.set(key,c);
        }
        return [...seen.values()];
      });
      setWarnings(p=>p.filter(x=>x.id!==w.id));
    }catch(err){
      setWarnings(p=>p.map(x=>x.id===w.id?{...x,retrying:false,message:`${labelForBatch(w.batch)} failed: ${err?.message||"unknown error"}`}:x));
    }
  };
  const retryAll=()=>warnings.filter(w=>w.batch&&!w.retrying).forEach(retry);

  const save=()=>{
    const ts=Date.now();
    const cards=concepts.map((c,i)=>({
      id:`c${ts}-${i}`, wordType:"grammar", english:c.title, arabicBase:c.arabicTerm||"",
      forms:{}, grammar:{explanation:c.explanation,examples:c.examples}, status:"new",
    }));
    onSave(deckTitle.trim()||"Grammar",cards,targetDeck||null);
  };

  return (
    <div className="screen">
      <div style={{padding:"18px 18px 0",display:"flex",alignItems:"center",gap:10}}>
        <button className="btn btn-ghost" onClick={onBack} style={{width:34,height:34}}><ArrowLeft size={15}/></button>
        <div>
          <div style={{fontWeight:700,fontSize:17}}>Grammar Import <span className="ar" style={{fontSize:15,color:"var(--harf)"}}>قَوَاعِد</span></div>
          <div style={{fontSize:12,color:"var(--text3)"}}>{targetDeck?`Adding to "${targetDeck.title}"`:"Notes → concept flashcards"}</div>
        </div>
      </div>
      <div style={{padding:"16px 18px 24px",display:"flex",flexDirection:"column",gap:14}}>
        {stage==="input"&&(<>
          <div style={{fontSize:13.5,color:"var(--text2)",lineHeight:1.6}}>
            Dump in the grammar you've been learning — a PDF (typed or screenshots), photos of pages, or pasted text. I'll extract each distinct concept into a flashcard: <b>concept on the front, the rule + voweled examples on the back.</b>
          </div>
          <button className="btn" onClick={()=>fileRef.current?.click()}
            style={{width:"100%",padding:"26px 16px",borderRadius:"var(--r)",background:"var(--surface)",border:"2px dashed var(--border)",color:"var(--text2)",flexDirection:"column",gap:8,fontSize:13.5,fontWeight:600}}>
            <Upload size={22} color="var(--harf)"/>
            {files.length===0?"Choose PDF / images":"Add more files"}
            <span style={{fontSize:11.5,color:"var(--text3)",fontWeight:400}}>PDF · PNG · JPG · TXT — screenshots welcome</span>
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,image/*" multiple style={{display:"none"}}
            onChange={(e)=>{setFiles(p=>[...p,...Array.from(e.target.files||[])]);e.target.value="";}}/>
          {files.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {files.map((f,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:9,background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"9px 12px",fontSize:13}}>
                  <FileText size={14} color="var(--text3)"/>
                  <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span>
                  <span style={{fontSize:11,color:"var(--text3)"}}>{(f.size/1024/1024).toFixed(1)} MB</span>
                  <button className="btn btn-ghost" onClick={()=>setFiles(p=>p.filter((_,j)=>j!==i))} style={{width:26,height:26}}><X size={12}/></button>
                </div>
              ))}
            </div>
          )}
          <div>
            <div className="sec">Or paste your notes</div>
            <textarea value={pasted} onChange={e=>setPasted(e.target.value)} rows={6} placeholder="Paste grammar explanations, rules, examples…"
              style={{width:"100%",background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 13px",fontSize:13.5,color:"var(--text)",resize:"vertical",fontFamily:"inherit"}}/>
          </div>
          <button className="btn btn-primary" onClick={run} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14.5}}>
            <Sparkles size={15}/> Analyze &amp; build flashcards
          </button>
        </>)}
        {stage==="working"&&(
          <div style={{textAlign:"center",padding:"46px 12px",display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
            <RefreshCw size={26} className="spin" color="var(--harf)"/>
            <div style={{fontSize:14,fontWeight:600}}>Building your grammar deck…</div>
            <div style={{fontSize:12.5,color:"var(--text3)",minHeight:18}}>{progress}</div>
            <button className="btn" onClick={()=>{cancelRef.current=true;setStage("input");}} style={{fontSize:12.5,color:"var(--text3)",background:"var(--surface2)",padding:"8px 18px",borderRadius:"var(--rs)"}}>Cancel</button>
          </div>
        )}
        {stage==="preview"&&(<>
          <div style={{background:"var(--know-bg)",border:"1px solid var(--know-border)",borderRadius:"var(--rs)",padding:"11px 14px",fontSize:13.5,color:"var(--know)",fontWeight:600}}>
            <Check size={14} style={{verticalAlign:-2}}/> Found {concepts.length} grammar concept{concepts.length!==1?"s":""} — review, prune, then save.
          </div>
          {warnings.length>1&&warnings.some(w=>w.batch)&&(
            <button className="btn" onClick={retryAll} style={{alignSelf:"flex-start",fontSize:12,color:"var(--weak)",background:"var(--weak-bg)",border:"1px solid var(--weak-border)",padding:"7px 13px",borderRadius:"var(--rs)"}}>
              <RefreshCw size={12}/> Retry all failed
            </button>
          )}
          {warnings.map((w)=>(
            <div key={w.id} style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rs)",padding:"9px 13px",fontSize:12,color:"var(--weak)",display:"flex",alignItems:"center",gap:10}}>
              <span style={{flex:1}}>⚠️ {w.message}</span>
              {w.batch&&(
                <button className="btn btn-ghost" disabled={w.retrying} onClick={()=>retry(w)} style={{fontSize:11.5,color:"var(--weak)",padding:"4px 10px",flexShrink:0}}>
                  <RefreshCw size={11} className={w.retrying?"spin":""}/> {w.retrying?"Retrying…":"Retry"}
                </button>
              )}
            </div>
          ))}
          {!targetDeck&&(
            <div>
              <div className="sec">Deck name</div>
              <input value={deckTitle} onChange={e=>setDeckTitle(e.target.value)}
                style={{width:"100%",background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"11px 13px",fontSize:14,color:"var(--text)",fontWeight:600}}/>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {concepts.map((c,i)=>(
              <div key={i} style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={()=>setExpanded(expanded===i?-1:i)} style={{flex:1,display:"flex",alignItems:"center",gap:8,background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0,color:"var(--text)"}}>
                    {expanded===i?<ChevronUp size={14} color="var(--text3)"/>:<ChevronDown size={14} color="var(--text3)"/>}
                    <span style={{fontWeight:600,fontSize:13.5,flex:1}}>{c.title}</span>
                    {c.arabicTerm&&<span className="ar" style={{fontSize:15,color:"var(--harf)"}}>{c.arabicTerm}</span>}
                  </button>
                  <button className="btn btn-ghost" title="Remove" onClick={()=>{setConcepts(p=>p.filter((_,j)=>j!==i));setExpanded(-1);}} style={{width:28,height:28,color:"var(--weak)"}}><Trash2 size={13}/></button>
                </div>
                {expanded===i&&(
                  <div style={{marginTop:10,display:"flex",flexDirection:"column",gap:8}}>
                    <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6}}>{c.explanation}</div>
                    {c.examples.map((ex,j)=>(
                      <div key={j} style={{background:"var(--accent-bg)",borderRadius:"var(--rxs)",padding:"8px 11px"}}>
                        <div className="ar" style={{fontSize:17}}>{ex.ar}</div>
                        <div style={{fontSize:11.5,color:"var(--text3)",fontStyle:"italic"}}>{ex.en}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button className="btn btn-primary" onClick={save} disabled={concepts.length===0} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14.5}}>
            <Save size={15}/> {targetDeck?`Add ${concepts.length} cards to "${targetDeck.title}"`:`Save deck · ${concepts.length} cards`}
          </button>
          <button className="btn" onClick={()=>setStage("input")} style={{width:"100%",fontSize:12.5,color:"var(--text3)",background:"transparent"}}>← Back to input</button>
        </>)}
      </div>
    </div>
  );
}

function VocabImportScreen({onBack,trackUsage,onSave,targetDeck}){
  const [stage,setStage]=useState("input"); // input | working | preview
  const [pasted,setPasted]=useState("");
  const [files,setFiles]=useState([]);
  const [progress,setProgress]=useState("");
  const [cards,setCards]=useState([]);
  const [warnings,setWarnings]=useState([]);
  const [pagesRead,setPagesRead]=useState(0); // for the preview-stage coverage line
  const [deckTitle,setDeckTitle]=useState(targetDeck?targetDeck.title:"Vocabulary — Bayna Yadayk");
  const [expanded,setExpanded]=useState(-1);
  const fileRef=useRef(null);
  const cancelRef=useRef(false);

  useEffect(()=>()=>{cancelRef.current=true;},[]);

  const normalizeCard=(c)=>{
    const wordType=["noun","verb","adjective"].includes(c?.wordType)?c.wordType:"noun";
    const allowed=new Set(VOCAB_IMPORT_FIELDS[wordType]);
    const forms=Object.fromEntries(Object.entries(c?.forms||{}).filter(([k,v])=>v&&allowed.has(k)));
    return {
      wordType,
      english:String(c?.english||"").trim(),
      arabicBase:String(c?.arabicBase||"").trim(),
      forms,
    };
  };

  const run=async()=>{
    if(!pasted.trim()&&files.length===0){showToast("Add a PDF, images, or paste some vocabulary first.","error");return;}
    setStage("working");setWarnings([]);cancelRef.current=false;
    const warns=[]; // collected from page-extraction AND batch failures, shown even on total failure
    try{
      // 1) Collect pages from every source
      let pages=[];
      if(pasted.trim()) pages.push({type:"text",text:pasted.trim(),source:"pasted text"});
      for(const f of files){
        if(cancelRef.current) return;
        if(f.type==="application/pdf"||/\.pdf$/i.test(f.name)){
          const {pages:pdfPages,pageErrors}=await extractPdfPages(f,setProgress);
          pages.push(...pdfPages); warns.push(...pageErrors.map(message=>({id:Math.random().toString(36).slice(2),message,batch:null})));
        } else if(f.type.startsWith("image/")){
          setProgress(`Preparing image "${f.name}"…`);
          pages.push({type:"image",dataUrl:await fileToDownscaledJpeg(f),source:f.name});
        } else {
          setProgress(`Reading "${f.name}"…`);
          pages.push({type:"text",text:await f.text(),source:f.name}); // .txt / .md / pasted docs
        }
      }
      setPagesRead(pages.length);

      // 2) Batch. Vocab pages pack MANY more output fields per item than
      // grammar concepts (a verb card alone has 8 fields), so batches here
      // are deliberately smaller (~3k chars / 2 images) and maxTokens larger
      // (4500) than Grammar Import's — otherwise a dense vocab-list page can
      // hit the output-token cap, and extractJSON's truncation-repair will
      // silently drop the tail of that batch with NO warning at all. Each
      // batch also carries the {source,page} list of every page folded into
      // it, so a failure can be reported as real pages, not a batch index.
      const batches=[];
      let buf="",bufPages=[];
      for(const p of pages.filter(p=>p.type==="text")){
        if(buf&&buf.length+p.text.length>3000){batches.push({type:"text",text:buf,pages:bufPages});buf="";bufPages=[];}
        buf+=(buf?"\n\n---PAGE---\n\n":"")+p.text; bufPages.push({source:p.source,page:p.page});
        while(buf.length>3000){batches.push({type:"text",text:buf.slice(0,3000),pages:bufPages});buf=buf.slice(3000);bufPages=[];}
      }
      if(buf.trim()) batches.push({type:"text",text:buf,pages:bufPages});
      const imgs=pages.filter(p=>p.type==="image");
      for(let i=0;i<imgs.length;i+=2){
        const chunk=imgs.slice(i,i+2);
        batches.push({type:"images",images:chunk.map(p=>p.dataUrl),pages:chunk.map(p=>({source:p.source,page:p.page}))});
      }
      if(batches.length===0&&warns.length===0) throw new Error("Nothing readable found in the input.");

      // 3) Generate per batch, accumulate + dedupe by base word
      const seen=new Map();
      for(let i=0;i<batches.length;i++){
        if(cancelRef.current) return;
        const b=batches[i];
        setProgress(`Analyzing ${b.type==="images"?"screenshot":"notes"} batch ${i+1}/${batches.length} (${labelForBatch(b)}) — ${seen.size} words so far…`);
        try{
          const arr=await generateVocabForBatch(b,trackUsage);
          for(const rawC of arr){
            const c=normalizeCard(rawC);
            if(!c.english||!c.arabicBase) continue;
            const key=c.wordType+"|"+stripTashkeel(c.arabicBase).replace(/\s+/g,"");
            const prev=seen.get(key);
            // keep the richer duplicate (more non-empty forms filled in)
            const score=Object.values(c.forms).filter(Boolean).length;
            const prevScore=prev?Object.values(prev.forms).filter(Boolean).length:-1;
            if(!prev||score>prevScore) seen.set(key,c);
          }
        }catch(err){
          warns.push({id:Math.random().toString(36).slice(2),message:`${labelForBatch(b)} failed: ${err?.message||"unknown error"}`,batch:b});
        }
      }
      if(cancelRef.current) return;
      const found=[...seen.values()];
      // Land on the preview stage even with zero results, as long as we have
      // SOMETHING to show — otherwise a fully-failed import just bounces back
      // to input with a single toast, discarding every other batch's error.
      if(found.length===0&&warns.length===0) throw new Error("No vocabulary could be extracted — try clearer pages or paste the text directly.");
      setCards(found);setWarnings(warns);setStage("preview");
    }catch(err){
      if(cancelRef.current) return;
      showToast(err?.message||"Import failed","error");
      setStage("input");
    }
  };

  // Re-send a single failed batch (kept on its warning) without re-reading
  // any files. On success its cards merge in and the warning clears; on a
  // repeat failure the warning stays, retryable again.
  const retry=async(w)=>{
    if(!w.batch||w.retrying) return;
    setWarnings(p=>p.map(x=>x.id===w.id?{...x,retrying:true}:x));
    try{
      const arr=await generateVocabForBatch(w.batch,trackUsage);
      const fresh=arr.map(normalizeCard).filter(c=>c.english&&c.arabicBase);
      setCards(prev=>{
        const seen=new Map(prev.map(c=>[c.wordType+"|"+stripTashkeel(c.arabicBase).replace(/\s+/g,""),c]));
        for(const c of fresh){
          const key=c.wordType+"|"+stripTashkeel(c.arabicBase).replace(/\s+/g,"");
          const prevC=seen.get(key);
          const score=Object.values(c.forms).filter(Boolean).length;
          const prevScore=prevC?Object.values(prevC.forms).filter(Boolean).length:-1;
          if(!prevC||score>prevScore) seen.set(key,c);
        }
        return [...seen.values()];
      });
      setWarnings(p=>p.filter(x=>x.id!==w.id));
    }catch(err){
      setWarnings(p=>p.map(x=>x.id===w.id?{...x,retrying:false,message:`${labelForBatch(w.batch)} failed: ${err?.message||"unknown error"}`}:x));
    }
  };
  const retryAll=()=>warnings.filter(w=>w.batch&&!w.retrying).forEach(retry);

  const save=()=>{
    const ts=Date.now();
    const built=cards.map((c,i)=>({
      id:`c${ts}-${i}`, wordType:c.wordType, english:c.english, arabicBase:c.arabicBase,
      forms:c.forms, status:"new",
    }));
    onSave(deckTitle.trim()||"Vocabulary",built,targetDeck||null);
  };

  return (
    <div className="screen">
      <div style={{padding:"18px 18px 0",display:"flex",alignItems:"center",gap:10}}>
        <button className="btn btn-ghost" onClick={onBack} style={{width:34,height:34}}><ArrowLeft size={15}/></button>
        <div>
          <div style={{fontWeight:700,fontSize:17}}>Vocabulary Import <span className="ar" style={{fontSize:15,color:"var(--know)"}}>مُفْرَدَات</span></div>
          <div style={{fontSize:12,color:"var(--text3)"}}>{targetDeck?`Adding to "${targetDeck.title}"`:"Screenshots / PDF → noun & verb flashcards"}</div>
        </div>
      </div>
      <div style={{padding:"16px 18px 24px",display:"flex",flexDirection:"column",gap:14}}>
        {stage==="input"&&(<>
          <div style={{fontSize:13.5,color:"var(--text2)",lineHeight:1.6}}>
            Dump in the vocabulary you're studying — a PDF (typed or screenshots), photos of vocab-list pages, or pasted text. I'll extract each word into a flashcard, classify it as a <b>noun</b> or <b>verb</b>, normalize it to its base form, and fill in the right fields (nouns get singular + plural; verbs get past/present/future/masdar/participles + a common preposition).
          </div>
          <button className="btn" onClick={()=>fileRef.current?.click()}
            style={{width:"100%",padding:"26px 16px",borderRadius:"var(--r)",background:"var(--surface)",border:"2px dashed var(--border)",color:"var(--text2)",flexDirection:"column",gap:8,fontSize:13.5,fontWeight:600}}>
            <Upload size={22} color="var(--know)"/>
            {files.length===0?"Choose PDF / images":"Add more files"}
            <span style={{fontSize:11.5,color:"var(--text3)",fontWeight:400}}>PDF · PNG · JPG · TXT — screenshots welcome</span>
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.txt,.md,image/*" multiple style={{display:"none"}}
            onChange={(e)=>{setFiles(p=>[...p,...Array.from(e.target.files||[])]);e.target.value="";}}/>
          {files.length>0&&(
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {files.map((f,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:9,background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"9px 12px",fontSize:13}}>
                  <FileText size={14} color="var(--text3)"/>
                  <span style={{flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.name}</span>
                  <span style={{fontSize:11,color:"var(--text3)"}}>{(f.size/1024/1024).toFixed(1)} MB</span>
                  <button className="btn btn-ghost" onClick={()=>setFiles(p=>p.filter((_,j)=>j!==i))} style={{width:26,height:26}}><X size={12}/></button>
                </div>
              ))}
            </div>
          )}
          <div>
            <div className="sec">Or paste your notes</div>
            <textarea value={pasted} onChange={e=>setPasted(e.target.value)} rows={6} placeholder="Paste a word list, vocab table, or glossary…"
              style={{width:"100%",background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 13px",fontSize:13.5,color:"var(--text)",resize:"vertical",fontFamily:"inherit"}}/>
          </div>
          <button className="btn btn-primary" onClick={run} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14.5}}>
            <Sparkles size={15}/> Analyze &amp; build flashcards
          </button>
        </>)}
        {stage==="working"&&(
          <div style={{textAlign:"center",padding:"46px 12px",display:"flex",flexDirection:"column",alignItems:"center",gap:14}}>
            <RefreshCw size={26} className="spin" color="var(--know)"/>
            <div style={{fontSize:14,fontWeight:600}}>Building your vocabulary deck…</div>
            <div style={{fontSize:12.5,color:"var(--text3)",minHeight:18}}>{progress}</div>
            <button className="btn" onClick={()=>{cancelRef.current=true;setStage("input");}} style={{fontSize:12.5,color:"var(--text3)",background:"var(--surface2)",padding:"8px 18px",borderRadius:"var(--rs)"}}>Cancel</button>
          </div>
        )}
        {stage==="preview"&&(<>
          <div style={{background:"var(--know-bg)",border:"1px solid var(--know-border)",borderRadius:"var(--rs)",padding:"11px 14px",fontSize:13.5,color:"var(--know)",fontWeight:600}}>
            <Check size={14} style={{verticalAlign:-2}}/> Found {cards.length} word{cards.length!==1?"s":""} from {pagesRead} page{pagesRead!==1?"s":""} — review, prune, then save.
          </div>
          {warnings.length>0&&(
            <div style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rs)",padding:"11px 14px",fontSize:12.5,color:"var(--weak)",fontWeight:600,display:"flex",alignItems:"center",gap:10}}>
              <span style={{flex:1}}>⚠️ {warnings.length} issue{warnings.length!==1?"s":""} while reading — some pages may be missing or incomplete below:</span>
              {warnings.length>1&&warnings.some(w=>w.batch)&&(
                <button className="btn" onClick={retryAll} style={{fontSize:11.5,color:"var(--weak)",background:"var(--surface)",border:"1px solid var(--weak-border)",padding:"6px 11px",borderRadius:"var(--rxs)",flexShrink:0}}>
                  <RefreshCw size={11}/> Retry all
                </button>
              )}
            </div>
          )}
          {warnings.map((w)=>(
            <div key={w.id} style={{background:"var(--weak-bg)",border:"1px solid var(--weak-border)",borderRadius:"var(--rs)",padding:"9px 13px",fontSize:12,color:"var(--weak)",display:"flex",alignItems:"center",gap:10}}>
              <span style={{flex:1}}>⚠️ {w.message}</span>
              {w.batch&&(
                <button className="btn btn-ghost" disabled={w.retrying} onClick={()=>retry(w)} style={{fontSize:11.5,color:"var(--weak)",padding:"4px 10px",flexShrink:0}}>
                  <RefreshCw size={11} className={w.retrying?"spin":""}/> {w.retrying?"Retrying…":"Retry"}
                </button>
              )}
            </div>
          ))}
          {!targetDeck&&(
            <div>
              <div className="sec">Deck name</div>
              <input value={deckTitle} onChange={e=>setDeckTitle(e.target.value)}
                style={{width:"100%",background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"11px 13px",fontSize:14,color:"var(--text)",fontWeight:600}}/>
            </div>
          )}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {cards.map((c,i)=>(
              <div key={i} style={{background:"var(--surface)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 14px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <button onClick={()=>setExpanded(expanded===i?-1:i)} style={{flex:1,display:"flex",alignItems:"center",gap:8,background:"none",border:"none",cursor:"pointer",textAlign:"left",padding:0,color:"var(--text)"}}>
                    {expanded===i?<ChevronUp size={14} color="var(--text3)"/>:<ChevronDown size={14} color="var(--text3)"/>}
                    <span style={{fontWeight:600,fontSize:13.5,flex:1}}>{c.english}</span>
                    <span className="chip" style={{fontSize:10.5,padding:"2px 8px"}}>{c.wordType}</span>
                    {c.arabicBase&&<span className="ar" style={{fontSize:15,color:"var(--know)"}}>{c.arabicBase}</span>}
                  </button>
                  <button className="btn btn-ghost" title="Remove" onClick={()=>{setCards(p=>p.filter((_,j)=>j!==i));setExpanded(-1);}} style={{width:28,height:28,color:"var(--weak)"}}><Trash2 size={13}/></button>
                </div>
                {expanded===i&&(
                  <div style={{marginTop:10,display:"flex",flexWrap:"wrap",gap:8}}>
                    {Object.entries(c.forms).map(([k,v])=>(
                      <div key={k} style={{background:"var(--accent-bg)",borderRadius:"var(--rxs)",padding:"7px 11px"}}>
                        <div style={{fontSize:10.5,color:"var(--text3)",textTransform:"uppercase",letterSpacing:.3}}>{FORM_LABELS[k]||k}</div>
                        <div className="ar" style={{fontSize:16}}>{v}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          <button className="btn btn-primary" onClick={save} disabled={cards.length===0} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14.5}}>
            <Save size={15}/> {targetDeck?`Add ${cards.length} cards to "${targetDeck.title}"`:`Save deck · ${cards.length} cards`}
          </button>
          <button className="btn" onClick={()=>setStage("input")} style={{width:"100%",fontSize:12.5,color:"var(--text3)",background:"transparent"}}>← Back to input</button>
        </>)}
      </div>
    </div>
  );
}

// teaser). Kept to what actually exists to avoid implying features that don't.
const CAPSULES=[
  {id:"island", title:"Language Island", titleAr:"جزيرة اللغة", icon:Globe, color:"#2563EB", status:"live", screen:"island",
   desc:"Immersion Q&A across all 64 units — read, answer aloud, reveal the model answer."},
];

function CapsulesScreen({profile,onOpen,onBack}){
  const personalized=!!profile?.personalizationOn;
  return (
    <div className="screen">
      <Hdr title="Immersion Capsules" sub="Capsules" onBack={onBack}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:11}}>
        <TipBanner id="capsules-intro" title="What are capsules?">
          Self-contained immersion experiences. <b>Language Island</b> generates speaking-practice Q&amp;A across all 64 units. Turn on <b>Personalized</b> mode in Settings to tailor them to your profile and known words.
        </TipBanner>
        <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.6,marginBottom:2}}>
          Long-form, conversational practice. {personalized
            ? <b style={{color:"var(--accent)"}}>Personalized</b>
            : "General"} mode — {personalized?"tailored to your profile & known vocabulary.":"shared preset content at your level."}
        </div>
        {CAPSULES.map(c=>{
          const Icon=c.icon; const live=c.status==="live";
          return (
            <div key={c.id} onClick={()=>live&&onOpen(c.screen)} className="module-card"
              style={{borderColor:c.color+"55",background:c.color+"12",cursor:live?"pointer":"default",opacity:live?1:.55}}>
              <div style={{width:42,height:42,borderRadius:12,background:c.color,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Icon size={20} color="#fff"/></div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                  <span style={{fontWeight:700,fontSize:14.5,color:c.color}}>{c.title}</span>
                  <span className="ar" style={{fontSize:13,color:"var(--text3)"}}>{c.titleAr}</span>
                  {!live&&<span style={{fontSize:9.5,fontWeight:800,letterSpacing:".06em",color:"var(--text3)",background:"var(--surface2)",padding:"2px 7px",borderRadius:100}}>SOON</span>}
                </div>
                <div style={{fontSize:12.5,color:"var(--text2)",marginTop:3,lineHeight:1.5}}>{c.desc}</div>
              </div>
              {live&&<ChevronRight size={15} color={c.color}/>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PresetLibraryScreen({profile,decks,onBack}){
  const [central,setCentral]=useState([]);
  const [onlyMyLevel,setOnlyMyLevel]=useState(true);
  useEffect(()=>{ let alive=true; fetchCentralPresets().then(c=>{if(alive&&c.length)setCentral(c);}); return ()=>{alive=false;}; },[]);
  const byId={}; PRESET_DECKS.forEach(d=>{byId[d.id]=d;}); central.forEach(d=>{byId[d.id]=d;});
  const list=Object.values(byId);
  const wl=profile?.workingLevel;
  const filtered=(onlyMyLevel&&wl)?list.filter(d=>d.level===wl):list;
  const owned=new Set((decks||[]).map(d=>d.title));
  return (
    <div className="screen">
      <Hdr title="Preset Library" sub="Starter decks" onBack={onBack}/>
      <div style={{padding:"18px 20px 0",display:"flex",flexDirection:"column",gap:11}}>
        <TipBanner id="presets-intro" title="Free starter decks">
          Ready-made, fully-voweled decks available to everyone. Tap <b>Download</b> to copy one into your decks — then study and edit it like your own; it syncs to your account.
        </TipBanner>
        {wl&&(
          <div style={{display:"flex",gap:6}}>
            <button className={`chip ${onlyMyLevel?"chip-on":""}`} onClick={()=>setOnlyMyLevel(true)} style={{padding:"5px 11px",fontSize:12}}>My level · {levelById(wl).label}</button>
            <button className={`chip ${!onlyMyLevel?"chip-on":""}`} onClick={()=>setOnlyMyLevel(false)} style={{padding:"5px 11px",fontSize:12}}>All levels</button>
          </div>
        )}
        {filtered.length===0&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:14,padding:"32px 0"}}><Layers size={26} style={{opacity:.3,marginBottom:8}}/><br/>No preset decks for this level yet.</div>}
        {filtered.map(pd=>{
          const u=pd.unitId?unitById(pd.unitId):null;
          const already=owned.has(pd.title);
          return (
            <div key={pd.id} className="module-card" style={{alignItems:"flex-start",cursor:"default"}}>
              <div style={{width:40,height:40,borderRadius:12,background:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Layers size={18} color="#fff"/></div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14}}>{pd.title}</div>
                <div style={{fontSize:11.5,color:"var(--text3)",marginTop:2}}>{(pd.cards||[]).length} cards · {levelById(pd.level).cefr}{u?` · ${u.titleEn}`:""}</div>
                <div className="ar" dir="rtl" style={{fontSize:15,color:"var(--accent)",marginTop:5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{(pd.cards||[]).slice(0,5).map(c=>c.arabicBase).join(" · ")}</div>
              </div>
              <button className="btn btn-sm" onClick={()=>{const n=downloadPreset(pd);showToast(`Added "${pd.title}" (${n} cards) to your decks`,"success");}}
                style={{background:already?"var(--surface2)":"var(--accent)",color:already?"var(--text2)":"#fff",flexShrink:0,alignSelf:"center",gap:5,fontSize:12.5}}>
                <Download size={13}/> {already?"Add again":"Download"}
              </button>
            </div>
          );
        })}
        <div style={{height:20}}/>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LANGUAGE ISLAND — Arabic immersion capsule (vendored ./language-island)
// Thin React host: mounts the framework-free widget into a div and wires it to
// this app's own systems — generation flows through callClaude (/api/claude →
// OpenRouter, server-side key, usage meter), and difficulty is personalized to
// the learner's real deck via the `vocab` option. localStorage persistence and
// the widget's scoped (.li-root) styling are handled inside the module.
// ─────────────────────────────────────────────────────────────
function LanguageIslandScreen({decks,cardStates,profile,trackUsage,onBack}) {
  const ref=useRef(null);
  useEffect(()=>{
    const personalized=!!profile?.personalizationOn;
    // Layered per-user store (Phase 3): localStorage always (instant, reliable),
    // plus Firestore when signed in so sets + ✓ marks sync across devices. If
    // Firestore is blocked (rules/offline) the local layer keeps persistence —
    // no regression from the module's localStorage default.
    const encKey=(k)=>String(k).replace(/\//g,"_");
    const lsGet=(k)=>{try{const v=localStorage.getItem("li:"+k);return v?JSON.parse(v):null;}catch{return null;}};
    const lsSet=(k,v)=>{try{localStorage.setItem("li:"+k,JSON.stringify(v));}catch{}};
    const islandStore={
      async get(k){ const u=auth.currentUser;
        if(u){ try{ const snap=await getDoc(doc(db,"users",u.uid,"island",encKey(k))); if(snap.exists()) return snap.data().value; }catch{} }
        return lsGet(k); },
      async set(k,v){ lsSet(k,v); const u=auth.currentUser;
        if(u){ try{ await setDoc(doc(db,"users",u.uid,"island",encKey(k)),{value:v,updatedAt:Date.now()}); }catch{} } },
      async remove(k){ try{localStorage.removeItem("li:"+k);}catch{} const u=auth.currentUser;
        if(u){ try{ await setDoc(doc(db,"users",u.uid,"island",encKey(k)),{value:null,updatedAt:Date.now()}); }catch{} } },
    };
    const inst=mountIsland(ref.current,{
      store:islandStore,
      // Generation now flows through the gateway (/api/generate): auth +
      // entitlement + cache + metering server-side. General mode draws from the
      // shared (cacheable) library; personalized mode biases to the learner's
      // known vocabulary. `seq` keeps "generate more" fresh while letting the
      // first batch per unit/level be a shared cache hit.
      generate:async ({unitAr,unitEn,level,count})=>{
        const known=personalized?knownVocab(decks,cardStates):[];
        const persona=personalized?buildPersona(profile):"";
        // Ground Q&A in this unit's real curriculum vocabulary.
        const u=UNITS.find(x=>x.titleAr===unitAr||x.titleEn===unitEn);
        const unitVocab=u?UNIT_VOCAB[u.id]||null:null;
        const seqKey=`li-seq:${personalized?"p:":""}${unitEn}:${level.id}`;
        let seq=0; try{ seq=parseInt(localStorage.getItem(seqKey)||"0",10)||0; }catch{}
        const d=await callGenerate({
          kind:"islandQA",
          inputs:{unitAr,unitEn,level:{id:level.id,guidance:level.guidance},count,vocab:known,persona,unitVocab,topic:unitEn,seq},
          maxTokens:1024, tag:"island", personalized, trackFn:trackUsage,
        });
        try{ localStorage.setItem(seqKey,String(seq+1)); }catch{}
        const pairs=d.payload;
        if(!pairs?.length) throw new Error("Could not read the generated questions — try again.");
        return pairs;
      },
      onClose:onBack,
    });
    return ()=>{ try{inst.destroy();}catch{} };
  },[]); // mount once; deps intentionally empty
  return (
    <div className="screen">
      <div style={{padding:"18px 16px 0"}}>
        <button className="btn btn-ghost" onClick={onBack} style={{display:"flex",alignItems:"center",gap:6,fontSize:14,color:"var(--text2)"}}><ArrowLeft size={16}/> Home</button>
      </div>
      <div ref={ref} style={{padding:"8px 12px 24px"}}/>
    </div>
  );
}

export default function App() {
  const [screen,setScreen]=useState("home");
  const [decks,setDecks]=useState(SEED_DECKS);
  const [cardStates,setCardStates]=useState(SEED_CARDS);
  const [activeDeck,setActiveDeck]=useState(null);
  const [activeCard,setActiveCard]=useState(null);
  const [settings,setSettings]=useState({orKey:"",gKey:"",model:"openai/gpt-4o-mini"});
  const [user,setUser]=useState(undefined); // undefined = loading, null = signed out
  const [dataLoaded,setDataLoaded]=useState(false);
  const [loadError,setLoadError]=useState(false);
  const [loadRetryTick,setLoadRetryTick]=useState(0);
  const [authLoading,setAuthLoading]=useState(false);
  const [authError,setAuthError]=useState("");
  const [sessionCards,setSessionCards]=useState([]);
  const [currentIdx,setCurrentIdx]=useState(0);
  const [usage,setUsage]=useState(initUsage);
  const [studyLog,setStudyLog]=useState(initStudyLog);
  const [showSearch,setShowSearch]=useState(false);
  const [showOnboarding,setShowOnboarding]=useState(false);
  const [profile,setProfile]=useState(null); // {displayName,workingLevel,personalizationOn,personalContext,nativeLanguage}
  const [sessionRating,setSessionRating]=useState(null);
  const [masterPool,setMasterPool]=useState("all"); // all, weak, due
  const [grammarTarget,setGrammarTarget]=useState(null); // grammar deck to append to (null = create new)
  const [vocabTarget,setVocabTarget]=useState(null); // vocab deck to append to via Vocab Import (null = create new)
  const [sessionRestored,setSessionRestored]=useState(false);
  const sessionRes=useRef({known:0,weak:0});
  const studyHistory=useRef([]); // [{prevCard, prevIdx, prevRes}] for undo
  // Timestamp of the newest decks/cardStates state this tab actually knows
  // about — from its own last save or its last fetch from Firestore. Lets the
  // refresh-on-visible effect below tell "cloud has something new" apart from
  // "cloud still has exactly what I just wrote", without which a plain
  // getDoc-and-apply on every foreground would occasionally win a race against
  // an in-flight save and clobber a just-made local edit with the slightly
  // older copy that read completed against.
  const lastSyncRef=useRef(0);
  const [darkMode,setDarkMode]=useState(()=>{
    const saved=localStorage.getItem("arabic_fc_dark");
    if(saved!==null) return saved==="true";
    return window.matchMedia?.("(prefers-color-scheme:dark)").matches||false;
  });
  useEffect(()=>{
    document.documentElement.setAttribute("data-theme",darkMode?"dark":"light");
    localStorage.setItem("arabic_fc_dark",darkMode);
  },[darkMode]);

  // Firebase auth state listener
  useEffect(()=>{
    let mounted=true;
    const loadUserDoc=(u)=>{
      setLoadError(false);
      getDoc(doc(db,"users",u.uid)).then(snap=>{
          if(!mounted) return;
          if(snap.exists()){
            const d=snap.data();
            try {
              // Trust an explicitly-present `decks` array as-is — including an
              // empty one, which is a legitimate "user deleted everything"
              // state. Only fall back to the local seed when the field is
              // truly ABSENT (e.g. a doc predating this field). Previously this
              // checked `d.decks?.length`, so any load that returned a falsy/
              // empty decks array (transient read glitch, etc.) silently kept
              // the in-memory SEED_DECKS/SEED_CARDS, which then got written
              // back over the real cloud data by the autosave effect below —
              // wiping the user's real decks. cardStates cleaning is nested in
              // here for the same reason: never derive it from local seed data.
              if(Array.isArray(d.decks)) {
                setDecks(d.decks);
                // Clean orphaned cardStates — only keep keys matching existing decks
                if(d.cardStates){
                  const deckIds=new Set(d.decks.map(dk=>dk.id));
                  const cleaned={};
                  for(const [k,v] of Object.entries(d.cardStates)){
                    if(deckIds.has(k)) cleaned[k]=v;
                  }
                  setCardStates(cleaned);
                }
              }
              if(d.settings) setSettings(s=>({...s,...d.settings}));
              if(d.profile) setProfile(d.profile);
              if(d.usage?.byTag) setUsage(d.usage);
              if(d.studyLog) setStudyLog(sl=>({...initStudyLog(),...d.studyLog}));
              hydrateSessionsFromCloud(d);
              hydrateDeckIdxFromCloud(d,savedIdx);
              lastSyncRef.current=d.updatedAt||0;
            } catch(e){ console.error("Data parse error:",e); }
          }
          setDataLoaded(true);
          // Show onboarding for first-time users
          if(!snap.exists()||!snap.data()?.onboardingDone) setShowOnboarding(true);
        }).catch(e=>{
          console.error("Firestore load error:",e);
          // Do NOT setDataLoaded(true) here — that would arm the autosave
          // effect below with whatever is still in local state (seed data on
          // a fresh mount), which would then overwrite the user's real cloud
          // data. Leaving dataLoaded false blocks autosave and surfaces a
          // retry instead of silently deleting the account's decks.
          if(mounted) setLoadError(true);
        });
    };
    const unsub=onAuthStateChanged(auth,u=>{
      if(!mounted) return;
      if(u){
        setUser(u);
        setSessionSyncUser(u.uid);
        loadUserDoc(u);
      } else {
        setUser(null);
        setSessionSyncUser(null);
        setDataLoaded(false);
      }
    });
    return ()=>{mounted=false;unsub();};
  },[loadRetryTick]);

  // Auto-save to Firestore whenever data changes. Debounced 1.5s so rapid
  // edits (typing, quick card swipes) don't spam writes — but the debounce
  // ALONE silently drops the save if the tab is switched away from, put in
  // the background, or closed within that window. That's exactly what was
  // reported as "imported deck disappeared": finish a big PDF/screenshot
  // import, immediately switch to another device before 1.5s is up, and the
  // import never reaches Firestore at all — it only ever existed in this
  // tab's React state. The next device to load then fetches the real (import-
  // missing) cloud doc, and if that device's own autosave later fires, it
  // writes that snapshot straight back over the original tab's local state
  // too, on next reload. Fix: also flush immediately, bypassing the
  // debounce, the moment the tab is hidden or unloading.
  useEffect(()=>{
    if(!user||!dataLoaded) return;
    const save=()=>{
      const stamp=Date.now();
      setDoc(doc(db,"users",user.uid),{decks,cardStates,settings,usage,studyLog,updatedAt:stamp,...(profile?{profile}:{})},{merge:true})
        .then(()=>{ lastSyncRef.current=stamp; })
        .catch(e=>console.error("Save error:",e));
    };
    const t=setTimeout(save,1500);
    const flushIfHidden=()=>{ if(document.visibilityState==="hidden") save(); };
    document.addEventListener("visibilitychange",flushIfHidden);
    window.addEventListener("pagehide",save);
    return ()=>{
      clearTimeout(t);
      document.removeEventListener("visibilitychange",flushIfHidden);
      window.removeEventListener("pagehide",save);
    };
  },[decks,cardStates,settings,usage,studyLog,profile,user,dataLoaded]);

  // Refresh-on-foreground: a tab left open across a study session (or just
  // sitting in a background phone tab) never re-fetches on its own — only
  // mount/sign-in does a getDoc. So if a DIFFERENT device saves a new deck
  // (e.g. a PDF import) while this tab sits idle, this tab's `decks` goes
  // stale — and the very next thing that touches its autosave deps (studying
  // one card bumps `usage`/`studyLog`, which are both in that effect's dep
  // array) writes this tab's stale decks straight back over the cloud,
  // erasing the other device's import. Re-pulling the doc whenever the tab
  // regains visibility/focus closes that gap. Guarded by `updatedAt` (see
  // lastSyncRef above) so this can never win a race against this same tab's
  // own in-flight save and regress to older data.
  useEffect(()=>{
    if(!user||!dataLoaded) return;
    const refresh=()=>{
      if(document.visibilityState!=="visible") return;
      getDoc(doc(db,"users",user.uid)).then(snap=>{
        if(!snap.exists()) return;
        const d=snap.data();
        // Session/screen and deck-resume-position hydration are gated by
        // their own per-key freshness checks (savedAt / plain cloud-wins
        // merge), independent of the decks/cardStates `updatedAt` guard
        // below — they must run on every foreground refresh, not just the
        // ones where decks happened to change, or a device that only
        // studied cards (never touching decks) would never pick up the
        // other device's resume position.
        hydrateSessionsFromCloud(d);
        hydrateDeckIdxFromCloud(d,savedIdx);
        if(!Array.isArray(d.decks)) return;
        if((d.updatedAt||0)<=lastSyncRef.current) return;
        setDecks(d.decks);
        if(d.cardStates){
          const deckIds=new Set(d.decks.map(dk=>dk.id));
          const cleaned={};
          for(const [k,v] of Object.entries(d.cardStates)){
            if(deckIds.has(k)) cleaned[k]=v;
          }
          setCardStates(cleaned);
        }
        lastSyncRef.current=d.updatedAt;
      }).catch(e=>console.error("Refresh error:",e));
    };
    document.addEventListener("visibilitychange",refresh);
    window.addEventListener("focus",refresh);
    return ()=>{
      document.removeEventListener("visibilitychange",refresh);
      window.removeEventListener("focus",refresh);
    };
  },[user,dataLoaded]);

  // Restore active session from localStorage once data is loaded
  // Reload/refresh always lands on Home now (founder decision 2026-08-06) —
  // deliberately NOT auto-navigating into whatever screen was active before,
  // even for "study"/"masterReview" which do track real progress. This used
  // to jump straight back into study/reading/listening/conversation (+master
  // variants) on load, which was surprising more often than it was welcome.
  // `sessionRestored` still has to end up `true` — the initial-load gate at
  // the bottom of this component blocks all rendering until it does — it's
  // just no longer doing any actual restoration first. Per-screen PREFERENCE
  // memory (deck selection, settings, generated content — saveScreen/
  // loadScreen, keyed separately per screen) is untouched and still applies
  // whenever you manually navigate into one of those screens; only the
  // "which screen were you on, jump back into it" behavior is gone. Master
  // Review's own in-screen "Resume" button (hydrateSessionCards/
  // deflateSessionCards, further down) is a different, screen-local
  // mechanism and is also untouched.
  useEffect(()=>{
    if(!dataLoaded||sessionRestored) return;
    setSessionRestored(true);
  },[dataLoaded,sessionRestored]);

  const handleSignIn=async()=>{
    setAuthLoading(true);setAuthError("");
    try {
      await signInWithPopup(auth,googleProvider);
    } catch(e){
      setAuthError(e.message||"Sign-in failed. Please try again.");
    } finally { setAuthLoading(false); }
  };

  const handleSignOut=async()=>{
    clearAllSessions();
    studyHistory.current=[];
    setSessionCards([]);setCurrentIdx(0);
    await signOut(auth);
    setScreen("home");
  };

  // Immediately push decks/cardStates to Firestore, bypassing the debounced
  // autosave effect entirely. Import actions are exactly the case that
  // effect's 1.5s debounce fails: the toast below fires the instant local
  // state updates, so the user reasonably believes it's saved and may
  // refresh or switch devices right away — but the write itself was still
  // sitting in the debounce queue and had not gone out at all yet. A big,
  // effortful, one-shot action like a PDF/screenshot import can't be allowed
  // to depend on the tab staying open and idle for another 1.5+ seconds.
  const flushSaveNow=(newDecks,newCardStates)=>{
    if(!user) return;
    const stamp=Date.now();
    setDoc(doc(db,"users",user.uid),{decks:newDecks,cardStates:newCardStates,settings,usage,studyLog,updatedAt:stamp,...(profile?{profile}:{})},{merge:true})
      .then(()=>{ lastSyncRef.current=stamp; })
      .catch(e=>{ console.error("Save error:",e); showToast("Saved on this device but failed to sync — check your connection and don't close this tab yet.","error"); });
  };

  // Save grammar cards from the Grammar Import screen — either into a brand
  // new deckType:"grammar" deck or appended to an existing grammar deck.
  const saveGrammarDeck=(title,cards,target)=>{
    let newDecks=decks,newCardStates;
    if(target){
      newCardStates={...cardStates,[target.id]:[...(cardStates[target.id]||[]),...cards]};
      setCardStates(newCardStates);
      showToast(`Added ${cards.length} grammar cards to "${target.title}"`,"success");
    } else {
      const deck={id:`d${Date.now()}`,title,createdAt:Date.now(),deckType:"grammar"};
      newDecks=[deck,...decks];
      newCardStates={...cardStates,[deck.id]:cards};
      setDecks(newDecks);
      setCardStates(newCardStates);
      showToast(`Grammar deck "${title}" created — ${cards.length} concepts`,"success");
    }
    flushSaveNow(newDecks,newCardStates);
    setGrammarTarget(null);
    setScreen("home");
  };

  // Save vocab cards from the Vocab Import screen — either into a brand new
  // deck or appended to an existing one. Cards are normal wordType (noun/
  // verb/adjective), no deckType tag — same shape as manually-added cards.
  const saveVocabDeck=(title,cards,target)=>{
    let newDecks=decks,newCardStates;
    if(target){
      newCardStates={...cardStates,[target.id]:[...(cardStates[target.id]||[]),...cards]};
      setCardStates(newCardStates);
      showToast(`Added ${cards.length} vocab cards to "${target.title}"`,"success");
    } else {
      const deck={id:`d${Date.now()}`,title,createdAt:Date.now()}; // no deckType → normal vocab deck
      newDecks=[deck,...decks];
      newCardStates={...cardStates,[deck.id]:cards};
      setDecks(newDecks);
      setCardStates(newCardStates);
      showToast(`Vocab deck "${title}" created — ${cards.length} cards`,"success");
    }
    flushSaveNow(newDecks,newCardStates);
    setVocabTarget(null);
    setScreen("home");
  };

  // Handle deck import from HomeScreen
  useEffect(()=>{
    const handler=(e)=>{
      const {deck:d,cards:c}=e.detail;
      const newDecks=[d,...decks];
      const newCardStates={...cardStates,[d.id]:c};
      setDecks(newDecks);
      setCardStates(newCardStates);
      flushSaveNow(newDecks,newCardStates);
    };
    window.addEventListener("importDeck",handler);
    return ()=>window.removeEventListener("importDeck",handler);
  },[decks,cardStates,user,settings,usage,studyLog,profile]);

  // Keep module-level refs in sync — picked up automatically by callClaude /
  // generateImage / synthesizeArabic / transcribeAudio.
  useEffect(()=>{
    _defaultModel = settings.model || "openai/gpt-4o-mini";
    _modelByTag = {...(settings.models||{})};
    _imageModel = settings.imageModel || "gemini-2.5-flash-image";
    _orKey = settings.orKey||"";
    _gKey = settings.gKey||"";
    _ttsKey = settings.ttsKey||"";
    _ttsVoice = settings.ttsVoice||"ar-XA-Wavenet-C";
    _ttsSpeed = typeof settings.ttsSpeed==="number"?settings.ttsSpeed:0.92;
    _sttKey = settings.sttKey||"";
    _sttEnabled = !!settings.sttEnabled;
    _convSilenceMs = typeof settings.convSilenceMs==="number"?settings.convSilenceMs:2500;
    _convFuzzyThreshold = typeof settings.convFuzzyThreshold==="number"?settings.convFuzzyThreshold:0.8;
    _autoGenerateImage = !!settings.autoGenerateImage;
  },[settings.model,settings.models,settings.imageModel,settings.orKey,settings.gKey,settings.ttsKey,settings.ttsVoice,settings.ttsSpeed,settings.sttKey,settings.sttEnabled,settings.convSilenceMs,settings.convFuzzyThreshold,settings.autoGenerateImage]);
  const go=s=>setScreen(s);

  // Usage tracker function passed to all Claude calls
  const trackUsage=useCallback((tag,inputChars,outputChars,inputTokens,outputTokens)=>{
    setUsage(prev=>{
      const t=prev.byTag[tag]||prev.byTag["other"]||{calls:0,inputTokens:0,outputTokens:0};
      return {
        ...prev,
        byTag:{
          ...prev.byTag,
          [tag]:{calls:t.calls+1,inputTokens:t.inputTokens+(inputTokens||0),outputTokens:t.outputTokens+(outputTokens||0)},
        },
      };
    });
  },[]);

  // Expose trackUsage to the module-level synthesizeArabic / transcribeAudio
  // helpers so they can record TTS chars + STT seconds against the meter.
  // Two-arg signature: (tag, units) → forwarded as inputTokens for accumulation.
  useEffect(()=>{
    _voiceTracker = (tag, units) => trackUsage(tag, 0, 0, units, 0);
    return () => { _voiceTracker = null; };
  },[trackUsage]);

  // Reset all usage counters to zero. Useful for watching a clean window
  // (e.g. "what did today actually cost?"). Doesn't touch real provider
  // bills — just clears the in-app meter. The new trackingSince becomes
  // the starting point for the next round of counting.
  const resetUsageCounters=useCallback(()=>{
    if(typeof window!=="undefined"&&!window.confirm("Reset usage counters to zero? This won't affect your real provider bills — it just clears what this meter shows. Start tracking from now.")) return;
    setUsage(initUsage());
  },[]);

  const openDeck=deck=>{setActiveDeck(deck);go("deck");};
  const createDeck=(title,unitId=null)=>{
    const id=`d${Date.now()}`;
    const u=unitId?unitById(unitId):null;
    const deck={id,title,createdAt:Date.now(),...(u?{unitId:u.id,level:u.level}:{})};
    setDecks(p=>[deck,...p]);setCardStates(p=>({...p,[id]:[]}));setActiveDeck(deck);go("addCards");
  };
  const renameDeck=(id,title)=>setDecks(p=>p.map(d=>d.id===id?{...d,title}:d));
  // Link/unlink a deck to a curriculum unit (Phase 2). Stores unitId + derived level.
  const setDeckUnit=(id,unitId)=>{
    const u=unitId?unitById(unitId):null;
    setDecks(p=>p.map(d=>{
      if(d.id!==id) return d;
      const {unitId:_u,level:_l,...rest}=d;
      return u?{...rest,unitId:u.id,level:u.level}:rest;
    }));
    setActiveDeck(ad=>ad&&ad.id===id?(u?{...ad,unitId:u.id,level:u.level}:(()=>{const {unitId,level,...r}=ad;return r;})()):ad);
  };
  const deleteDeck=(id)=>{
    setDecks(p=>p.filter(d=>d.id!==id));
    setCardStates(p=>{const n={...p};delete n[id];return n;});
    go("home");
  };
  const savedIdx=useRef(loadDeckIdx());
  const studyStartRef=useRef(null);
  const studyModeRef=useRef("all"); // which filter the active study session was started with
  // A deck only counts as "studied" for rotation purposes once you've rated
  // >=DECK_TOUCH_THRESHOLD cards from it in one sitting — a couple of stray
  // swipes shouldn't mark a whole deck fresh. Stamped once per session (ref,
  // not state) so it doesn't refire on every subsequent swipe past 20.
  const deckTouchStampedRef=useRef(false);
  // Capped to however many cards are actually in this study session — a deck
  // (or mode filter, e.g. "weak") with fewer than DECK_TOUCH_THRESHOLD cards
  // could otherwise never be rated enough times to count as studied.
  const deckTouchGoalRef=useRef(DECK_TOUCH_THRESHOLD);
  const touchDeck=(deckId)=>setDecks(p=>p.map(d=>d.id===deckId?{...d,lastStudiedAt:Date.now()}:d));
  // Manual override from the deck menu — corrects decks studied before this
  // feature existed, or outside the app. ts=null clears back to "never studied".
  const setDeckLastStudied=(deckId,ts)=>setDecks(p=>p.map(d=>d.id===deckId?{...d,lastStudiedAt:ts}:d));
  // Direct per-form weak flag, independent of the swipe/SRS flow — lets you
  // flag a SECOND form weak (e.g. Plural 2) while a different form (e.g.
  // Passive Part) is already the active retest, without that swipe silently
  // overwriting it. Only touches weakForms — no status/SRS side effects,
  // since this isn't a timed recall attempt, just a note for next time.
  const toggleWeakForm=(deckId,cardId,formKey)=>{
    if(!INFLECTIONAL_FORMS.has(formKey)) return;
    setCardStates(p=>({...p,[deckId]:(p[deckId]||[]).map(c=>{
      if(c.id!==cardId) return c;
      const has=(c.weakForms||[]).includes(formKey);
      const weakForms=has?c.weakForms.filter(f=>f!==formKey):[...(c.weakForms||[]),formKey];
      return {...c,weakForms};
    })}));
  };
  const startStudy=(mode,restart=false)=>{
    const dc=cardStates[activeDeck.id]||[];
    const now=Date.now();
    const toStudy=mode==="weak"?dc.filter(c=>c.status==="weak")
      :mode==="due"?dc.filter(c=>c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now)
      :mode==="new"?dc.filter(c=>c.status==="new"||!c.status)
      :mode==="known"?dc.filter(c=>c.status==="known")
      :sortByDueDate(dc);
    if(!toStudy.length) return;
    studyStartRef.current=Date.now();
    studyModeRef.current=mode;
    sessionRes.current={known:0,weak:0};
    deckTouchStampedRef.current=false;
    deckTouchGoalRef.current=Math.min(DECK_TOUCH_THRESHOLD,toStudy.length);
    studyHistory.current=[]; // fresh undo stack on (re)start
    setSessionCards(toStudy);
    const key=activeDeck.id+"_"+mode;
    const resumeIdx=(!restart&&savedIdx.current[key])||0;
    setCurrentIdx(Math.min(resumeIdx,toStudy.length-1));
    go("study");
  };
  const handleSwipe=(dir,cardId,activeForm)=>{
    const ns=dir==="right"?"known":"weak";
    // Snapshot for undo: previous card object and counters
    const prevCard=(cardStates[activeDeck.id]||[]).find(c=>c.id===cardId);
    if(prevCard){
      studyHistory.current.push({
        prevCard:JSON.parse(JSON.stringify(prevCard)),
        prevIdx:currentIdx,
        prevRes:{...sessionRes.current},
      });
    }
    sessionRes.current[ns==="known"?"known":"weak"]++;
    if(!deckTouchStampedRef.current&&sessionRes.current.known+sessionRes.current.weak>=deckTouchGoalRef.current&&activeDeck){
      deckTouchStampedRef.current=true;
      touchDeck(activeDeck.id);
    }
    setCardStates(p=>({...p,[activeDeck.id]:p[activeDeck.id].map(c=>{
      if(c.id!==cardId) return c;
      const srs=calculateSRS(c,ns);
      // Per-instance weakness tracking — inflectional forms only (see
      // INFLECTIONAL_FORMS); synonym/antonym are different words and must
      // never drive this card's weak-form retest queue.
      let weakForms=c.weakForms?[...c.weakForms]:[];
      if(ns==="weak"&&activeForm&&INFLECTIONAL_FORMS.has(activeForm)){
        if(!weakForms.includes(activeForm)) weakForms.push(activeForm);
      } else if(ns==="known"&&activeForm&&INFLECTIONAL_FORMS.has(activeForm)){
        weakForms=weakForms.filter(f=>f!==activeForm);
      }
      return {...c,status:ns,weakForms,...srs};
    })}));
    if(currentIdx<sessionCards.length-1){
      const nextIdx=currentIdx+1;
      setCurrentIdx(nextIdx);
      // Save progress for resume, keyed by the filter this session started with
      if(activeDeck){
        const key=activeDeck.id+"_"+studyModeRef.current;
        savedIdx.current[key]=nextIdx;saveDeckIdx(savedIdx.current);cloudSyncDeckIdx(key,nextIdx);
      }
    } else {
      // Reset saved progress on completion, log study time, clear persisted session
      if(activeDeck){
        const key=activeDeck.id+"_"+studyModeRef.current;
        savedIdx.current[key]=0;saveDeckIdx(savedIdx.current);cloudSyncDeckIdx(key,0);
      }
      if(studyStartRef.current){
        const mins=Math.max(1,Math.round((Date.now()-studyStartRef.current)/60000));
        logStudy({type:"app",module:"vocab",minutes:mins});studyStartRef.current=null;
      }
      saveSession(null);
      studyHistory.current=[];
      go("complete");
    }
  };

  // Undo the most recent swipe in StudyScreen
  const undoStudy=()=>{
    const snap=studyHistory.current.pop();
    if(!snap||!activeDeck) return;
    setCardStates(p=>({...p,[activeDeck.id]:(p[activeDeck.id]||[]).map(c=>c.id===snap.prevCard.id?snap.prevCard:c)}));
    sessionRes.current={...snap.prevRes};
    setCurrentIdx(snap.prevIdx);
  };

  // Restore a card snapshot — used by MasterReview undo
  const restoreCard=(deckId,prevCard)=>{
    if(!deckId||!prevCard) return;
    setCardStates(p=>({...p,[deckId]:(p[deckId]||[]).map(c=>c.id===prevCard.id?prevCard:c)}));
  };
  const saveCards=newCards=>{
    setCardStates(p=>({...p,[activeDeck.id]:[...(p[activeDeck.id]||[]),...newCards]}));
    setDecks(p=>p.map(d=>d.id===activeDeck.id?{...d,createdAt:Date.now()}:d));go("deck");
  };
  const saveEditedCard=edited=>{setCardStates(p=>({...p,[activeDeck.id]:p[activeDeck.id].map(c=>c.id===edited.id?edited:c)}));go("deck");};
  const deleteCard=cardId=>setCardStates(p=>({...p,[activeDeck.id]:p[activeDeck.id].filter(c=>c.id!==cardId)}));
  const addToFlashcard=(deckId,card)=>{
    setCardStates(p=>({...p,[deckId]:[...(p[deckId]||[]),card]}));
    setDecks(p=>p.map(d=>d.id===deckId?{...d,createdAt:Date.now()}:d));
  };

  const logStudy=(entry)=>setStudyLog(prev=>addStudyEntry(prev,entry));

  // Master review swipe — updates the correct deck's card
  const handleMasterSwipe=(deckId,cardId,status,activeForm)=>{
    setCardStates(p=>({...p,[deckId]:(p[deckId]||[]).map(c=>{
      if(c.id!==cardId) return c;
      const srs=calculateSRS(c,status);
      let weakForms=c.weakForms?[...c.weakForms]:[];
      if(status==="weak"&&activeForm&&INFLECTIONAL_FORMS.has(activeForm)){if(!weakForms.includes(activeForm)) weakForms.push(activeForm);}
      else if(status==="known"&&activeForm&&INFLECTIONAL_FORMS.has(activeForm)){weakForms=weakForms.filter(f=>f!==activeForm);}
      return {...c,status,weakForms,...srs};
    })}));
  };

  const completeOnboarding=(data)=>{
    setShowOnboarding(false);
    if(data?.profile) setProfile(data.profile);
    if(user){
      const payload={onboardingDone:true};
      if(data?.profile) payload.profile=data.profile;
      if(data?.placement) payload.placement=data.placement;
      setDoc(doc(db,"users",user.uid),payload,{merge:true}).catch(e=>{
        console.error("Onboarding save error:",e);
        showToast("Couldn't save your profile — check your connection and try again.","error");
      });
    }
  };

  const handleSearchSelect=(card,deck)=>{
    setShowSearch(false);
    setActiveDeck(deck);
    if(card.wordType==="grammar"){ go("deck"); return; } // grammar cards have no form editor — open their deck instead
    setActiveCard(card);
    go("editCard");
  };

  const commonProps={decks,cardStates,trackUsage};

  const screens={
    home:<HomeScreen {...commonProps} onOpenDeck={openDeck} onSettings={()=>go("settings")} onCreateDeck={()=>go("createDeck")} onReading={()=>go("reading")} onListening={()=>go("listening")} onConversation={()=>go("conversation")} onDictation={()=>go("dictation")} onCapsules={()=>go("capsules")} onSearch={()=>setShowSearch(true)} onProgress={()=>go("progress")} onMasterReview={()=>go("masterReview")} onGuide={()=>go("guide")} onPresets={()=>go("preset")} onGrammarImport={()=>{setGrammarTarget(null);go("grammarImport");}} onVocabImport={()=>{setVocabTarget(null);go("vocabImport");}} darkMode={darkMode} onToggleDark={()=>setDarkMode(d=>!d)} studyLog={studyLog}/>,
    grammarImport:<GrammarImportScreen key={grammarTarget?.id||"new"} onBack={()=>{setGrammarTarget(null);go("home");}} trackUsage={trackUsage} onSave={saveGrammarDeck} targetDeck={grammarTarget}/>,
    vocabImport:<VocabImportScreen key={vocabTarget?.id||"new"} onBack={()=>{setVocabTarget(null);go("home");}} trackUsage={trackUsage} onSave={saveVocabDeck} targetDeck={vocabTarget}/>,
    capsules:<CapsulesScreen profile={profile} onOpen={(s)=>go(s)} onBack={()=>go("home")}/>,
    preset:<PresetLibraryScreen profile={profile} decks={decks} onBack={()=>go("home")}/>,
    guide:<GuideScreen onBack={()=>go("home")} onReplayOnboarding={()=>{setShowOnboarding(true);go("home");}} onResetTips={()=>{resetTips();showToast("Tips reset — they'll show again as you explore.","success");}}/>,
    island:<LanguageIslandScreen decks={decks} cardStates={cardStates} profile={profile} trackUsage={trackUsage} onBack={()=>go("capsules")}/>,
    dictation:<DictationScreen decks={decks} cardStates={cardStates} profile={profile} trackUsage={trackUsage} onBack={()=>go("home")} onLogStudy={logStudy} onFinish={()=>{go("home");setSessionRating({module:"writing"});}}/>,
    settings:<SettingsScreen settings={settings} setSettings={setSettings} onBack={()=>go("home")} usage={usage} user={user} onSignOut={handleSignOut} onReplayOnboarding={()=>setShowOnboarding(true)} profile={profile} setProfile={setProfile} studyLog={studyLog} onUpdateTargets={(t)=>setStudyLog(sl=>({...sl,targets:t}))} decks={decks} cardStates={cardStates} setCardStates={setCardStates} trackUsage={trackUsage} onResetUsage={resetUsageCounters}/>,
    createDeck:<CreateDeckScreen onBack={()=>go("home")} onCreate={createDeck}/>,
    addCards:activeDeck&&<AddCardsScreen deck={activeDeck} onBack={()=>go("deck")} onSave={saveCards} trackUsage={trackUsage}/>,
    deck:activeDeck&&<DeckScreen deck={activeDeck} cards={cardStates[activeDeck.id]||[]} onStartStudy={startStudy} onBack={()=>go("home")} onAddCards={()=>{if(activeDeck.deckType==="grammar"){setGrammarTarget(activeDeck);go("grammarImport");}else go("addCards");}} onImportMore={()=>{setVocabTarget(activeDeck);go("vocabImport");}} onEditCard={c=>{if(c.wordType==="grammar"){showToast("Grammar cards can't be edited yet — remove it and re-import that section.","info");return;}setActiveCard(c);go("editCard");}} onDeleteCard={deleteCard} onRenameDeck={renameDeck} onDeleteDeck={deleteDeck} onSetDeckUnit={setDeckUnit} onSetDeckLastStudied={setDeckLastStudied} savedIdx={{all:savedIdx.current[activeDeck.id+"_all"]||0,new:savedIdx.current[activeDeck.id+"_new"]||0,weak:savedIdx.current[activeDeck.id+"_weak"]||0,known:savedIdx.current[activeDeck.id+"_known"]||0,due:savedIdx.current[activeDeck.id+"_due"]||0}}/>,
    editCard:activeCard&&activeDeck&&<EditCardScreen card={activeCard} onBack={()=>go("deck")} onSave={saveEditedCard} trackUsage={trackUsage}/>,
    study:activeDeck&&sessionCards.length>0&&<StudyScreen cards={sessionCards} currentIndex={currentIdx} onSwipe={handleSwipe} onBack={undoStudy} canUndo={studyHistory.current.length>0} onExit={()=>go("deck")} trackUsage={trackUsage} decks={decks} cardStates={cardStates} onAddToFlashcard={addToFlashcard} onToggleWeakForm={(cardId,formKey)=>toggleWeakForm(activeDeck.id,cardId,formKey)}/>,
    complete:<CompleteScreen known={sessionRes.current.known} weak={sessionRes.current.weak} onBack={()=>go("deck")}/>,
    reading:<ReadingScreen {...commonProps} onBack={()=>go("home")} onFinish={()=>{saveScreen("reading",null);saveSession(null);go("home");setSessionRating({module:"reading"});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    listening:<ListeningScreen {...commonProps} onBack={()=>go("home")} onFinish={()=>{saveScreen("listening",null);saveSession(null);go("home");setSessionRating({module:"listening"});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    masterReading:<ReadingScreen {...commonProps} master={true} masterPool={masterPool} onBack={()=>go("masterReview")} onFinish={()=>{saveScreen("masterReading",null);saveSession(null);go("home");setSessionRating({module:"reading",master:true});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    masterListening:<ListeningScreen {...commonProps} master={true} masterPool={masterPool} onBack={()=>go("masterReview")} onFinish={()=>{saveScreen("masterListening",null);saveSession(null);go("home");setSessionRating({module:"listening",master:true});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    masterSpeaking:<ConversationScreen {...commonProps} master={true} masterPool={masterPool} onBack={()=>go("masterReview")} onFinish={()=>{saveScreen("masterSpeaking",null);saveSession(null);go("home");setSessionRating({module:"speaking",master:true});}} onLogStudy={logStudy} onAddToFlashcard={addToFlashcard}/>,
    conversation:<ConversationScreen {...commonProps} onBack={()=>go("home")} onFinish={()=>{saveScreen("conversation",null);saveSession(null);go("home");setSessionRating({module:"speaking"});}} onLogStudy={logStudy} onAddToFlashcard={addToFlashcard}/>,
    progress:<ProgressScreen cardStates={cardStates} studyLog={studyLog} onBack={()=>go("home")} onLogManual={(e)=>logStudy(e)}/>,
    masterReview:<MasterReviewScreen decks={decks} cardStates={cardStates} onBack={()=>go("home")} onSwipeCard={handleMasterSwipe} onUndoSwipe={restoreCard} onDeckTouched={touchDeck} onToggleWeakForm={toggleWeakForm} trackUsage={trackUsage} onAddToFlashcard={addToFlashcard} studyLog={studyLog} onLogStudy={logStudy}
      onMasterReading={(pool)=>{setMasterPool(pool);go("masterReading");}}
      onMasterListening={(pool)=>{setMasterPool(pool);go("masterListening");}}
      onMasterSpeaking={(pool)=>{setMasterPool(pool);go("masterSpeaking");}}/>,
  };

  // Show loading spinner while Firebase checks auth state
  if(user===undefined) return (
    <><style>{CSS}</style>
    <div className="app" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <RefreshCw size={24} className="spin" style={{color:"var(--accent)"}}/>
    </div></>
  );

  // Show login screen if not signed in
  if(!user) return (
    <><style>{CSS}</style>
    <div className="app"><LoginScreen onLogin={handleSignIn} loading={authLoading} error={authError}/></div></>
  );

  // Couldn't reach Firestore — show a retry instead of silently continuing
  // with empty/default local state (which the autosave effect would then
  // write over the user's real cloud data).
  if(loadError) return (
    <><style>{CSS}</style>
    <div className="app" style={{display:"flex",flexDirection:"column",gap:14,alignItems:"center",justifyContent:"center",minHeight:"100vh",padding:24,textAlign:"center"}}>
      <div style={{fontSize:14,color:"var(--text2)"}}>Couldn't load your data. Your decks are safe in the cloud — this device just couldn't reach it.</div>
      <button className="btn btn-primary" onClick={()=>setLoadRetryTick(t=>t+1)} style={{padding:"10px 18px",borderRadius:"var(--r)"}}>Retry</button>
    </div></>
  );

  // While Firestore loads or session is restoring, show spinner so we don't flash HomeScreen before resuming
  if(!dataLoaded||!sessionRestored) return (
    <><style>{CSS}</style>
    <div className="app" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh"}}>
      <RefreshCw size={24} className="spin" style={{color:"var(--accent)"}}/>
    </div></>
  );

  return (
    <><style>{CSS}</style>
      <ToastContainer/>
      {showSearch&&<GlobalSearch decks={decks} cardStates={cardStates} onClose={()=>setShowSearch(false)} onSelectCard={handleSearchSelect}/>}
      {showOnboarding&&<Onboarding onComplete={completeOnboarding} initialProfile={profile}/>}
      {sessionRating&&<SessionRating module={sessionRating.module} onSubmit={(r)=>{logStudy({type:"app",module:sessionRating.module,minutes:0,rating:r,master:sessionRating.master||false});setSessionRating(null);}} onSkip={()=>setSessionRating(null)}/>}
      <div className="app">{screens[screen]}</div>
    </>
  );
}
