import { levelInfo } from './watch-levels.js';
import { progressSummary } from './watch-progress.js';
// Product planning defaults, NOT measured Arabic listening-to-CEFR averages.
// Distinct from Cambridge/FSI overall study hours. Reassess comprehension every 25h.
export const LISTENING_GOALS=[
 {cefr:'A1',hours:75,next:'A2'}, {cefr:'A2',hours:100,next:'B1'},
 {cefr:'B1',hours:200,next:'B2'}, {cefr:'B2',hours:250,next:'C1'},
 {cefr:'C1',hours:300,next:'C2'}, {cefr:'C2',hours:null,next:null},
];
const SUB_GOALS={'b1-low':65,'b1-mid':65,'b1-high':70,'b2-low':80,'b2-mid':80,'b2-high':90};
export function suggestedGoal(level){
 if(level==='all'||level==='unrated')return null;
 if(SUB_GOALS[level])return SUB_GOALS[level];
 return LISTENING_GOALS.find(g=>g.cefr===(level.startsWith('cefr:')?level.slice(5):levelInfo(level).cefr))?.hours||null;
}
export const canonicalGoalLevel=level=>["a1","a2","c1","c2"].includes(level)?"cefr:"+level.toUpperCase():level;
export function listeningGoal(records,level){
 level=canonicalGoalLevel(level);
 const custom=records.filter(r=>r.kind==='goal'&&canonicalGoalLevel(r.level)===level&&Number.isFinite(r.hours)&&r.hours>0).sort((a,b)=>b.updatedAt-a.updatedAt)[0];
 const hours=custom?.hours||suggestedGoal(level),seconds=progressSummary(records,{level}).seconds;
 return {hours,seconds,custom:!!custom,percent:hours?Math.min(100,seconds/(hours*36)):0,reached:!!hours&&seconds>=hours*3600};
}
