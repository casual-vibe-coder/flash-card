import test from 'node:test';
import assert from 'node:assert/strict';
import { indexCards, mergeDeckCards } from './card-merge.js';
const c=(id,lr=0,x={})=>({id,srsLastReview:lr,...x});

test('stale device does not roll back reviews made elsewhere', () => {
  const seen = indexCards([c('a',100),c('b',100)]);   // what the phone last saw
  const phone = [c('a',100),c('b',100)];               // stale copy
  const cloud = [c('a',500),c('b',100)];               // desktop reviewed a
  const out = mergeDeckCards([c('a',100),c('b',900)], cloud, seen); // phone reviews b
  assert.equal(out.find(x=>x.id==='a').srsLastReview, 500);
  assert.equal(out.find(x=>x.id==='b').srsLastReview, 900);
  assert.notEqual(out, phone);
});
test('local wins when cloud copy is what we already saw (undo)', () => {
  const out = mergeDeckCards([c('a',100)], [c('a',500)], indexCards([c('a',500)]));
  assert.equal(out[0].srsLastReview, 100);
});
test('cards added elsewhere are kept, cards deleted here are dropped', () => {
  const seen = indexCards([c('a',1),c('gone',1)]);
  const out = mergeDeckCards([c('a',1),c('new',2)], [c('a',1),c('gone',1),c('other',3)], seen);
  assert.deepEqual(out.map(x=>x.id).sort(), ['a','new','other']);
});
test('returns the cloud array itself when nothing differs (even if key order does)', () => {
  const cloud=[{id:'a',srsLastReview:5,forms:{x:1,y:2}}];
  const local=[{forms:{y:2,x:1},srsLastReview:5,id:'a'}];
  assert.equal(mergeDeckCards(local, cloud, indexCards(cloud)), cloud);
});
test('empty/undefined inputs', () => {
  assert.deepEqual(mergeDeckCards(undefined, undefined, undefined), []);
  assert.deepEqual(mergeDeckCards([c('a')], [], undefined).map(x=>x.id), ['a']);
});
