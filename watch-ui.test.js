import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as icons from 'lucide-react';
import { playbackPosition, lineEnd, captionTime, videoTime as captionVideoTime, alignedWordTimes } from './watch-timing.js';
import { filterVideos, searchQuery, normalizeBreakdown, prepareWatchLesson } from './watch-library.js';
const source=fs.readFileSync(new URL('./App.jsx',import.meta.url),'utf8');
const start=source.indexOf('function WatchScreen('),end=source.indexOf('// One-time backlog spread',start);
const component=source.slice(start,end).replace(/const \[(\w+),(\w+)\]=useState\(/g,'const [$1,$2]=useNamedState("$1",');
const compiled=transformSync(component+'\nglobalThis.Component=WatchScreen;',{loader:'jsx',jsxFactory:'React.createElement',format:'cjs'}).code;
function fixture(overrides={},request=async()=>{}){
 const context={React,...icons,AbortController,console,setTimeout,clearTimeout,playbackPosition,lineEnd,captionTime,captionVideoTime,alignedWordTimes,filterVideos,searchQuery,normalizeBreakdown,prepareWatchLesson,requestTranscript:request,
  localStorage:{length:0,getItem:()=>null,setItem(){},removeItem(){}},useRef:value=>({current:value}),useEffect:()=>{},useNamedState:(key,value)=>[Object.hasOwn(overrides,key)?overrides[key]:typeof value==='function'?value():value,()=>{}],
  WatchCosts:()=>null,Hdr:()=>null,pickModelForTag:()=> 'test',MODEL_PRICES:{},WATCH_CATEGORIES:[{k:'all',label:'All',ar:''}],fmtDur:()=>'',};
 vm.createContext(context);vm.runInContext(compiled,context);return context.Component({decks:[],user:null});
}
function buttons(node,list=[]){if(!node||typeof node!=='object')return list;if(Array.isArray(node)){node.forEach(n=>buttons(n,list));return list;}if(node.type==='button')list.push(node);buttons(node.props?.children,list);return list;}
test('actual Watch markup reads Arabic RTL once and keeps English glosses LTR',()=>{
 const tree=fixture({videoId:'abcdefghijk',ready:true,lines:[{start:0,dur:2,text:'أذهب إلى السوق'}],bd:[{tr:'I go to the market.',w:[{ar:'أَذْهَبُ',en:'I go'},{ar:'إِلَى',en:'to'},{ar:'السُّوقِ',en:'the market'}]}]});
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
