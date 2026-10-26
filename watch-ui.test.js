import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as progressHelpers from './watch-progress.js';
import * as levelHelpers from './watch-levels.js';
import * as icons from 'lucide-react';
import { playbackPosition, lineEnd, captionTime, videoTime as captionVideoTime, alignedWordTimes } from './watch-timing.js';
import { filterVideos, searchQuery, normalizeBreakdown, prepareWatchLesson } from './watch-library.js';
const source=fs.readFileSync(new URL('./App.jsx',import.meta.url),'utf8');
const start=source.indexOf('function WatchScreen('),end=source.indexOf('// One-time backlog spread',start);
const component=source.slice(start,end).replace(/const \[(\w+),(\w+)\]=useState\(/g,'const [$1,$2]=useNamedState("$1",');
const compiled=transformSync(component+'\nglobalThis.Component=WatchScreen;',{loader:'jsx',jsxFactory:'React.createElement',format:'cjs'}).code;
function fixture(overrides={},request=async()=>{},harness=null){
 const refs=[],effects=[];
 const context={React,...icons,...progressHelpers,...levelHelpers,WatchProgress:()=>null,LevelOptions:()=>null,AbortController,console,setTimeout,clearTimeout,playbackPosition,lineEnd,captionTime,captionVideoTime,alignedWordTimes,filterVideos,searchQuery,normalizeBreakdown,prepareWatchLesson,requestTranscript:request,
  localStorage:{length:0,getItem:()=>null,setItem(){},removeItem(){}},useRef:value=>{const ref={current:value};refs.push(ref);return ref;},useEffect:fn=>effects.push(fn),useNamedState:(key,value)=>[Object.hasOwn(overrides,key)?overrides[key]:typeof value==='function'?value():value,()=>{}],
  WatchCosts:()=>null,Hdr:()=>null,pickModelForTag:()=> 'test',MODEL_PRICES:{},WATCH_CATEGORIES:[{k:'all',label:'All',ar:''}],fmtDur:()=>'',};
 vm.createContext(context);vm.runInContext(compiled,context);const tree=context.Component({decks:[],user:null,watchProgress:{owner:"device",records:[],status:"Saved",save(){}}});if(harness)Object.assign(harness,{context,refs,effects,tree});return tree;
}
function buttons(node,list=[]){if(!node||typeof node!=='object')return list;if(Array.isArray(node)){node.forEach(n=>buttons(n,list));return list;}if(node.type==='button')list.push(node);buttons(node.props?.children,list);return list;}
test('actual Watch markup reads Arabic RTL once and keeps English glosses LTR',()=>{
 const tree=fixture({videoId:'abcdefghijk',ready:true,lessonEntered:true,lines:[{start:0,dur:2,text:'أذهب إلى السوق'}],bd:[{tr:'I go to the market.',w:[{ar:'أَذْهَبُ',en:'I go'},{ar:'إِلَى',en:'to'},{ar:'السُّوقِ',en:'the market'}]}]});
 const html=renderToStaticMarkup(tree);assert(html.includes('direction:rtl;display:flex;flex-wrap:wrap;flex-direction:row;'));assert(!html.includes('flex-direction:row-reverse'));assert(html.includes('dir="ltr" lang="en"'));assert(html.indexOf('I go</div>')<html.indexOf('the market</div>'));
});
test('blocked transcripts expose an enabled speech-to-text action and saved jobs expose Resume',()=>{
 const html=renderToStaticMarkup(fixture({videoId:'abcdefghijk',genOffer:true,err:'Caption access blocked.'}));assert(html.includes('Generate transcript (speech-to-text)'));assert(html.includes('Caption access blocked.'));
 const resume=renderToStaticMarkup(fixture({videoId:'abcdefghijk',genOffer:true,pendingJob:'job'}));assert(resume.includes('Resume speech-to-text job'));
});
test('library renders matching saved titles and a no-match path into external search',()=>{
 const videos=[{id:'one',title:'أخبار العالم',channel:'Arabic'},{id:'two',title:'Cooking',channel:'Food'}];
 const html=renderToStaticMarkup(fixture({tab:'library',mine:videos,library:[],libraryQuery:'اخبار'}));assert(html.includes('أخبار العالم'));assert(!html.includes('Cooking'));
 const empty=renderToStaticMarkup(fixture({tab:'library',mine:videos,library:[],libraryQuery:'zzz'}));assert(empty.includes('No saved videos match'));assert(empty.includes('Search YouTube instead'));
});
test('rapid double click starts one paid job even before React rerenders',async()=>{
 let calls=0,reject;const pending=new Promise((_,r)=>reject=r);
 const tree=fixture({videoId:'abcdefghijk',genOffer:true},()=>{calls++;return pending;});
 const button=buttons(tree).find(b=>b.props.onClick?.name==='generate');assert(button);
 const first=button.props.onClick(),second=button.props.onClick();assert.equal(calls,1);reject(Error('controlled request failure'));await Promise.all([first,second]);
});

test('ready lesson shows level estimate before player is mounted',()=>{const html=renderToStaticMarkup(fixture({ready:true,videoId:'video',lines:[{text:'مرحبا'}],assessment:{levelId:'b1-low',reason:'Everyday narrative',confidence:'medium',register:'msa',caveats:['Transcript only']}}));assert(html.includes('Lower intermediate'));assert(html.includes('Everyday narrative'));assert(html.includes('Begin watching'));assert(!html.includes('aspect-ratio:16/9'));});

test('actual player heartbeat excludes paused, hidden and seeked playback',async()=>{
 const h={};fixture({videoId:'video',ready:true,lessonEntered:true,lines:[{start:0,dur:90,text:'مرحبا'}],bd:[{tr:'hello',w:[]}]},undefined,h);
 const tracker=new progressHelpers.PlaybackTracker(progressHelpers.createWatchSession({id:'s',owner:'device',videoId:'video'}));h.refs[0].current=tracker;
 let time=0,position=0,state=1,events;const timers=[],saved=[];
 const player={getCurrentTime:()=>position,getPlaybackRate:()=>1,getPlayerState:()=>state,setPlaybackRate(){},destroy(){}};
 Object.assign(h.context,{performance:{now:()=>time},document:{visibilityState:'visible',hasFocus:()=>true},window:{addEventListener(){},removeEventListener(){}},setInterval:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearInterval(){},loadYouTubeApi:async()=>({Player:function(_,options){events=options.events;return player;}})});
 h.refs[1].current={owner:'device',records:[],save:r=>saved.push(r)};
 // React normally assigns the player container ref during the commit.
 function mount(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(mount);return;}if(node.ref&&node.type==='div')node.ref.current={};mount(node.props?.children);}mount(h.tree);
 const effect=h.effects.find(fn=>fn.toString().includes('loadYouTubeApi'));assert(effect);const cleanup=effect();await Promise.resolve();events.onReady();
 const tick=()=>{time+=1000;timers.find(t=>t.ms===1000).fn();};tick();position=1;tick();assert.equal(tracker.record.seconds,1);
 state=2;events.onStateChange();tick();assert.equal(tracker.record.seconds,1);
 state=1;events.onStateChange();position=80;tick();assert.equal(tracker.record.seconds,1);
 h.context.document.visibilityState='hidden';position=81;tick();assert.equal(tracker.record.seconds,1);
 cleanup();assert(saved.some(r=>r.seconds===1));
});
