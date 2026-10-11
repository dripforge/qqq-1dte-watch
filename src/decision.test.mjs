import test from 'node:test';
import assert from 'node:assert/strict';
import { decideExit } from './decision.mjs';

const arm = { option_id: '00000000-0000-4000-8000-000000000001',
  option_type: 'put', expiration_date: '2026-10-09',
  qqq_invalidation: 754, entry_premium: 1.5, quantity: 1 };
const position = { option_id: arm.option_id, type: 'long', quantity: '1',
  chain_symbol: 'QQQ', expiration_date: arm.expiration_date };
const now = new Date('2026-10-08T15:30:04Z');
const quote = price => ({ results: [{ quote: { symbol: 'QQQ', state: 'active',
  has_traded: true, last_trade_price: String(price),
  venue_last_trade_time: '2026-10-08T15:30:02Z' } }] });

test('tightened level exits a profitable put before the original invalidation', () => {
  const result = decideExit({ arm, position, quote: quote(753), now,
    profitPlan: { option_id: arm.option_id, qqq_trailing_level: 753 } });
  assert.equal(result.exit, true);
  assert.equal(result.reason, 'qqq_profit_trail');
  assert.equal(result.qqq_exit_level, 753);
});

test('profit sell request queues an exit without another QQQ quote', () => {
  const requestedAt = '2026-10-08T15:30:03Z';
  const result = decideExit({ arm, position, quote: null, now,
    profitRequest: { option_id: arm.option_id, requested_at: requestedAt } });
  assert.equal(result.reason, 'profit_discretion');
  assert.equal(result.observed_at, requestedAt);
});

test('existing exit intent wins over a later profit request', () => {
  const result = decideExit({ arm, position, quote: null, now,
    pendingExit: { option_id: arm.option_id, reason: 'qqq_invalidation',
      breach_at: '2026-10-08T15:30:01Z' },
    profitRequest: { option_id: arm.option_id, requested_at: '2026-10-08T15:30:03Z' } });
  assert.equal(result.reason, 'qqq_invalidation');
});

test('a gap beyond both tightened and original levels remains a profit trail exit',()=>{
 const result=decideExit({arm,position,quote:quote(754.10),now,
  profitPlan:{option_id:arm.option_id,qqq_trailing_level:753}});
 assert.equal(result.exit,true);assert.equal(result.reason,'qqq_profit_trail');
});
test('old profit instructions for the same option cannot affect a new trade',()=>{
 const currentArm={...arm,trade_id:'new'};
 const result=decideExit({arm:currentArm,position,quote:quote(753),now,
  profitPlan:{option_id:arm.option_id,trade_id:'old',qqq_trailing_level:753},
  profitRequest:{option_id:arm.option_id,trade_id:'old',requested_at:now.toISOString()}});
 assert.equal(result.exit,false);assert.equal(result.qqq_exit_level,754);
});
