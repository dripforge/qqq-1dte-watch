import test from 'node:test';
import assert from 'node:assert/strict';
import { validateResearchEvent, quoteReferenceMovement } from './research-policy.mjs';
import { AT, iso, setup, retouch, trail, quote } from './research-fixtures.mjs';

const now = Date.parse(AT);
test('strict schema refuses unknown fields, fabricated source, stale observations and absent null fields', () => {
  assert.throws(() => validateResearchEvent({ ...setup(), account_number: 'secret' }, now), /documented/);
  assert.throws(() => validateResearchEvent(setup(AT, { source: 'estimated' }), now), /source/);
  assert.throws(() => validateResearchEvent(setup(), now + 120001), /stale/);
  const missing = setup(); delete missing.selected_contract.delta;
  assert.throws(() => validateResearchEvent(missing, now), /documented/);
});
test('actual missing fields remain null and stale or crossed quotes are unusable', () => {
  const input = setup();
  input.selected_contract = quote('2026-10-08T17:59:00Z', undefined, { delta: null, theta: null });
  const event = validateResearchEvent(input, now);
  assert.equal(event.selected_contract.delta, null);
  assert.equal(event.selected_contract.quote_usable, false);
  assert.equal(event.measurements.planned_25pct_premium_stop_plus_1, null);
  assert.ok(event.missing_data.includes('fresh_selected_option_quote'));
  input.selected_contract = quote(AT, undefined, { bid: 3, ask: 2 });
  assert.equal(validateResearchEvent(input, now).selected_contract.spread, null);
});
test('setup records underlying room and distance without pretending option return', () => {
  const event = validateResearchEvent(setup(), now);
  assert.ok(Math.abs(event.measurements.room_to_obstacle - 1.2) < 1e-8);
  assert.ok(Math.abs(event.measurements.distance_to_invalidation - .8) < 1e-8);
  assert.ok(Math.abs(event.measurements.underlying_room_risk_ratio - 1.5) < 1e-8);
  assert.equal(event.measurements.planned_25pct_premium_stop_plus_1, 51);
  assert.ok(Math.abs(event.measurements.option_spread_cost - 10) < 1e-8);
  assert.equal(Object.hasOwn(event.measurements, 'expected_return'), false);
});
test('bearish hold and retouch require distinct completed evidence', () => {
  const hold = validateResearchEvent(setup(), now);
  assert.deepEqual(hold.shadow_comparison, { break_hold: true, failed_reclaim: false, reason: 'hold_confirmed_without_retouch' });
  const retouchEvent = validateResearchEvent(retouch(), Date.parse('2026-10-08T18:05:02Z'));
  assert.equal(retouchEvent.case_id, hold.case_id);
  assert.equal(retouchEvent.shadow_comparison.failed_reclaim, true);
  assert.notEqual(retouchEvent.event_id, hold.event_id);
});
test('unfinished or noncontiguous bars reject; absent interpolation needs positive broker volume for research', () => {
  const unfinished = setup(); unfinished.one_minute_bars.at(-1).begins_at = iso(60);
  assert.throws(() => validateResearchEvent(unfinished, now), /completed/);
  const gap = setup(); gap.one_minute_bars[0].begins_at = iso(57);
  assert.throws(() => validateResearchEvent(gap, now), /contiguous/);
  const unknown = setup(); delete unknown.one_minute_bars[0].interpolated;
  const event = validateResearchEvent(unknown, now);
  assert.equal(event.one_minute_bars[0].interpolated, null);
  assert.equal(event.one_minute_bars[0].research_quality.verification_basis, 'inferred_positive_broker_volume');
  assert.equal(event.shadow_comparison.break_hold, true);
  assert.equal(event.candle_quality.one_minute.inferred_positive_volume_bars, 1);
  assert.equal(event.comparison_quality.one_minute_basis, 'mixed_explicit_flags_and_positive_volume_inference');
  unknown.one_minute_bars[0].volume = 0;
  assert.equal(validateResearchEvent(unknown, now).shadow_comparison.break_hold, null);
});
test('trail compares only confirmed post-entry swings with shared buffer', () => {
  const event = validateResearchEvent(trail(), now);
  assert.ok(Math.abs(event.trail_comparison.buffer - .2) < 1e-8);
  assert.equal(event.trail_comparison.one_minute.level, 499.4);
  assert.equal(event.trail_comparison.five_minute.level, 499.1);
  const late = validateResearchEvent(trail({ opened_at: iso(59) }), now);
  assert.equal(late.trail_comparison.one_minute, null);
  assert.equal(late.trail_comparison.five_minute, null);
});
test('option reference movement uses same actual instrument and exact quote timing only', () => {
  const reference = validateResearchEvent(setup(), now).selected_contract;
  const later = validateResearchEvent(setup('2026-10-08T18:00:06Z', { selected_contract: quote('2026-10-08T18:00:06Z', undefined, { bid: 2.1, ask: 2.2 }) }), now + 4000).selected_contract;
  const movement = quoteReferenceMovement(reference, later);
  assert.ok(Math.abs(movement.bid_minus_reference_ask_per_contract - 10) < 1e-8);
  assert.equal(movement.actual_quote_elapsed_minutes, 4 / 60);
  assert.match(movement.basis, /no_assumed/);
  assert.equal(quoteReferenceMovement(later, reference), null);
  assert.equal(quoteReferenceMovement(reference, { ...later, instrument_id: 'different' }), null);
});
test('zoned times are valid but impossible calendar dates are not', () => {
  const event = setup(); event.observed_at = '2026-10-08T14:00:02-04:00';
  assert.doesNotThrow(() => validateResearchEvent(event, now));
  event.observed_at = '2026-02-30T18:00:02Z';
  assert.throws(() => validateResearchEvent(event, now), /timestamp/);
});
