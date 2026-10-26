import { useEffect, useRef, useState } from 'react';
import { collection, doc, getDocs, setDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { mergeRecords } from './watch-progress.js';
export default function useWatchProgress(user){
 const owner=user?.uid||'device',key='watch:progress:v1:'+owner;
 const read=()=>{try{return JSON.parse(localStorage.getItem(key)||'[]');}catch{return [];}};
 const [view,setView]=useState({owner,records:[],status:'Loading progress…'});
 const current=useRef(null);
 useEffect(()=>{
  const state={owner,records:read(),alive:true,chain:Promise.resolve(),status:user?.uid?'Syncing progress…':'Saved on this device'};current.current=state;
  const publish=()=>{if(state.alive)setView({owner,records:[...state.records],status:state.status});};
  state.publish=publish;
  state.persist=()=>{try{localStorage.setItem(key,JSON.stringify(state.records));}catch{state.status='Device storage full — keep this page open';}publish();};
  state.upload=records=>{if(!user?.uid)return;state.chain=state.chain.then(async()=>{try{for(const record of records)await setDoc(doc(db,'users',owner,'watchProgress',record.id),record);state.status='Progress synced';}catch{state.status='Saved on this device · cloud sync unavailable';}publish();});};
  publish();
  if(user?.uid)getDocs(collection(db,'users',owner,'watchProgress')).then(snap=>{if(!state.alive)return;state.records=mergeRecords([...snap.docs.map(d=>d.data()),...state.records]);state.persist();state.upload(state.records);}).catch(()=>{state.status='Saved on this device · cloud sync unavailable';publish();});
  return()=>{state.alive=false;};
 },[owner]);
 const save=(record,cloud=true)=>{const state=current.current;if(!state||state.owner!==owner||record.owner!==owner)return;state.records=mergeRecords([...state.records,record]);state.persist();if(cloud)state.upload([record]);};
 const records=view.owner===owner?view.records:[];
 return {owner,records,status:view.owner===owner?view.status:'Loading progress…',save};
}
