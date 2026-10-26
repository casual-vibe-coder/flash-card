import test from 'node:test';
import assert from 'node:assert/strict';
import { requestTranscript } from './watch-transcript.js';
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
test('native requests never initiate speech generation automatically',async()=>{
  const urls=[];
  await assert.rejects(requestTranscript('abcdefghijk',{fetcher:async url=>{urls.push(url);return response({error:'caption_blocked',canGenerate:true},422);}}),e=>e.canGenerate&&e.code==='caption_blocked');
  assert.equal(urls.length,1);assert(!urls[0].includes('generate=1'));
});
test('one paid request followed only by free job polling',async()=>{
  const urls=[],jobs=[];
  const fixtures=[response({pending:true,jobId:'job-1'},202),response({pending:true,jobId:'job-1'},202),response({lines:[{start:0,dur:1,text:'مرحبا'}]})];
  const value=await requestTranscript('abcdefghijk',{generate:true,fetcher:async url=>{urls.push(url);return fixtures.shift();},sleep:async()=>{},onJob:job=>jobs.push(job)});
  assert.equal(value.lines.length,1);assert.equal(urls.filter(x=>x.includes('generate=1')).length,1);assert(urls.slice(1).every(x=>x.includes('job=job-1')));assert.equal(jobs[0],'job-1');
});
test('resuming a stored job never starts another generation',async()=>{
  let url;
  await requestTranscript('abcdefghijk',{generate:true,jobId:'existing',fetcher:async u=>{url=u;return response({lines:[{text:'مرحبا'}]});}});
  assert(url.includes('job=existing'));assert(!url.includes('generate=1'));
});
test('polling limit retains the resumable job ID',async()=>{
  await assert.rejects(requestTranscript('abcdefghijk',{generate:true,maxPolls:1,sleep:async()=>{},fetcher:async()=>response({pending:true,jobId:'slow'},202)}),e=>e.code==='still_processing'&&e.pendingJob==='slow');
});
test('provider auth/credit failures are not disguised as missing captions',async()=>{
  await assert.rejects(requestTranscript('abcdefghijk',{generate:true,fetcher:async()=>response({error:'transcript_auth',canGenerate:false,detail:'Access needs checking.'},422)}),e=>!e.canGenerate&&e.message==='Access needs checking.');
});
