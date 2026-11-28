import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transformSync} from 'esbuild';
import * as icons from 'lucide-react';
import {lookupContext,lookupPrompt,parseLookup} from './word-lookup.js';
const source=fs.readFileSync(new URL('./App.jsx',import.meta.url),'utf8');
const start=source.indexOf('function WordPopup('),end=source.indexOf('// USAGE METER',start);
const compiled=transformSync(source.slice(start,end)+'\nglobalThis.Component=WordPopup;',{loader:'jsx',jsxFactory:'React.createElement'}).code;
function harness(call){
 const states=[],refs=[],deps=[],effects=[],cleanups=[];let cursor=0,refCursor=0,effectCursor=0;
 const ctx={_learnerLang:'English',React,...icons,lookupContext,lookupPrompt,parseLookup,cardFromLookup,draftCard,findExistingWord,defaultDeckId:d=>d[0]?.id||'',DeckPicker:()=>null,FORM_LABELS:{},extractJSON:JSON.parse,callClaude:call,setTimeout,pickModelForTag:()=>'test/model',localStorage:(()=>{const m={};return {getItem:k=>m[k]??null,setItem:(k,v)=>{m[k]=v;}};})(),
 useState:initial=>{const i=cursor++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},
 useRef:initial=>{const i=refCursor++;return refs[i]||(refs[i]={current:initial});},
 useEffect:(fn,next)=>{const i=effectCursor++;if(!deps[i]||next.some((v,n)=>v!==deps[i][n])){deps[i]=next;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
 vm.createContext(ctx);vm.runInContext(compiled,ctx);
 return {render(props){cursor=0;refCursor=0;effectCursor=0;return ctx.Component({word:'كتاب',decks:[],onClose(){},...props});},async flush(){while(effects.length)effects.shift()();await new Promise(resolve=>setImmediate(resolve));}};
}
const html=tree=>renderToStaticMarkup(tree);
function buttons(node,result=[]){if(!node||typeof node!=='object')return result;if(node.type==='button')result.push(node);React.Children.forEach(node.props?.children,child=>buttons(child,result));return result;}
test('context contains a late tapped word and accepts missing context',()=>{assert(lookupContext('كتاب','x'.repeat(1000)+'كتاب').includes('كتاب'));assert.equal(lookupContext('كتاب',null),'');assert(lookupPrompt('كتاب',undefined).includes('كتاب'));});
test('invalid or blank meanings never become saveable definitions',()=>{for(const value of [{},{meaning:''},{meaning:9},null])assert.throws(()=>parseLookup(JSON.stringify(value),'كتاب',JSON.parse));assert.equal(parseLookup('{"meaning":"book","root":{}}','كتاب',JSON.parse).root,'');});
test('failed request displays retry, then loads a valid meaning without reopening',async()=>{
 let calls=0;const h=harness(async()=>{if(++calls===1)throw Error('Provider unavailable');return '{"meaning":"book"}';});
 h.render();await h.flush();let tree=h.render();assert(html(tree).includes('Provider unavailable'));assert(!html(tree).includes('Add to Flashcards'));
 buttons(tree).find(b=>b.props.children==='Retry lookup').props.onClick();h.render();await h.flush();tree=h.render();assert(html(tree).includes('book'));assert(html(tree).includes('Add to Flashcards'));assert.equal(calls,2);
});
test('changing words resets loading and uses context even for the same word',async()=>{
 const calls=[];const h=harness(async prompt=>{calls.push(prompt);return '{"meaning":"book"}';});
 h.render();await h.flush();h.render({word:'بيت',context:'هذا بيت'});await h.flush();assert(html(h.render({word:'بيت',context:'هذا بيت'})).includes('book'));assert.equal(calls.length,2);
 h.render({word:'بيت',context:'بيت الشعر'});await h.flush();assert.equal(calls.length,3);
});

test('a late response from the previous word cannot overwrite the new lookup',async()=>{
 const requests=[];const h=harness(()=>new Promise(resolve=>requests.push(resolve)));
 h.render({word:'كتاب'});await h.flush();h.render({word:'بيت'});await h.flush();
 requests[1]('{"meaning":"house"}');await h.flush();assert(html(h.render({word:'بيت'})).includes('house'));
 requests[0]('{"meaning":"book"}');await h.flush();const result=html(h.render({word:'بيت'}));assert(result.includes('house'));assert(!result.includes('>book<'));
});

test('prompt asks for the learner language and keeps English as the default',()=>{
 assert(lookupPrompt('كتاب','x').includes('into English'));
 const bn=lookupPrompt('كتاب','x','Bengali');
 assert(bn.includes('into Bengali'));assert(bn.includes('"meaning":"Bengali meaning'));assert(bn.includes('English gloss'));
});
import {cardFromLookup,draftCard,lookupWordType} from './word-lookup.js';
import {findExistingWord} from './card-duplicates.js';
test('verb lookup becomes a full verb card with preposition, surface and untouched context',()=>{
 const data=parseLookup(JSON.stringify({word:'يَذْهَبُونَ',baseForm:'ذَهَبَ',meaning:'to go',partOfSpeech:'verb',past:'ذَهَبَ',present:'يَذْهَبُ',imperative:'اِذْهَبْ',preposition:'إِلَى',confidence:'high'}),'يَذْهَبُونَ',JSON.parse);
 const card=cardFromLookup(data,{surface:'يَذْهَبُونَ',context:'هُمْ يَذْهَبُونَ إِلَى المَدْرَسَةِ',sourceType:'video',sourceName:'Ep 3'});
 assert.equal(card.wordType,'verb');assert.equal(card.arabicBase,'ذَهَبَ');assert.equal(card.forms.harf,'إِلَى');assert.equal(card.forms.imperative,'اِذْهَبْ');
 assert.equal(card.source.text,'هُمْ يَذْهَبُونَ إِلَى المَدْرَسَةِ');assert.equal(card.source.name,'Ep 3');assert.equal(card.surface,'يَذْهَبُونَ');
});
test('noun lookup keeps singular base and plural; uncertain preposition is flagged, never invented',()=>{
 const data=parseLookup(JSON.stringify({baseForm:'كِتَاب',meaning:'book',partOfSpeech:'noun',plural:'كُتُب',confidence:'high'}),'الكُتُب',JSON.parse);
 const card=cardFromLookup(data,{surface:'الكُتُب'});
 assert.equal(card.forms.singular,'كِتَاب');assert.equal(card.forms.plural,'كُتُب');assert.equal(card.forms.harf,undefined);
 const v=cardFromLookup(parseLookup(JSON.stringify({baseForm:'رَغِبَ',meaning:'to desire',partOfSpeech:'verb',preposition:'فِي',prepositionUncertain:true}),'x',JSON.parse),{});
 assert.equal(v.prepositionUncertain,true);
});
test('missing base form can never be high confidence; draft cards are marked needsLookup',()=>{
 assert.notEqual(parseLookup('{"meaning":"x","confidence":"high"}','w',JSON.parse).confidence,'high');
 const d=draftCard({surface:'قَلَم',context:'ctx'});assert.equal(d.needsLookup,true);assert.equal(d.source.text,'ctx');assert.equal(lookupWordType({partOfSpeech:'adjective'}),'adjective');
});
test('add-time duplicate check ignores tashkeel and skips manual/grammar cards',()=>{
 const decks=[{id:'a',title:'Madinah'}],states={a:[{id:'1',wordType:'noun',arabicBase:'كِتَاب',forms:{}},{id:'2',wordType:'manual',arabicBase:'كتاب',forms:{}}]};
 const hit=findExistingWord(decks,states,'كتاب');assert.equal(hit.card.id,'1');assert.equal(hit.deckTitle,'Madinah');
 assert.equal(findExistingWord(decks,states,'قلم'),null);
});
