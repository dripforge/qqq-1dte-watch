import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStop } from './emergency.mjs';
import { testArm as arm, testStop } from './protection-fixtures.mjs';

function harness(time='2026-10-09T13:45:01Z', initial=null) {
  let at=Date.parse(time),saved=initial;const sent=[],canceled=[];
  const broker={orders:async()=>[],order:async()=>null,cancel:async id=>{canceled.push(id);},
    optionQuote:async()=>({bid_price:'1.70',ask_price:'1.74',updated_at:new Date(at).toISOString()}),
    placeStop:async(args,{beforeSend}={})=>{beforeSend?.();sent.push(args);return {order:testStop(arm,{id:`stop-${sent.length}`,created:new Date(at).toISOString(),stopPrice:args.stop_price})};}};
  const intentStore={load:()=>saved,save:value=>{saved=value;}};
  return {broker,sent,canceled,saved:()=>saved,advance:ms=>{at+=ms;},clock:()=>at,
    check:(extra={})=>ensureStop({arm,broker,intentStore,clock:()=>at,...extra})};
}
const yesterday=()=>testStop(arm,{id:'old-stop',created:'2026-10-08T15:30:00Z'});

test('overnight carry keeps the arm and explicitly reports no live GFD protection',async()=>{
  const h=harness('2026-10-08T21:00:00Z');h.broker.orders=async()=>[yesterday()];
  h.broker.optionQuote=async()=>{throw Error('No regular market quote overnight');};
  const result=await h.check();assert.equal(result.status,'stop_unavailable_now');
  assert.equal(result.readiness.phase,'carry_waiting_session');assert.equal(result.readiness.broker_stop_verified,false);
  assert.equal(result.readiness.carry_mode,true);assert.equal(h.sent.length,0);assert.equal(h.canceled.length,0);
  assert.equal(h.saved().order_id,'old-stop');
});
test('9:30–9:45 relies on fresh local premium checks and leaves expired GFD orders untouched until broker rearm is allowed',async()=>{
  const h=harness('2026-10-09T13:30:02Z');h.broker.orders=async()=>[yesterday()];
  const result=await h.check();assert.equal(result.status,'local_premium_watch_only');
  assert.equal(result.readiness.ready_for_session,true);assert.equal(result.readiness.broker_stop_verified,false);
  assert.equal(result.readiness.local_coverage_verified,true);assert.equal(h.sent.length,0);assert.equal(h.canceled.length,0);
  assert.equal(h.saved().readiness.phase,'opening_local_watch');
});
test('a gap through the opening stop threshold requests the existing safe exit path immediately',async()=>{
  const h=harness('2026-10-09T13:35:00Z');h.broker.orders=async()=>[yesterday()];
  h.broker.optionQuote=async()=>({bid_price:'1.20',ask_price:'1.25',updated_at:new Date(h.clock()).toISOString()});
  const result=await h.check();assert.equal(result.needs_exit,true);assert.equal(result.reason,'emergency_premium');
  assert.equal(h.sent.length,0);assert.equal(h.canceled.length,0);
});
test('expired confirmed GFD stops renew only after cancellation is verified terminal with zero fills',async()=>{
  const h=harness(),old=yesterday();h.broker.orders=async()=>[old];
  h.broker.order=async()=>({...old,state:'cancelled',processed_quantity:'0',pending_quantity:'0'});
  const result=await h.check();assert.equal(result.status,'stop_armed');assert.deepEqual(h.canceled,['old-stop']);
  assert.equal(h.sent.length,1);assert.equal(h.sent[0].stop_price,'1.33');
  assert.equal(h.saved().replaces_verified_order_id,'old-stop');assert.equal(result.readiness.broker_stop_verified,true);
});
test('a wrong stop price is safely repaired after exact-identity cancellation and zero-fill proof',async()=>{
  const h=harness(),wrong=testStop(arm,{id:'wrong-stop',created:'2026-10-09T13:45:00Z',stopPrice:'1.20'});
  h.broker.orders=async()=>[wrong];h.broker.order=async()=>({...wrong,state:'cancelled',processed_quantity:'0',pending_quantity:'0'});
  const result=await h.check();assert.equal(result.status,'stop_armed');assert.deepEqual(h.canceled,['wrong-stop']);
  assert.equal(h.sent[0].stop_price,'1.33');assert.deepEqual(result.readiness.issues,[]);
});
test('wrong-contract, excess-quantity, or unknown-entry stops block replacement instead of canceling uncertain protection',async()=>{
  for(const change of [{quantity:'2'},{legs:[{...yesterday().legs[0],option_id:'other-contract'}]}]){
    const h=harness();h.broker.orders=async()=>[{...yesterday(),...change}];
    const result=await h.check();assert.equal(result.status,'stop_order_unverified');
    assert.equal(h.sent.length,0);assert.equal(h.canceled.length,0);
  }
  const h=harness();h.broker.orders=async()=>[yesterday()];
  const result=await h.check({entryFillVerified:false});assert.equal(result.status,'stop_order_unverified');
  assert.ok(result.readiness.issues.includes('entry_fill_unverified'));assert.equal(h.sent.length,0);assert.equal(h.canceled.length,0);
});
test('pending renewal cancellation does not repeat cancellation or create a fresh sell reference',async()=>{
  const h=harness(),old=yesterday();let final=false;
  h.broker.orders=async()=>[old];h.broker.order=async()=>final?{...old,state:'cancelled',processed_quantity:'0',pending_quantity:'0'}:
    {...old,state:'pending_cancelled'};
  assert.equal((await h.check()).status,'stop_rearm_pending');const reference=h.saved().ref_id;
  h.advance(5000);assert.equal((await h.check()).status,'stop_rearm_pending');
  assert.deepEqual(h.canceled,['old-stop']);assert.equal(h.saved().ref_id,reference);assert.equal(h.sent.length,0);
  final=true;h.advance(5000);assert.equal((await h.check()).status,'stop_armed');assert.equal(h.sent.length,1);
});
test('cancellation fill races and incomplete fill proof cannot produce a duplicate sell',async()=>{
  for(const finalState of [{state:'filled',processed_quantity:'1',pending_quantity:'0'},
    {state:'cancelled',processed_quantity:undefined,pending_quantity:'0'},
    {state:'cancelled',processed_quantity:'0.5',pending_quantity:'0'}]){
    const h=harness(),old=yesterday();h.broker.orders=async()=>[old];h.broker.order=async()=>({...old,...finalState});
    const result=await h.check();assert.equal(result.status,finalState.state==='filled'?'stop_filled_waiting_position':'stop_outcome_unknown');
    assert.equal(h.sent.length,0);
  }
});
test('slow cancellation refreshes a stale quote and acts on a new emergency breach before rearming',async()=>{
  const h=harness(),old=yesterday();let reads=0;h.broker.orders=async()=>[old];
  h.broker.order=async()=>{h.advance(15000);return {...old,state:'cancelled',processed_quantity:'0',pending_quantity:'0'};};
  h.broker.optionQuote=async()=>({bid_price:++reads===1?'1.70':'1.20',ask_price:reads===1?'1.74':'1.25',updated_at:new Date(h.clock()).toISOString()});
  const result=await h.check();assert.equal(reads,2);assert.equal(result.needs_exit,true);assert.equal(result.reason,'emergency_premium');
  assert.equal(h.sent.length,0);
});
test('queued stop dispatch rejects stale quotes locally and retries with identical approved broker arguments',async()=>{
  const h=harness();const argumentsSeen=[];let actualSends=0;
  h.broker.placeStop=async(args,{beforeSend})=>{argumentsSeen.push(args);if(argumentsSeen.length===1)h.advance(11000);
    beforeSend();actualSends++;return {order:testStop(arm,{created:new Date(h.clock()).toISOString(),stopPrice:args.stop_price})};};
  const blocked=await h.check();assert.equal(blocked.status,'stop_unavailable_now');assert.equal(blocked.local_not_sent,true);
  assert.equal(actualSends,0);const ref=h.saved().ref_id;
  assert.equal((await h.check()).status,'stop_armed');assert.equal(actualSends,1);
  assert.equal(h.saved().ref_id,ref);assert.deepEqual(argumentsSeen[0],argumentsSeen[1]);
});
test('three separately verified zero-fill rejections request the existing emergency safety exit',async()=>{
  const h=harness();let calls=0;
  h.broker.placeStop=async(args,{beforeSend})=>{beforeSend();return {order:testStop(arm,{id:`rejection-${++calls}`,state:'rejected',created:new Date(h.clock()).toISOString()})};};
  h.broker.order=async id=>testStop(arm,{id,state:'rejected',created:new Date(h.clock()-1000).toISOString()});
  for(let count=0;count<3;count++){assert.equal((await h.check()).status,'stop_rejected');h.advance(5000);}
  const result=await h.check();assert.equal(result.status,'stop_repeatedly_rejected');assert.equal(result.needs_exit,true);
  assert.equal(calls,3);assert.ok(result.readiness.issues.includes('stop_rearm_failed'));
});
test('pending broker stops still monitor premium and surface unconfirmed protection after thirty seconds',async()=>{
  const h=harness(),queued=testStop(arm,{state:'queued',created:'2026-10-09T13:45:00Z'});h.broker.orders=async()=>[queued];
  assert.equal((await h.check()).status,'stop_pending');h.advance(31000);
  const late=await h.check();assert.ok(late.readiness.issues.includes('stop_confirmation_delayed'));assert.equal(late.protection_ready,false);
  h.broker.optionQuote=async()=>({bid_price:'1.20',ask_price:'1.25',updated_at:new Date(h.clock()).toISOString()});
  assert.equal((await h.check()).needs_exit,true);assert.equal(h.sent.length,0);
});
test('null, empty, nonnumeric, crossed, future and stale quotes never trigger a spurious zero-bid emergency exit',async()=>{
  const changes=[{bid_price:null},{bid_price:''},{bid_price:' '},{bid_price:false},{bid_price:undefined},{bid_price:'NaN'},{ask_price:null},
    {bid_price:'1.75',ask_price:'1.70'},{updated_at:'2026-10-09T13:45:10Z'},{updated_at:'2026-10-09T13:44:40Z'}];
  for(const change of changes){
    const h=harness('2026-10-09T13:35:01Z');const baseline={bid_price:'1.70',ask_price:'1.74',updated_at:'2026-10-09T13:35:00Z'};
    h.broker.optionQuote=async()=>({...baseline,...change});const result=await h.check();
    assert.notEqual(result.needs_exit,true);assert.equal(result.readiness.local_coverage_verified,false);
    assert.ok(result.readiness.issues.includes('local_quote_unavailable'));assert.equal(h.sent.length,0);
  }
});
test('locally observed missing quotes remain visible across later fresh opening polls until broker rearm',async()=>{
  const h=harness('2026-10-09T13:30:02Z');h.broker.optionQuote=async()=>({bid_price:null,ask_price:'1.74',updated_at:new Date(h.clock()).toISOString()});
  assert.ok((await h.check()).readiness.issues.includes('opening_local_coverage_unverified'));
  h.advance(5000);h.broker.optionQuote=async()=>({bid_price:'1.70',ask_price:'1.74',updated_at:new Date(h.clock()).toISOString()});
  assert.ok((await h.check()).readiness.issues.includes('opening_local_coverage_unverified'));
});
test('an exact one-contract filled close prevents new selling even if its old stop price or entry basis is unverified',async()=>{
  const h=harness('2026-10-09T13:35:01Z');h.broker.orders=async()=>[];
  const filled=testStop(arm,{id:'filled-old-stop',state:'filled',stopPrice:'1.20'});
  const unknownBasis={...arm,opened_at:undefined,entry_fill_verified:false};
  const initial={option_id:arm.option_id,order_id:filled.id};let saved=initial;
  h.broker.order=async()=>filled;h.broker.optionQuote=async()=>{throw Error('Knownfilledstopshouldnotsellagain');};
  const result=await ensureStop({arm:unknownBasis,broker:h.broker,clock:h.clock,entryFillVerified:false,
    intentStore:{load:()=>saved,save:value=>{saved=value;}}});
  assert.equal(result.status,'stop_filled_waiting_position');assert.equal(result.needs_exit,undefined);assert.equal(h.sent.length,0);
});
