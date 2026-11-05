// Per-card merge for a deck's cards array (see comment in App.jsx at the call sites).
function same(a,b){
  if(a===b) return true;
  if(a&&b&&typeof a==='object'&&typeof b==='object'){
    if(Array.isArray(a)!==Array.isArray(b)) return false;
    const ka=Object.keys(a), kb=Object.keys(b);
    if(ka.length!==kb.length) return false;
    for(const k of ka) if(!same(a[k],b[k])) return false;
    return true;
  }
  return false;
}
export function indexCards(cards){ const m=new Map(); for(const c of cards||[]) m.set(c.id,c.srsLastReview||0); return m; }
export function mergeDeckCards(local,cloud,seen){
  local=local||[]; cloud=cloud||[]; seen=seen||new Map();
  const cloudById=new Map(cloud.map(c=>[c.id,c]));
  const out=[]; let differsFromCloud=false;
  for(const c of local){
    const cc=cloudById.get(c.id);
    if(!cc){ out.push(c); differsFromCloud=true; continue; }
    cloudById.delete(c.id);
    const cloudLR=cc.srsLastReview||0, localLR=c.srsLastReview||0;
    if(cloudLR>localLR&&cloudLR!==seen.get(c.id)) out.push(cc);
    else { out.push(c); if(!same(c,cc)) differsFromCloud=true; }
  }
  for(const cc of cloudById.values()){
    if(seen.has(cc.id)){ differsFromCloud=true; continue; } // deleted locally
    out.push(cc);
  }
  return differsFromCloud?out:cloud;
}
