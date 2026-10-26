import { useState } from 'react';
import { WATCH_LEVELS, filterLabel, nextLevel } from './watch-levels.js';
import { progressSummary, timeLabel } from './watch-progress.js';
export function LevelOptions(){return <><option value="all">All levels</option>{['A1','A2','B1','B2','C1','C2'].map(l=><option key={l} value={'cefr:'+l}>{l} · all sub-bands</option>)}{WATCH_LEVELS.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}<option value="unrated">Unrated</option></>;}
export default function WatchProgress({progress}){
 const [level,setLevel]=useState('all'),[days,setDays]=useState('all'),[goal,setGoal]=useState('');
 const summary=progressSummary(progress.records,{level,days:days==='all'?null:Number(days)});
 const stored=progress.records.find(r=>r.kind==='goal'&&r.level===level);
 const lifetime=progressSummary(progress.records,{level});
 const achieved=stored&&lifetime.seconds>=stored.hours*3600;
 const box={padding:16,border:'1px solid var(--border)',borderRadius:'var(--rs)',background:'var(--surface)'};
 return <div style={{padding:20,display:'grid',gap:14}}>
  <h2 style={{margin:0,fontSize:20}}>Listening through watching</h2>
  <p style={{margin:0,fontSize:13,color:'var(--text2)'}}>Time counts while the video plays and advances in a visible, focused window. Pauses, buffering, background tabs and skipping ahead add no time. This measures playback, not attention or comprehension. Tracking starts with this update.</p>
  <small>{progress.status}</small>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><select className="input" aria-label="Watch level" value={level} onChange={e=>setLevel(e.target.value)}><LevelOptions/></select><select className="input" aria-label="Watch period" value={days} onChange={e=>setDays(e.target.value)}><option value="all">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option></select></div>
  <div style={box}><strong style={{fontSize:28}}>{(summary.seconds/3600).toFixed(2)} hours</strong><div>{timeLabel(summary.seconds)} actually played · {summary.videos} videos · {summary.sessions} sessions</div><small>{timeLabel(summary.uniqueSeconds)} unique video content covered. Replays add listening time; faster playback uses less real time.</small></div>
  <div style={box}><strong>Hours by estimated material level</strong>{Object.entries(summary.byLevel).filter(([,r])=>r.seconds>0).map(([id,row])=><div key={id} style={{marginTop:10}}>{filterLabel(id)} <b style={{float:'right'}}>{(row.seconds/3600).toFixed(2)} h</b><div style={{height:5,background:'var(--border)',marginTop:5}}><div style={{height:5,width:100*row.seconds/(summary.seconds||1)+'%',background:'var(--accent)'}}/></div></div>)}{!summary.seconds&&<p>No viewing time for this selection yet.</p>}</div>
  <div style={box}><strong>Your practice goal · {filterLabel(level)}</strong><p>Choose your own lifetime hour target for this level. Hours alone do not establish CEFR proficiency.</p><div style={{display:'flex',gap:8}}><input className="input" type="number" min="0.1" max="10000" step="0.5" aria-label="Practice goal hours" placeholder={stored?String(stored.hours):'Hours'} value={goal} onChange={e=>setGoal(e.target.value)}/><button className="btn" disabled={!(Number(goal)>0&&Number(goal)<=10000)} onClick={()=>{progress.save({id:'goal-'+level.replace(':','-'),kind:'goal',owner:progress.owner,level,hours:Number(goal),updatedAt:Date.now()});setGoal('');}}>Save goal</button></div>{stored&&<p>{(lifetime.seconds/3600).toFixed(2)} / {stored.hours} hours{achieved?`. Goal reached! Try a short ${nextLevel(level)?filterLabel(nextLevel(level)):'more challenging'} clip and check whether you can follow the main ideas without captions.`:'. Keep building comfortable comprehension.'}</p>}</div>
  <div style={box}><strong>Videos you watched</strong>{summary.videoHistory.map(v=><div key={v.id} style={{padding:'10px 0',borderBottom:'1px solid var(--border)'}}>{v.title||v.id}<div style={{fontSize:12}}>{timeLabel(v.seconds)} listening · {timeLabel(v.ranges.reduce((n,[a,b])=>n+b-a,0))} unique content</div></div>)}</div>
  <small>Levels are AI estimates from transcripts. B1/B2 sub-bands are app labels. Audio clarity and accent are not assessed. A session keeps the estimate it started with.</small>
 </div>;
}
