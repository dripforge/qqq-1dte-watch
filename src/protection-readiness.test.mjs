import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEmergencyStop, protectionReadiness } from './protection-readiness.mjs';
import { testArm as arm, testStop } from './protection-fixtures.mjs';
const now=new Date('2026-10-08T15:30:01Z');
function quote(at,bid='1.70'){return {bid_price:bid,ask_price:'1.74',updated_at:at};}

test('only the full exact approved single-contract stop is armed',()=>{
  const assessment=inspectEmergencyStop(testStop(),arm,{now});
  assert.equal(assessment.valid,true);assert.equal(assessment.broker_armed,true);
  for(const changes of [{quantity:'2'},{stop_price:'1.32'},{type:'limit'},{time_in_force:'gtc'},
    {market_hours:'regular_curb_hours'},{processed_quantity:'0.5'},{trade_value_multiplier:'10'},
    {chain_symbol:'SPY'},{created_at:null},{legs:[{...testStop().legs[0],side:'buy'}]},
    {legs:[testStop().legs[0],testStop().legs[0]]},{legs:[{...testStop().legs[0],ratio_quantity:2}]},
    {legs:[{...testStop().legs[0],option_id:'different-contract'}]}]){
    const invalid=inspectEmergencyStop({...testStop(),...changes},arm,{now});
    assert.equal(invalid.valid,false,JSON.stringify(changes));assert.equal(invalid.broker_armed,false);
  }
  assert.equal(inspectEmergencyStop(testStop(),arm,{now,entryFillVerified:false}).broker_armed,false);
});
test('wrong price or order type with exact safe close identity may be repaired after cancellation',()=>{
  assert.equal(inspectEmergencyStop(testStop(arm,{stopPrice:'1.20'}),arm,{now}).safe_to_replace,true);
  assert.equal(inspectEmergencyStop(testStop(arm,{type:'limit'}),arm,{now}).safe_to_replace,true);
  assert.equal(inspectEmergencyStop(testStop(arm,{quantity:'2'}),arm,{now}).safe_to_replace,false);
  assert.equal(inspectEmergencyStop(testStop(),arm,{now,entryFillVerified:false}).safe_to_replace,false);
});
test('GFD confirmed from yesterday or after its early closing bell cannot imply overnight broker protection',()=>{
  const tomorrow=new Date('2026-10-09T13:35:00Z');
  const expired=inspectEmergencyStop(testStop(),arm,{now:tomorrow});
  assert.equal(expired.valid,true);assert.equal(expired.renewal_required,true);assert.equal(expired.broker_armed,false);
  const earlyArm={...arm,expiration_date:'2026-11-30'};
  const early=inspectEmergencyStop(testStop(earlyArm,{created:'2026-11-27T15:00:00Z'}),earlyArm,
    {now:new Date('2026-11-27T18:00:00Z')});
  assert.equal(early.renewal_required,true);assert.equal(early.broker_armed,false);
});
test('carry state describes no live market protection and leaves overnight carry allowed',()=>{
  const readiness=protectionReadiness({arm,now:new Date('2026-10-08T21:00:00Z'),status:'stop_unavailable_now'});
  assert.equal(readiness.phase,'carry_waiting_session');assert.equal(readiness.carry_mode,true);
  assert.equal(readiness.ready_for_session,false);assert.equal(readiness.requires_live_monitor,true);
  assert.deepEqual(readiness.issues,[]);
});
test('fresh opening quotes verify current local coverage but sustained gaps remain visible until broker protection is armed',()=>{
  const start=new Date('2026-10-09T13:30:02Z');
  const first=protectionReadiness({arm,now:start,quote:quote(start.toISOString()),status:'local_premium_watch_only'});
  assert.equal(first.phase,'opening_local_watch');assert.equal(first.ready_for_session,true);
  const next=new Date('2026-10-09T13:30:29Z');
  const gap=protectionReadiness({arm,now:next,quote:quote(next.toISOString()),previous:first,status:'local_premium_watch_only'});
  assert.equal(gap.local_coverage_verified,true);assert.equal(gap.ready_for_session,false);
  assert.ok(gap.issues.includes('local_coverage_gap'));
  const later=new Date('2026-10-09T13:30:34Z');
  assert.ok(protectionReadiness({arm,now:later,quote:quote(later.toISOString()),previous:gap,status:'local_premium_watch_only'}).issues.includes('local_coverage_gap'));
});
test('stale opening data and a late first check cannot claim sustained local coverage',()=>{
  const checked=new Date('2026-10-09T13:30:35Z');
  const failed=protectionReadiness({arm,now:checked,quote:quote('2026-10-09T13:30:01Z'),status:'local_premium_watch_only'});
  assert.equal(failed.local_coverage_verified,false);assert.equal(failed.ready_for_session,false);
  assert.ok(failed.issues.includes('local_quote_unavailable'));assert.ok(failed.issues.includes('opening_coverage_started_late'));
  const fresh=new Date('2026-10-09T13:30:40Z');
  const next=protectionReadiness({arm,now:fresh,quote:quote(fresh.toISOString()),previous:failed,status:'local_premium_watch_only'});
  assert.ok(next.issues.includes('opening_local_coverage_unverified'));
});
test('rearming at 9:45 requires actual broker confirmation, even with a fresh local quote',()=>{
  const checked=new Date('2026-10-09T13:45:40Z');
  const pending=protectionReadiness({arm,now:checked,quote:quote(checked.toISOString()),status:'stop_pending',pendingAt:'2026-10-09T13:45:00Z'});
  assert.equal(pending.phase,'broker_rearm_required');assert.equal(pending.ready_for_session,false);
  assert.ok(pending.issues.includes('stop_confirmation_delayed'));
  const assessment=inspectEmergencyStop(testStop(arm,{created:'2026-10-09T13:45:30Z'}),arm,{now:checked});
  const protectedNow=protectionReadiness({arm,now:checked,orderAssessment:assessment,status:'stop_armed'});
  assert.equal(protectedNow.ready_for_session,true);assert.deepEqual(protectedNow.issues,[]);
});
