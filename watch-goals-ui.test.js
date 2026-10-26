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
function markup(records=[]){const module={exports:{}};const ctx={React,module,exports:module.exports,require:name=>name==='react'?{useState:initial=>[initial,()=>{}]}:name.includes('watch-goals')?goals:name.includes('watch-levels')?levels:progress};vm.createContext(ctx);vm.runInContext(code,ctx);return renderToStaticMarkup(ctx.module.exports.default({progress:{records,status:'Saved',owner:'user'}}));}
test('all-level view renders listening goals by level, without a combined goal or implied certification',()=>{const html=markup();for(const h of [75,100,200,250,300])assert(html.includes(' / '+h+' h'));assert(html.includes('not total language-study hours'));assert(html.includes('C2 has no next CEFR level'));assert(!html.includes('Save goal'));assert(html.includes('Check comprehension with unseen videos every 25 hours'));});
test('existing custom family goal is shown instead of overwriting it with a default',()=>{const html=markup([{kind:'goal',level:'cefr:B1',hours:125,updatedAt:Date.now()}]);assert(html.includes(' / 125 h'));assert(html.includes('Your target'));});
