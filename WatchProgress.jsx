import { useState } from 'react';
import { WATCH_LEVELS, filterLabel, nextLevel } from './watch-levels.js';
import { listeningGoal, canonicalGoalLevel } from './watch-goals.js';
import { progressSummary, timeLabel } from './watch-progress.js';
export function LevelOptions(){return <><option value="all">All levels</option>{WATCH_LEVELS.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}<optgroup label="Overall totals"><option value="cefr:B1">B1 · overall</option><option value="cefr:B2">B2 · overall</option></optgroup><option value="unrated">Unrated</option></>;}
export default function WatchProgress({progress}){
 const [level,setLevel]=useState('all'),[days,setDays]=useState('all'),[goal,setGoal]=useState('');
 const summary=progressSummary(progress.records,{level,days:days==='all'?null:Number(days)});
 const selectedGoal=listeningGoal(progress.records,level);
 const goalLevels=level==='all'?WATCH_LEVELS.map(g=>g.id):level==='unrated'?[]:[level];
 const box={padding:16,border:'1px solid var(--border)',borderRadius:'var(--rs)',background:'var(--surface)'};
 return <div style={{padding:20,display:'grid',gap:14}}>
  <h2 style={{margin:0,fontSize:20}}>Listening through watching</h2>
  <p style={{margin:0,fontSize:13,color:'var(--text2)'}}>Time counts while the video plays and advances in a visible, focused window. Pauses, buffering, background tabs and skipping ahead add no time. This measures playback, not attention or comprehension. Tracking starts with this update.</p>
  <small>{progress.status}</small>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><select className="input" aria-label="Watch level" value={level} onChange={e=>setLevel(e.target.value)}><LevelOptions/></select><select className="input" aria-label="Watch period" value={days} onChange={e=>setDays(e.target.value)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></div>
  <div style={box}><strong style={{fontSize:28}}>{(summary.seconds/3600).toFixed(2)} hours</strong><div>{timeLabel(summary.seconds)} actually played · {summary.videos} videos · {summary.sessions} sessions</div><small>{timeLabel(summary.uniqueSeconds)} unique video content covered. Replays add listening time; faster playback uses less real time.</small></div>
  <div style={box}><strong>Hours by estimated material level</strong>{Object.entries(summary.byLevel).filter(([,r])=>r.seconds>0).map(([id,row])=><div key={id} style={{marginTop:10}}>{filterLabel(id)} <b style={{float:'right'}}>{(row.seconds/3600).toFixed(2)} h</b><div style={{height:5,background:'var(--border)',marginTop:5}}><div style={{height:5,width:100*row.seconds/(summary.seconds||1)+'%',background:'var(--accent)'}}/></div></div>)}{!summary.seconds&&<p>No viewing time for this selection yet.</p>}</div>
  <div style={box}>
   <strong>Watch hours to the next tier</strong>
   <p style={{fontSize:13}}>Each tier shows hours watched against its practice target before moving to the next tier. Targets are per tier, not cumulative from beginner. These are listening practice estimates, not total language-study hours or a guarantee of fluency.</p>
   <small>Check comprehension with unseen videos every 25 hours. Move up when you can follow unfamiliar material comfortably.</small>
   {goalLevels.map(id=>{const g=listeningGoal(progress.records,id),watched=g.seconds/3600,next=nextLevel(id),checkpoint=(Math.floor(watched/25)+1)*25;return <div key={id} style={{padding:'12px 0',borderBottom:'1px solid var(--border)'}}>
    <strong>{filterLabel(id)}</strong><span style={{float:'right'}}>{(g.seconds/3600).toFixed(2)} / {g.hours??'set a target'} h</span>
    {g.hours&&<div role="progressbar" aria-label={filterLabel(id)+' listening goal'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(g.percent)} style={{height:7,background:'var(--border)',marginTop:8,borderRadius:5}}><div style={{height:7,width:g.percent+'%',background:'var(--accent)',borderRadius:5}}/></div>}
    <div style={{fontSize:13,marginTop:8}}>{g.hours?g.reached?'Hour target reached · Check comprehension before moving up.':`${Math.max(0,g.hours-watched).toFixed(1)} h remaining${next?' → '+filterLabel(next):''}`:'C2 has no next CEFR level; set a personal maintenance goal.'}</div>
    <small>{g.hours?(g.custom?'Your target':'Suggested tier target')+' · ':''}Next comprehension spot check: {checkpoint} h ({(checkpoint-watched).toFixed(1)} h away)</small>
   </div>;})}
   {level==='all'&&<p style={{fontSize:12}}>Each tier counts time watched at that material level. B1 totals 200 h across its three tiers; B2 totals 250 h at the default targets. Unrated sessions count toward total listening time. Select a tier above to adjust its target.</p>}
   {level==='unrated'&&<p>Unrated listening is recorded, but has no CEFR-level goal.</p>}
   {!['all','unrated'].includes(level)&&<>
    <p style={{fontSize:12}}>Adjust the listening target for {filterLabel(level)}. {level.startsWith('b1-')||level.startsWith('b2-')?'Tier hours also count toward the overall B1/B2 total. Changing a tier target does not change a saved overall target.':''}</p>
    <div style={{display:'flex',gap:8}}><input className="input" type="number" min="0.1" max="10000" step="0.5" aria-label="Listening goal hours" placeholder={selectedGoal.hours?String(selectedGoal.hours):'Hours'} value={goal} onChange={e=>setGoal(e.target.value)}/><button className="btn" disabled={!(Number(goal)>0&&Number(goal)<=10000)} onClick={()=>{progress.save({id:'goal-'+canonicalGoalLevel(level).replace(':','-'),kind:'goal',owner:progress.owner,level:canonicalGoalLevel(level),hours:Number(goal),updatedAt:Date.now()});setGoal('');}}>Save goal</button></div>
   </>}
   <details style={{marginTop:12}}><summary>When should I try the next level?</summary><p>On three unfamiliar videos with different speakers, listen first without the transcript. Check whether you can explain the main message, recall key details and follow without constant pauses. Try harder material as soon as you are ready; you do not have to finish the hour target first.</p><p>For a practice session: listen → check the Arabic/English breakdown → save useful words or phrases → listen again without the transcript. The hour counter measures exposure, not your test score.</p><a href="https://support.cambridgeenglish.org/hc/en-gb/articles/202838506-Guided-learning-hours" target="_blank" rel="noreferrer">What guided study hours mean</a> · <a href="https://rm.coe.int/1680459f97" target="_blank" rel="noreferrer">CEFR comprehension descriptors</a></details>
  </div>
  <div style={box}><strong>Videos you watched</strong>{summary.videoHistory.map(v=><div key={v.id} style={{padding:'10px 0',borderBottom:'1px solid var(--border)'}}>{v.title||v.id}<div style={{fontSize:12}}>{timeLabel(v.seconds)} listening · {timeLabel(v.ranges.reduce((n,[a,b])=>n+b-a,0))} unique content</div></div>)}</div>
  <small>Levels are AI estimates from transcripts. B1/B2 sub-bands are app labels. Audio clarity and accent are not assessed. A session keeps the estimate it started with.</small>
 </div>;
}
