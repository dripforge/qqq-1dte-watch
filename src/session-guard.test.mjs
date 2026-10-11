import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionSubmissionGuard } from './session-guard.mjs';
import { withBrokerAccess } from './broker-access.mjs';
import { submitExit } from './orderflow.mjs';
import { testStop } from './protection-fixtures.mjs';
import { ensureStop } from './emergency.mjs';

const arm = { option_type:'call',opened_at:'2026-11-27T14:45:00Z',option_id: '00000000-0000-4000-8000-000000000001', expiration_date: '2026-11-30', entry_premium: 1.5 };
function store() { let value; return {load:()=>value,save:item=>{value=item;}}; }
function localBlock(error) { return error.code === 'LOCAL_PREFLIGHT'; }

test('dispatch guard permits urgent early-session closes but holds new stops until 9:45', () => {
  const clock=()=>Date.parse('2026-11-27T14:35:00Z');
  assert.equal(sessionSubmissionGuard(arm,{clock})().is_open,true);
  assert.throws(sessionSubmissionGuard(arm,{clock,stop:true}),localBlock);
  assert.equal(sessionSubmissionGuard(arm,{clock:()=>Date.parse('2026-11-27T14:45:00Z'),stop:true})().is_open,true);
});

test('dispatch guard rejects closed, holiday, unsupported and expired sessions locally', () => {
  for (const time of ['2026-11-27T18:00:00Z','2026-11-26T16:00:00Z','2029-01-02T16:00:00Z','2026-12-01T16:00:00Z']) {
    assert.throws(sessionSubmissionGuard(arm,{clock:()=>Date.parse(time)}),localBlock);
  }
  assert.throws(sessionSubmissionGuard({...arm,expiration_date:'2029-01-02'},
    {clock:()=>Date.parse('2026-11-27T16:00:00Z')}),localBlock);
});

async function lockedQueue(action) {
  const folder=mkdtempSync(join(tmpdir(),'qqq-dispatch-guard-'));
  const lockPath=join(folder,'broker.lock');
  let releaseLock, held;
  const blockerGate=new Promise(resolve=>{releaseLock=resolve;});
  const lockHeld=new Promise(resolve=>{held=resolve;});
  const blocker=withBrokerAccess(async()=>{held();await blockerGate;},{lockPath});
  await lockHeld;
  try { return await action({lockPath,releaseLock,blocker}); }
  finally { releaseLock();await blocker;rmSync(folder,{recursive:true,force:true}); }
}

test('a real broker lock delaying an exit past either closing bell records no local send', async () => {
  for (const [before,after,expiration] of [
    ['2026-10-08T19:59:55Z','2026-10-08T20:00:05Z','2026-10-09'],
    ['2026-11-27T17:59:55Z','2026-11-27T18:00:05Z','2026-11-27'],
  ]) {
    await lockedQueue(async({lockPath,releaseLock,blocker})=>{
      let time=Date.parse(before),sent=0;
      const contract={...arm,expiration_date:expiration};
      const intentStore=store();
      const guard=sessionSubmissionGuard(contract,{clock:()=>time});
      const pending=submitExit({arm:contract,decision:{reason:'qqq_invalidation',observed_at:before},intentStore,clock:()=>time,
        broker:{orders:async()=>[],position:async()=>({quantity:'1'}),
          place:args=>withBrokerAccess(()=>{guard();sent++;return {order:{id:'sent',state:'confirmed'}};},{lockPath})}});
      await new Promise(resolve=>setTimeout(resolve,10));
      time=Date.parse(after);releaseLock();await blocker;
      const result=await pending;
      assert.equal(sent,0);
      assert.equal(result.status,'exit_waiting_market');
      assert.equal(result.local_not_sent,true);
      assert.equal(intentStore.load().attempts.at(-1).outcome,'local_not_sent');
      assert.equal(intentStore.load().order_id,undefined);
      assert.equal(result.first_accepted_submission_at,null);
      assert.equal(result.expiration_window_missed,expiration==='2026-11-27');
      assert.ok(intentStore.load().ref_id);
    });
  }
});

test('a real broker lock delaying a stop past an early close retains its exact reference', async () => {
  await lockedQueue(async({lockPath,releaseLock,blocker})=>{
    let time=Date.parse('2026-11-27T17:59:55Z'),sent=0;
    const intentStore=store();
    const guard=sessionSubmissionGuard(arm,{clock:()=>time,stop:true});
    const broker={orders:async()=>[],optionQuote:async()=>({bid_price:'1.50',ask_price:'1.54',updated_at:new Date(time).toISOString()}),
      placeStop:args=>withBrokerAccess(()=>{guard();sent++;return {order:testStop(arm,{id:'stop',created:new Date(time).toISOString(),stopPrice:args.stop_price})};},{lockPath})};
    const pending=ensureStop({arm,broker,intentStore,clock:()=>time});
    await new Promise(resolve=>setTimeout(resolve,10));
    time=Date.parse('2026-11-27T18:00:05Z');releaseLock();await blocker;
    const result=await pending;
    assert.equal(sent,0);
    assert.equal(result.status,'stop_unavailable_now');
    assert.equal(result.local_not_sent,true);
    const reference=intentStore.load().ref_id,price=intentStore.load().stop_price;
    assert.ok(reference);
    assert.equal(intentStore.load().order_id,undefined);
    // The next verified session can reuse the same proven-unsent arguments.
    time=Date.parse('2026-11-30T15:00:00Z');
    assert.equal((await ensureStop({arm,broker,intentStore,clock:()=>time})).status,'stop_armed');
    assert.equal(intentStore.load().ref_id,reference);
    assert.equal(intentStore.load().stop_price,price);
    assert.equal(intentStore.load().local_not_sent,false);
    assert.equal(sent,1);
  });
});

test('locally blocked exit retries preserve reference and submission arguments without timing credit', async () => {
  let time=Date.parse('2026-11-27T17:59:55Z'),placements=0;
  const intentStore=store(),argumentsSeen=[];
  const broker={orders:async()=>[],position:async()=>({quantity:'1'}),place:async args=>{
    argumentsSeen.push(args);
    if(placements++===0){time=Date.parse('2026-11-27T18:00:05Z');sessionSubmissionGuard(arm,{clock:()=>time})();}
    return {order:{id:'actual-exit',state:'confirmed'}};
  }};
  const input={arm,decision:{reason:'qqq_invalidation',observed_at:'2026-11-27T17:59:54Z'},broker,intentStore,clock:()=>time};
  assert.equal((await submitExit(input)).status,'exit_waiting_market');
  const reference=intentStore.load().ref_id;
  time=Date.parse('2026-11-30T15:00:00Z');
  const result=await submitExit(input);
  assert.equal(result.status,'exit_submitted');
  assert.equal(result.deadline_met,false);
  assert.equal(intentStore.load().ref_id,reference);
  assert.deepEqual(argumentsSeen[0],argumentsSeen[1]);
  assert.deepEqual(intentStore.load().attempts.map(attempt=>attempt.outcome),['local_not_sent','accepted']);
  assert.equal(intentStore.load().local_not_sent,false);
});
