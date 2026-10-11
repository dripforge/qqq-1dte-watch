import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareEntryIntent, validateEntryIntent, recoverEntry, dispatchEntry,
  verifiedEntryFill, verifiedPositionEntryBasis, readAllEntryOrders, priorityEntryExit } from './entry-recovery.mjs';

const now = Date.parse('2026-10-08T17:00:10Z');
const created = now - 10000;
const arm = {option_id:'00000000-0000-4000-8000-000000000001',trade_id:'00000000-0000-4000-8000-000000000002',
  option_type:'put',expiration_date:'2026-10-09',quantity:1,entry_premium:4.00};
const prepared = () => prepareEntryIntent({arm,setupId:'setup',policySnapshot:{revision:1},now:created});
const sent = () => ({...prepared(),dispatch_phase:'dispatch_started',dispatch_started_at:new Date(created+100).toISOString(),dispatch_attempts:1});
const order = (change={}) => ({id:'buy-original',ref_id:arm.trade_id,quantity:'1',type:'limit',trigger:'immediate',price:'4.00',
  direction:'debit',market_hours:'regular_hours',time_in_force:'gfd',trade_value_multiplier:'100',state:'confirmed',
  processed_quantity:'0',processed_premium:'0',created_at:new Date(created+1000).toISOString(),
  last_transaction_at:new Date(now-1000).toISOString(),legs:[{option_id:arm.option_id,side:'buy',position_effect:'open',ratio_quantity:1}],...change});
const fill = (change={}) => order({state:'filled',processed_quantity:'1',processed_premium:'390',
  legs:[{option_id:arm.option_id,side:'buy',position_effect:'open',ratio_quantity:1,
    executions:[{price:'3.90',quantity:'1',timestamp:new Date(now-1000).toISOString()}]}],...change});
const broker = pages => ({ordersPage:async()=>({orders:pages}),order:async()=>null});

test('lost buy response recovers one original reference after every history page',async()=>{
  let saved, calls=0;
  const result=await recoverEntry({intent:sent(),arm,now,save:value=>saved=value,broker:{
    ordersPage:async args=>{calls++;return args.cursor?{orders:[order()]}:{orders:[order({id:'other',ref_id:'other'})],next:'page2'};},
    order:async()=>assert.fail('unknown order ID must not be guessed'),
  }});
  assert.equal(calls,2); assert.equal(result.status,'entry_pending');
  assert.equal(saved.order_id,'buy-original'); assert.equal(saved.ref_id,arm.trade_id);
  assert.equal(saved.created_at,new Date(created).toISOString());
});

test('missing broker reference or empty history remains unknown and never places',async()=>{
  for(const orders of [[],[order({ref_id:undefined})]]) {
    let saved=false;
    const result=await recoverEntry({intent:sent(),arm,now,save:()=>saved=true,broker:{...broker(orders),place:()=>assert.fail('recovery cannot submit a buy')}});
    assert.equal(result.status,'entry_outcome_unknown'); assert.equal(saved,false);
  }
});

test('crash before dispatch is provably unsent only after entry owner is gone',async()=>{
  const neverRead={order:()=>assert.fail('no order ID'),ordersPage:()=>assert.fail('not dispatched')};
  assert.equal((await recoverEntry({intent:prepared(),arm,broker:neverRead,entryProcessActive:true,now})).status,'entry_preparing');
  const dead=await recoverEntry({intent:prepared(),arm,broker:neverRead,entryProcessActive:false,now});
  assert.equal(dead.verified_not_sent,true);
  const ambiguous=await recoverEntry({intent:{...sent(),local_not_sent:true},arm,broker:broker([]),now});
  assert.equal(ambiguous.status,'entry_outcome_unknown');
});

test('filled original order verifies real premium/time instead of original ask',async()=>{
  const result=await recoverEntry({intent:sent(),arm,broker:broker([fill()]),now});
  assert.equal(result.status,'entry_filled'); assert.equal(result.fill.premium,3.90);
  assert.equal(result.fill.filled_at,new Date(now-1000).toISOString());
  assert.equal(result.fill.order_id,'buy-original');
});

test('known-ID recovery works without broker reference and refuses another ID',async()=>{
  const intent={...sent(),order_id:'buy-original'};
  const result=await recoverEntry({intent,arm,now,broker:{order:async()=>fill({ref_id:undefined}),ordersPage:()=>assert.fail('known ID')}});
  assert.equal(result.fill.premium,3.9);
  await assert.rejects(recoverEntry({intent,arm,now,broker:{order:async()=>order({id:'different'}),ordersPage:()=>assert.fail('known ID')}}),/saved order ID/);
});

test('normal rejection or cancellation archives only explicit verified zero fills',async()=>{
  for(const state of ['rejected','cancelled','failed','voided']) {
    const result=await recoverEntry({intent:sent(),arm,broker:broker([order({state})]),now});
    assert.equal(result.status,'entry_not_filled'); assert.equal(result.verified_zero_fill,true);
  }
  for(const processed_quantity of [null,'bad','0.5','1']) {
    await assert.rejects(recoverEntry({intent:sent(),arm,broker:broker([order({state:'cancelled',processed_quantity})]),now}),/unverified/);
  }
});

test('duplicate reference, malformed page and incomplete pagination cannot adopt an order',async()=>{
  await assert.rejects(recoverEntry({intent:sent(),arm,broker:broker([order(),order({id:'second'})]),now}),/more than one/);
  await assert.rejects(recoverEntry({intent:sent(),arm,broker:{ordersPage:async()=>({orders:null})},now}),/incomplete/);
  await assert.rejects(readAllEntryOrders({ordersPage:async()=>({orders:[],next:'same'})},new Date(created).toISOString()),/pagination/);
  let n=0;
  await assert.rejects(readAllEntryOrders({ordersPage:async()=>({orders:[],next:`page${++n}`})},new Date(created).toISOString(),{maxPages:2}),/complete-search/);
});

test('matching reference cannot disguise a wrong contract, price, side or multi-leg order',async()=>{
  for(const wrong of [order({price:'4.01'}),order({quantity:'2'}),order({state:'mystery'}),
    order({created_at:new Date(created-6000).toISOString()}),
    order({legs:[{...order().legs[0],side:'sell'}]}),order({legs:[{...order().legs[0],option_id:'other'}]}),
    order({legs:[order().legs[0],order().legs[0]]})]) {
    await assert.rejects(recoverEntry({intent:sent(),arm,broker:broker([wrong]),now}),/blocked/);
  }
});

test('fill records reject incomplete, over-limit, inconsistent or future executions',()=>{
  const intent=sent();
  for(const wrong of [fill({processed_premium:'400'}),fill({processed_quantity:'0'}),fill({processed_premium:null}),
    fill({legs:[{...fill().legs[0],executions:[]}]}),
    fill({legs:[{...fill().legs[0],executions:[{price:'4.01',quantity:'1',timestamp:new Date(now-1000).toISOString()}]}]}),
    fill({legs:[{...fill().legs[0],executions:[{price:'3.9',quantity:'1',timestamp:new Date(now+6000).toISOString()}]}]})]) {
    assert.throws(()=>verifiedEntryFill(wrong,intent,arm,{now}),/blocked/);
  }
});

test('position cost fallback proves contract units/time but does not invent order or execution identity',()=>{
  const position={chain_symbol:'QQQ',option_id:arm.option_id,expiration_date:arm.expiration_date,type:'long',quantity:'1',
    trade_value_multiplier:'100',average_price:'390',opened_at:new Date(now-1000).toISOString()};
  const basis=verifiedPositionEntryBasis(position,sent(),arm,{now});
  assert.equal(basis.premium,3.9); assert.equal(basis.basis,'broker_position_cost');
  assert.equal(basis.execution_fill_verified,false); assert.equal(basis.order_identity_verified,false); assert.equal(basis.fees,null);
  for(const invalid of [{...position,trade_value_multiplier:null},{...position,quantity:'2'},
    {...position,average_price:'-390'},{...position,average_price:'401'},
    {...position,opened_at:new Date(created-6000).toISOString()}]) {
    assert.throws(()=>verifiedPositionEntryBasis(invalid,sent(),arm,{now}),/blocked/);
  }
});

test('one exact same-reference retry after lost response preserves original time and never duplicates identity',async()=>{
  let saved=prepared(), attempts=0; const argumentsSeen=[];
  const dispatch=retry=>dispatchEntry({intent:saved,arm,now:()=>now,retry,save:value=>saved=value,
    preflight:()=>{},place:async(args,beforeSend)=>{
      beforeSend(); argumentsSeen.push(structuredClone(args)); attempts++;
      assert.equal(saved.dispatch_phase,'dispatch_started');
      if(attempts===1)throw new Error('lost response after server accepted');
      return {order:order()};
    }});
  await assert.rejects(dispatch(false),/lost response/);
  const result=await dispatch(true);
  assert.equal(result.order.id,'buy-original'); assert.deepEqual(argumentsSeen[0],argumentsSeen[1]);
  assert.equal(saved.dispatch_attempts,2); assert.equal(saved.created_at,new Date(created).toISOString());
  await assert.rejects(dispatch(true),/not eligible/); assert.equal(attempts,2);
});

test('late, ineligible or changed arguments block replay before any buy submission',async()=>{
  let calls=0;
  const run=(intent,at=now,preflight=()=>{})=>dispatchEntry({intent,arm,retry:true,now:()=>at,save:()=>{},preflight,
    place:()=>{calls++;assert.fail('blocked replay cannot place');}});
  await assert.rejects(run(sent(),created+120001),/not eligible/);
  await assert.rejects(run(sent(),now,()=>{throw new Error('policy or account risk changed');}),/risk changed/);
  const changed=sent(); changed.submission_args.price='3.99';
  await assert.rejects(run(changed),/changed/);
  const unsafe=sent(); unsafe.submission_args.account_number='private';
  await assert.rejects(run(unsafe),/malformed/);
  assert.equal(calls,0);
});

test('prepared submission cannot be altered by the transport or a later quote',async()=>{
  let saved=prepared();
  await assert.rejects(dispatchEntry({intent:saved,arm,now:()=>now,save:value=>saved=value,preflight:()=>{},
    place:async(args,beforeSend)=>{beforeSend();args.price='4.50';return {order:order()};}}),TypeError);
  assert.equal(saved.submission_args.price,'4.00');
  assert.equal(validateEntryIntent(saved,arm).price,'4.00');
});

test('mandatory, pending, invalidation and existing trail exits run before any fill/history research',async()=>{
  for(const reason of ['expiration_cutoff','qqq_invalidation','qqq_profit_trail']) {
    const calls=[];
    const result=await priorityEntryExit({readPrimaryDecision:async()=>{calls.push('primary');return {exit:true,reason};},
      submitPrimaryExit:async decision=>{calls.push('sell');assert.equal(decision.reason,reason);}});
    if(!result.priority_exit)await recoverEntry({intent:sent(),arm,broker:{ordersPage:()=>assert.fail('history must not delay risk exit')},now});
    assert.deepEqual(calls,['primary','sell']); assert.equal(result.priority_exit,true);
  }
  const holding=await priorityEntryExit({readPrimaryDecision:async()=>({exit:false,reason:'holding'}),submitPrimaryExit:()=>assert.fail('holding cannot submit')});
  assert.equal(holding.priority_exit,false);
  const noData=await priorityEntryExit({readPrimaryDecision:async()=>{throw new Error('stale QQQ quote');},submitPrimaryExit:()=>assert.fail('no guessed exit')});
  assert.equal(noData.primary_error,'stale QQQ quote');
});

test('opening-order research has one short overall budget and cannot claim empty history on timeout',async()=>{
  await assert.rejects(readAllEntryOrders({ordersPage:()=>new Promise(()=>{})},new Date(created).toISOString(),{budgetMs:10}),/time budget/);
});
