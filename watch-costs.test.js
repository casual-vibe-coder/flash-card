import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastWatch, CREDIT_RATES } from './watch-costs.js';
import { chatComplete } from './api/_openrouter.js';
test('forecast separates one caption credit from generated minutes and translation tokens',()=>{
  const c=forecastWatch(10,{in:0.15,out:0.5},0.01);
  assert.equal(c.captions,0.01);
  assert.equal(c.speechCredits,20);
  assert.equal(c.speech,0.2);
  assert.equal(c.english,0.02544);
  assert.ok(c.low<c.english&&c.high>c.english);
});
test('missing model prices stay unknown, free credits do not imply free translation',()=>{
  assert.equal(forecastWatch(10,null,0.01).english,null);
  const c=forecastWatch(5.1,{in:0.15,out:0.5},CREDIT_RATES.free.usd);
  assert.equal(c.speechCredits,12);
  assert.equal(c.speech,0);
  assert.ok(c.english>0);
});
test('OpenRouter reported charges include the internal empty-response retry',async()=>{
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=> (++calls===1
    ? {usage:{cost:0.001},choices:[{message:{content:''},finish_reason:'length'}]}
    : {usage:{cost:0.002},choices:[{message:{content:'translated'},finish_reason:'stop'}]})});
  try{
    const result=await chatComplete({apiKey:'test',model:'test',max_tokens:100,messages:[]});
    assert.equal(result.usage.cost,0.003);
    assert.equal(result.text,'translated');
  }finally{globalThis.fetch=original;}
});
test('unreported charges remain unknown rather than showing a free request',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:'done'}}]})});
  try {assert.equal((await chatComplete({apiKey:'test',model:'test',messages:[]})).usage.cost,null);}
  finally{globalThis.fetch=original;}
});
