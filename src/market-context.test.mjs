import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildMarketContext,candidateContext,sessionBoundary,priorContextSessions,collectContextHistoryTick} from './market-context.mjs';
import {readLocalJson} from './entry-watch-runtime.mjs';

const now=Date.parse('2026-10-09T14:30:02Z'),start=Date.parse('2026-10-09T13:30:00Z');
const bar=(time,price,volume=100)=>({begins_at:new Date(time).toISOString(),open_price:String(price-.01),high_price:String(price+.1),low_price:String(price-.1),close_price:String(price),volume,session:'reg'});
const minute=()=>Array.from({length:60},(_,i)=>bar(start+i*60000,100+i*.01));
const five=()=>Array.from({length:12},(_,i)=>bar(start+i*300000,100+i*.1,500));
function history(){return {sessions:Object.fromEntries(priorContextSessions('2026-10-09').slice(0,5).map(date=>[date,
  {date,close_minute:960,cumulative_volume:Array.from({length:390},(_,i)=>(i+1)*50),high:105,low:98}]))};}
test('context uses completed full-session data, explicitly estimated VWAP and matched-clock volume',()=>{
  const x=buildMarketContext({now,qqqPrice:101,oneMinuteBars:minute(),fiveMinuteBars:five(),history:history()});
  assert.equal(x.vwap.status,'available');assert.equal(x.vwap.position,'above');assert.ok(x.vwap.slope_5m>0);
  assert.equal(x.vwap.contains_positive_volume_inference,true);assert.match(x.vwap.method,/estimate/);
  assert.equal(x.relative_volume.ratio,2);assert.equal(x.relative_volume.sessions_used,5);
  assert.equal(x.relative_volume.coverage,'partial_history');assert.equal(x.trend_15m.status,'up');
  assert.equal(x.research_only,true);assert.equal(x.live_filter,false);
});
test('partial session, gap, zero/unknown volume and forming candles cannot create full VWAP or relative volume',()=>{
  for(const bars of [minute().slice(1),minute().filter((b,i)=>i!==15),minute().map(b=>({...b,volume:undefined})),minute().map(b=>({...b,volume:0}))]){
    const x=buildMarketContext({now,qqqPrice:101,oneMinuteBars:bars,fiveMinuteBars:five(),history:history()});
    assert.equal(x.vwap.status,'unknown');assert.equal(x.relative_volume.status,'unknown');
  }
  const x=buildMarketContext({now,qqqPrice:101,oneMinuteBars:[...minute(),bar(now,120)],fiveMinuteBars:[...five(),bar(now,120)],history:history()});
  assert.equal(x.vwap.bar_count,60);assert.equal(x.trend_15m.closes.at(-1).close,101.1);
});
test('obstacles are causal confirmed swings or previously closed session extremes',()=>{
  const x=buildMarketContext({now,qqqPrice:101,oneMinuteBars:minute(),fiveMinuteBars:five(),history:history()});
  const c=candidateContext(x,{direction:'call',level:100,qqqPrice:101});
  assert.equal(c.next_obstacle.price,105);assert.equal(c.room_to_obstacle,4);
  assert.ok(Date.parse(c.next_obstacle.known_at)<now);assert.equal(c.live_filter,false);
});
test('session boundaries respect daylight saving and prior sessions exclude current/future dates',()=>{
  assert.equal(sessionBoundary('2026-10-09',570),'2026-10-09T13:30:00.000Z');
  assert.equal(sessionBoundary('2026-11-02',570),'2026-11-02T14:30:00.000Z');
  assert.ok(priorContextSessions('2026-10-09').every(date=>date<'2026-10-09'));
});
test('historical lookup yields to pending entries and missing history does not strand all later dates',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-context-'));let calls=0;
  try{
    const read=async()=>{calls++;throw Error('No historical data');};
    assert.equal((await collectContextHistoryTick({folder,read,now,planPending:true})).reason,'pending_entry_plan_priority');assert.equal(calls,0);
    const first=await collectContextHistoryTick({folder,read,now});assert.equal(first.status,'unavailable');
    const second=await collectContextHistoryTick({folder,read,now:now+10000});assert.notEqual(first.date,second.date);
    assert.equal(Object.keys(readLocalJson(folder,'market-context-history.json').failures).length,2);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
