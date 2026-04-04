import { useState, useRef, useEffect, useCallback } from "react";
import { auth, googleProvider, db } from "./firebase.js";
import { signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";
import {
  Settings, ArrowLeft, ChevronRight, X, Volume2, RotateCcw, BookOpen,
  RefreshCw, Check, Sparkles, Plus, Edit3, Trash2, Layers, Save, Eye,
  EyeOff, Headphones, FileText, Play, Pause, SkipBack, Sliders, Globe,
  PlusCircle, Mic, Info, Image as ImageIcon, MoreVertical, Pencil,
  DollarSign, Zap, ChevronDown, ChevronUp, SquareCheck, Square
} from "lucide-react";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const FORM_LABELS = {
  singular:"Singular", plural:"Plural",
  synonym:"Synonym", synonymPlural:"Synonym Plural",
  antonym:"Antonym", antonymPlural:"Antonym Plural",
  harf:"Common Preposition",
  past:"Past", present:"Present", imperative:"Command",
  masdar:"Masdar", activePart:"Active Part.", passivePart:"Passive Part.",
  masculine:"Masculine", feminine:"Feminine",
};
const FORM_ARABIC = {
  singular:"مفرد", plural:"جمع",
  synonym:"مرادف", synonymPlural:"جمع المرادف",
  antonym:"ضد", antonymPlural:"جمع الضد",
  harf:"حرف الجر",
  past:"ماضي", present:"مضارع", imperative:"أمر",
  masdar:"مصدر", activePart:"فاعل", passivePart:"مفعول",
  masculine:"مذكر", feminine:"مؤنث",
};
const FORMS_BY_TYPE = {
  noun:      ["singular","plural","synonym","synonymPlural","antonym","antonymPlural","harf"],
  verb:      ["past","present","imperative","masdar","activePart","passivePart","harf"],
  adjective: ["masculine","feminine","plural","antonym","antonymPlural","harf"],
  other:     ["singular","plural","synonym","antonym","harf"],
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

// Cost estimate: Claude Sonnet ~$3/MTok input, $15/MTok output
const INPUT_COST_PER_CHAR  = 3  / 1_000_000 / 4;
const OUTPUT_COST_PER_CHAR = 15 / 1_000_000 / 4;

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
html,body,#root{height:100%;background:var(--bg);font-family:'Outfit',sans-serif;color:var(--text);-webkit-font-smoothing:antialiased}
.app{max-width:430px;margin:0 auto;min-height:100vh}
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
.drawer{background:var(--surface);border-radius:20px 20px 0 0;width:100%;max-width:430px;padding:22px 20px 36px;animation:drIn .25s cubic-bezier(.2,0,.2,1)}
@keyframes drIn{from{transform:translateY(40px);opacity:0}to{transform:translateY(0);opacity:1}}
.seg{display:flex;background:var(--surface2);border-radius:var(--rs);padding:3px;gap:2px}
.seg-opt{flex:1;text-align:center;padding:7px 4px;font-size:12px;font-weight:500;border-radius:8px;cursor:pointer;transition:all .15s;color:var(--text2);border:none;background:transparent;font-family:'Outfit',sans-serif}
.seg-opt.on{background:var(--surface);color:var(--text);font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,.1)}
.module-card{border-radius:var(--r);padding:16px 18px;border:1.5px solid;cursor:pointer;transition:all .15s;display:flex;align-items:center;gap:14px;background:var(--surface)}
.module-card:hover{transform:translateX(2px)}
.scene-card{background:linear-gradient(135deg,#1a1a2e,#16213e 50%,#0f3460);border-radius:var(--rs);overflow:hidden;position:relative}
.scene-inner{padding:18px;position:relative;z-index:1}
.scene-stars{position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,.15) 1px,transparent 1px);background-size:20px 20px;opacity:.4}
.usage-dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-left:4px}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
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
  // api/claude.js normalises OpenRouter response → {content:[{type:"text",text}], usage:{input_tokens, output_tokens}}
  const outputText = d.content?.find(b=>b.type==="text")?.text || "";
  if (trackFn) {
    trackFn(tag, prompt.length, outputText.length,
      d.usage?.input_tokens  || Math.ceil(prompt.length/4),
      d.usage?.output_tokens || Math.ceil(outputText.length/4)
    );
  }
  return outputText;
}

// Robust JSON extractor — handles LLM responses that wrap JSON in markdown or extra text
function extractJSON(raw) {
  const clean = raw.replace(/```json|```/g,"").trim();
  try { return JSON.parse(clean); } catch {}
  const obj = clean.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }
  const arr = clean.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch {} }
  throw new Error("JSON extraction failed");
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
// DECK SELECTOR (used in Reading/Listening)
// ─────────────────────────────────────────────────────────────
function DeckSelector({decks,cardStates,selectedDeckId,onChange}) {
  return (
    <div>
      <div className="sec">Study Deck</div>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {decks.map(d=>{
          const count=(cardStates[d.id]||[]).length;
          const on=selectedDeckId===d.id;
          return (
            <button key={d.id} className="btn" onClick={()=>onChange(d.id)}
              style={{background:on?"var(--accent-bg)":"var(--surface)",border:`1.5px solid ${on?"var(--accent)":"var(--border)"}`,borderRadius:"var(--rs)",padding:"11px 14px",textAlign:"left",width:"100%",justifyContent:"space-between"}}>
              <span style={{fontWeight:600,fontSize:14,color:on?"var(--accent)":"var(--text)"}}>{d.title}</span>
              <span style={{fontSize:12,color:"var(--text3)"}}>{count} cards</span>
            </button>
          );
        })}
      </div>
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
        const raw=await callClaude(
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
function HomeScreen({decks,cardStates,onOpenDeck,onSettings,onCreateDeck,onReading,onListening}) {
  const sorted=[...decks].sort((a,b)=>b.createdAt-a.createdAt);
  return (
    <div className="screen">
      <div style={{padding:"26px 20px 0",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div>
          <div className="sec" style={{margin:0,marginBottom:4}}>Arabic Study</div>
          <div style={{fontFamily:"Lora,serif",fontSize:26,fontWeight:600}}>My Decks</div>
          <div className="ar" style={{fontSize:15,color:"var(--text3)",marginTop:4}}>بِسْمِ اللهِ</div>
        </div>
        <button className="btn btn-ghost" onClick={onSettings} style={{width:36,height:36}}><Settings size={17}/></button>
      </div>
      <div style={{padding:"20px 20px 0"}}>
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
        </div>
        <div className="sec">Flashcard Decks</div>
        <button className="btn btn-primary" onClick={onCreateDeck} style={{width:"100%",padding:"13px",borderRadius:"var(--r)",fontSize:14,marginBottom:12}}>
          <Plus size={15}/> Create New Deck
        </button>
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
function SettingsScreen({settings,setSettings,onBack,usage,user,onSignOut}) {
  const [local,setLocal]=useState(settings);
  const [saved,setSaved]=useState(false);
  const set=(k,v)=>setLocal(p=>({...p,[k]:v}));
  const save=()=>{
    setSettings(local);
    localStorage.setItem("arabic_fc_settings",JSON.stringify(local));
    setSaved(true);setTimeout(()=>setSaved(false),2500);
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

        <button className="btn btn-primary" onClick={save} style={{width:"100%",padding:14,borderRadius:"var(--r)",fontSize:15}}>
          {saved?<><Check size={16}/>Saved</>:<><Save size={15}/>Save Settings</>}
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
  const [preview,setPreview]=useState(null);
  const [err,setErr]=useState("");
  const avail=FORMS_BY_TYPE[wordType]||FORMS_BY_TYPE.other;
  const wordList=words.split("\n").map(w=>w.trim()).filter(Boolean);
  const toggleForm=f=>{setSelForms(p=>p.includes(f)?p.filter(x=>x!==f):[...p,f]);setPreview(null);};
  const changeType=t=>{setWordType(t);const defaults=FORMS_BY_TYPE[t]?.slice(0,3)||[];setSelForms([...defaults,"harf"]);setPreview(null);};

  const generate=async()=>{
    if(!wordList.length){setErr("Enter at least one word.");return;}
    if(!selForms.length){setErr("Select at least one form.");return;}
    setErr("");setGenerating(true);setPreview(null);
    const isEn=inputLang==="english";
    const formsDesc=selForms.map(f=>`"${f}" (${FORM_LABELS[f]})`).join(", ");
    try {
      const raw=await callClaude(
        `Expert Arabic linguist creating flashcards.
Input: ${isEn?"English":"Arabic"} | Type: ${wordType} | Words: ${wordList.join(", ")}
Required forms: ${formsDesc}

Notes on special fields:
- "harf": the single most common Arabic preposition/particle used with this word (e.g. فِي / إِلَى / مَعَ / عَنْ / مِنْ)
- "synonymPlural": plural of the synonym if provided
- "antonymPlural": plural of the antonym if provided

Return ONLY valid JSON array, no markdown:
[{"english":"...","arabicBase":"Arabic with diacritics","wordType":"${wordType}","forms":{${selForms.map(f=>`"${f}":"Arabic with diacritics or empty string"`).join(",")}}}]

Rules: full tashkeel on all Arabic; exactly ${wordList.length} objects in same order; "" for inapplicable forms.`,
        2500,"flashcard",trackUsage
      );
      setPreview(JSON.parse(raw.replace(/```json|```/g,"").trim()));
    } catch { setErr("Generation failed — try again."); }
    finally { setGenerating(false); }
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
          {generating?<><RefreshCw size={14} className="spin"/>Generating {wordList.length} card{wordList.length!==1?"s":""}…</>:<><Sparkles size={14}/>Generate {wordList.length||""} Card{wordList.length!==1?"s":""}</>}
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
function DeckScreen({deck,cards,onStartStudy,onBack,onAddCards,onEditCard,onDeleteCard,onRenameDeck,onDeleteDeck}) {
  const [deckMenu,setDeckMenu]=useState(false);
  const [renaming,setRenaming]=useState(false);
  const [newTitle,setNewTitle]=useState(deck.title);
  const [confirmDelete,setConfirmDelete]=useState(false);

  const weak=cards.filter(c=>c.status==="weak").length;
  const known=cards.filter(c=>c.status==="known").length;
  const pct=cards.length>0?Math.round((known/cards.length)*100):0;

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
            <button className="btn btn-primary" onClick={()=>onStartStudy("all")} style={{width:"100%",padding:"13px",borderRadius:"var(--r)",fontSize:14}}>
              <BookOpen size={16}/> Study All ({cards.length})
            </button>
            {weak>0&&<button className="btn" onClick={()=>onStartStudy("weak")} style={{width:"100%",padding:"12px",borderRadius:"var(--r)",fontSize:14,fontWeight:600,background:"var(--weak-bg)",color:"var(--weak)",border:"1.5px solid var(--weak-border)"}}>
              <RotateCcw size={15}/> Practice Weak ({weak})
            </button>}
          </div>
        )}
        <div className="sec">{cards.length>0?`All Cards (${cards.length})`:"No cards yet"}</div>
        {cards.length===0&&<div style={{textAlign:"center",padding:"36px 0",color:"var(--text3)",fontSize:14}}><Layers size={28} style={{opacity:.3,marginBottom:8}}/><br/>Tap "Add Cards" to generate flashcards</div>}
        <div style={{display:"flex",flexDirection:"column",gap:9}}>
          {cards.map(c=>(
            <div key={c.id} className="card-row">
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3}}>
                  <span style={{fontWeight:600,fontSize:14}}>{c.english}</span>
                  <span className={`tag tag-${c.status}`}>{c.status}</span>
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
      const raw=await callClaude(
        `Arabic linguist. This is a ${local.wordType}: "${local.english}" / "${local.arabicBase}"
Generate all relevant Arabic forms. Return ONLY valid JSON object (just the forms, no wrapper):
{${forms.map(f=>`"${f}":"Arabic with diacritics or empty string"`).join(",")}}

For "harf": the single most common Arabic preposition used with this ${local.wordType}.
Include full tashkeel on all Arabic.`,
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
function StudyScreen({cards,currentIndex,onSwipe,onExit,trackUsage,decks,cardStates,onAddToFlashcard}) {
  const [flipped,setFlipped]=useState(false);
  const [selForm,setSelForm]=useState(null);
  const [gen,setGen]=useState(null);
  const [genLoading,setGenLoading]=useState(false);
  const [imgLoading,setImgLoading]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [wordPopup,setWordPopup]=useState(null);
  const card=cards[currentIndex];
  const availForms=Object.entries(card.forms).filter(([,v])=>v);

  useEffect(()=>{
    setFlipped(false);setSelForm(availForms[0]?.[0]??null);setGen(null);setGenLoading(false);setImgLoading(false);
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    setPlaying(false);
  },[currentIndex]);

  const generate=async(prevSentence=null)=>{
    if(!selForm) return;
    const arabicForm=card.forms[selForm];
    const formLabel=FORM_LABELS[selForm]||selForm;
    setGenLoading(true);setGen(null);
    try {
      const avoidClause=prevSentence?`\nDo NOT reuse or closely resemble this previous sentence: "${prevSentence}"`:"";
      const raw=await callClaude(
        `Arabic teacher creating flashcard learning aid.
Word: "${card.english}" · Arabic form "${arabicForm}" (${formLabel})
Generate: 1) Short natural Arabic sentence (6-10w) using EXACTLY: ${arabicForm}  2) English translation  3) Vivid DALL-E scene (2-3 sentences, real everyday Arabic life, no Arabic text in scene)${avoidClause}
Full tashkeel (diacritics) on every Arabic word in the sentence.
Return ONLY valid JSON: {"sentence":"...","translation":"...","imagePrompt":"..."}`,
        800,"sentence",trackUsage
      );
      const parsed=extractJSON(raw);
      setGen({...parsed,imageUrl:null});
      setGenLoading(false);
      // Generate real DALL-E image in background
      setImgLoading(true);
      const url=await generateDalleImage(parsed.imagePrompt);
      setGen(prev=>prev?{...prev,imageUrl:url}:prev);
      setImgLoading(false);
    } catch {
      setGen({sentence:arabicForm,translation:card.english,imagePrompt:`A warm everyday scene representing "${card.english}" in Arabic-speaking daily life, natural lighting.`,imageUrl:null});
      setGenLoading(false);setImgLoading(false);
    }
  };

  const playAudio=()=>{
    if(!gen?.sentence||!window.speechSynthesis) return;
    if(playing){window.speechSynthesis.cancel();setPlaying(false);return;}
    const utt=new SpeechSynthesisUtterance(gen.sentence);
    utt.lang="ar-SA";utt.rate=0.82;
    const v=window.speechSynthesis.getVoices().find(v=>v.lang.startsWith("ar"));if(v) utt.voice=v;
    utt.onstart=()=>setPlaying(true);utt.onend=()=>setPlaying(false);utt.onerror=()=>setPlaying(false);
    window.speechSynthesis.speak(utt);
  };

  return (
    <div className="screen" style={{display:"flex",flexDirection:"column",padding:"18px 18px 20px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <button className="btn btn-ghost" onClick={onExit} style={{width:32,height:32}}><X size={14}/></button>
        <span style={{fontSize:13,color:"var(--text2)",fontWeight:600}}>{currentIndex+1} <span style={{color:"var(--text3)",fontWeight:400}}>/ {cards.length}</span></span>
        <div style={{width:32}}/>
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
              {availForms.filter(([k])=>k!=="harf").map(([key,val])=>(
                <button key={key} className={`chip ${selForm===key?"chip-on":""}`} onClick={()=>{setSelForm(key);setGen(null);}}>
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
            <button className="btn" onClick={()=>onSwipe("left",card.id)} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--weak-bg)",color:"var(--weak)",border:"1.5px solid var(--weak-border)",fontWeight:600,fontSize:13.5}}>← Needs Practice</button>
            <button className="btn" onClick={()=>onSwipe("right",card.id)} style={{flex:1,padding:"14px 8px",borderRadius:"var(--r)",background:"var(--know-bg)",color:"var(--know)",border:"1.5px solid var(--know-border)",fontWeight:600,fontSize:13.5}}>Know It →</button>
          </div>
        )}
        {!flipped&&<div style={{textAlign:"center",color:"var(--text3)",fontSize:12.5,marginTop:"auto"}}>Tap the card to reveal Arabic</div>}
      </div>
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks||[]} cardStates={cardStates||{}} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// COMPLETE
// ─────────────────────────────────────────────────────────────
function CompleteScreen({known,weak,onBack}) {
  return (
    <div className="screen" style={{display:"flex",alignItems:"center",justifyContent:"center",minHeight:"100vh",padding:28,textAlign:"center"}}>
      <div className="pop-appear">
        <div style={{fontSize:52,marginBottom:14}}>✦</div>
        <div style={{fontFamily:"Lora,serif",fontSize:26,fontWeight:600,marginBottom:8}}>Session Complete</div>
        <div style={{fontSize:14,color:"var(--text2)",marginBottom:32}}>
          <span style={{color:"var(--know)",fontWeight:700}}>{known} known</span> · <span style={{color:"var(--weak)",fontWeight:700}}>{weak} need practice</span>
        </div>
        <button className="btn btn-primary" onClick={onBack} style={{padding:"14px 28px",borderRadius:"var(--r)",fontSize:15}}>Back to Deck</button>
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
  const selectAllCards=()=>setSelCardIds(new Set(pooledCards.map(c=>c.id)));
  const clearAllCards=()=>setSelCardIds(new Set());

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
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <button className="btn btn-sm" onClick={selectAllCards} style={{background:"var(--know-bg)",color:"var(--know)",border:"1px solid var(--know-border)"}}>Select All</button>
                <button className="btn btn-sm" onClick={clearAllCards} style={{background:"var(--surface2)",color:"var(--text2)"}}>Clear All</button>
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
function ReadingScreen({decks,cardStates,onBack,onAddToFlashcard,trackUsage}) {
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

  // Derive selected cards from pool
  const selectedCards = decks
    .filter(d=>selDeckIds.has(d.id))
    .flatMap(d=>(cardStates[d.id]||[]))
    .filter(c=>selCardIds.has(c.id));

  const deckNames = decks.filter(d=>selDeckIds.has(d.id)).map(d=>d.title).join(" + ");

  const generate=async()=>{
    if(!selectedCards.length){alert("Select at least one card.");return;}
    setGenerating(true);setPassage(null);setShowTranslation(settings.showTranslation);
    const lenMap={short:"60-80",medium:"110-140",long:"180-220"};
    try {
      const raw=await callClaude(
        `Expert Arabic language teacher creating reading practice.
Deck: ${deckNames}
Arabic vocabulary (MUST use every word): ${selectedCards.map(c=>c.arabicBase).join("، ")}

Write a ${settings.difficulty}-level Arabic reading passage of exactly ~${lenMap[settings.length]||"110-140"} words.
Rules:
- Include every Arabic word from the list above at least once — this is mandatory
- Full tashkeel (diacritics) on every Arabic word
- Grammatically correct and coherent

Return ONLY valid JSON: {"arabic":"...","translation":"...","vocabUsed":["base form of each vocab word that appears"]}`,
        1500,"reading",trackUsage
      );
      setPassage(extractJSON(raw));
    } catch {
      setPassage({arabic:"حَدَثَ خَطَأٌ. يُرْجَى الْمُحَاوَلَةُ مَرَّةً أُخْرَى.",translation:"A generation error occurred.",vocabUsed:[]});
    } finally { setGenerating(false); }
  };

  return (
    <div className="screen">
      <Hdr title="Reading" sub="Practice" onBack={onBack}
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

        <MultiDeckCardSelector
          decks={decks} cardStates={cardStates}
          selDeckIds={selDeckIds} setSelDeckIds={setSelDeckIds}
          selCardIds={selCardIds} setSelCardIds={setSelCardIds}
          accentVar="--read" accentBgVar="--read-bg" accentBorderVar="--read-border"
          onReset={()=>setPassage(null)}
        />

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
              <button className="btn btn-read" onClick={generate} style={{flex:2,padding:"11px",borderRadius:"var(--rs)",fontSize:13}}>
                <RefreshCw size={14}/> Generate New
              </button>
            </div>
          </div>
        )}
      </div>
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LISTENING — multi-deck + multi-card pool
// ─────────────────────────────────────────────────────────────
function ListeningScreen({decks,cardStates,onBack,onAddToFlashcard,trackUsage}) {
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

  useEffect(()=>()=>{if(window.speechSynthesis) window.speechSynthesis.cancel();},[]);

  const selectedCards = decks
    .filter(d=>selDeckIds.has(d.id))
    .flatMap(d=>(cardStates[d.id]||[]))
    .filter(c=>selCardIds.has(c.id));

  const deckNames = decks.filter(d=>selDeckIds.has(d.id)).map(d=>d.title).join(" + ");

  const generate=async()=>{
    if(window.speechSynthesis) window.speechSynthesis.cancel();
    setPlaying(false);
    if(!selectedCards.length){alert("Select at least one card.");return;}
    setGenerating(true);setContent(null);
    setShowArabic(settings.showArabicDefault);setShowEnglish(settings.showEnglishDefault);
    const lenMap={short:"50-70",medium:"90-120",long:"160-200"};
    try {
      const raw=await callClaude(
        `Arabic teacher creating listening practice.
Deck: ${deckNames}
Arabic vocabulary (MUST use every word): ${selectedCards.map(c=>c.arabicBase).join("، ")}

Write a ${settings.difficulty}-level spoken Arabic passage of exactly ~${lenMap[settings.length]} words.
Rules:
- Include every Arabic word from the list above at least once — this is mandatory
- Natural conversational tone suitable for listening
- Full tashkeel (diacritics) on every Arabic word

Return ONLY valid JSON: {"arabic":"...","translation":"...","vocabUsed":["base form of each vocab word that appears"]}`,
        1200,"listening",trackUsage
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
      <Hdr title="Listening" sub="Practice" onBack={onBack}
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

        <MultiDeckCardSelector
          decks={decks} cardStates={cardStates}
          selDeckIds={selDeckIds} setSelDeckIds={setSelDeckIds}
          selCardIds={selCardIds} setSelCardIds={setSelCardIds}
          accentVar="--listen" accentBgVar="--listen-bg" accentBorderVar="--listen-border"
          onReset={()=>{setContent(null);if(window.speechSynthesis) window.speechSynthesis.cancel();setPlaying(false);}}
        />

        <button className="btn btn-listen" onClick={generate} disabled={generating||!selectedCards.length} style={{width:"100%",padding:"14px",borderRadius:"var(--r)",fontSize:14}}>
          {generating
            ?<><RefreshCw size={14} className="spin"/>Generating…</>
            :<><Mic size={15}/>Generate from {selectedCards.length} Card{selectedCards.length!==1?"s":""} · {selDeckIds.size} Deck{selDeckIds.size!==1?"s":""}</>}
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
              <button className="btn btn-listen" onClick={generate} style={{flex:2,padding:"11px",borderRadius:"var(--rs)",fontSize:13}}>
                <RefreshCw size={14}/> Generate New
              </button>
            </div>
          </div>
        )}
      </div>
      {wordPopup&&<WordPopup word={wordPopup.word} context={wordPopup.context} decks={decks} cardStates={cardStates} onClose={()=>setWordPopup(null)} onAddToFlashcard={onAddToFlashcard} trackUsage={trackUsage}/>}
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

  // Firebase auth state listener
  useEffect(()=>{
    // Check for redirect result first (mobile/popup-blocked fallback)
    getRedirectResult(auth).catch(()=>{});
    const unsub=onAuthStateChanged(auth,async u=>{
      setUser(u);
      if(u){
        try {
          const snap=await getDoc(doc(db,"users",u.uid));
          if(snap.exists()){
            const d=snap.data();
            if(d.decks) setDecks(d.decks);
            if(d.cardStates) setCardStates(d.cardStates);
            if(d.settings) setSettings(s=>({...s,...d.settings}));
          }
        } catch(e){ console.error("Firestore load error:",e); }
        setDataLoaded(true);
      } else {
        setDataLoaded(false);
        setDecks(SEED_DECKS);
        setCardStates(SEED_CARDS);
      }
    });
    return unsub;
  },[]);

  // Auto-save to Firestore whenever data changes
  useEffect(()=>{
    if(!user||!dataLoaded) return;
    const t=setTimeout(()=>{
      setDoc(doc(db,"users",user.uid),{decks,cardStates,settings},{merge:true}).catch(e=>console.error("Save error:",e));
    },1500);
    return ()=>clearTimeout(t);
  },[decks,cardStates,settings,user,dataLoaded]);

  const handleSignIn=async()=>{
    setAuthLoading(true);setAuthError("");
    try {
      await signInWithPopup(auth,googleProvider);
    } catch(e){
      // If popup blocked or fails, try redirect
      if(e.code==="auth/popup-blocked"||e.code==="auth/popup-closed-by-user"||e.code==="auth/cancelled-popup-request"){
        try { await signInWithRedirect(auth,googleProvider); return; } catch(e2){ setAuthError(e2.message); }
      } else {
        setAuthError(e.message||"Sign-in failed. Please try again.");
      }
    } finally { setAuthLoading(false); }
  };

  const handleSignOut=async()=>{
    await signOut(auth);
    setScreen("home");
  };

  // Keep module-level refs in sync — picked up automatically by callClaude / generateDalleImage
  useEffect(()=>{ _activeModel = settings.model; _orKey = settings.orKey||""; _oaKey = settings.oaKey||""; },[settings.model,settings.orKey,settings.oaKey]);
  const [sessionCards,setSessionCards]=useState([]);
  const [currentIdx,setCurrentIdx]=useState(0);
  const [usage,setUsage]=useState(initUsage);
  const sessionRes=useRef({known:0,weak:0});
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
  const startStudy=mode=>{
    const dc=cardStates[activeDeck.id]||[];
    const toStudy=mode==="weak"?dc.filter(c=>c.status==="weak"):[...dc];
    if(!toStudy.length) return;
    sessionRes.current={known:0,weak:0};setSessionCards(toStudy);setCurrentIdx(0);go("study");
  };
  const handleSwipe=(dir,cardId)=>{
    const ns=dir==="right"?"known":"weak";
    sessionRes.current[ns==="known"?"known":"weak"]++;
    setCardStates(p=>({...p,[activeDeck.id]:p[activeDeck.id].map(c=>c.id===cardId?{...c,status:ns}:c)}));
    if(currentIdx<sessionCards.length-1) setCurrentIdx(i=>i+1);
    else go("complete");
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

  const commonProps={decks,cardStates,trackUsage};

  const screens={
    home:<HomeScreen {...commonProps} onOpenDeck={openDeck} onSettings={()=>go("settings")} onCreateDeck={()=>go("createDeck")} onReading={()=>go("reading")} onListening={()=>go("listening")}/>,
    settings:<SettingsScreen settings={settings} setSettings={setSettings} onBack={()=>go("home")} usage={usage} user={user} onSignOut={handleSignOut}/>,
    createDeck:<CreateDeckScreen onBack={()=>go("home")} onCreate={createDeck}/>,
    addCards:activeDeck&&<AddCardsScreen deck={activeDeck} onBack={()=>go("deck")} onSave={saveCards} trackUsage={trackUsage}/>,
    deck:activeDeck&&<DeckScreen deck={activeDeck} cards={cardStates[activeDeck.id]||[]} onStartStudy={startStudy} onBack={()=>go("home")} onAddCards={()=>go("addCards")} onEditCard={c=>{setActiveCard(c);go("editCard");}} onDeleteCard={deleteCard} onRenameDeck={renameDeck} onDeleteDeck={deleteDeck}/>,
    editCard:activeCard&&activeDeck&&<EditCardScreen card={activeCard} onBack={()=>go("deck")} onSave={saveEditedCard} trackUsage={trackUsage}/>,
    study:activeDeck&&sessionCards.length>0&&<StudyScreen cards={sessionCards} currentIndex={currentIdx} onSwipe={handleSwipe} onExit={()=>go("deck")} trackUsage={trackUsage} decks={decks} cardStates={cardStates} onAddToFlashcard={addToFlashcard}/>,
    complete:<CompleteScreen known={sessionRes.current.known} weak={sessionRes.current.weak} onBack={()=>go("deck")}/>,
    reading:<ReadingScreen {...commonProps} onBack={()=>go("home")} onAddToFlashcard={addToFlashcard}/>,
    listening:<ListeningScreen {...commonProps} onBack={()=>go("home")} onAddToFlashcard={addToFlashcard}/>,
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

  return (<><style>{CSS}</style><div className="app">{screens[screen]}</div></>);
}
