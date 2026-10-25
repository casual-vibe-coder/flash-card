import test from 'node:test';
import assert from 'node:assert/strict';
import { captionWords, playbackPosition, lineEnd, alignedWordTimes, captionTime, videoTime } from './watch-timing.js';
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

test('keeps source word timing when breakdown merges attached particles',()=>{
  const lines=[{start:0,dur:10,words:[
    {text:'و',start:0,end:0.1},{text:'البيت',start:0.1,end:0.8},{text:'كبير',start:1,end:1.8}
  ]}];
  const breakdown=[{w:[{ar:'وَالْبَيْتُ'},{ar:'كَبِيرٌ'}]}];
  assert.deepEqual(alignedWordTimes(lines[0],breakdown[0].w),[{start:0,end:0.8},{start:1,end:1.8}]);
  assert.equal(playbackPosition(lines,breakdown,1.1).word,1); // not stretched over the 10-second display cue
  assert.equal(playbackPosition(lines,breakdown,0.9).word,-1); // speech pause
  assert.equal(playbackPosition(lines,breakdown,2).word,-1);
});
test('aligns split breakdown tokens without losing caption boundaries',()=>{
  const line={start:2,dur:4,words:[{text:'والبيت',start:2,end:3.2},{text:'كبير',start:4,end:5}]};
  const words=[{ar:'وَ'},{ar:'الْبَيْتُ'},{ar:'كَبِيرٌ'}];
  const times=alignedWordTimes(line,words);
  assert.equal(times[0].start,2);
  assert.ok(Math.abs(times[0].end-2.2)<1e-9);
  assert.equal(times[1].end,3.2);
  assert.equal(times[2].start,4);
  assert.equal(playbackPosition([line],[{w:words}],4.2).word,2);
});
test('fallback stays inside available speech times, not trailing caption display time',()=>{
  const lines=[{start:0,dur:20,words:[{text:'هذا',start:1,end:1.5},{text:'بيت',start:1.5,end:2}]}];
  const breakdown=[{w:[{ar:'هَذَا'},{ar:'الْبَيْتُ'}]}]; // differing wording cannot claim word alignment
  assert.equal(alignedWordTimes(lines[0],breakdown[0].w),null);
  assert.equal(playbackPosition(lines,breakdown,0.5).word,-1);
  assert.equal(playbackPosition(lines,breakdown,1.9).word,1);
  assert.equal(playbackPosition(lines,breakdown,2.1).word,-1);
});
test('does not accept incorrect or nonmonotonic source times as aligned',()=>{
  const w=[{ar:'مرحبا'}];
  assert.equal(alignedWordTimes({words:[{text:'مرحبا',start:1,end:NaN}]},w),null);
  assert.equal(alignedWordTimes({words:[{text:'مرحبا',start:2,end:3},{text:'بكم',start:1,end:2}]},[{ar:'مرحبا'},{ar:'بكم'}]),null);
});
test('highlighting, replay and looping share the same caption-offset clock',()=>{
  for(const offset of [-1.25,0,0.75]){
    const seek=videoTime(10,offset);
    assert.equal(captionTime(seek,offset),10);
    const lines=[{start:10,dur:2},{start:12,dur:2}];
    assert.equal(playbackPosition(lines,bd,captionTime(seek,offset)).index,0);
    assert.equal(captionTime(videoTime(lineEnd(lines,0),offset),offset),12);
  }
  assert.equal(videoTime(0,-1),0); // never seek before the video starts
});
test('uses player media time so different playback speeds do not accumulate drift',()=>{
  const lines=[{start:10,dur:2,words:[{text:'مرحبا',start:10,end:10.4},{text:'بكم',start:10.4,end:11}]}];
  for(const speed of [0.5,0.75,1,1.25,2]){
    const wallElapsed=0.6/speed,mediaTime=10+wallElapsed*speed;
    assert.equal(playbackPosition(lines,bd,mediaTime).word,1);
  }
});
