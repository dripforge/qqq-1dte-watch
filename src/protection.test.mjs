import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedDecision } from './protection.mjs';
test('a stale QQQ quote cannot skip independent broker premium protection',async()=>{
 let protectedCount=0;
 const r=await protectedDecision({readDecision:async()=>{throw Error('QQQ quote stale');},
  ensureProtection:async()=>{protectedCount++;return {status:'stop_armed'};}});
 assert.equal(protectedCount,1);assert.equal(r.decision.reason,'qqq_data_unavailable');assert.equal(r.protection.status,'stop_armed');
});
test('actionable invalidation exits do not wait for option protection',async()=>{
 const r=await protectedDecision({readDecision:async()=>({exit:true,reason:'qqq_invalidation'}),
  ensureProtection:async()=>{throw Error('must not delay urgent exit');}});
 assert.equal(r.decision.exit,true);assert.equal(r.protection,undefined);
});
test('option emergency exit can still act when QQQ data is unavailable',async()=>{
 const r=await protectedDecision({readDecision:async()=>{throw Error('QQQ unavailable');},
  ensureProtection:async()=>({needs_exit:true,reason:'emergency_premium',observed_at:'2026-10-08T15:30:00Z'})});
 assert.equal(r.decision.exit,true);assert.equal(r.decision.reason,'emergency_premium');
});
