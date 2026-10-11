import test from 'node:test';
import assert from 'node:assert/strict';
import {researchTradeSample} from './research-trade-sample.mjs';
import {marketSession} from './session.mjs';
const now=Date.parse('2026-10-09T14:30:02Z');
const arm={option_id:'11111111-1111-4111-8111-111111111111',option_type:'put',expiration_date:'2026-10-12',
  quantity:1,entry_premium:3,opened_at:'2026-10-09T14:20:00Z',entry_basis_verified:true,entry_fill_verified:true,qqq_invalidation:753};
const position={option_id:arm.option_id,chain_symbol:'QQQ',type:'long',quantity:'1',expiration_date:arm.expiration_date,opened_at:arm.opened_at};
test('future research sample retains actual basis, sizes and mandatory cutoff without any inferred fill/fees',()=>{
  const x=researchTradeSample({arm,position,option:{bid_size:4,ask_size:5},session:marketSession(new Date(now)),decision:{qqq_exit_level:752},now});
  assert.equal(x.position_verified,true);assert.equal(x.option_bid_size,4);assert.equal(x.emergency_stop_price,2.25);
  assert.equal(x.mandatory_exit_at,'2026-10-12T19:45:00.000Z');assert.equal(x.fees,null);assert.equal(x.entry_basis_verified,true);
});
test('missing quote sizes and unknown entry basis remain unavailable; replacement identity is never verified',()=>{
  const x=researchTradeSample({arm:{...arm,entry_basis_verified:false},position:{...position,option_id:'other'},option:{},session:marketSession(new Date(now)),decision:{},now});
  assert.equal(x.position_verified,false);assert.equal(x.option_bid_size,null);assert.equal(x.emergency_stop_price,null);
});
