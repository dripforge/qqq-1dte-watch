import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveExitLevel, validateTightening, profitTrailBoundary, validateBufferedTrail, profitCushion } from './profit-policy.mjs';

test('call profit level can only rise without crossing the current QQQ price', () => {
  const arm = { option_id: 'a', option_type: 'call', qqq_invalidation: 750 };
  const level = validateTightening(arm, null, 752, 753);
  assert.equal(level, 752);
  assert.equal(effectiveExitLevel(arm, { option_id: 'a', qqq_trailing_level: 752 }), 752);
  assert.throws(() => validateTightening(arm, { option_id: 'a', qqq_trailing_level: 752 }, 751, 753));
  assert.throws(() => validateTightening(arm, null, 754, 753));
});

test('put profit level can only fall and an unrelated plan is ignored', () => {
  const arm = { option_id: 'b', option_type: 'put', qqq_invalidation: 754 };
  assert.equal(effectiveExitLevel(arm, { option_id: 'other', qqq_trailing_level: 752 }), 754);
  assert.equal(validateTightening(arm, null, 753, 752), 753);
  assert.equal(effectiveExitLevel(arm, { option_id: 'b', qqq_trailing_level: 753 }), 753);
  assert.throws(() => validateTightening(arm, { option_id: 'b', qqq_trailing_level: 753 }, 753.5, 752));
  assert.throws(() => validateTightening(arm, null, 751, 752));
});

const now = new Date('2026-10-08T16:01:10Z');
function swingBars(direction = 'call') {
  const lows = [751.4, 751.3, 751.2, 751.3, 751.4, 751.6, 751.5, 751.7, 751.8, 751.9];
  return lows.map((low, i) => {
    const bar = { begins_at: new Date(Date.parse('2026-10-08T15:51:00Z') + i * 60000).toISOString(),
      low_price: String(low), high_price: String(low + 0.2), open_price: String(low + 0.08),
      close_price: String(low + 0.12), session: 'reg', volume: 100 };
    return direction === 'call' ? bar : { ...bar,
      low_price: String(1504 - Number(bar.high_price)), high_price: String(1504 - Number(bar.low_price)),
      open_price: String(1504 - Number(bar.open_price)), close_price: String(1504 - Number(bar.close_price)) };
  });
}
test('profit trails clear a fully confirmed post-entry swing and volatility buffer in either direction', () => {
  const call = { option_id: 'c', option_type: 'call', qqq_invalidation: 750, opened_at: '2026-10-08T15:52:30Z' };
  const callBars = swingBars();
  const boundary = profitTrailBoundary(callBars, call, now);
  assert.equal(boundary.swing_at, '2026-10-08T15:57:00.000Z');
  assert.ok(Math.abs(boundary.boundary - 751.4) < 1e-8);
  assert.equal(validateBufferedTrail(call, null, 751.4, 752.1, callBars, now).level, 751.4);
  assert.throws(() => validateBufferedTrail(call, null, 751.5, 752.1, callBars, now), /confirmed swing/);
  const put = { ...call, option_id: 'p', option_type: 'put', qqq_invalidation: 754 };
  assert.equal(validateBufferedTrail(put, null, 752.6, 751.9, swingBars('put'), now).level, 752.6);
  assert.throws(() => validateBufferedTrail(put, null, 752.5, 751.9, swingBars('put'), now), /confirmed swing/);
});
test('a trail cannot use a pre-entry swing, forming confirmation or stale bars', () => {
  const arm = { option_id: 'a', option_type: 'call', qqq_invalidation: 750, opened_at: '2026-10-08T15:59:00Z' };
  const bars = swingBars();
  assert.throws(() => profitTrailBoundary(bars, arm, now), /after entry/);
  assert.throws(() => profitTrailBoundary(bars, { ...arm, opened_at: undefined }, now), /entry time/);
  assert.throws(() => profitTrailBoundary(bars, { ...arm, opened_at: '2026-10-08T15:51:00Z' }, new Date('2026-10-08T16:05:00Z')), /stale/);
  const formingNow = new Date('2026-10-08T16:00:30Z');
  assert.throws(() => profitTrailBoundary(bars, { ...arm, opened_at: '2026-10-08T15:51:00Z' }, formingNow), /completed bars/);
});
test('profit trail stays outside current price noise even when swing boundary allows it', () => {
  const arm = { option_id: 'a', option_type: 'call', qqq_invalidation: 750, opened_at: '2026-10-08T15:51:00Z' };
  assert.throws(() => validateBufferedTrail(arm, null, 751.4, 751.45, swingBars(), now), /current price noise/);
});
test('zero or tiny quoted profit cannot justify a sell or tighten action', () => {
  const arm = { entry_premium: 1.77 };
  assert.throws(() => profitCushion(arm, { bid_price: '1.77', ask_price: '1.79' }), /too small/);
  assert.throws(() => profitCushion(arm, { bid_price: '1.78', ask_price: '1.79' }), /too small/);
  assert.throws(() => profitCushion(arm, { bid_price: '1.80', ask_price: '1.84' }), /too small/);
  assert.throws(() => profitCushion(arm, { bid_price: null, ask_price: '1.84' }), /unavailable/);
  const result = profitCushion(arm, { bid_price: '1.82', ask_price: '1.86' });
  assert.ok(Math.abs(result.quoted_gross_profit - 5) < 1e-8);
});
