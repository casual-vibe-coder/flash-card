import test from 'node:test';
import assert from 'node:assert/strict';
import { arabicSearchQuery } from './watch-search.js';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};};
test('Arabic search needs no model and preserves category',async()=>{const r=await arabicSearchQuery('السوق','حوار',{translate:()=>{throw Error();}});assert.equal(r.q,'السوق حوار');assert(!r.warning);});
test('English translates once, caches case variants and category is appended after translation',async()=>{let calls=0;const options={storage:storage(),translate:async()=>{calls++;return '{"query":"السفر إلى الفضاء"}';}};assert.equal((await arabicSearchQuery('Space travel','وثائقي',options)).q,'السفر إلى الفضاء وثائقي');assert((await arabicSearchQuery('space TRAVEL','',options)).cached);assert.equal(calls,1);});
test('translation failure or invalid output preserves a usable original query',async()=>{for(const raw of ['oops','{"query":"English"}']){const r=await arabicSearchQuery('space','',{translate:async()=>raw});assert.equal(r.q,'space');assert(r.warning);}});
test('aborted translation cannot issue a stale search or populate the cache',async()=>{const controller=new AbortController();await assert.rejects(arabicSearchQuery('space','',{signal:controller.signal,translate:async()=>{controller.abort();return '{"query":"فضاء"}';}}),{name:'AbortError'});});
test('changed model and expired cache translate again',async()=>{let n=0;const opts={storage:storage(),translate:async()=>{n++;return '{"query":"فضاء"}';},now:1};await arabicSearchQuery('space','',opts);await arabicSearchQuery('space','',{...opts,model:'other'});await arabicSearchQuery('space','',{...opts,now:32*86400000});assert.equal(n,3);});
