import { useEffect, useState } from 'react';
import { CREDIT_RATES, forecastWatch, usd } from './watch-costs.js';

export default function WatchCosts({ model, fallbackPrice, durationSec, billed }) {
  const [price, setPrice] = useState(null), [source, setSource] = useState('Loading current model pricing…');
  const [minutes, setMinutes] = useState(10), [rate, setRate] = useState(()=>{
    try { return localStorage.getItem('watch:creditRate') || 'basic'; } catch { return 'basic'; }
  });
  useEffect(()=>{ if(durationSec>0) setMinutes(Math.round(durationSec/60*100)/100); },[durationSec]);
  useEffect(()=>{
    const controller = new AbortController();
    setPrice(null);setSource('Loading current model pricing…');
    fetch('https://openrouter.ai/api/v1/models',{signal:controller.signal})
      .then(r=>{if(!r.ok) throw new Error();return r.json();})
      .then(d=>{
        const p=d.data?.find(m=>m.id===model)?.pricing;
        if(!p||!Number.isFinite(Number(p.prompt))||!Number.isFinite(Number(p.completion))||Number(p.prompt)<0||Number(p.completion)<0) throw new Error();
        setPrice({in:Number(p.prompt)*1e6,out:Number(p.completion)*1e6});
        setSource(`OpenRouter catalog · fetched ${new Date().toLocaleDateString()}`);
      }).catch(()=>{if(!controller.signal.aborted){setPrice(fallbackPrice||null);setSource('Live pricing unavailable · saved reference rates (may be outdated)');}});
    return ()=>controller.abort();
  },[model]);
  const creditRate=CREDIT_RATES[rate]||CREDIT_RATES.basic;
  const cost=forecastWatch(minutes,price,creditRate.usd);
  const range=extra=>cost.low==null?'Unavailable':`${usd(cost.low+extra)}–${usd(cost.high+extra)}`;
  const rows=[['Existing captions (1 credit via Supadata)',usd(cost.captions)],
    [`Speech-to-text instead (${cost.speechCredits} credits)`,usd(cost.speech)],
    ['English translation + word breakdown',range(0)],
    ['Total with existing captions',range(cost.captions)],
    ['Total with speech-to-text',range(cost.speech)],
    ['Save lesson · AI charges','$0']];
  return <details style={{margin:'12px 20px',padding:12,border:'1px solid var(--border)',borderRadius:'var(--rs)',fontSize:12,color:'var(--text2)'}}>
    <summary style={{cursor:'pointer',fontWeight:600}}>Video cost forecast · USD{billed?.requests?` · reported Watch AI charges ${usd(billed.usd)}`:''}</summary>
    <div style={{display:'grid',gap:9,marginTop:12}}>
      <label>Video length (minutes) <input className="input" type="number" min="0.1" max="1440" step="0.1" value={minutes} onChange={e=>setMinutes(Math.max(0.1,Math.min(1440,Number(e.target.value)||0.1)))} /></label>
      <label>Transcript credit rate <select className="input" value={rate} onChange={e=>{setRate(e.target.value);try{localStorage.setItem('watch:creditRate',e.target.value);}catch{}}}>{Object.entries(CREDIT_RATES).map(([id,r])=><option key={id} value={id}>{r.label}</option>)}</select></label>
      <div>English model: {model.split('/').pop()} · {price?`${usd(price.in)} input / ${usd(price.out)} output per million tokens`: 'Rate unavailable'}</div>
      <div style={{fontSize:11,color:'var(--text3)'}}>{source}</div>
      <table style={{width:'100%',borderCollapse:'collapse'}}><tbody>{rows.map(([label,value])=><tr key={label}><td style={{padding:'5px 0'}}>{label}</td><td style={{textAlign:'right',whiteSpace:'nowrap',paddingLeft:8}}>{value}</td></tr>)}</tbody></table>
      <div>Forecast assumes 120 Arabic words/minute, 8 input and 40 output tokens/word, with a 0.6–1.6× range. Actual provider routing, reasoning and retries can change the bill. Direct YouTube captions cost $0; Supadata charges apply only when used. An unavailable native transcript request can still use 1 credit; job-status polling has no credit charge.</div>
      {billed?.requests>0&&<div>OpenRouter-reported Watch AI charges this session: <strong>{usd(billed.usd)}</strong> across {billed.requests} responses. {billed.unknown>0?`${billed.unknown} responses did not report a cost. `:''}Timed-out requests may still incur charges that are not reported here.</div>}
      <div>English search adds a short AI translation request (cached for repeated searches). Video difficulty adds one small AI request per new transcript/model, billed separately from the translation forecast. Reported Watch AI charges include translation, query translation and difficulty estimates. Saved lessons reuse completed translations. Saving stores text and a YouTube reference, not the video file. Device storage has no service charge. Firebase reads, writes and storage depend on your region, plan and free quota; excluded from totals, along with hosting, taxes and credit purchase fees.</div>
      <details><summary>How to keep transcript costs down</summary><p>Search with the caption-track filter enabled. Existing Arabic captions cost no speech-generation credits: direct retrieval is free; a Supadata native request costs 1 credit. A caption badge does not guarantee an accessible Arabic track.</p><p>Reuse saved lessons and resume pending speech jobs instead of starting another. Speech generation is 2 credits per video minute, so a 10-minute video is about 20 credits. At Basic/Pro recharge rates that is $0.20; at Mega recharge rates $0.04. Monthly plan fees are separate, so upgrading only saves money if you use enough credits.</p><p>Slowing the player does not lower transcription cost; the source duration determines it. The app always tries existing captions before offering paid speech-to-text. English breakdown and video-level AI charges are separate.</p></details>
      <div>Transcript rates checked October 26, 2026. Speech estimates round up to whole minutes; the provider dashboard determines final usage. Free-plan rate applies only while included credits remain. Included-plan rates assume all credits are used.</div>
      <div><a href="https://supadata.ai/pricing" target="_blank" rel="noreferrer">Transcript rates</a> · <a href={`https://openrouter.ai/${model}`} target="_blank" rel="noreferrer">Model rates</a> · <a href="https://firebase.google.com/docs/firestore/pricing" target="_blank" rel="noreferrer">Saving rates</a></div>
    </div>
  </details>;
}
