import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import * as goals from './watch-goals.js';
import * as levels from './watch-levels.js';
import * as progress from './watch-progress.js';
const source=fs.readFileSync(new URL('./WatchProgress.jsx',import.meta.url),'utf8');
const code=transformSync(source,{loader:'jsx',jsxFactory:'React.createElement',format:'cjs'}).code;
function markup(records=[],level='all'){const module={exports:{}};const ctx={React,module,exports:module.exports,require:name=>name==='react'?{useState:initial=>[initial==='all'?level:initial,()=>{}]}:name.includes('watch-goals')?goals:name.includes('watch-levels')?levels:progress};vm.createContext(ctx);vm.runInContext(code,ctx);return renderToStaticMarkup(ctx.module.exports.default({progress:{records,status:'Saved',owner:'user'}}));}
test('all-level view renders listening goals by level, without a combined goal or implied certification',()=>{const html=markup();for(const h of [75,100,65,70,80,90,300])assert(html.includes(' / '+h+' h'));assert(html.includes('not total language-study hours'));assert(html.includes('B1 · Lower'));assert(html.includes('65.0 h remaining'));assert(html.includes('Next comprehension spot check: 25 h'));assert(html.includes('C2 has no next CEFR level'));assert(!html.includes('Save goal'));assert(html.includes('Check comprehension with unseen videos every 25 hours'));});
test('existing custom family goal is shown instead of overwriting it with a default',()=>{const html=markup([{kind:'goal',level:'cefr:B1',hours:125,updatedAt:Date.now()}],'cefr:B1');assert(html.includes(' / 125 h'));assert(html.includes('Your target'));});

test('tier progress shows remaining hours and the next 25-hour check from lifetime viewing',()=>{const seconds=30*3600;const html=markup([{kind:'session',id:'s',videoId:'v',levelId:'b1-low',seconds,days:{[new Date().toISOString().slice(0,10)]:{seconds,ranges:[]}}}]);assert(html.includes('30.00 / 65 h'));assert(html.includes('35.0 h remaining'));assert(html.includes('Next comprehension spot check: 50 h (20.0 h away)'));});
