import test from 'node:test';
import assert from 'node:assert/strict';
import {findDuplicateGroups,entryKey,preferredEntry,applyDuplicateChoices,undoDuplicateChanges} from './card-duplicates.js';
const decks=[{id:'a',title:'One'},{id:'b',title:'Two'}];
const card=(id,extra={})=>({id,wordType:'noun',arabicBase:'كِتَاب',english:'Book',...extra});
test('matches formatting differences but keeps meanings, word types and blank entries separate',()=>{
 const states={a:[card('1'),card('2',{arabicBase:' كـتاب ',english:'  BOOK. '}),card('3',{english:'writing'}),card('4',{wordType:'verb'}),card('5',{arabicBase:'',english:''}),card('6',{wordType:'grammar'})]};
 const groups=findDuplicateGroups(decks,states);assert.equal(groups.length,1);assert.equal(groups[0].entries.length,2);
});
test('same ID across decks is scoped, missing forms merge and the chosen schedule stays intact',()=>{
 const states={a:[card('same',{forms:{singular:'كِتَاب'},srsReps:20,srsLastReview:100,srsNextReview:200})],b:[card('same',{forms:{plural:'كُتُب'},srsReps:1,srsLastReview:300,srsNextReview:500,note:'saved note'})]};
 const groups=findDuplicateGroups(decks,states),winner=preferredEntry(groups[0].entries);
 assert.equal(winner.deckId,'a');
 const result=applyDuplicateChoices(states,groups,{[groups[0].key]:entryKey(winner)});
 assert.equal(result.states.b.length,0);assert.equal(result.states.a.length,1);
 assert.deepEqual(result.states.a[0].forms,{singular:'كِتَاب',plural:'كُتُب'});
 assert.equal(result.states.a[0].srsNextReview,200);assert.equal(result.states.a[0].note,'saved note');
 assert.deepEqual(undoDuplicateChanges(result.states,result.changes),states);
});
test('skipped and stale groups remove nothing; undo preserves subsequent edits and new cards',()=>{
 const states={a:[card('1')],b:[card('2')]},groups=findDuplicateGroups(decks,states),choices={[groups[0].key]:entryKey(groups[0].entries[0])};
 assert.deepEqual(applyDuplicateChoices(states,groups,{}).states,states);
 const edited={...states,b:[card('2',{english:'different'})]};assert.deepEqual(applyDuplicateChoices(edited,groups,choices).states,edited);
 const result=applyDuplicateChoices(states,groups,choices);
 const later={...result.states,a:[{...result.states.a[0],english:'edited'},card('new')]};
 const undone=undoDuplicateChanges(later,result.changes);assert.equal(undone.a[0].english,'edited');assert.equal(undone.a.length,2);assert.deepEqual(undone.b,states.b);
});
