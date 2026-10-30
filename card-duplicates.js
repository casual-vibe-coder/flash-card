// Conservative matching: spelling/spacing differences, never guessed synonyms.
export const normalizeDuplicateText = value => String(value||'').normalize('NFKC').replace(/[\u0640\u064B-\u065F\u0670]/g,'').replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g,'').trim().toLowerCase().replace(/\s+/g,' ').replace(/[.!،,؛;؟?]+$/u,'').trim();
export const entryKey = entry => JSON.stringify([entry.deckId,entry.card.id]);
export function scoreCardForKeep(card){
 return [Number(card.srsReps)||0,Number(card.srsLastReview)||0,card.status==='known'?2:card.status==='weak'?1:0,Object.values(card.forms||{}).filter(Boolean).length];
}
export function preferredEntry(entries){return [...entries].sort((a,b)=>{const x=scoreCardForKeep(a.card),y=scoreCardForKeep(b.card);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return y[i]-x[i];return 0;})[0];}
export function findDuplicateGroups(decks,cardStates){
 const buckets=new Map();
 for(const deck of decks)for(const card of cardStates[deck.id]||[]){
  // Grammar explanations and blank words need a different kind of review.
  if(card.wordType==='grammar'||deck.deckType==='grammar'||!card.id)continue;
  const ar=normalizeDuplicateText(card.arabicBase||card.forms?.singular||card.forms?.past||''),en=normalizeDuplicateText(card.english);
  if(!ar||!en)continue;
  const key=JSON.stringify([card.wordType||'noun',ar,en]);
  if(!buckets.has(key))buckets.set(key,[]);
  buckets.get(key).push({card,deckId:deck.id,deckTitle:deck.title});
 }
 return [...buckets].filter(([,entries])=>entries.length>1).map(([key,entries])=>({key,entries}));
}
function fillMissing(keep,other){
 const merged={...keep};
 for(const [key,value] of Object.entries(other)){
  if(key==='id'||key==='status'||key.startsWith('srs'))continue;
  if(value&&typeof value==='object'&&!Array.isArray(value)){
   if(keep[key]&&typeof keep[key]==='object'&&!Array.isArray(keep[key]))merged[key]=fillMissing(keep[key],value);
   else if(!keep[key])merged[key]=value;
  }else if((keep[key]===undefined||keep[key]===null||keep[key]==='')&&value!==undefined)merged[key]=value;
 }
 return merged;
}
export function applyDuplicateChoices(states,groups,choices){
 const next={...states},changes=[];
 for(const group of groups){
  const selected=choices[group.key];if(!selected)continue;
  // Revalidate against current state so a stale scan cannot delete edited cards.
  const entries=group.entries.map(e=>({...e,current:(next[e.deckId]||[]).find(c=>c.id===e.card.id)}));
  if(entries.some(e=>!e.current||JSON.stringify(e.current)!==JSON.stringify(e.card)))continue;
  const winner=entries.find(e=>entryKey(e)===selected);if(!winner)continue;
  let merged=winner.current;
  for(const e of entries)if(entryKey(e)!==selected)merged=fillMissing(merged,e.current);
  changes.push({deckId:winner.deckId,id:winner.card.id,before:winner.current,after:merged,removed:false});
  next[winner.deckId]=next[winner.deckId].map(c=>c.id===winner.card.id?merged:c);
  for(const e of entries)if(entryKey(e)!==selected){
   const index=next[e.deckId].findIndex(c=>c.id===e.card.id);
   changes.push({deckId:e.deckId,id:e.card.id,before:e.current,index,removed:true});
   next[e.deckId]=next[e.deckId].filter(c=>c.id!==e.card.id);
  }
 }
 return {states:next,changes};
}
export function undoDuplicateChanges(states,changes){
 const next={...states};
 for(const change of [...changes].reverse()){
  const cards=next[change.deckId];if(!cards)continue;
  if(change.removed){if(!cards.some(c=>c.id===change.id)){const copy=[...cards];copy.splice(Math.min(change.index,copy.length),0,change.before);next[change.deckId]=copy;}}
  else next[change.deckId]=cards.map(c=>c.id===change.id&&JSON.stringify(c)===JSON.stringify(change.after)?change.before:c);
 }
 return next;
}
