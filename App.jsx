import { useState, useRef, useEffect, useCallback } from "react";
import { auth, googleProvider, db } from "./firebase.js";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  Settings, ArrowLeft, ChevronRight, X, Volume2, RotateCcw, BookOpen,
  RefreshCw, Check, Sparkles, Plus, Edit3, Trash2, Layers, Save, Eye,
  EyeOff, Headphones, FileText, Play, Pause, SkipBack, Sliders, Globe,
  PlusCircle, Mic, Info, Image as ImageIcon, MoreVertical, Pencil,
  DollarSign, Zap, ChevronDown, ChevronUp, SquareCheck, Square,
  Moon, Sun, Download, Upload, Search, MessageCircle, HelpCircle,
  Send, Clock, Target, BarChart3, Hash, Star, PenLine, Brain, CheckCircle2
} from "lucide-react";

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

/** Get vocab level as percentage toward B2 */
function getVocabProgress(cardStates) {
  const known = Object.values(cardStates).flat().filter(c => c.status === "known").length;
  return { known, target: B2_WORD_TARGET, pct: Math.min(100, Math.round(known / B2_WORD_TARGET * 100)) };
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
  past:"Past", present:"Present", imperative:"Command",
  masdar:"Masdar", activePart:"Active Part.", passivePart:"Passive Part.",
  masculine:"Masculine", feminine:"Feminine",
};
const FORM_ARABIC = {
  singular:"مفرد", plural:"جمع ١", plural2:"جمع ٢",
  synonym:"مرادف", synonymPlural:"جمع المرادف",
  antonym:"ضد", antonymPlural:"جمع الضد",
  harf:"حرف الجر",
  past:"ماضي", present:"مضارع", imperative:"أمر",
  masdar:"مصدر", activePart:"فاعل", passivePart:"مفعول",
  masculine:"مذكر", feminine:"مؤنث",
};
const FORMS_BY_TYPE = {
  noun:      ["singular","plural","plural2","synonym","synonymPlural","antonym","antonymPlural","harf"],
  verb:      ["past","present","imperative","masdar","activePart","passivePart","harf"],
  adjective: ["masculine","feminine","plural","antonym","antonymPlural","harf"],
  other:     ["singular","plural","plural2","synonym","antonym","harf"],
};
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

const USAGE_LABELS = {
  flashcard:"Flashcard Generation", sentence:"Sentence / Learning Aid",
  reading:"Reading Passage", listening:"Listening Content",
  wordLookup:"Word Lookup", regen:"Form Regeneration",
};

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

// Module-level model ref — updated by root App when settings change.
// Avoids threading model as a prop through every screen component.
let _activeModel = "openai/gpt-4o-mini";
let _orKey = ""; // OpenRouter key — synced from settings
let _oaKey = ""; // OpenAI key for DALL-E — synced from settings

async function callClaude(prompt, maxTokens=1500, tag="other", trackFn=null) {
  const res = await fetch("/api/claude", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({
      model: _activeModel,
      max_tokens: maxTokens,
      messages:[{role:"user",content:prompt}],
      ..._orKey ? {apiKey:_orKey} : {},
    }),
  });
  const d = await res.json();
  if(d.error) throw new Error(d.error);
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

// DALL-E image generation — goes through /api/image proxy
// Returns image URL or null (app shows scene description as fallback)
async function generateDalleImage(prompt) {
  try {
    const res = await fetch("/api/image", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"dall-e-3",
        prompt:`${prompt} Style: warm natural photography, soft daylight, everyday life in an Arabic-speaking country, photorealistic. No text or Arabic letters visible in the image.`,
        n:1, size:"1024x1024", quality:"standard",
        ..._oaKey ? {apiKey:_oaKey} : {},
      }),
    });
    const data = await res.json();
    if (data.noKey) return null;
    return data.data?.[0]?.url || null;
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
          <span style={{fontSize:10,color:"rgba(255,255,255,.4)",background:"rgba(255,255,255,.08)",padding:"2px 7px",borderRadius:100,border:"1px solid rgba(255,255,255,.12)"}}>DALL-E ready</span>
        </div>
        <div style={{fontSize:13.5,color:"rgba(255,255,255,.88)",lineHeight:1.75,fontStyle:"italic"}}>{imagePrompt}</div>
        <div style={{marginTop:10,fontSize:11,color:"rgba(255,255,255,.35)"}}>Prompt ready for DALL-E 3 in your deployed app</div>
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
            <span className={`ar-word${isHL?" hl":""}`} onClick={()=>onWordClick&&onWordClick(clean,text)} title="Tap to look up">{w}</span>{" "}
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
    (async()=>{
      try {
        const raw=await callClaudeWithTashkeel(
          `Arabic language expert. Learner clicked word: "${word}" in: "${context}"
Return ONLY valid JSON no markdown. Include full tashkeel on all Arabic text:
{"word":"${word}","root":"3-letter Arabic root with tashkeel like كَتَبَ or empty","rootMeaning":"short root meaning or empty","meaning":"English meaning","partOfSpeech":"noun/verb/adjective/etc","note":"one short helpful tip or empty"}`,
          500,"wordLookup",trackUsage
        );
        setData(JSON.parse(raw.replace(/```json|```/g,"").trim()));
      } catch {
        setData({word,root:"",rootMeaning:"",meaning:"Arabic word",partOfSpeech:"",note:""});
      } finally { setLoading(false); }
    })();
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
          <div style={{display:"flex",alignItems:"center",gap:8,padding:"12px 0",color:"var(--text2)",fontSize:13}}><RefreshCw size={14} className="spin"/> Looking up…</div>
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
function UsageMeter({usage}) {
  const [open,setOpen]=useState(false);
  const totalInputTok  = Object.values(usage.byTag).reduce((s,v)=>s+v.inputTokens,0);
  const totalOutputTok = Object.values(usage.byTag).reduce((s,v)=>s+v.outputTokens,0);
  const totalCost = totalInputTok*3/1_000_000 + totalOutputTok*15/1_000_000;
  const totalCalls = Object.values(usage.byTag).reduce((s,v)=>s+v.calls,0);

  const barColor = totalCost<0.10?"var(--know)":totalCost<0.50?"#C07000":"var(--weak)";

  return (
    <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",overflow:"hidden"}}>
      <div style={{padding:"14px 16px",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}} onClick={()=>setOpen(v=>!v)}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <DollarSign size={15} color={barColor}/>
          <div>
            <div className="sec" style={{margin:0,color:barColor}}>AI Credit Usage</div>
            <div style={{fontSize:14,fontWeight:700,color:"var(--text)",marginTop:1}}>
              ~${totalCost.toFixed(4)}
              <span style={{fontSize:11,fontWeight:400,color:"var(--text3)",marginLeft:6}}>{totalCalls} calls · {(totalInputTok+totalOutputTok).toLocaleString()} tokens</span>
            </div>
          </div>
        </div>
        {open?<ChevronUp size={15} color="var(--text3)"/>:<ChevronDown size={15} color="var(--text3)"/>}
      </div>

      {open&&(
        <div style={{borderTop:"1px solid var(--border)",padding:"12px 16px",display:"flex",flexDirection:"column",gap:8}}>
          <div style={{fontSize:11,fontWeight:700,color:"var(--text3)",letterSpacing:".1em",textTransform:"uppercase",marginBottom:4,display:"grid",gridTemplateColumns:"1fr 60px 60px 70px",gap:4}}>
            <span>Feature</span><span style={{textAlign:"right"}}>Calls</span><span style={{textAlign:"right"}}>Tokens</span><span style={{textAlign:"right"}}>Cost</span>
          </div>
          {Object.entries(usage.byTag).filter(([,v])=>v.calls>0).map(([tag,v])=>{
            const cost = v.inputTokens*3/1_000_000 + v.outputTokens*15/1_000_000;
            return (
              <div key={tag} style={{display:"grid",gridTemplateColumns:"1fr 60px 60px 70px",gap:4,fontSize:12.5,color:"var(--text2)",alignItems:"center"}}>
                <span style={{color:"var(--text)"}}>{USAGE_LABELS[tag]||tag}</span>
                <span style={{textAlign:"right",color:"var(--text3)"}}>{v.calls}</span>
                <span style={{textAlign:"right",color:"var(--text3)"}}>{(v.inputTokens+v.outputTokens).toLocaleString()}</span>
                <span style={{textAlign:"right",fontWeight:600,color:"var(--accent)"}}>${cost.toFixed(4)}</span>
              </div>
            );
          })}
          <div className="divider" style={{margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:700}}>
            <span>Total (est.)</span>
            <span style={{color:barColor}}>${totalCost.toFixed(4)}</span>
          </div>
          <div style={{fontSize:11,color:"var(--text3)",lineHeight:1.6}}>
            Estimated from token counts. Actual cost depends on selected model — check openrouter.ai/models for per-model pricing. Resets on page refresh.
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HOME
// ─────────────────────────────────────────────────────────────
function HomeScreen({decks,cardStates,onOpenDeck,onSettings,onCreateDeck,onReading,onListening,onConversation,onSearch,onProgress,onMasterReview,darkMode,onToggleDark,studyLog}) {
  const sorted=[...decks].sort((a,b)=>b.createdAt-a.createdAt);
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

  // Dashboard stats
  const allCards=Object.values(cardStates).flat();
  const totalCards=allCards.length;
  const knownCount=allCards.filter(c=>c.status==="known").length;
  const weakCount=allCards.filter(c=>c.status==="weak").length;
  const newCount=allCards.filter(c=>c.status==="new"||!c.status).length;
  const totalInstances=countWordInstances(cardStates);
  const dueCount=getDueCount(allCards);

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
          <button className="btn btn-ghost" onClick={onToggleDark} style={{width:36,height:36}} title={darkMode?"Light mode":"Dark mode"}>{darkMode?<Sun size={16}/>:<Moon size={16}/>}</button>
          <button className="btn btn-ghost" onClick={onSettings} style={{width:36,height:36}}><Settings size={17}/></button>
        </div>
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
        <div className="sec">Flashcard Decks</div>
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          <button className="btn btn-primary" onClick={onCreateDeck} style={{flex:1,padding:"13px",borderRadius:"var(--r)",fontSize:14}}>
            <Plus size={15}/> Create New Deck
          </button>
          <button className="btn" onClick={()=>importRef.current?.click()} style={{padding:"13px 16px",borderRadius:"var(--r)",fontSize:14,background:"var(--surface)",border:"1.5px solid var(--border)",color:"var(--text2)",fontWeight:600}}>
            <Upload size={14}/>
          </button>
          <input ref={importRef} type="file" accept=".json" onChange={handleImport} style={{display:"none"}}/>
        </div>
        {sorted.length===0&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:14,padding:"36px 0"}}><Layers size={28} style={{opacity:.3,marginBottom:8}}/><br/>No decks yet.</div>}
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {sorted.map(deck=>{
            const dc=cardStates[deck.id]||[];
            const weak=dc.filter(c=>c.status==="weak").length;
            const known=dc.filter(c=>c.status==="known").length;
            const pct=dc.length>0?Math.round((known/dc.length)*100):0;
            return (
              <button key={deck.id} className="btn" onClick={()=>onOpenDeck(deck)}
                style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px",textAlign:"left",width:"100%",flexDirection:"column",alignItems:"stretch",gap:8}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontWeight:600,fontSize:15,color:"var(--text)"}}>{deck.title}</span>
                  <ChevronRight size={15} color="var(--text3)"/>
                </div>
                <div style={{display:"flex",gap:7,alignItems:"center"}}>
                  <span style={{fontSize:12.5,color:"var(--text3)"}}>{dc.length} cards</span>
                  {weak>0&&<span className="tag tag-weak">{weak} weak</span>}
                  {known>0&&<span className="tag tag-know">{known} known</span>}
                </div>
                <div className="progress-track"><div className="progress-fill" style={{width:`${pct}%`,background:"var(--know)"}}/></div>
              </button>
            );
          })}
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
function SettingsScreen({settings,setSettings,onBack,usage,user,onSignOut,onReplayOnboarding,studyLog,onUpdateTargets}) {
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

        <UsageMeter usage={usage}/>

        {/* Model toggle — the main thing to configure */}
        <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"15px 17px"}}>
          <div className="sec">AI Model · via OpenRouter</div>
          <select className="input" value={local.model} onChange={e=>set("model",e.target.value)} style={{marginBottom:8}}>
            {OR_MODELS.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div style={{fontSize:11.5,color:"var(--text3)",lineHeight:1.65}}>
            All text generation (flashcards, sentences, reading, listening, word lookups) uses this model. Switch anytime — takes effect immediately after saving. Compare models and pricing at <strong>openrouter.ai/models</strong>.
          </div>
        </div>

        {/* API keys */}
        <div style={{background:"var(--info-bg)",border:"1.5px solid var(--info-border)",borderRadius:"var(--r)",padding:"14px 16px"}}>
          <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:10}}><Info size={14} color="var(--info)"/><div className="sec" style={{margin:0,color:"var(--info)"}}>API Keys</div></div>
          <div style={{fontSize:13,color:"var(--text2)",lineHeight:1.7,marginBottom:12}}>
            Your API keys are stored securely in your account. Each user needs their own keys.
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                <span style={{fontSize:14}}>🔑</span>
                <div style={{fontSize:12.5,fontWeight:700,color:"var(--text)",fontFamily:"monospace"}}>OpenRouter API Key</div>
              </div>
              <input
                className="input"
                type="password"
                placeholder="sk-or-… (from openrouter.ai/keys)"
                value={local.orKey||""}
                onChange={e=>set("orKey",e.target.value)}
                style={{fontSize:12,padding:"7px 10px",fontFamily:"monospace"}}
              />
              <div style={{fontSize:11,color:"var(--text3)",marginTop:3}}>Required for all AI text generation (flashcards, sentences, reading, listening).</div>
            </div>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                <span style={{fontSize:14}}>🖼</span>
                <div style={{fontSize:12.5,fontWeight:700,color:"var(--text)",fontFamily:"monospace"}}>OpenAI API Key</div>
              </div>
              <input
                className="input"
                type="password"
                placeholder="sk-… (from platform.openai.com/api-keys)"
                value={local.oaKey||""}
                onChange={e=>set("oaKey",e.target.value)}
                style={{fontSize:12,padding:"7px 10px",fontFamily:"monospace"}}
              />
              <div style={{fontSize:11,color:"var(--text3)",marginTop:3}}>Optional — enables DALL-E image generation on flashcards.</div>
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
  return (
    <div className="screen">
      <Hdr title="New Deck" sub="Create" onBack={onBack}/>
      <div style={{padding:"22px 20px 0"}}>
        <label className="lbl">Deck Title</label>
        <input className="input" placeholder="e.g. Common Nouns, Chapter 3 Verbs…" value={title} onChange={e=>setTitle(e.target.value)} autoFocus onKeyDown={e=>e.key==="Enter"&&title.trim()&&onCreate(title.trim())}/>
        <button className="btn btn-primary" onClick={()=>title.trim()&&onCreate(title.trim())} disabled={!title.trim()} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:15,marginTop:18}}>
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
    onSave(preview.map((c,i)=>({...c,id:`c${Date.now()}-${i}`,status:"new",forms:Object.fromEntries(Object.entries(c.forms||{}).filter(([,v])=>v))})));
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
function DeckScreen({deck,cards,onStartStudy,onBack,onAddCards,onEditCard,onDeleteCard,onRenameDeck,onDeleteDeck,savedIdx}) {
  const [deckMenu,setDeckMenu]=useState(false);
  const [renaming,setRenaming]=useState(false);
  const [newTitle,setNewTitle]=useState(deck.title);
  const [confirmDelete,setConfirmDelete]=useState(false);
  const [search,setSearch]=useState("");
  const [statusFilter,setStatusFilter]=useState("all"); // all, new, weak, known, due

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
            <button className="btn btn-ghost" onClick={()=>setDeckMenu(true)} style={{width:34,height:34}}><MoreVertical size={15}/></button>
          </div>
        }/>

      <div style={{padding:"18px 20px 0"}}>
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
        {cards.length>0&&(
          <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
            <button className="btn btn-primary" onClick={()=>onStartStudy("all",true)} style={{width:"100%",padding:"13px",borderRadius:"var(--r)",fontSize:14}}>
              <BookOpen size={16}/> Study All ({cards.length})
            </button>
            {weak>0&&<button className="btn" onClick={()=>onStartStudy("weak")} style={{width:"100%",padding:"12px",borderRadius:"var(--r)",fontSize:14,fontWeight:600,background:"var(--weak-bg)",color:"var(--weak)",border:"1.5px solid var(--weak-border)"}}>
              <RotateCcw size={15}/> Practice Weak ({weak})
            </button>}
          </div>
        )}
        {cards.length>0&&(
          <div style={{marginBottom:12}}>
            <div style={{position:"relative",marginBottom:10}}>
              <svg style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",opacity:.4}} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              <input className="search-input" placeholder="Search cards…" value={search} onChange={e=>setSearch(e.target.value)}/>
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
                <div style={{display:"flex",flexWrap:"wrap",gap:4}}>
                  {c.forms.harf&&(
                    <span style={{fontSize:11.5,background:"var(--harf-bg)",color:"var(--harf)",padding:"2px 8px",borderRadius:100,border:"1px solid var(--harf-border)",display:"inline-flex",alignItems:"center",gap:3}}>
                      حرف: <span className="ar" style={{fontSize:13}}>{c.forms.harf}</span>
                    </span>
                  )}
                  {Object.entries(c.forms).filter(([k,v])=>v&&k!=="harf").map(([k,v])=>(
                    <span key={k} style={{fontSize:11,color:"var(--text3)",background:"var(--surface2)",padding:"2px 7px",borderRadius:100}}>
                      {FORM_LABELS[k]}: <span className="ar" style={{fontSize:12}}>{v}</span>
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
        <div className="overlay" onClick={e=>{if(e.target===e.currentTarget){setDeckMenu(false);setRenaming(false);setConfirmDelete(false);}}}>
          <div className="drawer">
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div style={{fontFamily:"Lora,serif",fontSize:17,fontWeight:600}}>Deck Options</div>
              <button className="btn btn-ghost" onClick={()=>{setDeckMenu(false);setRenaming(false);setConfirmDelete(false);}} style={{width:30,height:30}}><X size={13}/></button>
            </div>

            {!renaming&&!confirmDelete&&(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <button className="btn" onClick={()=>setRenaming(true)}
                  style={{background:"var(--surface2)",color:"var(--text)",padding:"13px 16px",borderRadius:"var(--rs)",justifyContent:"flex-start",gap:12,fontSize:14}}>
                  <Pencil size={15} color="var(--text2)"/> Rename Deck
                </button>
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
function StudyScreen({cards,currentIndex,onSwipe,onBack,onExit,trackUsage,decks,cardStates,onAddToFlashcard,activeFormOverride}) {
  const [flipped,setFlipped]=useState(false);
  const [selForm,setSelForm]=useState(null);
  const [gen,setGen]=useState(null);
  const [genLoading,setGenLoading]=useState(false);
  const [imgLoading,setImgLoading]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const genRef=useRef(0); // prevent duplicate/stale generation
  const card=cards[currentIndex];
  const availForms=Object.entries(card.forms).filter(([,v])=>v);

  useEffect(()=>{
    genRef.current++;
    // Default to weak form if card has weakForms tracked
    const weakForms=card.weakForms||[];
    const defaultForm=weakForms.find(f=>availForms.some(([k])=>k===f))||availForms[0]?.[0]||null;
    setFlipped(false);setSelForm(defaultForm);setGen(null);setGenLoading(false);setImgLoading(false);
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    setPlaying(false);
  },[currentIndex]);

  const generate=async(prevSentence=null)=>{
    if(!selForm||genLoading) return;
    const id=++genRef.current;
    const arabicForm=card.forms[selForm];
    const formLabel=FORM_LABELS[selForm]||selForm;
    setGenLoading(true);setGen(null);
    try {
      const avoidClause=prevSentence?`\nDo NOT reuse or closely resemble this previous sentence: "${prevSentence}"`:"";
      const raw=await callClaudeWithTashkeel(
        `Arabic teacher creating flashcard learning aid.
Word: "${card.english}" · Arabic form "${arabicForm}" (${formLabel})
Generate: 1) Short natural Arabic sentence (6-10w) using EXACTLY: ${arabicForm}  2) English translation  3) Vivid DALL-E scene (2-3 sentences, real everyday Arabic life, no Arabic text in scene)${avoidClause}

CRITICAL: Every single Arabic word MUST have full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين) — no bare letters. Example: ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ not ذهب الطالب إلى المدرسة.
Return ONLY valid JSON: {"sentence":"...","translation":"...","imagePrompt":"..."}`,
        600,"sentence",trackUsage
      );
      if(id!==genRef.current) return;
      const parsed=extractJSON(raw);
      setGen({...parsed,imageUrl:null});
      setGenLoading(false);
      // Generate real DALL-E image in background
      setImgLoading(true);
      const url=await generateDalleImage(parsed.imagePrompt);
      if(id!==genRef.current) return;
      setGen(prev=>prev?{...prev,imageUrl:url}:prev);
      setImgLoading(false);
    } catch {
      if(id!==genRef.current) return;
      setGen({sentence:arabicForm,translation:card.english,imagePrompt:`A warm everyday scene representing "${card.english}" in Arabic-speaking daily life, natural lighting.`,imageUrl:null});
      setGenLoading(false);setImgLoading(false);
    }
  };

  // Keyboard shortcuts for study
  useEffect(()=>{
    const handler=(e)=>{
      if(e.target.tagName==="INPUT"||e.target.tagName==="TEXTAREA") return;
      if(e.key===" "||e.key==="Enter"){e.preventDefault();if(!flipped) setFlipped(true);}
      if(flipped&&e.key==="ArrowLeft"){e.preventDefault();onSwipe("left",card.id,selForm);}
      if(flipped&&e.key==="ArrowRight"){e.preventDefault();onSwipe("right",card.id,selForm);}
      if(e.key==="ArrowUp"&&currentIndex>0){e.preventDefault();onBack();}
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[flipped,card?.id,currentIndex,selForm]);

  // Stop audio on unmount or screen change
  useEffect(()=>()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();},[]);

  const playAudio=()=>{
    if(!gen?.sentence||!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    if(playing){setPlaying(false);return;}
    setTimeout(()=>{
      const utt=new SpeechSynthesisUtterance(gen.sentence);
      utt.lang="ar-SA";utt.rate=0.82;
      const v=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith("ar"));if(v) utt.voice=v;
      utt.onend=()=>setPlaying(false);utt.onerror=()=>setPlaying(false);
      setPlaying(true);
      window.speechSynthesis.speak(utt);
    },50);
  };

  return (
    <div className="screen" style={{display:"flex",flexDirection:"column",padding:"18px 18px 20px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <button className="btn btn-ghost" onClick={onExit} style={{width:32,height:32}}><X size={14}/></button>
        <span style={{fontSize:13,color:"var(--text2)",fontWeight:600}}>{currentIndex+1} <span style={{color:"var(--text3)",fontWeight:400}}>/ {cards.length}</span></span>
        <button className="btn btn-ghost" onClick={onBack} disabled={currentIndex===0} style={{width:32,height:32,opacity:currentIndex===0?0.3:1}}><ArrowLeft size={14}/></button>
      </div>
      <div className="progress-track" style={{marginBottom:16}}><div className="progress-fill" style={{width:`${((currentIndex+1)/cards.length)*100}%`,background:"var(--accent)"}}/></div>

      <div style={{flex:1,display:"flex",flexDirection:"column",gap:13,overflowY:"auto"}}>
        {!flipped&&(
          <div key={`f${currentIndex}`} className="card-appear" onClick={()=>setFlipped(true)}
            style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"44px 24px",cursor:"pointer",textAlign:"center",boxShadow:"0 5px 24px rgba(0,0,0,0.08)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:188}}>
            <div className="sec" style={{margin:0,marginBottom:16}}>English</div>
            <div style={{fontFamily:"Lora,serif",fontSize:38,fontWeight:600,lineHeight:1.2}}>{card.english}</div>
            <div style={{fontSize:12,color:"var(--text3)",marginTop:20,fontWeight:500}}>Tap to reveal Arabic ↓</div>
          </div>
        )}
        {flipped&&(
          <div key={`b${currentIndex}`} className="card-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"18px 17px",boxShadow:"0 5px 24px rgba(0,0,0,0.08)"}}>
            <div style={{textAlign:"center",paddingBottom:14,borderBottom:"1px solid var(--border)",marginBottom:14}}>
              <div className="sec" style={{margin:0,marginBottom:5}}>Arabic · <span style={{textTransform:"capitalize"}}>{card.wordType}</span></div>
              <div className="ar" style={{fontSize:42,color:"var(--text)"}}>{card.arabicBase}</div>
              <div style={{fontSize:13,color:"var(--text3)"}}>{card.english}</div>
              {card.srsStreak>0&&(
                <div style={{display:"inline-flex",alignItems:"center",gap:4,marginTop:5,fontSize:11,color:"var(--know)"}}>
                  {"🔥".repeat(Math.min(card.srsStreak,5))} {card.srsStreak} streak
                </div>
              )}
              {/* Harf badge */}
              {card.forms.harf&&(
                <div style={{display:"inline-flex",alignItems:"center",gap:5,marginTop:7,background:"var(--harf-bg)",border:"1px solid var(--harf-border)",borderRadius:100,padding:"3px 11px"}}>
                  <span style={{fontSize:11.5,color:"var(--harf)"}}>حرف الجر</span>
                  <span className="ar" style={{fontSize:17,color:"var(--harf)",fontWeight:600}}>{card.forms.harf}</span>
                </div>
              )}
            </div>
            <div className="sec">Select a form</div>
            <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:12}}>
              {availForms
                .filter(([k])=>k!=="harf")
                .sort((a,b)=>{
                  const order=["singular","plural","plural2","masculine","feminine","past","present","imperative","masdar","activePart","passivePart","synonym","synonymPlural","antonym","antonymPlural"];
                  return (order.indexOf(a[0])===-1?99:order.indexOf(a[0]))-(order.indexOf(b[0])===-1?99:order.indexOf(b[0]));
                })
                .map(([key,val])=>(
                <button key={key} className={`chip ${selForm===key?"chip-on":""}`} onClick={()=>{setSelForm(key);setGen(null);}}>
                  {(card.weakForms||[]).includes(key)&&<span style={{color:selForm===key?"rgba(255,200,200,.9)":"var(--weak)",fontSize:10}}>●</span>}
                  {FORM_LABELS[key]}<span className="ar" style={{fontSize:13,color:selForm===key?"rgba(255,255,255,.75)":"var(--text3)"}}>· {val}</span>
                </button>
              ))}
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
                {/* Image — real DALL-E or scene description fallback */}
                {imgLoading?(
                  <div style={{background:"var(--surface2)",border:"1px solid var(--border)",borderRadius:"var(--rs)",padding:"18px 16px",display:"flex",alignItems:"center",gap:9,fontSize:13,color:"var(--text2)"}}>
                    <RefreshCw size={14} className="spin"/> Generating image with DALL-E 3…
                  </div>
                ):gen.imageUrl?(
                  <img src={gen.imageUrl} alt={`Scene for ${card.english}`} style={{width:"100%",display:"block",borderRadius:"var(--rs)",border:"1px solid var(--border)"}}/>
                ):(
                  <SceneCard imagePrompt={gen.imagePrompt} word={card.forms[selForm]||card.arabicBase}/>
                )}
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
            <button className="btn" onClick={()=>onSwipe("left",card.id,selForm)} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--weak-bg)",color:"var(--weak)",border:"1.5px solid var(--weak-border)",fontWeight:600,fontSize:13.5}}>← Needs Practice</button>
            <button className="btn" onClick={()=>onSwipe("right",card.id,selForm)} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--know-bg)",color:"var(--know)",border:"1.5px solid var(--know-border)",fontWeight:600,fontSize:13.5}}>Know It →</button>
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
function MultiDeckCardSelector({decks,cardStates,selDeckIds,setSelDeckIds,selCardIds,setSelCardIds,accentVar,accentBgVar,accentBorderVar,onReset}) {
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
  const screenStart=useRef(Date.now());
  useEffect(()=>{screenStart.current=Date.now();return ()=>{
    const mins=Math.max(1,Math.round((Date.now()-screenStart.current)/60000));
    if(mins>=1&&onLogStudy) onLogStudy({type:"app",module:"reading",minutes:mins});
  };},[]);
  const [showSettings,setShowSettings]=useState(false);
  const [settings,setSettings]=useState({length:"medium",difficulty:"intermediate",showTranslation:false,highlightVocab:true});
  const setSetting=(k,v)=>setSettings(p=>({...p,[k]:v}));

  // Multi-deck selection — all decks selected by default
  const [selDeckIds,setSelDeckIds]=useState(()=>new Set(decks.map(d=>d.id)));
  // Multi-card selection — all cards selected by default
  const allInitCards=decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id));
  const [selCardIds,setSelCardIds]=useState(()=>new Set(allInitCards));

  const [passage,setPassage]=useState(null);
  const [generating,setGenerating]=useState(false);
  const [showTranslation,setShowTranslation]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const [showMiniRating,setShowMiniRating]=useState(false);

  const handleNextPassage=()=>{
    if(passage){setShowMiniRating(true);} else generate();
  };
  const submitMiniRating=(rating)=>{
    if(rating&&onLogStudy) onLogStudy({type:"app",module:"reading",minutes:0,rating,master:!!master});
    setShowMiniRating(false);generate();
  };

  // Derive selected cards from pool
  const now=Date.now();
  const allPooled = decks
    .filter(d=>selDeckIds.has(d.id))
    .flatMap(d=>(cardStates[d.id]||[]))
    .filter(c=>selCardIds.has(c.id));
  const selectedCards = master&&masterPool&&masterPool!=="all"
    ? allPooled.filter(c=>masterPool==="weak"?c.status==="weak":masterPool==="due"?(c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now):true)
    : allPooled;

  const deckNames = decks.filter(d=>selDeckIds.has(d.id)).map(d=>d.title).join(" + ");
  const poolLabel = master?(masterPool==="weak"?"weak":masterPool==="due"?"due":"all"):"";

  const generate=async()=>{
    if(!selectedCards.length){showToast("Select at least one card.","error");return;}
    setGenerating(true);setPassage(null);setShowTranslation(settings.showTranslation);
    const baseLenMap={short:"60-80",medium:"110-140",long:"180-220"};
    // Scale passage length with word count — more words need longer passages
    const MAX_VOCAB=20;
    let vocabCards=selectedCards;
    if(vocabCards.length>MAX_VOCAB){
      // Random subset for very large selections
      vocabCards=[...vocabCards].sort(()=>Math.random()-0.5).slice(0,MAX_VOCAB);
    }
    const scaleFactor=Math.max(1,vocabCards.length/10);
    const scaleLen=(range)=>{const[lo,hi]=range.split("-").map(Number);return `${Math.round(lo*scaleFactor)}-${Math.round(hi*scaleFactor)}`;};
    const targetLen=scaleLen(baseLenMap[settings.length]||"110-140");
    const maxTok=Math.min(4000,Math.max(1500,vocabCards.length*100));
    try {
      const raw=await callClaudeWithTashkeel(
        `Expert Arabic language teacher creating reading practice.
Deck: ${deckNames}
Arabic vocabulary (MUST use every word): ${vocabCards.map(c=>c.arabicBase).join("، ")}

Write a ${settings.difficulty}-level Arabic reading passage of exactly ~${targetLen} words.
Rules:
- Include every Arabic word from the list above at least once — this is mandatory
- Grammatically correct and coherent
- CRITICAL: Every single Arabic word MUST have full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين) — no bare letters. Example: ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ not ذهب الطالب إلى المدرسة.

Return ONLY valid JSON: {"arabic":"...","translation":"...","vocabUsed":["base form of each vocab word that appears"]}`,
        maxTok,"reading",trackUsage
      );
      setPassage(extractJSON(raw));
    } catch {
      setPassage({arabic:"حَدَثَ خَطَأٌ. يُرْجَى الْمُحَاوَلَةُ مَرَّةً أُخْرَى.",translation:"A generation error occurred.",vocabUsed:[]});
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
          onReset={()=>setPassage(null)}
        />}
        {master&&<div style={{background:"var(--read-bg)",border:"1px solid var(--read-border)",borderRadius:"var(--rs)",padding:"10px 14px",fontSize:13,color:"var(--read)",fontWeight:500}}>Using {selectedCards.length} {poolLabel} vocabulary words · Master session</div>}

        <button className="btn btn-read" onClick={generate} disabled={generating||!selectedCards.length} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
          {generating
            ?<><RefreshCw size={14} className="spin"/>Generating passage…</>
            :<><FileText size={15}/>Generate from {selectedCards.length} Card{selectedCards.length!==1?"s":""} · {selDeckIds.size} Deck{selDeckIds.size!==1?"s":""}</>}
        </button>

        {passage&&!generating&&(
          <div className="gen-appear" style={{display:"flex",flexDirection:"column",gap:12}}>
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
  const screenStart=useRef(Date.now());
  useEffect(()=>{screenStart.current=Date.now();return ()=>{
    const mins=Math.max(1,Math.round((Date.now()-screenStart.current)/60000));
    if(mins>=1&&onLogStudy) onLogStudy({type:"app",module:"listening",minutes:mins});
  };},[]);
  const [showSettings,setShowSettings]=useState(false);
  const [settings,setSettings]=useState({length:"medium",difficulty:"intermediate",speed:0.82,showArabicDefault:false,showEnglishDefault:false,highlightVocab:true});
  const setSetting=(k,v)=>setSettings(p=>({...p,[k]:v}));

  // Multi-deck selection — all selected by default
  const [selDeckIds,setSelDeckIds]=useState(()=>new Set(decks.map(d=>d.id)));
  const allInitCards=decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id));
  const [selCardIds,setSelCardIds]=useState(()=>new Set(allInitCards));

  const [content,setContent]=useState(null);
  const [generating,setGenerating]=useState(false);
  const [showArabic,setShowArabic]=useState(false);
  const [showEnglish,setShowEnglish]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const [showMiniRating,setShowMiniRating]=useState(false);

  const handleNextPassage=()=>{
    if(content){setShowMiniRating(true);} else generate();
  };
  const submitMiniRating=(rating)=>{
    if(rating&&onLogStudy) onLogStudy({type:"app",module:"listening",minutes:0,rating,master:!!master});
    setShowMiniRating(false);generate();
  };

  useEffect(()=>()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();},[]);

  const now2=Date.now();
  const allPooled2 = decks.filter(d=>selDeckIds.has(d.id)).flatMap(d=>(cardStates[d.id]||[])).filter(c=>selCardIds.has(c.id));
  const selectedCards = master&&masterPool&&masterPool!=="all"
    ? allPooled2.filter(c=>masterPool==="weak"?c.status==="weak":masterPool==="due"?(c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now2):true)
    : allPooled2;
  const poolLabel2 = master?(masterPool==="weak"?"weak":masterPool==="due"?"due":"all"):"";

  const deckNames = decks.filter(d=>selDeckIds.has(d.id)).map(d=>d.title).join(" + ");

  const generate=async()=>{
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    setPlaying(false);
    if(!selectedCards.length){showToast("Select at least one card.","error");return;}
    setGenerating(true);setContent(null);
    setShowArabic(settings.showArabicDefault);setShowEnglish(settings.showEnglishDefault);
    const baseLenMap={short:"50-70",medium:"90-120",long:"160-200"};
    const MAX_VOCAB=20;
    let vocabCards=selectedCards;
    if(vocabCards.length>MAX_VOCAB){
      vocabCards=[...vocabCards].sort(()=>Math.random()-0.5).slice(0,MAX_VOCAB);
    }
    const scaleFactor=Math.max(1,vocabCards.length/10);
    const scaleLen=(range)=>{const[lo,hi]=range.split("-").map(Number);return `${Math.round(lo*scaleFactor)}-${Math.round(hi*scaleFactor)}`;};
    const targetLen=scaleLen(baseLenMap[settings.length]||"90-120");
    const maxTok=Math.min(4000,Math.max(1200,vocabCards.length*100));
    try {
      const raw=await callClaudeWithTashkeel(
        `Arabic teacher creating listening practice.
Deck: ${deckNames}
Arabic vocabulary (MUST use every word): ${vocabCards.map(c=>c.arabicBase).join("، ")}

Write a ${settings.difficulty}-level spoken Arabic passage of exactly ~${targetLen} words.
Rules:
- Include every Arabic word from the list above at least once — this is mandatory
- Natural conversational tone suitable for listening
- CRITICAL: Every single Arabic word MUST have full tashkeel (فَتْحَة ضَمَّة كَسْرَة سُكُون شَدَّة تَنْوِين) — no bare letters. Example: ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ not ذهب الطالب إلى المدرسة.

Return ONLY valid JSON: {"arabic":"...","translation":"...","vocabUsed":["base form of each vocab word that appears"]}`,
        maxTok,"listening",trackUsage
      );
      setContent(extractJSON(raw));
    } catch {
      setContent({arabic:"حَدَثَ خَطَأٌ. يُرْجَى الْمُحَاوَلَةُ مَرَّةً أُخْرَى.",translation:"A generation error occurred."});
    } finally { setGenerating(false); }
  };

  const doPlay=(rate)=>{
    if(!content?.arabic||!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utt=new SpeechSynthesisUtterance(content.arabic);
    utt.lang="ar-SA";utt.rate=rate||settings.speed;
    const v=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith("ar"));if(v) utt.voice=v;
    utt.onstart=()=>setPlaying(true);utt.onend=()=>setPlaying(false);utt.onerror=()=>setPlaying(false);
    window.speechSynthesis.speak(utt);
  };

  const togglePlay=()=>{
    if(!content?.arabic) return;
    if(playing){window.speechSynthesis.cancel();setPlaying(false);}
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
                <input type="range" min="0.5" max="1.2" step="0.05" value={settings.speed} onChange={e=>setSetting("speed",parseFloat(e.target.value))} style={{width:"100%",accentColor:"var(--listen)"}}/>
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
          onReset={()=>{setContent(null);if(window.speechSynthesis) window.speechSynthesis.cancel();setPlaying(false);}}
        />}
        {master&&<div style={{background:"var(--listen-bg)",border:"1px solid var(--listen-border)",borderRadius:"var(--rs)",padding:"10px 14px",fontSize:13,color:"var(--listen)",fontWeight:500}}>Using {selectedCards.length} {poolLabel2} vocabulary words · Master session</div>}

        <button className="btn btn-listen" onClick={generate} disabled={generating||!selectedCards.length} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
          {generating
            ?<><RefreshCw size={14} className="spin"/>Generating…</>
            :<><Mic size={15}/>{master?"Generate Master Passage":`Generate from ${selectedCards.length} Card${selectedCards.length!==1?"s":""}`}</>}
        </button>

        {content&&!generating&&(
          <div className="gen-appear" style={{display:"flex",flexDirection:"column",gap:12}}>
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
                  <button key={s.v} onClick={()=>{setSetting("speed",s.v);window.speechSynthesis.cancel();setPlaying(false);}}
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
const ONBOARDING_STEPS=[
  {icon:"🗂️",title:"Welcome to Arabic Flashcards",body:"Your all-in-one Arabic learning app. AI-powered flashcards with full tashkeel, spaced repetition, reading, listening, conversation, and progress tracking toward B2."},
  {icon:"📇",title:"How Flashcards Work",body:"Create decks and add English or Arabic words. The AI generates all forms — singular, plural, synonyms, antonyms, verb conjugations, and the common preposition (harf) — all with full diacritics."},
  {icon:"🎯",title:"Master Review",body:"The Master Review button on your home screen is your daily study hub. It works like Anki — due cards first, then weak, then new. Choose 20 to 200 cards per session. You can also launch Master Reading, Listening, and Speaking from here."},
  {icon:"🔁",title:"Spaced Repetition",body:"Known cards come back in 1 day, then 3, then 7, and so on. Weak cards reset to immediate review. Each form (singular, plural, etc.) is tracked separately — if you fail on plural, it shows plural first next time."},
  {icon:"📖",title:"Practice Modules",body:"Reading generates AI passages. Listening creates audio exercises. Conversation lets you chat with AI — all using your vocabulary. Tap any Arabic word to look it up and save it. \"Finish Session\" lets you rate how it went."},
  {icon:"📊",title:"Progress & Performance",body:"Two views: Performance tracks your skill scores (from master sessions only), B2 vocab progress, and insights. Progress tracks study time, daily/weekly targets, and module activity. Log outside study too."},
  {icon:"🚀",title:"Ready to Start!",body:"Create a deck, add words, then hit Master Review. Set your daily target in Settings. The app tracks everything — you focus on learning Arabic."},
];

function Onboarding({onComplete}) {
  const [step,setStep]=useState(0);
  const s=ONBOARDING_STEPS[step];
  return (
    <div className="onboarding-overlay" onClick={e=>{if(e.target===e.currentTarget&&step===ONBOARDING_STEPS.length-1) onComplete();}}>
      <div className="onboarding-card">
        <div style={{fontSize:48,marginBottom:16}}>{s.icon}</div>
        <div style={{fontFamily:"Lora,serif",fontSize:22,fontWeight:600,marginBottom:10}}>{s.title}</div>
        <div style={{fontSize:14,color:"var(--text2)",lineHeight:1.7,marginBottom:8}}>{s.body}</div>
        <div className="onboarding-dots">
          {ONBOARDING_STEPS.map((_,i)=><div key={i} className={`onboarding-dot ${i===step?"active":""}`}/>)}
        </div>
        <div style={{display:"flex",gap:8,marginTop:8}}>
          {step>0&&<button className="btn" onClick={()=>setStep(s=>s-1)} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Back</button>}
          {step<ONBOARDING_STEPS.length-1?(
            <button className="btn btn-primary" onClick={()=>setStep(s=>s+1)} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Next</button>
          ):(
            <button className="btn btn-primary" onClick={onComplete} style={{flex:2,padding:"12px",borderRadius:"var(--rs)",fontSize:14}}>Get Started</button>
          )}
        </div>
        <button onClick={onComplete} style={{background:"none",border:"none",color:"var(--text3)",fontSize:12,cursor:"pointer",marginTop:12}}>Skip onboarding</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CONVERSATION MODULE
// ─────────────────────────────────────────────────────────────
function ConversationScreen({decks,cardStates,onBack,onFinish,trackUsage,onLogStudy,onAddToFlashcard,master,masterPool}) {
  const screenStart=useRef(Date.now());
  useEffect(()=>{screenStart.current=Date.now();return ()=>{
    const mins=Math.max(1,Math.round((Date.now()-screenStart.current)/60000));
    if(mins>=1&&onLogStudy) onLogStudy({type:"app",module:"speaking",minutes:mins});
  };},[]);
  const [selDeckIds,setSelDeckIds]=useState(()=>new Set(decks.map(d=>d.id)));
  const allInitCards=decks.flatMap(d=>(cardStates[d.id]||[]).map(c=>c.id));
  const [selCardIds,setSelCardIds]=useState(()=>new Set(allInitCards));
  const [messages,setMessages]=useState([]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [started,setStarted]=useState(false);
  const [voiceMode,setVoiceMode]=useState(false);
  const [listening,setListening]=useState(false);
  const [speaking,setSpeaking]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const chatRef=useRef(null);
  const recognitionRef=useRef(null);

  // Check browser support for speech recognition
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  const hasSpeechRecog=!!SpeechRecognition;

  const now3=Date.now();
  const allPooled3 = decks.filter(d=>selDeckIds.has(d.id)).flatMap(d=>(cardStates[d.id]||[])).filter(c=>selCardIds.has(c.id));
  const selectedCards = master&&masterPool&&masterPool!=="all"
    ? allPooled3.filter(c=>masterPool==="weak"?c.status==="weak":masterPool==="due"?(c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now3):true)
    : allPooled3;
  const poolLabel3 = master?(masterPool==="weak"?"weak":masterPool==="due"?"due":"all"):"";

  const scrollBottom=()=>setTimeout(()=>chatRef.current?.scrollTo(0,chatRef.current.scrollHeight),50);

  // Text-to-speech: speak Arabic text
  const speakArabic=(text)=>{
    if(!window.speechSynthesis||!text) return;
    // Strip English hint in parentheses for cleaner audio
    const arabicOnly=text.replace(/\n?\n?\(.*?\)\s*$/s,"").trim();
    if(!arabicOnly) return;
    window.speechSynthesis.cancel();
    const utt=new SpeechSynthesisUtterance(arabicOnly);
    utt.lang="ar-SA";utt.rate=0.82;
    const v=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith("ar"));
    if(v) utt.voice=v;
    utt.onstart=()=>setSpeaking(true);
    utt.onend=()=>setSpeaking(false);
    utt.onerror=()=>setSpeaking(false);
    setSpeaking(true);
    window.speechSynthesis.speak(utt);
  };

  // Speech-to-text: listen via mic
  const startListening=()=>{
    if(!SpeechRecognition){showToast("Speech recognition not supported in this browser","error");return;}
    if(listening){
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const recognition=new SpeechRecognition();
    recognitionRef.current=recognition;
    recognition.lang="ar-SA";
    recognition.interimResults=true;
    recognition.continuous=false;
    recognition.maxAlternatives=1;

    recognition.onstart=()=>setListening(true);
    recognition.onresult=(e)=>{
      const transcript=Array.from(e.results).map(r=>r[0].transcript).join("");
      setInput(transcript);
      // If final result, auto-send
      if(e.results[e.results.length-1].isFinal){
        setListening(false);
      }
    };
    recognition.onerror=(e)=>{
      setListening(false);
      if(e.error==="no-speech") showToast("No speech detected — try again","info");
      else if(e.error!=="aborted") showToast(`Mic error: ${e.error}`,"error");
    };
    recognition.onend=()=>setListening(false);
    recognition.start();
  };

  // Cleanup speech on unmount
  useEffect(()=>()=>{
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    recognitionRef.current?.stop();
  },[]);

  const startConversation=async()=>{
    if(!selectedCards.length){showToast("Select at least one card.","error");return;}
    setStarted(true);setLoading(true);setMessages([]);
    const vocabList=selectedCards.slice(0,20).map(c=>`${c.english} (${c.arabicBase})`).join(", ");
    try {
      const raw=await callClaudeWithTashkeel(
        `You are a friendly Arabic conversation partner for a language learner.
Vocabulary to practice: ${vocabList}

Start a simple, natural conversation in Arabic that uses 2-3 of these vocabulary words.
Write 2-3 short sentences as your opening message. Keep it beginner-friendly.
After your Arabic text, add a line break and an English hint in parentheses.

CRITICAL: Every Arabic word MUST have full tashkeel. Example: مَرْحَبًا، كَيْفَ حَالُكَ؟
Return plain text, NOT JSON.`,
        400,"other",trackUsage
      );
      setMessages([{role:"ai",text:raw}]);
      if(voiceMode) speakArabic(raw);
    } catch {
      setMessages([{role:"ai",text:"مَرْحَبًا! كَيْفَ حَالُكَ الْيَوْمَ؟\n\n(Hello! How are you today?)"}]);
    } finally { setLoading(false);scrollBottom(); }
  };

  const sendMessage=async(overrideText)=>{
    const userMsg=(overrideText||input).trim();
    if(!userMsg||loading) return;
    setInput("");
    setMessages(p=>[...p,{role:"user",text:userMsg}]);
    setLoading(true);scrollBottom();

    const vocabList=selectedCards.slice(0,15).map(c=>`${c.english} (${c.arabicBase})`).join(", ");
    const history=messages.slice(-6).map(m=>`${m.role==="ai"?"Assistant":"User"}: ${m.text}`).join("\n");
    try {
      const raw=await callClaudeWithTashkeel(
        `You are a friendly Arabic conversation partner for a language learner.
Vocabulary to incorporate: ${vocabList}

Conversation so far:
${history}
User: ${userMsg}

Reply naturally in Arabic (2-3 short sentences). Try to use vocabulary from the list above.
If the user makes a mistake, gently correct it. Add an English hint in parentheses at the end.
CRITICAL: Every Arabic word MUST have full tashkeel.
Return plain text, NOT JSON.`,
        400,"other",trackUsage
      );
      setMessages(p=>[...p,{role:"ai",text:raw}]);
      if(voiceMode) speakArabic(raw);
    } catch {
      setMessages(p=>[...p,{role:"ai",text:"عُذْرًا، حَدَثَ خَطَأٌ. حَاوِلْ مَرَّةً أُخْرَى.\n\n(Sorry, an error occurred. Try again.)"}]);
    } finally { setLoading(false);scrollBottom(); }
  };

  // Tap-to-speak on any AI bubble in voice mode
  const handleBubbleTap=(msg)=>{
    if(msg.role==="ai"&&!speaking) speakArabic(msg.text);
    else if(speaking) {window.speechSynthesis.cancel();setSpeaking(false);}
  };

  return (
    <div className="screen" style={{display:"flex",flexDirection:"column",paddingBottom:0}}>
      <Hdr title={master?"Master Speaking":"Conversation"} sub="Practice" onBack={()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();recognitionRef.current?.stop();onBack();}}
        right={started&&(
          <div style={{display:"flex",gap:6}}>
            <button className={`btn btn-sm ${voiceMode?"btn-primary":""}`} onClick={()=>{setVoiceMode(v=>!v);if(window.speechSynthesis) window.speechSynthesis.cancel();setSpeaking(false);}}
              style={voiceMode?{}:{background:"var(--surface2)",color:"var(--text2)"}}>
              {voiceMode?<><Volume2 size={13}/>Voice</>:<><Mic size={13}/>Voice</>}
            </button>
            <button className="btn btn-sm" onClick={()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();recognitionRef.current?.stop();onFinish();}}
              style={{background:"var(--know-bg)",color:"var(--know)",border:"1px solid var(--know-border)"}}>
              <CheckCircle2 size={13}/> Finish
            </button>
          </div>
        )}/>
      <div style={{flex:1,display:"flex",flexDirection:"column",padding:"12px 20px 0",overflow:"hidden"}}>
        {!started?(
          <div style={{display:"flex",flexDirection:"column",gap:14,flex:1,overflowY:"auto"}}>
            <div style={{fontSize:13.5,color:"var(--text2)",lineHeight:1.6}}>
              Practice Arabic conversation using vocabulary from your selected decks. The AI will guide the conversation and use your flashcard words.
            </div>
            {/* Voice mode toggle before starting */}
            <div style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--rs)",padding:"12px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div>
                <div style={{fontSize:13.5,fontWeight:600,color:"var(--text)"}}>Voice Mode</div>
                <div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>
                  {hasSpeechRecog?"Speak into mic, AI reads back aloud":"Text-to-speech only (mic not supported in this browser)"}
                </div>
              </div>
              <div className={`chk ${voiceMode?"on":""}`} onClick={()=>setVoiceMode(v=>!v)}>{voiceMode&&<Check size={11} color="white"/>}</div>
            </div>
            {!master&&<MultiDeckCardSelector
              decks={decks} cardStates={cardStates}
              selDeckIds={selDeckIds} setSelDeckIds={setSelDeckIds}
              selCardIds={selCardIds} setSelCardIds={setSelCardIds}
              accentVar="--accent" accentBgVar="--accent-bg" accentBorderVar="--accent-border"
              onReset={()=>{}}
            />}
            {master&&<div style={{background:"var(--accent-bg)",border:"1px solid var(--accent-border)",borderRadius:"var(--rs)",padding:"10px 14px",fontSize:13,color:"var(--accent)",fontWeight:500}}>Using {selectedCards.length} {poolLabel3} vocabulary words · Master session</div>}
            <button className="btn btn-primary" onClick={startConversation} disabled={loading||!selectedCards.length}
              style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
              {loading?<><RefreshCw size={14} className="spin"/>Starting…</>:<><MessageCircle size={15}/>{master?"Start Master Conversation":`Start Conversation with ${selectedCards.length} words`}</>}
            </button>
          </div>
        ):(
          <>
            <div ref={chatRef} style={{flex:1,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,paddingBottom:12}}>
              {messages.map((m,i)=>(
                <div key={i} className={`chat-bubble chat-${m.role==="ai"?"ai":"user"}`}
                  style={m.role==="ai"&&voiceMode?{cursor:"pointer"}:{}}>
                  {m.role==="ai"?(
                    <div onClick={voiceMode?()=>handleBubbleTap(m):undefined}>
                      <ClickableArabic text={m.text} onWordClick={(word,ctx)=>setWordPopup({word,context:ctx})} fontSize={18}/>
                      <div style={{fontSize:11,color:"var(--text3)",marginTop:4}}>💡 Tap any word to look it up{voiceMode&&(speaking?" · 🔊 Speaking…":" · 🔈 Tap to hear")}</div>
                    </div>
                  ):<div>{m.text}</div>}
                </div>
              ))}
              {loading&&<div style={{alignSelf:"flex-start",padding:"8px 12px",color:"var(--text3)",fontSize:13}}><RefreshCw size={13} className="spin" style={{marginRight:6}}/>Thinking…</div>}
            </div>
            <div style={{padding:"10px 0 16px",display:"flex",gap:8,borderTop:"1px solid var(--border)",alignItems:"center"}}>
              {voiceMode&&hasSpeechRecog?(
                <>
                  {/* Voice mode: big mic button + optional text fallback */}
                  <input className="input" value={input} onChange={e=>setInput(e.target.value)} placeholder={listening?"Listening…":"Tap mic or type…"}
                    onKeyDown={e=>e.key==="Enter"&&input.trim()&&sendMessage()} style={{flex:1,fontSize:15,padding:"12px 14px"}}
                    dir={/[\u0600-\u06FF]/.test(input)?"rtl":"ltr"}/>
                  <button className="btn" onClick={startListening}
                    style={{width:48,height:48,borderRadius:"50%",flexShrink:0,
                      background:listening?"var(--weak)":"var(--accent)",color:"white",
                      border:"none",display:"flex",alignItems:"center",justifyContent:"center",
                      boxShadow:listening?"0 0 0 4px var(--weak-bg)":"none",
                      animation:listening?"pulse 1.5s infinite":"none"}}>
                    <Mic size={20}/>
                  </button>
                  {input.trim()&&(
                    <button className="btn btn-primary" onClick={()=>sendMessage()} disabled={loading} style={{padding:"12px 16px",borderRadius:"var(--rs)"}}>
                      <Send size={16}/>
                    </button>
                  )}
                </>
              ):(
                <>
                  <input className="input" value={input} onChange={e=>setInput(e.target.value)} placeholder="Type in Arabic or English…"
                    onKeyDown={e=>e.key==="Enter"&&sendMessage()} style={{flex:1,fontSize:15,padding:"12px 14px"}}
                    dir={/[\u0600-\u06FF]/.test(input)?"rtl":"ltr"}/>
                  <button className="btn btn-primary" onClick={()=>sendMessage()} disabled={loading||!input.trim()} style={{padding:"12px 16px",borderRadius:"var(--rs)"}}>
                    <Send size={16}/>
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MASTER REVIEW — Anki-style across all decks
// ─────────────────────────────────────────────────────────────
function MasterReviewScreen({decks,cardStates,onBack,onSwipeCard,trackUsage,onAddToFlashcard,studyLog,onLogStudy,onMasterReading,onMasterListening,onMasterSpeaking}) {
  const [started,setStarted]=useState(false);
  const [mode,setMode]=useState("smart"); // smart, due, weak, new, all
  const [limit,setLimit]=useState(50);
  const [masterModulePool,setMasterModulePool]=useState("all");
  const [sessionCards,setSessionCards]=useState([]);
  const [idx,setIdx]=useState(0);
  const [results,setResults]=useState({known:0,weak:0});
  const [flipped,setFlipped]=useState(false);
  const [selForm,setSelForm]=useState(null);
  const [wordPopup,setWordPopup]=useState(null);
  const startRef=useRef(null);

  const allCards=Object.values(cardStates).flat();
  const now=Date.now();
  const dueCards=allCards.filter(c=>c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now);
  const weakCards=allCards.filter(c=>c.status==="weak");
  const newCards=allCards.filter(c=>c.status==="new"||!c.status);
  const knownCards=allCards.filter(c=>c.status==="known");

  const start=(m)=>{
    const startMode=m||mode;
    let pool=[];
    if(startMode==="smart"){
      // Anki-style: due first, then weak, then new
      pool=[...sortByDueDate(dueCards),...weakCards.filter(c=>!dueCards.includes(c)),...newCards];
    } else if(startMode==="due") pool=[...sortByDueDate(dueCards)];
    else if(startMode==="weak") pool=[...weakCards];
    else if(startMode==="new") pool=[...newCards];
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
    startRef.current=Date.now();
  };

  const handleSwipe=(dir)=>{
    const card=sessionCards[idx];
    const ns=dir==="right"?"known":"weak";
    setResults(p=>({...p,[ns]:p[ns]+1}));
    onSwipeCard(card._deckId,card.id,ns,selForm);
    if(idx<sessionCards.length-1){
      setIdx(i=>i+1);setFlipped(false);setSelForm(null);
    } else {
      if(startRef.current){
        const mins=Math.max(1,Math.round((Date.now()-startRef.current)/60000));
        onLogStudy({type:"app",module:"vocab",minutes:mins,subtype:"master-review"});
      }
      setStarted(false);setMode("done");
    }
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
            <button className="btn" onClick={()=>{setMode("smart");}} style={{flex:1,background:"var(--surface2)",color:"var(--text2)",padding:"13px",borderRadius:"var(--rs)",fontWeight:600}}>Review Again</button>
            <button className="btn btn-primary" onClick={onBack} style={{flex:1,padding:"13px",borderRadius:"var(--rs)"}}> Home</button>
          </div>
        </div>
      </div>
    );
  }

  // Active study
  if(started&&card){
    const availForms=Object.entries(card.forms||{}).filter(([,v])=>v);
    if(!selForm&&availForms.length){
      const weakForms=card.weakForms||[];
      const def=weakForms.find(f=>availForms.some(([k])=>k===f))||availForms[0]?.[0]||null;
      setTimeout(()=>setSelForm(def),0);
    }
    return (
      <div className="screen" style={{display:"flex",flexDirection:"column",padding:"18px 18px 20px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <button className="btn btn-ghost" onClick={()=>{setStarted(false);setMode("smart");}} style={{width:32,height:32}}><X size={14}/></button>
          <span style={{fontSize:13,color:"var(--text2)",fontWeight:600}}>{idx+1} / {sessionCards.length}</span>
          <span style={{fontSize:12,color:"var(--text3)"}}><span style={{color:"var(--know)"}}>{results.known}✓</span> <span style={{color:"var(--weak)"}}>{results.weak}✗</span></span>
        </div>
        <div className="progress-track" style={{marginBottom:16}}><div className="progress-fill" style={{width:`${((idx+1)/sessionCards.length)*100}%`,background:"var(--accent)"}}/></div>

        <div style={{flex:1,display:"flex",flexDirection:"column",gap:13,overflowY:"auto"}}>
          {!flipped?(
            <div className="card-appear" onClick={()=>setFlipped(true)}
              style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"44px 24px",cursor:"pointer",textAlign:"center",boxShadow:"0 5px 24px rgba(0,0,0,0.08)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:188}}>
              <div className="sec" style={{margin:0,marginBottom:16}}>English</div>
              <div style={{fontFamily:"Lora,serif",fontSize:36,fontWeight:600,lineHeight:1.2}}>{card.english}</div>
              <div style={{fontSize:12,color:"var(--text3)",marginTop:20}}>Tap to reveal · <span className="kbd">Space</span></div>
            </div>
          ):(
            <div className="card-appear" style={{background:"var(--surface)",border:"1.5px solid var(--border)",borderRadius:"var(--r)",padding:"18px 17px",boxShadow:"0 5px 24px rgba(0,0,0,0.08)"}}>
              <div style={{textAlign:"center",paddingBottom:14,borderBottom:"1px solid var(--border)",marginBottom:14}}>
                <div className="sec" style={{margin:0,marginBottom:5}}>Arabic · <span style={{textTransform:"capitalize"}}>{card.wordType}</span></div>
                <div className="ar" style={{fontSize:40,color:"var(--text)"}}>{card.arabicBase}</div>
                <div style={{fontSize:13,color:"var(--text3)"}}>{card.english}</div>
                {card.srsStreak>0&&<div style={{display:"inline-flex",alignItems:"center",gap:4,marginTop:5,fontSize:11,color:"var(--know)"}}>{"🔥".repeat(Math.min(card.srsStreak,5))} {card.srsStreak} streak</div>}
                {card.forms?.harf&&<div style={{display:"inline-flex",alignItems:"center",gap:5,marginTop:7,background:"var(--harf-bg)",border:"1px solid var(--harf-border)",borderRadius:100,padding:"3px 11px"}}><span className="ar" style={{fontSize:17,color:"var(--harf)",fontWeight:600}}>{card.forms.harf}</span></div>}
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:7,marginBottom:12}}>
                {availForms.filter(([k])=>k!=="harf").map(([key,val])=>(
                  <button key={key} className={`chip ${selForm===key?"chip-on":""}`} onClick={()=>setSelForm(key)}>
                    {(card.weakForms||[]).includes(key)&&<span style={{color:selForm===key?"rgba(255,200,200,.9)":"var(--weak)",fontSize:10}}>●</span>}
                    {FORM_LABELS[key]||key}<span className="ar" style={{fontSize:13,color:selForm===key?"rgba(255,255,255,.75)":"var(--text3)"}}>· {val}</span>
                  </button>
                ))}
              </div>
              {selForm&&card.forms[selForm]&&(
                <div style={{textAlign:"center",background:"var(--accent-bg)",borderRadius:"var(--rxs)",padding:"9px 13px",marginBottom:12}}>
                  <div style={{fontSize:11,color:"var(--text3)",marginBottom:3}}>{FORM_LABELS[selForm]}</div>
                  <div className="ar" style={{fontSize:28,color:"var(--accent)",fontWeight:500}}>{card.forms[selForm]}</div>
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
        <div className="test-option" onClick={()=>{setMode("smart");start("smart");}}>
          <div style={{width:40,height:40,borderRadius:12,background:"var(--accent-bg)",display:"flex",alignItems:"center",justifyContent:"center"}}><Zap size={18} color="var(--accent)"/></div>
          <div style={{flex:1}}>
            <div style={{fontWeight:600,fontSize:14}}>Smart Review</div>
            <div style={{fontSize:12,color:"var(--text3)",marginTop:2}}>Due ({dueCards.length}) → Weak ({weakCards.length}) → New ({newCards.length})</div>
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
          {module==="reading"?"📖":module==="listening"?"🎧":"💬"}
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
                <span style={{color:"var(--know)",fontWeight:600}}>{vocabProgress.known} known</span>
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
            {[20,50,100,999].map(n=>(
              <button key={n} className={`chip ${s.dailyLimit===n?"chip-on":""}`} onClick={()=>set("dailyLimit",n)} style={{flex:1,justifyContent:"center",padding:"8px 0",fontSize:12}}>
                {n>=999?"No limit":n}
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
  const tags=["flashcard","sentence","reading","listening","wordLookup","regen","other"];
  const byTag={};
  tags.forEach(t=>{byTag[t]={calls:0,inputTokens:0,outputTokens:0};});
  return {byTag};
}

export default function App() {
  const [screen,setScreen]=useState("home");
  const [decks,setDecks]=useState(SEED_DECKS);
  const [cardStates,setCardStates]=useState(SEED_CARDS);
  const [activeDeck,setActiveDeck]=useState(null);
  const [activeCard,setActiveCard]=useState(null);
  const [settings,setSettings]=useState({orKey:"",oaKey:"",model:"openai/gpt-4o-mini"});
  const [user,setUser]=useState(undefined); // undefined = loading, null = signed out
  const [dataLoaded,setDataLoaded]=useState(false);
  const [authLoading,setAuthLoading]=useState(false);
  const [authError,setAuthError]=useState("");
  const [sessionCards,setSessionCards]=useState([]);
  const [currentIdx,setCurrentIdx]=useState(0);
  const [usage,setUsage]=useState(initUsage);
  const [studyLog,setStudyLog]=useState(initStudyLog);
  const [showSearch,setShowSearch]=useState(false);
  const [showOnboarding,setShowOnboarding]=useState(false);
  const [sessionRating,setSessionRating]=useState(null);
  const [masterPool,setMasterPool]=useState("all"); // all, weak, due
  const sessionRes=useRef({known:0,weak:0});
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
    const unsub=onAuthStateChanged(auth,u=>{
      if(!mounted) return;
      if(u){
        setUser(u);
        getDoc(doc(db,"users",u.uid)).then(snap=>{
          if(!mounted) return;
          if(snap.exists()){
            const d=snap.data();
            try {
              if(d.decks?.length) {
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
              if(d.usage?.byTag) setUsage(d.usage);
              if(d.studyLog) setStudyLog(sl=>({...initStudyLog(),...d.studyLog}));
            } catch(e){ console.error("Data parse error:",e); }
          }
          setDataLoaded(true);
          // Show onboarding for first-time users
          if(!snap.exists()||!snap.data()?.onboardingDone) setShowOnboarding(true);
        }).catch(e=>{
          console.error("Firestore load error:",e);
          if(mounted) setDataLoaded(true);
        });
      } else {
        setUser(null);
        setDataLoaded(false);
      }
    });
    return ()=>{mounted=false;unsub();};
  },[]);

  // Auto-save to Firestore whenever data changes
  useEffect(()=>{
    if(!user||!dataLoaded) return;
    const t=setTimeout(()=>{
      setDoc(doc(db,"users",user.uid),{decks,cardStates,settings,usage,studyLog},{merge:true}).catch(e=>console.error("Save error:",e));
    },1500);
    return ()=>clearTimeout(t);
  },[decks,cardStates,settings,usage,studyLog,user,dataLoaded]);

  const handleSignIn=async()=>{
    setAuthLoading(true);setAuthError("");
    try {
      await signInWithPopup(auth,googleProvider);
    } catch(e){
      setAuthError(e.message||"Sign-in failed. Please try again.");
    } finally { setAuthLoading(false); }
  };

  const handleSignOut=async()=>{
    await signOut(auth);
    setScreen("home");
  };

  // Handle deck import from HomeScreen
  useEffect(()=>{
    const handler=(e)=>{
      const {deck:d,cards:c}=e.detail;
      setDecks(p=>[d,...p]);
      setCardStates(p=>({...p,[d.id]:c}));
    };
    window.addEventListener("importDeck",handler);
    return ()=>window.removeEventListener("importDeck",handler);
  },[]);

  // Keep module-level refs in sync — picked up automatically by callClaude / generateDalleImage
  useEffect(()=>{ _activeModel = settings.model; _orKey = settings.orKey||""; _oaKey = settings.oaKey||""; },[settings.model,settings.orKey,settings.oaKey]);
  const go=s=>setScreen(s);

  // Usage tracker function passed to all Claude calls
  const trackUsage=useCallback((tag,inputChars,outputChars,inputTokens,outputTokens)=>{
    setUsage(prev=>{
      const t=prev.byTag[tag]||prev.byTag["other"];
      return {
        ...prev,
        byTag:{
          ...prev.byTag,
          [tag]:{calls:t.calls+1,inputTokens:t.inputTokens+(inputTokens||0),outputTokens:t.outputTokens+(outputTokens||0)},
        },
      };
    });
  },[]);

  const openDeck=deck=>{setActiveDeck(deck);go("deck");};
  const createDeck=title=>{
    const id=`d${Date.now()}`;const deck={id,title,createdAt:Date.now()};
    setDecks(p=>[deck,...p]);setCardStates(p=>({...p,[id]:[]}));setActiveDeck(deck);go("addCards");
  };
  const renameDeck=(id,title)=>setDecks(p=>p.map(d=>d.id===id?{...d,title}:d));
  const deleteDeck=(id)=>{
    setDecks(p=>p.filter(d=>d.id!==id));
    setCardStates(p=>{const n={...p};delete n[id];return n;});
    go("home");
  };
  const savedIdx=useRef({});
  const studyStartRef=useRef(null);
  const startStudy=(mode,restart=false)=>{
    const dc=cardStates[activeDeck.id]||[];
    const now=Date.now();
    const toStudy=mode==="weak"?dc.filter(c=>c.status==="weak")
      :mode==="due"?dc.filter(c=>c.srsLastReview&&c.srsNextReview&&c.srsNextReview<=now)
      :sortByDueDate(dc);
    if(!toStudy.length) return;
    studyStartRef.current=Date.now();
    sessionRes.current={known:0,weak:0};setSessionCards(toStudy);
    const key=activeDeck.id+"_"+mode;
    const resumeIdx=(!restart&&savedIdx.current[key])||0;
    setCurrentIdx(Math.min(resumeIdx,toStudy.length-1));
    go("study");
  };
  const handleSwipe=(dir,cardId,activeForm)=>{
    const ns=dir==="right"?"known":"weak";
    sessionRes.current[ns==="known"?"known":"weak"]++;
    setCardStates(p=>({...p,[activeDeck.id]:p[activeDeck.id].map(c=>{
      if(c.id!==cardId) return c;
      const srs=calculateSRS(c,ns);
      // Per-instance weakness tracking
      let weakForms=c.weakForms?[...c.weakForms]:[];
      if(ns==="weak"&&activeForm){
        if(!weakForms.includes(activeForm)) weakForms.push(activeForm);
      } else if(ns==="known"&&activeForm){
        weakForms=weakForms.filter(f=>f!==activeForm);
      }
      return {...c,status:ns,weakForms,...srs};
    })}));
    if(currentIdx<sessionCards.length-1){
      const nextIdx=currentIdx+1;
      setCurrentIdx(nextIdx);
      // Save progress for resume
      if(activeDeck) savedIdx.current[activeDeck.id+"_all"]=nextIdx;
    } else {
      // Reset saved progress on completion, log study time
      if(activeDeck){savedIdx.current[activeDeck.id+"_all"]=0;savedIdx.current[activeDeck.id+"_weak"]=0;}
      if(studyStartRef.current){
        const mins=Math.max(1,Math.round((Date.now()-studyStartRef.current)/60000));
        logStudy({type:"app",module:"vocab",minutes:mins});studyStartRef.current=null;
      }
      go("complete");
    }
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
      if(status==="weak"&&activeForm){if(!weakForms.includes(activeForm)) weakForms.push(activeForm);}
      else if(status==="known"&&activeForm){weakForms=weakForms.filter(f=>f!==activeForm);}
      return {...c,status,weakForms,...srs};
    })}));
  };

  const completeOnboarding=()=>{
    setShowOnboarding(false);
    if(user) setDoc(doc(db,"users",user.uid),{onboardingDone:true},{merge:true}).catch(()=>{});
  };

  const handleSearchSelect=(card,deck)=>{
    setShowSearch(false);
    setActiveDeck(deck);
    setActiveCard(card);
    go("editCard");
  };

  const commonProps={decks,cardStates,trackUsage};

  const screens={
    home:<HomeScreen {...commonProps} onOpenDeck={openDeck} onSettings={()=>go("settings")} onCreateDeck={()=>go("createDeck")} onReading={()=>go("reading")} onListening={()=>go("listening")} onConversation={()=>go("conversation")} onSearch={()=>setShowSearch(true)} onProgress={()=>go("progress")} onMasterReview={()=>go("masterReview")} darkMode={darkMode} onToggleDark={()=>setDarkMode(d=>!d)} studyLog={studyLog}/>,
    settings:<SettingsScreen settings={settings} setSettings={setSettings} onBack={()=>go("home")} usage={usage} user={user} onSignOut={handleSignOut} onReplayOnboarding={()=>setShowOnboarding(true)} studyLog={studyLog} onUpdateTargets={(t)=>setStudyLog(sl=>({...sl,targets:t}))}/>,
    createDeck:<CreateDeckScreen onBack={()=>go("home")} onCreate={createDeck}/>,
    addCards:activeDeck&&<AddCardsScreen deck={activeDeck} onBack={()=>go("deck")} onSave={saveCards} trackUsage={trackUsage}/>,
    deck:activeDeck&&<DeckScreen deck={activeDeck} cards={cardStates[activeDeck.id]||[]} onStartStudy={startStudy} onBack={()=>go("home")} onAddCards={()=>go("addCards")} onEditCard={c=>{setActiveCard(c);go("editCard");}} onDeleteCard={deleteCard} onRenameDeck={renameDeck} onDeleteDeck={deleteDeck} savedIdx={savedIdx.current[activeDeck.id+"_all"]||0}/>,
    editCard:activeCard&&activeDeck&&<EditCardScreen card={activeCard} onBack={()=>go("deck")} onSave={saveEditedCard} trackUsage={trackUsage}/>,
    study:activeDeck&&sessionCards.length>0&&<StudyScreen cards={sessionCards} currentIndex={currentIdx} onSwipe={handleSwipe} onBack={()=>{if(currentIdx>0)setCurrentIdx(i=>i-1);}} onExit={()=>go("deck")} trackUsage={trackUsage} decks={decks} cardStates={cardStates} onAddToFlashcard={addToFlashcard}/>,
    complete:<CompleteScreen known={sessionRes.current.known} weak={sessionRes.current.weak} onBack={()=>go("deck")}/>,
    reading:<ReadingScreen {...commonProps} onBack={()=>go("home")} onFinish={()=>{go("home");setSessionRating({module:"reading"});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    listening:<ListeningScreen {...commonProps} onBack={()=>go("home")} onFinish={()=>{go("home");setSessionRating({module:"listening"});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    masterReading:<ReadingScreen {...commonProps} master={true} masterPool={masterPool} onBack={()=>go("masterReview")} onFinish={()=>{go("home");setSessionRating({module:"reading",master:true});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    masterListening:<ListeningScreen {...commonProps} master={true} masterPool={masterPool} onBack={()=>go("masterReview")} onFinish={()=>{go("home");setSessionRating({module:"listening",master:true});}} onAddToFlashcard={addToFlashcard} onLogStudy={logStudy}/>,
    masterSpeaking:<ConversationScreen {...commonProps} master={true} masterPool={masterPool} onBack={()=>go("masterReview")} onFinish={()=>{go("home");setSessionRating({module:"speaking",master:true});}} onLogStudy={logStudy} onAddToFlashcard={addToFlashcard}/>,
    conversation:<ConversationScreen {...commonProps} onBack={()=>go("home")} onFinish={()=>{go("home");setSessionRating({module:"speaking"});}} onLogStudy={logStudy} onAddToFlashcard={addToFlashcard}/>,
    progress:<ProgressScreen cardStates={cardStates} studyLog={studyLog} onBack={()=>go("home")} onLogManual={(e)=>logStudy(e)}/>,
    masterReview:<MasterReviewScreen decks={decks} cardStates={cardStates} onBack={()=>go("home")} onSwipeCard={handleMasterSwipe} trackUsage={trackUsage} onAddToFlashcard={addToFlashcard} studyLog={studyLog} onLogStudy={logStudy}
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

  return (
    <><style>{CSS}</style>
      <ToastContainer/>
      {showSearch&&<GlobalSearch decks={decks} cardStates={cardStates} onClose={()=>setShowSearch(false)} onSelectCard={handleSearchSelect}/>}
      {showOnboarding&&<Onboarding onComplete={completeOnboarding}/>}
      {sessionRating&&<SessionRating module={sessionRating.module} onSubmit={(r)=>{logStudy({type:"app",module:sessionRating.module,minutes:0,rating:r,master:sessionRating.master||false});setSessionRating(null);}} onSkip={()=>setSessionRating(null)}/>}
      <div className="app">{screens[screen]}</div>
    </>
  );
}
