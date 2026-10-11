import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmBaseCross, BASE_CROSS_CONFIRM_MS } from './confirmation.mjs';

const arm = { option_id: 'a' };
const crossing = { exit: true, reason: 'qqq_invalidation', qqq_exit_level: 753.75,
  qqq_price: 753.77, observed_at: '2026-10-08T15:51:03Z' };

test('an invalidation crossing acts immediately', () => {
  const first = confirmBaseCross(arm, crossing, null, new Date('2026-10-08T15:51:04Z'));
  assert.equal(first.decision.exit, true);
  assert.equal(BASE_CROSS_CONFIRM_MS, 0);
  const afterMinute = confirmBaseCross(arm, crossing, first.candidate, new Date('2026-10-08T15:52:00Z'));
  assert.equal(afterMinute.decision.exit, true);
  const recovered = confirmBaseCross(arm, { exit: false, reason: 'holding' }, afterMinute.candidate,
    new Date('2026-10-08T15:52:05Z'));
  assert.equal(recovered.candidate, null);
});

test('old confirmation state cannot add a wait', () => {
  const first = confirmBaseCross(arm, crossing, null, new Date('2026-10-08T15:51:04Z'));
  const confirmed = confirmBaseCross(arm, crossing, first.candidate, new Date('2026-10-08T15:52:18Z'));
  assert.equal(confirmed.decision.exit, true);
  assert.equal(confirmed.decision.observed_at, crossing.observed_at);
  assert.equal(confirmed.candidate, null);
});
