import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEntryIntent} from './entry-recovery.mjs';
import {assessPositionOwnership,confirmPositionOwnership,assertPositionOwnership,
  assertOwnedPositionSnapshot,positionFromCompleteSnapshot,confirmedOldClosure} from './position-ownership.mjs';

const at=Date.parse('2026-10-09T14:00:00Z'),now=at+60000;
const arm={option_id:'00000000-0000-4000-8000-000000000001',trade_id:'00000000-0000-4000-8000-000000000002',
  option_type:'call',expiration_date:'2026-10-12',quantity:1,entry_premium:4,qqq_invalidation:746};
const intent={...prepareEntryIntent({arm,setupId:'setup',policySnapshot:{revision:1},now:at}),
  dispatch_phase:'dispatch_started',dispatch_started_at:new Date(at+100).toISOString(),dispatch_attempts:1};
const position={chain_symbol:'QQQ',option_id:arm.option_id,type:'long',quantity:'1',trade_value_multiplier:'100',
  expiration_date:arm.expiration_date,average_price:'390',opened_at:new Date(at+1000).toISOString()};
const input=(changes={})=>({arm,intent,position,now,...changes});
const pinned=()=>confirmPositionOwnership(input()).arm;

test('first position binds exact broker lifetime and cost without inventing a fill or changing risk',()=>{
  const confirmed=confirmPositionOwnership(input());
  assert.equal(confirmed.assessment.owned,true);assert.equal(confirmed.changed,true);
  assert.equal(confirmed.arm.broker_position_opened_at,position.opened_at);
  assert.equal(confirmed.arm.position_owner_trade_id,arm.trade_id);
  assert.equal(confirmed.arm.position_cost_at_bind,390);
  assert.equal(confirmed.arm.entry_premium,4);assert.equal(confirmed.arm.entry_fill_verified,undefined);
  assert.equal(confirmed.arm.qqq_invalidation,746);assert.equal(arm.broker_position_opened_at,undefined);
  assert.throws(()=>assertPositionOwnership(input()),/must be persisted/);
  assert.equal(assertPositionOwnership(input({arm:confirmed.arm})).owned,true);
});

test('verified fill allows tiny broker open-time offset only while first pin is established',()=>{
  const known={...intent,order_id:'buy',fill_checked:true,fill_price:3.9,filled_at:new Date(at+1000).toISOString()};
  const slightlyDifferent={...position,opened_at:new Date(at+1003).toISOString()};
  const confirmed=confirmPositionOwnership(input({intent:known,position:slightlyDifferent}));
  assert.equal(confirmed.assessment.owned,true);
  const changed=assessPositionOwnership(input({arm:confirmed.arm,intent:known,
    position:{...slightlyDifferent,opened_at:new Date(at+1004).toISOString()}}));
  assert.equal(changed.status,'position_ownership_changed');
  assert.equal(changed.reason,'broker_position_lifetime_changed');
});

test('manual close and reopen of the identical contract/quantity/cost cannot reuse the old arm',()=>{
  const old=pinned(),replacement={...position,opened_at:new Date(at+20000).toISOString()};
  assert.throws(()=>assertPositionOwnership(input({arm:old,position:replacement})),error=>
    error.code==='LOCAL_PREFLIGHT'&&error.ownership_status==='position_ownership_changed');
  const refused=confirmPositionOwnership(input({arm:old,position:replacement}));
  assert.equal(refused.changed,false);assert.equal(refused.arm,old);
  assert.equal(refused.arm.broker_position_opened_at,position.opened_at);
});

test('sub-millisecond lifecycle changes remain distinct; equivalent timezone formatting stays identical',()=>{
  const precise={...position,opened_at:'2026-10-09T14:00:01.123456Z'};
  const old=confirmPositionOwnership(input({position:precise})).arm;
  assert.equal(assessPositionOwnership(input({arm:old,position:{...precise,opened_at:'2026-10-09T10:00:01.123456-04:00'}})).owned,true);
  assert.equal(assessPositionOwnership(input({arm:old,position:{...precise,opened_at:'2026-10-09T14:00:01.123457Z'}})).status,'position_ownership_changed');
});

test('an unfilled initial entry can protect the exact timely position without any history reads',()=>{
  const result=confirmPositionOwnership(input());
  assert.equal(result.assessment.binding_basis,'bounded_original_entry_time');
  assert.equal(result.assessment.owned,true);
  for(const changed of [{...intent,dispatch_phase:'prepared',dispatch_started_at:undefined},
    {...intent,local_not_sent:true},{...intent,ref_id:'another-intent'}]) {
    assert.equal(assessPositionOwnership(input({intent:changed})).owned,false);
  }
  assert.equal(assessPositionOwnership(input({position:{...position,opened_at:new Date(at+126000).toISOString()},now:at+130000})).owned,false);
});

test('old verified position-cost lifetime permits safe migration but not a replacement',()=>{
  const recovered={...arm,entry_basis_verified:true,entry_basis_source:'broker_position_cost',entry_premium:3.9,opened_at:position.opened_at};
  assert.equal(confirmPositionOwnership(input({arm:recovered})).assessment.owned,true);
  assert.equal(assessPositionOwnership(input({arm:recovered,position:{...position,opened_at:new Date(at+20000).toISOString()}})).status,'position_ownership_changed');
});

test('unknown, impossible or future broker open time blocks old protective and discretionary actions',()=>{
  const old=pinned();
  for(const opened_at of [undefined,null,'not-known','2026-02-30T14:00:00Z','2026-10-08T24:00:00Z',new Date(now+6000).toISOString()]) {
    const assessment=assessPositionOwnership(input({arm:old,position:{...position,opened_at}}));
    assert.equal(assessment.owned,false);assert.equal(assessment.status,'position_ownership_unverified');
    assert.throws(()=>assertPositionOwnership(input({arm:old,position:{...position,opened_at}})));
  }
});

test('material cost alteration or position size/type/contract changes block prior ownership',()=>{
  const old=pinned();
  for(const changed of [{...position,quantity:'2'},{...position,type:'short'},{...position,option_id:'another'},
    {...position,trade_value_multiplier:'10'},{...position,expiration_date:'2026-10-13'},
    {...position,average_price:'391.01'},{...position,average_price:'401.01'}]) {
    assert.equal(assessPositionOwnership(input({arm:old,position:changed})).status,'position_ownership_changed');
  }
  assert.equal(assessPositionOwnership(input({arm:old,position:{...position,average_price:'391.00'}})).owned,true);
  assert.equal(assessPositionOwnership(input({arm:old,position:{...position,average_price:'389.00'}})).owned,true);
});

test('fee tolerance is bounded to one total contract dollar, never one dollar of option premium',()=>{
  const known={...intent,order_id:'buy',fill_checked:true,fill_price:3.9,filled_at:position.opened_at};
  assert.equal(confirmPositionOwnership(input({intent:known,position:{...position,average_price:'391'}})).assessment.owned,true);
  assert.equal(confirmPositionOwnership(input({intent:known,position:{...position,average_price:'392'}})).assessment.owned,false);
});

test('incomplete/malformed position snapshots never prove flatness or authorize a close',()=>{
  const old=pinned();
  for(const snapshot of [{positions:[position],next:'more'},{positions:null},{positions:[null]},
    {positions:[{...position,quantity:null}]},{positions:[position,position]}]) {
    assert.throws(()=>assertOwnedPositionSnapshot({...input({arm:old}),snapshot}));
  }
  assert.equal(positionFromCompleteSnapshot({positions:[]},old),null);
  assert.throws(()=>assertOwnedPositionSnapshot({...input({arm:old}),snapshot:{positions:[]}}),error=>error.ownership_status==='position_absent');
  assert.equal(assertOwnedPositionSnapshot({...input({arm:old}),snapshot:{positions:[position]}}).owned,true);
});

test('final async snapshot recheck after earlier reads blocks both old place and cancel when user reopens',async()=>{
  const old=pinned();let sent=0,cancelled=0;
  for(const action of ['place','cancel']) {
    const beforeSend=async()=>{
      const snapshot=await Promise.resolve({positions:[{...position,opened_at:new Date(at+30000).toISOString()}]});
      assertOwnedPositionSnapshot({...input({arm:old}),snapshot});
    };
    await assert.rejects((async()=>{await beforeSend();if(action==='place')sent++;else cancelled++;})(),error=>error.ownership_status==='position_ownership_changed');
  }
  assert.equal(sent,0);assert.equal(cancelled,0);
});

const close=(change={})=>({id:'manual-close',state:'filled',chain_symbol:'QQQ',direction:'credit',quantity:'1',processed_quantity:'1',
  trade_value_multiplier:'100',processed_premium:'410',last_transaction_at:new Date(at+19000).toISOString(),
  legs:[{option_id:arm.option_id,side:'sell',position_effect:'close',ratio_quantity:1,expiration_date:arm.expiration_date,option_type:'call',
    executions:[{price:'4.10',quantity:'1',timestamp:new Date(at+19000).toISOString()}]}],...change});
const closureInput=()=>({arm:{...pinned(),entry_basis_verified:true,entry_basis_source:'broker_order_fill',entry_premium:3.9},
  order:close(),replacementPosition:{...position,opened_at:new Date(at+20000).toISOString()},now});

test('verified old manual close is recordable once but never cancels or archives replacement state',()=>{
  const proof=confirmedOldClosure(closureInput());
  assert.equal(proof.old_close_verified,true);assert.equal(proof.realized_pnl,20);
  assert.equal(proof.archive_safe,false);assert.equal(proof.replacement_present,true);
  assert.equal(proof.required_action,'retain_position_ownership_changed_alert');
  assert.equal(confirmedOldClosure({...closureInput(),recordedClosureKeys:[proof.closure_key]}).already_recorded,true);
});

test('old close proof requires full exact leg/fill chronology and cannot describe a sell after replacement as old close',()=>{
  for(const change of [{...closureInput(),order:close({processed_quantity:'0'})},
    {...closureInput(),order:close({legs:[close().legs[0],close().legs[0]]})},
    {...closureInput(),order:close({legs:[{...close().legs[0],executions:[{price:'4.1',quantity:'1',timestamp:new Date(at+21000).toISOString()}]}]})},
    {...closureInput(),order:close({processed_premium:'411'})},
    {...closureInput(),replacementPosition:{...position,opened_at:null}}]) {
    assert.equal(confirmedOldClosure(change),null);
  }
});

test('verified old sell never fabricates returns from an unverified entry estimate',()=>{
  const data=closureInput();data.arm.entry_basis_verified=false;
  const proof=confirmedOldClosure(data);
  assert.equal(proof.exit_premium_total,410);assert.equal(proof.realized_pnl,null);
  assert.equal(proof.pnl_basis,'unverified_entry_basis');assert.equal(proof.archive_safe,false);
});
