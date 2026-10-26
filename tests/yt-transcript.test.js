import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { normalizeSupadata } from '../api/yt-transcript.js';
const id='abcdefghijk';
const response=(data,status=200)=>({ok:status>=200&&status<300,status,text:async()=>typeof data==='string'?data:JSON.stringify(data),json:async()=>data});
const res=()=>({code:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.code=n;return this;},json(data){this.body=data;return this;}});
async function scenario(query,fetcher,configured=true){const original=globalThis.fetch,old=process.env.SUPADATA_API_KEY,oldAlias=process.env.SUPA_API_KEY;globalThis.fetch=fetcher;if(configured)process.env.SUPADATA_API_KEY='test';else delete process.env.SUPADATA_API_KEY;delete process.env.SUPA_API_KEY;try{const out=res();await handler({query:{v:id,...query}},out);return out;}finally{globalThis.fetch=original;if(old===undefined)delete process.env.SUPADATA_API_KEY;else process.env.SUPADATA_API_KEY=old;if(oldAlias===undefined)delete process.env.SUPA_API_KEY;else process.env.SUPA_API_KEY=oldAlias;}}
const nativePlayer=()=>response('<script>var ytInitialPlayerResponse = '+JSON.stringify({playabilityStatus:{status:'OK'},videoDetails:{title:'Arabic sample'},captions:{playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:'ar',baseUrl:'https://captions.test/?fmt=json3'}]}}})+';</script>');
test('direct captions retain word timestamps and need no configured paid provider',async()=>{
 const result=await scenario({},async url=>url.includes('youtube.com/watch')?nativePlayer():response({events:[{tStartMs:1000,dDurationMs:2000,segs:[{utf8:'مرحبا ',tOffsetMs:0},{utf8:'بكم',tOffsetMs:1000}]}]}),false);
 assert.equal(result.code,200);assert.equal(result.body.lines[0].words[1].start,2);
});
test('blocked native captions + Supadata unavailable (206) offer speech, never start it',async()=>{
 const urls=[];const result=await scenario({},async url=>{urls.push(url);if(url.includes('youtube.com/watch'))return response('',403);return response({error:'transcript-unavailable'},206);});
 assert.equal(result.body.error,'no_captions');assert.equal(result.body.canGenerate,true);assert(urls.some(x=>x.includes('mode=native')));assert(!urls.some(x=>x.includes('mode=generate')));assert.equal(result.headers['Cache-Control'],'no-store');
});
test('an empty direct caption track is not reported as a successful transcript',async()=>{
 const result=await scenario({},async url=>url.includes('youtube.com/watch')?nativePlayer():url.includes('captions.test')?response({events:[]}):response({error:'transcript-unavailable'},206));
 assert.equal(result.body.canGenerate,true);assert(result.body.error);
});
test('explicit generate is the only route that starts paid generation',async()=>{
 const urls=[];const result=await scenario({generate:'1'},async url=>{urls.push(url);return response({jobId:'new-job'},202);});
 assert.equal(result.code,202);assert.equal(result.body.jobId,'new-job');assert.equal(urls.length,1);assert(urls[0].includes('mode=generate'));assert.equal(result.headers['Cache-Control'],'no-store');
});
test('polling accepts completed nested results and sorts caption times',async()=>{
 const result=await scenario({job:'existing'},async url=>{assert(url.endsWith('/existing'));return response({status:'completed',result:{lang:'ar',content:[{offset:1000,duration:1000,text:'ثانيا'},{offset:0,duration:1000,text:'أولا'}]}});});
 assert.equal(result.code,200);assert.deepEqual(result.body.lines.map(x=>x.start),[0,1]);
});
test('failed and unknown job states stop polling instead of remaining pending forever',async()=>{
 for(const status of ['failed','unexpected']){const result=await scenario({job:'existing'},async()=>response({status}));assert(result.body.error);assert(!result.body.pending);}
});
test('provider access and credit failures are visible and disable generation',async()=>{
 for(const status of [401,403,402,429]){const result=await scenario({generate:'1'},async()=>response({error:'blocked'},status));assert(result.body.error);assert.equal(result.body.canGenerate,false);}
});
test('missing speech configuration explains the unavailable option without a paid call',async()=>{
 let calls=0;const result=await scenario({generate:'1'},async()=>{calls++;throw Error('unexpected');},false);
 assert.equal(calls,0);assert.equal(result.body.setupRequired,true);assert.equal(result.body.canGenerate,false);
});
test('normalisation rejects empty, untimed or non-Arabic provider output',()=>{
 assert.equal(normalizeSupadata({lang:'ar',content:[]},id).error,'no_speech');
 assert.equal(normalizeSupadata({lang:'ar',content:[{text:'مرحبا'}]},id).error,'no_speech');
 assert.equal(normalizeSupadata({lang:'en',content:[{offset:0,duration:1000,text:'hello'}]},id).error,'no_arabic_captions');
});

test('expired jobs stop polling and permit an explicit new request',async()=>{
 const result=await scenario({job:'expired'},async()=>response({error:'not-found'},404));assert.equal(result.body.error,'job_expired');assert.equal(result.body.canGenerate,true);assert(!result.body.pending);
});
