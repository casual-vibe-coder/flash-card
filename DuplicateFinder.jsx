import { useState } from 'react';
import { findDuplicateGroups, preferredEntry, entryKey, applyDuplicateChoices, undoDuplicateChanges } from './card-duplicates.js';
export default function DuplicateFinder({decks,cardStates,setCardStates}){
 const [phase,setPhase]=useState('idle'),[groups,setGroups]=useState([]),[choices,setChoices]=useState({}),[changes,setChanges]=useState([]),[scope,setScope]=useState('all');
 const found=findDuplicateGroups(scope==='all'?decks:decks.filter(d=>d.id===scope),cardStates);
 const count=groups.reduce((n,g)=>n+(choices[g.key]?g.entries.length-1:0),0);
 const scan=()=>{setGroups(found);setChoices(Object.fromEntries(found.map(g=>[g.key,entryKey(preferredEntry(g.entries))])));setPhase('review');setChanges([]);};
 const apply=()=>{const result=applyDuplicateChoices(cardStates,groups,choices);setCardStates(prev=>applyDuplicateChoices(prev,groups,choices).states);setChanges(result.changes);setPhase('done');};
 const box={background:'var(--surface)',border:'1px solid var(--border)',borderRadius:'var(--rs)',padding:14};
 return <div style={box}>
  <div className="sec">Duplicate Finder</div>
  <p style={{fontSize:13,color:'var(--text2)'}}>Find matching Arabic words and meanings despite tashkeel, extra spaces or punctuation. Different meanings, word types and grammar cards stay separate. The copy with the most reviews is recommended; its study schedule is preserved. Missing details are copied into it.</p>
  {phase==='idle'&&<><select className="input" aria-label="Duplicate scan scope" value={scope} onChange={e=>setScope(e.target.value)}><option value="all">All decks</option>{decks.filter(d=>d.deckType!=='grammar').map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select><button className="btn btn-primary" style={{marginTop:10}} onClick={scan} disabled={!found.length}>{found.length?`Review ${found.length} duplicate groups`:'No duplicates found'}</button></>}
  {phase==='review'&&<>
   <p>{groups.length} groups · {count} copies selected for removal</p>
   <div style={{maxHeight:440,overflowY:'auto'}}>{groups.map(g=><fieldset key={g.key} style={{...box,marginBottom:10}}><legend><span className="ar">{g.entries[0].card.arabicBase||g.entries[0].card.forms?.singular||g.entries[0].card.forms?.past}</span> · {g.entries[0].card.english}</legend>
    {g.entries.map(e=><label key={entryKey(e)} style={{display:'flex',gap:8,padding:'8px 0',alignItems:'center'}}><input type="radio" name={g.key} checked={choices[g.key]===entryKey(e)} onChange={()=>setChoices(p=>({...p,[g.key]:entryKey(e)}))}/><span><b>{choices[g.key]===entryKey(e)?'Keep':'Remove'}</b> · {e.deckTitle}<br/><small>{e.card.status||'new'} · {e.card.srsReps||0} reviews · {Object.values(e.card.forms||{}).filter(Boolean).length} forms{entryKey(preferredEntry(g.entries))===entryKey(e)?' · Recommended':''}</small></span></label>)}
    <label style={{display:'flex',gap:8,paddingTop:6}}><input type="radio" name={g.key} checked={!choices[g.key]} onChange={()=>setChoices(p=>({...p,[g.key]:null}))}/>Keep all copies in this group</label>
   </fieldset>)}</div>
   <div style={{display:'flex',gap:8,marginTop:10}}><button className="btn" onClick={()=>setPhase('idle')}>Cancel</button><button className="btn btn-primary" disabled={!count} onClick={apply}>Combine and remove {count} copies</button></div>
  </>}
  {phase==='done'&&<><p>{changes.filter(c=>c.removed).length} duplicate copies removed. Kept cards retain their review history.</p><div style={{display:'flex',gap:8}}>{changes.length>0&&<button className="btn" onClick={()=>{setCardStates(prev=>undoDuplicateChanges(prev,changes));setChanges([]);setPhase('idle');}}>Undo removal</button>}<button className="btn" onClick={()=>setPhase('idle')}>Scan again</button></div></>}
 </div>;
}
