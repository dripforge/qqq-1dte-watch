import test from 'node:test';
import assert from 'node:assert/strict';
import { completedBars, validateSetup } from './setup-policy.mjs';
const now = new Date('2026-10-08T16:01:10Z');
function fixtures(direction = 'call') {
  const bar = (at, open, high, low, close) => ({ begins_at: at, open_price: String(open),
    high_price: String(high), low_price: String(low), close_price: String(close), session: 'reg', volume: 100 });
  let five = [bar('2026-10-08T15:45:00Z', 99.8, 99.95, 99.7, 99.8),
    bar('2026-10-08T15:50:00Z', 99.8, 100.6, 99.75, 100.5),
    bar('2026-10-08T15:55:00Z', 100.5, 100.8, 99.95, 100.7)];
  let minute = Array.from({ length: 10 }, (_, i) => {
    const close = 100.2 + i * 0.04;
    return bar(new Date(Date.parse('2026-10-08T15:51:00Z') + i * 60000).toISOString(), close - 0.02, close + 0.1, close - 0.1, close);
  });
  if (direction === 'put') {
    const mirror = b => ({ ...b, open_price: String(200 - Number(b.open_price)),
      close_price: String(200 - Number(b.close_price)), high_price: String(200 - Number(b.low_price)), low_price: String(200 - Number(b.high_price)) });
    five = five.map(mirror); minute = minute.map(mirror);
  }
  const candidate = { version: 1, direction, pattern: direction === 'call' ? 'break_retest' : 'break_failed_reclaim',
    break_bar_at: five[1].begins_at, confirm_bar_at: five[2].begins_at,
    confirmation_1m_at: minute[9].begins_at, level: 100, rationale: 'Completed break, retest and renewed directional follow-through.' };
  return { candidate, inputs: { direction, fiveMinuteBars: five, oneMinuteBars: minute, now } };
}
test('accepts evidenced completed bullish and bearish setups', () => {
  for (const direction of ['call', 'put']) {
    const { candidate, inputs } = fixtures(direction);
    assert.match(validateSetup(candidate, inputs).setup_id, /^[0-9a-f]{64}$/);
  }
});
test('same break cannot be retraded by changing level, pattern or direction', () => {
  const { candidate, inputs } = fixtures();
  const previous = validateSetup(candidate, inputs);
  assert.throws(() => validateSetup(candidate, { ...inputs, previous }), /new completed break/);
  assert.throws(() => validateSetup({ ...candidate, level: 100.01 }, { ...inputs, previous }), /new completed break/);
});
test('rejects vague pattern evidence and wrong one-minute follow-through', () => {
  const { candidate, inputs } = fixtures();
  assert.throws(() => validateSetup({ ...candidate, pattern: 'wick' }, inputs), /pattern/);
  const bad = structuredClone(inputs);
  bad.oneMinuteBars[9].close_price = bad.oneMinuteBars[9].open_price;
  assert.throws(() => validateSetup(candidate, bad), /follow-through/);
});
test('stale, missing, interpolated and forming bars cannot pass the bar gate', () => {
  const { inputs } = fixtures();
  assert.throws(() => completedBars(inputs.oneMinuteBars, 60000, new Date('2026-10-08T16:05:00Z')), /stale/);
  const gap = structuredClone(inputs.oneMinuteBars); gap[8].begins_at = gap[7].begins_at;
  assert.throws(() => completedBars(gap, 60000, now), /gap/);
  const synthesized = structuredClone(inputs.oneMinuteBars); synthesized[3].interpolated = true;
  assert.throws(() => completedBars(synthesized, 60000, now), /interpolated/);
  assert.throws(() => completedBars(inputs.oneMinuteBars, 60000, new Date('2026-10-08T16:00:30Z')), /required/);
});
