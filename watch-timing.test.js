import test from 'node:test';
import assert from 'node:assert/strict';
import { captionWords, playbackPosition, lineEnd } from './watch-timing.js';
const bd=[{w:[{ar:'مَرْحَبًا'},{ar:'بِكُمْ'}]},{w:[{ar:'التالي'}]}];
test('preserves segment offsets and matches vowelized breakdown',()=>{
  const words=captionWords({tStartMs:1000,dDurationMs:3000,segs:[{utf8:'مرحبا ',tOffsetMs:0},{utf8:'بكم',tOffsetMs:1500}]});
  assert.deepEqual(words,[{text:'مرحبا',start:1,end:2.5},{text:'بكم',start:2.5,end:4}]);
  const lines=[{start:1,dur:3,words}];
  assert.equal(playbackPosition(lines,bd,2.4).word,0);
  assert.equal(playbackPosition(lines,bd,2.5).word,1);
  assert.equal(playbackPosition(lines,bd,4).word,-1);
});
test('overlapping cues stop at the next start without anticipating speech',()=>{
  const lines=[{start:1,dur:8},{start:3,dur:1}];
  assert.equal(lineEnd(lines,0),3);
  assert.deepEqual(playbackPosition(lines,bd,0.9),{index:-1,word:-1});
  assert.equal(playbackPosition(lines,bd,2.99).index,0);
  assert.deepEqual(playbackPosition(lines,bd,3),{index:1,word:0});
  assert.deepEqual(playbackPosition(lines,bd,5),{index:1,word:-1});
  assert.equal(playbackPosition(lines,bd,1.1).index,0); // backward seek
});
test('does not invent precise timestamps for untimed captions',()=>{
  assert.equal(captionWords({segs:[{utf8:'مرحبا بكم'}]}),undefined);
});
