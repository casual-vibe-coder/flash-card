import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/yt-search.js';
const res=()=>({code:200,setHeader(){},status(n){this.code=n;return this;},json(data){this.body=data;return this;}});
const response=(body,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body});
async function scenario(query,fetcher,google=true,supa=true){const original=globalThis.fetch;const keys=['YOUTUBE_API_KEY','SUPADATA_API_KEY','SUPA_API_KEY'];const saved=keys.map(k=>process.env[k]);if(google)process.env.YOUTUBE_API_KEY='test';else delete process.env.YOUTUBE_API_KEY;if(supa)process.env.SUPADATA_API_KEY='test';else delete process.env.SUPADATA_API_KEY;delete process.env.SUPA_API_KEY;globalThis.fetch=fetcher;try{const out=res();await handler({query:{q:'فضاء',...query}},out);return out;}finally{globalThis.fetch=original;keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}}
const hit={id:{videoId:'abcdefghijk'},snippet:{title:'Arabic space',channelTitle:'Channel'}};
test('search includes videos without captions by default and keeps matching query text',async()=>{
 let query;const out=await scenario({q:'  space travel  '},async url=>{if(url.includes('/search?')){query=new URL(url);return response({items:[hit],nextPageToken:'next'});}return response({items:[]});});
 assert.equal(query.searchParams.get('q'),'space travel');assert.equal(query.searchParams.get('videoCaption'),'any');assert.equal(out.body.items.length,1);assert.equal(out.body.next,'next');
});
test('caption filter is explicit and pagination stays encoded',async()=>{
 await scenario({captions:'1',pageToken:'a+b&c'},async url=>{const u=new URL(url);assert.equal(u.searchParams.get('videoCaption'),'closedCaption');assert.equal(u.searchParams.get('pageToken'),'a+b&c');return response({items:[]});});
});
test('duration lookup failure does not remove valid video results',async()=>{
 const out=await scenario({},async url=>{if(url.includes('/search?'))return response({items:[hit]});throw Error('metadata failed');});assert.equal(out.body.items[0].id,'abcdefghijk');assert.equal(out.body.items[0].durationSec,0);
});
test('missing key and quota failure report configuration errors instead of empty results',async()=>{
 let calls=0;const missing=await scenario({},async()=>{calls++;throw Error();},false);assert.equal(calls,0);assert.equal(missing.code,503);assert.equal(missing.body.canUseTranscriptSearch,true);
 const quota=await scenario({},async()=>response({error:{message:'quota'}},403));assert.equal(quota.code,502);assert.equal(quota.body.error,'youtube_error');assert(!quota.body.items);
});
test('paid transcript-service search is only used by explicit provider selection',async()=>{
 let url;const out=await scenario({provider:'supadata'},async u=>{url=new URL(u);return response({results:[{type:'video',id:'abcdefghijk',title:'عنوان',channel:{name:'قناة'},duration:120}],nextPageToken:'next'});},false);
 assert.equal(url.hostname,'api.supadata.ai');assert.equal(url.searchParams.get('limit'),null);assert.equal(out.body.items[0].durationSec,120);assert.equal(out.body.provider,'supadata');assert.equal(out.body.next,'next');
});
