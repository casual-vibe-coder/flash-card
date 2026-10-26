import { WATCH_LEVELS, matchesLevel, levelInfo } from './watch-levels.js';
const DAY=86400000;
export function unionRanges(ranges=[]) {
  const sorted=ranges.filter(r=>Array.isArray(r)&&r.length===2&&Number.isFinite(r[0])&&Number.isFinite(r[1])&&r[1]>r[0]&&r[0]>=0).map(r=>[...r]).sort((a,b)=>a[0]-b[0]);
  const result=[];for(const range of sorted){const last=result[result.length-1];if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else result.push(range);}return result;
}
export const coveredSeconds = ranges => unionRanges(ranges).reduce((sum,[a,b])=>sum+b-a,0);
export function dayShares(start,end,seconds) {
  if(!(end>start))return [[new Date(end).toISOString().slice(0,10),seconds]];
  const result=[];let at=start;
  while(at<end){const stop=Math.min(end,(Math.floor(at/DAY)+1)*DAY);result.push([new Date(at).toISOString().slice(0,10),seconds*(stop-at)/(end-start)]);at=stop;}return result;
}
export function createWatchSession({id,owner,videoId,title='',assessment=null,now=Date.now()}) {
  return {kind:'session',version:1,id,owner,videoId,title:String(title).slice(0,250),levelId:assessment?.levelId||'unrated',assessmentId:assessment?.id||null,
    confidence:assessment?.confidence||null,startedAt:now,updatedAt:now,seconds:0,mediaSeconds:0,days:{},comprehension:null};
}
export class PlaybackTracker {
  constructor(record){this.record=record;this.previous=null;}
  reset(){this.previous=null;}
  sample(sample){
    const before=this.previous;this.previous={...sample};
    if(!before||!before.playing||!sample.playing||!before.visible||!sample.visible||!before.focused||!sample.focused)return 0;
    const elapsed=(sample.wallMs-before.wallMs)/1000,advance=sample.position-before.position,rate=before.rate;
    if(!(elapsed>0&&elapsed<=2.5&&rate>0)||rate!==sample.rate||!Number.isFinite(advance)||advance<=0)return 0;
    const expected=elapsed*rate;
    if(Math.abs(advance-expected)>Math.max(.6,expected*.35))return 0; // seek, timer suspension or inconsistent playback
    const seconds=Math.min(elapsed,advance/rate);
    if(!Number.isFinite(seconds)||seconds<=0)return 0;
    const media=Math.min(advance,seconds*rate);
    this.record.seconds+=seconds;this.record.mediaSeconds+=media;this.record.updatedAt=sample.at;
    const shares=dayShares(before.at,sample.at,seconds);
    let rangeStart=Math.max(0,before.position);
    for(const [date,amount] of shares){const part=media*amount/seconds,rangeEnd=rangeStart+part;
      const day=this.record.days[date]||(this.record.days[date]={seconds:0,mediaSeconds:0,ranges:[]});day.seconds+=amount;day.mediaSeconds+=part;day.ranges=unionRanges([...day.ranges,[rangeStart,rangeEnd]]);rangeStart=rangeEnd;
    }
    return seconds;
  }
  snapshot(){return JSON.parse(JSON.stringify(this.record));}
}
export function mergeRecords(records=[]) {
  const map=new Map();for(const record of records){
    if(!record?.id)continue;const previous=map.get(record.id);
    if(!previous||(record.kind==='session'?(record.seconds||0)>(previous.seconds||0)||(record.seconds===previous.seconds&&record.updatedAt>=previous.updatedAt):(record.updatedAt||record.assessedAt||0)>=(previous.updatedAt||previous.assessedAt||0)))map.set(record.id,record);
  }return [...map.values()];
}
export function progressSummary(records,{level='all',days=null,now=Date.now()}={}) {
  const cutoff=days?new Date(now-(days-1)*DAY).toISOString().slice(0,10):null;
  const today=new Date(now).toISOString().slice(0,10);const byLevel=Object.fromEntries([...WATCH_LEVELS.map(l=>l.id),'unrated'].map(id=>[id,{seconds:0,videos:new Set()}]));
  const videos=new Map();let seconds=0,mediaSeconds=0,count=0;const sessions=[];
  for(const record of mergeRecords(records).filter(r=>r.kind==='session')){
    if(!matchesLevel(record.levelId,level))continue;
    const selected=Object.entries(record.days||{}).filter(([date])=>(!cutoff||date>=cutoff)&&date<=today);
    const watched=selected.reduce((n,[,d])=>n+(Number.isFinite(d.seconds)?Math.max(0,d.seconds):0),0);
    if(!watched)continue;
    const consumed=selected.reduce((n,[,d])=>n+(Number.isFinite(d.mediaSeconds)?Math.max(0,d.mediaSeconds):0),0);
    seconds+=watched;mediaSeconds+=consumed;count++;
    const id=levelInfo(record.levelId).id;byLevel[id].seconds+=watched;byLevel[id].videos.add(record.videoId);
    const video=videos.get(record.videoId)||{id:record.videoId,title:record.title,seconds:0,ranges:[]};video.seconds+=watched;video.ranges=unionRanges([...video.ranges,...selected.flatMap(([,d])=>d.ranges||[])]);videos.set(record.videoId,video);
    sessions.push({...record,selectedSeconds:watched});
  }
  return {seconds,mediaSeconds,sessions:count,videos:videos.size,uniqueSeconds:[...videos.values()].reduce((n,v)=>n+coveredSeconds(v.ranges),0),
    byLevel:Object.fromEntries(Object.entries(byLevel).map(([id,row])=>[id,{seconds:row.seconds,videos:row.videos.size}])),
    history:sessions.sort((a,b)=>b.updatedAt-a.updatedAt),videoHistory:[...videos.values()].sort((a,b)=>b.seconds-a.seconds)};
}
export function watchStudyEntries(records){return mergeRecords(records).filter(r=>r.kind==='session').flatMap(record=>Object.entries(record.days||{}).filter(([,day])=>day.seconds>0).map(([date,day])=>({id:'watch:'+record.id+':'+date,date,ts:record.updatedAt,type:'app',module:'listening',subtype:'watch-verified',minutes:day.seconds/60,videoId:record.videoId,levelId:record.levelId})));}
export function mergeWatchStudyLog(log,records){return {...log,entries:[...(log.entries||[]).filter(e=>e.subtype!=='watch-verified'),...watchStudyEntries(records)]};}
export const timeLabel = seconds => {const n=Math.floor(Math.max(0,seconds||0));return n>=3600?`${Math.floor(n/3600)}h ${Math.floor(n%3600/60)}m`:`${Math.floor(n/60)}m ${n%60}s`;};
