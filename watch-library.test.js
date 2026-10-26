import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVideos, searchQuery, normalizeBreakdown, prepareWatchLesson } from './watch-library.js';
import { playbackPosition } from './watch-timing.js';
test('saved library search handles Arabic vowels, alef variants, English case and multiple terms',()=>{
  const videos=[{id:'one',title:'أَخْبَارُ الْعَالَمِ',channel:'Arabic News'},{id:'two',title:'Cooking at Home',channel:'Daily Arabic'}];
  assert.equal(filterVideos(videos,'اخبار العالم')[0].id,'one');
  assert.equal(filterVideos(videos,'ARABIC news')[0].id,'one');
  assert.equal(filterVideos(videos,'cooking daily')[0].id,'two');
  assert.equal(filterVideos(videos,'no match').length,0);
  assert.equal(filterVideos(videos,'').length,2);
});
test('video search uses the typed query without an AI call',()=>{
  assert.equal(searchQuery('  space exploration '),'space exploration');
  assert.equal(searchQuery('أخبار','وثائقي'),'أخبار وثائقي');
});
test('reorders reversed cached breakdowns without separating English from its Arabic token',()=>{
  const line={start:0,dur:2,text:'أذهب إلى السوق',words:[{text:'أذهب',start:0,end:.5},{text:'إلى',start:.5,end:1},{text:'السوق',start:1,end:2}]};
  const entry={tr:'I go to the market.',w:[{ar:'السُّوقِ',en:'the market'},{ar:'إِلَى',en:'to'},{ar:'أَذْهَبُ',en:'I go'}]};
  const fixed=normalizeBreakdown(line,entry);
  assert.deepEqual(fixed.w.map(w=>w.en),['I go','to','the market']);
  assert.equal(playbackPosition([line],[fixed],1.2).word,2);
  assert.equal(entry.w[0].en,'the market'); // does not mutate the stored source object
});
test('does not invent a match for changed wording or split glosses',()=>{
  const entry={w:[{ar:'كتاب',en:'book'},{ar:'هذا',en:'this'}]};
  assert.equal(normalizeBreakdown({text:'هذا بيت'},entry),entry);
});
test('sorts captions and associated translations together before binary-search playback',()=>{
  const lesson=prepareWatchLesson([{start:10,dur:2,text:'التالي'},{start:0,dur:2,text:'مرحبا'}],[{w:[{ar:'التالي',en:'next'}]},{w:[{ar:'مرحبا',en:'hello'}]}]);
  assert.deepEqual(lesson.lines.map(x=>x.start),[0,10]);
  assert.deepEqual(lesson.breakdown.map(x=>x.w[0].en),['hello','next']);
  assert.equal(playbackPosition(lesson.lines,lesson.breakdown,10.5).index,1);
});
