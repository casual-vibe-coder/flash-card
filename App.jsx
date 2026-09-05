import { useState, useRef, useEffect, useCallback } from "react";
import { auth, googleProvider, db } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, collection, getDocs } from "firebase/firestore";
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

// A batch-heavy import (many photos in one go) means many sequential /api/claude
// calls, each individually caught per-batch — but a serverless platform-level
// failure (function timeout, gateway error) doesn't come back as JSON at all,
// it comes back as an HTML error page or empty body. Blindly calling res.json()
// on that throws a cryptic "Unexpected token < in JSON" that tells the user
// (and the warning banner they see) nothing useful about what actually
// happened. Surface the real HTTP status instead.
async function parseAIResponse(res){
  let bodyText;
  try { bodyText=await res.text(); }
  catch { throw new Error(`AI request failed (HTTP ${res.status}, couldn't read response).`); }
  let d;
  try { d=JSON.parse(bodyText); }
  catch {
    throw new Error(res.ok
      ? "AI returned an unreadable response — try again, or with fewer images at once."
      : `AI request failed (HTTP ${res.status}) — try again, or with fewer images at once.`);
  }
  return d;
}
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
    const d = await parseAIResponse(res);
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
  const d = await parseAIResponse(res);
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
// Bayna Yadayk Book 1, Part 1 — Units 1-8, transcribed from the book's own
// end-of-book "vocabulary by unit" glossary (المُفْرَدَاتُ بِحَسَبِ الوَحَدَات,
// printed pages 235-236). Bound grammatical morphemes (attached pronoun
// suffixes, bare particles like و/لـ/هل) are intentionally omitted — they
// aren't standalone flashcard-able words. `seriesId` groups these 8 for the
// "download all" bulk action in PresetLibraryScreen.
const BYY1_SERIES="byy1-part1";
// Human-readable label per seriesId for the "download all" grouped card in
// PresetLibraryScreen — keyed here (rather than inferred from deck titles)
// so future series (Book 1 Part 2, Book 2, etc.) just add one line.
const BYY1P2_SERIES="byy1-part2";
const BYY2P1_SERIES="byy2-part1";
const BYY2P2_SERIES="byy2-part2";
const BYY3P1_SERIES="byy3-part1";
const BYY3P2_SERIES="byy3-part2";
const BYY4P1_SERIES="byy4-part1";
const BYY4P2_SERIES="byy4-part2";
const SERIES_LABELS={ [BYY1_SERIES]:"Bayna Yadayk — Book 1, Part 1", [BYY1P2_SERIES]:"Bayna Yadayk — Book 1, Part 2", [BYY2P1_SERIES]:"Bayna Yadayk — Book 2, Part 1", [BYY2P2_SERIES]:"Bayna Yadayk — Book 2, Part 2", [BYY3P1_SERIES]:"Bayna Yadayk — Book 3, Part 1", [BYY3P2_SERIES]:"Bayna Yadayk — Book 3, Part 2", [BYY4P1_SERIES]:"Bayna Yadayk — Book 4, Part 1", [BYY4P2_SERIES]:"Bayna Yadayk — Book 4, Part 2" };
const PRESET_DECKS=[
  {id:"preset-byy1-u1", title:"Bayna Yadayk Book 1 · Unit 1 — Greetings & Introductions", unitId:"1-1", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Brother",arabicBase:"أَخ",forms:{singular:"أَخ",plural:"إِخْوَة"}},
     {wordType:"noun",english:"Sister",arabicBase:"أُخْت",forms:{singular:"أُخْت",plural:"أَخَوَات"}},
     {wordType:"noun",english:"Name",arabicBase:"اِسْم",forms:{singular:"اِسْم",plural:"أَسْمَاء"}},
     {wordType:"noun",english:"Nationality",arabicBase:"جِنْسِيَّة",forms:{singular:"جِنْسِيَّة",plural:"جِنْسِيَّات"}},
     {wordType:"noun",english:"Friend (male)",arabicBase:"صَدِيق",forms:{singular:"صَدِيق",plural:"أَصْدِقَاء"}},
     {wordType:"noun",english:"Friend (female)",arabicBase:"صَدِيقَة",forms:{singular:"صَدِيقَة",plural:"صَدِيقَات"}},
     {wordType:"noun",english:"Student (female)",arabicBase:"طَالِبَة",forms:{singular:"طَالِبَة",plural:"طَالِبَات"}},
     {wordType:"noun",english:"Engineer",arabicBase:"مُهَنْدِس",forms:{singular:"مُهَنْدِس",plural:"مُهَنْدِسُون"}},
     {wordType:"noun",english:"Teacher",arabicBase:"مُدَرِّس",forms:{singular:"مُدَرِّس",plural:"مُدَرِّسُون"}},
     {wordType:"noun",english:"Pakistani",arabicBase:"بَاكِسْتَانِيّ",forms:{singular:"بَاكِسْتَانِيّ"}},
     {wordType:"noun",english:"One",arabicBase:"وَاحِد",forms:{singular:"وَاحِد"}},
     {wordType:"noun",english:"Two",arabicBase:"اِثْنَان",forms:{singular:"اِثْنَان"}},
     {wordType:"noun",english:"Three",arabicBase:"ثَلَاثَة",forms:{singular:"ثَلَاثَة"}},
     {wordType:"noun",english:"Four",arabicBase:"أَرْبَعَة",forms:{singular:"أَرْبَعَة"}},
     {wordType:"noun",english:"Five",arabicBase:"خَمْسَة",forms:{singular:"خَمْسَة"}},
     {wordType:"noun",english:"I",arabicBase:"أَنَا",forms:{singular:"أَنَا"}},
     {wordType:"noun",english:"You (to a male)",arabicBase:"أَنْتَ",forms:{singular:"أَنْتَ"}},
     {wordType:"noun",english:"You (to a female)",arabicBase:"أَنْتِ",forms:{singular:"أَنْتِ"}},
     {wordType:"noun",english:"He",arabicBase:"هُوَ",forms:{singular:"هُوَ"}},
     {wordType:"noun",english:"She",arabicBase:"هِيَ",forms:{singular:"هِيَ"}},
     {wordType:"noun",english:"This (male)",arabicBase:"هَذَا",forms:{singular:"هَذَا"}},
     {wordType:"noun",english:"This (female)",arabicBase:"هَذِه",forms:{singular:"هَذِه"}},
     {wordType:"noun",english:"Welcome / hello",arabicBase:"أَهْلاً وَسَهْلاً",forms:{singular:"أَهْلاً وَسَهْلاً"}},
     {wordType:"noun",english:"Fine / well",arabicBase:"بِخَيْر",forms:{singular:"بِخَيْر"}},
     {wordType:"noun",english:"Praise be to God",arabicBase:"الحَمْدُ لله",forms:{singular:"الحَمْدُ لله"}},
     {wordType:"noun",english:"Peace be upon you",arabicBase:"السَّلَامُ عَلَيْكُم",forms:{singular:"السَّلَامُ عَلَيْكُم"}},
     {wordType:"noun",english:"And peace be upon you too",arabicBase:"وَعَلَيْكُمُ السَّلَام",forms:{singular:"وَعَلَيْكُمُ السَّلَام"}},
     {wordType:"noun",english:"How are you? (to a male)",arabicBase:"كَيْفَ حَالُكَ؟",forms:{singular:"كَيْفَ حَالُكَ؟"}},
     {wordType:"noun",english:"Goodbye",arabicBase:"مَعَ السَّلَامَة",forms:{singular:"مَعَ السَّلَامَة"}},
     {wordType:"noun",english:"From where?",arabicBase:"مِنْ أَيْنَ؟",forms:{singular:"مِنْ أَيْنَ؟"}},
     {wordType:"noun",english:"What is your name? (to a male)",arabicBase:"مَا اسْمُكَ؟",forms:{singular:"مَا اسْمُكَ؟"}},
     {wordType:"noun",english:"What is your nationality? (to a male)",arabicBase:"مَا جِنْسِيَّتُكَ؟",forms:{singular:"مَا جِنْسِيَّتُكَ؟"}},
     {wordType:"noun",english:"Yes",arabicBase:"نَعَمْ",forms:{singular:"نَعَمْ"}},
   ]},
  {id:"preset-byy1-u2", title:"Bayna Yadayk Book 1 · Unit 2 — The Family", unitId:"1-2", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Father",arabicBase:"أَب",forms:{singular:"أَب",plural:"آبَاء"}},
     {wordType:"noun",english:"Daughter",arabicBase:"اِبْنَة",forms:{singular:"اِبْنَة",plural:"بَنَات"}},
     {wordType:"noun",english:"Family",arabicBase:"أُسْرَة",forms:{singular:"أُسْرَة",plural:"أُسَر"}},
     {wordType:"noun",english:"Children / boys",arabicBase:"أَوْلَاد",forms:{singular:"أَوْلَاد"}},
     {wordType:"noun",english:"Mother",arabicBase:"أُمّ",forms:{singular:"أُمّ",plural:"أُمَّهَات"}},
     {wordType:"noun",english:"Eight",arabicBase:"ثَمَانِيَة",forms:{singular:"ثَمَانِيَة"}},
     {wordType:"noun",english:"Nine",arabicBase:"تِسْعَة",forms:{singular:"تِسْعَة"}},
     {wordType:"noun",english:"Ten",arabicBase:"عَشَرَة",forms:{singular:"عَشَرَة"}},
     {wordType:"noun",english:"Six",arabicBase:"سِتَّة",forms:{singular:"سِتَّة"}},
     {wordType:"noun",english:"Seven",arabicBase:"سَبْعَة",forms:{singular:"سَبْعَة"}},
     {wordType:"noun",english:"Grandfather",arabicBase:"جَدّ",forms:{singular:"جَدّ",plural:"أَجْدَاد"}},
     {wordType:"noun",english:"Grandmother",arabicBase:"جَدَّة",forms:{singular:"جَدَّة",plural:"جَدَّات"}},
     {wordType:"noun",english:"Bathroom",arabicBase:"حَمَّام",forms:{singular:"حَمَّام",plural:"حَمَّامَات"}},
     {wordType:"noun",english:"Paternal uncle",arabicBase:"عَمّ",forms:{singular:"عَمّ",plural:"أَعْمَام"}},
     {wordType:"noun",english:"Paternal aunt",arabicBase:"عَمَّة",forms:{singular:"عَمَّة",plural:"عَمَّات"}},
     {wordType:"noun",english:"Tree",arabicBase:"شَجَرَة",forms:{singular:"شَجَرَة",plural:"أَشْجَار"}},
     {wordType:"noun",english:"Picture",arabicBase:"صُورَة",forms:{singular:"صُورَة",plural:"صُوَر"}},
     {wordType:"noun",english:"Room",arabicBase:"غُرْفَة",forms:{singular:"غُرْفَة",plural:"غُرَف"}},
     {wordType:"noun",english:"Mosque",arabicBase:"مَسْجِد",forms:{singular:"مَسْجِد",plural:"مَسَاجِد"}},
     {wordType:"noun",english:"Prayer area (in a house)",arabicBase:"مُصَلّى",forms:{singular:"مُصَلّى"}},
     {wordType:"noun",english:"Coat",arabicBase:"مِعْطَف",forms:{singular:"مِعْطَف",plural:"مَعَاطِف"}},
     {wordType:"noun",english:"Teacher (female)",arabicBase:"مُعَلِّمَة",forms:{singular:"مُعَلِّمَة",plural:"مُعَلِّمَات"}},
     {wordType:"noun",english:"Glasses",arabicBase:"نَظَّارَة",forms:{singular:"نَظَّارَة",plural:"نَظَّارَات"}},
     {wordType:"noun",english:"Father",arabicBase:"وَالِد",forms:{singular:"وَالِد",plural:"آبَاء"}},
     {wordType:"noun",english:"Mother",arabicBase:"وَالِدَة",forms:{singular:"وَالِدَة",plural:"وَالِدَات"}},
     {wordType:"noun",english:"Call to prayer",arabicBase:"أَذَان",forms:{singular:"أَذَان"}},
     {wordType:"noun",english:"The Messenger",arabicBase:"الرَّسُول",forms:{singular:"الرَّسُول"}},
     {wordType:"noun",english:"The Qur'an",arabicBase:"القُرْآن",forms:{singular:"القُرْآن"}},
     {wordType:"noun",english:"Ablution",arabicBase:"تَوَضُّؤ",forms:{singular:"تَوَضُّؤ"}},
     {wordType:"noun",english:"Dawn / Fajr prayer time",arabicBase:"الفَجْر",forms:{singular:"الفَجْر"}},
     {wordType:"verb",english:"To pray",arabicBase:"صَلَّى",forms:{past:"صَلَّى",present:"يُصَلِّي",imperative:"صَلِّ",masdar:"صَلَاة",activePart:"مُصَلٍّ"}},
     {wordType:"verb",english:"To read / recite",arabicBase:"قَرَأَ",forms:{past:"قَرَأَ",present:"يَقْرَأُ",imperative:"اِقْرَأْ",masdar:"قِرَاءَة",activePart:"قَارِئ",passivePart:"مَقْرُوء"}},
     {wordType:"verb",english:"To perform ablution",arabicBase:"تَوَضَّأَ",forms:{past:"تَوَضَّأَ",present:"يَتَوَضَّأُ",imperative:"تَوَضَّأْ",masdar:"تَوَضُّؤ",activePart:"مُتَوَضِّئ"}},
     {wordType:"noun",english:"God is greatest",arabicBase:"اللَّهُ أَكْبَرُ",forms:{singular:"اللَّهُ أَكْبَرُ"}},
     {wordType:"noun",english:"What God has willed (expression of admiration)",arabicBase:"مَا شَاءَ اللهُ",forms:{singular:"مَا شَاءَ اللهُ"}},
     {wordType:"noun",english:"May God's peace and blessings be upon him",arabicBase:"صَلَّى اللهُ عَلَيْهِ وَسَلَّم",forms:{singular:"صَلَّى اللهُ عَلَيْهِ وَسَلَّم"}},
     {wordType:"noun",english:"Let's go / come on",arabicBase:"هَيَّا بِنَا",forms:{singular:"هَيَّا بِنَا"}},
     {wordType:"noun",english:"Where?",arabicBase:"أَيْنَ؟",forms:{singular:"أَيْنَ؟"}},
     {wordType:"noun",english:"Who?",arabicBase:"مَنْ؟",forms:{singular:"مَنْ؟"}},
   ]},
  {id:"preset-byy1-u3", title:"Bayna Yadayk Book 1 · Unit 3 — Housing", unitId:"1-3", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Furniture",arabicBase:"أَثَاث",forms:{singular:"أَثَاث"}},
     {wordType:"noun",english:"Armchair / sofa",arabicBase:"أَرِيكَة",forms:{singular:"أَرِيكَة",plural:"أَرَائِك"}},
     {wordType:"noun",english:"Seller",arabicBase:"بَائِع",forms:{singular:"بَائِع",plural:"بَاعَة"}},
     {wordType:"noun",english:"Door",arabicBase:"بَاب",forms:{singular:"بَاب",plural:"أَبْوَاب"}},
     {wordType:"noun",english:"House",arabicBase:"بَيْت",forms:{singular:"بَيْت",plural:"بُيُوت"}},
     {wordType:"noun",english:"Refrigerator",arabicBase:"ثَلَّاجَة",forms:{singular:"ثَلَّاجَة",plural:"ثَلَّاجَات"}},
     {wordType:"noun",english:"University",arabicBase:"جَامِعَة",forms:{singular:"جَامِعَة",plural:"جَامِعَات"}},
     {wordType:"noun",english:"Neighborhood",arabicBase:"حَيّ",forms:{singular:"حَيّ",plural:"أَحْيَاء"}},
     {wordType:"noun",english:"Floor (of a building)",arabicBase:"دَوْر",forms:{singular:"دَوْر",plural:"أَدْوَار"}},
     {wordType:"noun",english:"Number",arabicBase:"رَقْم",forms:{singular:"رَقْم",plural:"أَرْقَام"}},
     {wordType:"noun",english:"Curtain",arabicBase:"سِتَارَة",forms:{singular:"سِتَارَة",plural:"سَتَائِر"}},
     {wordType:"noun",english:"Carpet / rug",arabicBase:"سَجَّادَة",forms:{singular:"سَجَّادَة",plural:"سَجَاجِيد"}},
     {wordType:"noun",english:"Water heater",arabicBase:"سَخَّان",forms:{singular:"سَخَّان",plural:"سَخَّانَات"}},
     {wordType:"noun",english:"Bed",arabicBase:"سَرِير",forms:{singular:"سَرِير",plural:"أَسِرَّة"}},
     {wordType:"noun",english:"Apartment",arabicBase:"شُقَّة",forms:{singular:"شُقَّة",plural:"شُقَق"}},
     {wordType:"noun",english:"Thing",arabicBase:"شَيْء",forms:{singular:"شَيْء",plural:"أَشْيَاء"}},
     {wordType:"noun",english:"Living room",arabicBase:"غُرْفَة جُلُوس",forms:{singular:"غُرْفَة جُلُوس"}},
     {wordType:"noun",english:"Bedroom",arabicBase:"غُرْفَة نَوْم",forms:{singular:"غُرْفَة نَوْم"}},
     {wordType:"noun",english:"Oven",arabicBase:"فُرْن",forms:{singular:"فُرْن",plural:"أَفْرَان"}},
     {wordType:"noun",english:"Mirror",arabicBase:"مِرْآة",forms:{singular:"مِرْآة",plural:"مَرَايَا"}},
     {wordType:"noun",english:"Tenant",arabicBase:"مُسْتَأْجِر",forms:{singular:"مُسْتَأْجِر",plural:"مُسْتَأْجِرُون"}},
     {wordType:"noun",english:"Buyer",arabicBase:"مُشْتَرِي",forms:{singular:"مُشْتَرِي",plural:"مُشْتَرُون"}},
     {wordType:"noun",english:"Airport",arabicBase:"مَطَار",forms:{singular:"مَطَار",plural:"مَطَارَات"}},
     {wordType:"noun",english:"Kitchen",arabicBase:"مَطْبَخ",forms:{singular:"مَطْبَخ",plural:"مَطَابِخ"}},
     {wordType:"noun",english:"Monday",arabicBase:"الاثْنَيْن",forms:{singular:"الاثْنَيْن"}},
     {wordType:"noun",english:"Sunday",arabicBase:"الأَحَد",forms:{singular:"الأَحَد"}},
     {wordType:"noun",english:"Wednesday",arabicBase:"الأَرْبِعَاء",forms:{singular:"الأَرْبِعَاء"}},
     {wordType:"noun",english:"Tuesday",arabicBase:"الثُّلَاثَاء",forms:{singular:"الثُّلَاثَاء"}},
     {wordType:"noun",english:"Friday",arabicBase:"الجُمُعَة",forms:{singular:"الجُمُعَة"}},
     {wordType:"noun",english:"Thursday",arabicBase:"الخَمِيس",forms:{singular:"الخَمِيس"}},
     {wordType:"noun",english:"Saturday",arabicBase:"السَّبْت",forms:{singular:"السَّبْت"}},
     {wordType:"adjective",english:"Beautiful (female)",arabicBase:"جَمِيلَة",forms:{singular:"جَمِيلَة"}},
     {wordType:"adjective",english:"Near / close",arabicBase:"قَرِيب",forms:{singular:"قَرِيب"}},
     {wordType:"adjective",english:"Fifth",arabicBase:"خَامِس",forms:{singular:"خَامِس"}},
     {wordType:"adjective",english:"Rented",arabicBase:"مُؤَجَّر",forms:{singular:"مُؤَجَّر"}},
     {wordType:"verb",english:"To want",arabicBase:"أَرَادَ",forms:{past:"أَرَادَ",present:"يُرِيدُ",imperative:"أَرِدْ",masdar:"إِرَادَة",activePart:"مُرِيد",passivePart:"مُرَاد"}},
     {wordType:"verb",english:"To enter",arabicBase:"دَخَلَ",forms:{past:"دَخَلَ",present:"يَدْخُلُ",imperative:"اُدْخُلْ",masdar:"دُخُول",activePart:"دَاخِل"}},
     {wordType:"verb",english:"To live / reside",arabicBase:"سَكَنَ",forms:{past:"سَكَنَ",present:"يَسْكُنُ",imperative:"اُسْكُنْ",masdar:"سَكَن",activePart:"سَاكِن",harf:"فِي"}},
     {wordType:"noun",english:"How can I help you?",arabicBase:"أَيَّ خِدْمَة؟",forms:{singular:"أَيَّ خِدْمَة؟"}},
     {wordType:"noun",english:"Please, come in",arabicBase:"تَفَضَّلْ",forms:{singular:"تَفَضَّلْ"}},
     {wordType:"noun",english:"How many?",arabicBase:"كَمْ؟",forms:{singular:"كَمْ؟"}},
     {wordType:"noun",english:"What?",arabicBase:"مَاذَا؟",forms:{singular:"مَاذَا؟"}},
     {wordType:"noun",english:"Please",arabicBase:"مِنْ فَضْلِك",forms:{singular:"مِنْ فَضْلِك"}},
   ]},
  {id:"preset-byy1-u4", title:"Bayna Yadayk Book 1 · Unit 4 — Daily Life", unitId:"1-4", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Dishes / plates",arabicBase:"أَطْبَاق",forms:{singular:"أَطْبَاق"}},
     {wordType:"noun",english:"Television",arabicBase:"تِلْفَاز",forms:{singular:"تِلْفَاز"}},
     {wordType:"noun",english:"Bus",arabicBase:"حَافِلَة",forms:{singular:"حَافِلَة",plural:"حَافِلَات"}},
     {wordType:"noun",english:"Clock / hour",arabicBase:"السَّاعَة",forms:{singular:"السَّاعَة",plural:"سَاعَات"}},
     {wordType:"noun",english:"Car",arabicBase:"سَيَّارَة",forms:{singular:"سَيَّارَة",plural:"سَيَّارَات"}},
     {wordType:"noun",english:"Morning",arabicBase:"صَبَاح",forms:{singular:"صَبَاح"}},
     {wordType:"noun",english:"Newspaper",arabicBase:"صَحِيفَة",forms:{singular:"صَحِيفَة",plural:"صُحُف"}},
     {wordType:"noun",english:"The prayer",arabicBase:"الصَّلَاة",forms:{singular:"الصَّلَاة",plural:"صَلَوَات"}},
     {wordType:"noun",english:"Book",arabicBase:"كِتَاب",forms:{singular:"كِتَاب",plural:"كُتُب"}},
     {wordType:"noun",english:"School",arabicBase:"مَدْرَسَة",forms:{singular:"مَدْرَسَة",plural:"مَدَارِس"}},
     {wordType:"noun",english:"Clothes",arabicBase:"مَلَابِس",forms:{singular:"مَلَابِس"}},
     {wordType:"noun",english:"Day off / holiday",arabicBase:"يَوْمُ عُطْلَة",forms:{singular:"يَوْمُ عُطْلَة"}},
     {wordType:"noun",english:"Work day",arabicBase:"يَوْمُ عَمَل",forms:{singular:"يَوْمُ عَمَل"}},
     {wordType:"adjective",english:"Big / large",arabicBase:"كَبِير",forms:{singular:"كَبِير",plural:"كِبَار"}},
     {wordType:"adjective",english:"First",arabicBase:"أَوَّل",forms:{singular:"أَوَّل"}},
     {wordType:"adjective",english:"Second",arabicBase:"ثَانِي",forms:{singular:"ثَانِي"}},
     {wordType:"adjective",english:"Third",arabicBase:"ثَالِث",forms:{singular:"ثَالِث"}},
     {wordType:"adjective",english:"Fourth",arabicBase:"رَابِع",forms:{singular:"رَابِع"}},
     {wordType:"adjective",english:"Early",arabicBase:"مُبَكِّراً",forms:{singular:"مُبَكِّراً"}},
     {wordType:"adjective",english:"Late",arabicBase:"مُتَأَخِّراً",forms:{singular:"مُتَأَخِّراً"}},
     {wordType:"verb",english:"To wake up",arabicBase:"اسْتَيْقَظَ",forms:{past:"اسْتَيْقَظَ",present:"يَسْتَيْقِظُ",imperative:"اِسْتَيْقِظْ",masdar:"اسْتِيقَاظ",activePart:"مُسْتَيْقِظ"}},
     {wordType:"verb",english:"To go",arabicBase:"ذَهَبَ",forms:{past:"ذَهَبَ",present:"يَذْهَبُ",imperative:"اِذْهَبْ",masdar:"ذَهَاب",activePart:"ذَاهِب",harf:"إِلَى"}},
     {wordType:"verb",english:"To watch",arabicBase:"شَاهَدَ",forms:{past:"شَاهَدَ",present:"يُشَاهِدُ",imperative:"شَاهِدْ",masdar:"مُشَاهَدَة",activePart:"مُشَاهِد",passivePart:"مُشَاهَد"}},
     {wordType:"verb",english:"To wash",arabicBase:"غَسَلَ",forms:{past:"غَسَلَ",present:"يَغْسِلُ",imperative:"اِغْسِلْ",masdar:"غَسْل",activePart:"غَاسِل",passivePart:"مَغْسُول"}},
     {wordType:"verb",english:"To do",arabicBase:"فَعَلَ",forms:{past:"فَعَلَ",present:"يَفْعَلُ",imperative:"اِفْعَلْ",masdar:"فِعْل",activePart:"فَاعِل",passivePart:"مَفْعُول"}},
     {wordType:"verb",english:"To sweep",arabicBase:"كَنَسَ",forms:{past:"كَنَسَ",present:"يَكْنُسُ",imperative:"اُكْنُسْ",masdar:"كَنْس",activePart:"كَانِس",passivePart:"مَكْنُوس"}},
     {wordType:"verb",english:"To iron",arabicBase:"كَوَى",forms:{past:"كَوَى",present:"يَكْوِي",imperative:"اِكْوِ",masdar:"كَيّ",activePart:"كَاوٍ",passivePart:"مَكْوِيّ"}},
     {wordType:"verb",english:"To sleep",arabicBase:"نَامَ",forms:{past:"نَامَ",present:"يَنَامُ",imperative:"نَمْ",masdar:"نَوْم",activePart:"نَائِم"}},
     {wordType:"noun",english:"When?",arabicBase:"مَتَى؟",forms:{singular:"مَتَى؟"}},
   ]},
  {id:"preset-byy1-u5", title:"Bayna Yadayk Book 1 · Unit 5 — Food & Drink", unitId:"1-5", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Rice",arabicBase:"أَرُزّ",forms:{singular:"أَرُزّ"}},
     {wordType:"noun",english:"Dates",arabicBase:"تَمْر",forms:{singular:"تَمْر"}},
     {wordType:"noun",english:"Milk",arabicBase:"حَلِيب",forms:{singular:"حَلِيب"}},
     {wordType:"noun",english:"Bread",arabicBase:"خُبْز",forms:{singular:"خُبْز"}},
     {wordType:"noun",english:"Chicken",arabicBase:"دَجَاج",forms:{singular:"دَجَاج"}},
     {wordType:"noun",english:"Husband",arabicBase:"زَوْج",forms:{singular:"زَوْج",plural:"أَزْوَاج"}},
     {wordType:"noun",english:"Wife",arabicBase:"زَوْجَة",forms:{singular:"زَوْجَة",plural:"زَوْجَات"}},
     {wordType:"noun",english:"Salad",arabicBase:"سَلَطَة",forms:{singular:"سَلَطَة",plural:"سَلَطَات"}},
     {wordType:"noun",english:"Fish",arabicBase:"سَمَك",forms:{singular:"سَمَك"}},
     {wordType:"noun",english:"Tea",arabicBase:"شَاي",forms:{singular:"شَاي"}},
     {wordType:"noun",english:"Guests",arabicBase:"ضُيُوف",forms:{singular:"ضُيُوف"}},
     {wordType:"noun",english:"Food",arabicBase:"طَعَام",forms:{singular:"طَعَام"}},
     {wordType:"noun",english:"Dinner",arabicBase:"عَشَاء",forms:{singular:"عَشَاء"}},
     {wordType:"noun",english:"Grapes",arabicBase:"عِنَب",forms:{singular:"عِنَب"}},
     {wordType:"noun",english:"Lunch",arabicBase:"غَدَاء",forms:{singular:"غَدَاء"}},
     {wordType:"noun",english:"Fruit",arabicBase:"فَاكِهَة",forms:{singular:"فَاكِهَة",plural:"فَوَاكِه"}},
     {wordType:"noun",english:"Breakfast",arabicBase:"فُطُور",forms:{singular:"فُطُور"}},
     {wordType:"noun",english:"Coffee",arabicBase:"قَهْوَة",forms:{singular:"قَهْوَة"}},
     {wordType:"noun",english:"Meat",arabicBase:"لَحْم",forms:{singular:"لَحْم",plural:"لُحُوم"}},
     {wordType:"noun",english:"Water",arabicBase:"مَاء",forms:{singular:"مَاء"}},
     {wordType:"noun",english:"Dining table",arabicBase:"مَائِدَة",forms:{singular:"مَائِدَة",plural:"مَوَائِد"}},
     {wordType:"noun",english:"Traveler (female)",arabicBase:"مُسَافِرَة",forms:{singular:"مُسَافِرَة"}},
     {wordType:"noun",english:"Hostess / flight attendant",arabicBase:"مُضِيفَة",forms:{singular:"مُضِيفَة"}},
     {wordType:"noun",english:"Restaurant",arabicBase:"مَطْعَم",forms:{singular:"مَطْعَم",plural:"مَطَاعِم"}},
     {wordType:"noun",english:"Meal",arabicBase:"وَجْبَة",forms:{singular:"وَجْبَة",plural:"وَجَبَات"}},
     {wordType:"noun",english:"Weight",arabicBase:"وَزْن",forms:{singular:"وَزْن"}},
     {wordType:"noun",english:"Day",arabicBase:"يَوْم",forms:{singular:"يَوْم",plural:"أَيَّام"}},
     {wordType:"noun",english:"Sixty",arabicBase:"سِتُّون",forms:{singular:"سِتُّون"}},
     {wordType:"adjective",english:"Hungry",arabicBase:"جَوْعَانُ",forms:{singular:"جَوْعَانُ"}},
     {wordType:"adjective",english:"Fat / plump",arabicBase:"سَمِين",forms:{singular:"سَمِين"}},
     {wordType:"adjective",english:"Thin / slim",arabicBase:"نَحِيف",forms:{singular:"نَحِيف"}},
     {wordType:"adjective",english:"Little / few",arabicBase:"قَلِيل",forms:{singular:"قَلِيل"}},
     {wordType:"adjective",english:"Much / many",arabicBase:"كَثِير",forms:{singular:"كَثِير"}},
     {wordType:"adjective",english:"First (female)",arabicBase:"أُولَى",forms:{singular:"أُولَى"}},
     {wordType:"adjective",english:"Second (female)",arabicBase:"ثَانِيَة",forms:{singular:"ثَانِيَة"}},
     {wordType:"verb",english:"To eat",arabicBase:"أَكَلَ",forms:{past:"أَكَلَ",present:"يَأْكُلُ",imperative:"كُلْ",masdar:"أَكْل",activePart:"آكِل",passivePart:"مَأْكُول"}},
     {wordType:"verb",english:"To drink",arabicBase:"شَرِبَ",forms:{past:"شَرِبَ",present:"يَشْرَبُ",imperative:"اِشْرَبْ",masdar:"شُرْب",activePart:"شَارِب",passivePart:"مَشْرُوب"}},
     {wordType:"verb",english:"To request / order",arabicBase:"طَلَبَ",forms:{past:"طَلَبَ",present:"يَطْلُبُ",imperative:"اُطْلُبْ",masdar:"طَلَب",activePart:"طَالِب",passivePart:"مَطْلُوب",harf:"مِنْ"}},
     {wordType:"verb",english:"To prefer",arabicBase:"فَضَّلَ",forms:{past:"فَضَّلَ",present:"يُفَضِّلُ",imperative:"فَضِّلْ",masdar:"تَفْضِيل",activePart:"مُفَضِّل",passivePart:"مُفَضَّل"}},
     {wordType:"noun",english:"You're welcome / excuse me",arabicBase:"عَفْواً",forms:{singular:"عَفْواً"}},
     {wordType:"noun",english:"Why?",arabicBase:"لِمَاذَا؟",forms:{singular:"لِمَاذَا؟"}},
   ]},
  {id:"preset-byy1-u6", title:"Bayna Yadayk Book 1 · Unit 6 — Prayer (Salah)", unitId:"1-6", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Airplane",arabicBase:"طَائِرَة",forms:{singular:"طَائِرَة",plural:"طَائِرَات"}},
     {wordType:"noun",english:"Noon / Dhuhr prayer",arabicBase:"الظُّهْر",forms:{singular:"الظُّهْر"}},
     {wordType:"noun",english:"Evening / Isha prayer",arabicBase:"العِشَاء",forms:{singular:"العِشَاء"}},
     {wordType:"noun",english:"Afternoon / Asr prayer",arabicBase:"العَصْر",forms:{singular:"العَصْر"}},
     {wordType:"noun",english:"Sunset / Maghrib prayer",arabicBase:"المَغْرِب",forms:{singular:"المَغْرِب"}},
     {wordType:"noun",english:"Prayers",arabicBase:"صَلَوَات",forms:{singular:"صَلَوَات"}},
     {wordType:"noun",english:"Night",arabicBase:"لَيْل",forms:{singular:"لَيْل"}},
     {wordType:"noun",english:"Madinah, the Enlightened City",arabicBase:"المَدِينَة المُنَوَّرَة",forms:{singular:"المَدِينَة المُنَوَّرَة"}},
     {wordType:"noun",english:"The Sacred Mosque (Makkah)",arabicBase:"المَسْجِد الحَرَام",forms:{singular:"المَسْجِد الحَرَام"}},
     {wordType:"noun",english:"The Prophet's Mosque",arabicBase:"المَسْجِد النَّبَوِيّ",forms:{singular:"المَسْجِد النَّبَوِيّ"}},
     {wordType:"noun",english:"Makkah",arabicBase:"مَكَّة",forms:{singular:"مَكَّة"}},
     {wordType:"noun",english:"Alarm clock",arabicBase:"مُنَبِّه",forms:{singular:"مُنَبِّه",plural:"مُنَبِّهَات"}},
     {wordType:"noun",english:"A good idea",arabicBase:"فِكْرَة طَيِّبَة",forms:{singular:"فِكْرَة طَيِّبَة"}},
     {wordType:"adjective",english:"Far",arabicBase:"بَعِيد",forms:{singular:"بَعِيد"}},
     {wordType:"adjective",english:"Sick",arabicBase:"مَرِيض",forms:{singular:"مَرِيض"}},
     {wordType:"adjective",english:"Lazy",arabicBase:"كَسْلَانُ",forms:{singular:"كَسْلَانُ"}},
     {wordType:"adjective",english:"Correct / right",arabicBase:"صَحِيحٌ",forms:{singular:"صَحِيحٌ"}},
     {wordType:"adjective",english:"Sorry",arabicBase:"آسِفٌ",forms:{singular:"آسِفٌ"}},
     {wordType:"adjective",english:"Going (on one's way)",arabicBase:"ذَاهِبٌ",forms:{singular:"ذَاهِبٌ"}},
     {wordType:"adjective",english:"Better / best",arabicBase:"أَفْضَلُ",forms:{singular:"أَفْضَلُ"}},
     {wordType:"adjective",english:"Sixth",arabicBase:"سَادِس",forms:{singular:"سَادِس"}},
     {wordType:"adjective",english:"Seventh",arabicBase:"سَابِع",forms:{singular:"سَابِع"}},
     {wordType:"adjective",english:"Eighth",arabicBase:"ثَامِن",forms:{singular:"ثَامِن"}},
     {wordType:"adjective",english:"Ninth",arabicBase:"تَاسِع",forms:{singular:"تَاسِع"}},
     {wordType:"adjective",english:"Tenth",arabicBase:"عَاشِر",forms:{singular:"عَاشِر"}},
     {wordType:"verb",english:"To be able to",arabicBase:"اسْتَطَاعَ",forms:{past:"اسْتَطَاعَ",present:"يَسْتَطِيعُ",imperative:"اِسْتَطِعْ",masdar:"اسْتِطَاعَة",activePart:"مُسْتَطِيع"}},
     {wordType:"verb",english:"To wait",arabicBase:"انْتَظَرَ",forms:{past:"انْتَظَرَ",present:"يَنْتَظِرُ",imperative:"اِنْتَظِرْ",masdar:"انْتِظَار",activePart:"مُنْتَظِر",passivePart:"مُنْتَظَر"}},
     {wordType:"verb",english:"To hear",arabicBase:"سَمِعَ",forms:{past:"سَمِعَ",present:"يَسْمَعُ",imperative:"اِسْمَعْ",masdar:"سَمْع",activePart:"سَامِع",passivePart:"مَسْمُوع"}},
     {wordType:"verb",english:"To work / do",arabicBase:"عَمِلَ",forms:{past:"عَمِلَ",present:"يَعْمَلُ",imperative:"اِعْمَلْ",masdar:"عَمَل",activePart:"عَامِل",passivePart:"مَعْمُول",harf:"فِي"}},
     {wordType:"verb",english:"To put / place",arabicBase:"وَضَعَ",forms:{past:"وَضَعَ",present:"يَضَعُ",imperative:"ضَعْ",masdar:"وَضْع",activePart:"وَاضِع",passivePart:"مَوْضُوع"}},
     {wordType:"noun",english:"To where?",arabicBase:"إِلَى أَيْنَ؟",forms:{singular:"إِلَى أَيْنَ؟"}},
     {wordType:"noun",english:"God willing",arabicBase:"إِنْ شَاءَ الله",forms:{singular:"إِنْ شَاءَ الله"}},
     {wordType:"noun",english:"May God reward you with good",arabicBase:"جَزَاكَ اللَّهُ خَيْراً",forms:{singular:"جَزَاكَ اللَّهُ خَيْراً"}},
     {wordType:"noun",english:"Next to / beside",arabicBase:"بِجَانِب",forms:{singular:"بِجَانِب"}},
   ]},
  {id:"preset-byy1-u7", title:"Bayna Yadayk Book 1 · Unit 7 — Study", unitId:"1-7", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Exam / test",arabicBase:"اخْتِبَار",forms:{singular:"اخْتِبَار",plural:"اخْتِبَارَات"}},
     {wordType:"noun",english:"Week",arabicBase:"أُسْبُوع",forms:{singular:"أُسْبُوع",plural:"أَسَابِيع"}},
     {wordType:"noun",english:"Break / recess",arabicBase:"اسْتِرَاحَة",forms:{singular:"اسْتِرَاحَة"}},
     {wordType:"noun",english:"Month",arabicBase:"شَهْر",forms:{singular:"شَهْر",plural:"أَشْهُر"}},
     {wordType:"noun",english:"Islamic culture",arabicBase:"ثَقَافَة إِسْلَامِيَّة",forms:{singular:"ثَقَافَة إِسْلَامِيَّة"}},
     {wordType:"noun",english:"Study schedule / timetable",arabicBase:"جَدْوَلٌ دِرَاسِيّ",forms:{singular:"جَدْوَلٌ دِرَاسِيّ"}},
     {wordType:"noun",english:"Computer",arabicBase:"حَاسُوب",forms:{singular:"حَاسُوب",plural:"حَوَاسِيب"}},
     {wordType:"noun",english:"Class period / lesson",arabicBase:"حِصَّة",forms:{singular:"حِصَّة",plural:"حِصَص"}},
     {wordType:"noun",english:"Study / studying",arabicBase:"دِرَاسَة",forms:{singular:"دِرَاسَة"}},
     {wordType:"noun",english:"Ramadan",arabicBase:"رَمَضَان",forms:{singular:"رَمَضَان"}},
     {wordType:"noun",english:"Mathematics",arabicBase:"رِيَاضِيَّات",forms:{singular:"رِيَاضِيَّات"}},
     {wordType:"noun",english:"Sha'ban (month name)",arabicBase:"شَعْبَان",forms:{singular:"شَعْبَان"}},
     {wordType:"noun",english:"Classroom / grade level",arabicBase:"صَفّ دِرَاسِيّ",forms:{singular:"صَفّ دِرَاسِيّ",plural:"صُفُوف"}},
     {wordType:"noun",english:"Academic year",arabicBase:"عَامٌ دِرَاسِيّ",forms:{singular:"عَامٌ دِرَاسِيّ"}},
     {wordType:"noun",english:"Vacation / holiday",arabicBase:"عُطْلَة",forms:{singular:"عُطْلَة",plural:"عُطَل"}},
     {wordType:"noun",english:"Sciences",arabicBase:"عُلُوم",forms:{singular:"عُلُوم"}},
     {wordType:"noun",english:"College of Education",arabicBase:"كُلِّيَّةُ التَّرْبِيَة",forms:{singular:"كُلِّيَّةُ التَّرْبِيَة"}},
     {wordType:"noun",english:"College of Medicine",arabicBase:"كُلِّيَّةُ الطِّبّ",forms:{singular:"كُلِّيَّةُ الطِّبّ"}},
     {wordType:"noun",english:"Arabic language",arabicBase:"لُغَةٌ عَرَبِيَّةٌ",forms:{singular:"لُغَةٌ عَرَبِيَّةٌ"}},
     {wordType:"noun",english:"Board / panel",arabicBase:"لَوْحَة",forms:{singular:"لَوْحَة",plural:"لَوْحَات"}},
     {wordType:"noun",english:"Laboratory",arabicBase:"مُخْتَبَر",forms:{singular:"مُخْتَبَر",plural:"مُخْتَبَرَات"}},
     {wordType:"noun",english:"Teacher (female)",arabicBase:"مُدَرِّسَة",forms:{singular:"مُدَرِّسَة",plural:"مُدَرِّسَات"}},
     {wordType:"noun",english:"Teacher (male)",arabicBase:"مُعَلِّم",forms:{singular:"مُعَلِّم",plural:"مُعَلِّمُون"}},
     {wordType:"noun",english:"Library / bookstore",arabicBase:"مَكْتَبَة",forms:{singular:"مَكْتَبَة",plural:"مَكْتَبَات"}},
     {wordType:"noun",english:"Study subjects / materials",arabicBase:"مَوَادّ دِرَاسِيَّة",forms:{singular:"مَوَادّ دِرَاسِيَّة"}},
     {wordType:"noun",english:"Time",arabicBase:"وَقْت",forms:{singular:"وَقْت",plural:"أَوْقَات"}},
     {wordType:"noun",english:"School day",arabicBase:"يَوْمٌ دِرَاسِيّ",forms:{singular:"يَوْمٌ دِرَاسِيّ"}},
     {wordType:"noun",english:"Now",arabicBase:"الآنَ",forms:{singular:"الآنَ"}},
     {wordType:"adjective",english:"Long (female)",arabicBase:"طَوِيلَة",forms:{singular:"طَوِيلَة"}},
     {wordType:"verb",english:"To finish / end",arabicBase:"انْتَهَى",forms:{past:"انْتَهَى",present:"يَنْتَهِي",imperative:"اِنْتَهِ",masdar:"انْتِهَاء",activePart:"مُنْتَهٍ",harf:"مِنْ"}},
     {wordType:"verb",english:"To begin",arabicBase:"بَدَأَ",forms:{past:"بَدَأَ",present:"يَبْدَأُ",imperative:"اِبْدَأْ",masdar:"بَدْء",activePart:"بَادِئ",harf:"بِـ"}},
     {wordType:"verb",english:"To come",arabicBase:"جَاءَ",forms:{past:"جَاءَ",present:"يَجِيء",imperative:"جِئْ",masdar:"مَجِيء",activePart:"جَاءٍ"}},
     {wordType:"verb",english:"To study",arabicBase:"دَرَسَ",forms:{past:"دَرَسَ",present:"يَدْرُسُ",imperative:"اُدْرُسْ",masdar:"دِرَاسَة",activePart:"دَارِس",passivePart:"مَدْرُوس",harf:"فِي"}},
     {wordType:"verb",english:"To be",arabicBase:"كَانَ",forms:{past:"كَانَ",present:"يَكُونُ",imperative:"كُنْ",masdar:"كَوْن",activePart:"كَائِن"}},
     {wordType:"verb",english:"To write",arabicBase:"كَتَبَ",forms:{past:"كَتَبَ",present:"يَكْتُبُ",imperative:"اُكْتُبْ",masdar:"كِتَابَة",activePart:"كَاتِب",passivePart:"مَكْتُوب"}},
     {wordType:"verb",english:"To look",arabicBase:"نَظَرَ",forms:{past:"نَظَرَ",present:"يَنْظُرُ",imperative:"اُنْظُرْ",masdar:"نَظَر",activePart:"نَاظِر",harf:"إِلَى"}},
   ]},
  {id:"preset-byy1-u8", title:"Bayna Yadayk Book 1 · Unit 8 — Work", unitId:"1-8", level:"book1", seriesId:BYY1_SERIES,
   cards:[
     {wordType:"noun",english:"Child",arabicBase:"طِفْل",forms:{singular:"طِفْل",plural:"أَطْفَال"}},
     {wordType:"noun",english:"Nursing (the field)",arabicBase:"تَمْرِيض",forms:{singular:"تَمْرِيض"}},
     {wordType:"noun",english:"Clock / watch",arabicBase:"سَاعَة",forms:{singular:"سَاعَة",plural:"سَاعَات"}},
     {wordType:"noun",english:"Tourism",arabicBase:"سِيَاحَة",forms:{singular:"سِيَاحَة"}},
     {wordType:"noun",english:"Company",arabicBase:"شَرِكَة",forms:{singular:"شَرِكَة",plural:"شَرِكَات"}},
     {wordType:"noun",english:"Pharmacist",arabicBase:"صَيْدَلِيّ",forms:{singular:"صَيْدَلِيّ",plural:"صَيَادِلَة"}},
     {wordType:"noun",english:"Pharmacy (the field)",arabicBase:"صَيْدَلَة",forms:{singular:"صَيْدَلَة"}},
     {wordType:"noun",english:"Doctor",arabicBase:"طَبِيب",forms:{singular:"طَبِيب",plural:"أَطِبَّاء"}},
     {wordType:"noun",english:"Medicine (the field)",arabicBase:"طِبّ",forms:{singular:"طِبّ"}},
     {wordType:"noun",english:"Students",arabicBase:"طُلَّاب",forms:{singular:"طُلَّاب"}},
     {wordType:"noun",english:"Pilot",arabicBase:"طَيَّار",forms:{singular:"طَيَّار",plural:"طَيَّارُون"}},
     {wordType:"noun",english:"Aviation (the field)",arabicBase:"طَيَرَان",forms:{singular:"طَيَرَان"}},
     {wordType:"noun",english:"Work / job",arabicBase:"عَمَل",forms:{singular:"عَمَل",plural:"أَعْمَال"}},
     {wordType:"noun",english:"College of Nursing",arabicBase:"كُلِّيَّةُ التَّمْرِيض",forms:{singular:"كُلِّيَّةُ التَّمْرِيض"}},
     {wordType:"noun",english:"College of Pharmacy",arabicBase:"كُلِّيَّةُ الصَّيْدَلَة",forms:{singular:"كُلِّيَّةُ الصَّيْدَلَة"}},
     {wordType:"noun",english:"College of Aviation",arabicBase:"كُلِّيَّةُ الطَّيَرَان",forms:{singular:"كُلِّيَّةُ الطَّيَرَان"}},
     {wordType:"noun",english:"College of Engineering",arabicBase:"كُلِّيَّةُ الهَنْدَسَة",forms:{singular:"كُلِّيَّةُ الهَنْدَسَة"}},
     {wordType:"noun",english:"Primary / elementary stage",arabicBase:"مَرْحَلَة ابْتِدَائِيَّة",forms:{singular:"مَرْحَلَة ابْتِدَائِيَّة"}},
     {wordType:"noun",english:"Middle / intermediate stage",arabicBase:"مَرْحَلَة مُتَوَسِّطَة",forms:{singular:"مَرْحَلَة مُتَوَسِّطَة"}},
     {wordType:"noun",english:"Hospital",arabicBase:"مُسْتَشْفى",forms:{singular:"مُسْتَشْفى",plural:"مُسْتَشْفَيَات"}},
     {wordType:"noun",english:"Nurse (male)",arabicBase:"مُمَرِّض",forms:{singular:"مُمَرِّض",plural:"مُمَرِّضُون"}},
     {wordType:"noun",english:"Profession",arabicBase:"مِهْنَة",forms:{singular:"مِهْنَة",plural:"مِهَن"}},
     {wordType:"noun",english:"Engineering (the field)",arabicBase:"هَنْدَسَة",forms:{singular:"هَنْدَسَة"}},
     {wordType:"noun",english:"Eleven (female)",arabicBase:"حَادِيَة عَشْرَة",forms:{singular:"حَادِيَة عَشْرَة"}},
     {wordType:"verb",english:"To love / like",arabicBase:"أَحَبَّ",forms:{past:"أَحَبَّ",present:"يُحِبُّ",imperative:"أَحِبَّ",masdar:"حُبّ",activePart:"مُحِبّ",passivePart:"مُحَبّ"}},
     {wordType:"verb",english:"To teach",arabicBase:"دَرَّسَ",forms:{past:"دَرَّسَ",present:"يُدَرِّسُ",imperative:"دَرِّسْ",masdar:"تَدْرِيس",activePart:"مُدَرِّس",passivePart:"مُدَرَّس"}},
     {wordType:"verb",english:"To help",arabicBase:"سَاعَدَ",forms:{past:"سَاعَدَ",present:"يُسَاعِدُ",imperative:"سَاعِدْ",masdar:"مُسَاعَدَة",activePart:"مُسَاعِد",passivePart:"مُسَاعَد"}},
     {wordType:"verb",english:"To travel",arabicBase:"سَافَرَ",forms:{past:"سَافَرَ",present:"يُسَافِرُ",imperative:"سَافِرْ",masdar:"سَفَر",activePart:"مُسَافِر",harf:"إِلَى"}},
   ]},
  {id:"preset-byy1-u9", title:"Bayna Yadayk Book 1 · Unit 9 — Shopping", unitId:"1-9", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"adjective",english:"Red",arabicBase:"أَحْمَر",forms:{singular:"أَحْمَر",feminine:"حَمْرَاء",plural:"حُمْر"}},
     {wordType:"adjective",english:"Green",arabicBase:"أَخْضَر",forms:{singular:"أَخْضَر",feminine:"خَضْرَاء",plural:"خُضْر"}},
     {wordType:"adjective",english:"Blue",arabicBase:"أَزْرَق",forms:{singular:"أَزْرَق",feminine:"زَرْقَاء",plural:"زُرْق"}},
     {wordType:"adjective",english:"Black",arabicBase:"أَسْوَد",forms:{singular:"أَسْوَد",feminine:"سَوْدَاء",plural:"سُود"}},
     {wordType:"adjective",english:"Yellow",arabicBase:"أَصْفَر",forms:{singular:"أَصْفَر",feminine:"صَفْرَاء",plural:"صُفْر"}},
     {wordType:"adjective",english:"White",arabicBase:"أَبْيَض",forms:{singular:"أَبْيَض",feminine:"بَيْضَاء",plural:"بِيض"}},
     {wordType:"noun",english:"Onion",arabicBase:"بَصَل",forms:{singular:"بَصَل"}},
     {wordType:"noun",english:"Coffee beans",arabicBase:"بُنّ",forms:{singular:"بُنّ"}},
     {wordType:"noun",english:"Eggs",arabicBase:"بَيْض",forms:{singular:"بَيْض"}},
     {wordType:"noun",english:"Garment",arabicBase:"ثَوْب",forms:{singular:"ثَوْب",plural:"أَثْوَاب"}},
     {wordType:"noun",english:"Cucumber",arabicBase:"خِيَار",forms:{singular:"خِيَار"}},
     {wordType:"noun",english:"Notebook",arabicBase:"دَفْتَر",forms:{singular:"دَفْتَر",plural:"دَفَاتِر"}},
     {wordType:"noun",english:"Dinar (currency)",arabicBase:"دِينَار",forms:{singular:"دِينَار",plural:"دَنَانِير"}},
     {wordType:"noun",english:"Riyal (currency)",arabicBase:"رِيَال",forms:{singular:"رِيَال",plural:"رِيَالَات"}},
     {wordType:"noun",english:"Sugar",arabicBase:"سُكَّر",forms:{singular:"سُكَّر"}},
     {wordType:"noun",english:"Tomatoes",arabicBase:"طَمَاطِم",forms:{singular:"طَمَاطِم"}},
     {wordType:"noun",english:"Fabric",arabicBase:"قُمَاش",forms:{singular:"قُمَاش",plural:"أَقْمِشَة"}},
     {wordType:"noun",english:"Shirt",arabicBase:"قَمِيص",forms:{singular:"قَمِيص",plural:"قُمْصَان"}},
     {wordType:"noun",english:"Salt",arabicBase:"مِلْح",forms:{singular:"مِلْح"}},
     {wordType:"noun",english:"Dictionary",arabicBase:"مُعْجَم",forms:{singular:"مُعْجَم",plural:"مَعَاجِم"}},
     {wordType:"noun",english:"Woman",arabicBase:"اِمْرَأَة",forms:{singular:"اِمْرَأَة",plural:"نِسَاء"}},
     {wordType:"noun",english:"How much?",arabicBase:"بِكَمْ؟",forms:{singular:"بِكَمْ؟"}},
     {wordType:"noun",english:"Please / if you would",arabicBase:"لَوْ سَمَحْتَ",forms:{singular:"لَوْ سَمَحْتَ"}},
     {wordType:"noun",english:"Thirty",arabicBase:"ثَلَاثُون",forms:{singular:"ثَلَاثُون"}},
     {wordType:"noun",english:"Fifty",arabicBase:"خَمْسُون",forms:{singular:"خَمْسُون"}},
     {wordType:"noun",english:"Apple",arabicBase:"تُفَّاحَة",forms:{singular:"تُفَّاحَة",plural:"تُفَّاح"}},
     {wordType:"noun",english:"Banana",arabicBase:"مَوْز",forms:{singular:"مَوْز"}},
     {wordType:"noun",english:"Orange (fruit)",arabicBase:"بُرْتُقَال",forms:{singular:"بُرْتُقَال"}},
     {wordType:"noun",english:"Grapes",arabicBase:"عِنَب",forms:{singular:"عِنَب"}},
     {wordType:"noun",english:"Potato",arabicBase:"بَطَاطِس",forms:{singular:"بَطَاطِس"}},
     {wordType:"noun",english:"Garlic",arabicBase:"ثُوم",forms:{singular:"ثُوم"}},
     {wordType:"verb",english:"To buy",arabicBase:"اِشْتَرَى",forms:{past:"اِشْتَرَى",present:"يَشْتَرِي",imperative:"اِشْتَرِ",masdar:"شِرَاء",activePart:"مُشْتَرٍ",passivePart:"مُشْتَرًى"}},
   ]},
  {id:"preset-byy1-u10", title:"Bayna Yadayk Book 1 · Unit 10 — Weather", unitId:"1-10", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"In front of",arabicBase:"أَمَام",forms:{singular:"أَمَام"}},
     {wordType:"noun",english:"The countryside / open land",arabicBase:"البَرّ",forms:{singular:"البَرّ"}},
     {wordType:"noun",english:"Under",arabicBase:"تَحْت",forms:{singular:"تَحْت"}},
     {wordType:"noun",english:"Behind",arabicBase:"خَلْف",forms:{singular:"خَلْف"}},
     {wordType:"noun",english:"Tent",arabicBase:"خَيْمَة",forms:{singular:"خَيْمَة",plural:"خِيَام"}},
     {wordType:"noun",english:"Outside",arabicBase:"خَارِج",forms:{singular:"خَارِج"}},
     {wordType:"noun",english:"Temperature",arabicBase:"دَرَجَةُ الحَرَارَة",forms:{singular:"دَرَجَةُ الحَرَارَة"}},
     {wordType:"noun",english:"Sky",arabicBase:"سَمَاء",forms:{singular:"سَمَاء",plural:"سَمَاوَات"}},
     {wordType:"noun",english:"Winter",arabicBase:"شِتَاء",forms:{singular:"شِتَاء"}},
     {wordType:"noun",english:"Beach",arabicBase:"شَاطِئ",forms:{singular:"شَاطِئ",plural:"شَوَاطِئ"}},
     {wordType:"noun",english:"North",arabicBase:"شَمَال",forms:{singular:"شَمَال"}},
     {wordType:"noun",english:"Zero",arabicBase:"صِفْر",forms:{singular:"صِفْر"}},
     {wordType:"noun",english:"Autumn season",arabicBase:"فَصْل الخَرِيف",forms:{singular:"فَصْل الخَرِيف"}},
     {wordType:"noun",english:"Tomorrow",arabicBase:"غَداً",forms:{singular:"غَداً"}},
     {wordType:"noun",english:"Spring season",arabicBase:"فَصْل الرَّبِيع",forms:{singular:"فَصْل الرَّبِيع"}},
     {wordType:"noun",english:"Winter season",arabicBase:"فَصْل الشِّتَاء",forms:{singular:"فَصْل الشِّتَاء"}},
     {wordType:"noun",english:"Above",arabicBase:"فَوْق",forms:{singular:"فَوْق"}},
     {wordType:"noun",english:"Night",arabicBase:"لَيْلَة",forms:{singular:"لَيْلَة",plural:"لَيَالٍ"}},
     {wordType:"noun",english:"Right (direction)",arabicBase:"يَمِين",forms:{singular:"يَمِين"}},
     {wordType:"noun",english:"Moonlit",arabicBase:"مُقْمِر",forms:{singular:"مُقْمِر"}},
     {wordType:"noun",english:"Sunny",arabicBase:"مُشْمِس",forms:{singular:"مُشْمِس"}},
     {wordType:"noun",english:"Winds",arabicBase:"رِيَاح",forms:{singular:"رِيَاح"}},
     {wordType:"noun",english:"Clouds",arabicBase:"غُيُوم",forms:{singular:"غُيُوم"}},
     {wordType:"noun",english:"Thunder",arabicBase:"رَعْد",forms:{singular:"رَعْد"}},
     {wordType:"noun",english:"Lightning",arabicBase:"بَرْق",forms:{singular:"بَرْق"}},
     {wordType:"noun",english:"Ice",arabicBase:"جَلِيد",forms:{singular:"جَلِيد"}},
     {wordType:"noun",english:"Fog",arabicBase:"ضَبَاب",forms:{singular:"ضَبَاب"}},
     {wordType:"adjective",english:"Cold",arabicBase:"بَارِد",forms:{singular:"بَارِد",feminine:"بَارِدَة"}},
     {wordType:"adjective",english:"Warm",arabicBase:"دَافِئ",forms:{singular:"دَافِئ",feminine:"دَافِئَة"}},
     {wordType:"adjective",english:"Moderate / mild",arabicBase:"مُعْتَدِل",forms:{singular:"مُعْتَدِل",feminine:"مُعْتَدِلَة"}},
     {wordType:"verb",english:"To bring",arabicBase:"أَحْضَرَ",forms:{past:"أَحْضَرَ",present:"يُحْضِرُ",imperative:"أَحْضِرْ",masdar:"إِحْضَار",activePart:"مُحْضِر",passivePart:"مُحْضَر"}},
     {wordType:"verb",english:"To become cold",arabicBase:"بَرَدَ",forms:{past:"بَرَدَ",present:"يَبْرُدُ",imperative:"اُبْرُدْ",masdar:"بُرُودَة",activePart:"بَارِد"}},
     {wordType:"verb",english:"To remain / stay",arabicBase:"بَقِيَ",forms:{past:"بَقِيَ",present:"يَبْقَى",imperative:"اِبْقَ",masdar:"بَقَاء",activePart:"بَاقٍ"}},
     {wordType:"verb",english:"To spend (time)",arabicBase:"قَضَى",forms:{past:"قَضَى",present:"يَقْضِي",imperative:"اِقْضِ",masdar:"قَضَاء",activePart:"قَاضٍ",passivePart:"مَقْضِيّ"}},
   ]},
  {id:"preset-byy1-u11", title:"Bayna Yadayk Book 1 · Unit 11 — People & Places", unitId:"1-11", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"Crowding / congestion",arabicBase:"اِزْدِحَام",forms:{singular:"اِزْدِحَام"}},
     {wordType:"noun",english:"Professor",arabicBase:"أُسْتَاذ",forms:{singular:"أُسْتَاذ",plural:"أَسَاتِذَة"}},
     {wordType:"noun",english:"Sea",arabicBase:"بَحْر",forms:{singular:"بَحْر",plural:"بِحَار"}},
     {wordType:"noun",english:"Passport",arabicBase:"جَوَاز سَفَر",forms:{singular:"جَوَاز سَفَر"}},
     {wordType:"noun",english:"Opinion",arabicBase:"رَأْي",forms:{singular:"رَأْي",plural:"آرَاء"}},
     {wordType:"noun",english:"Trip",arabicBase:"رِحْلَة",forms:{singular:"رِحْلَة",plural:"رِحَلَات"}},
     {wordType:"noun",english:"Year",arabicBase:"سَنَة",forms:{singular:"سَنَة",plural:"سَنَوَات"}},
     {wordType:"noun",english:"Village",arabicBase:"قَرْيَة",forms:{singular:"قَرْيَة",plural:"قُرَى"}},
     {wordType:"noun",english:"Train",arabicBase:"قِطَار",forms:{singular:"قِطَار",plural:"قِطَارَات"}},
     {wordType:"noun",english:"What is your opinion?",arabicBase:"مَا رَأْيُكَ؟",forms:{singular:"مَا رَأْيُكَ؟"}},
     {wordType:"noun",english:"City",arabicBase:"مَدِينَة",forms:{singular:"مَدِينَة",plural:"مُدُن"}},
     {wordType:"noun",english:"Manager / director",arabicBase:"مُدِير",forms:{singular:"مُدِير",plural:"مُدَرَاء"}},
     {wordType:"noun",english:"Problem",arabicBase:"مُشْكِلَة",forms:{singular:"مُشْكِلَة",plural:"مَشَاكِل"}},
     {wordType:"noun",english:"Half",arabicBase:"نِصْف",forms:{singular:"نِصْف"}},
     {wordType:"noun",english:"There",arabicBase:"هُنَاك",forms:{singular:"هُنَاك"}},
     {wordType:"noun",english:"Air",arabicBase:"هَوَاء",forms:{singular:"هَوَاء"}},
     {wordType:"adjective",english:"Quiet / calm",arabicBase:"هَادِئ",forms:{singular:"هَادِئ",feminine:"هَادِئَة"}},
     {wordType:"verb",english:"To take (time/effort)",arabicBase:"اِسْتَغْرَقَ",forms:{past:"اِسْتَغْرَقَ",present:"يَسْتَغْرِقُ",imperative:"اِسْتَغْرِقْ",masdar:"اِسْتِغْرَاق",activePart:"مُسْتَغْرِق"}},
     {wordType:"verb",english:"To marry",arabicBase:"تَزَوَّجَ",forms:{past:"تَزَوَّجَ",present:"يَتَزَوَّجُ",imperative:"تَزَوَّجْ",masdar:"تَزَوُّج",activePart:"مُتَزَوِّج"}},
     {wordType:"verb",english:"To visit",arabicBase:"زَارَ",forms:{past:"زَارَ",present:"يَزُورُ",imperative:"زُرْ",masdar:"زِيَارَة",activePart:"زَائِر",passivePart:"مَزُور"}},
   ]},
  {id:"preset-byy1-u12", title:"Bayna Yadayk Book 1 · Unit 12 — Hobbies", unitId:"1-12", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"Verse (of the Qur'an)",arabicBase:"آيَة",forms:{singular:"آيَة",plural:"آيَات"}},
     {wordType:"noun",english:"Ticket",arabicBase:"تَذْكِرَة",forms:{singular:"تَذْكِرَة",plural:"تَذَاكِر"}},
     {wordType:"noun",english:"All / all of",arabicBase:"جَمِيع",forms:{singular:"جَمِيع"}},
     {wordType:"noun",english:"Section / wing",arabicBase:"جَنَاح",forms:{singular:"جَنَاح",plural:"أَجْنِحَة"}},
     {wordType:"noun",english:"Computer",arabicBase:"حَاسُوب",forms:{singular:"حَاسُوب",plural:"حَوَاسِيب"}},
     {wordType:"noun",english:"Sewing",arabicBase:"خِيَاطَة",forms:{singular:"خِيَاطَة"}},
     {wordType:"noun",english:"Mathematics",arabicBase:"رِيَاضِيَّات",forms:{singular:"رِيَاضِيَّات"}},
     {wordType:"noun",english:"Sport",arabicBase:"رِيَاضَة",forms:{singular:"رِيَاضَة",plural:"رِيَاضَات"}},
     {wordType:"noun",english:"Swimming",arabicBase:"سِبَاحَة",forms:{singular:"سِبَاحَة"}},
     {wordType:"noun",english:"Journalism",arabicBase:"صِحَافَة",forms:{singular:"صِحَافَة"}},
     {wordType:"noun",english:"Newspaper",arabicBase:"صَحِيفَة",forms:{singular:"صَحِيفَة",plural:"صُحُف"}},
     {wordType:"noun",english:"Postage stamp",arabicBase:"طَابِع",forms:{singular:"طَابِع",plural:"طَوَابِع"}},
     {wordType:"noun",english:"Cooking",arabicBase:"طَبْخ",forms:{singular:"طَبْخ"}},
     {wordType:"noun",english:"Sciences",arabicBase:"عُلُوم",forms:{singular:"عُلُوم"}},
     {wordType:"noun",english:"Horsemanship",arabicBase:"فُرُوسِيَّة",forms:{singular:"فُرُوسِيَّة"}},
     {wordType:"noun",english:"Reading",arabicBase:"قِرَاءَة",forms:{singular:"قِرَاءَة"}},
     {wordType:"noun",english:"Football / soccer",arabicBase:"كُرَةُ القَدَم",forms:{singular:"كُرَةُ القَدَم"}},
     {wordType:"noun",english:"Word",arabicBase:"كَلِمَة",forms:{singular:"كَلِمَة",plural:"كَلِمَات"}},
     {wordType:"noun",english:"Language",arabicBase:"لُغَة",forms:{singular:"لُغَة",plural:"لُغَات"}},
     {wordType:"noun",english:"Magazine",arabicBase:"مَجَلَّة",forms:{singular:"مَجَلَّة",plural:"مَجَلَّات"}},
     {wordType:"noun",english:"Exhibition",arabicBase:"مَعْرِض",forms:{singular:"مَعْرِض",plural:"مَعَارِض"}},
     {wordType:"noun",english:"Hobby",arabicBase:"هِوَايَة",forms:{singular:"هِوَايَة",plural:"هِوَايَات"}},
     {wordType:"adjective",english:"Correct",arabicBase:"صَحِيح",forms:{singular:"صَحِيح",feminine:"صَحِيحَة"}},
     {wordType:"adjective",english:"Short",arabicBase:"قَصِير",forms:{singular:"قَصِير",feminine:"قَصِيرَة"}},
     {wordType:"adjective",english:"Lazy",arabicBase:"كَسْلَان",forms:{singular:"كَسْلَان",feminine:"كَسْلَى"}},
     {wordType:"adjective",english:"Useful",arabicBase:"مُفِيد",forms:{singular:"مُفِيد",feminine:"مُفِيدَة"}},
     {wordType:"verb",english:"To choose",arabicBase:"اِخْتَارَ",forms:{past:"اِخْتَارَ",present:"يَخْتَارُ",imperative:"اِخْتَرْ",masdar:"اِخْتِيَار",activePart:"مُخْتَار",passivePart:"مُخْتَار"}},
   ]},
  {id:"preset-byy1-u13", title:"Bayna Yadayk Book 1 · Unit 13 — Travel", unitId:"1-13", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"Week",arabicBase:"أُسْبُوع",forms:{singular:"أُسْبُوع",plural:"أَسَابِيع"}},
     {wordType:"noun",english:"A pleasant stay",arabicBase:"إِقَامَة طَيِّبَة",forms:{singular:"إِقَامَة طَيِّبَة"}},
     {wordType:"noun",english:"Exit visa",arabicBase:"تَأْشِيرَةُ خُرُوج",forms:{singular:"تَأْشِيرَةُ خُرُوج"}},
     {wordType:"noun",english:"Entry visa",arabicBase:"تَأْشِيرَةُ دُخُول",forms:{singular:"تَأْشِيرَةُ دُخُول"}},
     {wordType:"noun",english:"Booking confirmation",arabicBase:"تَأْكِيدُ حَجْز",forms:{singular:"تَأْكِيدُ حَجْز"}},
     {wordType:"noun",english:"South",arabicBase:"جَنُوب",forms:{singular:"جَنُوب"}},
     {wordType:"noun",english:"Bag / suitcase",arabicBase:"حَقِيبَة",forms:{singular:"حَقِيبَة",plural:"حَقَائِب"}},
     {wordType:"noun",english:"Airlines",arabicBase:"خُطُوط طَيَران",forms:{singular:"خُطُوط طَيَران"}},
     {wordType:"noun",english:"Happy journey",arabicBase:"رِحْلَةٌ سَعِيدَة",forms:{singular:"رِحْلَةٌ سَعِيدَة"}},
     {wordType:"noun",english:"East",arabicBase:"شَرْق",forms:{singular:"شَرْق"}},
     {wordType:"noun",english:"Officer",arabicBase:"ضَابِط",forms:{singular:"ضَابِط",plural:"ضُبَّاط"}},
     {wordType:"noun",english:"West",arabicBase:"غَرْب",forms:{singular:"غَرْب"}},
     {wordType:"noun",english:"Hotel",arabicBase:"فُنْدُق",forms:{singular:"فُنْدُق",plural:"فَنَادِق"}},
     {wordType:"noun",english:"Employee",arabicBase:"مُوَظَّف",forms:{singular:"مُوَظَّف",plural:"مُوَظَّفُون"}},
     {wordType:"noun",english:"Boat",arabicBase:"مَرْكَب",forms:{singular:"مَرْكَب",plural:"مَرَاكِب"}},
     {wordType:"noun",english:"Ship",arabicBase:"سَفِينَة",forms:{singular:"سَفِينَة",plural:"سُفُن"}},
     {wordType:"noun",english:"Customs",arabicBase:"جَمَارِك",forms:{singular:"جَمَارِك"}},
     {wordType:"noun",english:"Money",arabicBase:"نُقُود",forms:{singular:"نُقُود"}},
     {wordType:"noun",english:"Bicycle",arabicBase:"دَرَّاجَة",forms:{singular:"دَرَّاجَة",plural:"دَرَّاجَات"}},
     {wordType:"noun",english:"Wallet",arabicBase:"مِحْفَظَة",forms:{singular:"مِحْفَظَة",plural:"مَحَافِظ"}},
     {wordType:"noun",english:"Landing (aviation)",arabicBase:"هُبُوط",forms:{singular:"هُبُوط"}},
     {wordType:"noun",english:"Takeoff (aviation)",arabicBase:"إِقْلَاع",forms:{singular:"إِقْلَاع"}},
     {wordType:"noun",english:"Taxi",arabicBase:"سَيَّارَة أُجْرَة",forms:{singular:"سَيَّارَة أُجْرَة"}},
     {wordType:"noun",english:"Station",arabicBase:"مَحَطَّة",forms:{singular:"مَحَطَّة",plural:"مَحَطَّات"}},
     {wordType:"adjective",english:"Coming / arriving",arabicBase:"قَادِم",forms:{singular:"قَادِم",feminine:"قَادِمَة"}},
     {wordType:"verb",english:"To reside / stay",arabicBase:"أَقَامَ",forms:{past:"أَقَامَ",present:"يُقِيمُ",imperative:"أَقِمْ",masdar:"إِقَامَة",activePart:"مُقِيم"}},
     {wordType:"verb",english:"To depart",arabicBase:"غَادَرَ",forms:{past:"غَادَرَ",present:"يُغَادِرُ",imperative:"غَادِرْ",masdar:"مُغَادَرَة",activePart:"مُغَادِر"}},
     {wordType:"verb",english:"To open",arabicBase:"فَتَحَ",forms:{past:"فَتَحَ",present:"يَفْتَحُ",imperative:"اِفْتَحْ",masdar:"فَتْح",activePart:"فَاتِح",passivePart:"مَفْتُوح"}},
     {wordType:"verb",english:"To lose",arabicBase:"فَقَدَ",forms:{past:"فَقَدَ",present:"يَفْقِدُ",imperative:"اِفْقِدْ",masdar:"فَقْد",activePart:"فَاقِد",passivePart:"مَفْقُود"}},
     {wordType:"verb",english:"To arrive",arabicBase:"وَصَلَ",forms:{past:"وَصَلَ",present:"يَصِلُ",imperative:"صِلْ",masdar:"وُصُول",activePart:"وَاصِل"}},
   ]},
  {id:"preset-byy1-u14", title:"Bayna Yadayk Book 1 · Unit 14 — Hajj & Umrah", unitId:"1-14", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"Eleven",arabicBase:"أَحَدَ عَشَر",forms:{singular:"أَحَدَ عَشَر"}},
     {wordType:"noun",english:"Twelve",arabicBase:"اِثْنَا عَشَر",forms:{singular:"اِثْنَا عَشَر"}},
     {wordType:"noun",english:"Thirteen",arabicBase:"ثَلَاثَةَ عَشَر",forms:{singular:"ثَلَاثَةَ عَشَر"}},
     {wordType:"noun",english:"Fourteen",arabicBase:"أَرْبَعَةَ عَشَر",forms:{singular:"أَرْبَعَةَ عَشَر"}},
     {wordType:"noun",english:"Fifteen",arabicBase:"خَمْسَةَ عَشَر",forms:{singular:"خَمْسَةَ عَشَر"}},
     {wordType:"noun",english:"Sixteen",arabicBase:"سِتَّةَ عَشَر",forms:{singular:"سِتَّةَ عَشَر"}},
     {wordType:"noun",english:"Seventeen",arabicBase:"سَبْعَةَ عَشَر",forms:{singular:"سَبْعَةَ عَشَر"}},
     {wordType:"noun",english:"Eighteen",arabicBase:"ثَمَانِيَةَ عَشَر",forms:{singular:"ثَمَانِيَةَ عَشَر"}},
     {wordType:"noun",english:"Nineteen",arabicBase:"تِسْعَةَ عَشَر",forms:{singular:"تِسْعَةَ عَشَر"}},
     {wordType:"noun",english:"Circuits (of Tawaf)",arabicBase:"أَشْوَاط",forms:{singular:"أَشْوَاط"}},
     {wordType:"noun",english:"Ihram garment",arabicBase:"ثَوْبُ الإِحْرَام",forms:{singular:"ثَوْبُ الإِحْرَام"}},
     {wordType:"noun",english:"The Greater Jamarah",arabicBase:"الجَمْرَةُ الكُبْرَى",forms:{singular:"الجَمْرَةُ الكُبْرَى"}},
     {wordType:"noun",english:"Midday / zenith",arabicBase:"الزَّوَال",forms:{singular:"الزَّوَال"}},
     {wordType:"noun",english:"Joy / happiness",arabicBase:"سُرُور",forms:{singular:"سُرُور"}},
     {wordType:"noun",english:"Sun",arabicBase:"شَمْس",forms:{singular:"شَمْس"}},
     {wordType:"noun",english:"Tawaf al-Ifadah",arabicBase:"طَوَافُ الإِفَاضَة",forms:{singular:"طَوَافُ الإِفَاضَة"}},
     {wordType:"noun",english:"Farewell Tawaf",arabicBase:"طَوَافُ الوَدَاع",forms:{singular:"طَوَافُ الوَدَاع"}},
     {wordType:"noun",english:"Arafat",arabicBase:"عَرَفَات",forms:{singular:"عَرَفَات"}},
     {wordType:"noun",english:"Eid / festival",arabicBase:"عِيد",forms:{singular:"عِيد",plural:"أَعْيَاد"}},
     {wordType:"noun",english:"Shortening (of prayer)",arabicBase:"قَصْر",forms:{singular:"قَصْر"}},
     {wordType:"noun",english:"The Kaaba",arabicBase:"الكَعْبَة",forms:{singular:"الكَعْبَة"}},
     {wordType:"noun",english:"Muzdalifah",arabicBase:"مُزْدَلِفَة",forms:{singular:"مُزْدَلِفَة"}},
     {wordType:"noun",english:"Station of Ibrahim",arabicBase:"مَقَامُ إِبْرَاهِيم",forms:{singular:"مَقَامُ إِبْرَاهِيم"}},
     {wordType:"noun",english:"Mina",arabicBase:"مِنَى",forms:{singular:"مِنَى"}},
     {wordType:"noun",english:"Sacrificial animal",arabicBase:"هَدْي",forms:{singular:"هَدْي"}},
     {wordType:"noun",english:"Standing (at Arafat)",arabicBase:"وُقُوف",forms:{singular:"وُقُوف"}},
     {wordType:"verb",english:"To perform Umrah",arabicBase:"اِعْتَمَرَ",forms:{past:"اِعْتَمَرَ",present:"يَعْتَمِرُ",imperative:"اِعْتَمِرْ",masdar:"اِعْتِمَار",activePart:"مُعْتَمِر"}},
     {wordType:"verb",english:"To shave",arabicBase:"حَلَقَ",forms:{past:"حَلَقَ",present:"يَحْلِقُ",imperative:"اِحْلِقْ",masdar:"حَلْق",activePart:"حَالِق",passivePart:"مَحْلُوق"}},
     {wordType:"verb",english:"To take off / remove",arabicBase:"خَلَعَ",forms:{past:"خَلَعَ",present:"يَخْلَعُ",imperative:"اِخْلَعْ",masdar:"خَلْع",activePart:"خَالِع",passivePart:"مَخْلُوع"}},
     {wordType:"verb",english:"To perform Sa'i",arabicBase:"سَعَى",forms:{past:"سَعَى",present:"يَسْعَى",imperative:"اِسْعَ",masdar:"سَعْي",activePart:"سَاعٍ"}},
     {wordType:"verb",english:"To feel",arabicBase:"شَعَرَ",forms:{past:"شَعَرَ",present:"يَشْعُرُ",imperative:"اُشْعُرْ",masdar:"شُعُور",activePart:"شَاعِر"}},
     {wordType:"verb",english:"To fast",arabicBase:"صَامَ",forms:{past:"صَامَ",present:"يَصُومُ",imperative:"صُمْ",masdar:"صِيَام",activePart:"صَائِم"}},
     {wordType:"verb",english:"To circumambulate (Tawaf)",arabicBase:"طَافَ",forms:{past:"طَافَ",present:"يَطُوفُ",imperative:"طُفْ",masdar:"طَوَاف",activePart:"طَائِف"}},
     {wordType:"verb",english:"To say the Talbiyah",arabicBase:"لَبَّى",forms:{past:"لَبَّى",present:"يُلَبِّي",imperative:"لَبِّ",masdar:"تَلْبِيَة",activePart:"مُلَبٍّ"}},
     {wordType:"verb",english:"To wear",arabicBase:"لَبِسَ",forms:{past:"لَبِسَ",present:"يَلْبَسُ",imperative:"اِلْبَسْ",masdar:"لُبْس",activePart:"لَابِس",passivePart:"مَلْبُوس"}},
   ]},
  {id:"preset-byy1-u15", title:"Bayna Yadayk Book 1 · Unit 15 — Health", unitId:"1-15", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"Ear",arabicBase:"أُذُن",forms:{singular:"أُذُن",plural:"آذَان"}},
     {wordType:"noun",english:"First aid",arabicBase:"إِسْعَاف",forms:{singular:"إِسْعَاف"}},
     {wordType:"noun",english:"Teeth",arabicBase:"أَسْنَان",forms:{singular:"أَسْنَان"}},
     {wordType:"noun",english:"Pain",arabicBase:"أَلَم",forms:{singular:"أَلَم",plural:"آلَام"}},
     {wordType:"noun",english:"Nose",arabicBase:"أَنْف",forms:{singular:"أَنْف",plural:"أُنُوف"}},
     {wordType:"noun",english:"Throat",arabicBase:"حَنْجَرَة",forms:{singular:"حَنْجَرَة",plural:"حَنَاجِر"}},
     {wordType:"noun",english:"Medicine",arabicBase:"دَوَاء",forms:{singular:"دَوَاء",plural:"أَدْوِيَة"}},
     {wordType:"noun",english:"Rest",arabicBase:"رَاحَة",forms:{singular:"رَاحَة"}},
     {wordType:"noun",english:"Weight gain",arabicBase:"زِيَادَةُ الوَزْن",forms:{singular:"زِيَادَةُ الوَزْن"}},
     {wordType:"noun",english:"Cough",arabicBase:"سُعَال",forms:{singular:"سُعَال"}},
     {wordType:"noun",english:"May God heal you",arabicBase:"شَفَاكَ اللهُ",forms:{singular:"شَفَاكَ اللهُ"}},
     {wordType:"noun",english:"Headache",arabicBase:"صُدَاع",forms:{singular:"صُدَاع"}},
     {wordType:"noun",english:"Chest",arabicBase:"صَدْر",forms:{singular:"صَدْر",plural:"صُدُور"}},
     {wordType:"noun",english:"Pressure",arabicBase:"ضَغْط",forms:{singular:"ضَغْط"}},
     {wordType:"noun",english:"Doctor",arabicBase:"طَبِيب",forms:{singular:"طَبِيب",plural:"أَطِبَّاء"}},
     {wordType:"noun",english:"Dentist",arabicBase:"طَبِيبُ أَسْنَان",forms:{singular:"طَبِيبُ أَسْنَان"}},
     {wordType:"noun",english:"Kidney",arabicBase:"كُلْيَة",forms:{singular:"كُلْيَة",plural:"كُلًى"}},
     {wordType:"noun",english:"Practice",arabicBase:"مُمَارَسَة",forms:{singular:"مُمَارَسَة"}},
     {wordType:"noun",english:"Appointment",arabicBase:"مَوْعِد",forms:{singular:"مَوْعِد",plural:"مَوَاعِيد"}},
     {wordType:"noun",english:"Result",arabicBase:"نَتِيجَة",forms:{singular:"نَتِيجَة",plural:"نَتَائِج"}},
     {wordType:"noun",english:"Fracture",arabicBase:"كَسْر",forms:{singular:"كَسْر",plural:"كُسُور"}},
     {wordType:"noun",english:"Wound",arabicBase:"جُرْح",forms:{singular:"جُرْح",plural:"جُرُوح"}},
     {wordType:"noun",english:"Surgeon",arabicBase:"جَرَّاح",forms:{singular:"جَرَّاح",plural:"جَرَّاحُون"}},
     {wordType:"noun",english:"Cold / flu",arabicBase:"زُكَام",forms:{singular:"زُكَام"}},
     {wordType:"noun",english:"Constipation",arabicBase:"إِمْسَاك",forms:{singular:"إِمْسَاك"}},
     {wordType:"noun",english:"Stomach cramp",arabicBase:"مَغَص",forms:{singular:"مَغَص"}},
     {wordType:"noun",english:"Nosebleed",arabicBase:"رُعَاف",forms:{singular:"رُعَاف"}},
     {wordType:"noun",english:"Diarrhea",arabicBase:"إِسْهَال",forms:{singular:"إِسْهَال"}},
     {wordType:"noun",english:"Fever",arabicBase:"حُمَّى",forms:{singular:"حُمَّى"}},
     {wordType:"noun",english:"Vomiting",arabicBase:"قَيْء",forms:{singular:"قَيْء"}},
     {wordType:"noun",english:"Fainting",arabicBase:"إِغْمَاء",forms:{singular:"إِغْمَاء"}},
     {wordType:"noun",english:"Bleeding",arabicBase:"نَزْف",forms:{singular:"نَزْف"}},
     {wordType:"adjective",english:"Healthy / sound",arabicBase:"سَلِيم",forms:{singular:"سَلِيم",feminine:"سَلِيمَة"}},
     {wordType:"adjective",english:"Severe",arabicBase:"شَدِيد",forms:{singular:"شَدِيد",feminine:"شَدِيدَة"}},
     {wordType:"verb",english:"To rise / increase",arabicBase:"اِرْتَفَعَ",forms:{past:"اِرْتَفَعَ",present:"يَرْتَفِعُ",imperative:"اِرْتَفِعْ",masdar:"اِرْتِفَاع",activePart:"مُرْتَفِع"}},
     {wordType:"verb",english:"To afflict",arabicBase:"أَصَابَ",forms:{past:"أَصَابَ",present:"يُصِيبُ",imperative:"أَصِبْ",masdar:"إِصَابَة",activePart:"مُصِيب",passivePart:"مُصَاب"}},
     {wordType:"verb",english:"To leave",arabicBase:"تَرَكَ",forms:{past:"تَرَكَ",present:"يَتْرُكُ",imperative:"اُتْرُكْ",masdar:"تَرْك",activePart:"تَارِك",passivePart:"مَتْرُوك"}},
     {wordType:"verb",english:"To be absent",arabicBase:"تَغَيَّبَ",forms:{past:"تَغَيَّبَ",present:"يَتَغَيَّبُ",imperative:"تَغَيَّبْ",masdar:"تَغَيُّب",activePart:"مُتَغَيِّب"}},
     {wordType:"verb",english:"To measure",arabicBase:"قَاسَ",forms:{past:"قَاسَ",present:"يَقِيسُ",imperative:"قِسْ",masdar:"قِيَاس",activePart:"قَائِس",passivePart:"مَقِيس"}},
     {wordType:"verb",english:"To advise",arabicBase:"نَصَحَ",forms:{past:"نَصَحَ",present:"يَنْصَحُ",imperative:"اِنْصَحْ",masdar:"نُصْح",activePart:"نَاصِح",passivePart:"مَنْصُوح"}},
   ]},
  {id:"preset-byy1-u16", title:"Bayna Yadayk Book 1 · Unit 16 — Holiday / Vacation", unitId:"1-16", level:"book1", seriesId:BYY1P2_SERIES,
   cards:[
     {wordType:"noun",english:"Permission",arabicBase:"إِذْن",forms:{singular:"إِذْن"}},
     {wordType:"noun",english:"Sacrificial animal (Eid)",arabicBase:"أُضْحِيَة",forms:{singular:"أُضْحِيَة",plural:"أَضَاحِي"}},
     {wordType:"noun",english:"Camels",arabicBase:"جِمَال",forms:{singular:"جِمَال"}},
     {wordType:"noun",english:"Mountains",arabicBase:"جِبَال",forms:{singular:"جِبَال"}},
     {wordType:"noun",english:"Jumada al-Akhirah (month)",arabicBase:"جُمَادَى الآخِرَة",forms:{singular:"جُمَادَى الآخِرَة"}},
     {wordType:"noun",english:"Jumada al-Awwal (month)",arabicBase:"جُمَادَى الأُولَى",forms:{singular:"جُمَادَى الأُولَى"}},
     {wordType:"noun",english:"Dhul-Hijjah (month)",arabicBase:"ذُو الحِجَّة",forms:{singular:"ذُو الحِجَّة"}},
     {wordType:"noun",english:"Dhul-Qi'dah (month)",arabicBase:"ذُو القَعْدَة",forms:{singular:"ذُو القَعْدَة"}},
     {wordType:"noun",english:"Rabi' al-Thani (month)",arabicBase:"رَبِيع الآخِر",forms:{singular:"رَبِيع الآخِر"}},
     {wordType:"noun",english:"Rabi' al-Awwal (month)",arabicBase:"رَبِيع الأَوَّل",forms:{singular:"رَبِيع الأَوَّل"}},
     {wordType:"noun",english:"Rajab (month)",arabicBase:"رَجَب",forms:{singular:"رَجَب"}},
     {wordType:"noun",english:"Safar (month)",arabicBase:"صَفَر",forms:{singular:"صَفَر"}},
     {wordType:"noun",english:"Shawwal (month)",arabicBase:"شَوَّال",forms:{singular:"شَوَّال"}},
     {wordType:"noun",english:"Person",arabicBase:"شَخْص",forms:{singular:"شَخْص",plural:"أَشْخَاص"}},
     {wordType:"noun",english:"Capital city",arabicBase:"عَاصِمَة",forms:{singular:"عَاصِمَة",plural:"عَوَاصِم"}},
     {wordType:"noun",english:"Eid prayer",arabicBase:"صَلَاةُ العِيد",forms:{singular:"صَلَاةُ العِيد"}},
     {wordType:"noun",english:"Summer vacation",arabicBase:"عُطْلَةُ الصَّيْف",forms:{singular:"عُطْلَةُ الصَّيْف"}},
     {wordType:"noun",english:"Happy holiday",arabicBase:"عُطْلَةٌ سَعِيدَة",forms:{singular:"عُطْلَةٌ سَعِيدَة"}},
     {wordType:"noun",english:"Eid al-Adha",arabicBase:"عِيدُ الأَضْحَى",forms:{singular:"عِيدُ الأَضْحَى"}},
     {wordType:"noun",english:"Eid al-Fitr",arabicBase:"عِيدُ الفِطْر",forms:{singular:"عِيدُ الفِطْر"}},
     {wordType:"noun",english:"Team",arabicBase:"فَرِيق",forms:{singular:"فَرِيق",plural:"فِرَق"}},
     {wordType:"noun",english:"Poor people",arabicBase:"فُقَرَاء",forms:{singular:"فُقَرَاء"}},
     {wordType:"noun",english:"Place",arabicBase:"مَكَان",forms:{singular:"مَكَان",plural:"أَمْكِنَة"}},
     {wordType:"noun",english:"Museums",arabicBase:"مُتَاحِف",forms:{singular:"مُتَاحِف"}},
     {wordType:"noun",english:"River",arabicBase:"نَهْر",forms:{singular:"نَهْر",plural:"أَنْهَار"}},
     {wordType:"noun",english:"Eid day",arabicBase:"يَوْم عِيد",forms:{singular:"يَوْم عِيد"}},
     {wordType:"adjective",english:"Cheap",arabicBase:"رَخِيص",forms:{singular:"رَخِيص",feminine:"رَخِيصَة"}},
     {wordType:"adjective",english:"Expensive",arabicBase:"غَالٍ",forms:{singular:"غَالٍ",feminine:"غَالِيَة"}},
     {wordType:"adjective",english:"Agreeing / coinciding",arabicBase:"مُوَافِق",forms:{singular:"مُوَافِق",feminine:"مُوَافِقَة"}},
     {wordType:"verb",english:"To approach",arabicBase:"اِقْتَرَبَ",forms:{past:"اِقْتَرَبَ",present:"يَقْتَرِبُ",imperative:"اِقْتَرِبْ",masdar:"اِقْتِرَاب",activePart:"مُقْتَرِب"}},
     {wordType:"verb",english:"To give",arabicBase:"أَعْطَى",forms:{past:"أَعْطَى",present:"يُعْطِي",imperative:"أَعْطِ",masdar:"إِعْطَاء",activePart:"مُعْطٍ",passivePart:"مُعْطًى"}},
     {wordType:"verb",english:"To perform Hajj",arabicBase:"حَجَّ",forms:{past:"حَجَّ",present:"يَحُجُّ",imperative:"حُجَّ",masdar:"حَجّ",activePart:"حَاجّ"}},
     {wordType:"verb",english:"To say",arabicBase:"قَالَ",forms:{past:"قَالَ",present:"يَقُولُ",imperative:"قُلْ",masdar:"قَوْل",activePart:"قَائِل",passivePart:"مَقُول"}},
   ]},
  // Bayna Yadayk Book 2, Part 1 — Units 1-8, transcribed from the book's own
  // end-of-book "vocabulary of each unit" glossary (قائمة مفردات كل وحدة,
  // printed pages 200-201). Book 2's vocabulary lists run noticeably denser
  // than Book 1's — a representative, pedagogically central subset was kept
  // per unit (not literally every listed item) to stay teachable rather than
  // exhaustive; skipped bound grammatical morphemes and words already
  // covered in Book 1 decks.
  {id:"preset-byy2-u1", title:"Bayna Yadayk Book 2 · Unit 1 — Health Care", unitId:"2-1", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Doctor",arabicBase:"طَبِيب",forms:{singular:"طَبِيب",plural:"أَطِبَّاء"}},
     {wordType:"noun",english:"Medicine",arabicBase:"دَوَاء",forms:{singular:"دَوَاء",plural:"أَدْوِيَة"}},
     {wordType:"noun",english:"Condition / case",arabicBase:"حَالَة",forms:{singular:"حَالَة",plural:"حَالَات"}},
     {wordType:"noun",english:"Woman",arabicBase:"اِمْرَأَة",forms:{singular:"اِمْرَأَة",plural:"نِسَاء"}},
     {wordType:"noun",english:"Marriage",arabicBase:"زَوَاج",forms:{singular:"زَوَاج"}},
     {wordType:"noun",english:"Juice",arabicBase:"عَصِير",forms:{singular:"عَصِير",plural:"عَصَائِر"}},
     {wordType:"noun",english:"Fruit",arabicBase:"فَاكِهَة",forms:{singular:"فَاكِهَة",plural:"فَوَاكِه"}},
     {wordType:"noun",english:"Story",arabicBase:"قِصَّة",forms:{singular:"قِصَّة",plural:"قَصَص"}},
     {wordType:"noun",english:"Sign / mark",arabicBase:"عَلَامَة",forms:{singular:"عَلَامَة",plural:"عَلَامَات"}},
     {wordType:"noun",english:"Gift",arabicBase:"هَدِيَّة",forms:{singular:"هَدِيَّة",plural:"هَدَايَا"}},
     {wordType:"noun",english:"Fat (body)",arabicBase:"شَحْم",forms:{singular:"شَحْم"}},
     {wordType:"noun",english:"Stomach / belly",arabicBase:"بُطْن",forms:{singular:"بُطْن",plural:"بُطُون"}},
     {wordType:"noun",english:"Pain",arabicBase:"أَلَم",forms:{singular:"أَلَم",plural:"آلَام"}},
     {wordType:"noun",english:"Diet",arabicBase:"حِمْيَة",forms:{singular:"حِمْيَة",plural:"حِمْيَات"}},
     {wordType:"adjective",english:"Dangerous",arabicBase:"خَطِير",forms:{singular:"خَطِير",feminine:"خَطِيرَة"}},
     {wordType:"adjective",english:"Normal / ordinary",arabicBase:"عَادِيّ",forms:{singular:"عَادِيّ",feminine:"عَادِيَّة"}},
     {wordType:"adjective",english:"Ugly",arabicBase:"قَبِيح",forms:{singular:"قَبِيح",feminine:"قَبِيحَة"}},
     {wordType:"adjective",english:"Complete / whole",arabicBase:"كَامِل",forms:{singular:"كَامِل",feminine:"كَامِلَة"}},
     {wordType:"adjective",english:"Busy",arabicBase:"مَشْغُول",forms:{singular:"مَشْغُول",feminine:"مَشْغُولَة"}},
     {wordType:"verb",english:"To take",arabicBase:"أَخَذَ",forms:{past:"أَخَذَ",present:"يَأْخُذُ",imperative:"خُذْ",masdar:"أَخْذ",activePart:"آخِذ",passivePart:"مَأْخُوذ"}},
     {wordType:"verb",english:"To know",arabicBase:"عَرَفَ",forms:{past:"عَرَفَ",present:"يَعْرِفُ",imperative:"اِعْرِفْ",masdar:"مَعْرِفَة",activePart:"عَارِف",passivePart:"مَعْرُوف"}},
     {wordType:"verb",english:"To try",arabicBase:"حَاوَلَ",forms:{past:"حَاوَلَ",present:"يُحَاوِلُ",imperative:"حَاوِلْ",masdar:"مُحَاوَلَة",activePart:"مُحَاوِل"}},
     {wordType:"verb",english:"To warn",arabicBase:"حَذَّرَ",forms:{past:"حَذَّرَ",present:"يُحَذِّرُ",imperative:"حَذِّرْ",masdar:"تَحْذِير",activePart:"مُحَذِّر",passivePart:"مُحَذَّر",harf:"مِنْ"}},
     {wordType:"verb",english:"To increase",arabicBase:"زَادَ",forms:{past:"زَادَ",present:"يَزِيدُ",imperative:"زِدْ",masdar:"زِيَادَة",activePart:"زَائِد",passivePart:"مَزِيد"}},
     {wordType:"verb",english:"To decrease",arabicBase:"نَقَصَ",forms:{past:"نَقَصَ",present:"يَنْقُصُ",imperative:"اُنْقُصْ",masdar:"نَقْص",activePart:"نَاقِص",passivePart:"مَنْقُوص"}},
     {wordType:"verb",english:"To succeed",arabicBase:"نَجَحَ",forms:{past:"نَجَحَ",present:"يَنْجَحُ",imperative:"اِنْجَحْ",masdar:"نَجَاح",activePart:"نَاجِح"}},
     {wordType:"verb",english:"To find",arabicBase:"وَجَدَ",forms:{past:"وَجَدَ",present:"يَجِدُ",imperative:"جِدْ",masdar:"وُجُود",activePart:"وَاجِد",passivePart:"مَوْجُود"}},
     {wordType:"verb",english:"To treat (medically)",arabicBase:"عَالَجَ",forms:{past:"عَالَجَ",present:"يُعَالِجُ",imperative:"عَالِجْ",masdar:"مُعَالَجَة",activePart:"مُعَالِج",passivePart:"مُعَالَج"}},
     {wordType:"verb",english:"To believe",arabicBase:"اِعْتَقَدَ",forms:{past:"اِعْتَقَدَ",present:"يَعْتَقِدُ",imperative:"اِعْتَقِدْ",masdar:"اِعْتِقَاد",activePart:"مُعْتَقِد"}},
     {wordType:"verb",english:"To differ",arabicBase:"اِخْتَلَفَ",forms:{past:"اِخْتَلَفَ",present:"يَخْتَلِفُ",imperative:"اِخْتَلِفْ",masdar:"اِخْتِلَاف",activePart:"مُخْتَلِف"}},
     {wordType:"verb",english:"To appear",arabicBase:"ظَهَرَ",forms:{past:"ظَهَرَ",present:"يَظْهَرُ",imperative:"اِظْهَرْ",masdar:"ظُهُور",activePart:"ظَاهِر"}},
     {wordType:"verb",english:"To advance / progress",arabicBase:"تَقَدَّمَ",forms:{past:"تَقَدَّمَ",present:"يَتَقَدَّمُ",imperative:"تَقَدَّمْ",masdar:"تَقَدُّم",activePart:"مُتَقَدِّم"}},
     {wordType:"verb",english:"To complain",arabicBase:"اِشْتَكَى",forms:{past:"اِشْتَكَى",present:"يَشْتَكِي",imperative:"اِشْتَكِ",masdar:"اِشْتِكَاء",activePart:"مُشْتَكٍ",harf:"مِنْ"}},
   ]},
  {id:"preset-byy2-u2", title:"Bayna Yadayk Book 2 · Unit 2 — Recreation & Leisure", unitId:"2-2", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Style / method",arabicBase:"أُسْلُوب",forms:{singular:"أُسْلُوب",plural:"أَسَالِيب"}},
     {wordType:"noun",english:"Human being",arabicBase:"إِنْسَان",forms:{singular:"إِنْسَان",plural:"أُنَاس"}},
     {wordType:"noun",english:"Garden",arabicBase:"حَدِيقَة",forms:{singular:"حَدِيقَة",plural:"حَدَائِق"}},
     {wordType:"noun",english:"Life",arabicBase:"حَيَاة",forms:{singular:"حَيَاة"}},
     {wordType:"noun",english:"Tent",arabicBase:"خَيْمَة",forms:{singular:"خَيْمَة",plural:"خِيَام"}},
     {wordType:"noun",english:"Opinion",arabicBase:"رَأْي",forms:{singular:"رَأْي",plural:"آرَاء"}},
     {wordType:"noun",english:"Desert",arabicBase:"صَحْرَاء",forms:{singular:"صَحْرَاء",plural:"صَحَارَى"}},
     {wordType:"noun",english:"Bird",arabicBase:"طَائِر",forms:{singular:"طَائِر",plural:"طُيُور"}},
     {wordType:"noun",english:"Hunting",arabicBase:"صَيْد",forms:{singular:"صَيْد"}},
     {wordType:"noun",english:"Mind",arabicBase:"عَقْل",forms:{singular:"عَقْل",plural:"عُقُول"}},
     {wordType:"noun",english:"Forest",arabicBase:"غَابَة",forms:{singular:"غَابَة",plural:"غَابَات"}},
     {wordType:"noun",english:"Benefit",arabicBase:"فَائِدَة",forms:{singular:"فَائِدَة",plural:"فَوَائِد"}},
     {wordType:"noun",english:"Strength",arabicBase:"قُوَّة",forms:{singular:"قُوَّة",plural:"قُوَى"}},
     {wordType:"noun",english:"Camp",arabicBase:"مُخَيَّم",forms:{singular:"مُخَيَّم",plural:"مُخَيَّمَات"}},
     {wordType:"noun",english:"Pleasure / enjoyment",arabicBase:"مُتْعَة",forms:{singular:"مُتْعَة",plural:"مُتَع"}},
     {wordType:"noun",english:"Summer resort",arabicBase:"مَصِيف",forms:{singular:"مَصِيف",plural:"مَصَايِف"}},
     {wordType:"noun",english:"Advice",arabicBase:"نَصِيحَة",forms:{singular:"نَصِيحَة",plural:"نَصَائِح"}},
     {wordType:"noun",english:"Self / soul",arabicBase:"نَفْس",forms:{singular:"نَفْس",plural:"أَنْفُس"}},
     {wordType:"noun",english:"Goal",arabicBase:"هَدَف",forms:{singular:"هَدَف",plural:"أَهْدَاف"}},
     {wordType:"noun",english:"Means",arabicBase:"وَسِيلَة",forms:{singular:"وَسِيلَة",plural:"وَسَائِل"}},
     {wordType:"adjective",english:"Strange / amazing",arabicBase:"عَجِيب",forms:{singular:"عَجِيب",feminine:"عَجِيبَة"}},
     {wordType:"verb",english:"To need",arabicBase:"اِحْتَاجَ",forms:{past:"اِحْتَاجَ",present:"يَحْتَاجُ",imperative:"اِحْتَجْ",masdar:"اِحْتِيَاج",activePart:"مُحْتَاج",harf:"إِلَى"}},
     {wordType:"verb",english:"To prepare",arabicBase:"أَعَدَّ",forms:{past:"أَعَدَّ",present:"يُعِدُّ",imperative:"أَعِدَّ",masdar:"إِعْدَاد",activePart:"مُعِدّ",passivePart:"مُعَدّ"}},
     {wordType:"verb",english:"To carry",arabicBase:"حَمَلَ",forms:{past:"حَمَلَ",present:"يَحْمِلُ",imperative:"اِحْمِلْ",masdar:"حَمْل",activePart:"حَامِل",passivePart:"مَحْمُول"}},
     {wordType:"verb",english:"To relax / entertain oneself",arabicBase:"رَوَّحَ",forms:{past:"رَوَّحَ",present:"يُرَوِّحُ",imperative:"رَوِّحْ",masdar:"تَرْوِيح",activePart:"مُرَوِّح"}},
     {wordType:"verb",english:"To swim",arabicBase:"سَبَحَ",forms:{past:"سَبَحَ",present:"يَسْبَحُ",imperative:"اِسْبَحْ",masdar:"سِبَاحَة",activePart:"سَابِح"}},
     {wordType:"verb",english:"To play",arabicBase:"لَعِبَ",forms:{past:"لَعِبَ",present:"يَلْعَبُ",imperative:"اِلْعَبْ",masdar:"لَعِب",activePart:"لَاعِب",passivePart:"مَلْعُوب"}},
     {wordType:"verb",english:"To discuss",arabicBase:"نَاقَشَ",forms:{past:"نَاقَشَ",present:"يُنَاقِشُ",imperative:"نَاقِشْ",masdar:"مُنَاقَشَة",activePart:"مُنَاقِش",passivePart:"مُنَاقَش"}},
     {wordType:"verb",english:"To intend",arabicBase:"قَصَدَ",forms:{past:"قَصَدَ",present:"يَقْصِدُ",imperative:"اِقْصِدْ",masdar:"قَصْد",activePart:"قَاصِد",passivePart:"مَقْصُود"}},
   ]},
  {id:"preset-byy2-u3", title:"Bayna Yadayk Book 2 · Unit 3 — Married Life", unitId:"2-3", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Dispute / disagreement",arabicBase:"خِلَاف",forms:{singular:"خِلَاف",plural:"خِلَافَات"}},
     {wordType:"noun",english:"Good / goodness",arabicBase:"خَيْر",forms:{singular:"خَيْر"}},
     {wordType:"noun",english:"Religion",arabicBase:"دِين",forms:{singular:"دِين",plural:"أَدْيَان"}},
     {wordType:"noun",english:"Happiness",arabicBase:"سَعَادَة",forms:{singular:"سَعَادَة"}},
     {wordType:"noun",english:"Policy / politics",arabicBase:"سِيَاسَة",forms:{singular:"سِيَاسَة",plural:"سِيَاسَات"}},
     {wordType:"noun",english:"Youth",arabicBase:"شَبَاب",forms:{singular:"شَبَاب"}},
     {wordType:"noun",english:"Personality",arabicBase:"شَخْصِيَّة",forms:{singular:"شَخْصِيَّة",plural:"شَخْصِيَّات"}},
     {wordType:"noun",english:"Weakness",arabicBase:"ضَعْف",forms:{singular:"ضَعْف"}},
     {wordType:"noun",english:"Difficulty",arabicBase:"صُعُوبَة",forms:{singular:"صُعُوبَة",plural:"صُعُوبَات"}},
     {wordType:"noun",english:"Divorce",arabicBase:"طَلَاق",forms:{singular:"طَلَاق"}},
     {wordType:"noun",english:"Young woman",arabicBase:"فَتَاة",forms:{singular:"فَتَاة",plural:"فَتَيَات"}},
     {wordType:"noun",english:"Money",arabicBase:"مَال",forms:{singular:"مَال",plural:"أَمْوَال"}},
     {wordType:"noun",english:"System",arabicBase:"نِظَام",forms:{singular:"نِظَام",plural:"أَنْظِمَة"}},
     {wordType:"noun",english:"Boy / child",arabicBase:"وَلَد",forms:{singular:"وَلَد",plural:"أَوْلَاد"}},
     {wordType:"noun",english:"Relationship",arabicBase:"عَلَاقَة",forms:{singular:"عَلَاقَة",plural:"عَلَاقَات"}},
     {wordType:"adjective",english:"Rich",arabicBase:"غَنِيّ",forms:{singular:"غَنِيّ",feminine:"غَنِيَّة",plural:"أَغْنِيَاء"}},
     {wordType:"adjective",english:"Poor",arabicBase:"فَقِير",forms:{singular:"فَقِير",feminine:"فَقِيرَة",plural:"فُقَرَاء"}},
     {wordType:"adjective",english:"Tall / long",arabicBase:"طَوِيل",forms:{singular:"طَوِيل",feminine:"طَوِيلَة"}},
     {wordType:"verb",english:"To care about",arabicBase:"اِهْتَمَّ",forms:{past:"اِهْتَمَّ",present:"يَهْتَمُّ",imperative:"اِهْتَمَّ",masdar:"اِهْتِمَام",activePart:"مُهْتَمّ",harf:"بِـ"}},
     {wordType:"verb",english:"To be verified / come true",arabicBase:"تَحَقَّقَ",forms:{past:"تَحَقَّقَ",present:"يَتَحَقَّقُ",imperative:"تَحَقَّقْ",masdar:"تَحَقُّق",activePart:"مُتَحَقِّق"}},
     {wordType:"verb",english:"To change",arabicBase:"تَغَيَّرَ",forms:{past:"تَغَيَّرَ",present:"يَتَغَيَّرُ",imperative:"تَغَيَّرْ",masdar:"تَغَيُّر",activePart:"مُتَغَيِّر"}},
     {wordType:"verb",english:"To return",arabicBase:"رَجَعَ",forms:{past:"رَجَعَ",present:"يَرْجِعُ",imperative:"اِرْجِعْ",masdar:"رُجُوع",activePart:"رَاجِع"}},
     {wordType:"verb",english:"To return / go back",arabicBase:"عَادَ",forms:{past:"عَادَ",present:"يَعُودُ",imperative:"عُدْ",masdar:"عَوْدَة",activePart:"عَائِد"}},
     {wordType:"verb",english:"To live",arabicBase:"عَاشَ",forms:{past:"عَاشَ",present:"يَعِيشُ",imperative:"عِشْ",masdar:"عَيْش",activePart:"عَائِش"}},
     {wordType:"verb",english:"To be unable",arabicBase:"عَجَزَ",forms:{past:"عَجَزَ",present:"يَعْجِزُ",imperative:"اُعْجِزْ",masdar:"عَجْز",activePart:"عَاجِز"}},
     {wordType:"verb",english:"To stand / undertake",arabicBase:"قَامَ",forms:{past:"قَامَ",present:"يَقُومُ",imperative:"قُمْ",masdar:"قِيَام",activePart:"قَائِم",harf:"بِـ"}},
     {wordType:"verb",english:"To gather / include",arabicBase:"ضَمَّ",forms:{past:"ضَمَّ",present:"يَضُمُّ",imperative:"ضُمَّ",masdar:"ضَمّ",activePart:"ضَامّ",passivePart:"مَضْمُوم"}},
   ]},
  {id:"preset-byy2-u4", title:"Bayna Yadayk Book 2 · Unit 4 — Life in the City", unitId:"2-4", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Ruins / traces",arabicBase:"أَثَر",forms:{singular:"أَثَر",plural:"آثَار"}},
     {wordType:"noun",english:"Neighbor",arabicBase:"جَار",forms:{singular:"جَار",plural:"جِيرَان"}},
     {wordType:"noun",english:"Right (entitlement)",arabicBase:"حَقّ",forms:{singular:"حَقّ",plural:"حُقُوق"}},
     {wordType:"noun",english:"Accident",arabicBase:"حَادِث",forms:{singular:"حَادِث",plural:"حَوَادِث"}},
     {wordType:"noun",english:"State / country",arabicBase:"دَوْلَة",forms:{singular:"دَوْلَة",plural:"دُوَل"}},
     {wordType:"noun",english:"Countryside",arabicBase:"رِيف",forms:{singular:"رِيف"}},
     {wordType:"noun",english:"Corner / angle",arabicBase:"زَاوِيَة",forms:{singular:"زَاوِيَة",plural:"زَوَايَا"}},
     {wordType:"noun",english:"Agriculture",arabicBase:"زِرَاعَة",forms:{singular:"زِرَاعَة"}},
     {wordType:"noun",english:"Earthquake",arabicBase:"زِلْزَال",forms:{singular:"زِلْزَال",plural:"زَلَازِل"}},
     {wordType:"noun",english:"Driver",arabicBase:"سَائِق",forms:{singular:"سَائِق",plural:"سَائِقُون"}},
     {wordType:"noun",english:"Pharmacy",arabicBase:"صَيْدَلِيَّة",forms:{singular:"صَيْدَلِيَّة",plural:"صَيْدَلِيَّات"}},
     {wordType:"noun",english:"Road / way",arabicBase:"طَرِيق",forms:{singular:"طَرِيق",plural:"طُرُق"}},
     {wordType:"noun",english:"World",arabicBase:"عَالَم",forms:{singular:"عَالَم",plural:"عَوَالِم"}},
     {wordType:"noun",english:"Number",arabicBase:"عَدَد",forms:{singular:"عَدَد",plural:"أَعْدَاد"}},
     {wordType:"noun",english:"Building",arabicBase:"عِمَارَة",forms:{singular:"عِمَارَة",plural:"عِمَارَات"}},
     {wordType:"noun",english:"Minaret",arabicBase:"مِئْذَنَة",forms:{singular:"مِئْذَنَة",plural:"مَآذِن"}},
     {wordType:"noun",english:"Narcotics / drugs",arabicBase:"مُخَدِّرَات",forms:{singular:"مُخَدِّرَات"}},
     {wordType:"noun",english:"City",arabicBase:"مَدِينَة",forms:{singular:"مَدِينَة",plural:"مُدُن"}},
     {wordType:"noun",english:"Billion",arabicBase:"مِلْيَار",forms:{singular:"مِلْيَار",plural:"مِلْيَارَات"}},
     {wordType:"noun",english:"Percentage / ratio",arabicBase:"نِسْبَة",forms:{singular:"نِسْبَة",plural:"نِسَب"}},
     {wordType:"noun",english:"Migration",arabicBase:"هِجْرَة",forms:{singular:"هِجْرَة"}},
     {wordType:"noun",english:"Century",arabicBase:"قَرْن",forms:{singular:"قَرْن",plural:"قُرُون"}},
     {wordType:"verb",english:"To head towards",arabicBase:"اِتَّجَهَ",forms:{past:"اِتَّجَهَ",present:"يَتَّجِهُ",imperative:"اِتَّجِهْ",masdar:"اِتِّجَاه",activePart:"مُتَّجِه",harf:"إِلَى"}},
     {wordType:"verb",english:"To continue",arabicBase:"اِسْتَمَرَّ",forms:{past:"اِسْتَمَرَّ",present:"يَسْتَمِرُّ",imperative:"اِسْتَمِرَّ",masdar:"اِسْتِمْرَار",activePart:"مُسْتَمِرّ"}},
     {wordType:"verb",english:"To become famous",arabicBase:"اِشْتَهَرَ",forms:{past:"اِشْتَهَرَ",present:"يَشْتَهِرُ",imperative:"اِشْتَهِرْ",masdar:"اِشْتِهَار",activePart:"مُشْتَهِر"}},
     {wordType:"verb",english:"To establish",arabicBase:"أَنْشَأَ",forms:{past:"أَنْشَأَ",present:"يُنْشِئُ",imperative:"أَنْشِئْ",masdar:"إِنْشَاء",activePart:"مُنْشِئ",passivePart:"مُنْشَأ"}},
     {wordType:"verb",english:"To sell",arabicBase:"بَاعَ",forms:{past:"بَاعَ",present:"يَبِيعُ",imperative:"بِعْ",masdar:"بَيْع",activePart:"بَائِع",passivePart:"مَبِيع"}},
     {wordType:"verb",english:"To depart / travel",arabicBase:"رَحَلَ",forms:{past:"رَحَلَ",present:"يَرْحَلُ",imperative:"اِرْحَلْ",masdar:"رَحِيل",activePart:"رَاحِل"}},
     {wordType:"verb",english:"To emigrate",arabicBase:"هَاجَرَ",forms:{past:"هَاجَرَ",present:"يُهَاجِرُ",imperative:"هَاجِرْ",masdar:"هِجْرَة",activePart:"مُهَاجِر"}},
     {wordType:"verb",english:"To fall / be located",arabicBase:"وَقَعَ",forms:{past:"وَقَعَ",present:"يَقَعُ",imperative:"قَعْ",masdar:"وُقُوع",activePart:"وَاقِع"}},
   ]},
  {id:"preset-byy2-u5", title:"Bayna Yadayk Book 2 · Unit 5 — Knowledge & Learning", unitId:"2-5", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Family / people",arabicBase:"أَهْل",forms:{singular:"أَهْل",plural:"أَهَالٍ"}},
     {wordType:"noun",english:"Enrollment / joining",arabicBase:"اِلْتِحَاق",forms:{singular:"اِلْتِحَاق"}},
     {wordType:"noun",english:"Grade / appreciation",arabicBase:"تَقْدِير",forms:{singular:"تَقْدِير",plural:"تَقْدِيرَات"}},
     {wordType:"noun",english:"Education",arabicBase:"تَعْلِيم",forms:{singular:"تَعْلِيم"}},
     {wordType:"noun",english:"Pupil",arabicBase:"تِلْمِيذ",forms:{singular:"تِلْمِيذ",plural:"تَلَامِيذ"}},
     {wordType:"noun",english:"Geography",arabicBase:"جُغْرَافِيَا",forms:{singular:"جُغْرَافِيَا"}},
     {wordType:"noun",english:"Nursery / daycare",arabicBase:"حَضَانَة",forms:{singular:"حَضَانَة",plural:"حَضَانَات"}},
     {wordType:"noun",english:"Civilization",arabicBase:"حَضَارَة",forms:{singular:"حَضَارَة",plural:"حَضَارَات"}},
     {wordType:"noun",english:"Study",arabicBase:"دِرَاسَة",forms:{singular:"دِرَاسَة",plural:"دِرَاسَات"}},
     {wordType:"noun",english:"Doctorate",arabicBase:"دُكْتُورَاه",forms:{singular:"دُكْتُورَاه"}},
     {wordType:"noun",english:"Kindergarten",arabicBase:"رَوْضَة",forms:{singular:"رَوْضَة",plural:"رِيَاض"}},
     {wordType:"noun",english:"Age",arabicBase:"سِنّ",forms:{singular:"سِنّ",plural:"أَسْنَان"}},
     {wordType:"noun",english:"Period (of time)",arabicBase:"فَتْرَة",forms:{singular:"فَتْرَة",plural:"فَتَرَات"}},
     {wordType:"noun",english:"Astronomy",arabicBase:"فَلَك",forms:{singular:"فَلَك"}},
     {wordType:"noun",english:"Acceptance",arabicBase:"قَبُول",forms:{singular:"قَبُول"}},
     {wordType:"noun",english:"Master's degree",arabicBase:"مَاجِسْتِير",forms:{singular:"مَاجِسْتِير"}},
     {wordType:"noun",english:"Stage / phase",arabicBase:"مَرْحَلَة",forms:{singular:"مَرْحَلَة",plural:"مَرَاحِل"}},
     {wordType:"noun",english:"Level",arabicBase:"مُسْتَوَى",forms:{singular:"مُسْتَوَى",plural:"مُسْتَوَيَات"}},
     {wordType:"noun",english:"Institute",arabicBase:"مَعْهَد",forms:{singular:"مَعْهَد",plural:"مَعَاهِد"}},
     {wordType:"adjective",english:"Optional",arabicBase:"اِخْتِيَارِيّ",forms:{singular:"اِخْتِيَارِيّ",feminine:"اِخْتِيَارِيَّة"}},
     {wordType:"adjective",english:"Natural",arabicBase:"طَبِيعِيّ",forms:{singular:"طَبِيعِيّ",feminine:"طَبِيعِيَّة"}},
     {wordType:"adjective",english:"Excellent",arabicBase:"مُمْتَاز",forms:{singular:"مُمْتَاز",feminine:"مُمْتَازَة"}},
     {wordType:"adjective",english:"Specific / certain",arabicBase:"مُعَيَّن",forms:{singular:"مُعَيَّن",feminine:"مُعَيَّنَة"}},
     {wordType:"verb",english:"To supervise",arabicBase:"أَشْرَفَ",forms:{past:"أَشْرَفَ",present:"يُشْرِفُ",imperative:"أَشْرِفْ",masdar:"إِشْرَاف",activePart:"مُشْرِف",harf:"عَلَى"}},
     {wordType:"verb",english:"To spread",arabicBase:"اِنْتَشَرَ",forms:{past:"اِنْتَشَرَ",present:"يَنْتَشِرُ",imperative:"اِنْتَشِرْ",masdar:"اِنْتِشَار",activePart:"مُنْتَشِر"}},
     {wordType:"verb",english:"To range / vary",arabicBase:"تَرَاوَحَ",forms:{past:"تَرَاوَحَ",present:"يَتَرَاوَحُ",imperative:"تَرَاوَحْ",masdar:"تَرَاوُح",activePart:"مُتَرَاوِح",harf:"بَيْنَ"}},
     {wordType:"verb",english:"To translate",arabicBase:"تَرْجَمَ",forms:{past:"تَرْجَمَ",present:"يُتَرْجِمُ",imperative:"تَرْجِمْ",masdar:"تَرْجَمَة",activePart:"مُتَرْجِم",passivePart:"مُتَرْجَم"}},
     {wordType:"verb",english:"To obtain",arabicBase:"حَصَلَ",forms:{past:"حَصَلَ",present:"يَحْصُلُ",imperative:"اُحْصُلْ",masdar:"حُصُول",activePart:"حَاصِل",harf:"عَلَى"}},
     {wordType:"verb",english:"To desire",arabicBase:"رَغِبَ",forms:{past:"رَغِبَ",present:"يَرْغَبُ",imperative:"اِرْغَبْ",masdar:"رَغْبَة",activePart:"رَاغِب",harf:"فِي"}},
     {wordType:"verb",english:"To kiss",arabicBase:"قَبَّلَ",forms:{past:"قَبَّلَ",present:"يُقَبِّلُ",imperative:"قَبِّلْ",masdar:"تَقْبِيل",activePart:"مُقَبِّل",passivePart:"مُقَبَّل"}},
     {wordType:"verb",english:"To pass by",arabicBase:"مَرَّ",forms:{past:"مَرَّ",present:"يَمُرُّ",imperative:"مُرَّ",masdar:"مُرُور",activePart:"مَارّ",harf:"بِـ"}},
     {wordType:"verb",english:"To agree",arabicBase:"وَافَقَ",forms:{past:"وَافَقَ",present:"يُوَافِقُ",imperative:"وَافِقْ",masdar:"مُوَافَقَة",activePart:"مُوَافِق",harf:"عَلَى"}},
   ]},
  {id:"preset-byy2-u6", title:"Bayna Yadayk Book 2 · Unit 6 — Professions", unitId:"2-6", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Morals / ethics",arabicBase:"أَخْلَاق",forms:{singular:"أَخْلَاق"}},
     {wordType:"noun",english:"Owner / companion",arabicBase:"صَاحِب",forms:{singular:"صَاحِب",plural:"أَصْحَاب"}},
     {wordType:"noun",english:"Living abroad",arabicBase:"اِغْتِرَاب",forms:{singular:"اِغْتِرَاب"}},
     {wordType:"noun",english:"Unemployment",arabicBase:"بَطَالَة",forms:{singular:"بَطَالَة"}},
     {wordType:"noun",english:"Government",arabicBase:"حُكُومَة",forms:{singular:"حُكُومَة",plural:"حُكُومَات"}},
     {wordType:"noun",english:"Maid / servant",arabicBase:"خَادِمَة",forms:{singular:"خَادِمَة",plural:"خَادِمَات"}},
     {wordType:"noun",english:"Experience",arabicBase:"خِبْرَة",forms:{singular:"خِبْرَة",plural:"خِبِرَات"}},
     {wordType:"noun",english:"Salary",arabicBase:"رَاتِب",forms:{singular:"رَاتِب",plural:"رَوَاتِب"}},
     {wordType:"noun",english:"Condition",arabicBase:"شَرْط",forms:{singular:"شَرْط",plural:"شُرُوط"}},
     {wordType:"noun",english:"Certificate / degree",arabicBase:"شَهَادَة",forms:{singular:"شَهَادَة",plural:"شَهَادَات"}},
     {wordType:"noun",english:"Opportunity",arabicBase:"فُرْصَة",forms:{singular:"فُرْصَة",plural:"فَرَص"}},
     {wordType:"noun",english:"Field / domain",arabicBase:"مَجَال",forms:{singular:"مَجَال",plural:"مَجَالَات"}},
     {wordType:"noun",english:"Help / assistance",arabicBase:"مُسَاعَدَة",forms:{singular:"مُسَاعَدَة",plural:"مُسَاعَدَات"}},
     {wordType:"noun",english:"Issue / matter",arabicBase:"مَسْأَلَة",forms:{singular:"مَسْأَلَة",plural:"مَسَائِل"}},
     {wordType:"noun",english:"Blessing",arabicBase:"نِعْمَة",forms:{singular:"نِعْمَة",plural:"نِعَم"}},
     {wordType:"noun",english:"Job / position",arabicBase:"وَظِيفَة",forms:{singular:"وَظِيفَة",plural:"وَظَائِف"}},
     {wordType:"adjective",english:"Lawful / permissible",arabicBase:"حَلَال",forms:{singular:"حَلَال"}},
     {wordType:"adjective",english:"Forbidden",arabicBase:"حَرَام",forms:{singular:"حَرَام"}},
     {wordType:"adjective",english:"Easy",arabicBase:"سَهْل",forms:{singular:"سَهْل",feminine:"سَهْلَة"}},
     {wordType:"adjective",english:"Strange / foreign",arabicBase:"غَرِيب",forms:{singular:"غَرِيب",feminine:"غَرِيبَة"}},
     {wordType:"verb",english:"To manage",arabicBase:"أَدَارَ",forms:{past:"أَدَارَ",present:"يُدِيرُ",imperative:"أَدِرْ",masdar:"إِدَارَة",activePart:"مُدِير",passivePart:"مُدَار"}},
     {wordType:"verb",english:"To depend",arabicBase:"اِعْتَمَدَ",forms:{past:"اِعْتَمَدَ",present:"يَعْتَمِدُ",imperative:"اِعْتَمِدْ",masdar:"اِعْتِمَاد",activePart:"مُعْتَمِد",harf:"عَلَى"}},
     {wordType:"verb",english:"To graduate",arabicBase:"تَخَرَّجَ",forms:{past:"تَخَرَّجَ",present:"يَتَخَرَّجُ",imperative:"تَخَرَّجْ",masdar:"تَخَرُّج",activePart:"مُتَخَرِّج",harf:"مِنْ"}},
     {wordType:"verb",english:"To preserve / maintain",arabicBase:"حَافَظَ",forms:{past:"حَافَظَ",present:"يُحَافِظُ",imperative:"حَافِظْ",masdar:"مُحَافَظَة",activePart:"مُحَافِظ",harf:"عَلَى"}},
     {wordType:"verb",english:"To pay / push",arabicBase:"دَفَعَ",forms:{past:"دَفَعَ",present:"يَدْفَعُ",imperative:"اِدْفَعْ",masdar:"دَفْع",activePart:"دَافِع",passivePart:"مَدْفُوع"}},
     {wordType:"verb",english:"To raise (children)",arabicBase:"رَبَّى",forms:{past:"رَبَّى",present:"يُرَبِّي",imperative:"رَبِّ",masdar:"تَرْبِيَة",activePart:"مُرَبٍّ",passivePart:"مُرَبًّى"}},
     {wordType:"verb",english:"To present / offer",arabicBase:"قَدَّمَ",forms:{past:"قَدَّمَ",present:"يُقَدِّمُ",imperative:"قَدِّمْ",masdar:"تَقْدِيم",activePart:"مُقَدِّم",passivePart:"مُقَدَّم"}},
     {wordType:"verb",english:"To prevent",arabicBase:"مَنَعَ",forms:{past:"مَنَعَ",present:"يَمْنَعُ",imperative:"اِمْنَعْ",masdar:"مَنْع",activePart:"مَانِع",passivePart:"مَمْنُوع"}},
     {wordType:"verb",english:"To suit",arabicBase:"نَاسَبَ",forms:{past:"نَاسَبَ",present:"يُنَاسِبُ",imperative:"نَاسِبْ",masdar:"مُنَاسَبَة",activePart:"مُنَاسِب"}},
     {wordType:"verb",english:"To clean",arabicBase:"نَظَّفَ",forms:{past:"نَظَّفَ",present:"يُنَظِّفُ",imperative:"نَظِّفْ",masdar:"تَنْظِيف",activePart:"مُنَظِّف",passivePart:"مُنَظَّف"}},
   ]},
  {id:"preset-byy2-u7", title:"Bayna Yadayk Book 2 · Unit 7 — The Arabic Language", unitId:"2-7", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Communication / contact",arabicBase:"اِتِّصَال",forms:{singular:"اِتِّصَال",plural:"اِتِّصَالَات"}},
     {wordType:"noun",english:"Broadcasting / radio",arabicBase:"إِذَاعَة",forms:{singular:"إِذَاعَة",plural:"إِذَاعَات"}},
     {wordType:"noun",english:"Colonialism",arabicBase:"اِسْتِعْمَار",forms:{singular:"اِسْتِعْمَار"}},
     {wordType:"noun",english:"Eloquence / rhetoric",arabicBase:"بَلَاغَة",forms:{singular:"بَلَاغَة"}},
     {wordType:"noun",english:"Training",arabicBase:"تَدْرِيب",forms:{singular:"تَدْرِيب",plural:"تَدْرِيبَات"}},
     {wordType:"noun",english:"Translation",arabicBase:"تَرْجَمَة",forms:{singular:"تَرْجَمَة",plural:"تَرْجَمَات"}},
     {wordType:"noun",english:"Interpretation / exegesis",arabicBase:"تَفْسِير",forms:{singular:"تَفْسِير",plural:"تَفَاسِير"}},
     {wordType:"noun",english:"Island / peninsula",arabicBase:"جَزِيرَة",forms:{singular:"جَزِيرَة",plural:"جُزُر"}},
     {wordType:"noun",english:"Letter (alphabet)",arabicBase:"حَرْف",forms:{singular:"حَرْف",plural:"حُرُوف"}},
     {wordType:"noun",english:"News / piece of information",arabicBase:"خَبَر",forms:{singular:"خَبَر",plural:"أَخْبَار"}},
     {wordType:"noun",english:"Oratory / public speaking",arabicBase:"خَطَابَة",forms:{singular:"خَطَابَة"}},
     {wordType:"noun",english:"Grammar (morphology)",arabicBase:"صَرْف",forms:{singular:"صَرْف"}},
     {wordType:"noun",english:"Era",arabicBase:"عَصْر",forms:{singular:"عَصْر",plural:"عُصُور"}},
     {wordType:"noun",english:"Contract / decade",arabicBase:"عَقْد",forms:{singular:"عَقْد",plural:"عُقُود"}},
     {wordType:"noun",english:"Jurisprudence",arabicBase:"فِقْه",forms:{singular:"فِقْه"}},
     {wordType:"noun",english:"Tribe",arabicBase:"قَبِيلَة",forms:{singular:"قَبِيلَة",plural:"قَبَائِل"}},
     {wordType:"noun",english:"Dialect",arabicBase:"لَهْجَة",forms:{singular:"لَهْجَة",plural:"لَهَجَات"}},
     {wordType:"noun",english:"Call / vocative",arabicBase:"نِدَاء",forms:{singular:"نِدَاء",plural:"نِدَاءَات"}},
     {wordType:"adjective",english:"Eloquent / classical",arabicBase:"فَصِيح",forms:{singular:"فَصِيح",feminine:"فَصِيحَة"}},
     {wordType:"adjective",english:"Official / formal",arabicBase:"رَسْمِيّ",forms:{singular:"رَسْمِيّ",feminine:"رَسْمِيَّة"}},
     {wordType:"adjective",english:"Shared / common",arabicBase:"مُشْتَرَك",forms:{singular:"مُشْتَرَك",feminine:"مُشْتَرَكَة"}},
     {wordType:"verb",english:"To influence",arabicBase:"أَثَّرَ",forms:{past:"أَثَّرَ",present:"يُؤَثِّرُ",imperative:"أَثِّرْ",masdar:"تَأْثِير",activePart:"مُؤَثِّر",passivePart:"مُؤَثَّر",harf:"فِي"}},
     {wordType:"verb",english:"To flourish",arabicBase:"اِزْدَهَرَ",forms:{past:"اِزْدَهَرَ",present:"يَزْدَهِرُ",imperative:"اِزْدَهِرْ",masdar:"اِزْدِهَار",activePart:"مُزْدَهِر"}},
     {wordType:"verb",english:"To add",arabicBase:"أَضَافَ",forms:{past:"أَضَافَ",present:"يُضِيفُ",imperative:"أَضِفْ",masdar:"إِضَافَة",activePart:"مُضِيف",passivePart:"مُضَاف"}},
     {wordType:"verb",english:"To enroll / join",arabicBase:"اِلْتَحَقَ",forms:{past:"اِلْتَحَقَ",present:"يَلْتَحِقُ",imperative:"اِلْتَحِقْ",masdar:"اِلْتِحَاق",activePart:"مُلْتَحِق",harf:"بِـ"}},
     {wordType:"verb",english:"To learn",arabicBase:"تَعَلَّمَ",forms:{past:"تَعَلَّمَ",present:"يَتَعَلَّمُ",imperative:"تَعَلَّمْ",masdar:"تَعَلُّم",activePart:"مُتَعَلِّم"}},
     {wordType:"verb",english:"To fight / wage war",arabicBase:"حَارَبَ",forms:{past:"حَارَبَ",present:"يُحَارِبُ",imperative:"حَارِبْ",masdar:"مُحَارَبَة",activePart:"مُحَارِب",passivePart:"مُحَارَب"}},
     {wordType:"verb",english:"To memorize / preserve",arabicBase:"حَفِظَ",forms:{past:"حَفِظَ",present:"يَحْفَظُ",imperative:"اِحْفَظْ",masdar:"حِفْظ",activePart:"حَافِظ",passivePart:"مَحْفُوظ"}},
     {wordType:"verb",english:"To grow up / originate",arabicBase:"نَشَأَ",forms:{past:"نَشَأَ",present:"يَنْشَأُ",imperative:"اِنْشَأْ",masdar:"نَشْأَة",activePart:"نَاشِئ"}},
     {wordType:"verb",english:"To pronounce",arabicBase:"نَطَقَ",forms:{past:"نَطَقَ",present:"يَنْطُقُ",imperative:"اُنْطُقْ",masdar:"نُطْق",activePart:"نَاطِق",passivePart:"مَنْطُوق"}},
   ]},
  {id:"preset-byy2-u8", title:"Bayna Yadayk Book 2 · Unit 8 — Prizes & Awards", unitId:"2-8", level:"book2", seriesId:BYY2P1_SERIES,
   cards:[
     {wordType:"noun",english:"Choice / selection",arabicBase:"اِخْتِيَار",forms:{singular:"اِخْتِيَار",plural:"اِخْتِيَارَات"}},
     {wordType:"noun",english:"Distinction / privilege",arabicBase:"اِمْتِيَاز",forms:{singular:"اِمْتِيَاز",plural:"اِمْتِيَازَات"}},
     {wordType:"noun",english:"Announcement",arabicBase:"إِعْلَان",forms:{singular:"إِعْلَان",plural:"إِعْلَانَات"}},
     {wordType:"noun",english:"Card",arabicBase:"بِطَاقَة",forms:{singular:"بِطَاقَة",plural:"بِطَاقَات"}},
     {wordType:"noun",english:"Prize / award",arabicBase:"جَائِزَة",forms:{singular:"جَائِزَة",plural:"جَوَائِز"}},
     {wordType:"noun",english:"Service",arabicBase:"خِدْمَة",forms:{singular:"خِدْمَة",plural:"خَدَمَات"}},
     {wordType:"noun",english:"Shield (trophy)",arabicBase:"دِرْع",forms:{singular:"دِرْع",plural:"دُرُوع"}},
     {wordType:"noun",english:"Colleague",arabicBase:"زَمِيل",forms:{singular:"زَمِيل",plural:"زُمَلَاء"}},
     {wordType:"noun",english:"Biography",arabicBase:"سِيرَة",forms:{singular:"سِيرَة",plural:"سِيَر"}},
     {wordType:"noun",english:"Trait / quality",arabicBase:"صِفَة",forms:{singular:"صِفَة",plural:"صِفَات"}},
     {wordType:"noun",english:"Pardon",arabicBase:"عَفْو",forms:{singular:"عَفْو"}},
     {wordType:"noun",english:"Value",arabicBase:"قِيمَة",forms:{singular:"قِيمَة",plural:"قِيَم"}},
     {wordType:"noun",english:"Committee",arabicBase:"لَجْنَة",forms:{singular:"لَجْنَة",plural:"لِجَان"}},
     {wordType:"noun",english:"Sum (of money)",arabicBase:"مَبْلَغ",forms:{singular:"مَبْلَغ",plural:"مَبَالِغ"}},
     {wordType:"noun",english:"Competition",arabicBase:"مُسَابَقَة",forms:{singular:"مُسَابَقَة",plural:"مُسَابَقَات"}},
     {wordType:"noun",english:"Piece of information",arabicBase:"مَعْلُومَة",forms:{singular:"مَعْلُومَة",plural:"مَعْلُومَات"}},
     {wordType:"noun",english:"Summary",arabicBase:"مُلَخَّص",forms:{singular:"مُلَخَّص",plural:"مُلَخَّصَات"}},
     {wordType:"noun",english:"Reward",arabicBase:"مُكَافَأَة",forms:{singular:"مُكَافَأَة",plural:"مُكَافَآت"}},
     {wordType:"noun",english:"Organization / body",arabicBase:"هَيْئَة",forms:{singular:"هَيْئَة",plural:"هَيْئَات"}},
     {wordType:"adjective",english:"Creative",arabicBase:"مُبْدِع",forms:{singular:"مُبْدِع",feminine:"مُبْدِعَة"}},
     {wordType:"adjective",english:"Famous",arabicBase:"مَشْهُور",forms:{singular:"مَشْهُور",feminine:"مَشْهُورَة"}},
     {wordType:"adjective",english:"Beloved / popular",arabicBase:"مَحْبُوب",forms:{singular:"مَحْبُوب",feminine:"مَحْبُوبَة"}},
     {wordType:"verb",english:"To gather / meet",arabicBase:"اِجْتَمَعَ",forms:{past:"اِجْتَمَعَ",present:"يَجْتَمِعُ",imperative:"اِجْتَمِعْ",masdar:"اِجْتِمَاع",activePart:"مُجْتَمِع"}},
     {wordType:"verb",english:"To announce",arabicBase:"أَعْلَنَ",forms:{past:"أَعْلَنَ",present:"يُعْلِنُ",imperative:"أَعْلِنْ",masdar:"إِعْلَان",activePart:"مُعْلِن",passivePart:"مُعْلَن"}},
     {wordType:"verb",english:"To gather / collect",arabicBase:"جَمَعَ",forms:{past:"جَمَعَ",present:"يَجْمَعُ",imperative:"اِجْمَعْ",masdar:"جَمْع",activePart:"جَامِع",passivePart:"مَجْمُوع"}},
     {wordType:"verb",english:"To raise / lift",arabicBase:"رَفَعَ",forms:{past:"رَفَعَ",present:"يَرْفَعُ",imperative:"اِرْفَعْ",masdar:"رَفْع",activePart:"رَافِع",passivePart:"مَرْفُوع"}},
     {wordType:"verb",english:"To participate",arabicBase:"شَارَكَ",forms:{past:"شَارَكَ",present:"يُشَارِكُ",imperative:"شَارِكْ",masdar:"مُشَارَكَة",activePart:"مُشَارِك",harf:"فِي"}},
     {wordType:"verb",english:"To pardon",arabicBase:"عَفَا",forms:{past:"عَفَا",present:"يَعْفُو",imperative:"اُعْفُ",masdar:"عَفْو",activePart:"عَافٍ",harf:"عَنْ"}},
     {wordType:"verb",english:"To grant / bestow",arabicBase:"مَنَحَ",forms:{past:"مَنَحَ",present:"يَمْنَحُ",imperative:"اِمْنَحْ",masdar:"مَنْح",activePart:"مَانِح",passivePart:"مَمْنُوح"}},
     {wordType:"verb",english:"To attain / receive",arabicBase:"نَالَ",forms:{past:"نَالَ",present:"يَنَالُ",imperative:"نَلْ",masdar:"نَيْل",activePart:"نَائِل"}},
   ]},
  {id:"preset-byy2-u9", title:"Bayna Yadayk Book 2 · Unit 9 — The World, A Small Village", unitId:"2-9", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"verb",english:"To agree",arabicBase:"اِتَّفَقَ",forms:{past:"اِتَّفَقَ",present:"يَتَّفِقُ",imperative:"اِتَّفِقْ",masdar:"اِتِّفَاق",activePart:"مُتَّفِق"}},
     {wordType:"noun",english:"News",arabicBase:"خَبَر",forms:{singular:"خَبَر",plural:"أَخْبَار"}},
     {wordType:"verb",english:"To perform / lead to",arabicBase:"أَدَّى",forms:{past:"أَدَّى",present:"يُؤَدِّي",imperative:"أَدِّ",masdar:"أَدَاء",activePart:"مُؤَدٍّ",passivePart:"مُؤَدًّى"}},
     {wordType:"verb",english:"To send",arabicBase:"أَرْسَلَ",forms:{past:"أَرْسَلَ",present:"يُرْسِلُ",imperative:"أَرْسِلْ",masdar:"إِرْسَال",activePart:"مُرْسِل",passivePart:"مُرْسَل"}},
     {wordType:"noun",english:"Email",arabicBase:"بَرِيدٌ إِلِكْتُرُونِيّ",forms:{singular:"بَرِيدٌ إِلِكْتُرُونِيّ"}},
     {wordType:"noun",english:"War",arabicBase:"حَرْب",forms:{singular:"حَرْب",plural:"حُرُوب"}},
     {wordType:"noun",english:"Argument / proof",arabicBase:"حُجَّة",forms:{singular:"حُجَّة",plural:"حُجَج"}},
     {wordType:"verb",english:"To be ignorant",arabicBase:"جَهِلَ",forms:{past:"جَهِلَ",present:"يَجْهَلُ",imperative:"اِجْهَلْ",masdar:"جَهْل",activePart:"جَاهِل"}},
     {wordType:"noun",english:"Side",arabicBase:"جَانِب",forms:{singular:"جَانِب",plural:"جَوَانِب"}},
     {wordType:"noun",english:"Animal",arabicBase:"حَيَوَان",forms:{singular:"حَيَوَان",plural:"حَيَوَانَات"}},
     {wordType:"noun",english:"Computer",arabicBase:"حَاسُوب",forms:{singular:"حَاسُوب",plural:"حَوَاسِيب"}},
     {wordType:"noun",english:"Letter / message",arabicBase:"رِسَالَة",forms:{singular:"رِسَالَة",plural:"رَسَائِل"}},
     {wordType:"verb",english:"To refuse",arabicBase:"رَفَضَ",forms:{past:"رَفَضَ",present:"يَرْفُضُ",imperative:"اُرْفُضْ",masdar:"رَفْض",activePart:"رَافِض",passivePart:"مَرْفُوض"}},
     {wordType:"noun",english:"Ship",arabicBase:"سَفِينَة",forms:{singular:"سَفِينَة",plural:"سُفُن"}},
     {wordType:"noun",english:"Screen",arabicBase:"شَاشَة",forms:{singular:"شَاشَة",plural:"شَاشَات"}},
     {wordType:"noun",english:"The internet",arabicBase:"الشَّبَكَةُ الدَّوْلِيَّة",forms:{singular:"الشَّبَكَةُ الدَّوْلِيَّة"}},
     {wordType:"verb",english:"To make",arabicBase:"صَنَعَ",forms:{past:"صَنَعَ",present:"يَصْنَعُ",imperative:"اِصْنَعْ",masdar:"صُنْع",activePart:"صَانِع",passivePart:"مَصْنُوع"}},
     {wordType:"verb",english:"To fly",arabicBase:"طَارَ",forms:{past:"طَارَ",present:"يَطِيرُ",imperative:"طِرْ",masdar:"طَيَرَان",activePart:"طَائِر"}},
     {wordType:"noun",english:"Address",arabicBase:"عُنْوَان",forms:{singular:"عُنْوَان",plural:"عَنَاوِين"}},
     {wordType:"noun",english:"Globalization",arabicBase:"عَوْلَمَة",forms:{singular:"عَوْلَمَة"}},
     {wordType:"noun",english:"Engine / motor",arabicBase:"مُحَرِّك",forms:{singular:"مُحَرِّك",plural:"مُحَرِّكَات"}},
     {wordType:"noun",english:"Illness",arabicBase:"مَرَض",forms:{singular:"مَرَض",plural:"أَمْرَاض"}},
     {wordType:"verb",english:"To own / possess",arabicBase:"مَلَكَ",forms:{past:"مَلَكَ",present:"يَمْلِكُ",imperative:"اُمْلُكْ",masdar:"مِلْك",activePart:"مَالِك",passivePart:"مَمْلُوك"}},
     {wordType:"noun",english:"Window",arabicBase:"نَافِذَة",forms:{singular:"نَافِذَة",plural:"نَوَافِذ"}},
     {wordType:"adjective",english:"Wide / spacious",arabicBase:"وَاسِع",forms:{singular:"وَاسِع",feminine:"وَاسِعَة",plural:"وَاسِعُون"}},
     {wordType:"noun",english:"Development",arabicBase:"تَنْمِيَة",forms:{singular:"تَنْمِيَة"}},
   ]},
  {id:"preset-byy2-u10", title:"Bayna Yadayk Book 2 · Unit 10 — Cleanliness", unitId:"2-10", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"verb",english:"To remove",arabicBase:"أَزَالَ",forms:{past:"أَزَالَ",present:"يُزِيلُ",imperative:"أَزِلْ",masdar:"إِزَالَة",activePart:"مُزِيل",passivePart:"مُزَال"}},
     {wordType:"verb",english:"To use",arabicBase:"اِسْتَعْمَلَ",forms:{past:"اِسْتَعْمَلَ",present:"يَسْتَعْمِلُ",imperative:"اِسْتَعْمِلْ",masdar:"اِسْتِعْمَال",activePart:"مُسْتَعْمِل",passivePart:"مُسْتَعْمَل"}},
     {wordType:"verb",english:"To bathe",arabicBase:"اِغْتَسَلَ",forms:{past:"اِغْتَسَلَ",present:"يَغْتَسِلُ",imperative:"اِغْتَسِلْ",masdar:"اِغْتِسَال",activePart:"مُغْتَسِل"}},
     {wordType:"verb",english:"To spend",arabicBase:"أَنْفَقَ",forms:{past:"أَنْفَقَ",present:"يُنْفِقُ",imperative:"أَنْفِقْ",masdar:"إِنْفَاق",activePart:"مُنْفِق",passivePart:"مُنْفَق"}},
     {wordType:"noun",english:"Environment",arabicBase:"بِيئَة",forms:{singular:"بِيئَة",plural:"بِيئَات"}},
     {wordType:"noun",english:"Body",arabicBase:"جَسَد",forms:{singular:"جَسَد",plural:"أَجْسَاد"}},
     {wordType:"noun",english:"Garden",arabicBase:"حَدِيقَة",forms:{singular:"حَدِيقَة",plural:"حَدَائِق"}},
     {wordType:"verb",english:"To burn",arabicBase:"حَرَقَ",forms:{past:"حَرَقَ",present:"يَحْرِقُ",imperative:"اُحْرُقْ",masdar:"حَرْق",activePart:"حَارِق",passivePart:"مَحْرُوق"}},
     {wordType:"adjective",english:"Special / private",arabicBase:"خَاصّ",forms:{singular:"خَاصّ",feminine:"خَاصَّة"}},
     {wordType:"noun",english:"Purity",arabicBase:"طَهَارَة",forms:{singular:"طَهَارَة"}},
     {wordType:"noun",english:"Act of worship",arabicBase:"عِبَادَة",forms:{singular:"عِبَادَة",plural:"عِبَادَات"}},
     {wordType:"verb",english:"To wash",arabicBase:"غَسَلَ",forms:{past:"غَسَلَ",present:"يَغْسِلُ",imperative:"اِغْسِلْ",masdar:"غَسْل",activePart:"غَاسِل",passivePart:"مَغْسُول"}},
     {wordType:"verb",english:"To measure",arabicBase:"قَاسَ",forms:{past:"قَاسَ",present:"يَقِيسُ",imperative:"قِسْ",masdar:"قِيَاس",activePart:"قَائِس",passivePart:"مَقِيس"}},
     {wordType:"noun",english:"Responsibility",arabicBase:"مَسْؤُولِيَّة",forms:{singular:"مَسْؤُولِيَّة"}},
     {wordType:"noun",english:"Dwelling",arabicBase:"مَسْكَن",forms:{singular:"مَسْكَن",plural:"مَسَاكِن"}},
     {wordType:"adjective",english:"Clean",arabicBase:"نَظِيف",forms:{singular:"نَظِيف",feminine:"نَظِيفَة",plural:"نُظَفَاء"}},
     {wordType:"noun",english:"Waste / garbage",arabicBase:"نُفَايَة",forms:{singular:"نُفَايَة",plural:"نُفَايَات"}},
     {wordType:"noun",english:"System",arabicBase:"نِظَام",forms:{singular:"نِظَام",plural:"أَنْظِمَة"}},
     {wordType:"noun",english:"Face",arabicBase:"وَجْه",forms:{singular:"وَجْه",plural:"وُجُوه"}},
     {wordType:"noun",english:"Ablution",arabicBase:"وُضُوء",forms:{singular:"وُضُوء"}},
     {wordType:"noun",english:"Hand",arabicBase:"يَد",forms:{singular:"يَد",plural:"أَيْدٍ"}},
     {wordType:"adjective",english:"Hygienic",arabicBase:"صِحِّيّ",forms:{singular:"صِحِّيّ",feminine:"صِحِّيَّة"}},
   ]},
  {id:"preset-byy2-u11", title:"Bayna Yadayk Book 2 · Unit 11 — Islam", unitId:"2-11", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"noun",english:"Pillar",arabicBase:"رُكْن",forms:{singular:"رُكْن",plural:"أَرْكَان"}},
     {wordType:"verb",english:"To submit / become Muslim",arabicBase:"أَسْلَمَ",forms:{past:"أَسْلَمَ",present:"يُسْلِمُ",imperative:"أَسْلِمْ",masdar:"إِسْلَام",activePart:"مُسْلِم"}},
     {wordType:"noun",english:"Nation / community",arabicBase:"أُمَّة",forms:{singular:"أُمَّة",plural:"أُمَم"}},
     {wordType:"noun",english:"Mankind",arabicBase:"بَشَر",forms:{singular:"بَشَر"}},
     {wordType:"noun",english:"Monotheism",arabicBase:"تَوْحِيد",forms:{singular:"تَوْحِيد"}},
     {wordType:"noun",english:"Truth / reality",arabicBase:"حَقِيقَة",forms:{singular:"حَقِيقَة",plural:"حَقَائِق"}},
     {wordType:"noun",english:"Evidence / proof",arabicBase:"دَلِيل",forms:{singular:"دَلِيل",plural:"أَدِلَّة"}},
     {wordType:"noun",english:"Desire",arabicBase:"رَغْبَة",forms:{singular:"رَغْبَة",plural:"رَغَبَات"}},
     {wordType:"verb",english:"To ask",arabicBase:"سَأَلَ",forms:{past:"سَأَلَ",present:"يَسْأَلُ",imperative:"اِسْأَلْ",masdar:"سُؤَال",activePart:"سَائِل",passivePart:"مَسْؤُول"}},
     {wordType:"noun",english:"People",arabicBase:"شَعْب",forms:{singular:"شَعْب",plural:"شُعُوب"}},
     {wordType:"noun",english:"Sun",arabicBase:"شَمْس",forms:{singular:"شَمْس",plural:"شُمُوس"}},
     {wordType:"adjective",english:"Righteous",arabicBase:"صَالِح",forms:{singular:"صَالِح",feminine:"صَالِحَة",plural:"صَالِحُون"}},
     {wordType:"noun",english:"Justice",arabicBase:"عَدْل",forms:{singular:"عَدْل"}},
     {wordType:"adjective",english:"Great",arabicBase:"عَظِيم",forms:{singular:"عَظِيم",feminine:"عَظِيمَة",plural:"عُظَمَاء"}},
     {wordType:"verb",english:"To understand",arabicBase:"فَهِمَ",forms:{past:"فَهِمَ",present:"يَفْهَمُ",imperative:"اِفْهَمْ",masdar:"فَهْم",activePart:"فَاهِم",passivePart:"مَفْهُوم"}},
     {wordType:"noun",english:"Book",arabicBase:"كِتَاب",forms:{singular:"كِتَاب",plural:"كُتُب"}},
     {wordType:"noun",english:"Equality",arabicBase:"مُسَاوَاة",forms:{singular:"مُسَاوَاة"}},
     {wordType:"noun",english:"Rite",arabicBase:"مَنْسَك",forms:{singular:"مَنْسَك",plural:"مَنَاسِك"}},
     {wordType:"noun",english:"Description",arabicBase:"وَصْف",forms:{singular:"وَصْف"}},
     {wordType:"verb",english:"To worship",arabicBase:"عَبَدَ",forms:{past:"عَبَدَ",present:"يَعْبُدُ",imperative:"اُعْبُدْ",masdar:"عِبَادَة",activePart:"عَابِد",passivePart:"مَعْبُود"}},
   ]},
  {id:"preset-byy2-u12", title:"Bayna Yadayk Book 2 · Unit 12 — Youth", unitId:"2-12", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"verb",english:"To respect",arabicBase:"اِحْتَرَمَ",forms:{past:"اِحْتَرَمَ",present:"يَحْتَرِمُ",imperative:"اِحْتَرِمْ",masdar:"اِحْتِرَام",activePart:"مُحْتَرِم",passivePart:"مُحْتَرَم"}},
     {wordType:"noun",english:"Media",arabicBase:"إِعْلَام",forms:{singular:"إِعْلَام"}},
     {wordType:"verb",english:"To neglect",arabicBase:"أَهْمَلَ",forms:{past:"أَهْمَلَ",present:"يُهْمِلُ",imperative:"أَهْمِلْ",masdar:"إِهْمَال",activePart:"مُهْمِل",passivePart:"مُهْمَل"}},
     {wordType:"noun",english:"Importance",arabicBase:"أَهَمِّيَّة",forms:{singular:"أَهَمِّيَّة"}},
     {wordType:"noun",english:"Influence",arabicBase:"تَأْثِير",forms:{singular:"تَأْثِير",plural:"تَأْثِيرَات"}},
     {wordType:"noun",english:"Experience",arabicBase:"تَجْرِبَة",forms:{singular:"تَجْرِبَة",plural:"تَجَارِب"}},
     {wordType:"noun",english:"Heritage",arabicBase:"تُرَاث",forms:{singular:"تُرَاث"}},
     {wordType:"noun",english:"Crime",arabicBase:"جَرِيمَة",forms:{singular:"جَرِيمَة",plural:"جَرَائِم"}},
     {wordType:"verb",english:"To converse / dialogue",arabicBase:"حَاوَرَ",forms:{past:"حَاوَرَ",present:"يُحَاوِرُ",imperative:"حَاوِرْ",masdar:"مُحَاوَرَة",activePart:"مُحَاوِر",passivePart:"مُحَاوَر"}},
     {wordType:"noun",english:"Wisdom",arabicBase:"حِكْمَة",forms:{singular:"حِكْمَة",plural:"حِكَم"}},
     {wordType:"noun",english:"Youth (young man)",arabicBase:"شَابّ",forms:{singular:"شَابّ",plural:"شَبَاب"}},
     {wordType:"noun",english:"Feeling",arabicBase:"شُعُور",forms:{singular:"شُعُور"}},
     {wordType:"verb",english:"To harm",arabicBase:"ضَرَّ",forms:{past:"ضَرَّ",present:"يَضُرُّ",imperative:"ضُرَّ",masdar:"ضَرَر",activePart:"ضَارّ",passivePart:"مَضْرُور"}},
     {wordType:"verb",english:"To lead",arabicBase:"قَادَ",forms:{past:"قَادَ",present:"يَقُودُ",imperative:"قُدْ",masdar:"قِيَادَة",activePart:"قَائِد",passivePart:"مَقُود"}},
     {wordType:"noun",english:"Leadership",arabicBase:"قِيَادَة",forms:{singular:"قِيَادَة"}},
     {wordType:"noun",english:"Adolescent",arabicBase:"مُرَاهِق",forms:{singular:"مُرَاهِق",plural:"مُرَاهِقُون"}},
     {wordType:"noun",english:"Participation",arabicBase:"مُشَارَكَة",forms:{singular:"مُشَارَكَة"}},
     {wordType:"noun",english:"Emigrant",arabicBase:"مُهَاجِر",forms:{singular:"مُهَاجِر",plural:"مُهَاجِرُون"}},
     {wordType:"verb",english:"To forget",arabicBase:"نَسِيَ",forms:{past:"نَسِيَ",present:"يَنْسَى",imperative:"اِنْسَ",masdar:"نِسْيَان",activePart:"نَاسٍ",passivePart:"مَنْسِيّ"}},
     {wordType:"noun",english:"Advice",arabicBase:"نَصِيحَة",forms:{singular:"نَصِيحَة",plural:"نَصَائِح"}},
     {wordType:"verb",english:"To benefit",arabicBase:"نَفَعَ",forms:{past:"نَفَعَ",present:"يَنْفَعُ",imperative:"اُنْفَعْ",masdar:"نَفْع",activePart:"نَافِع",passivePart:"مَنْفُوع"}},
     {wordType:"verb",english:"To face / confront",arabicBase:"وَاجَهَ",forms:{past:"وَاجَهَ",present:"يُوَاجِهُ",imperative:"وَاجِهْ",masdar:"مُوَاجَهَة",activePart:"مُوَاجِه",passivePart:"مُوَاجَه"}},
   ]},
  {id:"preset-byy2-u13", title:"Bayna Yadayk Book 2 · Unit 13 — The Islamic World", unitId:"2-13", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"verb",english:"To unite",arabicBase:"اِتَّحَدَ",forms:{past:"اِتَّحَدَ",present:"يَتَّحِدُ",imperative:"اِتَّحِدْ",masdar:"اِتِّحَاد",activePart:"مُتَّحِد"}},
     {wordType:"verb",english:"To occupy",arabicBase:"اِحْتَلَّ",forms:{past:"اِحْتَلَّ",present:"يَحْتَلُّ",imperative:"اِحْتَلَّ",masdar:"اِحْتِلَال",activePart:"مُحْتَلّ",passivePart:"مُحْتَلّ"}},
     {wordType:"verb",english:"To save / rescue",arabicBase:"أَنْقَذَ",forms:{past:"أَنْقَذَ",present:"يُنْقِذُ",imperative:"أَنْقِذْ",masdar:"إِنْقَاذ",activePart:"مُنْقِذ",passivePart:"مُنْقَذ"}},
     {wordType:"verb",english:"To achieve",arabicBase:"حَقَّقَ",forms:{past:"حَقَّقَ",present:"يُحَقِّقُ",imperative:"حَقِّقْ",masdar:"تَحْقِيق",activePart:"مُحَقِّق",passivePart:"مُحَقَّق"}},
     {wordType:"noun",english:"Lord",arabicBase:"رَبّ",forms:{singular:"رَبّ"}},
     {wordType:"adjective",english:"Agricultural",arabicBase:"زِرَاعِيّ",forms:{singular:"زِرَاعِيّ",feminine:"زِرَاعِيَّة"}},
     {wordType:"noun",english:"Sect / group",arabicBase:"طَائِفَة",forms:{singular:"طَائِفَة",plural:"طَوَائِف"}},
     {wordType:"noun",english:"Currency",arabicBase:"عُمْلَة",forms:{singular:"عُمْلَة",plural:"عُمْلَات"}},
     {wordType:"noun",english:"Era / covenant",arabicBase:"عَهْد",forms:{singular:"عَهْد",plural:"عُهُود"}},
     {wordType:"noun",english:"Direction of prayer",arabicBase:"قِبْلَة",forms:{singular:"قِبْلَة"}},
     {wordType:"noun",english:"Globe",arabicBase:"كُرَةٌ أَرْضِيَّة",forms:{singular:"كُرَةٌ أَرْضِيَّة"}},
     {wordType:"noun",english:"Building",arabicBase:"مَبْنَى",forms:{singular:"مَبْنَى",plural:"مَبَانِي"}},
     {wordType:"noun",english:"Ocean",arabicBase:"مُحِيط",forms:{singular:"مُحِيط",plural:"مُحِيطَات"}},
     {wordType:"noun",english:"Area",arabicBase:"مَسَاحَة",forms:{singular:"مَسَاحَة"}},
     {wordType:"adjective",english:"Sacred",arabicBase:"مُقَدَّس",forms:{singular:"مُقَدَّس",feminine:"مُقَدَّسَة"}},
     {wordType:"noun",english:"Region",arabicBase:"مِنْطَقَة",forms:{singular:"مِنْطَقَة",plural:"مَنَاطِق"}},
     {wordType:"verb",english:"To include",arabicBase:"شَمِلَ",forms:{past:"شَمِلَ",present:"يَشْمَلُ",imperative:"اِشْمَلْ",masdar:"شُمُول",activePart:"شَامِل",passivePart:"مَشْمُول"}},
   ]},
  {id:"preset-byy2-u14", title:"Bayna Yadayk Book 2 · Unit 14 — Security", unitId:"2-14", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"noun",english:"Effect / trace",arabicBase:"أَثَر",forms:{singular:"أَثَر",plural:"آثَار"}},
     {wordType:"verb",english:"To frighten",arabicBase:"أَخَافَ",forms:{past:"أَخَافَ",present:"يُخِيفُ",imperative:"أَخِفْ",masdar:"إِخَافَة",activePart:"مُخِيف",passivePart:"مُخَاف"}},
     {wordType:"noun",english:"Stability",arabicBase:"اِسْتِقْرَار",forms:{singular:"اِسْتِقْرَار"}},
     {wordType:"verb",english:"To release / launch",arabicBase:"أَطْلَقَ",forms:{past:"أَطْلَقَ",present:"يُطْلِقُ",imperative:"أَطْلِقْ",masdar:"إِطْلَاق",activePart:"مُطْلِق",passivePart:"مُطْلَق"}},
     {wordType:"noun",english:"Reassurance",arabicBase:"اِطْمِئْنَان",forms:{singular:"اِطْمِئْنَان"}},
     {wordType:"verb",english:"To search",arabicBase:"بَحَثَ",forms:{past:"بَحَثَ",present:"يَبْحَثُ",imperative:"اُبْحَثْ",masdar:"بَحْث",activePart:"بَاحِث",passivePart:"مَبْحُوث"}},
     {wordType:"noun",english:"History / date",arabicBase:"تَارِيخ",forms:{singular:"تَارِيخ"}},
     {wordType:"verb",english:"To cooperate",arabicBase:"تَعَاوَنَ",forms:{past:"تَعَاوَنَ",present:"يَتَعَاوَنُ",imperative:"تَعَاوَنْ",masdar:"تَعَاوُن",activePart:"مُتَعَاوِن"}},
     {wordType:"noun",english:"Hunger",arabicBase:"جُوع",forms:{singular:"جُوع"}},
     {wordType:"noun",english:"Accident",arabicBase:"حَادِث",forms:{singular:"حَادِث",plural:"حَوَادِث"}},
     {wordType:"noun",english:"Border / limit",arabicBase:"حَدّ",forms:{singular:"حَدّ",plural:"حُدُود"}},
     {wordType:"noun",english:"Map",arabicBase:"خَرِيطَة",forms:{singular:"خَرِيطَة",plural:"خَرَائِط"}},
     {wordType:"noun",english:"Fear",arabicBase:"خَوْف",forms:{singular:"خَوْف"}},
     {wordType:"noun",english:"Industry",arabicBase:"صِنَاعَة",forms:{singular:"صِنَاعَة",plural:"صِنَاعَات"}},
     {wordType:"adjective",english:"Weak",arabicBase:"ضَعِيف",forms:{singular:"ضَعِيف",feminine:"ضَعِيفَة",plural:"ضُعَفَاء"}},
     {wordType:"noun",english:"Punishment",arabicBase:"عُقُوبَة",forms:{singular:"عُقُوبَة",plural:"عُقُوبَات"}},
     {wordType:"noun",english:"Food / nourishment",arabicBase:"غِذَاء",forms:{singular:"غِذَاء"}},
     {wordType:"noun",english:"Decision",arabicBase:"قَرَار",forms:{singular:"قَرَار",plural:"قَرَارَات"}},
     {wordType:"noun",english:"Issue / case",arabicBase:"قَضِيَّة",forms:{singular:"قَضِيَّة",plural:"قَضَايَا"}},
     {wordType:"noun",english:"Law",arabicBase:"قَانُون",forms:{singular:"قَانُون",plural:"قَوَانِين"}},
     {wordType:"noun",english:"Criminal",arabicBase:"مُجْرِم",forms:{singular:"مُجْرِم",plural:"مُجْرِمُون"}},
     {wordType:"noun",english:"The Security Council",arabicBase:"مَجْلِسُ الأَمْن",forms:{singular:"مَجْلِسُ الأَمْن"}},
     {wordType:"adjective",english:"Active",arabicBase:"نَشِيط",forms:{singular:"نَشِيط",feminine:"نَشِيطَة",plural:"نَشِيطُون"}},
   ]},
  {id:"preset-byy2-u15", title:"Bayna Yadayk Book 2 · Unit 15 — Pollution", unitId:"2-15", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"noun",english:"Burning",arabicBase:"إِحْرَاق",forms:{singular:"إِحْرَاق"}},
     {wordType:"noun",english:"Waste / excess",arabicBase:"إِسْرَاف",forms:{singular:"إِسْرَاف"}},
     {wordType:"noun",english:"Tree",arabicBase:"شَجَرَة",forms:{singular:"شَجَرَة",plural:"أَشْجَار"}},
     {wordType:"verb",english:"To throw / dump",arabicBase:"أَلْقَى",forms:{past:"أَلْقَى",present:"يُلْقِي",imperative:"أَلْقِ",masdar:"إِلْقَاء",activePart:"مُلْقٍ",passivePart:"مُلْقًى"}},
     {wordType:"noun",english:"Sea",arabicBase:"بَحْر",forms:{singular:"بَحْر",plural:"بِحَار"}},
     {wordType:"noun",english:"Soil",arabicBase:"تُرْبَة",forms:{singular:"تُرْبَة"}},
     {wordType:"noun",english:"Desertification",arabicBase:"تَصَحُّر",forms:{singular:"تَصَحُّر"}},
     {wordType:"verb",english:"To protect",arabicBase:"حَمَى",forms:{past:"حَمَى",present:"يَحْمِي",imperative:"اِحْمِ",masdar:"حِمَايَة",activePart:"حَامٍ",passivePart:"مَحْمِيّ"}},
     {wordType:"verb",english:"To fear",arabicBase:"خَافَ",forms:{past:"خَافَ",present:"يَخَافُ",imperative:"خَفْ",masdar:"خَوْف",activePart:"خَائِف"}},
     {wordType:"verb",english:"To bury",arabicBase:"دَفَنَ",forms:{past:"دَفَنَ",present:"يَدْفِنُ",imperative:"اُدْفُنْ",masdar:"دَفْن",activePart:"دَافِن",passivePart:"مَدْفُون"}},
     {wordType:"noun",english:"Smell",arabicBase:"رَائِحَة",forms:{singular:"رَائِحَة",plural:"رَوَائِح"}},
     {wordType:"verb",english:"To plant",arabicBase:"زَرَعَ",forms:{past:"زَرَعَ",present:"يَزْرَعُ",imperative:"اُزْرَعْ",masdar:"زَرْع",activePart:"زَارِع",passivePart:"مَزْرُوع"}},
     {wordType:"noun",english:"Agriculture",arabicBase:"زِرَاعَة",forms:{singular:"زِرَاعَة"}},
     {wordType:"noun",english:"Cancer",arabicBase:"سَرَطَان",forms:{singular:"سَرَطَان"}},
     {wordType:"noun",english:"Spring (water)",arabicBase:"عَيْن",forms:{singular:"عَيْن",plural:"عُيُون"}},
     {wordType:"verb",english:"To die",arabicBase:"مَاتَ",forms:{past:"مَاتَ",present:"يَمُوتُ",imperative:"مُتْ",masdar:"مَوْت",activePart:"مَيِّت"}},
     {wordType:"noun",english:"Preservation",arabicBase:"مُحَافَظَة",forms:{singular:"مُحَافَظَة"}},
     {wordType:"noun",english:"Death",arabicBase:"مَوْت",forms:{singular:"مَوْت"}},
     {wordType:"noun",english:"Water",arabicBase:"مَاء",forms:{singular:"مَاء",plural:"مِيَاه"}},
     {wordType:"adjective",english:"Rare",arabicBase:"نَادِر",forms:{singular:"نَادِر",feminine:"نَادِرَة"}},
     {wordType:"noun",english:"Plant",arabicBase:"نَبَات",forms:{singular:"نَبَات",plural:"نَبَاتَات"}},
   ]},
  {id:"preset-byy2-u16", title:"Bayna Yadayk Book 2 · Unit 16 — Energy", unitId:"2-16", level:"book2", seriesId:BYY2P2_SERIES,
   cards:[
     {wordType:"noun",english:"Electrical appliance",arabicBase:"جِهَازٌ كَهْرَبَائِيّ",forms:{singular:"جِهَازٌ كَهْرَبَائِيّ",plural:"أَجْهِزَة كَهْرَبَائِيَّة"}},
     {wordType:"verb",english:"To increase",arabicBase:"اِزْدَادَ",forms:{past:"اِزْدَادَ",present:"يَزْدَادُ",imperative:"اِزْدَدْ",masdar:"اِزْدِيَاد",activePart:"مُزْدَاد"}},
     {wordType:"verb",english:"To exploit",arabicBase:"اِسْتَغَلَّ",forms:{past:"اِسْتَغَلَّ",present:"يَسْتَغِلُّ",imperative:"اِسْتَغِلَّ",masdar:"اِسْتِغْلَال",activePart:"مُسْتَغِلّ",passivePart:"مُسْتَغَلّ"}},
     {wordType:"verb",english:"To benefit",arabicBase:"اِسْتَفَادَ",forms:{past:"اِسْتَفَادَ",present:"يَسْتَفِيدُ",imperative:"اِسْتَفِدْ",masdar:"اِسْتِفَادَة",activePart:"مُسْتَفِيد"}},
     {wordType:"verb",english:"To consume",arabicBase:"اِسْتَهْلَكَ",forms:{past:"اِسْتَهْلَكَ",present:"يَسْتَهْلِكُ",imperative:"اِسْتَهْلِكْ",masdar:"اِسْتِهْلَاك",activePart:"مُسْتَهْلِك",passivePart:"مُسْتَهْلَك"}},
     {wordType:"noun",english:"Price",arabicBase:"سِعْر",forms:{singular:"سِعْر",plural:"أَسْعَار"}},
     {wordType:"noun",english:"Lighting",arabicBase:"إِضَاءَة",forms:{singular:"إِضَاءَة"}},
     {wordType:"verb",english:"To decrease",arabicBase:"اِنْخَفَضَ",forms:{past:"اِنْخَفَضَ",present:"يَنْخَفِضُ",imperative:"اِنْخَفِضْ",masdar:"اِنْخِفَاض",activePart:"مُنْخَفِض"}},
     {wordType:"noun",english:"Plastic",arabicBase:"بِلَاسْتِيك",forms:{singular:"بِلَاسْتِيك"}},
     {wordType:"noun",english:"Heating",arabicBase:"تَدْفِئَة",forms:{singular:"تَدْفِئَة"}},
     {wordType:"verb",english:"To renew",arabicBase:"جَدَّدَ",forms:{past:"جَدَّدَ",present:"يُجَدِّدُ",imperative:"جَدِّدْ",masdar:"تَجْدِيد",activePart:"مُجَدِّد",passivePart:"مُجَدَّد"}},
     {wordType:"verb",english:"To mix",arabicBase:"خَلَطَ",forms:{past:"خَلَطَ",present:"يَخْلِطُ",imperative:"اِخْلِطْ",masdar:"خَلْط",activePart:"خَالِط",passivePart:"مَخْلُوط"}},
     {wordType:"noun",english:"Black gold (petroleum)",arabicBase:"ذَهَبٌ أَسْوَد",forms:{singular:"ذَهَبٌ أَسْوَد"}},
     {wordType:"noun",english:"Truck",arabicBase:"شَاحِنَة",forms:{singular:"شَاحِنَة",plural:"شَاحِنَات"}},
     {wordType:"verb",english:"To export",arabicBase:"صَدَّرَ",forms:{past:"صَدَّرَ",present:"يُصَدِّرُ",imperative:"صَدِّرْ",masdar:"تَصْدِير",activePart:"مُصَدِّر",passivePart:"مُصَدَّر"}},
     {wordType:"verb",english:"To double",arabicBase:"ضَاعَفَ",forms:{past:"ضَاعَفَ",present:"يُضَاعِفُ",imperative:"ضَاعِفْ",masdar:"مُضَاعَفَة",activePart:"مُضَاعِف",passivePart:"مُضَاعَف"}},
     {wordType:"noun",english:"Solar energy",arabicBase:"طَاقَةٌ شَمْسِيَّة",forms:{singular:"طَاقَةٌ شَمْسِيَّة"}},
     {wordType:"noun",english:"Coal",arabicBase:"فَحْمٌ حَجَرِيّ",forms:{singular:"فَحْمٌ حَجَرِيّ"}},
     {wordType:"noun",english:"Electricity",arabicBase:"كَهْرَبَاء",forms:{singular:"كَهْرَبَاء"}},
     {wordType:"noun",english:"Source",arabicBase:"مَصْدَر",forms:{singular:"مَصْدَر",plural:"مَصَادِر"}},
     {wordType:"noun",english:"Fuel",arabicBase:"وَقُود",forms:{singular:"وَقُود"}},
   ]},
  {id:"preset-byy3-u1", title:"Bayna Yadayk Book 3 · Unit 1 — The Eternal Miracle", unitId:"3-1", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"noun",english:"Prophet",arabicBase:"نَبِيّ",forms:{singular:"نَبِيّ",plural:"أَنْبِيَاء"}},
     {wordType:"noun",english:"Mankind (as a species)",arabicBase:"إِنْس",forms:{singular:"إِنْس"}},
     {wordType:"verb",english:"To send down / reveal",arabicBase:"أَنْزَلَ",forms:{past:"أَنْزَلَ",present:"يُنْزِلُ",imperative:"أَنْزِلْ",masdar:"إِنْزَال",activePart:"مُنْزِل",passivePart:"مُنْزَل"}},
     {wordType:"verb",english:"To challenge",arabicBase:"تَحَدَّى",forms:{past:"تَحَدَّى",present:"يَتَحَدَّى",imperative:"تَحَدَّ",masdar:"تَحَدٍّ",activePart:"مُتَحَدٍّ"}},
     {wordType:"noun",english:"Means / medium",arabicBase:"وَاسِطَة",forms:{singular:"وَاسِطَة",plural:"وَسَائِط"}},
     {wordType:"verb",english:"To pass away",arabicBase:"تَوَفَّى",forms:{past:"تَوَفَّى",present:"يَتَوَفَّى",imperative:"تَوَفَّ",masdar:"تَوَفٍّ",activePart:"مُتَوَفٍّ"}},
     {wordType:"noun",english:"Jinn",arabicBase:"جِنّ",forms:{singular:"جِنّ"}},
     {wordType:"noun",english:"Struggle / striving",arabicBase:"جِهَاد",forms:{singular:"جِهَاد"}},
     {wordType:"noun",english:"Wisdom",arabicBase:"حِكْمَة",forms:{singular:"حِكْمَة",plural:"حِكَم"}},
     {wordType:"noun",english:"Right (entitlement)",arabicBase:"حَقّ",forms:{singular:"حَقّ",plural:"حُقُوق"}},
     {wordType:"verb",english:"To indicate / point to",arabicBase:"دَلَّ",forms:{past:"دَلَّ",present:"يَدُلُّ",imperative:"دُلَّ",masdar:"دَلَالَة",activePart:"دَالّ",passivePart:"مَدْلُول",harf:"عَلَى"}},
     {wordType:"adjective",english:"Previous / former",arabicBase:"سَابِق",forms:{singular:"سَابِق",feminine:"سَابِقَة",plural:"سَابِقُون"}},
     {wordType:"verb",english:"To be safe / unharmed",arabicBase:"سَلِمَ",forms:{past:"سَلِمَ",present:"يَسْلَمُ",imperative:"اِسْلَمْ",masdar:"سَلَامَة",activePart:"سَالِم"}},
     {wordType:"adjective",english:"Comprehensive",arabicBase:"شَامِل",forms:{singular:"شَامِل",feminine:"شَامِلَة"}},
     {wordType:"noun",english:"Surah (Qur'an chapter)",arabicBase:"سُورَة",forms:{singular:"سُورَة",plural:"سُوَر"}},
     {wordType:"noun",english:"Companion of the Prophet",arabicBase:"صَحَابِيّ",forms:{singular:"صَحَابِيّ",plural:"صَحَابَة"}},
     {wordType:"noun",english:"Lesson / moral",arabicBase:"عِبْرَة",forms:{singular:"عِبْرَة",plural:"عِبَر"}},
     {wordType:"noun",english:"Staff / stick",arabicBase:"عَصًا",forms:{singular:"عَصًا",plural:"عِصِيّ"}},
     {wordType:"noun",english:"Creed / belief",arabicBase:"عَقِيدَة",forms:{singular:"عَقِيدَة",plural:"عَقَائِد"}},
     {wordType:"noun",english:"Tribulation / temptation",arabicBase:"فِتْنَة",forms:{singular:"فِتْنَة",plural:"فِتَن"}},
     {wordType:"noun",english:"Religious obligation",arabicBase:"فَرِيضَة",forms:{singular:"فَرِيضَة",plural:"فَرَائِض"}},
     {wordType:"noun",english:"Reciter (of Qur'an)",arabicBase:"قَارِئ",forms:{singular:"قَارِئ",plural:"قُرَّاء"}},
     {wordType:"noun",english:"Heart",arabicBase:"قَلْب",forms:{singular:"قَلْب",plural:"قُلُوب"}},
     {wordType:"adjective",english:"Material / physical",arabicBase:"مَادِّيّ",forms:{singular:"مَادِّيّ",feminine:"مَادِّيَّة"}},
     {wordType:"noun",english:"Apostate",arabicBase:"مُرْتَدّ",forms:{singular:"مُرْتَدّ",plural:"مُرْتَدُّون"}},
     {wordType:"noun",english:"Knowledge",arabicBase:"مَعْرِفَة",forms:{singular:"مَعْرِفَة",plural:"مَعَارِف"}},
     {wordType:"noun",english:"Miracle",arabicBase:"مُعْجِزَة",forms:{singular:"مُعْجِزَة",plural:"مُعْجِزَات"}},
     {wordType:"adjective",english:"Moral / abstract",arabicBase:"مَعْنَوِيّ",forms:{singular:"مَعْنَوِيّ",feminine:"مَعْنَوِيَّة"}},
     {wordType:"noun",english:"She-camel",arabicBase:"نَاقَة",forms:{singular:"نَاقَة",plural:"نُوق"}},
     {wordType:"noun",english:"Descent / revelation",arabicBase:"نُزُول",forms:{singular:"نُزُول"}},
     {wordType:"noun",english:"Copy",arabicBase:"نُسْخَة",forms:{singular:"نُسْخَة",plural:"نُسَخ"}},
     {wordType:"noun",english:"The seven modes (of Qur'an recitation)",arabicBase:"الأَحْرُفُ السَّبْعَة",forms:{singular:"الأَحْرُفُ السَّبْعَة"}},
     {wordType:"noun",english:"The Oneness of God",arabicBase:"وَحْدَانِيَّةُ الله",forms:{singular:"وَحْدَانِيَّةُ الله"}},
     {wordType:"noun",english:"The Day of Resurrection",arabicBase:"يَوْمُ القِيَامَة",forms:{singular:"يَوْمُ القِيَامَة"}},
   ]},
  {id:"preset-byy3-u2", title:"Bayna Yadayk Book 3 · Unit 2 — A Day in a Youth's Life", unitId:"3-2", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"noun",english:"Pious person",arabicBase:"تَقِيّ",forms:{singular:"تَقِيّ",plural:"أَتْقِيَاء"}},
     {wordType:"noun",english:"Sincerity",arabicBase:"إِخْلَاص",forms:{singular:"إِخْلَاص"}},
     {wordType:"noun",english:"Virtuous person",arabicBase:"خَيِّر",forms:{singular:"خَيِّر",plural:"أَخْيَار"}},
     {wordType:"noun",english:"Etiquette of the road",arabicBase:"آدَابُ الطَّرِيق",forms:{singular:"آدَابُ الطَّرِيق"}},
     {wordType:"noun",english:"Supplication",arabicBase:"دُعَاء",forms:{singular:"دُعَاء",plural:"أَدْعِيَة"}},
     {wordType:"verb",english:"To face",arabicBase:"اِسْتَقْبَلَ",forms:{past:"اِسْتَقْبَلَ",present:"يَسْتَقْبِلُ",imperative:"اِسْتَقْبِلْ",masdar:"اِسْتِقْبَال",activePart:"مُسْتَقْبِل",passivePart:"مُسْتَقْبَل"}},
     {wordType:"verb",english:"To turn one's back to",arabicBase:"اِسْتَدْبَرَ",forms:{past:"اِسْتَدْبَرَ",present:"يَسْتَدْبِرُ",imperative:"اِسْتَدْبِرْ",masdar:"اِسْتِدْبَار",activePart:"مُسْتَدْبِر"}},
     {wordType:"noun",english:"Remembrance (of God)",arabicBase:"ذِكْر",forms:{singular:"ذِكْر",plural:"أَذْكَار"}},
     {wordType:"noun",english:"Supervision",arabicBase:"إِشْرَاف",forms:{singular:"إِشْرَاف"}},
     {wordType:"verb",english:"To waste / lose",arabicBase:"أَضَاعَ",forms:{past:"أَضَاعَ",present:"يُضِيعُ",imperative:"أَضِعْ",masdar:"إِضَاعَة",activePart:"مُضِيع",passivePart:"مُضَاع"}},
     {wordType:"noun",english:"Spreading greetings of peace",arabicBase:"إِفْشَاءُ السَّلَام",forms:{singular:"إِفْشَاءُ السَّلَام"}},
     {wordType:"noun",english:"Blessing",arabicBase:"بَرَكَة",forms:{singular:"بَرَكَة",plural:"بَرَكَات"}},
     {wordType:"noun",english:"A few (number)",arabicBase:"بِضْع",forms:{singular:"بِضْع"}},
     {wordType:"verb",english:"To avoid",arabicBase:"تَجَنَّبَ",forms:{past:"تَجَنَّبَ",present:"يَتَجَنَّبُ",imperative:"تَجَنَّبْ",masdar:"تَجَنُّب",activePart:"مُتَجَنِّب",passivePart:"مُتَجَنَّب"}},
     {wordType:"noun",english:"Exercise",arabicBase:"تَمْرِين",forms:{singular:"تَمْرِين",plural:"تَمَارِين"}},
     {wordType:"verb",english:"To be keen on",arabicBase:"حَرِصَ",forms:{past:"حَرِصَ",present:"يَحْرِصُ",imperative:"اِحْرِصْ",masdar:"حِرْص",activePart:"حَرِيص",harf:"عَلَى"}},
     {wordType:"noun",english:"Side",arabicBase:"جَنْب",forms:{singular:"جَنْب"}},
     {wordType:"verb",english:"To have mercy on",arabicBase:"رَحِمَ",forms:{past:"رَحِمَ",present:"يَرْحَمُ",imperative:"اِرْحَمْ",masdar:"رَحْمَة",activePart:"رَاحِم",passivePart:"مَرْحُوم"}},
     {wordType:"verb",english:"To control",arabicBase:"ضَبَطَ",forms:{past:"ضَبَطَ",present:"يَضْبِطُ",imperative:"اُضْبُطْ",masdar:"ضَبْط",activePart:"ضَابِط",passivePart:"مَضْبُوط"}},
     {wordType:"verb",english:"To lower (one's gaze)",arabicBase:"غَضَّ",forms:{past:"غَضَّ",present:"يَغُضُّ",imperative:"غُضَّ",masdar:"غَضّ",activePart:"غَاضّ",passivePart:"مَغْضُوض",harf:"مِنْ"}},
     {wordType:"adjective",english:"Truthful",arabicBase:"صَادِق",forms:{singular:"صَادِق",feminine:"صَادِقَة"}},
     {wordType:"adjective",english:"Heedless",arabicBase:"غَافِل",forms:{singular:"غَافِل",feminine:"غَافِلَة"}},
     {wordType:"verb",english:"To be able to",arabicBase:"قَدَرَ",forms:{past:"قَدَرَ",present:"يَقْدِرُ",imperative:"اِقْدِرْ",masdar:"قُدْرَة",activePart:"قَادِر",harf:"عَلَى"}},
     {wordType:"noun",english:"Disbeliever",arabicBase:"كَافِر",forms:{singular:"كَافِر",plural:"كُفَّار"}},
     {wordType:"verb",english:"To grow up",arabicBase:"كَبِرَ",forms:{past:"كَبِرَ",present:"يَكْبُرُ",imperative:"اُكْبُرْ",masdar:"كِبَر",activePart:"كَبِير"}},
     {wordType:"adjective",english:"Filled / full",arabicBase:"مَمْلُوء",forms:{singular:"مَمْلُوء",feminine:"مَمْلُوءَة"}},
     {wordType:"adjective",english:"Well-done / perfected",arabicBase:"مُتْقَن",forms:{singular:"مُتْقَن",feminine:"مُتْقَنَة"}},
     {wordType:"noun",english:"Young person / youth",arabicBase:"نَاشِئ",forms:{singular:"نَاشِئ",plural:"نَاشِئُون"}},
     {wordType:"noun",english:"Impurity",arabicBase:"نَجَاسَة",forms:{singular:"نَجَاسَة",plural:"نَجَاسَات"}},
     {wordType:"adjective",english:"Purposeful",arabicBase:"هَادِف",forms:{singular:"هَادِف",feminine:"هَادِفَة"}},
     {wordType:"noun",english:"Duty",arabicBase:"وَاجِب",forms:{singular:"وَاجِب",plural:"وَاجِبَات"}},
     {wordType:"noun",english:"Left (hand)",arabicBase:"يُسْرَى",forms:{singular:"يُسْرَى"}},
     {wordType:"noun",english:"Right (hand)",arabicBase:"يُمْنَى",forms:{singular:"يُمْنَى"}},
   ]},
  {id:"preset-byy3-u3", title:"Bayna Yadayk Book 3 · Unit 3 — Our Minorities in the World", unitId:"3-3", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"adjective",english:"Social",arabicBase:"اِجْتِمَاعِيّ",forms:{singular:"اِجْتِمَاعِيّ",feminine:"اِجْتِمَاعِيَّة"}},
     {wordType:"verb",english:"To permit / allow",arabicBase:"أَبَاحَ",forms:{past:"أَبَاحَ",present:"يُبِيحُ",imperative:"أَبِحْ",masdar:"إِبَاحَة",activePart:"مُبِيح",passivePart:"مُبَاح"}},
     {wordType:"noun",english:"Procedure",arabicBase:"إِجْرَاء",forms:{singular:"إِجْرَاء",plural:"إِجْرَاءَات"}},
     {wordType:"noun",english:"Part",arabicBase:"جُزْء",forms:{singular:"جُزْء",plural:"أَجْزَاء"}},
     {wordType:"noun",english:"Term / appointed time",arabicBase:"أَجَل",forms:{singular:"أَجَل",harf:"مِنْ"}},
     {wordType:"verb",english:"To agree unanimously",arabicBase:"أَجْمَعَ",forms:{past:"أَجْمَعَ",present:"يُجْمِعُ",imperative:"أَجْمِعْ",masdar:"إِجْمَاع",activePart:"مُجْمِع",passivePart:"مُجْمَع",harf:"عَلَى"}},
     {wordType:"verb",english:"To make lawful",arabicBase:"أَحَلَّ",forms:{past:"أَحَلَّ",present:"يُحِلُّ",imperative:"أَحِلَّ",masdar:"إِحْلَال",activePart:"مُحِلّ",passivePart:"مُحَلّ"}},
     {wordType:"noun",english:"Mixing / intermingling",arabicBase:"اِخْتِلَاط",forms:{singular:"اِخْتِلَاط"}},
     {wordType:"verb",english:"To settle / become stable",arabicBase:"اِسْتَقَرَّ",forms:{past:"اِسْتَقَرَّ",present:"يَسْتَقِرُّ",imperative:"اِسْتَقِرَّ",masdar:"اِسْتِقْرَار",activePart:"مُسْتَقِرّ"}},
     {wordType:"noun",english:"Minority",arabicBase:"أَقَلِّيَّة",forms:{singular:"أَقَلِّيَّة",plural:"أَقَلِّيَّات"}},
     {wordType:"verb",english:"To complete",arabicBase:"أَكْمَلَ",forms:{past:"أَكْمَلَ",present:"يُكْمِلُ",imperative:"أَكْمِلْ",masdar:"إِكْمَال",activePart:"مُكْمِل",passivePart:"مُكْمَل"}},
     {wordType:"verb",english:"To establish",arabicBase:"أَنْشَأَ",forms:{past:"أَنْشَأَ",present:"يُنْشِئُ",imperative:"أَنْشِئْ",masdar:"إِنْشَاء",activePart:"مُنْشِئ",passivePart:"مُنْشَأ"}},
     {wordType:"noun",english:"Specification / allocation",arabicBase:"تَخْصِيص",forms:{singular:"تَخْصِيص"}},
     {wordType:"noun",english:"Polygamy",arabicBase:"تَعَدُّدُ الزَّوْجَات",forms:{singular:"تَعَدُّدُ الزَّوْجَات"}},
     {wordType:"noun",english:"Distribution",arabicBase:"تَوْزِيع",forms:{singular:"تَوْزِيع"}},
     {wordType:"noun",english:"Veil",arabicBase:"حِجَاب",forms:{singular:"حِجَاب",plural:"أَحْجِبَة"}},
     {wordType:"verb",english:"To slaughter",arabicBase:"ذَبَحَ",forms:{past:"ذَبَحَ",present:"يَذْبَحُ",imperative:"اُذْبَحْ",masdar:"ذَبْح",activePart:"ذَابِح",passivePart:"مَذْبُوح"}},
     {wordType:"verb",english:"To provide sustenance",arabicBase:"رَزَقَ",forms:{past:"رَزَقَ",present:"يَرْزُقُ",imperative:"اُرْزُقْ",masdar:"رِزْق",activePart:"رَازِق",passivePart:"مَرْزُوق"}},
     {wordType:"noun",english:"Authority / power",arabicBase:"سُلْطَة",forms:{singular:"سُلْطَة",plural:"سُلُطَات"}},
     {wordType:"noun",english:"Box / fund",arabicBase:"صُنْدُوق",forms:{singular:"صُنْدُوق",plural:"صَنَادِيق"}},
     {wordType:"verb",english:"To expel",arabicBase:"طَرَدَ",forms:{past:"طَرَدَ",present:"يَطْرُدُ",imperative:"اُطْرُدْ",masdar:"طَرْد",activePart:"طَارِد",passivePart:"مَطْرُود"}},
     {wordType:"noun",english:"Law",arabicBase:"قَانُون",forms:{singular:"قَانُون",plural:"قَوَانِين"}},
     {wordType:"noun",english:"Ability / power",arabicBase:"قُدْرَة",forms:{singular:"قُدْرَة",plural:"قُدُرَات"}},
     {wordType:"noun",english:"Issue / case",arabicBase:"قَضِيَّة",forms:{singular:"قَضِيَّة",plural:"قَضَايَا"}},
     {wordType:"verb",english:"To restrict",arabicBase:"قَيَّدَ",forms:{past:"قَيَّدَ",present:"يُقَيِّدُ",imperative:"قَيِّدْ",masdar:"تَقْيِيد",activePart:"مُقَيِّد",passivePart:"مُقَيَّد"}},
     {wordType:"verb",english:"To resort to / take refuge",arabicBase:"لَجَأَ",forms:{past:"لَجَأَ",present:"يَلْجَأُ",imperative:"اِلْجَأْ",masdar:"لُجُوء",activePart:"لَاجِئ",harf:"إِلَى"}},
     {wordType:"adjective",english:"Civil",arabicBase:"مَدَنِيّ",forms:{singular:"مَدَنِيّ",feminine:"مَدَنِيَّة"}},
     {wordType:"noun",english:"Cemetery",arabicBase:"مَقْبَرَة",forms:{singular:"مَقْبَرَة",plural:"مَقَابِر"}},
     {wordType:"noun",english:"Inheritance",arabicBase:"مِيرَاث",forms:{singular:"مِيرَاث"}},
     {wordType:"noun",english:"Ministry",arabicBase:"وِزَارَة",forms:{singular:"وِزَارَة",plural:"وِزَارَات"}},
   ]},
  {id:"preset-byy3-u4", title:"Bayna Yadayk Book 3 · Unit 4 — The Prophetic Sunnah", unitId:"3-4", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"verb",english:"To follow",arabicBase:"اِتَّبَعَ",forms:{past:"اِتَّبَعَ",present:"يَتَّبِعُ",imperative:"اِتَّبِعْ",masdar:"اِتِّبَاع",activePart:"مُتَّبِع",passivePart:"مُتَّبَع"}},
     {wordType:"verb",english:"To master / perfect",arabicBase:"أَتْقَنَ",forms:{past:"أَتْقَنَ",present:"يُتْقِنُ",imperative:"أَتْقِنْ",masdar:"إِتْقَان",activePart:"مُتْقِن",passivePart:"مُتْقَن"}},
     {wordType:"verb",english:"To seize (an opportunity)",arabicBase:"اِغْتَنَمَ",forms:{past:"اِغْتَنَمَ",present:"يَغْتَنِمُ",imperative:"اِغْتَنِمْ",masdar:"اِغْتِنَام",activePart:"مُغْتَنِم",passivePart:"مُغْتَنَم"}},
     {wordType:"verb",english:"To care about",arabicBase:"اِهْتَمَّ",forms:{past:"اِهْتَمَّ",present:"يَهْتَمُّ",imperative:"اِهْتَمَّ",masdar:"اِهْتِمَام",activePart:"مُهْتَمّ",harf:"بِـ"}},
     {wordType:"noun",english:"Deed / action",arabicBase:"فِعْل",forms:{singular:"فِعْل",plural:"أَفْعَال"}},
     {wordType:"noun",english:"Saying / statement",arabicBase:"قَوْل",forms:{singular:"قَوْل",plural:"أَقْوَال"}},
     {wordType:"verb",english:"To advise / instruct",arabicBase:"أَوْصَى",forms:{past:"أَوْصَى",present:"يُوصِي",imperative:"أَوْصِ",masdar:"إِيصَاء",activePart:"مُوصٍ",passivePart:"مُوصًى"}},
     {wordType:"noun",english:"Righteousness / piety",arabicBase:"البِرّ",forms:{singular:"البِرّ"}},
     {wordType:"verb",english:"To send / dispatch",arabicBase:"بَعَثَ",forms:{past:"بَعَثَ",present:"يَبْعَثُ",imperative:"اُبْعَثْ",masdar:"بَعْث",activePart:"بَاعِث",passivePart:"مَبْعُوث"}},
     {wordType:"verb",english:"To build",arabicBase:"بَنَى",forms:{past:"بَنَى",present:"يَبْنِي",imperative:"اِبْنِ",masdar:"بِنَاء",activePart:"بَانٍ",passivePart:"مَبْنِيّ"}},
     {wordType:"verb",english:"To investigate / seek out",arabicBase:"تَحَرَّى",forms:{past:"تَحَرَّى",present:"يَتَحَرَّى",imperative:"تَحَرَّ",masdar:"تَحَرٍّ",activePart:"مُتَحَرٍّ"}},
     {wordType:"noun",english:"Verification / scrutiny",arabicBase:"تَدْقِيق",forms:{singular:"تَدْقِيق"}},
     {wordType:"noun",english:"Recording / codification",arabicBase:"تَدْوِين",forms:{singular:"تَدْوِين"}},
     {wordType:"verb",english:"To forbid",arabicBase:"حَرَّمَ",forms:{past:"حَرَّمَ",present:"يُحَرِّمُ",imperative:"حَرِّمْ",masdar:"تَحْرِيم",activePart:"مُحَرِّم",passivePart:"مُحَرَّم"}},
     {wordType:"noun",english:"Sweetness",arabicBase:"حَلَاوَة",forms:{singular:"حَلَاوَة"}},
     {wordType:"noun",english:"Disease / ailment",arabicBase:"دَاء",forms:{singular:"دَاء",plural:"أَدْوَاء"}},
     {wordType:"noun",english:"Gentleness",arabicBase:"رِفْق",forms:{singular:"رِفْق"}},
     {wordType:"noun",english:"Narration",arabicBase:"رِوَايَة",forms:{singular:"رِوَايَة",plural:"رِوَايَات"}},
     {wordType:"noun",english:"Spirit / soul",arabicBase:"رُوح",forms:{singular:"رُوح",plural:"أَرْوَاح"}},
     {wordType:"verb",english:"To doubt",arabicBase:"شَكَّ",forms:{past:"شَكَّ",present:"يَشُكُّ",imperative:"شُكَّ",masdar:"شَكّ",activePart:"شَاكّ",harf:"فِي"}},
     {wordType:"verb",english:"To verify / authenticate",arabicBase:"صَحَّحَ",forms:{past:"صَحَّحَ",present:"يُصَحِّحُ",imperative:"صَحِّحْ",masdar:"تَصْحِيح",activePart:"مُصَحِّح",passivePart:"مُصَحَّح"}},
     {wordType:"verb",english:"To disobey",arabicBase:"عَصَى",forms:{past:"عَصَى",present:"يَعْصِي",imperative:"اِعْصِ",masdar:"عِصْيَان",activePart:"عَاصٍ",passivePart:"مَعْصِيّ"}},
     {wordType:"verb",english:"To slander / cast",arabicBase:"قَذَفَ",forms:{past:"قَذَفَ",present:"يَقْذِفُ",imperative:"اُقْذِفْ",masdar:"قَذْف",activePart:"قَاذِف",passivePart:"مَقْذُوف"}},
     {wordType:"verb",english:"To lie",arabicBase:"كَذَبَ",forms:{past:"كَذَبَ",present:"يَكْذِبُ",imperative:"اُكْذِبْ",masdar:"كَذِب",activePart:"كَاذِب"}},
     {wordType:"adjective",english:"Habitual liar",arabicBase:"كَذَّاب",forms:{singular:"كَذَّاب",feminine:"كَذَّابَة"}},
     {wordType:"verb",english:"To dislike / hate",arabicBase:"كَرِهَ",forms:{past:"كَرِهَ",present:"يَكْرَهُ",imperative:"اُكْرَهْ",masdar:"كَرَاهَة",activePart:"كَارِه",passivePart:"مَكْرُوه"}},
     {wordType:"noun",english:"Methodology",arabicBase:"مَنْهَج",forms:{singular:"مَنْهَج",plural:"مَنَاهِج"}},
     {wordType:"verb",english:"To guide",arabicBase:"هَدَى",forms:{past:"هَدَى",present:"يَهْدِي",imperative:"اِهْدِ",masdar:"هُدًى",activePart:"هَادٍ",passivePart:"مَهْدِيّ"}},
     {wordType:"noun",english:"Revelation",arabicBase:"وَحْي",forms:{singular:"وَحْي"}},
   ]},
  {id:"preset-byy3-u5", title:"Bayna Yadayk Book 3 · Unit 5 — Children & Reading", unitId:"3-5", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"verb",english:"To inform",arabicBase:"أَخْبَرَ",forms:{past:"أَخْبَرَ",present:"يُخْبِرُ",imperative:"أَخْبِرْ",masdar:"إِخْبَار",activePart:"مُخْبِر",passivePart:"مُخْبَر"}},
     {wordType:"noun",english:"Perception / comprehension",arabicBase:"إِدْرَاك",forms:{singular:"إِدْرَاك"}},
     {wordType:"noun",english:"Shape / form",arabicBase:"شَكْل",forms:{singular:"شَكْل",plural:"أَشْكَال"}},
     {wordType:"verb",english:"To please / impress",arabicBase:"أَعْجَبَ",forms:{past:"أَعْجَبَ",present:"يُعْجِبُ",imperative:"أَعْجِبْ",masdar:"إِعْجَاب",activePart:"مُعْجِب",passivePart:"مُعْجَب"}},
     {wordType:"verb",english:"To acquire",arabicBase:"اِكْتَسَبَ",forms:{past:"اِكْتَسَبَ",present:"يَكْتَسِبُ",imperative:"اِكْتَسِبْ",masdar:"اِكْتِسَاب",activePart:"مُكْتَسِب",passivePart:"مُكْتَسَب"}},
     {wordType:"noun",english:"Attention",arabicBase:"اِنْتِبَاه",forms:{singular:"اِنْتِبَاه"}},
     {wordType:"verb",english:"To extract / snatch",arabicBase:"اِنْتَزَعَ",forms:{past:"اِنْتَزَعَ",present:"يَنْتَزِعُ",imperative:"اِنْتَزِعْ",masdar:"اِنْتِزَاع",activePart:"مُنْتَزِع",passivePart:"مُنْتَزَع"}},
     {wordType:"verb",english:"To transform / change",arabicBase:"تَحَوَّلَ",forms:{past:"تَحَوَّلَ",present:"يَتَحَوَّلُ",imperative:"تَحَوَّلْ",masdar:"تَحَوُّل",activePart:"مُتَحَوِّل",harf:"إِلَى"}},
     {wordType:"noun",english:"Naming",arabicBase:"تَسْمِيَة",forms:{singular:"تَسْمِيَة"}},
     {wordType:"noun",english:"Comment / annotation",arabicBase:"تَعْلِيق",forms:{singular:"تَعْلِيق",plural:"تَعْلِيقَات"}},
     {wordType:"noun",english:"Tradition / imitation",arabicBase:"تَقْلِيد",forms:{singular:"تَقْلِيد",plural:"تَقَالِيد"}},
     {wordType:"noun",english:"Distinction",arabicBase:"تَمْيِيز",forms:{singular:"تَمْيِيز"}},
     {wordType:"verb",english:"To attract",arabicBase:"جَذَبَ",forms:{past:"جَذَبَ",present:"يَجْذِبُ",imperative:"اُجْذُبْ",masdar:"جَذْب",activePart:"جَاذِب",passivePart:"مَجْذُوب"}},
     {wordType:"noun",english:"Vocabulary (word stock)",arabicBase:"حَصِيلَة لُغَوِيَّة",forms:{singular:"حَصِيلَة لُغَوِيَّة"}},
     {wordType:"noun",english:"Intelligence",arabicBase:"ذَكَاء",forms:{singular:"ذَكَاء"}},
     {wordType:"verb",english:"To name",arabicBase:"سَمَّى",forms:{past:"سَمَّى",present:"يُسَمِّي",imperative:"سَمِّ",masdar:"تَسْمِيَة",activePart:"مُسَمٍّ",passivePart:"مُسَمًّى"}},
     {wordType:"noun",english:"Page",arabicBase:"صَفْحَة",forms:{singular:"صَفْحَة",plural:"صَفَحَات"}},
     {wordType:"verb",english:"To laugh",arabicBase:"ضَحِكَ",forms:{past:"ضَحِكَ",present:"يَضْحَكُ",imperative:"اِضْحَكْ",masdar:"ضَحِك",activePart:"ضَاحِك"}},
     {wordType:"noun",english:"Phenomenon",arabicBase:"ظَاهِرَة",forms:{singular:"ظَاهِرَة",plural:"ظَوَاهِر"}},
     {wordType:"adjective",english:"Fleeting / transient",arabicBase:"عَابِر",forms:{singular:"عَابِر",feminine:"عَابِرَة"}},
     {wordType:"verb",english:"To evaluate",arabicBase:"قَيَّمَ",forms:{past:"قَيَّمَ",present:"يُقَيِّمُ",imperative:"قَيِّمْ",masdar:"تَقْيِيم",activePart:"مُقَيِّم",passivePart:"مُقَيَّم"}},
     {wordType:"verb",english:"To extend",arabicBase:"مَدَّ",forms:{past:"مَدَّ",present:"يَمُدُّ",imperative:"مُدَّ",masdar:"مَدّ",activePart:"مَادّ",passivePart:"مَمْدُود"}},
     {wordType:"noun",english:"Flexibility",arabicBase:"مُرُونَة",forms:{singular:"مُرُونَة"}},
     {wordType:"adjective",english:"Contemporary",arabicBase:"مُعَاصِر",forms:{singular:"مُعَاصِر",feminine:"مُعَاصِرَة"}},
     {wordType:"adjective",english:"Adventurous",arabicBase:"مُغَامِر",forms:{singular:"مُغَامِر",feminine:"مُغَامِرَة"}},
     {wordType:"noun",english:"Key",arabicBase:"مِفْتَاح",forms:{singular:"مِفْتَاح",plural:"مَفَاتِيح"}},
     {wordType:"noun",english:"Concept",arabicBase:"مَفْهُوم",forms:{singular:"مَفْهُوم",plural:"مَفَاهِيم"}},
     {wordType:"adjective",english:"Colored",arabicBase:"مُلَوَّن",forms:{singular:"مُلَوَّن",feminine:"مُلَوَّنَة"}},
     {wordType:"noun",english:"Text",arabicBase:"نَصّ",forms:{singular:"نَصّ",plural:"نُصُوص"}},
     {wordType:"adjective",english:"Clear",arabicBase:"وَاضِح",forms:{singular:"وَاضِح",feminine:"وَاضِحَة"}},
     {wordType:"adjective",english:"Realistic",arabicBase:"وَاقِعِيّ",forms:{singular:"وَاقِعِيّ",feminine:"وَاقِعِيَّة"}},
   ]},
  {id:"preset-byy3-u6", title:"Bayna Yadayk Book 3 · Unit 6 — Brain Drain", unitId:"3-6", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"verb",english:"To deserve",arabicBase:"اِسْتَحَقَّ",forms:{past:"اِسْتَحَقَّ",present:"يَسْتَحِقُّ",imperative:"اِسْتَحِقَّ",masdar:"اِسْتِحْقَاق",activePart:"مُسْتَحِقّ",passivePart:"مُسْتَحَقّ"}},
     {wordType:"verb",english:"To be forced / compelled",arabicBase:"اُضْطُرَّ",forms:{past:"اُضْطُرَّ",present:"يُضْطَرُّ",masdar:"اِضْطِرَار",activePart:"مُضْطَرّ"}},
     {wordType:"verb",english:"To confirm / emphasize",arabicBase:"أَكَّدَ",forms:{past:"أَكَّدَ",present:"يُؤَكِّدُ",imperative:"أَكِّدْ",masdar:"تَأْكِيد",activePart:"مُؤَكِّد",passivePart:"مُؤَكَّد"}},
     {wordType:"verb",english:"To hope",arabicBase:"أَمِلَ",forms:{past:"أَمِلَ",present:"يَأْمَلُ",imperative:"اِئْمَلْ",masdar:"أَمَل",activePart:"آمِل"}},
     {wordType:"noun",english:"Absence / lack",arabicBase:"اِنْعِدَام",forms:{singular:"اِنْعِدَام"}},
     {wordType:"verb",english:"To turn / be overturned",arabicBase:"اِنْقَلَبَ",forms:{past:"اِنْقَلَبَ",present:"يَنْقَلِبُ",imperative:"اِنْقَلِبْ",masdar:"اِنْقِلَاب",activePart:"مُنْقَلِب"}},
     {wordType:"noun",english:"Situation",arabicBase:"وَضْع",forms:{singular:"وَضْع",plural:"أَوْضَاع"}},
     {wordType:"noun",english:"Homeland",arabicBase:"وَطَن",forms:{singular:"وَطَن",plural:"أَوْطَان"}},
     {wordType:"noun",english:"Appointment",arabicBase:"تَعْيِين",forms:{singular:"تَعْيِين"}},
     {wordType:"noun",english:"Need",arabicBase:"حَاجَة",forms:{singular:"حَاجَة",plural:"حَاجَات"}},
     {wordType:"noun",english:"Freedom",arabicBase:"حُرِّيَّة",forms:{singular:"حُرِّيَّة",plural:"حُرِّيَّات"}},
     {wordType:"adjective",english:"Keen / eager",arabicBase:"حَرِيص",forms:{singular:"حَرِيص",feminine:"حَرِيصَة"}},
     {wordType:"verb",english:"To be sad",arabicBase:"حَزِنَ",forms:{past:"حَزِنَ",present:"يَحْزَنُ",imperative:"اِحْزَنْ",masdar:"حُزْن",activePart:"حَزِين"}},
     {wordType:"noun",english:"Confusion / bewilderment",arabicBase:"حَيْرَة",forms:{singular:"حَيْرَة"}},
     {wordType:"noun",english:"Campaign",arabicBase:"حَمْلَة",forms:{singular:"حَمْلَة",plural:"حَمَلَات"}},
     {wordType:"verb",english:"To rule / judge",arabicBase:"حَكَمَ",forms:{past:"حَكَمَ",present:"يَحْكُمُ",imperative:"اُحْكُمْ",masdar:"حُكْم",activePart:"حَاكِم",passivePart:"مَحْكُوم"}},
     {wordType:"noun",english:"Precision",arabicBase:"دِقَّة",forms:{singular:"دِقَّة"}},
     {wordType:"verb",english:"To contribute",arabicBase:"سَاهَمَ",forms:{past:"سَاهَمَ",present:"يُسَاهِمُ",imperative:"سَاهِمْ",masdar:"مُسَاهَمَة",activePart:"مُسَاهِم",harf:"فِي"}},
     {wordType:"verb",english:"To equal",arabicBase:"سَاوَى",forms:{past:"سَاوَى",present:"يُسَاوِي",imperative:"سَاوِ",masdar:"مُسَاوَاة",activePart:"مُسَاوٍ",passivePart:"مُسَاوًى"}},
     {wordType:"noun",english:"Badness / evil",arabicBase:"سُوء",forms:{singular:"سُوء"}},
     {wordType:"verb",english:"To design / determine",arabicBase:"صَمَّمَ",forms:{past:"صَمَّمَ",present:"يُصَمِّمُ",imperative:"صَمِّمْ",masdar:"تَصْمِيم",activePart:"مُصَمِّم",passivePart:"مُصَمَّم"}},
     {wordType:"noun",english:"Mind / intellect",arabicBase:"عَقْل",forms:{singular:"عَقْل",plural:"عُقُول"}},
     {wordType:"noun",english:"Return",arabicBase:"عَوْدَة",forms:{singular:"عَوْدَة"}},
     {wordType:"noun",english:"Opportunity",arabicBase:"فُرْصَة",forms:{singular:"فُرْصَة",plural:"فُرَص"}},
     {wordType:"adjective",english:"Distinguished / prestigious",arabicBase:"مَرْمُوق",forms:{singular:"مَرْمُوق",feminine:"مَرْمُوقَة"}},
     {wordType:"noun",english:"Status / standing",arabicBase:"مَكَانَة",forms:{singular:"مَكَانَة"}},
     {wordType:"adjective",english:"Absolute",arabicBase:"مُطْلَق",forms:{singular:"مُطْلَق",feminine:"مُطْلَقَة"}},
     {wordType:"verb",english:"To criticize",arabicBase:"نَقَدَ",forms:{past:"نَقَدَ",present:"يَنْقُدُ",imperative:"اُنْقُدْ",masdar:"نَقْد",activePart:"نَاقِد",passivePart:"مَنْقُود"}},
   ]},
  {id:"preset-byy3-u7", title:"Bayna Yadayk Book 3 · Unit 7 — Good Day To You", unitId:"3-7", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"verb",english:"To guide",arabicBase:"أَرْشَدَ",forms:{past:"أَرْشَدَ",present:"يُرْشِدُ",imperative:"أَرْشِدْ",masdar:"إِرْشَاد",activePart:"مُرْشِد",passivePart:"مُرْشَد"}},
     {wordType:"verb",english:"To relax",arabicBase:"اِسْتَرْخَى",forms:{past:"اِسْتَرْخَى",present:"يَسْتَرْخِي",imperative:"اِسْتَرْخِ",masdar:"اِسْتِرْخَاء",activePart:"مُسْتَرْخٍ"}},
     {wordType:"noun",english:"Longing",arabicBase:"اِشْتِيَاق",forms:{singular:"اِشْتِيَاق"}},
     {wordType:"noun",english:"Emotion / agitation",arabicBase:"اِنْفِعَال",forms:{singular:"اِنْفِعَال",plural:"اِنْفِعَالَات"}},
     {wordType:"noun",english:"Waking up",arabicBase:"اِسْتِيقَاظ",forms:{singular:"اِسْتِيقَاظ"}},
     {wordType:"verb",english:"To occupy / attain (a position)",arabicBase:"تَبَوَّأَ",forms:{past:"تَبَوَّأَ",present:"يَتَبَوَّأُ",imperative:"تَبَوَّأْ",masdar:"تَبَوُّؤ",activePart:"مُتَبَوِّئ"}},
     {wordType:"noun",english:"Tension / stress",arabicBase:"تَوَتُّر",forms:{singular:"تَوَتُّر"}},
     {wordType:"noun",english:"Control",arabicBase:"تَحَكُّم",forms:{singular:"تَحَكُّم"}},
     {wordType:"noun",english:"Tiredness",arabicBase:"تَعَب",forms:{singular:"تَعَب"}},
     {wordType:"verb",english:"To wish",arabicBase:"تَمَنَّى",forms:{past:"تَمَنَّى",present:"يَتَمَنَّى",imperative:"تَمَنَّ",masdar:"تَمَنٍّ",activePart:"مُتَمَنٍّ"}},
     {wordType:"noun",english:"Saying \"Allahu Akbar\"",arabicBase:"تَكْبِير",forms:{singular:"تَكْبِير"}},
     {wordType:"noun",english:"Deprivation",arabicBase:"حِرْمَان",forms:{singular:"حِرْمَان"}},
     {wordType:"noun",english:"Humility / reverence (in prayer)",arabicBase:"خُشُوع",forms:{singular:"خُشُوع"}},
     {wordType:"verb",english:"To cause",arabicBase:"سَبَّبَ",forms:{past:"سَبَّبَ",present:"يُسَبِّبُ",imperative:"سَبِّبْ",masdar:"تَسْبِيب",activePart:"مُسَبِّب",passivePart:"مُسَبَّب"}},
     {wordType:"noun",english:"Speed",arabicBase:"سُرْعَة",forms:{singular:"سُرْعَة"}},
     {wordType:"noun",english:"Muscle",arabicBase:"عَضَلَة",forms:{singular:"عَضَلَة",plural:"عَضَلَات"}},
     {wordType:"noun",english:"Innate nature",arabicBase:"فِطْرَة",forms:{singular:"فِطْرَة"}},
     {wordType:"noun",english:"Nap / siesta",arabicBase:"قَيْلُولَة",forms:{singular:"قَيْلُولَة"}},
     {wordType:"noun",english:"Laziness",arabicBase:"كَسَل",forms:{singular:"كَسَل"}},
     {wordType:"adjective",english:"Comfortable / relaxing",arabicBase:"مُرِيح",forms:{singular:"مُرِيح",feminine:"مُرِيحَة"}},
     {wordType:"adjective",english:"Regular / organized",arabicBase:"مُنْتَظِم",forms:{singular:"مُنْتَظِم",feminine:"مُنْتَظِمَة"}},
     {wordType:"noun",english:"Drowsiness",arabicBase:"نُعَاس",forms:{singular:"نُعَاس"}},
     {wordType:"verb",english:"To deny / negate",arabicBase:"نَفَى",forms:{past:"نَفَى",present:"يَنْفِي",imperative:"اِنْفِ",masdar:"نَفْي",activePart:"نَافٍ",passivePart:"مَنْفِيّ"}},
     {wordType:"noun",english:"Pace / rhythm",arabicBase:"وَتِيرَة",forms:{singular:"وَتِيرَة"}},
     {wordType:"noun",english:"Function / job",arabicBase:"وَظِيفَة",forms:{singular:"وَظِيفَة",plural:"وَظَائِف"}},
     {wordType:"noun",english:"Death / passing",arabicBase:"وَفَاة",forms:{singular:"وَفَاة",plural:"وَفَيَات"}},
   ]},
  {id:"preset-byy3-u8", title:"Bayna Yadayk Book 3 · Unit 8 — Anecdotes & Witticisms", unitId:"3-8", level:"book3", seriesId:BYY3P1_SERIES,
   cards:[
     {wordType:"verb",english:"To make lasting / continue",arabicBase:"أَدَامَ",forms:{past:"أَدَامَ",present:"يُدِيمُ",imperative:"أَدِمْ",masdar:"إِدَامَة",activePart:"مُدِيم",passivePart:"مُدَام"}},
     {wordType:"adjective",english:"Intelligent",arabicBase:"ذَكِيّ",forms:{singular:"ذَكِيّ",plural:"أَذْكِيَاء"}},
     {wordType:"verb",english:"To be guided",arabicBase:"اِهْتَدَى",forms:{past:"اِهْتَدَى",present:"يَهْتَدِي",imperative:"اِهْتَدِ",masdar:"اِهْتِدَاء",activePart:"مُهْتَدٍ"}},
     {wordType:"verb",english:"To feel shy / ashamed",arabicBase:"اِسْتَحْيَا",forms:{past:"اِسْتَحْيَا",present:"يَسْتَحِي",imperative:"اِسْتَحِ",masdar:"اِسْتِحْيَاء",activePart:"مُسْتَحٍ"}},
     {wordType:"verb",english:"To point / indicate",arabicBase:"أَشَارَ",forms:{past:"أَشَارَ",present:"يُشِيرُ",imperative:"أَشِرْ",masdar:"إِشَارَة",activePart:"مُشِير",passivePart:"مُشَار",harf:"إِلَى"}},
     {wordType:"noun",english:"Excuse",arabicBase:"عُذْر",forms:{singular:"عُذْر",plural:"أَعْذَار"}},
     {wordType:"noun",english:"Apology",arabicBase:"اِعْتِذَار",forms:{singular:"اِعْتِذَار"}},
     {wordType:"noun",english:"Imam / leader",arabicBase:"إِمَام",forms:{singular:"إِمَام",plural:"أَئِمَّة"}},
     {wordType:"verb",english:"To order",arabicBase:"أَمَرَ",forms:{past:"أَمَرَ",present:"يَأْمُرُ",imperative:"مُرْ",masdar:"أَمْر",activePart:"آمِر",passivePart:"مَأْمُور"}},
     {wordType:"verb",english:"To recite (poetry)",arabicBase:"أَنْشَدَ",forms:{past:"أَنْشَدَ",present:"يُنْشِدُ",imperative:"أَنْشِدْ",masdar:"إِنْشَاد",activePart:"مُنْشِد",passivePart:"مُنْشَد"}},
     {wordType:"noun",english:"Slave-girl / servant (classical usage)",arabicBase:"جَارِيَة",forms:{singular:"جَارِيَة",plural:"جَوَارٍ"}},
     {wordType:"noun",english:"Generous person",arabicBase:"جَوَاد",forms:{singular:"جَوَاد",plural:"أَجْوَاد"}},
     {wordType:"verb",english:"To dig",arabicBase:"حَفَرَ",forms:{past:"حَفَرَ",present:"يَحْفِرُ",imperative:"اُحْفُرْ",masdar:"حَفْر",activePart:"حَافِر",passivePart:"مَحْفُور"}},
     {wordType:"noun",english:"Caliph",arabicBase:"خَلِيفَة",forms:{singular:"خَلِيفَة",plural:"خُلَفَاء"}},
     {wordType:"verb",english:"To lose",arabicBase:"خَسِرَ",forms:{past:"خَسِرَ",present:"يَخْسَرُ",imperative:"اِخْسَرْ",masdar:"خَسَارَة",activePart:"خَاسِر"}},
     {wordType:"verb",english:"To profit / gain",arabicBase:"رَبِحَ",forms:{past:"رَبِحَ",present:"يَرْبَحُ",imperative:"اِرْبَحْ",masdar:"رِبْح",activePart:"رَابِح"}},
     {wordType:"noun",english:"Cloud",arabicBase:"سَحَابَة",forms:{singular:"سَحَابَة",plural:"سَحَاب"}},
     {wordType:"noun",english:"Sultan",arabicBase:"سُلْطَان",forms:{singular:"سُلْطَان",plural:"سَلَاطِين"}},
     {wordType:"noun",english:"Poison",arabicBase:"سُمّ",forms:{singular:"سُمّ",plural:"سُمُوم"}},
     {wordType:"adjective",english:"Grateful",arabicBase:"شَاكِر",forms:{singular:"شَاكِر",feminine:"شَاكِرَة"}},
     {wordType:"noun",english:"Matter / affair",arabicBase:"شَأْن",forms:{singular:"شَأْن",plural:"شُؤُون"}},
     {wordType:"noun",english:"Poet",arabicBase:"شَاعِر",forms:{singular:"شَاعِر",plural:"شُعَرَاء"}},
     {wordType:"verb",english:"To thank",arabicBase:"شَكَرَ",forms:{past:"شَكَرَ",present:"يَشْكُرُ",imperative:"اُشْكُرْ",masdar:"شُكْر",activePart:"شَاكِر",passivePart:"مَشْكُور"}},
     {wordType:"verb",english:"To be patient",arabicBase:"صَبَرَ",forms:{past:"صَبَرَ",present:"يَصْبِرُ",imperative:"اِصْبِرْ",masdar:"صَبْر",activePart:"صَابِر"}},
     {wordType:"noun",english:"Witticism / anecdote",arabicBase:"طُرْفَة",forms:{singular:"طُرْفَة",plural:"طُرَف"}},
     {wordType:"verb",english:"To remain / continue",arabicBase:"ظَلَّ",forms:{past:"ظَلَّ",present:"يَظَلُّ",imperative:"ظَلَّ",activePart:"ظَالّ"}},
     {wordType:"verb",english:"To run",arabicBase:"عَدَا",forms:{past:"عَدَا",present:"يَعْدُو",imperative:"اُعْدُ",masdar:"عَدْو",activePart:"عَادٍ"}},
     {wordType:"adjective",english:"Deviant / misguided",arabicBase:"غَاوٍ",forms:{singular:"غَاوٍ",feminine:"غَاوِيَة"}},
     {wordType:"noun",english:"Stranger",arabicBase:"غَرِيب",forms:{singular:"غَرِيب",plural:"غُرَبَاء"}},
     {wordType:"verb",english:"To drown",arabicBase:"غَرِقَ",forms:{past:"غَرِقَ",present:"يَغْرَقُ",imperative:"اِغْرَقْ",masdar:"غَرَق",activePart:"غَارِق"}},
     {wordType:"adjective",english:"Charming / captivating",arabicBase:"فَاتِن",forms:{singular:"فَاتِن",feminine:"فَاتِنَة"}},
     {wordType:"adjective",english:"Capable",arabicBase:"قَادِر",forms:{singular:"قَادِر",feminine:"قَادِرَة"}},
     {wordType:"noun",english:"Fate / destiny",arabicBase:"قَدَر",forms:{singular:"قَدَر",plural:"أَقْدَار"}},
     {wordType:"adjective",english:"Generous / noble",arabicBase:"كَرِيم",forms:{singular:"كَرِيم",plural:"كِرَام"}},
     {wordType:"noun",english:"Dog",arabicBase:"كَلْب",forms:{singular:"كَلْب",plural:"كِلَاب"}},
     {wordType:"adjective",english:"Base / ignoble",arabicBase:"لَئِيم",forms:{singular:"لَئِيم",plural:"لِئَام"}},
     {wordType:"noun",english:"Believer",arabicBase:"مُؤْمِن",forms:{singular:"مُؤْمِن",plural:"مُؤْمِنُون"}},
     {wordType:"noun",english:"Praise poem",arabicBase:"مَدِيح",forms:{singular:"مَدِيح",plural:"مَدَائِح"}},
     {wordType:"noun",english:"Banquet / feast",arabicBase:"وَلِيمَة",forms:{singular:"وَلِيمَة",plural:"وَلَائِم"}},
   ]},
  {id:"preset-byy3-u9", title:"Bayna Yadayk Book 3 · Unit 9 — True Equality", unitId:"3-9", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"adjective",english:"Free (people)",arabicBase:"حُرّ",forms:{singular:"حُرّ",plural:"أَحْرَار"}},
     {wordType:"adjective",english:"More deserving / entitled",arabicBase:"أَحَقّ",forms:{singular:"أَحَقّ"}},
     {wordType:"noun",english:"Brotherhood",arabicBase:"إِخَاء",forms:{singular:"إِخَاء"}},
     {wordType:"noun",english:"Exception",arabicBase:"اِسْتِثْنَاء",forms:{singular:"اِسْتِثْنَاء",plural:"اِسْتِثْنَاءَات"}},
     {wordType:"verb",english:"To appease / seek to please",arabicBase:"اِسْتَرْضَى",forms:{past:"اِسْتَرْضَى",present:"يَسْتَرْضِي",imperative:"اِسْتَرْضِ",masdar:"اِسْتِرْضَاء",activePart:"مُسْتَرْضٍ"}},
     {wordType:"noun",english:"Seeking forgiveness",arabicBase:"اِسْتِغْفَار",forms:{singular:"اِسْتِغْفَار"}},
     {wordType:"verb",english:"To enslave",arabicBase:"اِسْتَعْبَدَ",forms:{past:"اِسْتَعْبَدَ",present:"يَسْتَعْبِدُ",imperative:"اِسْتَعْبِدْ",masdar:"اِسْتِعْبَاد",activePart:"مُسْتَعْبِد",passivePart:"مُسْتَعْبَد"}},
     {wordType:"verb",english:"To feel compassion for",arabicBase:"أَشْفَقَ",forms:{past:"أَشْفَقَ",present:"يُشْفِقُ",imperative:"أَشْفِقْ",masdar:"إِشْفَاق",activePart:"مُشْفِق",harf:"عَلَى"}},
     {wordType:"adjective",english:"Dearer / more precious",arabicBase:"أَعَزّ",forms:{singular:"أَعَزّ"}},
     {wordType:"verb",english:"To follow the example of",arabicBase:"اِقْتَدَى",forms:{past:"اِقْتَدَى",present:"يَقْتَدِي",imperative:"اِقْتَدِ",masdar:"اِقْتِدَاء",activePart:"مُقْتَدٍ",harf:"بِـ"}},
     {wordType:"noun",english:"Nickname / epithet (kunya)",arabicBase:"تَكْنِيَة",forms:{singular:"تَكْنِيَة",plural:"تَكْنِيَات"}},
     {wordType:"noun",english:"Honoring",arabicBase:"تَكْرِيم",forms:{singular:"تَكْرِيم"}},
     {wordType:"noun",english:"Execution / implementation",arabicBase:"تَنْفِيذ",forms:{singular:"تَنْفِيذ"}},
     {wordType:"verb",english:"To be a neighbor to",arabicBase:"جَاوَرَ",forms:{past:"جَاوَرَ",present:"يُجَاوِرُ",imperative:"جَاوِرْ",masdar:"مُجَاوَرَة",activePart:"مُجَاوِر"}},
     {wordType:"noun",english:"Limit / boundary",arabicBase:"حَدّ",forms:{singular:"حَدّ",plural:"حُدُود"}},
     {wordType:"noun",english:"Fear / awe",arabicBase:"خَشْيَة",forms:{singular:"خَشْيَة"}},
     {wordType:"adjective",english:"Sad",arabicBase:"حَزِين",forms:{singular:"حَزِين",feminine:"حَزِينَة",plural:"حَزَانَى"}},
     {wordType:"verb",english:"To turn around / pay attention",arabicBase:"اِلْتَفَتَ",forms:{past:"اِلْتَفَتَ",present:"يَلْتَفِتُ",imperative:"اِلْتَفِتْ",masdar:"اِلْتِفَات",activePart:"مُلْتَفِت",harf:"إِلَى"}},
     {wordType:"noun",english:"Costs / expenses",arabicBase:"تَكْلِفَة",forms:{singular:"تَكْلِفَة",plural:"تَكَالِيف"}},
     {wordType:"verb",english:"To prevail / dominate",arabicBase:"سَادَ",forms:{past:"سَادَ",present:"يَسُودُ",imperative:"سُدْ",masdar:"سِيَادَة",activePart:"سَائِد"}},
     {wordType:"noun",english:"Trousers",arabicBase:"سِرْوَال",forms:{singular:"سِرْوَال",plural:"سَرَاوِيل"}},
     {wordType:"verb",english:"To steal",arabicBase:"سَرَقَ",forms:{past:"سَرَقَ",present:"يَسْرِقُ",imperative:"اِسْرِقْ",masdar:"سَرِقَة",activePart:"سَارِق",passivePart:"مَسْرُوق"}},
     {wordType:"adjective",english:"Noble / honorable",arabicBase:"شَرِيف",forms:{singular:"شَرِيف",feminine:"شَرِيفَة",plural:"أَشْرَاف"}},
     {wordType:"adjective",english:"Astray / misguided",arabicBase:"ضَالّ",forms:{singular:"ضَالّ",feminine:"ضَالَّة"}},
     {wordType:"verb",english:"To hit / strike",arabicBase:"ضَرَبَ",forms:{past:"ضَرَبَ",present:"يَضْرِبُ",imperative:"اِضْرِبْ",masdar:"ضَرْب",activePart:"ضَارِب",passivePart:"مَضْرُوب"}},
     {wordType:"verb",english:"To apply / implement",arabicBase:"طَبَّقَ",forms:{past:"طَبَّقَ",present:"يُطَبِّقُ",imperative:"طَبِّقْ",masdar:"تَطْبِيق",activePart:"مُطَبِّق",passivePart:"مُطَبَّق"}},
     {wordType:"verb",english:"To wrong / oppress",arabicBase:"ظَلَمَ",forms:{past:"ظَلَمَ",present:"يَظْلِمُ",imperative:"اِظْلِمْ",masdar:"ظُلْم",activePart:"ظَالِم",passivePart:"مَظْلُوم"}},
     {wordType:"verb",english:"To raid / invade",arabicBase:"غَزَا",forms:{past:"غَزَا",present:"يَغْزُو",imperative:"اُغْزُ",masdar:"غَزْو",activePart:"غَازٍ"}},
     {wordType:"verb",english:"To become angry",arabicBase:"غَضِبَ",forms:{past:"غَضِبَ",present:"يَغْضَبُ",imperative:"اِغْضَبْ",masdar:"غَضَب",activePart:"غَاضِب",harf:"مِنْ"}},
     {wordType:"verb",english:"To separate / differentiate",arabicBase:"فَرَّقَ",forms:{past:"فَرَّقَ",present:"يُفَرِّقُ",imperative:"فَرِّقْ",masdar:"تَفْرِيق",activePart:"مُفَرِّق",passivePart:"مُفَرَّق"}},
     {wordType:"verb",english:"To decide",arabicBase:"قَرَّرَ",forms:{past:"قَرَّرَ",present:"يُقَرِّرُ",imperative:"قَرِّرْ",masdar:"تَقْرِير",activePart:"مُقَرِّر",passivePart:"مُقَرَّر"}},
     {wordType:"noun",english:"Retribution / retaliation",arabicBase:"قِصَاص",forms:{singular:"قِصَاص"}},
     {wordType:"verb",english:"To give a nickname",arabicBase:"كَنَّى",forms:{past:"كَنَّى",present:"يُكَنِّي",imperative:"كَنِّ",masdar:"تَكْنِيَة",activePart:"مُكَنٍّ"}},
     {wordType:"noun",english:"Principle",arabicBase:"مَبْدَأ",forms:{singular:"مَبْدَأ",plural:"مَبَادِئ"}},
     {wordType:"adjective",english:"Harmonious / united",arabicBase:"مُتَآلِف",forms:{singular:"مُتَآلِف"}},
     {wordType:"adjective",english:"Sincere / loyal",arabicBase:"مُخْلِص",forms:{singular:"مُخْلِص",feminine:"مُخْلِصَة"}},
     {wordType:"noun",english:"Victim (one wronged)",arabicBase:"مُعْتَدًى عَلَيْهِ",forms:{singular:"مُعْتَدًى عَلَيْهِ"}},
     {wordType:"adjective",english:"Unified",arabicBase:"مُوَحَّد",forms:{singular:"مُوَحَّد",feminine:"مُوَحَّدَة"}},
     {wordType:"adjective",english:"Theoretical",arabicBase:"نَظَرِيّ",forms:{singular:"نَظَرِيّ",feminine:"نَظَرِيَّة"}},
     {wordType:"adjective",english:"Lowly / base",arabicBase:"وَضِيع",forms:{singular:"وَضِيع",feminine:"وَضِيعَة"}},
   ]},
  {id:"preset-byy3-u10", title:"Bayna Yadayk Book 3 · Unit 10 — Kindness To Animals", unitId:"3-10", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"verb",english:"To force / compel",arabicBase:"أَجْبَرَ",forms:{past:"أَجْبَرَ",present:"يُجْبِرُ",imperative:"أَجْبِرْ",masdar:"إِجْبَار",activePart:"مُجْبِر",passivePart:"مُجْبَر"}},
     {wordType:"noun",english:"Kindness / excellence",arabicBase:"إِحْسَان",forms:{singular:"إِحْسَان"}},
     {wordType:"noun",english:"Loads / burdens",arabicBase:"حِمْل",forms:{singular:"حِمْل",plural:"أَحْمَال"}},
     {wordType:"noun",english:"Exhaustion / overburdening",arabicBase:"إِرْهَاق",forms:{singular:"إِرْهَاق"}},
     {wordType:"verb",english:"To rent / hire",arabicBase:"اِسْتَأْجَرَ",forms:{past:"اِسْتَأْجَرَ",present:"يَسْتَأْجِرُ",imperative:"اِسْتَأْجِرْ",masdar:"اِسْتِئْجَار",activePart:"مُسْتَأْجِر",passivePart:"مُسْتَأْجَر"}},
     {wordType:"verb",english:"To feed",arabicBase:"أَطْعَمَ",forms:{past:"أَطْعَمَ",present:"يُطْعِمُ",imperative:"أَطْعِمْ",masdar:"إِطْعَام",activePart:"مُطْعِم",passivePart:"مُطْعَم"}},
     {wordType:"noun",english:"Injury",arabicBase:"إِصَابَة",forms:{singular:"إِصَابَة",plural:"إِصَابَات"}},
     {wordType:"verb",english:"To obligate",arabicBase:"أَلْزَمَ",forms:{past:"أَلْزَمَ",present:"يُلْزِمُ",imperative:"أَلْزِمْ",masdar:"إِلْزَام",activePart:"مُلْزِم",passivePart:"مُلْزَم"}},
     {wordType:"noun",english:"Spending",arabicBase:"إِنْفَاق",forms:{singular:"إِنْفَاق"}},
     {wordType:"noun",english:"Endowment",arabicBase:"وَقْف",forms:{singular:"وَقْف",plural:"أَوْقَاف"}},
     {wordType:"noun",english:"Well (water)",arabicBase:"بِئْر",forms:{singular:"بِئْر",plural:"آبَار"}},
     {wordType:"noun",english:"Camel",arabicBase:"بَعِير",forms:{singular:"بَعِير",plural:"بُعْرَان"}},
     {wordType:"noun",english:"Animals / beasts",arabicBase:"بَهِيمَة",forms:{singular:"بَهِيمَة",plural:"بَهَائِم"}},
     {wordType:"noun",english:"Incitement (to fight)",arabicBase:"تَحْرِيش",forms:{singular:"تَحْرِيش"}},
     {wordType:"noun",english:"Loading",arabicBase:"تَحْمِيل",forms:{singular:"تَحْمِيل"}},
     {wordType:"verb",english:"To yearn / show compassion",arabicBase:"حَنَّ",forms:{past:"حَنَّ",present:"يَحِنُّ",imperative:"حِنَّ",masdar:"حَنِين",activePart:"حَانّ"}},
     {wordType:"noun",english:"Characteristics",arabicBase:"خَاصِّيَة",forms:{singular:"خَاصِّيَة",plural:"خَصَائِص"}},
     {wordType:"verb",english:"To shed (tears)",arabicBase:"ذَرَفَ",forms:{past:"ذَرَفَ",present:"يَذْرِفُ",imperative:"اِذْرِفْ",masdar:"ذَرْف",activePart:"ذَارِف"}},
     {wordType:"verb",english:"To tie",arabicBase:"رَبَطَ",forms:{past:"رَبَطَ",present:"يَرْبُطُ",imperative:"اُرْبُطْ",masdar:"رَبْط",activePart:"رَابِط",passivePart:"مَرْبُوط"}},
     {wordType:"noun",english:"Mercy",arabicBase:"رَحْمَة",forms:{singular:"رَحْمَة",plural:"رَحَمَات"}},
     {wordType:"verb",english:"To graze / tend",arabicBase:"رَعَى",forms:{past:"رَعَى",present:"يَرْعَى",imperative:"اِرْعَ",masdar:"رَعْي",activePart:"رَاعٍ",passivePart:"مَرْعِيّ"}},
     {wordType:"noun",english:"Riding",arabicBase:"رُكُوب",forms:{singular:"رُكُوب"}},
     {wordType:"verb",english:"To drive / herd",arabicBase:"سَاقَ",forms:{past:"سَاقَ",present:"يَسُوقُ",imperative:"سُقْ",masdar:"سَوْق",activePart:"سَائِق",passivePart:"مَسُوق"}},
     {wordType:"verb",english:"To subjugate / put to use",arabicBase:"سَخَّرَ",forms:{past:"سَخَّرَ",present:"يُسَخِّرُ",imperative:"سَخِّرْ",masdar:"تَسْخِير",activePart:"مُسَخِّر",passivePart:"مُسَخَّر"}},
     {wordType:"noun",english:"Sheep / ewe",arabicBase:"شَاة",forms:{singular:"شَاة",plural:"شِيَاه"}},
     {wordType:"noun",english:"Guarantee",arabicBase:"ضَمَان",forms:{singular:"ضَمَان"}},
     {wordType:"adjective",english:"Incapable / weak",arabicBase:"عَاجِز",forms:{singular:"عَاجِز",feminine:"عَاجِزَة"}},
     {wordType:"noun",english:"Sparrow / small bird",arabicBase:"عُصْفُور",forms:{singular:"عُصْفُور",plural:"عَصَافِير"}},
     {wordType:"noun",english:"Thirst",arabicBase:"عَطَش",forms:{singular:"عَطَش"}},
     {wordType:"verb",english:"To forgive",arabicBase:"غَفَرَ",forms:{past:"غَفَرَ",present:"يَغْفِرُ",imperative:"اِغْفِرْ",masdar:"مَغْفِرَة",activePart:"غَافِر",passivePart:"مَغْفُور"}},
     {wordType:"verb",english:"To curse",arabicBase:"لَعَنَ",forms:{past:"لَعَنَ",present:"يَلْعَنُ",imperative:"اِلْعَنْ",masdar:"لَعْن",activePart:"لَاعِن",passivePart:"مَلْعُون"}},
     {wordType:"verb",english:"To walk",arabicBase:"مَشَى",forms:{past:"مَشَى",present:"يَمْشِي",imperative:"اِمْشِ",masdar:"مَشْي",activePart:"مَاشٍ"}},
     {wordType:"verb",english:"To forbid",arabicBase:"نَهَى",forms:{past:"نَهَى",present:"يَنْهَى",imperative:"اِنْهَ",masdar:"نَهْي",activePart:"نَاهٍ",passivePart:"مَنْهِيّ",harf:"عَنْ"}},
     {wordType:"noun",english:"Cat",arabicBase:"هِرَّة",forms:{singular:"هِرَّة",plural:"هِرَر"}},
   ]},
  {id:"preset-byy3-u11", title:"Bayna Yadayk Book 3 · Unit 11 — Arabic Proverbs", unitId:"3-11", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"noun",english:"Proverbs",arabicBase:"مَثَل",forms:{singular:"مَثَل",plural:"أَمْثَال"}},
     {wordType:"noun",english:"Wrongdoing / insult",arabicBase:"إِسَاءَة",forms:{singular:"إِسَاءَة"}},
     {wordType:"noun",english:"Delivering / casting",arabicBase:"إِلْقَاء",forms:{singular:"إِلْقَاء"}},
     {wordType:"verb",english:"To seize (an opportunity)",arabicBase:"اِنْتَهَزَ",forms:{past:"اِنْتَهَزَ",present:"يَنْتَهِزُ",imperative:"اِنْتَهِزْ",masdar:"اِنْتِهَاز",activePart:"مُنْتَهِز",passivePart:"مُنْتَهَز"}},
     {wordType:"verb",english:"To be broken",arabicBase:"اِنْكَسَرَ",forms:{past:"اِنْكَسَرَ",present:"يَنْكَسِرُ",imperative:"اِنْكَسِرْ",masdar:"اِنْكِسَار",activePart:"مُنْكَسِر"}},
     {wordType:"noun",english:"Reward / recompense",arabicBase:"جَزَاء",forms:{singular:"جَزَاء",plural:"جَزَاءَات"}},
     {wordType:"verb",english:"To bring / fetch",arabicBase:"جَلَبَ",forms:{past:"جَلَبَ",present:"يَجْلِبُ",imperative:"اُجْلُبْ",masdar:"جَلْب",activePart:"جَالِب",passivePart:"مَجْلُوب"}},
     {wordType:"noun",english:"Soldiers",arabicBase:"جُنْدِيّ",forms:{singular:"جُنْدِيّ",plural:"جُنُود"}},
     {wordType:"verb",english:"To harvest / reap",arabicBase:"جَنَى",forms:{past:"جَنَى",present:"يَجْنِي",imperative:"اِجْنِ",masdar:"جَنْي",activePart:"جَانٍ",passivePart:"مَجْنِيّ"}},
     {wordType:"noun",english:"News",arabicBase:"خَبَر",forms:{singular:"خَبَر",plural:"أَخْبَار"}},
     {wordType:"noun",english:"Orator / preacher",arabicBase:"خَطِيب",forms:{singular:"خَطِيب",plural:"خُطَبَاء"}},
     {wordType:"noun",english:"Behind (spatial)",arabicBase:"خَلْف",forms:{singular:"خَلْف"}},
     {wordType:"noun",english:"Blood money",arabicBase:"دِيَة",forms:{singular:"دِيَة",plural:"دِيَات"}},
     {wordType:"verb",english:"To watch / monitor",arabicBase:"رَاقَبَ",forms:{past:"رَاقَبَ",present:"يُرَاقِبُ",imperative:"رَاقِبْ",masdar:"مُرَاقَبَة",activePart:"مُرَاقِب",passivePart:"مُرَاقَب"}},
     {wordType:"verb",english:"To bargain",arabicBase:"سَاوَمَ",forms:{past:"سَاوَمَ",present:"يُسَاوِمُ",imperative:"سَاوِمْ",masdar:"مُسَاوَمَة",activePart:"مُسَاوِم"}},
     {wordType:"verb",english:"To be silent",arabicBase:"سَكَتَ",forms:{past:"سَكَتَ",present:"يَسْكُتُ",imperative:"اُسْكُتْ",masdar:"سُكُوت",activePart:"سَاكِت"}},
     {wordType:"noun",english:"Authority / sultan",arabicBase:"سُلْطَان",forms:{singular:"سُلْطَان",plural:"سَلَاطِين"}},
     {wordType:"verb",english:"To ascend",arabicBase:"صَعِدَ",forms:{past:"صَعِدَ",present:"يَصْعَدُ",imperative:"اِصْعَدْ",masdar:"صُعُود",activePart:"صَاعِد"}},
     {wordType:"verb",english:"To be lost",arabicBase:"ضَاعَ",forms:{past:"ضَاعَ",present:"يَضِيعُ",imperative:"ضِعْ",masdar:"ضَيَاع",activePart:"ضَائِع"}},
     {wordType:"verb",english:"To fail",arabicBase:"فَشِلَ",forms:{past:"فَشِلَ",present:"يَفْشَلُ",imperative:"اِفْشَلْ",masdar:"فَشَل",activePart:"فَاشِل"}},
     {wordType:"noun",english:"Killer",arabicBase:"قَاتِل",forms:{singular:"قَاتِل",feminine:"قَاتِلَة"}},
     {wordType:"noun",english:"Halls",arabicBase:"قَاعَة",forms:{singular:"قَاعَة",plural:"قَاعَات"}},
     {wordType:"adjective",english:"Skilled",arabicBase:"مَاهِر",forms:{singular:"مَاهِر",feminine:"مَاهِرَة"}},
     {wordType:"verb",english:"To own / possess",arabicBase:"مَلَكَ",forms:{past:"مَلَكَ",present:"يَمْلِكُ",imperative:"اُمْلُكْ",masdar:"مِلْك",activePart:"مَالِك",passivePart:"مَمْلُوك"}},
     {wordType:"noun",english:"One killed / murder victim",arabicBase:"مَقْتُول",forms:{singular:"مَقْتُول"}},
     {wordType:"noun",english:"Appointment / deadline",arabicBase:"مِيعَاد",forms:{singular:"مِيعَاد",plural:"مَوَاعِيد"}},
     {wordType:"verb",english:"To alert",arabicBase:"نَبَّهَ",forms:{past:"نَبَّهَ",present:"يُنَبِّهُ",imperative:"نَبِّهْ",masdar:"تَنْبِيه",activePart:"مُنَبِّه",passivePart:"مُنَبَّه"}},
     {wordType:"verb",english:"To regret",arabicBase:"نَدِمَ",forms:{past:"نَدِمَ",present:"يَنْدَمُ",imperative:"اِنْدَمْ",masdar:"نَدَم",activePart:"نَادِم"}},
     {wordType:"verb",english:"To attack",arabicBase:"هَاجَمَ",forms:{past:"هَاجَمَ",present:"يُهَاجِمُ",imperative:"هَاجِمْ",masdar:"مُهَاجَمَة",activePart:"مُهَاجِم",passivePart:"مُهَاجَم"}},
     {wordType:"verb",english:"To plunder",arabicBase:"نَهَبَ",forms:{past:"نَهَبَ",present:"يَنْهَبُ",imperative:"اُنْهُبْ",masdar:"نَهْب",activePart:"نَاهِب",passivePart:"مَنْهُوب"}},
     {wordType:"verb",english:"To despair",arabicBase:"يَئِسَ",forms:{past:"يَئِسَ",present:"يَيْأَسُ",imperative:"اِيْأَسْ",masdar:"يَأْس",activePart:"يَائِس"}},
     {wordType:"noun",english:"Certainty",arabicBase:"يَقِين",forms:{singular:"يَقِين"}},
   ]},
  {id:"preset-byy3-u12", title:"Bayna Yadayk Book 3 · Unit 12 — Marital Disputes", unitId:"3-12", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"noun",english:"Agreement",arabicBase:"اِتِّفَاق",forms:{singular:"اِتِّفَاق",plural:"اِتِّفَاقَات"}},
     {wordType:"verb",english:"To make a mistake",arabicBase:"أَخْطَأَ",forms:{past:"أَخْطَأَ",present:"يُخْطِئُ",imperative:"أَخْطِئْ",masdar:"خَطَأ",activePart:"مُخْطِئ"}},
     {wordType:"noun",english:"Concealment",arabicBase:"إِخْفَاء",forms:{singular:"إِخْفَاء"}},
     {wordType:"verb",english:"To harm",arabicBase:"آذَى",forms:{past:"آذَى",present:"يُؤْذِي",imperative:"آذِ",masdar:"إِيذَاء",activePart:"مُؤْذٍ",passivePart:"مُؤْذًى"}},
     {wordType:"adjective",english:"Deeper",arabicBase:"أَعْمَق",forms:{singular:"أَعْمَق"}},
     {wordType:"noun",english:"Refusal / abstention",arabicBase:"اِمْتِنَاع",forms:{singular:"اِمْتِنَاع"}},
     {wordType:"noun",english:"Supply / support",arabicBase:"إِمْدَاد",forms:{singular:"إِمْدَاد"}},
     {wordType:"noun",english:"Emotion / agitation",arabicBase:"اِنْفِعَال",forms:{singular:"اِنْفِعَال",plural:"اِنْفِعَالَات"}},
     {wordType:"noun",english:"Remaining / survival",arabicBase:"بَقَاء",forms:{singular:"بَقَاء"}},
     {wordType:"noun",english:"Behavior / conduct",arabicBase:"تَصَرُّف",forms:{singular:"تَصَرُّف",plural:"تَصَرُّفَات"}},
     {wordType:"noun",english:"Complication",arabicBase:"تَعْقِيد",forms:{singular:"تَعْقِيد"}},
     {wordType:"verb",english:"To appoint as arbitrator",arabicBase:"حَكَّمَ",forms:{past:"حَكَّمَ",present:"يُحَكِّمُ",imperative:"حَكِّمْ",masdar:"تَحْكِيم",activePart:"مُحَكِّم",passivePart:"مُحَكَّم"}},
     {wordType:"noun",english:"Mourning",arabicBase:"حِدَاد",forms:{singular:"حِدَاد"}},
     {wordType:"verb",english:"To strangle",arabicBase:"خَنَقَ",forms:{past:"خَنَقَ",present:"يَخْنُقُ",imperative:"اُخْنُقْ",masdar:"خَنْق",activePart:"خَانِق",passivePart:"مَخْنُوق"}},
     {wordType:"noun",english:"Safety",arabicBase:"سَلَامَة",forms:{singular:"سَلَامَة"}},
     {wordType:"noun",english:"Equality / fairness",arabicBase:"سَوِيَّة",forms:{singular:"سَوِيَّة"}},
     {wordType:"noun",english:"Quarrel",arabicBase:"شِجَار",forms:{singular:"شِجَار"}},
     {wordType:"noun",english:"Frankness",arabicBase:"صَرَاحَة",forms:{singular:"صَرَاحَة"}},
     {wordType:"verb",english:"To be silent",arabicBase:"صَمَتَ",forms:{past:"صَمَتَ",present:"يَصْمُتُ",imperative:"اُصْمُتْ",masdar:"صَمْت",activePart:"صَامِت"}},
     {wordType:"verb",english:"To think / suppose",arabicBase:"ظَنَّ",forms:{past:"ظَنَّ",present:"يَظُنُّ",imperative:"ظُنَّ",masdar:"ظَنّ",activePart:"ظَانّ",passivePart:"مَظْنُون"}},
     {wordType:"noun",english:"Violence",arabicBase:"عُنْف",forms:{singular:"عُنْف"}},
     {wordType:"verb",english:"To be heedless / neglectful",arabicBase:"غَفَلَ",forms:{past:"غَفَلَ",present:"يَغْفَلُ",imperative:"اِغْفَلْ",masdar:"غَفْلَة",activePart:"غَافِل",harf:"عَنْ"}},
     {wordType:"noun",english:"Moment",arabicBase:"لَحْظَة",forms:{singular:"لَحْظَة",plural:"لَحَظَات"}},
     {wordType:"verb",english:"To meet / encounter",arabicBase:"لَاقَى",forms:{past:"لَاقَى",present:"يُلَاقِي",imperative:"لَاقِ",masdar:"مُلَاقَاة",activePart:"مُلَاقٍ"}},
     {wordType:"adjective",english:"Influential / affecting",arabicBase:"مُؤَثِّر",forms:{singular:"مُؤَثِّر",feminine:"مُؤَثِّرَة"}},
     {wordType:"adjective",english:"Painful",arabicBase:"مُؤْلِم",forms:{singular:"مُؤْلِم",feminine:"مُؤْلِمَة"}},
     {wordType:"noun",english:"One wronged / oppressed",arabicBase:"مَظْلُوم",forms:{singular:"مَظْلُوم"}},
     {wordType:"noun",english:"Discussion",arabicBase:"مُنَاقَشَة",forms:{singular:"مُنَاقَشَة",plural:"مُنَاقَشَات"}},
     {wordType:"noun",english:"Confrontation",arabicBase:"مُوَاجَهَة",forms:{singular:"مُوَاجَهَة",plural:"مُوَاجَهَات"}},
     {wordType:"adjective",english:"Successful",arabicBase:"نَاجِح",forms:{singular:"نَاجِح",feminine:"نَاجِحَة"}},
     {wordType:"verb",english:"To direct",arabicBase:"وَجَّهَ",forms:{past:"وَجَّهَ",present:"يُوَجِّهُ",imperative:"وَجِّهْ",masdar:"تَوْجِيه",activePart:"مُوَجِّه",passivePart:"مُوَجَّه"}},
     {wordType:"verb",english:"To scold",arabicBase:"وَبَّخَ",forms:{past:"وَبَّخَ",present:"يُوَبِّخُ",imperative:"وَبِّخْ",masdar:"تَوْبِيخ",activePart:"مُوَبِّخ",passivePart:"مُوَبَّخ"}},
     {wordType:"verb",english:"To reproach",arabicBase:"عَاتَبَ",forms:{past:"عَاتَبَ",present:"يُعَاتِبُ",imperative:"عَاتِبْ",masdar:"مُعَاتَبَة",activePart:"مُعَاتِب",passivePart:"مُعَاتَب"}},
   ]},
  {id:"preset-byy3-u13", title:"Bayna Yadayk Book 3 · Unit 13 — Parents & Children", unitId:"3-13", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"noun",english:"Fatherhood",arabicBase:"أُبُوَّة",forms:{singular:"أُبُوَّة"}},
     {wordType:"noun",english:"Sin",arabicBase:"إِثْم",forms:{singular:"إِثْم",plural:"آثَام"}},
     {wordType:"verb",english:"To relax / feel at ease",arabicBase:"اِرْتَاحَ",forms:{past:"اِرْتَاحَ",present:"يَرْتَاحُ",imperative:"اِرْتَحْ",masdar:"اِرْتِيَاح",activePart:"مُرْتَاح"}},
     {wordType:"verb",english:"To guide",arabicBase:"أَرْشَدَ",forms:{past:"أَرْشَدَ",present:"يُرْشِدُ",imperative:"أَرْشِدْ",masdar:"إِرْشَاد",activePart:"مُرْشِد",passivePart:"مُرْشَد"}},
     {wordType:"noun",english:"Independence",arabicBase:"اِسْتِقْلَال",forms:{singular:"اِسْتِقْلَال"}},
     {wordType:"noun",english:"Moderation",arabicBase:"اِعْتِدَال",forms:{singular:"اِعْتِدَال"}},
     {wordType:"verb",english:"To be convinced",arabicBase:"اِقْتَنَعَ",forms:{past:"اِقْتَنَعَ",present:"يَقْتَنِعُ",imperative:"اِقْتَنِعْ",masdar:"اِقْتِنَاع",activePart:"مُقْتَنِع"}},
     {wordType:"noun",english:"Faith",arabicBase:"إِيمَان",forms:{singular:"إِيمَان"}},
     {wordType:"verb",english:"To be dutiful (to parents)",arabicBase:"بَرَّ",forms:{past:"بَرَّ",present:"يَبَرُّ",imperative:"بَرَّ",masdar:"بِرّ",activePart:"بَارّ",harf:"بِـ"}},
     {wordType:"verb",english:"To respond / interact",arabicBase:"تَجَاوَبَ",forms:{past:"تَجَاوَبَ",present:"يَتَجَاوَبُ",imperative:"تَجَاوَبْ",masdar:"تَجَاوُب",activePart:"مُتَجَاوِب"}},
     {wordType:"verb",english:"To exceed / overlook",arabicBase:"تَجَاوَزَ",forms:{past:"تَجَاوَزَ",present:"يَتَجَاوَزُ",imperative:"تَجَاوَزْ",masdar:"تَجَاوُز",activePart:"مُتَجَاوِز"}},
     {wordType:"noun",english:"Settlement / resolution",arabicBase:"تَسْوِيَة",forms:{singular:"تَسْوِيَة"}},
     {wordType:"noun",english:"Cooperation",arabicBase:"تَعَاوُن",forms:{singular:"تَعَاوُن"}},
     {wordType:"verb",english:"To transgress",arabicBase:"تَعَدَّى",forms:{past:"تَعَدَّى",present:"يَتَعَدَّى",imperative:"تَعَدَّ",masdar:"تَعَدٍّ",activePart:"مُتَعَدٍّ"}},
     {wordType:"adjective",english:"Compassionate / tender",arabicBase:"حَانٍ",forms:{singular:"حَانٍ",feminine:"حَانِيَة"}},
     {wordType:"verb",english:"To create",arabicBase:"خَلَقَ",forms:{past:"خَلَقَ",present:"يَخْلُقُ",imperative:"اُخْلُقْ",masdar:"خَلْق",activePart:"خَالِق",passivePart:"مَخْلُوق"}},
     {wordType:"adjective",english:"Wise",arabicBase:"حَكِيم",forms:{singular:"حَكِيم",plural:"حُكَمَاء"}},
     {wordType:"verb",english:"To rule / judge",arabicBase:"حَكَمَ",forms:{past:"حَكَمَ",present:"يَحْكُمُ",imperative:"اُحْكُمْ",masdar:"حُكْم",activePart:"حَاكِم",passivePart:"مَحْكُوم"}},
     {wordType:"noun",english:"Dream / vision",arabicBase:"رُؤْيَا",forms:{singular:"رُؤْيَا",plural:"رُؤًى"}},
     {wordType:"verb",english:"To record",arabicBase:"سَجَّلَ",forms:{past:"سَجَّلَ",present:"يُسَجِّلُ",imperative:"سَجِّلْ",masdar:"تَسْجِيل",activePart:"مُسَجِّل",passivePart:"مُسَجَّل"}},
     {wordType:"verb",english:"To follow (a path)",arabicBase:"سَلَكَ",forms:{past:"سَلَكَ",present:"يَسْلُكُ",imperative:"اُسْلُكْ",masdar:"سُلُوك",activePart:"سَالِك",passivePart:"مَسْلُوك"}},
     {wordType:"verb",english:"To occupy / busy",arabicBase:"شَغَلَ",forms:{past:"شَغَلَ",present:"يَشْغَلُ",imperative:"اِشْغَلْ",masdar:"شُغْل",activePart:"شَاغِل",passivePart:"مَشْغُول"}},
     {wordType:"noun",english:"Misguidance",arabicBase:"ضَلَال",forms:{singular:"ضَلَال"}},
     {wordType:"noun",english:"Justice",arabicBase:"عَدْل",forms:{singular:"عَدْل"}},
     {wordType:"verb",english:"To be just / equitable",arabicBase:"عَدَلَ",forms:{past:"عَدَلَ",present:"يَعْدِلُ",imperative:"اِعْدِلْ",masdar:"عَدْل",activePart:"عَادِل",passivePart:"مَعْدُول"}},
     {wordType:"noun",english:"Enemy",arabicBase:"عَدُوّ",forms:{singular:"عَدُوّ",plural:"أَعْدَاء"}},
     {wordType:"noun",english:"Aggression",arabicBase:"عُدْوَان",forms:{singular:"عُدْوَان"}},
     {wordType:"noun",english:"Standing / uprising",arabicBase:"قِيَام",forms:{singular:"قِيَام"}},
     {wordType:"verb",english:"To reward",arabicBase:"كَافَأَ",forms:{past:"كَافَأَ",present:"يُكَافِئُ",imperative:"كَافِئْ",masdar:"مُكَافَأَة",activePart:"مُكَافِئ",passivePart:"مُكَافَأ"}},
     {wordType:"verb",english:"To earn / gain",arabicBase:"كَسَبَ",forms:{past:"كَسَبَ",present:"يَكْسِبُ",imperative:"اِكْسِبْ",masdar:"كَسْب",activePart:"كَاسِب",passivePart:"مَكْسُوب"}},
     {wordType:"noun",english:"Good deed / kindness",arabicBase:"مَعْرُوف",forms:{singular:"مَعْرُوف"}},
     {wordType:"noun",english:"Wrongdoing / evil",arabicBase:"مُنْكَر",forms:{singular:"مُنْكَر",plural:"مُنْكَرَات"}},
     {wordType:"noun",english:"Sleep / dream",arabicBase:"مَنَام",forms:{singular:"مَنَام"}},
     {wordType:"noun",english:"Salvation / rescue",arabicBase:"نَجَاة",forms:{singular:"نَجَاة"}},
     {wordType:"verb",english:"To admonish / preach",arabicBase:"وَعَظَ",forms:{past:"وَعَظَ",present:"يَعِظُ",imperative:"عِظْ",masdar:"وَعْظ",activePart:"وَاعِظ",passivePart:"مَوْعُوظ"}},
   ]},
  {id:"preset-byy3-u14", title:"Bayna Yadayk Book 3 · Unit 14 — Water, The Source Of Life", unitId:"3-14", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"noun",english:"Combustion / burning",arabicBase:"اِحْتِرَاق",forms:{singular:"اِحْتِرَاق"}},
     {wordType:"noun",english:"Excretion / output",arabicBase:"إِخْرَاج",forms:{singular:"إِخْرَاج"}},
     {wordType:"noun",english:"Phases / stages",arabicBase:"طَوْر",forms:{singular:"طَوْر",plural:"أَطْوَار"}},
     {wordType:"noun",english:"Foods",arabicBase:"غِذَاء",forms:{singular:"غِذَاء",plural:"أَغْذِيَة"}},
     {wordType:"noun",english:"Oxygen",arabicBase:"أَكْسِجِين",forms:{singular:"أَكْسِجِين"}},
     {wordType:"noun",english:"Intestines",arabicBase:"أَمْعَاء",forms:{singular:"أَمْعَاء"}},
     {wordType:"noun",english:"Tissues",arabicBase:"نَسِيج",forms:{singular:"نَسِيج",plural:"أَنْسِجَة"}},
     {wordType:"noun",english:"Collapse",arabicBase:"اِنْهِيَار",forms:{singular:"اِنْهِيَار"}},
     {wordType:"noun",english:"Weights",arabicBase:"وَزْن",forms:{singular:"وَزْن",plural:"أَوْزَان"}},
     {wordType:"noun",english:"Reproduction / multiplication",arabicBase:"تَكَاثُر",forms:{singular:"تَكَاثُر"}},
     {wordType:"noun",english:"Balance",arabicBase:"تَوَازُن",forms:{singular:"تَوَازُن"}},
     {wordType:"noun",english:"Body",arabicBase:"جِسْم",forms:{singular:"جِسْم",plural:"أَجْسَام"}},
     {wordType:"noun",english:"Fruits",arabicBase:"ثَمَرَة",forms:{singular:"ثَمَرَة",plural:"ثِمَار"}},
     {wordType:"noun",english:"Dryness / drought",arabicBase:"جَفَاف",forms:{singular:"جَفَاف"}},
     {wordType:"verb",english:"To dry up",arabicBase:"جَفَّ",forms:{past:"جَفَّ",present:"يَجِفُّ",imperative:"جِفَّ",masdar:"جَفَاف",activePart:"جَافّ"}},
     {wordType:"noun",english:"Skin",arabicBase:"جِلْد",forms:{singular:"جِلْد",plural:"جُلُود"}},
     {wordType:"noun",english:"Movement",arabicBase:"حَرَكَة",forms:{singular:"حَرَكَة",plural:"حَرَكَات"}},
     {wordType:"noun",english:"Vitality",arabicBase:"حَيَوِيَّة",forms:{singular:"حَيَوِيَّة"}},
     {wordType:"noun",english:"Cell (biology)",arabicBase:"خَلِيَّة",forms:{singular:"خَلِيَّة",plural:"خَلَايَا"}},
     {wordType:"adjective",english:"Precise / fine",arabicBase:"دَقِيق",forms:{singular:"دَقِيق",feminine:"دَقِيقَة"}},
     {wordType:"noun",english:"Tears",arabicBase:"دَمْعَة",forms:{singular:"دَمْعَة",plural:"دُمُوع"}},
     {wordType:"verb",english:"To slaughter",arabicBase:"ذَبَحَ",forms:{past:"ذَبَحَ",present:"يَذْبَحُ",imperative:"اِذْبَحْ",masdar:"ذَبْح",activePart:"ذَابِح",passivePart:"مَذْبُوح"}},
     {wordType:"adjective",english:"Thin / delicate",arabicBase:"رَقِيق",forms:{singular:"رَقِيق",feminine:"رَقِيقَة"}},
     {wordType:"noun",english:"Exhalation",arabicBase:"زَفِير",forms:{singular:"زَفِير"}},
     {wordType:"adjective",english:"Poisonous",arabicBase:"سَامّ",forms:{singular:"سَامّ",feminine:"سَامَّة"}},
     {wordType:"verb",english:"To include / encompass",arabicBase:"شَمِلَ",forms:{past:"شَمِلَ",present:"يَشْمَلُ",imperative:"اِشْمَلْ",masdar:"شُمُول",activePart:"شَامِل"}},
     {wordType:"noun",english:"Taste",arabicBase:"طَعْم",forms:{singular:"طَعْم",plural:"طُعُوم"}},
     {wordType:"adjective",english:"Parasitic",arabicBase:"طُفَيْلِيّ",forms:{singular:"طُفَيْلِيّ"}},
     {wordType:"noun",english:"Ambition",arabicBase:"طُمُوح",forms:{singular:"طُمُوح"}},
     {wordType:"noun",english:"Sweat",arabicBase:"عَرَق",forms:{singular:"عَرَق"}},
     {wordType:"noun",english:"Values",arabicBase:"قِيمَة",forms:{singular:"قِيمَة",plural:"قِيَم"}},
     {wordType:"noun",english:"Liver",arabicBase:"كَبِد",forms:{singular:"كَبِد"}},
     {wordType:"verb",english:"To grow up / become big",arabicBase:"كَبِرَ",forms:{past:"كَبِرَ",present:"يَكْبُرُ",imperative:"اُكْبُرْ",masdar:"كِبَر",activePart:"كَبِير"}},
     {wordType:"noun",english:"Shoulder",arabicBase:"كَتِف",forms:{singular:"كَتِف",plural:"أَكْتَاف"}},
     {wordType:"verb",english:"To lie",arabicBase:"كَذَبَ",forms:{past:"كَذَبَ",present:"يَكْذِبُ",imperative:"اِكْذِبْ",masdar:"كَذِب",activePart:"كَاذِب"}},
     {wordType:"adjective",english:"Arrogant",arabicBase:"مُتَكَبِّر",forms:{singular:"مُتَكَبِّر",feminine:"مُتَكَبِّرَة"}},
     {wordType:"noun",english:"Flexibility",arabicBase:"مُرُونَة",forms:{singular:"مُرُونَة"}},
     {wordType:"adjective",english:"Radiant / shining",arabicBase:"مُشْرِق",forms:{singular:"مُشْرِق",feminine:"مُشْرِقَة"}},
     {wordType:"noun",english:"Pyramid / old age",arabicBase:"هَرَم",forms:{singular:"هَرَم",plural:"أَهْرَام"}},
     {wordType:"noun",english:"Hormone",arabicBase:"هُرْمُون",forms:{singular:"هُرْمُون",plural:"هُرْمُونَات"}},
     {wordType:"verb",english:"To digest",arabicBase:"هَضَمَ",forms:{past:"هَضَمَ",present:"يَهْضِمُ",imperative:"اِهْضِمْ",masdar:"هَضْم",activePart:"هَاضِم",passivePart:"مَهْضُوم"}},
     {wordType:"noun",english:"Expense / alimony",arabicBase:"نَفَقَة",forms:{singular:"نَفَقَة",plural:"نَفَقَات"}},
     {wordType:"verb",english:"To transfer / transport",arabicBase:"نَقَلَ",forms:{past:"نَقَلَ",present:"يَنْقُلُ",imperative:"اُنْقُلْ",masdar:"نَقْل",activePart:"نَاقِل",passivePart:"مَنْقُول"}},
     {wordType:"verb",english:"To grow",arabicBase:"نَمَا",forms:{past:"نَمَا",present:"يَنْمُو",imperative:"اُنْمُ",masdar:"نُمُوّ",activePart:"نَامٍ"}},
     {wordType:"verb",english:"To find",arabicBase:"وَجَدَ",forms:{past:"وَجَدَ",present:"يَجِدُ",imperative:"جِدْ",masdar:"وُجُود",activePart:"وَاجِد",passivePart:"مَوْجُود"}},
   ]},
  {id:"preset-byy3-u15", title:"Bayna Yadayk Book 3 · Unit 15 — A Father's Counsel", unitId:"3-15", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"noun",english:"Ruling / judgment",arabicBase:"حُكْم",forms:{singular:"حُكْم",plural:"أَحْكَام"}},
     {wordType:"noun",english:"Jewelry",arabicBase:"حُلِيّ",forms:{singular:"حُلِيّ"}},
     {wordType:"adjective",english:"Warm",arabicBase:"دَافِئ",forms:{singular:"دَافِئ",feminine:"دَافِئَة"}},
     {wordType:"adjective",english:"Discontented / angry",arabicBase:"سَاخِط",forms:{singular:"سَاخِط",feminine:"سَاخِطَة"}},
     {wordType:"noun",english:"Poisons",arabicBase:"سَمّ",forms:{singular:"سَمّ",plural:"سُمُوم"}},
     {wordType:"adjective",english:"Anomalous / odd",arabicBase:"شَاذّ",forms:{singular:"شَاذّ"}},
     {wordType:"noun",english:"Partner",arabicBase:"شَرِيك",forms:{singular:"شَرِيك",plural:"شُرَكَاء"}},
     {wordType:"noun",english:"Patience",arabicBase:"صَبْر",forms:{singular:"صَبْر"}},
     {wordType:"verb",english:"To be patient",arabicBase:"صَبَرَ",forms:{past:"صَبَرَ",present:"يَصْبِرُ",imperative:"اِصْبِرْ",masdar:"صَبْر",activePart:"صَابِر"}},
     {wordType:"noun",english:"Companions (of the Prophet)",arabicBase:"صَحَابَة",forms:{singular:"صَحَابَة"}},
     {wordType:"verb",english:"To scream",arabicBase:"صَرَخَ",forms:{past:"صَرَخَ",present:"يَصْرُخُ",imperative:"اُصْرُخْ",masdar:"صُرَاخ",activePart:"صَارِخ"}},
     {wordType:"noun",english:"Difficulty",arabicBase:"صُعُوبَة",forms:{singular:"صُعُوبَة",plural:"صُعُوبَات"}},
     {wordType:"noun",english:"Reconciliation",arabicBase:"صُلْح",forms:{singular:"صُلْح"}},
     {wordType:"verb",english:"To design / resolve firmly",arabicBase:"صَمَّمَ",forms:{past:"صَمَّمَ",present:"يُصَمِّمُ",imperative:"صَمِّمْ",masdar:"تَصْمِيم",activePart:"مُصَمِّم",passivePart:"مُصَمَّم"}},
     {wordType:"verb",english:"To live",arabicBase:"عَاشَ",forms:{past:"عَاشَ",present:"يَعِيشُ",imperative:"عِشْ",masdar:"عَيْش",activePart:"عَائِش"}},
     {wordType:"noun",english:"Emotion",arabicBase:"عَاطِفَة",forms:{singular:"عَاطِفَة",plural:"عَوَاطِف"}},
     {wordType:"noun",english:"Servants (of God)",arabicBase:"عَبْد",forms:{singular:"عَبْد",plural:"عِبَاد"}},
     {wordType:"noun",english:"Futility / vanity",arabicBase:"عَبَث",forms:{singular:"عَبَث"}},
     {wordType:"noun",english:"Lesson / moral",arabicBase:"عِبْرَة",forms:{singular:"عِبْرَة",plural:"عِبَر"}},
     {wordType:"verb",english:"To run",arabicBase:"عَدَا",forms:{past:"عَدَا",present:"يَعْدُو",imperative:"اُعْدُ",masdar:"عَدْو",activePart:"عَادٍ"}},
     {wordType:"noun",english:"Non-existence / lack",arabicBase:"عَدَم",forms:{singular:"عَدَم"}},
     {wordType:"noun",english:"Stick / cane",arabicBase:"عَصًا",forms:{singular:"عَصًا",plural:"عِصِيّ"}},
     {wordType:"noun",english:"Muscles",arabicBase:"عَضَلَة",forms:{singular:"عَضَلَة",plural:"عَضَلَات"}},
     {wordType:"verb",english:"To be kind / sympathize",arabicBase:"عَطَفَ",forms:{past:"عَطَفَ",present:"يَعْطِفُ",imperative:"اِعْطِفْ",masdar:"عَطْف",activePart:"عَاطِف",harf:"عَلَى"}},
     {wordType:"adjective",english:"Heedless / unaware",arabicBase:"غَافِل",forms:{singular:"غَافِل",feminine:"غَافِلَة"}},
     {wordType:"noun",english:"Heedlessness",arabicBase:"غَفْلَة",forms:{singular:"غَفْلَة"}},
     {wordType:"verb",english:"To overwhelm / flood",arabicBase:"غَمَرَ",forms:{past:"غَمَرَ",present:"يَغْمُرُ",imperative:"اُغْمُرْ",masdar:"غَمْر",activePart:"غَامِر",passivePart:"مَغْمُور"}},
     {wordType:"adjective",english:"Harsh / cruel",arabicBase:"قَاسٍ",forms:{singular:"قَاسٍ",feminine:"قَاسِيَة"}},
     {wordType:"noun",english:"Fate / destiny",arabicBase:"قَدَر",forms:{singular:"قَدَر",plural:"أَقْدَار"}},
     {wordType:"verb",english:"To appreciate / estimate",arabicBase:"قَدَّرَ",forms:{past:"قَدَّرَ",present:"يُقَدِّرُ",imperative:"قَدِّرْ",masdar:"تَقْدِير",activePart:"مُقَدِّر",passivePart:"مُقَدَّر"}},
     {wordType:"noun",english:"Ability",arabicBase:"قُدْرَة",forms:{singular:"قُدْرَة",plural:"قُدُرَات"}},
     {wordType:"verb",english:"To throw / hurl",arabicBase:"قَذَفَ",forms:{past:"قَذَفَ",present:"يَقْذِفُ",imperative:"اِقْذِفْ",masdar:"قَذْف",activePart:"قَاذِف",passivePart:"مَقْذُوف"}},
     {wordType:"verb",english:"To fall short / be negligent",arabicBase:"قَصَّرَ",forms:{past:"قَصَّرَ",present:"يُقَصِّرُ",imperative:"قَصِّرْ",masdar:"تَقْصِير",activePart:"مُقَصِّر"}},
     {wordType:"noun",english:"Issue / case",arabicBase:"قَضِيَّة",forms:{singular:"قَضِيَّة",plural:"قَضَايَا"}},
     {wordType:"noun",english:"Entity",arabicBase:"كِيَان",forms:{singular:"كِيَان"}},
     {wordType:"noun",english:"Manner / way",arabicBase:"كَيْفِيَّة",forms:{singular:"كَيْفِيَّة"}},
     {wordType:"verb",english:"To become soft / gentle",arabicBase:"لَانَ",forms:{past:"لَانَ",present:"يَلِينُ",imperative:"لِنْ",masdar:"لِين",activePart:"لَيِّن"}},
     {wordType:"noun",english:"Love / affection",arabicBase:"مَحَبَّة",forms:{singular:"مَحَبَّة"}},
     {wordType:"noun",english:"Benefactor",arabicBase:"مُحْسِن",forms:{singular:"مُحْسِن",plural:"مُحْسِنُون"}},
     {wordType:"adjective",english:"Conceited / arrogant",arabicBase:"مُخْتَال",forms:{singular:"مُخْتَال"}},
     {wordType:"adjective",english:"Civil / civic",arabicBase:"مَدَنِيّ",forms:{singular:"مَدَنِيّ",feminine:"مَدَنِيَّة"}},
     {wordType:"adjective",english:"Bitter",arabicBase:"مُرّ",forms:{singular:"مُرّ",feminine:"مُرَّة"}},
     {wordType:"adjective",english:"Dark",arabicBase:"مُظْلِم",forms:{singular:"مُظْلِم",feminine:"مُظْلِمَة"}},
     {wordType:"adjective",english:"Contemporary",arabicBase:"مُعَاصِر",forms:{singular:"مُعَاصِر",feminine:"مُعَاصِرَة"}},
     {wordType:"adjective",english:"Accustomed / usual",arabicBase:"مُعْتَاد",forms:{singular:"مُعْتَاد",feminine:"مُعْتَادَة"}},
   ]},
  {id:"preset-byy3-u16", title:"Bayna Yadayk Book 3 · Unit 16 — From Walid's Diary", unitId:"3-16", level:"book3", seriesId:BYY3P2_SERIES,
   cards:[
     {wordType:"noun",english:"Smile",arabicBase:"اِبْتِسَامَة",forms:{singular:"اِبْتِسَامَة",plural:"اِبْتِسَامَات"}},
     {wordType:"verb",english:"To answer",arabicBase:"أَجَابَ",forms:{past:"أَجَابَ",present:"يُجِيبُ",imperative:"أَجِبْ",masdar:"إِجَابَة",activePart:"مُجِيب",passivePart:"مُجَاب"}},
     {wordType:"adjective",english:"More wonderful",arabicBase:"أَرْوَع",forms:{singular:"أَرْوَع"}},
     {wordType:"noun",english:"Disturbance",arabicBase:"إِزْعَاج",forms:{singular:"إِزْعَاج"}},
     {wordType:"noun",english:"Astonishment",arabicBase:"اِسْتِغْرَاب",forms:{singular:"اِسْتِغْرَاب"}},
     {wordType:"noun",english:"Sounds / voices",arabicBase:"صَوْت",forms:{singular:"صَوْت",plural:"أَصْوَات"}},
     {wordType:"noun",english:"Finger",arabicBase:"إِصْبَع",forms:{singular:"إِصْبَع",plural:"أَصَابِع"}},
     {wordType:"adjective",english:"Non-Arab / foreign",arabicBase:"أَعْجَمِيّ",forms:{singular:"أَعْجَمِيّ"}},
     {wordType:"verb",english:"To mix / blend",arabicBase:"اِمْتَزَجَ",forms:{past:"اِمْتَزَجَ",present:"يَمْتَزِجُ",imperative:"اِمْتَزِجْ",masdar:"اِمْتِزَاج",activePart:"مُمْتَزِج"}},
     {wordType:"noun",english:"Motherhood",arabicBase:"أُمُومَة",forms:{singular:"أُمُومَة"}},
     {wordType:"noun",english:"Waiting",arabicBase:"اِنْتِظَار",forms:{singular:"اِنْتِظَار"}},
     {wordType:"verb",english:"To smile",arabicBase:"تَبَسَّمَ",forms:{past:"تَبَسَّمَ",present:"يَتَبَسَّمُ",imperative:"تَبَسَّمْ",masdar:"تَبَسُّم",activePart:"مُتَبَسِّم"}},
     {wordType:"noun",english:"Analysis",arabicBase:"تَحْلِيل",forms:{singular:"تَحْلِيل",plural:"تَحْلِيلَات"}},
     {wordType:"noun",english:"Sides / aspects",arabicBase:"جَانِب",forms:{singular:"جَانِب",plural:"جَوَانِب"}},
     {wordType:"noun",english:"Nanny / incubator",arabicBase:"حَاضِنَة",forms:{singular:"حَاضِنَة",plural:"حَوَاضِن"}},
     {wordType:"noun",english:"Love",arabicBase:"حُبّ",forms:{singular:"حُبّ"}},
     {wordType:"noun",english:"Presence / attendance",arabicBase:"حُضُور",forms:{singular:"حُضُور"}},
     {wordType:"verb",english:"To lighten / reduce",arabicBase:"خَفَّفَ",forms:{past:"خَفَّفَ",present:"يُخَفِّفُ",imperative:"خَفِّفْ",masdar:"تَخْفِيف",activePart:"مُخَفِّف",passivePart:"مُخَفَّف"}},
     {wordType:"noun",english:"Warmth",arabicBase:"دِفْء",forms:{singular:"دِفْء"}},
     {wordType:"noun",english:"Nursing / breastfeeding",arabicBase:"رَضَاعَة",forms:{singular:"رَضَاعَة"}},
     {wordType:"verb",english:"To nurse / suckle",arabicBase:"رَضَعَ",forms:{past:"رَضَعَ",present:"يَرْضَعُ",imperative:"اُرْضَعْ",masdar:"رَضَاعَة",activePart:"رَاضِع"}},
     {wordType:"noun",english:"Morning",arabicBase:"صَبَاح",forms:{singular:"صَبَاح"}},
     {wordType:"noun",english:"Shame / disgrace",arabicBase:"عَار",forms:{singular:"عَار"}},
     {wordType:"noun",english:"Element",arabicBase:"عُنْصُر",forms:{singular:"عُنْصُر",plural:"عَنَاصِر"}},
     {wordType:"noun",english:"Food / nourishment",arabicBase:"غِذَاء",forms:{singular:"غِذَاء",plural:"أَغْذِيَة"}},
     {wordType:"noun",english:"Suddenness",arabicBase:"فَجْأَة",forms:{singular:"فَجْأَة"}},
     {wordType:"noun",english:"Sector",arabicBase:"قِطَاع",forms:{singular:"قِطَاع",plural:"قِطَاعَات"}},
     {wordType:"noun",english:"Structure / basis",arabicBase:"قِوَام",forms:{singular:"قِوَام"}},
     {wordType:"noun",english:"Restriction / shackle",arabicBase:"قَيْد",forms:{singular:"قَيْد",plural:"قُيُود"}},
     {wordType:"adjective",english:"Latent / hidden",arabicBase:"كَامِن",forms:{singular:"كَامِن",feminine:"كَامِنَة"}},
     {wordType:"noun",english:"Old age / greatness",arabicBase:"كِبَر",forms:{singular:"كِبَر"}},
     {wordType:"noun",english:"Liar",arabicBase:"كَذَّاب",forms:{singular:"كَذَّاب",feminine:"كَذَّابَة"}},
     {wordType:"noun",english:"Milk / yogurt",arabicBase:"لَبَن",forms:{singular:"لَبَن"}},
     {wordType:"verb",english:"To resort to / take refuge",arabicBase:"لَجَأَ",forms:{past:"لَجَأَ",present:"يَلْجَأُ",imperative:"اِلْجَأْ",masdar:"لُجُوء",activePart:"لَاجِئ",harf:"إِلَى"}},
     {wordType:"verb",english:"To wrap / wind",arabicBase:"لَفَّ",forms:{past:"لَفَّ",present:"يَلُفُّ",imperative:"لُفَّ",masdar:"لَفّ",activePart:"لَافّ",passivePart:"مَلْفُوف"}},
     {wordType:"verb",english:"To pant",arabicBase:"لَهَثَ",forms:{past:"لَهَثَ",present:"يَلْهَثُ",imperative:"اِلْهَثْ",masdar:"لَهَث",activePart:"لَاهِث"}},
     {wordType:"adjective",english:"Material / physical",arabicBase:"مَادِّيّ",forms:{singular:"مَادِّيّ",feminine:"مَادِّيَّة"}},
     {wordType:"noun",english:"Identity",arabicBase:"هُوِيَّة",forms:{singular:"هُوِيَّة"}},
     {wordType:"noun",english:"Advice / will (testament)",arabicBase:"وَصِيَّة",forms:{singular:"وَصِيَّة",plural:"وَصَايَا"}},
     {wordType:"noun",english:"Functions / jobs",arabicBase:"وَظِيفَة",forms:{singular:"وَظِيفَة",plural:"وَظَائِف"}},
     {wordType:"noun",english:"Death / passing",arabicBase:"وَفَاة",forms:{singular:"وَفَاة"}},
     {wordType:"verb",english:"To grant success",arabicBase:"وَفَّقَ",forms:{past:"وَفَّقَ",present:"يُوَفِّقُ",imperative:"وَفِّقْ",masdar:"تَوْفِيق",activePart:"مُوَفِّق",passivePart:"مُوَفَّق"}},
     {wordType:"noun",english:"Newborn",arabicBase:"وَلِيد",forms:{singular:"وَلِيد",plural:"وِلْدَان"}},
     {wordType:"noun",english:"Feast / banquet",arabicBase:"وَلِيمَة",forms:{singular:"وَلِيمَة",plural:"وَلَائِم"}},
   ]},
  {id:"preset-byy4-u1", title:"Bayna Yadayk Book 4 · Unit 1 — The Harms Of Smoking", unitId:"4-1", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"noun",english:"Smoking",arabicBase:"تَدْخِين",forms:{singular:"تَدْخِين"}},
     {wordType:"noun",english:"Cigarette",arabicBase:"سِيجَارَة",forms:{singular:"سِيجَارَة",plural:"سَجَائِر"}},
     {wordType:"noun",english:"Tobacco",arabicBase:"تَبْغ",forms:{singular:"تَبْغ"}},
     {wordType:"noun",english:"Prohibition",arabicBase:"تَحْرِيم",forms:{singular:"تَحْرِيم"}},
     {wordType:"noun",english:"Danger",arabicBase:"خَطَر",forms:{singular:"خَطَر",plural:"أَخْطَار"}},
     {wordType:"noun",english:"Fire",arabicBase:"حَرِيق",forms:{singular:"حَرِيق",plural:"حَرَائِق"}},
     {wordType:"adjective",english:"Vile / malignant",arabicBase:"خَبِيث",forms:{singular:"خَبِيث",feminine:"خَبِيثَة",plural:"خَبَائِث"}},
     {wordType:"noun",english:"Smoker",arabicBase:"مُدَخِّن",forms:{singular:"مُدَخِّن",plural:"مُدَخِّنُون"}},
     {wordType:"noun",english:"Epidemic",arabicBase:"وَبَاء",forms:{singular:"وَبَاء",plural:"أَوْبِئَة"}},
     {wordType:"noun",english:"Health",arabicBase:"صِحَّة",forms:{singular:"صِحَّة"}},
     {wordType:"noun",english:"Old age",arabicBase:"شَيْخُوخَة",forms:{singular:"شَيْخُوخَة"}},
     {wordType:"noun",english:"Youth",arabicBase:"شَبَاب",forms:{singular:"شَبَاب"}},
     {wordType:"verb",english:"To flare up / break out (fire)",arabicBase:"شَبَّ",forms:{past:"شَبَّ",present:"يَشِبُّ",imperative:"شِبَّ",masdar:"شَبَاب",activePart:"شَابّ"}},
     {wordType:"verb",english:"To be proven / established",arabicBase:"ثَبَتَ",forms:{past:"ثَبَتَ",present:"يَثْبُتُ",imperative:"اُثْبُتْ",masdar:"ثُبُوت",activePart:"ثَابِت"}},
     {wordType:"verb",english:"To conflict / contradict",arabicBase:"تَعَارَضَ",forms:{past:"تَعَارَضَ",present:"يَتَعَارَضُ",imperative:"تَعَارَضْ",masdar:"تَعَارُض",activePart:"مُتَعَارِض"}},
     {wordType:"verb",english:"To publish / spread",arabicBase:"نَشَرَ",forms:{past:"نَشَرَ",present:"يَنْشُرُ",imperative:"اُنْشُرْ",masdar:"نَشْر",activePart:"نَاشِر",passivePart:"مَنْشُور"}},
     {wordType:"verb",english:"To expose (to risk)",arabicBase:"عَرَّضَ",forms:{past:"عَرَّضَ",present:"يُعَرِّضُ",imperative:"عَرِّضْ",masdar:"تَعْرِيض",activePart:"مُعَرِّض",passivePart:"مُعَرَّض",harf:"لِـ"}},
     {wordType:"verb",english:"To kill",arabicBase:"قَتَلَ",forms:{past:"قَتَلَ",present:"يَقْتُلُ",imperative:"اُقْتُلْ",masdar:"قَتْل",activePart:"قَاتِل",passivePart:"مَقْتُول"}},
     {wordType:"verb",english:"To warn",arabicBase:"أَنْذَرَ",forms:{past:"أَنْذَرَ",present:"يُنْذِرُ",imperative:"أَنْذِرْ",masdar:"إِنْذَار",activePart:"مُنْذِر",passivePart:"مُنْذَر"}},
     {wordType:"noun",english:"Suicide",arabicBase:"اِنْتِحَار",forms:{singular:"اِنْتِحَار"}},
     {wordType:"noun",english:"Increase",arabicBase:"اِزْدِيَاد",forms:{singular:"اِزْدِيَاد"}},
     {wordType:"noun",english:"Wasting / loss",arabicBase:"إِضَاعَة",forms:{singular:"إِضَاعَة"}},
     {wordType:"verb",english:"To show / reveal",arabicBase:"أَظْهَرَ",forms:{past:"أَظْهَرَ",present:"يُظْهِرُ",imperative:"أَظْهِرْ",masdar:"إِظْهَار",activePart:"مُظْهِر",passivePart:"مُظْهَر"}},
     {wordType:"noun",english:"Advertisement / propaganda",arabicBase:"دِعَايَة",forms:{singular:"دِعَايَة",plural:"دَعَايَات"}},
     {wordType:"adjective",english:"Wise / rational",arabicBase:"عَاقِل",forms:{singular:"عَاقِل",plural:"عُقَلَاء"}},
     {wordType:"noun",english:"Society",arabicBase:"مُجْتَمَع",forms:{singular:"مُجْتَمَع",plural:"مُجْتَمَعَات"}},
     {wordType:"adjective",english:"Escalating / rising",arabicBase:"مُتَصَاعِد",forms:{singular:"مُتَصَاعِد"}},
     {wordType:"adjective",english:"Serious / grave",arabicBase:"جَسِيم",forms:{singular:"جَسِيم",feminine:"جَسِيمَة"}},
     {wordType:"adjective",english:"Necessary",arabicBase:"ضَرُورِيّ",forms:{singular:"ضَرُورِيّ",feminine:"ضَرُورِيَّة"}},
     {wordType:"verb",english:"To harm",arabicBase:"ضَرَّ",forms:{past:"ضَرَّ",present:"يَضُرُّ",imperative:"ضُرَّ",masdar:"ضَرَر",activePart:"ضَارّ"}},
     {wordType:"noun",english:"Destruction / peril",arabicBase:"تَهْلُكَة",forms:{singular:"تَهْلُكَة"}},
     {wordType:"noun",english:"Money / wealth",arabicBase:"مَال",forms:{singular:"مَال",plural:"أَمْوَال"}},
     {wordType:"noun",english:"Mankind (lit. sons of Adam)",arabicBase:"بَنُو آدَم",forms:{singular:"بَنُو آدَم"}},
   ]},
  {id:"preset-byy4-u2", title:"Bayna Yadayk Book 4 · Unit 2 — Recreation", unitId:"4-2", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"noun",english:"Permissibility",arabicBase:"إِبَاحَة",forms:{singular:"إِبَاحَة"}},
     {wordType:"verb",english:"To seek / desire",arabicBase:"اِبْتَغَى",forms:{past:"اِبْتَغَى",present:"يَبْتَغِي",imperative:"اِبْتَغِ",masdar:"اِبْتِغَاء",activePart:"مُبْتَغٍ"}},
     {wordType:"noun",english:"Body",arabicBase:"بَدَن",forms:{singular:"بَدَن",plural:"أَبْدَان"}},
     {wordType:"verb",english:"To permit / allow",arabicBase:"أَجَازَ",forms:{past:"أَجَازَ",present:"يُجِيزُ",imperative:"أَجِزْ",masdar:"إِجَازَة",activePart:"مُجِيز",passivePart:"مُجَاز"}},
     {wordType:"verb",english:"To strive / exert effort",arabicBase:"اِجْتَهَدَ",forms:{past:"اِجْتَهَدَ",present:"يَجْتَهِدُ",imperative:"اِجْتَهِدْ",masdar:"اِجْتِهَاد",activePart:"مُجْتَهِد"}},
     {wordType:"noun",english:"Brotherhood",arabicBase:"أُخُوَّة",forms:{singular:"أُخُوَّة"}},
     {wordType:"noun",english:"Investment",arabicBase:"اِسْتِثْمَار",forms:{singular:"اِسْتِثْمَار"}},
     {wordType:"noun",english:"Woman",arabicBase:"اِمْرَأَة",forms:{singular:"اِمْرَأَة",plural:"نِسَاء"}},
     {wordType:"verb",english:"To waste / squander",arabicBase:"أَهْدَرَ",forms:{past:"أَهْدَرَ",present:"يُهْدِرُ",imperative:"أَهْدِرْ",masdar:"إِهْدَار",activePart:"مُهْدِر",passivePart:"مُهْدَر"}},
     {wordType:"verb",english:"To lag behind",arabicBase:"تَخَلَّفَ",forms:{past:"تَخَلَّفَ",present:"يَتَخَلَّفُ",imperative:"تَخَلَّفْ",masdar:"تَخَلُّف",activePart:"مُتَخَلِّف"}},
     {wordType:"verb",english:"To leave behind",arabicBase:"خَلَّفَ",forms:{past:"خَلَّفَ",present:"يُخَلِّفُ",imperative:"خَلِّفْ",masdar:"تَخْلِيف",activePart:"مُخَلِّف",passivePart:"مُخَلَّف"}},
     {wordType:"verb",english:"To overcome",arabicBase:"تَغَلَّبَ",forms:{past:"تَغَلَّبَ",present:"يَتَغَلَّبُ",imperative:"تَغَلَّبْ",masdar:"تَغَلُّب",activePart:"مُتَغَلِّب",harf:"عَلَى"}},
     {wordType:"verb",english:"To call each other names",arabicBase:"تَنَابَزَ",forms:{past:"تَنَابَزَ",present:"يَتَنَابَزُ",imperative:"تَنَابَزْ",masdar:"تَنَابُز",activePart:"مُتَنَابِز"}},
     {wordType:"noun",english:"Effort",arabicBase:"جُهْد",forms:{singular:"جُهْد",plural:"جُهُود"}},
     {wordType:"noun",english:"Right / truth",arabicBase:"حَقّ",forms:{singular:"حَقّ",plural:"حُقُوق"}},
     {wordType:"noun",english:"Good deed",arabicBase:"حَسَنَة",forms:{singular:"حَسَنَة",plural:"حَسَنَات"}},
     {wordType:"verb",english:"To joke with / tease",arabicBase:"دَاعَبَ",forms:{past:"دَاعَبَ",present:"يُدَاعِبُ",imperative:"دَاعِبْ",masdar:"مُدَاعَبَة",activePart:"مُدَاعِب"}},
     {wordType:"verb",english:"To narrate",arabicBase:"رَوَى",forms:{past:"رَوَى",present:"يَرْوِي",imperative:"اِرْوِ",masdar:"رِوَايَة",activePart:"رَاوٍ",passivePart:"مَرْوِيّ"}},
     {wordType:"noun",english:"Mockery / sarcasm",arabicBase:"سُخْرِيَة",forms:{singular:"سُخْرِيَة"}},
     {wordType:"verb",english:"To mock",arabicBase:"سَخِرَ",forms:{past:"سَخِرَ",present:"يَسْخَرُ",imperative:"اِسْخَرْ",masdar:"سُخْرِيَة",activePart:"سَاخِر",harf:"مِنْ"}},
     {wordType:"noun",english:"Anecdote / joke",arabicBase:"طُرْفَة",forms:{singular:"طُرْفَة",plural:"طَرَائِف"}},
     {wordType:"noun",english:"Element / factor",arabicBase:"عُنْصُر",forms:{singular:"عُنْصُر",plural:"عَنَاصِر"}},
     {wordType:"noun",english:"Factor / worker",arabicBase:"عَامِل",forms:{singular:"عَامِل",plural:"عَوَامِل"}},
     {wordType:"noun",english:"Saying / statement",arabicBase:"قَوْل",forms:{singular:"قَوْل",plural:"أَقْوَال"}},
     {wordType:"verb",english:"To straighten / evaluate",arabicBase:"قَوَّمَ",forms:{past:"قَوَّمَ",present:"يُقَوِّمُ",imperative:"قَوِّمْ",masdar:"تَقْوِيم",activePart:"مُقَوِّم",passivePart:"مُقَوَّم"}},
     {wordType:"noun",english:"Value",arabicBase:"قِيمَة",forms:{singular:"قِيمَة",plural:"قِيَم"}},
     {wordType:"noun",english:"Lying",arabicBase:"كَذِب",forms:{singular:"كَذِب"}},
     {wordType:"verb",english:"To slander / backbite",arabicBase:"لَمَزَ",forms:{past:"لَمَزَ",present:"يَلْمِزُ",imperative:"اِلْمِزْ",masdar:"لَمْز",activePart:"لَامِز",passivePart:"مَلْمُوز"}},
     {wordType:"adjective",english:"Permitted",arabicBase:"مُبَاح",forms:{singular:"مُبَاح",feminine:"مُبَاحَة"}},
     {wordType:"noun",english:"Joy / playfulness",arabicBase:"مَرَح",forms:{singular:"مَرَح"}},
     {wordType:"verb",english:"To joke",arabicBase:"مَزَحَ",forms:{past:"مَزَحَ",present:"يَمْزَحُ",imperative:"اِمْزَحْ",masdar:"مَزْح",activePart:"مَازِح"}},
     {wordType:"verb",english:"To get bored",arabicBase:"مَلَّ",forms:{past:"مَلَّ",present:"يَمَلُّ",imperative:"اِمْلَلْ",masdar:"مَلَل",activePart:"مَالّ"}},
     {wordType:"noun",english:"Meaning",arabicBase:"مَعْنَى",forms:{singular:"مَعْنَى",plural:"مَعَانٍ"}},
     {wordType:"adjective",english:"Legitimate / lawful",arabicBase:"مَشْرُوع",forms:{singular:"مَشْرُوع",feminine:"مَشْرُوعَة"}},
   ]},
  {id:"preset-byy4-u3", title:"Bayna Yadayk Book 4 · Unit 3 — Choosing A Spouse", unitId:"4-3", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"noun",english:"Husband / spouse",arabicBase:"زَوْج",forms:{singular:"زَوْج",plural:"أَزْوَاج"}},
     {wordType:"verb",english:"To consult",arabicBase:"اِسْتَشَارَ",forms:{past:"اِسْتَشَارَ",present:"يَسْتَشِيرُ",imperative:"اِسْتَشِرْ",masdar:"اِسْتِشَارَة",activePart:"مُسْتَشِير",passivePart:"مُسْتَشَار"}},
     {wordType:"verb",english:"To be independent of / dispense with",arabicBase:"اِسْتَغْنَى",forms:{past:"اِسْتَغْنَى",present:"يَسْتَغْنِي",imperative:"اِسْتَغْنِ",masdar:"اِسْتِغْنَاء",activePart:"مُسْتَغْنٍ",harf:"عَنْ"}},
     {wordType:"verb",english:"To feel reassured",arabicBase:"اِطْمَأَنَّ",forms:{past:"اِطْمَأَنَّ",present:"يَطْمَئِنُّ",imperative:"اِطْمَئِنَّ",masdar:"اِطْمِئْنَان",activePart:"مُطْمَئِنّ"}},
     {wordType:"verb",english:"To feel safe / trust",arabicBase:"أَمِنَ",forms:{past:"أَمِنَ",present:"يَأْمَنُ",imperative:"اِئْمَنْ",masdar:"أَمْن",activePart:"آمِن"}},
     {wordType:"verb",english:"To enrich / make wealthy",arabicBase:"أَغْنَى",forms:{past:"أَغْنَى",present:"يُغْنِي",imperative:"أَغْنِ",masdar:"إِغْنَاء",activePart:"مُغْنٍ",passivePart:"مُغْنًى"}},
     {wordType:"verb",english:"To reflect / contemplate",arabicBase:"تَفَكَّرَ",forms:{past:"تَفَكَّرَ",present:"يَتَفَكَّرُ",imperative:"تَفَكَّرْ",masdar:"تَفَكُّر",activePart:"مُتَفَكِّر"}},
     {wordType:"verb",english:"To think / calculate",arabicBase:"حَسِبَ",forms:{past:"حَسِبَ",present:"يَحْسَبُ",imperative:"اِحْسِبْ",masdar:"حِسْبَان",activePart:"حَاسِب",passivePart:"مَحْسُوب"}},
     {wordType:"verb",english:"To address / speak to",arabicBase:"خَاطَبَ",forms:{past:"خَاطَبَ",present:"يُخَاطِبُ",imperative:"خَاطِبْ",masdar:"مُخَاطَبَة",activePart:"مُخَاطِب",passivePart:"مُخَاطَب"}},
     {wordType:"noun",english:"Step",arabicBase:"خُطْوَة",forms:{singular:"خُطْوَة",plural:"خُطُوَات"}},
     {wordType:"verb",english:"To create",arabicBase:"خَلَقَ",forms:{past:"خَلَقَ",present:"يَخْلُقُ",imperative:"اُخْلُقْ",masdar:"خَلْق",activePart:"خَالِق",passivePart:"مَخْلُوق"}},
     {wordType:"noun",english:"Character / disposition",arabicBase:"خُلُق",forms:{singular:"خُلُق",plural:"أَخْلَاق"}},
     {wordType:"noun",english:"Offspring / progeny",arabicBase:"ذُرِّيَّة",forms:{singular:"ذُرِّيَّة",plural:"ذُرِّيَّات"}},
     {wordType:"noun",english:"Bond / tie",arabicBase:"رَابِطَة",forms:{singular:"رَابِطَة",plural:"رَوَابِط"}},
     {wordType:"noun",english:"Housewife",arabicBase:"رَبَّةُ بَيْت",forms:{singular:"رَبَّةُ بَيْت"}},
     {wordType:"verb",english:"To marry off",arabicBase:"زَوَّجَ",forms:{past:"زَوَّجَ",present:"يُزَوِّجُ",imperative:"زَوِّجْ",masdar:"تَزْوِيج",activePart:"مُزَوِّج",passivePart:"مُزَوَّج"}},
     {wordType:"adjective",english:"Remaining / rest of",arabicBase:"سَائِر",forms:{singular:"سَائِر"}},
     {wordType:"adjective",english:"Righteous / good",arabicBase:"صَالِح",forms:{singular:"صَالِح",feminine:"صَالِحَة",plural:"صَالِحُون"}},
     {wordType:"noun",english:"Quality / attribute",arabicBase:"صِفَة",forms:{singular:"صِفَة",plural:"صِفَات"}},
     {wordType:"adjective",english:"Good / kind",arabicBase:"طَيِّب",forms:{singular:"طَيِّب",feminine:"طَيِّبَة"}},
     {wordType:"adjective",english:"Generous / noble",arabicBase:"كَرِيم",forms:{singular:"كَرِيم",feminine:"كَرِيمَة",plural:"كِرَام"}},
     {wordType:"verb",english:"To treat / deal with",arabicBase:"عَامَلَ",forms:{past:"عَامَلَ",present:"يُعَامِلُ",imperative:"عَامِلْ",masdar:"مُعَامَلَة",activePart:"مُعَامِل",passivePart:"مُعَامَل"}},
     {wordType:"noun",english:"Excuse",arabicBase:"عُذْر",forms:{singular:"عُذْر",plural:"أَعْذَار"}},
     {wordType:"adjective",english:"Wide / broad",arabicBase:"عَرِيض",forms:{singular:"عَرِيض",feminine:"عَرِيضَة"}},
     {wordType:"noun",english:"Dignity / honor",arabicBase:"كَرَامَة",forms:{singular:"كَرَامَة"}},
     {wordType:"noun",english:"Example",arabicBase:"مِثَال",forms:{singular:"مِثَال",plural:"أَمْثِلَة"}},
     {wordType:"noun",english:"Fiancée (betrothed woman)",arabicBase:"مَخْطُوبَة",forms:{singular:"مَخْطُوبَة"}},
     {wordType:"verb",english:"To prevent / forbid",arabicBase:"مَنَعَ",forms:{past:"مَنَعَ",present:"يَمْنَعُ",imperative:"اُمْنَعْ",masdar:"مَنْع",activePart:"مَانِع",passivePart:"مَمْنُوع"}},
     {wordType:"noun",english:"Affection / love",arabicBase:"مَوَدَّة",forms:{singular:"مَوَدَّة"}},
     {wordType:"noun",english:"Person / individual",arabicBase:"مَرْء",forms:{singular:"مَرْء"}},
     {wordType:"noun",english:"Agreement / consent",arabicBase:"مُوَافَقَة",forms:{singular:"مُوَافَقَة"}},
     {wordType:"verb",english:"To marry",arabicBase:"نَكَحَ",forms:{past:"نَكَحَ",present:"يَنْكِحُ",imperative:"اُنْكِحْ",masdar:"نِكَاح",activePart:"نَاكِح",passivePart:"مَنْكُوح"}},
     {wordType:"adjective",english:"Loving / affectionate",arabicBase:"وَدُود",forms:{singular:"وَدُود"}},
     {wordType:"noun",english:"Document",arabicBase:"وَثِيقَة",forms:{singular:"وَثِيقَة",plural:"وَثَائِق"}},
     {wordType:"noun",english:"Rule / base",arabicBase:"قَاعِدَة",forms:{singular:"قَاعِدَة",plural:"قَوَاعِد"}},
   ]},
  {id:"preset-byy4-u4", title:"Bayna Yadayk Book 4 · Unit 4 — Holy Cities", unitId:"4-4", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"noun",english:"Land / earth",arabicBase:"أَرْض",forms:{singular:"أَرْض",plural:"أَرَاضٍ"}},
     {wordType:"noun",english:"Part",arabicBase:"جُزْء",forms:{singular:"جُزْء",plural:"أَجْزَاء"}},
     {wordType:"noun",english:"Captive",arabicBase:"أَسِير",forms:{singular:"أَسِير",plural:"أَسْرَى"}},
     {wordType:"noun",english:"Month",arabicBase:"شَهْر",forms:{singular:"شَهْر",plural:"أَشْهُر"}},
     {wordType:"verb",english:"To usurp / seize by force",arabicBase:"اِغْتَصَبَ",forms:{past:"اِغْتَصَبَ",present:"يَغْتَصِبُ",imperative:"اِغْتَصِبْ",masdar:"اِغْتِصَاب",activePart:"مُغْتَصِب",passivePart:"مُغْتَصَب"}},
     {wordType:"verb",english:"To divide among themselves",arabicBase:"اِقْتَسَمَ",forms:{past:"اِقْتَسَمَ",present:"يَقْتَسِمُ",imperative:"اِقْتَسِمْ",masdar:"اِقْتِسَام",activePart:"مُقْتَسِم",passivePart:"مُقْتَسَم"}},
     {wordType:"verb",english:"To illuminate",arabicBase:"أَنَارَ",forms:{past:"أَنَارَ",present:"يُنِيرُ",imperative:"أَنِرْ",masdar:"إِنَارَة",activePart:"مُنِير",passivePart:"مُنَار"}},
     {wordType:"verb",english:"To disperse / squander",arabicBase:"بَدَّدَ",forms:{past:"بَدَّدَ",present:"يُبَدِّدُ",imperative:"بَدِّدْ",masdar:"تَبْدِيد",activePart:"مُبَدِّد",passivePart:"مُبَدَّد"}},
     {wordType:"adjective",english:"Seeing / perceptive",arabicBase:"بَصِير",forms:{singular:"بَصِير"}},
     {wordType:"noun",english:"Spot / area",arabicBase:"بُقْعَة",forms:{singular:"بُقْعَة",plural:"بِقَاع"}},
     {wordType:"verb",english:"To remain",arabicBase:"بَقِيَ",forms:{past:"بَقِيَ",present:"يَبْقَى",imperative:"اِبْقَ",masdar:"بَقَاء",activePart:"بَاقٍ"}},
     {wordType:"noun",english:"Pilgrim",arabicBase:"حَاجّ",forms:{singular:"حَاجّ",plural:"حُجَّاج"}},
     {wordType:"noun",english:"Mountain",arabicBase:"جَبَل",forms:{singular:"جَبَل",plural:"جِبَال"}},
     {wordType:"noun",english:"Vicinity / neighborhood",arabicBase:"جِوَار",forms:{singular:"جِوَار"}},
     {wordType:"verb",english:"To fluctuate / turn over",arabicBase:"تَقَلَّبَ",forms:{past:"تَقَلَّبَ",present:"يَتَقَلَّبُ",imperative:"تَقَلَّبْ",masdar:"تَقَلُّب",activePart:"مُتَقَلِّب"}},
     {wordType:"noun",english:"Sanctuary",arabicBase:"حَرَم",forms:{singular:"حَرَم",plural:"أَحْرَام"}},
     {wordType:"noun",english:"Traveler / explorer",arabicBase:"رَحَّالَة",forms:{singular:"رَحَّالَة"}},
     {wordType:"adjective",english:"All-Hearing",arabicBase:"سَمِيع",forms:{singular:"سَمِيع"}},
     {wordType:"noun",english:"Half / direction",arabicBase:"شَطْر",forms:{singular:"شَطْر"}},
     {wordType:"noun",english:"Crack / split",arabicBase:"شَقّ",forms:{singular:"شَقّ"}},
     {wordType:"verb",english:"To include / embrace",arabicBase:"ضَمَّ",forms:{past:"ضَمَّ",present:"يَضُمُّ",imperative:"ضُمَّ",masdar:"ضَمّ",activePart:"ضَامّ",passivePart:"مَضْمُوم"}},
     {wordType:"verb",english:"To express",arabicBase:"عَبَّرَ",forms:{past:"عَبَّرَ",present:"يُعَبِّرُ",imperative:"عَبِّرْ",masdar:"تَعْبِير",activePart:"مُعَبِّر",harf:"عَنْ"}},
     {wordType:"adjective",english:"Unique",arabicBase:"فَرِيد",forms:{singular:"فَرِيد",feminine:"فَرِيدَة"}},
     {wordType:"noun",english:"Team / group",arabicBase:"فَرِيق",forms:{singular:"فَرِيق",plural:"فِرَق"}},
     {wordType:"adjective",english:"Ancient / old",arabicBase:"قَدِيم",forms:{singular:"قَدِيم",feminine:"قَدِيمَة",plural:"قُدَمَاء"}},
     {wordType:"verb",english:"To disbelieve",arabicBase:"كَفَرَ",forms:{past:"كَفَرَ",present:"يَكْفُرُ",imperative:"اُكْفُرْ",masdar:"كُفْر",activePart:"كَافِر"}},
     {wordType:"adjective",english:"Blessed",arabicBase:"مُبَارَك",forms:{singular:"مُبَارَك",feminine:"مُبَارَكَة"}},
     {wordType:"noun",english:"Emigrant",arabicBase:"مُهَاجِر",forms:{singular:"مُهَاجِر",plural:"مُهَاجِرُون"}},
     {wordType:"noun",english:"Landmark",arabicBase:"مَعْلَم",forms:{singular:"مَعْلَم",plural:"مَعَالِم"}},
     {wordType:"noun",english:"One performing Umrah",arabicBase:"مُعْتَمِر",forms:{singular:"مُعْتَمِر",plural:"مُعْتَمِرُون"}},
     {wordType:"noun",english:"Cemetery",arabicBase:"مَقْبَرَة",forms:{singular:"مَقْبَرَة",plural:"مَقَابِر"}},
     {wordType:"noun",english:"Birthplace / place of origin",arabicBase:"مَسْقَط",forms:{singular:"مَسْقَط"}},
     {wordType:"noun",english:"Prophet",arabicBase:"نَبِيّ",forms:{singular:"نَبِيّ",plural:"أَنْبِيَاء"}},
     {wordType:"noun",english:"Light",arabicBase:"نُور",forms:{singular:"نُور",plural:"أَنْوَار"}},
     {wordType:"noun",english:"Guidance",arabicBase:"هُدًى",forms:{singular:"هُدًى"}},
     {wordType:"noun",english:"Valley",arabicBase:"وَادٍ",forms:{singular:"وَادٍ",plural:"أَوْدِيَة"}},
   ]},
  {id:"preset-byy4-u5", title:"Bayna Yadayk Book 4 · Unit 5 — Schools & Scientific Institutes", unitId:"4-5", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"verb",english:"To expand / be spacious",arabicBase:"اِتَّسَعَ",forms:{past:"اِتَّسَعَ",present:"يَتَّسِعُ",imperative:"اِتَّسِعْ",masdar:"اِتِّسَاع",activePart:"مُتَّسِع"}},
     {wordType:"verb",english:"To contain",arabicBase:"اِحْتَوَى",forms:{past:"اِحْتَوَى",present:"يَحْتَوِي",imperative:"اِحْتَوِ",masdar:"اِحْتِوَاء",activePart:"مُحْتَوٍ",harf:"عَلَى"}},
     {wordType:"noun",english:"Corridor / hall",arabicBase:"رِوَاق",forms:{singular:"رِوَاق",plural:"أَرْوِقَة"}},
     {wordType:"verb",english:"To resemble",arabicBase:"أَشْبَهَ",forms:{past:"أَشْبَهَ",present:"يُشْبِهُ",imperative:"أَشْبِهْ",masdar:"إِشْبَاه",activePart:"مُشْبِه"}},
     {wordType:"noun",english:"Thousand",arabicBase:"أَلْف",forms:{singular:"أَلْف",plural:"آلَاف"}},
     {wordType:"noun",english:"Separation",arabicBase:"اِنْفِصَال",forms:{singular:"اِنْفِصَال"}},
     {wordType:"noun",english:"Endowment",arabicBase:"وَقْف",forms:{singular:"وَقْف",plural:"أَوْقَاف"}},
     {wordType:"noun",english:"Orphan",arabicBase:"يَتِيم",forms:{singular:"يَتِيم",plural:"أَيْتَام"}},
     {wordType:"noun",english:"Merchant",arabicBase:"تَاجِر",forms:{singular:"تَاجِر",plural:"تُجَّار"}},
     {wordType:"noun",english:"Mosque / one who gathers",arabicBase:"جَامِع",forms:{singular:"جَامِع",plural:"جَوَامِع"}},
     {wordType:"adjective",english:"Present",arabicBase:"حَاضِر",forms:{singular:"حَاضِر"}},
     {wordType:"noun",english:"Memorization / preservation",arabicBase:"حِفْظ",forms:{singular:"حِفْظ"}},
     {wordType:"adjective",english:"Charitable / good",arabicBase:"خَيِّر",forms:{singular:"خَيِّر",feminine:"خَيِّرَة"}},
     {wordType:"verb",english:"To designate / allocate",arabicBase:"خَصَّصَ",forms:{past:"خَصَّصَ",present:"يُخَصِّصُ",imperative:"خَصِّصْ",masdar:"تَخْصِيص",activePart:"مُخَصِّص",passivePart:"مُخَصَّص"}},
     {wordType:"adjective",english:"Internal / boarding (school)",arabicBase:"دَاخِلِيّ",forms:{singular:"دَاخِلِيّ",feminine:"دَاخِلِيَّة"}},
     {wordType:"noun",english:"Presidency / leadership",arabicBase:"رِئَاسَة",forms:{singular:"رِئَاسَة"}},
     {wordType:"noun",english:"President / head",arabicBase:"رَئِيس",forms:{singular:"رَئِيس",plural:"رُؤَسَاء"}},
     {wordType:"noun",english:"Profit",arabicBase:"رِبْح",forms:{singular:"رِبْح",plural:"أَرْبَاح"}},
     {wordType:"verb",english:"To witness",arabicBase:"شَهِدَ",forms:{past:"شَهِدَ",present:"يَشْهَدُ",imperative:"اِشْهَدْ",masdar:"شَهَادَة",activePart:"شَاهِد",passivePart:"مَشْهُود"}},
     {wordType:"noun",english:"Islamic law",arabicBase:"شَرِيعَة",forms:{singular:"شَرِيعَة",plural:"شَرَائِع"}},
     {wordType:"noun",english:"Fame",arabicBase:"شُهْرَة",forms:{singular:"شُهْرَة"}},
     {wordType:"noun",english:"Maker / craftsman",arabicBase:"صَانِع",forms:{singular:"صَانِع",plural:"صُنَّاع"}},
     {wordType:"verb",english:"To read / peruse",arabicBase:"طَالَعَ",forms:{past:"طَالَعَ",present:"يُطَالِعُ",imperative:"طَالِعْ",masdar:"مُطَالَعَة",activePart:"مُطَالِع",passivePart:"مُطَالَع"}},
     {wordType:"noun",english:"Group / sect",arabicBase:"طَائِفَة",forms:{singular:"طَائِفَة",plural:"طَوَائِف"}},
     {wordType:"adjective",english:"High",arabicBase:"عَالٍ",forms:{singular:"عَالٍ",feminine:"عَالِيَة"}},
     {wordType:"verb",english:"To worship",arabicBase:"عَبَدَ",forms:{past:"عَبَدَ",present:"يَعْبُدُ",imperative:"اُعْبُدْ",masdar:"عِبَادَة",activePart:"عَابِد",passivePart:"مَعْبُود"}},
     {wordType:"verb",english:"To pledge / know of",arabicBase:"عَهِدَ",forms:{past:"عَهِدَ",present:"يَعْهَدُ",imperative:"اِعْهَدْ",masdar:"عَهْد",activePart:"عَاهِد",passivePart:"مَعْهُود"}},
     {wordType:"adjective",english:"Rich",arabicBase:"غَنِيّ",forms:{singular:"غَنِيّ",feminine:"غَنِيَّة",plural:"أَغْنِيَاء"}},
     {wordType:"noun",english:"Scarcity / small number",arabicBase:"قِلَّة",forms:{singular:"قِلَّة"}},
     {wordType:"noun",english:"Abundance",arabicBase:"كَثْرَة",forms:{singular:"كَثْرَة"}},
     {wordType:"noun",english:"Competence / efficiency",arabicBase:"كَفَاءَة",forms:{singular:"كَفَاءَة"}},
     {wordType:"adjective",english:"Numerous / multiple",arabicBase:"مُتَعَدِّد",forms:{singular:"مُتَعَدِّد",feminine:"مُتَعَدِّدَة"}},
     {wordType:"noun",english:"School of thought",arabicBase:"مَذْهَب",forms:{singular:"مَذْهَب",plural:"مَذَاهِب"}},
     {wordType:"noun",english:"Playground / field",arabicBase:"مَلْعَب",forms:{singular:"مَلْعَب",plural:"مَلَاعِب"}},
   ]},
  {id:"preset-byy4-u6", title:"Bayna Yadayk Book 4 · Unit 6 — Choosing Your Profession", unitId:"4-6", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"noun",english:"Connection / commitment",arabicBase:"اِرْتِبَاط",forms:{singular:"اِرْتِبَاط"}},
     {wordType:"noun",english:"Uprightness / integrity",arabicBase:"اِسْتِقَامَة",forms:{singular:"اِسْتِقَامَة"}},
     {wordType:"noun",english:"Acquisition",arabicBase:"اِكْتِسَاب",forms:{singular:"اِكْتِسَاب"}},
     {wordType:"noun",english:"People",arabicBase:"أُنَاس",forms:{singular:"إِنْسَان",plural:"أُنَاس"}},
     {wordType:"noun",english:"Sparkle / gleam",arabicBase:"بَرِيق",forms:{singular:"بَرِيق"}},
     {wordType:"verb",english:"To make sure / verify",arabicBase:"تَأَكَّدَ",forms:{past:"تَأَكَّدَ",present:"يَتَأَكَّدُ",imperative:"تَأَكَّدْ",masdar:"تَأَكُّد",activePart:"مُتَأَكِّد"}},
     {wordType:"verb",english:"To follow",arabicBase:"تَبِعَ",forms:{past:"تَبِعَ",present:"يَتْبَعُ",imperative:"اِتْبَعْ",masdar:"تَبَع",activePart:"تَابِع",passivePart:"مَتْبُوع"}},
     {wordType:"noun",english:"Attainment / achievement",arabicBase:"تَحْصِيل",forms:{singular:"تَحْصِيل"}},
     {wordType:"noun",english:"Training",arabicBase:"تَدْرِيب",forms:{singular:"تَدْرِيب"}},
     {wordType:"verb",english:"To get to know",arabicBase:"تَعَرَّفَ",forms:{past:"تَعَرَّفَ",present:"يَتَعَرَّفُ",imperative:"تَعَرَّفْ",masdar:"تَعَرُّف",activePart:"مُتَعَرِّف",harf:"عَلَى"}},
     {wordType:"verb",english:"To be disrupted / out of order",arabicBase:"تَعَطَّلَ",forms:{past:"تَعَطَّلَ",present:"يَتَعَطَّلُ",imperative:"تَعَطَّلْ",masdar:"تَعَطُّل",activePart:"مُتَعَطِّل"}},
     {wordType:"verb",english:"To plow / cultivate",arabicBase:"حَرَثَ",forms:{past:"حَرَثَ",present:"يَحْرُثُ",imperative:"اُحْرُثْ",masdar:"حَرْث",activePart:"حَارِث",passivePart:"مَحْرُوث"}},
     {wordType:"verb",english:"To inform",arabicBase:"خَبَّرَ",forms:{past:"خَبَّرَ",present:"يُخَبِّرُ",imperative:"خَبِّرْ",masdar:"تَخْبِير",activePart:"مُخَبِّر",passivePart:"مُخَبَّر"}},
     {wordType:"adjective",english:"Expert",arabicBase:"خَبِير",forms:{singular:"خَبِير",feminine:"خَبِيرَة",plural:"خُبَرَاء"}},
     {wordType:"verb",english:"To serve",arabicBase:"خَدَمَ",forms:{past:"خَدَمَ",present:"يَخْدُمُ",imperative:"اُخْدُمْ",masdar:"خِدْمَة",activePart:"خَادِم",passivePart:"مَخْدُوم"}},
     {wordType:"noun",english:"Plan",arabicBase:"خُطَّة",forms:{singular:"خُطَّة",plural:"خُطَط"}},
     {wordType:"noun",english:"Degree / grade",arabicBase:"دَرَجَة",forms:{singular:"دَرَجَة",plural:"دَرَجَات"}},
     {wordType:"noun",english:"Lord / master",arabicBase:"رَبّ",forms:{singular:"رَبّ",plural:"أَرْبَاب"}},
     {wordType:"noun",english:"Sustenance / provision",arabicBase:"رِزْق",forms:{singular:"رِزْق",plural:"أَرْزَاق"}},
     {wordType:"adjective",english:"Sound / safe",arabicBase:"سَلِيم",forms:{singular:"سَلِيم",feminine:"سَلِيمَة"}},
     {wordType:"noun",english:"Correctness",arabicBase:"صَوَاب",forms:{singular:"صَوَاب"}},
     {wordType:"adjective",english:"Difficult",arabicBase:"صَعْب",forms:{singular:"صَعْب",feminine:"صَعْبَة"}},
     {wordType:"verb",english:"To overcome / defeat",arabicBase:"غَلَبَ",forms:{past:"غَلَبَ",present:"يَغْلِبُ",imperative:"اِغْلِبْ",masdar:"غَلَب",activePart:"غَالِب",passivePart:"مَغْلُوب"}},
     {wordType:"adjective",english:"Varying / disparate",arabicBase:"مُتَفَاوِت",forms:{singular:"مُتَفَاوِت"}},
     {wordType:"adjective",english:"Connected / linked",arabicBase:"مُرْتَبِط",forms:{singular:"مُرْتَبِط"}},
     {wordType:"adjective",english:"Flexible",arabicBase:"مَرِن",forms:{singular:"مَرِن",feminine:"مَرِنَة"}},
     {wordType:"noun",english:"Future",arabicBase:"مُسْتَقْبَل",forms:{singular:"مُسْتَقْبَل"}},
     {wordType:"noun",english:"Interest / benefit",arabicBase:"مَصْلَحَة",forms:{singular:"مَصْلَحَة",plural:"مَصَالِح"}},
     {wordType:"noun",english:"Companionship / cohabitation",arabicBase:"مُعَاشَرَة",forms:{singular:"مُعَاشَرَة"}},
     {wordType:"noun",english:"Livelihood",arabicBase:"مَعِيشَة",forms:{singular:"مَعِيشَة"}},
     {wordType:"noun",english:"Profession",arabicBase:"مِهْنَة",forms:{singular:"مِهْنَة",plural:"مِهَن"}},
     {wordType:"noun",english:"Inclination / tendency",arabicBase:"مَيْل",forms:{singular:"مَيْل",plural:"مُيُول"}},
     {wordType:"adjective",english:"Facilitated / made easy",arabicBase:"مُيَسَّر",forms:{singular:"مُيَسَّر"}},
     {wordType:"noun",english:"Advantage / feature",arabicBase:"مِيزَة",forms:{singular:"مِيزَة",plural:"مِيزَات"}},
   ]},
  {id:"preset-byy4-u7", title:"Bayna Yadayk Book 4 · Unit 7 — Arabic & The Qur'an", unitId:"4-7", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"verb",english:"To affect / influence",arabicBase:"أَثَّرَ",forms:{past:"أَثَّرَ",present:"يُؤَثِّرُ",imperative:"أَثِّرْ",masdar:"تَأْثِير",activePart:"مُؤَثِّر",passivePart:"مُؤَثَّر",harf:"فِي"}},
     {wordType:"verb",english:"To count / enumerate",arabicBase:"أَحْصَى",forms:{past:"أَحْصَى",present:"يُحْصِي",imperative:"أَحْصِ",masdar:"إِحْصَاء",activePart:"مُحْصٍ",passivePart:"مُحْصًى"}},
     {wordType:"noun",english:"Sending / transmission",arabicBase:"إِرْسَال",forms:{singular:"إِرْسَال"}},
     {wordType:"noun",english:"Gospel",arabicBase:"إِنْجِيل",forms:{singular:"إِنْجِيل"}},
     {wordType:"noun",english:"People / nation",arabicBase:"قَوْم",forms:{singular:"قَوْم",plural:"أَقْوَام"}},
     {wordType:"noun",english:"Idea",arabicBase:"فِكْرَة",forms:{singular:"فِكْرَة",plural:"أَفْكَار"}},
     {wordType:"verb",english:"To captivate / fascinate",arabicBase:"اِسْتَهْوَى",forms:{past:"اِسْتَهْوَى",present:"يَسْتَهْوِي",imperative:"اِسْتَهْوِ",masdar:"اِسْتِهْوَاء",activePart:"مُسْتَهْوٍ"}},
     {wordType:"noun",english:"Distortion",arabicBase:"تَحْرِيف",forms:{singular:"تَحْرِيف"}},
     {wordType:"verb",english:"To worship devoutly",arabicBase:"تَعَبَّدَ",forms:{past:"تَعَبَّدَ",present:"يَتَعَبَّدُ",imperative:"تَعَبَّدْ",masdar:"تَعَبُّد",activePart:"مُتَعَبِّد"}},
     {wordType:"adjective",english:"Eternal / immortal",arabicBase:"خَالِد",forms:{singular:"خَالِد",feminine:"خَالِدَة"}},
     {wordType:"verb",english:"To make beloved / endear",arabicBase:"حَبَّبَ",forms:{past:"حَبَّبَ",present:"يُحَبِّبُ",imperative:"حَبِّبْ",masdar:"تَحْبِيب",activePart:"مُحَبِّب",passivePart:"مُحَبَّب"}},
     {wordType:"adjective",english:"Desiring / willing",arabicBase:"رَاغِب",forms:{singular:"رَاغِب",feminine:"رَاغِبَة"}},
     {wordType:"adjective",english:"Heavenly / divine",arabicBase:"سَمَاوِيّ",forms:{singular:"سَمَاوِيّ",feminine:"سَمَاوِيَّة"}},
     {wordType:"verb",english:"To emanate / be issued",arabicBase:"صَدَرَ",forms:{past:"صَدَرَ",present:"يَصْدُرُ",imperative:"اُصْدُرْ",masdar:"صُدُور",activePart:"صَادِر"}},
     {wordType:"verb",english:"To return",arabicBase:"عَادَ",forms:{past:"عَادَ",present:"يَعُودُ",imperative:"عُدْ",masdar:"عَوْدَة",activePart:"عَائِد"}},
     {wordType:"verb",english:"To surpass / excel",arabicBase:"فَاقَ",forms:{past:"فَاقَ",present:"يَفُوقُ",imperative:"فُقْ",masdar:"فَوْق",activePart:"فَائِق"}},
     {wordType:"noun",english:"Conquest / opening",arabicBase:"فَتْح",forms:{singular:"فَتْح",plural:"فُتُوحَات"}},
     {wordType:"noun",english:"Thought",arabicBase:"فِكْر",forms:{singular:"فِكْر"}},
     {wordType:"noun",english:"Summit / peak",arabicBase:"قِمَّة",forms:{singular:"قِمَّة",plural:"قِمَم"}},
     {wordType:"adjective",english:"All / entirety",arabicBase:"كَافَّة",forms:{singular:"كَافَّة"}},
     {wordType:"noun",english:"Tongue / language",arabicBase:"لِسَان",forms:{singular:"لِسَان",plural:"أَلْسِنَة"}},
     {wordType:"noun",english:"Depository / warehouse",arabicBase:"مُسْتَوْدَع",forms:{singular:"مُسْتَوْدَع"}},
     {wordType:"noun",english:"Demand / claim",arabicBase:"مُطَالَبَة",forms:{singular:"مُطَالَبَة"}},
     {wordType:"noun",english:"Rank / status",arabicBase:"مَنْزِلَة",forms:{singular:"مَنْزِلَة",plural:"مَنَازِل"}},
     {wordType:"verb",english:"To excel / become distinguished",arabicBase:"نَبَغَ",forms:{past:"نَبَغَ",present:"يَنْبُغُ",imperative:"اُنْبُغْ",masdar:"نُبُوغ",activePart:"نَابِغَة"}},
     {wordType:"noun",english:"Origin / upbringing",arabicBase:"نَشْأَة",forms:{singular:"نَشْأَة"}},
     {wordType:"verb",english:"To send down / reveal",arabicBase:"نَزَّلَ",forms:{past:"نَزَّلَ",present:"يُنَزِّلُ",imperative:"نَزِّلْ",masdar:"تَنْزِيل",activePart:"مُنَزِّل",passivePart:"مُنَزَّل"}},
   ]},
  {id:"preset-byy4-u8", title:"Bayna Yadayk Book 4 · Unit 8 — King Faisal Prize Scholars", unitId:"4-8", level:"book4", seriesId:BYY4P1_SERIES,
   cards:[
     {wordType:"noun",english:"Ruling / judgment",arabicBase:"حُكْم",forms:{singular:"حُكْم",plural:"أَحْكَام"}},
     {wordType:"noun",english:"Administration",arabicBase:"إِدَارَة",forms:{singular:"إِدَارَة"}},
     {wordType:"noun",english:"Guidance",arabicBase:"إِرْشَاد",forms:{singular:"إِرْشَاد"}},
     {wordType:"verb",english:"To participate",arabicBase:"اِشْتَرَكَ",forms:{past:"اِشْتَرَكَ",present:"يَشْتَرِكُ",imperative:"اِشْتَرِكْ",masdar:"اِشْتِرَاك",activePart:"مُشْتَرِك",harf:"فِي"}},
     {wordType:"noun",english:"Reform",arabicBase:"إِصْلَاح",forms:{singular:"إِصْلَاح"}},
     {wordType:"verb",english:"To issue / publish",arabicBase:"أَصْدَرَ",forms:{past:"أَصْدَرَ",present:"يُصْدِرُ",imperative:"أَصْدِرْ",masdar:"إِصْدَار",activePart:"مُصْدِر",passivePart:"مُصْدَر"}},
     {wordType:"noun",english:"Issuing religious rulings",arabicBase:"إِفْتَاء",forms:{singular:"إِفْتَاء"}},
     {wordType:"adjective",english:"Regional",arabicBase:"إِقْلِيمِيّ",forms:{singular:"إِقْلِيمِيّ",feminine:"إِقْلِيمِيَّة"}},
     {wordType:"noun",english:"Revival / recovery",arabicBase:"اِنْتِعَاش",forms:{singular:"اِنْتِعَاش"}},
     {wordType:"noun",english:"Research",arabicBase:"بَحْث",forms:{singular:"بَحْث",plural:"بُحُوث"}},
     {wordType:"noun",english:"Innovation (religious)",arabicBase:"بِدْعَة",forms:{singular:"بِدْعَة",plural:"بِدَع"}},
     {wordType:"noun",english:"Program",arabicBase:"بَرْنَامَج",forms:{singular:"بَرْنَامَج",plural:"بَرَامِج"}},
     {wordType:"adjective",english:"Eloquent",arabicBase:"بَلِيغ",forms:{singular:"بَلِيغ",feminine:"بَلِيغَة"}},
     {wordType:"noun",english:"Attainment / puberty",arabicBase:"بُلُوغ",forms:{singular:"بُلُوغ"}},
     {wordType:"adjective",english:"Foundational",arabicBase:"تَأْسِيسِيّ",forms:{singular:"تَأْسِيسِيّ",feminine:"تَأْسِيسِيَّة"}},
     {wordType:"noun",english:"Donation",arabicBase:"تَبَرُّع",forms:{singular:"تَبَرُّع",plural:"تَبَرُّعَات"}},
     {wordType:"verb",english:"To be related to / attached",arabicBase:"تَعَلَّقَ",forms:{past:"تَعَلَّقَ",present:"يَتَعَلَّقُ",imperative:"تَعَلَّقْ",masdar:"تَعَلُّق",activePart:"مُتَعَلِّق",harf:"بِـ"}},
     {wordType:"noun",english:"Warning",arabicBase:"تَحْذِير",forms:{singular:"تَحْذِير"}},
     {wordType:"verb",english:"To progress gradually",arabicBase:"تَدَرَّجَ",forms:{past:"تَدَرَّجَ",present:"يَتَدَرَّجُ",imperative:"تَدَرَّجْ",masdar:"تَدَرُّج",activePart:"مُتَدَرِّج"}},
     {wordType:"noun",english:"Definition",arabicBase:"تَعْرِيف",forms:{singular:"تَعْرِيف",plural:"تَعْرِيفَات"}},
     {wordType:"verb",english:"To receive",arabicBase:"تَلَقَّى",forms:{past:"تَلَقَّى",present:"يَتَلَقَّى",imperative:"تَلَقَّ",masdar:"تَلَقٍّ",activePart:"مُتَلَقٍّ"}},
     {wordType:"verb",english:"To be permissible",arabicBase:"جَازَ",forms:{past:"جَازَ",present:"يَجُوزُ",imperative:"جُزْ",masdar:"جَوَاز",activePart:"جَائِز"}},
     {wordType:"noun",english:"Superstition / myth",arabicBase:"خُرَافَة",forms:{singular:"خُرَافَة",plural:"خُرَافَات"}},
     {wordType:"noun",english:"Opponent",arabicBase:"خَصْم",forms:{singular:"خَصْم",plural:"خُصُوم"}},
     {wordType:"noun",english:"Thought / reflection",arabicBase:"خَاطِرَة",forms:{singular:"خَاطِرَة",plural:"خَوَاطِر"}},
     {wordType:"noun",english:"Memory",arabicBase:"ذِكْرَى",forms:{singular:"ذِكْرَى",plural:"ذِكْرَيَات"}},
     {wordType:"adjective",english:"Solid / tough",arabicBase:"صُلْب",forms:{singular:"صُلْب",feminine:"صُلْبَة"}},
     {wordType:"noun",english:"Religious ruling",arabicBase:"فَتْوَى",forms:{singular:"فَتْوَى",plural:"فَتَاوَى"}},
     {wordType:"noun",english:"Jurist / scholar of fiqh",arabicBase:"فَقِيه",forms:{singular:"فَقِيه",plural:"فُقَهَاء"}},
     {wordType:"noun",english:"Nationalism",arabicBase:"قَوْمِيَّة",forms:{singular:"قَوْمِيَّة"}},
     {wordType:"noun",english:"Writer",arabicBase:"كَاتِب",forms:{singular:"كَاتِب",plural:"كُتَّاب"}},
     {wordType:"adjective",english:"Great / senior",arabicBase:"كَبِير",forms:{singular:"كَبِير",feminine:"كَبِيرَة",plural:"كِبَار"}},
     {wordType:"noun",english:"Written work",arabicBase:"مُؤَلَّف",forms:{singular:"مُؤَلَّف",plural:"مُؤَلَّفَات"}},
     {wordType:"adjective",english:"Specialized",arabicBase:"مُتَخَصِّص",forms:{singular:"مُتَخَصِّص",feminine:"مُتَخَصِّصَة"}},
     {wordType:"noun",english:"Lecture",arabicBase:"مُحَاضَرَة",forms:{singular:"مُحَاضَرَة",plural:"مُحَاضَرَات"}},
     {wordType:"noun",english:"Claim / allegation",arabicBase:"زَعْم",forms:{singular:"زَعْم",plural:"مَزَاعِم"}},
     {wordType:"noun",english:"Institute",arabicBase:"مَعْهَد",forms:{singular:"مَعْهَد",plural:"مَعَاهِد"}},
     {wordType:"noun",english:"Mufti (religious jurist)",arabicBase:"مُفْتٍ",forms:{singular:"مُفْتٍ",plural:"مُفْتُون"}},
     {wordType:"noun",english:"King",arabicBase:"مَلِك",forms:{singular:"مَلِك",plural:"مُلُوك"}},
     {wordType:"noun",english:"Debate",arabicBase:"مُنَاظَرَة",forms:{singular:"مُنَاظَرَة",plural:"مُنَاظَرَات"}},
     {wordType:"noun",english:"Publication / leaflet",arabicBase:"مَنْشُور",forms:{singular:"مَنْشُور",plural:"مَنْشُورَات"}},
     {wordType:"noun",english:"Criticism",arabicBase:"نَقْد",forms:{singular:"نَقْد"}},
     {wordType:"noun",english:"Guidance (2)",arabicBase:"هِدَايَة",forms:{singular:"هِدَايَة"}},
   ]},
  {id:"preset-byy4-u9", title:"Bayna Yadayk Book 4 · Unit 9 — Globalization", unitId:"4-9", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Effect / trace",arabicBase:"أَثَر",forms:{singular:"أَثَر",plural:"آثَار"}},
     {wordType:"noun",english:"Religion",arabicBase:"دِين",forms:{singular:"دِين",plural:"أَدْيَان"}},
     {wordType:"noun",english:"Party / side",arabicBase:"طَرَف",forms:{singular:"طَرَف",plural:"أَطْرَاف"}},
     {wordType:"noun",english:"Achievement",arabicBase:"إِنْجَاز",forms:{singular:"إِنْجَاز",plural:"إِنْجَازَات"}},
     {wordType:"noun",english:"Pattern / style",arabicBase:"نَمَط",forms:{singular:"نَمَط",plural:"أَنْمَاط"}},
     {wordType:"noun",english:"Technology",arabicBase:"تِقَانَة",forms:{singular:"تِقَانَة",plural:"تِقَانَات"}},
     {wordType:"noun",english:"Progress",arabicBase:"تَقَدُّم",forms:{singular:"تَقَدُّم"}},
     {wordType:"noun",english:"Competition",arabicBase:"تَنَافُس",forms:{singular:"تَنَافُس"}},
     {wordType:"noun",english:"Account / calculation",arabicBase:"حِسَاب",forms:{singular:"حِسَاب",plural:"حِسَابَات"}},
     {wordType:"noun",english:"Commodity",arabicBase:"سِلْعَة",forms:{singular:"سِلْعَة",plural:"سِلَع"}},
     {wordType:"noun",english:"Conflict / struggle",arabicBase:"صِرَاع",forms:{singular:"صِرَاع",plural:"صِرَاعَات"}},
     {wordType:"noun",english:"Relation",arabicBase:"عَلَاقَة",forms:{singular:"عَلَاقَة",plural:"عَلَاقَات"}},
     {wordType:"noun",english:"Labor force",arabicBase:"عَمَالَة",forms:{singular:"عَمَالَة"}},
     {wordType:"noun",english:"Invasion",arabicBase:"غَزْو",forms:{singular:"غَزْو"}},
     {wordType:"noun",english:"Hatred",arabicBase:"كَرَاهِيَّة",forms:{singular:"كَرَاهِيَّة"}},
     {wordType:"noun",english:"Center",arabicBase:"مَرْكَز",forms:{singular:"مَرْكَز",plural:"مَرَاكِز"}},
     {wordType:"noun",english:"Consumer",arabicBase:"مُسْتَهْلِك",forms:{singular:"مُسْتَهْلِك",plural:"مُسْتَهْلِكُون"}},
     {wordType:"noun",english:"Suffering",arabicBase:"مُعَانَاة",forms:{singular:"مُعَانَاة"}},
     {wordType:"noun",english:"Belief",arabicBase:"مُعْتَقَد",forms:{singular:"مُعْتَقَد",plural:"مُعْتَقَدَات"}},
     {wordType:"noun",english:"Position / stance",arabicBase:"مَوْقِف",forms:{singular:"مَوْقِف",plural:"مَوَاقِف"}},
     {wordType:"noun",english:"Renaissance / awakening",arabicBase:"نَهْضَة",forms:{singular:"نَهْضَة",plural:"نَهَضَات"}},
     {wordType:"noun",english:"Civilization / civility",arabicBase:"مَدَنِيَّة",forms:{singular:"مَدَنِيَّة"}},
     {wordType:"adjective",english:"Economic",arabicBase:"اِقْتِصَادِيّ",forms:{singular:"اِقْتِصَادِيّ",feminine:"اِقْتِصَادِيَّة"}},
     {wordType:"adjective",english:"Capitalist",arabicBase:"رَأْسِمَالِيّ",forms:{singular:"رَأْسِمَالِيّ",feminine:"رَأْسِمَالِيَّة"}},
     {wordType:"adjective",english:"Prevailing / dominant",arabicBase:"سَائِد",forms:{singular:"سَائِد",feminine:"سَائِدَة"}},
     {wordType:"adjective",english:"Political",arabicBase:"سِيَاسِيّ",forms:{singular:"سِيَاسِيّ",feminine:"سِيَاسِيَّة"}},
     {wordType:"adjective",english:"Western",arabicBase:"غَرْبِيّ",forms:{singular:"غَرْبِيّ",feminine:"غَرْبِيَّة"}},
     {wordType:"adjective",english:"Advanced",arabicBase:"مُتَقَدِّم",forms:{singular:"مُتَقَدِّم",feminine:"مُتَقَدِّمَة"}},
     {wordType:"adjective",english:"Ready / prepared",arabicBase:"مُسْتَعِدّ",forms:{singular:"مُسْتَعِدّ",feminine:"مُسْتَعِدَّة"}},
     {wordType:"verb",english:"To believe",arabicBase:"آمَنَ",forms:{past:"آمَنَ",present:"يُؤْمِنُ",imperative:"آمِنْ",masdar:"إِيمَان",activePart:"مُؤْمِن",harf:"بِـ"}},
     {wordType:"verb",english:"To include / contain",arabicBase:"تَضَمَّنَ",forms:{past:"تَضَمَّنَ",present:"يَتَضَمَّنُ",imperative:"تَضَمَّنْ",masdar:"تَضَمُّن",activePart:"مُتَضَمِّن"}},
     {wordType:"verb",english:"To carry",arabicBase:"حَمَلَ",forms:{past:"حَمَلَ",present:"يَحْمِلُ",imperative:"اِحْمِلْ",masdar:"حَمْل",activePart:"حَامِل",passivePart:"مَحْمُول"}},
     {wordType:"verb",english:"To proceed / walk",arabicBase:"سَارَ",forms:{past:"سَارَ",present:"يَسِيرُ",imperative:"سِرْ",masdar:"سَيْر",activePart:"سَائِر"}},
     {wordType:"verb",english:"To be hostile to",arabicBase:"عَادَى",forms:{past:"عَادَى",present:"يُعَادِي",imperative:"عَادِ",masdar:"مُعَادَاة",activePart:"مُعَادٍ"}},
     {wordType:"verb",english:"To invade",arabicBase:"غَزَا",forms:{past:"غَزَا",present:"يَغْزُو",imperative:"اُغْزُ",masdar:"غَزْو",activePart:"غَازٍ",passivePart:"مَغْزُوّ"}},
     {wordType:"verb",english:"To represent",arabicBase:"مَثَّلَ",forms:{past:"مَثَّلَ",present:"يُمَثِّلُ",imperative:"مَثِّلْ",masdar:"تَمْثِيل",activePart:"مُمَثِّل",passivePart:"مُمَثَّل"}},
   ]},
  {id:"preset-byy4-u10", title:"Bayna Yadayk Book 4 · Unit 10 — Cleanliness", unitId:"4-10", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Harm",arabicBase:"أَذَى",forms:{singular:"أَذَى"}},
     {wordType:"noun",english:"Removal",arabicBase:"إِزَالَة",forms:{singular:"إِزَالَة"}},
     {wordType:"noun",english:"Nail (finger/toe)",arabicBase:"ظُفْر",forms:{singular:"ظُفْر",plural:"أَظَافِر"}},
     {wordType:"noun",english:"Commitment",arabicBase:"اِلْتِزَام",forms:{singular:"اِلْتِزَام"}},
     {wordType:"noun",english:"Trimming",arabicBase:"تَقْلِيم",forms:{singular:"تَقْلِيم"}},
     {wordType:"noun",english:"Modesty / shyness",arabicBase:"حَيَاء",forms:{singular:"حَيَاء"}},
     {wordType:"noun",english:"Circumcision",arabicBase:"خِتَان",forms:{singular:"خِتَان"}},
     {wordType:"noun",english:"Taste",arabicBase:"ذَوْق",forms:{singular:"ذَوْق",plural:"أَذْوَاق"}},
     {wordType:"noun",english:"Smell",arabicBase:"رَائِحَة",forms:{singular:"رَائِحَة",plural:"رَوَائِح"}},
     {wordType:"noun",english:"Excess part",arabicBase:"زَائِدَة",forms:{singular:"زَائِدَة",plural:"زَوَائِد"}},
     {wordType:"noun",english:"Practice / sunnah",arabicBase:"سُنَّة",forms:{singular:"سُنَّة",plural:"سُنَن"}},
     {wordType:"noun",english:"Tooth-stick (miswak)",arabicBase:"سِوَاك",forms:{singular:"سِوَاك"}},
     {wordType:"noun",english:"Mustache",arabicBase:"شَارِب",forms:{singular:"شَارِب",plural:"شَوَارِب"}},
     {wordType:"noun",english:"Branch / division",arabicBase:"شُعْبَة",forms:{singular:"شُعْبَة",plural:"شُعَب"}},
     {wordType:"noun",english:"Waste / excess",arabicBase:"فَضَلَات",forms:{singular:"فَضَلَات"}},
     {wordType:"noun",english:"Garbage",arabicBase:"قُمَامَة",forms:{singular:"قُمَامَة"}},
     {wordType:"noun",english:"Facility",arabicBase:"مَرْفِق",forms:{singular:"مَرْفِق",plural:"مَرَافِق"}},
     {wordType:"noun",english:"Touch",arabicBase:"مَسّ",forms:{singular:"مَسّ"}},
     {wordType:"noun",english:"Paste / toothpaste",arabicBase:"مِعْجُون",forms:{singular:"مِعْجُون",plural:"مَعَاجِين"}},
     {wordType:"noun",english:"Plucking",arabicBase:"نَتْف",forms:{singular:"نَتْف"}},
     {wordType:"noun",english:"Protection",arabicBase:"وِقَايَة",forms:{singular:"وِقَايَة"}},
     {wordType:"noun",english:"Ritual impurity",arabicBase:"جَنَابَة",forms:{singular:"جَنَابَة"}},
     {wordType:"noun",english:"Ritually impure (state)",arabicBase:"جُنُب",forms:{singular:"جُنُب"}},
     {wordType:"adjective",english:"Repugnant / disgusting",arabicBase:"كَرِيه",forms:{singular:"كَرِيه",feminine:"كَرِيهَة"}},
     {wordType:"adjective",english:"Dirty",arabicBase:"وَسِخ",forms:{singular:"وَسِخ",feminine:"وَسِخَة"}},
     {wordType:"adjective",english:"Purified",arabicBase:"مُطَهَّر",forms:{singular:"مُطَهَّر",feminine:"مُطَهَّرَة"}},
     {wordType:"verb",english:"To purify oneself",arabicBase:"اطَّهَّرَ",forms:{past:"اطَّهَّرَ",present:"يَطَّهَّرُ",imperative:"اِطَّهَّرْ",masdar:"تَطَهُّر",activePart:"مُطَّهِّر"}},
     {wordType:"verb",english:"To get rid of",arabicBase:"تَخَلَّصَ",forms:{past:"تَخَلَّصَ",present:"يَتَخَلَّصُ",imperative:"تَخَلَّصْ",masdar:"تَخَلُّص",activePart:"مُتَخَلِّص",harf:"مِنْ"}},
     {wordType:"verb",english:"To disperse",arabicBase:"تَفَرَّقَ",forms:{past:"تَفَرَّقَ",present:"يَتَفَرَّقُ",imperative:"تَفَرَّقْ",masdar:"تَفَرُّق",activePart:"مُتَفَرِّق"}},
     {wordType:"verb",english:"To cut / trim",arabicBase:"قَصَّ",forms:{past:"قَصَّ",present:"يَقُصُّ",imperative:"قُصَّ",masdar:"قَصّ",activePart:"قَاصّ",passivePart:"مَقْصُوص"}},
     {wordType:"verb",english:"To touch",arabicBase:"مَسَّ",forms:{past:"مَسَّ",present:"يَمَسُّ",imperative:"مَسَّ",masdar:"مَسّ",activePart:"مَاسّ",passivePart:"مَمْسُوس"}},
   ]},
  {id:"preset-byy4-u11", title:"Bayna Yadayk Book 4 · Unit 11 — The Seeker Of Truth", unitId:"4-11", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Origin / root",arabicBase:"أَصْل",forms:{singular:"أَصْل",plural:"أُصُول"}},
     {wordType:"noun",english:"Funeral",arabicBase:"جَنَازَة",forms:{singular:"جَنَازَة",plural:"جَنَائِز"}},
     {wordType:"noun",english:"Seal / ring",arabicBase:"خَاتَم",forms:{singular:"خَاتَم",plural:"خَوَاتِم"}},
     {wordType:"noun",english:"Garment / cloak",arabicBase:"رِدَاء",forms:{singular:"رِدَاء",plural:"أَرْدِيَة"}},
     {wordType:"noun",english:"Master / lord",arabicBase:"سَيِّد",forms:{singular:"سَيِّد",plural:"سَادَة"}},
     {wordType:"noun",english:"Charity",arabicBase:"صَدَقَة",forms:{singular:"صَدَقَة",plural:"صَدَقَات"}},
     {wordType:"noun",english:"Estrangement / foreignness",arabicBase:"غُرْبَة",forms:{singular:"غُرْبَة"}},
     {wordType:"noun",english:"Village",arabicBase:"قَرْيَة",forms:{singular:"قَرْيَة",plural:"قُرَى"}},
     {wordType:"noun",english:"Soothsayer / priest",arabicBase:"كَاهِن",forms:{singular:"كَاهِن",plural:"كَهَنَة"}},
     {wordType:"noun",english:"Church",arabicBase:"كَنِيسَة",forms:{singular:"كَنِيسَة",plural:"كَنَائِس"}},
     {wordType:"noun",english:"Landmark",arabicBase:"مَعْلَم",forms:{singular:"مَعْلَم",plural:"مَعَالِم"}},
     {wordType:"noun",english:"Fire",arabicBase:"نَار",forms:{singular:"نَار",plural:"نِيرَان"}},
     {wordType:"noun",english:"Palm tree",arabicBase:"نَخْلَة",forms:{singular:"نَخْلَة",plural:"نَخْل"}},
     {wordType:"noun",english:"Prophethood",arabicBase:"نُبُوَّة",forms:{singular:"نُبُوَّة"}},
     {wordType:"noun",english:"Bishop",arabicBase:"أُسْقُف",forms:{singular:"أُسْقُف",plural:"أَسَاقِفَة"}},
     {wordType:"noun",english:"Town",arabicBase:"بَلْدَة",forms:{singular:"بَلْدَة",plural:"بِلَاد"}},
     {wordType:"adjective",english:"Upright / true (in religion)",arabicBase:"حَنِيف",forms:{singular:"حَنِيف"}},
     {wordType:"adjective",english:"Zoroastrian",arabicBase:"مَجُوسِيّ",forms:{singular:"مَجُوسِيّ",feminine:"مَجُوسِيَّة"}},
     {wordType:"adjective",english:"Resident / dwelling",arabicBase:"قَاطِن",forms:{singular:"قَاطِن",feminine:"قَاطِنَة"}},
     {wordType:"adjective",english:"Higher / highest",arabicBase:"أَعْلَى",forms:{singular:"أَعْلَى"}},
     {wordType:"verb",english:"To establish",arabicBase:"أَقَامَ",forms:{past:"أَقَامَ",present:"يُقِيمُ",imperative:"أَقِمْ",masdar:"إِقَامَة",activePart:"مُقِيم",passivePart:"مُقَام"}},
     {wordType:"verb",english:"To become (in the evening)",arabicBase:"أَمْسَى",forms:{past:"أَمْسَى",present:"يُمْسِي",imperative:"أَمْسِ",masdar:"إِمْسَاء",activePart:"مُمْسٍ"}},
     {wordType:"verb",english:"To kindle / light",arabicBase:"أَوْقَدَ",forms:{past:"أَوْقَدَ",present:"يُوقِدُ",imperative:"أَوْقِدْ",masdar:"إِيقَاد",activePart:"مُوقِد",passivePart:"مُوقَد"}},
     {wordType:"verb",english:"To be certain",arabicBase:"أَيْقَنَ",forms:{past:"أَيْقَنَ",present:"يُوقِنُ",imperative:"أَيْقِنْ",masdar:"إِيقَان",activePart:"مُوقِن"}},
     {wordType:"verb",english:"To spread out",arabicBase:"بَسَطَ",forms:{past:"بَسَطَ",present:"يَبْسُطُ",imperative:"اُبْسُطْ",masdar:"بَسْط",activePart:"بَاسِط",passivePart:"مَبْسُوط"}},
     {wordType:"verb",english:"To speak",arabicBase:"تَحَدَّثَ",forms:{past:"تَحَدَّثَ",present:"يَتَحَدَّثُ",imperative:"تَحَدَّثْ",masdar:"تَحَدُّث",activePart:"مُتَحَدِّث",harf:"عَنْ"}},
     {wordType:"verb",english:"To address",arabicBase:"خَاطَبَ",forms:{past:"خَاطَبَ",present:"يُخَاطِبُ",imperative:"خَاطِبْ",masdar:"مُخَاطَبَة",activePart:"مُخَاطِب",passivePart:"مُخَاطَب"}},
     {wordType:"verb",english:"To depart",arabicBase:"رَحَلَ",forms:{past:"رَحَلَ",present:"يَرْحَلُ",imperative:"اِرْحَلْ",masdar:"رَحِيل",activePart:"رَاحِل"}},
     {wordType:"verb",english:"To appear",arabicBase:"ظَهَرَ",forms:{past:"ظَهَرَ",present:"يَظْهَرُ",imperative:"اِظْهَرْ",masdar:"ظُهُور",activePart:"ظَاهِر"}},
     {wordType:"verb",english:"To fight",arabicBase:"قَاتَلَ",forms:{past:"قَاتَلَ",present:"يُقَاتِلُ",imperative:"قَاتِلْ",masdar:"قِتَال",activePart:"مُقَاتِل",passivePart:"مُقَاتَل"}},
     {wordType:"verb",english:"To accept",arabicBase:"قَبِلَ",forms:{past:"قَبِلَ",present:"يَقْبَلُ",imperative:"اِقْبَلْ",masdar:"قَبُول",activePart:"قَابِل",passivePart:"مَقْبُول"}},
     {wordType:"verb",english:"To vow",arabicBase:"نَذَرَ",forms:{past:"نَذَرَ",present:"يَنْذُرُ",imperative:"اُنْذُرْ",masdar:"نَذْر",activePart:"نَاذِر",passivePart:"مَنْذُور"}},
     {wordType:"verb",english:"To describe",arabicBase:"وَصَفَ",forms:{past:"وَصَفَ",present:"يَصِفُ",imperative:"صِفْ",masdar:"وَصْف",activePart:"وَاصِف",passivePart:"مَوْصُوف"}},
   ]},
  {id:"preset-byy4-u12", title:"Bayna Yadayk Book 4 · Unit 12 — Types Of Friends", unitId:"4-12", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"The afterlife",arabicBase:"آخِرَة",forms:{singular:"آخِرَة"}},
     {wordType:"noun",english:"Excitement",arabicBase:"إِثَارَة",forms:{singular:"إِثَارَة"}},
     {wordType:"noun",english:"Adornment / jewelry",arabicBase:"حِلْيَة",forms:{singular:"حِلْيَة",plural:"حُلًى"}},
     {wordType:"noun",english:"Summary",arabicBase:"خُلَاصَة",forms:{singular:"خُلَاصَة"}},
     {wordType:"noun",english:"Wine",arabicBase:"خَمْر",forms:{singular:"خَمْر",plural:"خُمُور"}},
     {wordType:"noun",english:"Adornment",arabicBase:"زِينَة",forms:{singular:"زِينَة"}},
     {wordType:"noun",english:"Demeanor",arabicBase:"سَمْت",forms:{singular:"سَمْت"}},
     {wordType:"noun",english:"Network",arabicBase:"شَبَكَة",forms:{singular:"شَبَكَة",plural:"شِبَاك"}},
     {wordType:"noun",english:"Honor",arabicBase:"شَرَف",forms:{singular:"شَرَف"}},
     {wordType:"noun",english:"Partner",arabicBase:"شَرِيك",forms:{singular:"شَرِيك",plural:"شُرَكَاء"}},
     {wordType:"noun",english:"Friendship",arabicBase:"صَدَاقَة",forms:{singular:"صَدَاقَة"}},
     {wordType:"noun",english:"Class / layer",arabicBase:"طَبَقَة",forms:{singular:"طَبَقَة",plural:"طَبَقَات"}},
     {wordType:"noun",english:"Method",arabicBase:"طَرِيقَة",forms:{singular:"طَرِيقَة",plural:"طَرَائِق"}},
     {wordType:"noun",english:"Companionship",arabicBase:"عِشْرَة",forms:{singular:"عِشْرَة"}},
     {wordType:"noun",english:"Standard / scale",arabicBase:"مِقْيَاس",forms:{singular:"مِقْيَاس",plural:"مَقَايِيس"}},
     {wordType:"noun",english:"Balance / scale",arabicBase:"مِيزَان",forms:{singular:"مِيزَان",plural:"مَوَازِين"}},
     {wordType:"noun",english:"Position / post",arabicBase:"مَنْصِب",forms:{singular:"مَنْصِب",plural:"مَنَاصِب"}},
     {wordType:"noun",english:"Benefit",arabicBase:"نَفْع",forms:{singular:"نَفْع"}},
     {wordType:"adjective",english:"Foolish",arabicBase:"أَحْمَق",forms:{singular:"أَحْمَق",feminine:"حَمْقَاء"}},
     {wordType:"adjective",english:"Trustworthy",arabicBase:"أَمِين",forms:{singular:"أَمِين",feminine:"أَمِينَة"}},
     {wordType:"adjective",english:"Truthful",arabicBase:"صَادِق",forms:{singular:"صَادِق",feminine:"صَادِقَة"}},
     {wordType:"adjective",english:"Amusing",arabicBase:"طَرِيف",forms:{singular:"طَرِيف",feminine:"طَرِيفَة"}},
     {wordType:"adjective",english:"Natural",arabicBase:"طَبِيعِيّ",forms:{singular:"طَبِيعِيّ",feminine:"طَبِيعِيَّة"}},
     {wordType:"adjective",english:"Obscene",arabicBase:"فَاحِش",forms:{singular:"فَاحِش",feminine:"فَاحِشَة"}},
     {wordType:"adjective",english:"Sociable",arabicBase:"مُؤْنِس",forms:{singular:"مُؤْنِس",feminine:"مُؤْنِسَة"}},
     {wordType:"adjective",english:"Annoying",arabicBase:"مُزْعِج",forms:{singular:"مُزْعِج",feminine:"مُزْعِجَة"}},
     {wordType:"adjective",english:"Compelled",arabicBase:"مُضْطَرّ",forms:{singular:"مُضْطَرّ",feminine:"مُضْطَرَّة"}},
     {wordType:"adjective",english:"Helpful",arabicBase:"مُعِين",forms:{singular:"مُعِين",feminine:"مُعِينَة"}},
     {wordType:"verb",english:"To disturb / annoy",arabicBase:"أَزْعَجَ",forms:{past:"أَزْعَجَ",present:"يُزْعِجُ",imperative:"أَزْعِجْ",masdar:"إِزْعَاج",activePart:"مُزْعِج",passivePart:"مُزْعَج"}},
     {wordType:"verb",english:"To make happy",arabicBase:"أَسْعَدَ",forms:{past:"أَسْعَدَ",present:"يُسْعِدُ",imperative:"أَسْعِدْ",masdar:"إِسْعَاد",activePart:"مُسْعِد",passivePart:"مُسْعَد"}},
     {wordType:"verb",english:"To be limited to",arabicBase:"اقْتَصَرَ",forms:{past:"اقْتَصَرَ",present:"يَقْتَصِرُ",imperative:"اِقْتَصِرْ",masdar:"اِقْتِصَار",activePart:"مُقْتَصِر",harf:"عَلَى"}},
     {wordType:"verb",english:"To betray",arabicBase:"خَانَ",forms:{past:"خَانَ",present:"يَخُونُ",imperative:"خُنْ",masdar:"خِيَانَة",activePart:"خَائِن",passivePart:"مَخُون"}},
     {wordType:"verb",english:"To be bad / evil",arabicBase:"سَاءَ",forms:{past:"سَاءَ",present:"يَسُوءُ",imperative:"سُؤْ",masdar:"سُوء",activePart:"سَيِّئ"}},
     {wordType:"verb",english:"To please",arabicBase:"سَرَّ",forms:{past:"سَرَّ",present:"يَسُرُّ",imperative:"سُرَّ",masdar:"سُرُور",activePart:"سَارّ",passivePart:"مَسْرُور"}},
     {wordType:"verb",english:"To entertain",arabicBase:"سَلَّى",forms:{past:"سَلَّى",present:"يُسَلِّي",imperative:"سَلِّ",masdar:"تَسْلِيَة",activePart:"مُسَلٍّ",passivePart:"مُسَلًّى"}},
     {wordType:"verb",english:"To classify",arabicBase:"صَنَّفَ",forms:{past:"صَنَّفَ",present:"يُصَنِّفُ",imperative:"صَنِّفْ",masdar:"تَصْنِيف",activePart:"مُصَنِّف",passivePart:"مُصَنَّف"}},
     {wordType:"verb",english:"To make a covenant with",arabicBase:"عَاهَدَ",forms:{past:"عَاهَدَ",present:"يُعَاهِدُ",imperative:"عَاهِدْ",masdar:"مُعَاهَدَة",activePart:"مُعَاهِد",passivePart:"مُعَاهَد"}},
     {wordType:"verb",english:"To cheat",arabicBase:"غَشَّ",forms:{past:"غَشَّ",present:"يَغُشُّ",imperative:"غُشَّ",masdar:"غِشّ",activePart:"غَاشّ",passivePart:"مَغْشُوش"}},
   ]},
  {id:"preset-byy4-u13", title:"Bayna Yadayk Book 4 · Unit 13 — The Legacy Of Islamic Culture", unitId:"4-13", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Invention",arabicBase:"اِخْتِرَاع",forms:{singular:"اِخْتِرَاع",plural:"اِخْتِرَاعَات"}},
     {wordType:"noun",english:"Prosperity",arabicBase:"اِزْدِهَار",forms:{singular:"اِزْدِهَار"}},
     {wordType:"noun",english:"Contribution",arabicBase:"إِسْهَام",forms:{singular:"إِسْهَام",plural:"إِسْهَامَات"}},
     {wordType:"noun",english:"Announcement / advertisement",arabicBase:"إِعْلَان",forms:{singular:"إِعْلَان",plural:"إِعْلَانَات"}},
     {wordType:"noun",english:"Origin / root",arabicBase:"أَصْل",forms:{singular:"أَصْل",plural:"أُصُول"}},
     {wordType:"noun",english:"Development / construction",arabicBase:"إِعْمَار",forms:{singular:"إِعْمَار"}},
     {wordType:"noun",english:"Views / glances",arabicBase:"نَظَر",forms:{singular:"نَظَر",plural:"أَنْظَار"}},
     {wordType:"noun",english:"Emergence",arabicBase:"بُرُوز",forms:{singular:"بُرُوز"}},
     {wordType:"noun",english:"Algebra",arabicBase:"جَبْر",forms:{singular:"جَبْر"}},
     {wordType:"noun",english:"Caliphate",arabicBase:"خِلَافَة",forms:{singular:"خِلَافَة"}},
     {wordType:"noun",english:"Zero",arabicBase:"صِفْر",forms:{singular:"صِفْر",plural:"أَصْفَار"}},
     {wordType:"noun",english:"Light",arabicBase:"ضَوْء",forms:{singular:"ضَوْء",plural:"أَضْوَاء"}},
     {wordType:"noun",english:"Care",arabicBase:"عِنَايَة",forms:{singular:"عِنَايَة"}},
     {wordType:"noun",english:"Cotton",arabicBase:"قُطْن",forms:{singular:"قُطْن"}},
     {wordType:"noun",english:"Linen",arabicBase:"كَتَّان",forms:{singular:"كَتَّان"}},
     {wordType:"noun",english:"Discovery",arabicBase:"كَشْف",forms:{singular:"كَشْف",plural:"كُشُوف"}},
     {wordType:"noun",english:"Universe / being",arabicBase:"كَوْن",forms:{singular:"كَوْن"}},
     {wordType:"noun",english:"Chemistry",arabicBase:"كِيمْيَاء",forms:{singular:"كِيمْيَاء"}},
     {wordType:"noun",english:"Terminology",arabicBase:"مُصْطَلَح",forms:{singular:"مُصْطَلَح",plural:"مُصْطَلَحَات"}},
     {wordType:"noun",english:"Source / spring",arabicBase:"مَنْبَع",forms:{singular:"مَنْبَع",plural:"مَنَابِع"}},
     {wordType:"noun",english:"Glance",arabicBase:"نَظْرَة",forms:{singular:"نَظْرَة",plural:"نَظَرَات"}},
     {wordType:"noun",english:"Paper",arabicBase:"وَرَق",forms:{singular:"وَرَق",plural:"أَوْرَاق"}},
     {wordType:"adjective",english:"Authentic",arabicBase:"أَصِيل",forms:{singular:"أَصِيل",feminine:"أَصِيلَة"}},
     {wordType:"adjective",english:"Experimental",arabicBase:"تَجْرِيبِيّ",forms:{singular:"تَجْرِيبِيّ",feminine:"تَجْرِيبِيَّة"}},
     {wordType:"adjective",english:"Scientific",arabicBase:"عِلْمِيّ",forms:{singular:"عِلْمِيّ",feminine:"عِلْمِيَّة"}},
     {wordType:"adjective",english:"Excellent / surpassing",arabicBase:"فَائِق",forms:{singular:"فَائِق",feminine:"فَائِقَة"}},
     {wordType:"adjective",english:"Deliberate / intentional",arabicBase:"مُتَعَمِّد",forms:{singular:"مُتَعَمِّد",feminine:"مُتَعَمِّدَة"}},
     {wordType:"adjective",english:"Settled / stable",arabicBase:"مُسْتَقِرّ",forms:{singular:"مُسْتَقِرّ",feminine:"مُسْتَقِرَّة"}},
     {wordType:"adjective",english:"Used",arabicBase:"مُسْتَعْمَل",forms:{singular:"مُسْتَعْمَل",feminine:"مُسْتَعْمَلَة"}},
     {wordType:"verb",english:"To despise",arabicBase:"اِحْتَقَرَ",forms:{past:"اِحْتَقَرَ",present:"يَحْتَقِرُ",imperative:"اِحْتَقِرْ",masdar:"اِحْتِقَار",activePart:"مُحْتَقِر",passivePart:"مُحْتَقَر"}},
     {wordType:"verb",english:"To contribute",arabicBase:"أَسْهَمَ",forms:{past:"أَسْهَمَ",present:"يُسْهِمُ",imperative:"أَسْهِمْ",masdar:"إِسْهَام",activePart:"مُسْهِم",harf:"فِي"}},
     {wordType:"verb",english:"To discover",arabicBase:"اكْتَشَفَ",forms:{past:"اكْتَشَفَ",present:"يَكْتَشِفُ",imperative:"اِكْتَشِفْ",masdar:"اِكْتِشَاف",activePart:"مُكْتَشِف",passivePart:"مُكْتَشَف"}},
     {wordType:"verb",english:"To get to know",arabicBase:"تَعَرَّفَ",forms:{past:"تَعَرَّفَ",present:"يَتَعَرَّفُ",imperative:"تَعَرَّفْ",masdar:"تَعَرُّف",activePart:"مُتَعَرِّف",harf:"عَلَى"}},
     {wordType:"verb",english:"To violate / pierce",arabicBase:"خَرَقَ",forms:{past:"خَرَقَ",present:"يَخْرِقُ",imperative:"اِخْرِقْ",masdar:"خَرْق",activePart:"خَارِق",passivePart:"مَخْرُوق"}},
     {wordType:"verb",english:"To aspire",arabicBase:"طَمَحَ",forms:{past:"طَمَحَ",present:"يَطْمَحُ",imperative:"اِطْمَحْ",masdar:"طُمُوح",activePart:"طَامِح",harf:"إِلَى"}},
     {wordType:"verb",english:"To draw attention",arabicBase:"لَفَتَ",forms:{past:"لَفَتَ",present:"يَلْفِتُ",imperative:"اِلْفِتْ",masdar:"لَفْت",activePart:"لَافِت",passivePart:"مَلْفُوت"}},
   ]},
  {id:"preset-byy4-u14", title:"Bayna Yadayk Book 4 · Unit 14 — The Concept Of Security", unitId:"4-14", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Piety / God-consciousness",arabicBase:"تَقْوَى",forms:{singular:"تَقْوَى"}},
     {wordType:"noun",english:"Caliph / successor",arabicBase:"خَلِيفَة",forms:{singular:"خَلِيفَة",plural:"خُلَفَاء"}},
     {wordType:"noun",english:"Motive",arabicBase:"دَافِع",forms:{singular:"دَافِع",plural:"دَوَافِع"}},
     {wordType:"noun",english:"Maintenance",arabicBase:"صِيَانَة",forms:{singular:"صِيَانَة"}},
     {wordType:"noun",english:"Tranquility",arabicBase:"طُمَأْنِينَة",forms:{singular:"طُمَأْنِينَة"}},
     {wordType:"noun",english:"Individual",arabicBase:"فَرْد",forms:{singular:"فَرْد",plural:"أَفْرَاد"}},
     {wordType:"noun",english:"Immorality",arabicBase:"فُجُور",forms:{singular:"فُجُور"}},
     {wordType:"noun",english:"Clothing",arabicBase:"لِبَاس",forms:{singular:"لِبَاس",plural:"أَلْبِسَة"}},
     {wordType:"noun",english:"Concept",arabicBase:"مَفْهُوم",forms:{singular:"مَفْهُوم",plural:"مَفَاهِيم"}},
     {wordType:"noun",english:"Tendency",arabicBase:"نَزْعَة",forms:{singular:"نَزْعَة",plural:"نَزَعَات"}},
     {wordType:"noun",english:"Guide",arabicBase:"هَادٍ",forms:{singular:"هَادٍ",plural:"هُدَاة"}},
     {wordType:"noun",english:"Farewell",arabicBase:"وَدَاع",forms:{singular:"وَدَاع"}},
     {wordType:"noun",english:"Intellect / core",arabicBase:"لُبّ",forms:{singular:"لُبّ",plural:"أَلْبَاب"}},
     {wordType:"noun",english:"Ease / comfort",arabicBase:"رَغَد",forms:{singular:"رَغَد"}},
     {wordType:"adjective",english:"Safe",arabicBase:"آمِن",forms:{singular:"آمِن",feminine:"آمِنَة"}},
     {wordType:"adjective",english:"Deterrent",arabicBase:"رَادِع",forms:{singular:"رَادِع",feminine:"رَادِعَة"}},
     {wordType:"adjective",english:"Disruptive",arabicBase:"مُخِلّ",forms:{singular:"مُخِلّ",feminine:"مُخِلَّة"}},
     {wordType:"verb",english:"To fear God / be wary of",arabicBase:"اتَّقَى",forms:{past:"اتَّقَى",present:"يَتَّقِي",imperative:"اِتَّقِ",masdar:"تَقْوَى",activePart:"مُتَّقٍ"}},
     {wordType:"verb",english:"To be linked",arabicBase:"ارْتَبَطَ",forms:{past:"ارْتَبَطَ",present:"يَرْتَبِطُ",imperative:"اِرْتَبِطْ",masdar:"اِرْتِبَاط",activePart:"مُرْتَبِط",harf:"بِـ"}},
     {wordType:"verb",english:"To be satisfied with",arabicBase:"ارْتَضَى",forms:{past:"ارْتَضَى",present:"يَرْتَضِي",imperative:"اِرْتَضِ",masdar:"اِرْتِضَاء",activePart:"مُرْتَضٍ"}},
     {wordType:"verb",english:"To appoint as successor",arabicBase:"اسْتَخْلَفَ",forms:{past:"اسْتَخْلَفَ",present:"يَسْتَخْلِفُ",imperative:"اِسْتَخْلِفْ",masdar:"اِسْتِخْلَاف",activePart:"مُسْتَخْلِف",passivePart:"مُسْتَخْلَف"}},
     {wordType:"verb",english:"To inspire",arabicBase:"أَلْهَمَ",forms:{past:"أَلْهَمَ",present:"يُلْهِمُ",imperative:"أَلْهِمْ",masdar:"إِلْهَام",activePart:"مُلْهِم",passivePart:"مُلْهَم"}},
     {wordType:"verb",english:"To belong",arabicBase:"انْتَمَى",forms:{past:"انْتَمَى",present:"يَنْتَمِي",imperative:"اِنْتَمِ",masdar:"اِنْتِمَاء",activePart:"مُنْتَمٍ",harf:"إِلَى"}},
     {wordType:"verb",english:"To look forward to",arabicBase:"تَطَلَّعَ",forms:{past:"تَطَلَّعَ",present:"يَتَطَلَّعُ",imperative:"تَطَلَّعْ",masdar:"تَطَلُّع",activePart:"مُتَطَلِّع",harf:"إِلَى"}},
     {wordType:"verb",english:"To disturb / muddy",arabicBase:"عَكَّرَ",forms:{past:"عَكَّرَ",present:"يُعَكِّرُ",imperative:"عَكِّرْ",masdar:"تَعْكِير",activePart:"مُعَكِّر",passivePart:"مُعَكَّر"}},
     {wordType:"verb",english:"To enable",arabicBase:"مَكَّنَ",forms:{past:"مَكَّنَ",present:"يُمَكِّنُ",imperative:"مَكِّنْ",masdar:"تَمْكِين",activePart:"مُمَكِّن",passivePart:"مُمَكَّن",harf:"مِنْ"}},
     {wordType:"verb",english:"To make taste",arabicBase:"أَذَاقَ",forms:{past:"أَذَاقَ",present:"يُذِيقُ",imperative:"أَذِقْ",masdar:"إِذَاقَة",activePart:"مُذِيق"}},
   ]},
  {id:"preset-byy4-u15", title:"Bayna Yadayk Book 4 · Unit 15 — Protection From Pollution", unitId:"4-15", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Usage",arabicBase:"اِسْتِخْدَام",forms:{singular:"اِسْتِخْدَام"}},
     {wordType:"noun",english:"Rain",arabicBase:"مَطَر",forms:{singular:"مَطَر",plural:"أَمْطَار"}},
     {wordType:"noun",english:"Depletion",arabicBase:"اِسْتِنْزَاف",forms:{singular:"اِسْتِنْزَاف"}},
     {wordType:"noun",english:"Exposure",arabicBase:"تَعَرُّض",forms:{singular:"تَعَرُّض"}},
     {wordType:"noun",english:"Revolution / eruption",arabicBase:"ثَوْرَة",forms:{singular:"ثَوْرَة",plural:"ثَوْرَات"}},
     {wordType:"noun",english:"Irrigation",arabicBase:"رِيّ",forms:{singular:"رِيّ"}},
     {wordType:"noun",english:"Light / radiance",arabicBase:"ضِيَاء",forms:{singular:"ضِيَاء"}},
     {wordType:"noun",english:"Organ / member",arabicBase:"عُضْو",forms:{singular:"عُضْو",plural:"أَعْضَاء"}},
     {wordType:"noun",english:"Decade / contract",arabicBase:"عَقْد",forms:{singular:"عَقْد",plural:"عُقُود"}},
     {wordType:"noun",english:"Goal / purpose",arabicBase:"غَايَة",forms:{singular:"غَايَة",plural:"غَايَات"}},
     {wordType:"noun",english:"Pillar / support",arabicBase:"عِمَاد",forms:{singular:"عِمَاد"}},
     {wordType:"noun",english:"Bomb",arabicBase:"قُنْبُلَة",forms:{singular:"قُنْبُلَة",plural:"قَنَابِل"}},
     {wordType:"noun",english:"Benefit / utility",arabicBase:"مَنْفَعَة",forms:{singular:"مَنْفَعَة",plural:"مَنَافِع"}},
     {wordType:"noun",english:"Resource",arabicBase:"مَوْرِد",forms:{singular:"مَوْرِد",plural:"مَوَارِد"}},
     {wordType:"noun",english:"Pesticide",arabicBase:"مُبِيد",forms:{singular:"مُبِيد",plural:"مُبِيدَات"}},
     {wordType:"adjective",english:"Atmospheric",arabicBase:"جَوِّيّ",forms:{singular:"جَوِّيّ",feminine:"جَوِّيَّة"}},
     {wordType:"adjective",english:"Fresh / tender",arabicBase:"طَرِيّ",forms:{singular:"طَرِيّ",feminine:"طَرِيَّة"}},
     {wordType:"adjective",english:"Grave / severe",arabicBase:"فَادِح",forms:{singular:"فَادِح",feminine:"فَادِحَة"}},
     {wordType:"adjective",english:"Integrated / complete",arabicBase:"مُتَكَامِل",forms:{singular:"مُتَكَامِل",feminine:"مُتَكَامِلَة"}},
     {wordType:"verb",english:"To be exposed to",arabicBase:"تَعَرَّضَ",forms:{past:"تَعَرَّضَ",present:"يَتَعَرَّضُ",imperative:"تَعَرَّضْ",masdar:"تَعَرُّض",activePart:"مُتَعَرِّض",harf:"لِـ"}},
     {wordType:"verb",english:"To explode / erupt",arabicBase:"تَفَجَّرَ",forms:{past:"تَفَجَّرَ",present:"يَتَفَجَّرُ",imperative:"تَفَجَّرْ",masdar:"تَفَجُّر",activePart:"مُتَفَجِّر"}},
     {wordType:"verb",english:"To seal / conclude",arabicBase:"خَتَمَ",forms:{past:"خَتَمَ",present:"يَخْتِمُ",imperative:"اِخْتِمْ",masdar:"خَتْم",activePart:"خَاتِم",passivePart:"مَخْتُوم"}},
     {wordType:"verb",english:"To touch",arabicBase:"لَمَسَ",forms:{past:"لَمَسَ",present:"يَلْمَسُ",imperative:"اِلْمَسْ",masdar:"لَمْس",activePart:"لَامِس",passivePart:"مَلْمُوس"}},
     {wordType:"verb",english:"To threaten",arabicBase:"هَدَّدَ",forms:{past:"هَدَّدَ",present:"يُهَدِّدُ",imperative:"هَدِّدْ",masdar:"تَهْدِيد",activePart:"مُهَدِّد",passivePart:"مُهَدَّد",harf:"بِـ"}},
   ]},
  {id:"preset-byy4-u16", title:"Bayna Yadayk Book 4 · Unit 16 — Types Of Energy", unitId:"4-16", level:"book4", seriesId:BYY4P2_SERIES,
   cards:[
     {wordType:"noun",english:"Friction",arabicBase:"اِحْتِكَاك",forms:{singular:"اِحْتِكَاك"}},
     {wordType:"noun",english:"Continuation",arabicBase:"اِسْتِمْرَار",forms:{singular:"اِسْتِمْرَار"}},
     {wordType:"noun",english:"Battery",arabicBase:"بَطَّارِيَّة",forms:{singular:"بَطَّارِيَّة",plural:"بَطَّارِيَّات"}},
     {wordType:"noun",english:"Wire",arabicBase:"سِلْك",forms:{singular:"سِلْك",plural:"أَسْلَاك"}},
     {wordType:"noun",english:"Machine",arabicBase:"آلَة",forms:{singular:"آلَة",plural:"آلَات"}},
     {wordType:"noun",english:"Ray",arabicBase:"شُعَاع",forms:{singular:"شُعَاع",plural:"أَشِعَّة"}},
     {wordType:"noun",english:"Steam",arabicBase:"بُخَار",forms:{singular:"بُخَار"}},
     {wordType:"noun",english:"Conversion",arabicBase:"تَحْوِيل",forms:{singular:"تَحْوِيل",plural:"تَحْوِيلَات"}},
     {wordType:"noun",english:"Motion",arabicBase:"تَحْرِيك",forms:{singular:"تَحْرِيك"}},
     {wordType:"noun",english:"Structure / composition",arabicBase:"تَرْكِيب",forms:{singular:"تَرْكِيب",plural:"تَرَاكِيب"}},
     {wordType:"noun",english:"Current",arabicBase:"تَيَّار",forms:{singular:"تَيَّار",plural:"تَيَّارَات"}},
     {wordType:"noun",english:"Stone",arabicBase:"حَجَر",forms:{singular:"حَجَر",plural:"أَحْجَار"}},
     {wordType:"noun",english:"Cell",arabicBase:"خَلِيَّة",forms:{singular:"خَلِيَّة",plural:"خَلَايَا"}},
     {wordType:"noun",english:"Wind",arabicBase:"رِيح",forms:{singular:"رِيح",plural:"رِيَاح"}},
     {wordType:"noun",english:"Dam",arabicBase:"سَدّ",forms:{singular:"سَدّ",plural:"سُدُود"}},
     {wordType:"noun",english:"Surface",arabicBase:"سَطْح",forms:{singular:"سَطْح",plural:"سُطُوح"}},
     {wordType:"noun",english:"Ease",arabicBase:"سُهُولَة",forms:{singular:"سُهُولَة"}},
     {wordType:"noun",english:"Waterfall",arabicBase:"شَلَّال",forms:{singular:"شَلَّال",plural:"شَلَّالَات"}},
     {wordType:"noun",english:"Shape",arabicBase:"شَكْل",forms:{singular:"شَكْل",plural:"أَشْكَال"}},
     {wordType:"noun",english:"Rock",arabicBase:"صَخْرَة",forms:{singular:"صَخْرَة",plural:"صُخُور"}},
     {wordType:"noun",english:"Mill",arabicBase:"طَاحُونَة",forms:{singular:"طَاحُونَة",plural:"طَوَاحِين"}},
     {wordType:"noun",english:"Locomotive",arabicBase:"قَاطِرَة",forms:{singular:"قَاطِرَة",plural:"قَاطِرَات"}},
     {wordType:"noun",english:"Quantity",arabicBase:"كَمِّيَّة",forms:{singular:"كَمِّيَّة",plural:"كَمِّيَّات"}},
     {wordType:"noun",english:"Manifestation",arabicBase:"مَظْهَر",forms:{singular:"مَظْهَر",plural:"مَظَاهِر"}},
     {wordType:"noun",english:"Waste",arabicBase:"نُفَايَات",forms:{singular:"نُفَايَات"}},
     {wordType:"adjective",english:"Dry",arabicBase:"جَافّ",forms:{singular:"جَافّ",feminine:"جَافَّة"}},
     {wordType:"adjective",english:"Thermal",arabicBase:"حَرَارِيّ",forms:{singular:"حَرَارِيّ",feminine:"حَرَارِيَّة"}},
     {wordType:"adjective",english:"Vast",arabicBase:"شَاسِع",forms:{singular:"شَاسِع",feminine:"شَاسِعَة"}},
     {wordType:"adjective",english:"Available",arabicBase:"مُتَوَفِّر",forms:{singular:"مُتَوَفِّر",feminine:"مُتَوَفِّرَة"}},
     {wordType:"adjective",english:"Mechanical",arabicBase:"مِيكَانِيكِيّ",forms:{singular:"مِيكَانِيكِيّ",feminine:"مِيكَانِيكِيَّة"}},
     {wordType:"verb",english:"To invent",arabicBase:"اخْتَرَعَ",forms:{past:"اخْتَرَعَ",present:"يَخْتَرِعُ",imperative:"اِخْتَرِعْ",masdar:"اِخْتِرَاع",activePart:"مُخْتَرِع",passivePart:"مُخْتَرَع"}},
     {wordType:"verb",english:"To absorb",arabicBase:"اِمْتَصَّ",forms:{past:"اِمْتَصَّ",present:"يَمْتَصُّ",imperative:"اِمْتَصَّ",masdar:"اِمْتِصَاص",activePart:"مُمْتَصّ",passivePart:"مُمْتَصّ"}},
     {wordType:"verb",english:"To sweep away",arabicBase:"جَرَفَ",forms:{past:"جَرَفَ",present:"يَجْرُفُ",imperative:"اُجْرُفْ",masdar:"جَرْف",activePart:"جَارِف",passivePart:"مَجْرُوف"}},
     {wordType:"verb",english:"To revolve",arabicBase:"دَارَ",forms:{past:"دَارَ",present:"يَدُورُ",imperative:"دُرْ",masdar:"دَوَرَان",activePart:"دَائِر"}},
     {wordType:"verb",english:"To heat",arabicBase:"سَخَّنَ",forms:{past:"سَخَّنَ",present:"يُسَخِّنُ",imperative:"سَخِّنْ",masdar:"تَسْخِين",activePart:"مُسَخِّن",passivePart:"مُسَخَّن"}},
     {wordType:"verb",english:"To pollute",arabicBase:"لَوَّثَ",forms:{past:"لَوَّثَ",present:"يُلَوِّثُ",imperative:"لَوِّثْ",masdar:"تَلْوِيث",activePart:"مُلَوِّث",passivePart:"مُلَوَّث"}},
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
// Bulk version — downloads several presets (e.g. a whole book's worth of
// units) as ONE combined import instead of calling downloadPreset in a loop.
// Firing 8 separate "importDeck" events back-to-back would all get picked up
// by the same (not-yet-re-rendered) event listener closure, each computing
// `newDecks=[d,...decks]` off the SAME stale `decks` snapshot — only the
// last of the 8 would actually survive. Dispatching one "importDecks" event
// with the whole batch avoids that entirely: the app does one state update
// and one save for everything at once.
function downloadPresets(pds){
  const now=Date.now();
  const decks=[]; const cardsByDeckId={}; let total=0;
  pds.forEach((pd,pi)=>{
    const deckId=`d${now}-${pi}`;
    const cards=(pd.cards||[]).map((c,i)=>({...c,id:`c${now}-${pi}-${i}`,status:"new"}));
    decks.push({id:deckId,title:pd.title,createdAt:now+pi,...(pd.unitId?{unitId:pd.unitId,level:pd.level||(unitById(pd.unitId)?.level)}:{})});
    cardsByDeckId[deckId]=cards;
    total+=cards.length;
  });
  window.dispatchEvent(new CustomEvent("importDecks",{detail:{decks,cardsByDeckId}}));
  return total;
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

// Every setDoc to the user doc — main autosave, session/screen sync, deck-
// resume-position sync — used to fire its own independent network call the
// moment its own debounce elapsed. With a large account (thousands of
// cards) those calls can easily still be in flight when the next one fires,
// and Firestore's SDK queues writes that haven't been ack'd yet rather than
// dropping them — pile up enough of those and it hits its own queue cap and
// starts REJECTING new writes outright ("Write stream exhausted maximum
// allowed queued writes"), which is exactly what an import's save could
// lose to. Routing every write through one serialized, coalescing queue
// (one in-flight request at a time; multiple writes queued for the same
// target doc get merged into a single payload instead of sent one-by-one)
// keeps this client from ever being the cause of its own backlog. Keyed by
// an arbitrary string (not just uid) so it can serialize writes to the main
// user doc AND per-deck cards docs (see deckCardsRef below) through the same
// queue.
let _writeInFlight=false;
const _pendingWrites={}; // key -> {ref,data}
const _pendingCallbacks={}; // key -> [{onSuccess,onError}]
function queueFirestoreWrite(key,ref,data,{onSuccess,onError}={}){
  if(!ref) return;
  const existing=_pendingWrites[key];
  _pendingWrites[key]={ref,data:{...(existing?.data),...data}};
  if(onSuccess||onError){
    (_pendingCallbacks[key]=_pendingCallbacks[key]||[]).push({onSuccess,onError});
  }
  pumpWriteQueue();
}
function pumpWriteQueue(){
  if(_writeInFlight) return;
  const key=Object.keys(_pendingWrites)[0];
  if(!key) return;
  const {ref,data}=_pendingWrites[key];
  delete _pendingWrites[key];
  const callbacks=_pendingCallbacks[key]||[];
  delete _pendingCallbacks[key];
  _writeInFlight=true;
  // updateDoc, NOT setDoc(...,{merge:true}): a dotted string key like
  // "decksById.<id>" is only treated as a nested-field path by updateDoc.
  // setDoc with merge:true takes every object key literally, dots and all —
  // it silently created flat top-level fields actually named "decksById.x"
  // instead of nesting into a decksById map (confirmed directly in the
  // Firestore console: existing data is unaffected, sitting safely under
  // those literal field names, just never nested the way every read in this
  // file assumed). updateDoc requires the doc to already exist, so fall back
  // to setDoc only to create it on this account's very first-ever write.
  (async()=>{
    try {
      try {
        await updateDoc(ref,data);
      } catch(e){
        if(e.code!=="not-found") throw e;
        await setDoc(ref,data,{merge:true});
      }
      callbacks.forEach(cb=>cb.onSuccess?.());
    } catch(e){
      console.error("Save error:",e);
      callbacks.forEach(cb=>cb.onError?.(e));
    } finally {
      _writeInFlight=false;
      pumpWriteQueue();
    }
  })();
}
// deckCards/{deckId} docs hold that deck's cards ONLY — see the big comment
// on the migration logic in loadUserDoc for why this exists: cramming every
// deck's entire card list into the one main user doc hit Firestore's hard
// 1MB-per-document ceiling once an account grew past a few thousand cards,
// and once that happens EVERY save fails outright, forever, with no amount
// of retry/timing logic able to help — the doc is just too big to write.
function deckCardsRef(uid,deckId){ return doc(db,"users",uid,"deckCards",deckId); }
function mainDocRef(uid){ return doc(db,"users",uid); }
// Writes each deck's cards to its own doc BEFORE clearing the legacy field
// on the main doc, sequentially (not one batch) — so if this account has one
// single deck whose cards alone are still too big for one document, that
// one failure doesn't block every OTHER deck from migrating, and doesn't
// risk losing anything either way: the legacy field is only cleared once
// every deck it still lists has been confirmed written to its own doc.
async function migrateLegacyCardStates(uid,legacyCardStates,deckIds){
  const entries=Object.entries(legacyCardStates).filter(([id])=>deckIds.has(id));
  if(!entries.length) return;
  try {
    for(const [deckId,cards] of entries){
      await setDoc(deckCardsRef(uid,deckId),{cards});
    }
    await setDoc(mainDocRef(uid),{cardStates:deleteField()},{merge:true});
  } catch(e){ console.error("Migration error:",e); }
}
// Same idea for deck metadata: a legacy account still has the whole `decks`
// array as one field, which is exactly the last-write-wins shape that let a
// stale device erase decks it never saw. Mirror each entry not already in
// `decksById` into `decksById.<id>` (a dotted-path merge — see queueFirestoreWrite
// comment), THEN clear the legacy array field, so any device reading before
// migration finishes still has the legacy array as a fallback (see loadUserDoc).
async function migrateLegacyDecks(uid,legacyDecks,decksById){
  const missing=legacyDecks.filter(dk=>!(dk.id in decksById));
  try {
    for(const dk of missing){
      // updateDoc, not setDoc(...,{merge:true}) — see pumpWriteQueue comment;
      // setDoc took the dotted key literally instead of nesting it.
      await updateDoc(mainDocRef(uid),{[`decksById.${dk.id}`]:dk});
    }
    if(legacyDecks.length) await setDoc(mainDocRef(uid),{decks:deleteField()},{merge:true});
  } catch(e){ console.error("Migration error:",e); }
}
// Consolidates the flat "decksById.<id>" fields left by the setDoc-took-dots-
// literally bug into one proper nested decksById map, THEN removes the old
// flat fields — in that order, so there is always at least one live,
// findable copy of the data on the server throughout the migration.
async function migrateFlatDecksById(uid,flatDecksById,fullMergedDecksById){
  try {
    await updateDoc(mainDocRef(uid),{decksById:fullMergedDecksById});
    const clearPayload={};
    for(const suffix of Object.keys(flatDecksById)) clearPayload[`decksById.${suffix}`]=deleteField();
    await setDoc(mainDocRef(uid),clearPayload,{merge:true});
  } catch(e){ console.error("Flat decksById cleanup error:",e); }
}
function cloudSyncSession(key,payload){
  if(!_sessionSyncUid) return;
  clearTimeout(_sessionSyncTimers[key]);
  _sessionSyncTimers[key]=setTimeout(()=>{
    queueFirestoreWrite("main:"+_sessionSyncUid,mainDocRef(_sessionSyncUid),payload);
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
    queueFirestoreWrite("main:"+_sessionSyncUid,mainDocRef(_sessionSyncUid),{[`deckIdx.${key}`]:idx});
  },1200);
}
// Recovers fields written by the old (buggy) dotted-string-key + setDoc
// pattern — e.g. "decksById.d1" — which setDoc(...,{merge:true}) took
// LITERALLY as a top-level field name instead of nesting it, unlike
// updateDoc (see pumpWriteQueue). That data is real and was never lost, just
// scattered across top-level fields no read ever looked for. Returns
// {suffix: value} for every top-level key starting with `prefix`.
function extractPrefixedFields(d,prefix){
  const out={};
  for(const key of Object.keys(d)){
    if(key.startsWith(prefix)) out[key.slice(prefix.length)]=d[key];
  }
  return out;
}
// Merge the cloud's deckIdx map into this device's local copy — cloud keys
// win per-entry (each key is one deck+filter, so there's no real "conflict"
// to resolve, just whichever device most recently studied that filter).
function hydrateDeckIdxFromCloud(d,ref){
  const merged={...(d.deckIdx||{}),...extractPrefixedFields(d,"deckIdx.")};
  if(!Object.keys(merged).length) return;
  Object.assign(ref.current,merged);
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
  // Group decks sharing a seriesId (e.g. all 8 units of one book/part) so a
  // whole series can be downloaded in one tap instead of one at a time.
  const seriesIds=[...new Set(filtered.map(d=>d.seriesId).filter(Boolean))];
  const seriesGroups=seriesIds.map(sid=>({
    seriesId:sid,
    decks:filtered.filter(d=>d.seriesId===sid).sort((a,b)=>(unitById(a.unitId)?.index||0)-(unitById(b.unitId)?.index||0)),
  }));
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
        {seriesGroups.map(({seriesId,decks:seriesDecks})=>{
          const totalCards=seriesDecks.reduce((s,d)=>s+(d.cards||[]).length,0);
          const book=seriesDecks[0]?.unitId?unitById(seriesDecks[0].unitId):null;
          return (
            <div key={seriesId} className="module-card" style={{alignItems:"flex-start",cursor:"default",background:"var(--accent-bg)",border:"1.5px solid var(--accent-border)"}}>
              <div style={{width:40,height:40,borderRadius:12,background:"var(--accent)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Download size={18} color="#fff"/></div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:14}}>{SERIES_LABELS[seriesId]||"Whole book"} · {seriesDecks.length} units</div>
                <div style={{fontSize:11.5,color:"var(--text3)",marginTop:2}}>{totalCards} cards total{book?` · ${levelById(book.level).cefr}`:""}</div>
              </div>
              <button className="btn btn-sm" onClick={()=>{const n=downloadPresets(seriesDecks);showToast(`Downloading ${seriesDecks.length} decks (${n} cards)…`,"info");}}
                style={{background:"var(--accent)",color:"#fff",flexShrink:0,alignSelf:"center",gap:5,fontSize:12.5}}>
                <Download size={13}/> Download all {seriesDecks.length}
              </button>
            </div>
          );
        })}
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
  // The last cardStates this tab actually confirmed saved (per deck, by
  // array reference) — the main autosave effect diffs against this to know
  // WHICH deck(s) changed since the last save, since cards now live in their
  // own per-deck doc rather than one shared field. Every mutation path in
  // this file replaces a touched deck's array with a new one (`{...p,[id]:
  // ...}`), so a reference change reliably means "this deck was touched."
  const prevCardStatesRef=useRef({});
  // Same idea, for deck metadata: which deck OBJECTS (by reference) changed
  // since the last save. `decks` itself is written per-key (decksById.<id>,
  // see mainDocRef writes below), never as one whole array field — a device
  // with stale knowledge (e.g. a phone that loaded a split second before a
  // desktop's import landed) must never be able to write the WHOLE decks
  // list back and erase a deck it simply never saw. Diffing means it only
  // ever mentions the specific deck(s) IT touched, so a deck it doesn't know
  // about is never named in its writes and can't be clobbered by them.
  const prevDecksRef=useRef([]);
  // EMERGENCY SAFETY GUARD (2026-09-01): a load that finds neither `decks`
  // nor `decksById` on the cloud doc falls back to leaving local state at
  // its SEED_DECKS/SEED_CARDS default — that's the deliberate "brand new
  // user" path. But if this ever happens for an EXISTING account (cloud doc
  // unexpectedly missing its real deck data — under investigation), the
  // autosave effect must NOT be allowed to write that placeholder data to
  // the cloud at all: doing so could permanently stamp seed content over an
  // account that's still recoverable. Set true only when the load actually
  // saw real deck data (or a legitimate explicit empty state) on the cloud.
  const cloudDeckDataConfirmedRef=useRef(false);
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
      getDoc(doc(db,"users",u.uid)).then(async snap=>{
          if(!mounted) return;
          // A successful read — even "the doc doesn't exist yet" for a
          // brand-new account — is a confirmed, legitimate cloud state to
          // build from. Previously this only got set inside the `snap.
          // exists()` branch below, so a genuinely new user (no doc created
          // yet at all) could NEVER pass this guard: every save, including
          // settings and preset-deck downloads, was silently refused forever.
          cloudDeckDataConfirmedRef.current=true;
          if(snap.exists()){
            const d=snap.data();
            try {
              // Trust an explicitly-present `decks`/`decksById` as-is —
              // including empty, which is a legitimate "user deleted
              // everything" state. Only fall back to the local seed when
              // BOTH are truly ABSENT (e.g. a doc predating either field).
              // Previously this checked `d.decks?.length`, so any load that
              // returned a falsy/empty decks array (transient read glitch,
              // etc.) silently kept the in-memory SEED_DECKS/SEED_CARDS,
              // which then got written back over the real cloud data by the
              // autosave effect below — wiping the user's real decks.
              // flatDecksById recovers the real per-deck data that a prior bug
              // scattered across literal top-level fields named e.g.
              // "decksById.d1" (setDoc+merge:true took the dotted string key
              // literally instead of nesting it — see pumpWriteQueue). Fixed
              // going forward (now uses updateDoc, which nests correctly),
              // but this account's existing data is STILL sitting under those
              // flat names until migrated, so it has to be checked here too,
              // or an existing account's real decks look like they vanished.
              const flatDecksById=extractPrefixedFields(d,"decksById.");
              if(Array.isArray(d.decks)||(d.decksById&&typeof d.decksById==="object")||Object.keys(flatDecksById).length) {
                // Merge priority: flat legacy-bug fields, then the legacy
                // whole-array field, then the properly-nested decksById —
                // nested wins because it's what every FIXED write targets
                // going forward, so it reflects the most current state for
                // whatever it contains.
                const legacyArr=Array.isArray(d.decks)?d.decks:[];
                const decksById=d.decksById||{};
                const mergedDecks={...flatDecksById};
                for(const dk of legacyArr) mergedDecks[dk.id]=dk;
                for(const [id,dk] of Object.entries(decksById)) mergedDecks[id]=dk;
                const sortedDecks=Object.values(mergedDecks).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
                setDecks(sortedDecks);
                prevDecksRef.current=sortedDecks;
                cloudDeckDataConfirmedRef.current=true;
                if(legacyArr.length) migrateLegacyDecks(u.uid,legacyArr,decksById);
                if(Object.keys(flatDecksById).length) migrateFlatDecksById(u.uid,flatDecksById,mergedDecks);
                const deckIds=new Set(sortedDecks.map(dk=>dk.id));
                // Cards live in deckCards/{deckId} docs, not on the main doc —
                // see the migration comment below. `d.cardStates` is only read
                // here as a fallback for decks not yet migrated off it.
                const deckCardsSnap=await getDocs(collection(db,"users",u.uid,"deckCards"));
                const fromSub={};
                deckCardsSnap.forEach(docSnap=>{ fromSub[docSnap.id]=docSnap.data().cards||[]; });
                const merged={...(d.cardStates||{}),...fromSub};
                // Clean orphaned cardStates — only keep keys matching existing decks
                const cleaned={};
                for(const [k,v] of Object.entries(merged)){
                  if(deckIds.has(k)) cleaned[k]=v;
                }
                if(mounted){
                  setCardStates(cleaned);
                  prevCardStatesRef.current=cleaned;
                }
                // One-time migration: a legacy account still has ALL decks'
                // cards embedded in this one main doc under `cardStates`. That
                // is exactly what grew past Firestore's hard 1MB-per-document
                // ceiling once this account passed a few thousand cards —
                // once a doc is that big, EVERY future write to it fails
                // outright ("Document ... exceeds the maximum allowed size"),
                // permanently, no matter how saves are timed or debounced.
                // Move each deck's cards to its own deckCards/{deckId} doc
                // (see migrateLegacyCardStates), then clear the field here so
                // the main doc shrinks back under the limit.
                if(d.cardStates&&Object.keys(d.cardStates).length){
                  migrateLegacyCardStates(u.uid,d.cardStates,deckIds);
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
      // EMERGENCY SAFETY GUARD (2026-09-01) — see cloudDeckDataConfirmedRef
      // comment. Refuse to write anything at all until a load has actually
      // confirmed real deck data from the cloud, so this can never be the
      // thing that stamps placeholder/fallback state over a real account.
      if(!cloudDeckDataConfirmedRef.current){
        console.error("[flashcard-safety] Skipped autosave — cloud deck data was never confirmed loaded this session.");
        return;
      }
      const stamp=Date.now();
      const payload={settings,usage,studyLog,updatedAt:stamp,...(profile?{profile}:{})};
      // `decks` is written per-key (decksById.<id>), never as one whole array
      // field — see prevDecksRef comment: only the deck(s) that actually
      // changed get named here, so a stale copy of this tab's decks can never
      // erase a deck it doesn't currently know about.
      const prevD=prevDecksRef.current;
      const prevById={}; for(const dk of prevD) prevById[dk.id]=dk;
      const curById={}; for(const dk of decks) curById[dk.id]=dk;
      for(const dk of decks){
        if(curById[dk.id]!==prevById[dk.id]) payload[`decksById.${dk.id}`]=dk;
      }
      for(const dk of prevD){
        if(!(dk.id in curById)) payload[`decksById.${dk.id}`]=deleteField();
      }
      queueFirestoreWrite("main:"+user.uid,mainDocRef(user.uid),payload,{
        onSuccess:()=>{ lastSyncRef.current=stamp; },
      });
      prevDecksRef.current=decks;
      // Cards live in their own deckCards/{deckId} doc, not on the main doc
      // (see migrateLegacyCardStates) — only write the deck(s) whose array
      // reference actually changed since the last save, and delete a deck's
      // doc if the deck itself was removed. Every mutation path in this file
      // replaces a touched deck's array wholesale, so a reference change
      // reliably means "this deck changed."
      const prev=prevCardStatesRef.current;
      for(const id of Object.keys(cardStates)){
        if(cardStates[id]!==prev[id]){
          queueFirestoreWrite("deck:"+user.uid+":"+id,deckCardsRef(user.uid,id),{cards:cardStates[id]});
        }
      }
      for(const id of Object.keys(prev)){
        if(!(id in cardStates)) deleteDoc(deckCardsRef(user.uid,id)).catch(e=>console.error("Delete deck doc error:",e));
      }
      prevCardStatesRef.current=cardStates;
    };
    // 4s, not 1.5s — resaving on every single card swipe during continuous
    // study was firing far more often than each write could actually
    // complete, which is exactly how Firestore's SDK write queue got
    // overwhelmed (see queueFirestoreWrite above). flushIfHidden/pagehide
    // below still guarantee a save the instant the tab actually goes away.
    const t=setTimeout(save,4000);
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
      getDoc(doc(db,"users",user.uid)).then(async snap=>{
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
        const flatDecksById=extractPrefixedFields(d,"decksById.");
        if(!Array.isArray(d.decks)&&!(d.decksById&&typeof d.decksById==="object")&&!Object.keys(flatDecksById).length) return;
        if((d.updatedAt||0)<=lastSyncRef.current) return;
        const legacyArr=Array.isArray(d.decks)?d.decks:[];
        const decksByIdCloud=d.decksById||{};
        const mergedDecks={...flatDecksById};
        for(const dk of legacyArr) mergedDecks[dk.id]=dk;
        for(const [id,dk] of Object.entries(decksByIdCloud)) mergedDecks[id]=dk;
        const sortedDecks=Object.values(mergedDecks).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
        setDecks(sortedDecks);
        prevDecksRef.current=sortedDecks;
        cloudDeckDataConfirmedRef.current=true;
        if(legacyArr.length) migrateLegacyDecks(user.uid,legacyArr,decksByIdCloud);
        if(Object.keys(flatDecksById).length) migrateFlatDecksById(user.uid,flatDecksById,mergedDecks);
        // Cards live in deckCards/{deckId} docs (see migrateLegacyCardStates)
        // — re-pull them here too, or a device that only picked up newer
        // decks from elsewhere would keep whatever stale cards it already
        // had for any deck the OTHER device actually touched.
        const deckIds=new Set(sortedDecks.map(dk=>dk.id));
        const deckCardsSnap=await getDocs(collection(db,"users",user.uid,"deckCards"));
        const fromSub={};
        deckCardsSnap.forEach(docSnap=>{ fromSub[docSnap.id]=docSnap.data().cards||[]; });
        const merged={...(d.cardStates||{}),...fromSub};
        const cleaned={};
        for(const [k,v] of Object.entries(merged)){
          if(deckIds.has(k)) cleaned[k]=v;
        }
        setCardStates(cleaned);
        prevCardStatesRef.current=cleaned;
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
  // autosave effect entirely, and return a Promise so callers can actually
  // wait for the write to land before telling the user it's safe. Firing
  // this fire-and-forget was NOT enough: a setDoc kicked off by
  // visibilitychange/pagehide does not reliably survive an actual refresh —
  // the browser can and does cancel in-flight requests when the page tears
  // down, and this account's cardStates blob (thousands of cards) is large
  // enough to take real time to transmit, so a refresh thrown right after
  // import wins that race almost every time. The only real fix is to not
  // let the UI claim "saved" (and thus invite a refresh) until the write is
  // actually confirmed round-tripped.
  // touchedDeckIds: which deck(s) in newCardStates actually changed — cards
  // live in their own deckCards/{deckId} doc (see migrateLegacyCardStates),
  // so only those need writing, not the whole cardStates map.
  const pendingSaveCountRef=useRef(0);
  const flushSaveNow=(newDecks,newCardStates,touchedDeckIds)=>{
    if(!user) return Promise.resolve();
    // EMERGENCY SAFETY GUARD (2026-09-01) — see cloudDeckDataConfirmedRef
    // comment. Block explicit saves too (imports, new decks) until a load
    // has actually confirmed real cloud deck data this session.
    if(!cloudDeckDataConfirmedRef.current){
      return Promise.reject(new Error("Cloud deck data not confirmed loaded yet — refusing to save."));
    }
    const stamp=Date.now();
    pendingSaveCountRef.current++;
    // `decks` written per-key (decksById.<id>), not as one whole array field
    // — see prevDecksRef comment. Only the deck(s) this specific import
    // touched are named, same reasoning as the main autosave effect.
    const newById={}; for(const dk of newDecks) newById[dk.id]=dk;
    const payload={settings,usage,studyLog,updatedAt:stamp,...(profile?{profile}:{})};
    for(const id of touchedDeckIds){ if(newById[id]) payload[`decksById.${id}`]=newById[id]; }
    const mainPromise=new Promise((resolve,reject)=>{
      queueFirestoreWrite("main:"+user.uid,mainDocRef(user.uid),payload,{
        onSuccess:()=>{ lastSyncRef.current=stamp; resolve(); },
        onError:(e)=>reject(e),
      });
    });
    const deckPromises=touchedDeckIds.map(id=>new Promise((resolve,reject)=>{
      queueFirestoreWrite("deck:"+user.uid+":"+id,deckCardsRef(user.uid,id),{cards:newCardStates[id]},{
        onSuccess:resolve,
        onError:reject,
      });
    }));
    prevCardStatesRef.current=newCardStates;
    prevDecksRef.current=newDecks;
    return Promise.all([mainPromise,...deckPromises]).finally(()=>{ pendingSaveCountRef.current--; });
  };
  // Belt-and-suspenders: warn on an actual browser close/refresh while one
  // of the awaited saves below is still in flight, in case the user refreshes
  // faster than the "Saving…" toast can register.
  useEffect(()=>{
    const onBeforeUnload=(e)=>{
      if(pendingSaveCountRef.current>0){ e.preventDefault(); e.returnValue=""; }
    };
    window.addEventListener("beforeunload",onBeforeUnload);
    return ()=>window.removeEventListener("beforeunload",onBeforeUnload);
  },[]);

  // Save grammar cards from the Grammar Import screen — either into a brand
  // new deckType:"grammar" deck or appended to an existing grammar deck.
  const saveGrammarDeck=async(title,cards,target)=>{
    let newDecks=decks,newCardStates,touchedId;
    if(target){
      touchedId=target.id;
      newCardStates={...cardStates,[target.id]:[...(cardStates[target.id]||[]),...cards]};
      setCardStates(newCardStates);
    } else {
      const deck={id:`d${Date.now()}`,title,createdAt:Date.now(),deckType:"grammar"};
      touchedId=deck.id;
      newDecks=[deck,...decks];
      newCardStates={...cardStates,[deck.id]:cards};
      setDecks(newDecks);
      setCardStates(newCardStates);
    }
    showToast("Saving…","info");
    try {
      await flushSaveNow(newDecks,newCardStates,[touchedId]);
      showToast(target?`Added ${cards.length} grammar cards to "${target.title}"`:`Grammar deck "${title}" created — ${cards.length} concepts`,"success");
      setGrammarTarget(null);
      setScreen("home");
    } catch(e) {
      console.error("Save error:",e);
      showToast("Couldn't save to the cloud — check your connection and try again before closing this tab.","error");
    }
  };

  // Save vocab cards from the Vocab Import screen — either into a brand new
  // deck or appended to an existing one. Cards are normal wordType (noun/
  // verb/adjective), no deckType tag — same shape as manually-added cards.
  const saveVocabDeck=async(title,cards,target)=>{
    let newDecks=decks,newCardStates,touchedId;
    if(target){
      touchedId=target.id;
      newCardStates={...cardStates,[target.id]:[...(cardStates[target.id]||[]),...cards]};
      setCardStates(newCardStates);
    } else {
      const deck={id:`d${Date.now()}`,title,createdAt:Date.now()}; // no deckType → normal vocab deck
      touchedId=deck.id;
      newDecks=[deck,...decks];
      newCardStates={...cardStates,[deck.id]:cards};
      setDecks(newDecks);
      setCardStates(newCardStates);
    }
    showToast("Saving…","info");
    try {
      await flushSaveNow(newDecks,newCardStates,[touchedId]);
      showToast(target?`Added ${cards.length} vocab cards to "${target.title}"`:`Vocab deck "${title}" created — ${cards.length} cards`,"success");
      setVocabTarget(null);
      setScreen("home");
    } catch(e) {
      console.error("Save error:",e);
      showToast("Couldn't save to the cloud — check your connection and try again before closing this tab.","error");
    }
  };

  // Handle deck import from HomeScreen
  useEffect(()=>{
    const handler=async(e)=>{
      const {deck:d,cards:c}=e.detail;
      const newDecks=[d,...decks];
      const newCardStates={...cardStates,[d.id]:c};
      setDecks(newDecks);
      setCardStates(newCardStates);
      showToast("Saving…","info");
      try {
        await flushSaveNow(newDecks,newCardStates,[d.id]);
        showToast(`Deck "${d.title}" imported`,"success");
      } catch(err) {
        console.error("Save error:",err);
        showToast("Couldn't save to the cloud — check your connection and try again before closing this tab.","error");
      }
    };
    window.addEventListener("importDeck",handler);
    return ()=>window.removeEventListener("importDeck",handler);
  },[decks,cardStates,user,settings,usage,studyLog,profile]);

  // Handle bulk deck import (e.g. "download all 8 units") — see
  // downloadPresets: one combined state update + one save for the whole
  // batch, instead of N separate importDeck events racing each other.
  useEffect(()=>{
    const handler=async(e)=>{
      const {decks:newDeckList,cardsByDeckId}=e.detail;
      const newDecks=[...newDeckList,...decks];
      const newCardStates={...cardStates,...cardsByDeckId};
      setDecks(newDecks);
      setCardStates(newCardStates);
      showToast(`Saving ${newDeckList.length} decks…`,"info");
      try {
        await flushSaveNow(newDecks,newCardStates,newDeckList.map(d=>d.id));
        showToast(`${newDeckList.length} decks imported`,"success");
      } catch(err) {
        console.error("Save error:",err);
        showToast("Couldn't save to the cloud — check your connection and try again before closing this tab.","error");
      }
    };
    window.addEventListener("importDecks",handler);
    return ()=>window.removeEventListener("importDecks",handler);
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
