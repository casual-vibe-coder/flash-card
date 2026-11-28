import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transformSync} from 'esbuild';
import * as icons from 'lucide-react';
import {cardFromLookup} from './word-lookup.js';
const source=fs.readFileSync(new URL('./App.jsx',import.meta.url),'utf8');
const start=source.indexOf('let _deckApi='),end=source.indexOf('function WordPopup(',start);
const compiled=transformSync(source.slice(start,end)+'\nglobalThis.api={DeckPicker,ManualCardForm,ManualFace,buildManualCard,refactorMerge,defaultDeckId,_deckApi};',{loader:'jsx',jsxFactory:'React.createElement'}).code;
const ctx={React,...icons,useState:React.useState,useEffect:()=>{},FORM_LABELS:{past:'Past'},lookupWord:async()=>({}),cardFromLookup,RefreshCw:icons.RefreshCw};
vm.createContext(ctx);vm.runInContext(compiled,ctx);
const {DeckPicker,ManualCardForm,ManualFace,buildManualCard,refactorMerge,defaultDeckId}=ctx.api;
const html=n=>renderToStaticMarkup(n);

test('capture deck is the default; falls back to first vocab deck; grammar decks never default',()=>{
 const decks=[{id:'g',title:'G',deckType:'grammar'},{id:'a',title:'A'},{id:'b',title:'B',isCapture:true}];
 assert.equal(defaultDeckId(decks),'b');
 assert.equal(defaultDeckId([decks[0],decks[1]]),'a');
 assert.equal(defaultDeckId([]),'');
});
test('deck picker marks the capture deck and offers inline new-deck creation',()=>{
 const out=html(React.createElement(DeckPicker,{decks:[{id:'a',title:'Madinah'},{id:'b',title:'Capture',isCapture:true}],value:'b',onChange(){}}));
 assert(out.includes('★ Capture'));assert(out.includes('New deck'));assert(out.includes('Madinah'));
});
test('manual card saves front/back/reference exactly as typed and never gets generated fields',()=>{
 const typed='  بِسْمِ اللَّهِ  \nالرَّحْمَنِ ';
 const card=buildManualCard({id:'c1'},{cardType:'hadith',front:typed,back:'In the name of God',reference:'Bukhari 1',notes:''});
 assert.equal(card.front,typed);assert.equal(card.back,'In the name of God');assert.equal(card.wordType,'manual');assert.equal(card.isManual,true);
 assert.equal(JSON.stringify(card.forms),'{}');assert.equal(card.status,'new');assert.equal(card.reference,'Bukhari 1');
 // editing the back leaves the front untouched
 const edited=buildManualCard(card,{cardType:'hadith',front:card.front,back:'changed',reference:card.reference,notes:''});
 assert.equal(edited.front,typed);assert.equal(edited.back,'changed');assert.equal(edited.id,'c1');
});
test('manual form needs only Front and a deck; edit form is pre-filled and has no deck picker',()=>{
 const add=html(React.createElement(ManualCardForm,{decks:[{id:'a',title:'A'}],onSave(){},onBack(){}}));
 assert(add.includes('Add Hadith / Verse'));assert(add.includes('disabled'));assert(add.includes('Saved exactly as typed'));
 const edit=html(React.createElement(ManualCardForm,{initial:{id:'c1',cardType:'hadith',front:'F-text',back:'B-text'},decks:[],onSave(){},onBack(){}}));
 assert(edit.includes('F-text')&&edit.includes('B-text'));assert(!edit.includes('Choose a deck'));
});
test('review faces show the typed text, with reference and notes only on the back',()=>{
 const card={cardType:'quran_verse',front:'الفاتحة',back:'The Opening',reference:'1:1',notes:'n1'};
 const f=html(React.createElement(ManualFace,{card,side:'front'})),b=html(React.createElement(ManualFace,{card,side:'back'}));
 assert(f.includes('الفاتحة')&&!f.includes('1:1'));assert(b.includes('The Opening')&&b.includes('1:1')&&b.includes('n1'));
});
test('re-factor keeps sentence, notes, review state and aids; clears needsLookup; wrong plural is fixed',()=>{
 const card={id:'c9',wordType:'noun',arabicBase:'كتب',english:'book',forms:{singular:'كتب',plural:'كتابات',synonym:'مصحف'},notes:'my note',
  source:{text:'قرأت الكُتُب',type:'sentence',name:''},srsReps:4,srsNextReview:99,status:'known',aidByForm:{singular:{sentence:'x'}},needsLookup:true};
 const next=cardFromLookup({word:'الكُتُب',baseForm:'كِتَاب',meaning:'book',partOfSpeech:'noun',plural:'كُتُب',confidence:'high'},{surface:'الكُتُب',context:card.source.text});
 const m=refactorMerge(card,next);
 assert.equal(m.arabicBase,'كِتَاب');assert.equal(m.forms.plural,'كُتُب');assert.equal(m.forms.synonym,'مصحف');
 assert.equal(m.notes,'my note');assert.equal(m.source.text,'قرأت الكُتُب');assert.equal(m.srsReps,4);assert.equal(m.status,'known');assert.deepEqual(m.aidByForm,card.aidByForm);
 assert.equal(m.needsLookup,undefined);assert.equal(m.id,'c9');
});
