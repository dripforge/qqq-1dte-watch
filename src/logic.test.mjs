import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validateArm } from './logic.mjs';

const arm = { option_id: '00000000-0000-4000-8000-000000000001',
  option_type: 'call', expiration_date: '2026-10-09',
  qqq_invalidation: 750, entry_premium: 1.5, quantity: 1 };
const pos = { option_id: arm.option_id, type: 'long', quantity: '1',
  chain_symbol: 'QQQ', expiration_date: arm.expiration_date };
function quote(price, at) { return { results: [{ quote: { symbol: 'QQQ', state: 'active',
  has_traded: true, last_trade_price: String(price), venue_last_trade_time: at } }] }; }

test('call crosses at or below QQQ invalidation', () => {
  const now = new Date('2026-10-08T15:30:04Z');
  assert.equal(evaluate(arm, pos, quote(750, '2026-10-08T15:30:02Z'), now).exit, true);
  assert.equal(evaluate(arm, pos, quote(750.01, '2026-10-08T15:30:02Z'), now).exit, false);
});
test('put crosses at or above QQQ invalidation', () => {
  const put = { ...arm, option_type: 'put' };
  const now = new Date('2026-10-08T15:30:04Z');
  assert.equal(evaluate(put, pos, quote(750, '2026-10-08T15:30:02Z'), now).exit, true);
  assert.equal(evaluate(put, pos, quote(749.99, '2026-10-08T15:30:02Z'), now).exit, false);
});
test('stale quote and wrong position fail closed', () => {
  const now = new Date('2026-10-08T15:30:20Z');
  assert.throws(() => evaluate(arm, pos, quote(749, '2026-10-08T15:30:02Z'), now), /stale/);
  assert.throws(() => evaluate(arm, { ...pos, quantity: '2' }, quote(749, '2026-10-08T15:30:19Z'), now), /exactly one/);
});
test('expiration cutoff and contract cap', () => {
  const now = new Date('2026-10-09T19:45:00Z');
  assert.equal(evaluate(arm, pos, null, now).reason, 'expiration_cutoff');
  assert.throws(() => validateArm({ ...arm, entry_premium: 5.01 }), /premium/);
});
test('malformed QQQ prices never trigger an invalidation exit', () => {
  const now=new Date('2026-10-08T15:30:04Z');
  for(const value of [null,undefined,'',' ',false,true,0,-1,NaN,{},[]]){
    const response=quote(750,'2026-10-08T15:30:02Z');
    response.results[0].quote.last_trade_price=value;
    assert.throws(()=>evaluate(arm,pos,response,now),/invalid/,String(value));
  }
});
