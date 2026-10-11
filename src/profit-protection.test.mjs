import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfitProtectionPlan, evaluateProfitProtection, validateProfitProtectionEvidence } from './profit-protection.mjs';

const AT = Date.parse('2026-10-08T18:00:10Z');
const arm = { option_id: '11111111-1111-4111-8111-111111111111', trade_id: '22222222-2222-4222-8222-222222222222',
  option_type: 'call', quantity: 1, expiration_date: '2026-10-09', entry_premium: 2,
  entry_basis_verified: true, opened_at: '2026-10-08T18:00:00Z' };
const position = { option_id: arm.option_id, chain_symbol: 'QQQ', type: 'long', quantity: '1.00000', expiration_date: arm.expiration_date };
const session = { verified: true, is_open: true, date: '2026-10-08' };
function plan(mode = 'scalp', target = arm) { return createProfitProtectionPlan({ arm: target,
  evidence: { version: 1, mode, rationale: 'Completed support break with brief momentum follow-through' }, now: AT - 11000 }); }
function quote(bid = 2.2, spread = .02, at = AT) { return { instrument_id: arm.option_id,
  bid_price: bid.toFixed(2), ask_price: (bid + spread).toFixed(2), bid_size: '10.0000', ask_size: '8', updated_at: new Date(at).toISOString() }; }
function evaluate(extra = {}) { return evaluateProfitProtection({ arm, position, session, plan: plan(), quote: quote(), now: AT, ...extra }); }

test('initial plan exists before purchase but activation waits for verified actual fill and matching position', () => {
  assert.ok(Date.parse(plan().selected_at) < Date.parse(arm.opened_at));
  assert.equal(evaluate({ arm: { ...arm, entry_basis_verified: false } }).exit_requested, false);
  assert.equal(evaluate({ arm: { ...arm, entry_basis_verified: false } }).reason, 'actual_entry_basis_unverified');
  assert.equal(evaluate({ position: { ...position, quantity: '2' } }).reason, 'position_not_verified');
  assert.equal(evaluate({ plan: null }).reason, 'profit_protection_plan_unavailable');
  assert.throws(() => validateProfitProtectionEvidence({ version: 1, mode: 'scalp', rationale: 'Valid rationale', fixed_target: .2 }), /fields/);
});
test('small profit waits; sampled subminute peak arms a profitable floor without selling at peak', () => {
  const small = evaluate({ quote: quote(2.04) });
  assert.equal(small.status, 'watching');
  assert.equal(small.state.floor_bid, null);
  assert.equal(small.state.triggered_at, null);
  const peak = evaluate({ state: small.state, quote: quote(2.2, .02, AT + 5000), now: AT + 5000 });
  assert.equal(peak.status, 'armed');
  assert.equal(peak.exit_requested, false);
  assert.equal(peak.state.floor_bid, 2.12);
  assert.equal(peak.state.activation_gain, .1);
  assert.ok(peak.state.peak_bid - peak.state.floor_bid >= peak.state.drawdown_buffer_at_last_tightening - 1e-8);
  const retrace = evaluate({ state: peak.state, quote: quote(2.12, .02, AT + 10000), now: AT + 10000 });
  assert.equal(retrace.reason, 'profit_protection');
  assert.equal(retrace.exit_requested, true);
  assert.equal(retrace.state.triggered_at, quote(2.12, .02, AT + 10000).updated_at);
});
test('stronger sampled peaks keep moving the floor; a mode update cannot loosen it', () => {
  const first = evaluate();
  const higher = evaluate({ state: first.state, quote: quote(2.5, .02, AT + 5000), now: AT + 5000 });
  assert.equal(higher.exit_requested, false);
  assert.equal(higher.state.floor_bid, 2.3);
  const trend = evaluate({ state: higher.state, plan: plan('trend'), quote: quote(2.4, .02, AT + 10000), now: AT + 10000 });
  assert.equal(trend.state.floor_bid, 2.3);
  assert.equal(trend.state.mode, 'trend');
  const tighten = evaluate({ state: trend.state, plan: plan('trend'), quote: quote(3, .02, AT + 15000), now: AT + 15000 });
  assert.equal(tighten.state.floor_bid, 2.35);
});
test('trend retains less peak gain and waits for the larger initial movement', () => {
  const waiting = evaluate({ plan: plan('trend'), quote: quote(2.2) });
  assert.equal(waiting.state.activation_gain, .3);
  assert.equal(waiting.status, 'watching');
  const peak = evaluate({ plan: plan('trend'), state: waiting.state, quote: quote(2.4, .02, AT + 5000), now: AT + 5000 });
  assert.equal(peak.state.floor_bid, 2.14);
  assert.equal(peak.exit_requested, false);
});
test('wide spreads raise scalp activation enough to honor both retained profit and buffer', () => {
  const waiting = evaluate({ quote: quote(2.4, .1) });
  assert.equal(waiting.state.activation_gain, .5);
  assert.equal(waiting.status, 'watching');
  const active = evaluate({ state: waiting.state, quote: quote(2.5, .1, AT + 5000), now: AT + 5000 });
  assert.equal(active.state.floor_bid, 2.3);
  assert.ok(active.state.peak_bid - active.state.floor_bid >= .2 - 1e-8);
  assert.ok(active.state.floor_bid >= arm.entry_premium + .1);
});
test('valid spread widening preserves an existing floor and reports reduced current buffer', () => {
  const first = evaluate({ quote: quote(2.2, .02) });
  const wider = evaluate({ state: first.state, quote: quote(2.15, .1, AT + 5000), now: AT + 5000 });
  assert.equal(wider.state.floor_bid, first.state.floor_bid);
  assert.equal(wider.current_drawdown_buffer_satisfied, false);
  const cross = evaluate({ state: wider.state, quote: quote(2.12, .1, AT + 10000), now: AT + 10000 });
  assert.equal(cross.exit_requested, true);
});
test('unavailable or corrupt markets cannot create peaks or trigger a fresh profit exit', () => {
  const first = evaluate();
  for (const bad of [quote(2.5, .2), { ...quote(), bid_size: null }, { ...quote(), ask_size: '0' },
    { ...quote(), bid_price: true }, { ...quote(), bid_price: '' }, { ...quote(), ask_price: '1.00' },
    quote(2.5, .02, AT - 10001), quote(2.5, .02, AT + 5001), quote(2.5, .02, Date.parse(arm.opened_at) - 1)]) {
    const result = evaluate({ state: first.state, quote: bad });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.exit_requested, false);
    assert.equal(result.state, first.state);
  }
});
test('same contract in a new lifetime, changed actual basis, malformed state and closed session cannot reuse a floor', () => {
  const first = evaluate();
  const newArm = { ...arm, trade_id: '33333333-3333-4333-8333-333333333333' };
  assert.equal(evaluate({ arm: newArm }).status, 'unavailable');
  assert.equal(evaluate({ arm: newArm, plan: plan('scalp', newArm), state: first.state }).status, 'unavailable');
  assert.equal(evaluate({ arm: { ...arm, entry_premium: 1.9 }, state: first.state }).status, 'unavailable');
  assert.equal(evaluate({ state: { ...first.state, floor_bid: 9 } }).status, 'unavailable');
  assert.equal(evaluate({ session: { ...session, is_open: false }, state: first.state }).status, 'unavailable');
});
test('sample ordering is strict and a crossed floor remains latched after prices rebound', () => {
  const first = evaluate();
  assert.equal(evaluate({ state: first.state, quote: quote(2.3) }).status, 'unavailable');
  const cross = evaluate({ state: first.state, quote: quote(2.1, .02, AT + 5000), now: AT + 5000 });
  assert.equal(cross.exit_requested, true);
  const rebound = evaluate({ state: cross.state, quote: quote(2.4, .02, AT + 10000), now: AT + 10000 });
  assert.equal(rebound.exit_requested, true);
  assert.equal(rebound.state.triggered_at, cross.state.triggered_at);
  assert.equal(rebound.observed_at, cross.state.triggered_at);
});
test('restart preserves original latched deadline when later quotes are missing or stale', () => {
  const first = evaluate();
  const crossed = evaluate({ state: first.state, quote: quote(2.1, .02, AT + 5000), now: AT + 5000 });
  const restarted = JSON.parse(JSON.stringify(crossed.state));
  for (const laterQuote of [undefined, quote(2.4, .02, AT + 6000), { ...quote(2.4, .02, AT + 60000), bid_size: null }]) {
    const result = evaluate({ state: restarted, quote: laterQuote, now: AT + 60000 });
    assert.equal(result.status, 'exit_requested');
    assert.equal(result.exit_requested, true);
    assert.equal(result.observed_at, crossed.observed_at);
    assert.equal(result.state.triggered_at, crossed.state.triggered_at);
    assert.equal(result.trigger_age_ms, 55000);
    assert.equal(result.state, restarted);
    assert.ok(result.quote_unavailable_reason);
  }
});
test('latched requests still require ownership, verified basis, valid plan and regular session', () => {
  const crossed = evaluate({ state: evaluate().state, quote: quote(2.1, .02, AT + 5000), now: AT + 5000 });
  for (const failedGuard of [{ plan: null }, { session: { ...session, is_open: false } },
    { position: null }, { arm: { ...arm, entry_basis_verified: false } }, { arm: { ...arm, entry_premium: 1.9 } },
    { now: NaN }, { session: { ...session, verified: 'true' } }]) {
    const result = evaluate({ state: crossed.state, quote: undefined, now: AT + 60000, ...failedGuard });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.exit_requested, false);
    assert.equal(result.state, crossed.state);
  }
});
test('strict latch validation rejects missing, fabricated and contradictory trigger times', () => {
  const first = evaluate();
  const crossed = evaluate({ state: first.state, quote: quote(2.1, .02, AT + 5000), now: AT + 5000 });
  const missing = { ...crossed.state }; delete missing.triggered_at;
  for (const invalid of [missing, { ...crossed.state, triggered_at: null },
    { ...crossed.state, triggered_at: '2026-10-08T17:59:59Z' },
    { ...crossed.state, triggered_at: '2026-10-08T18:01:00Z' },
    { ...first.state, triggered_at: new Date(AT).toISOString() },
    { ...crossed.state, activated: false }]) {
    const result = evaluate({ state: invalid, quote: undefined, now: AT + 60000 });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.exit_requested, false);
  }
});
