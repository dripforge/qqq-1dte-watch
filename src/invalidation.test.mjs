import test from 'node:test';
import assert from 'node:assert/strict';
import { bufferedInvalidationBoundary, requireBufferedInvalidation } from './invalidation.mjs';

test('rejects the put invalidation that was clipped by the October 8 rebound', () => {
  const highs = [753.61, 753.38, 753.319, 753.12, 753.1475,
    753.245, 753.305, 753.46, 753.43, 753.405];
  const lows = [753.2901, 753.245, 752.93, 752.948, 752.9,
    752.96, 753.06, 753.25, 753.19, 753.12];
  const bars = highs.map((high, i) => ({ begins_at: new Date(Date.parse('2026-10-08T15:37:00Z') + i * 60000).toISOString(),
    high_price: String(high), low_price: String(lows[i]),
    open_price: String((high + lows[i]) / 2), close_price: String((high + lows[i]) / 2) }));
  const result = bufferedInvalidationBoundary(bars, 'put', new Date('2026-10-08T15:47:28Z'));
  assert.ok(result.boundary > 753.70);
  assert.throws(() => requireBufferedInvalidation(753.62, 'put', result.boundary), /noise/);
  assert.doesNotThrow(() => requireBufferedInvalidation(753.75, 'put', result.boundary));
});

test('forming bar is excluded and call level must clear the buffered swing low', () => {
  const start = Date.parse('2026-10-08T15:37:00Z');
  const bars = Array.from({ length: 11 }, (_, i) => ({
    begins_at: new Date(start + i * 60000).toISOString(),
    high_price: '751.30', low_price: i === 10 ? '749.00' : '751.00', open_price: '751.10', close_price: '751.20',
  }));
  const result = bufferedInvalidationBoundary(bars, 'call', new Date('2026-10-08T15:47:28Z'));
  assert.ok(result.boundary < 751);
  assert.ok(result.boundary > 750.8);
  assert.throws(() => requireBufferedInvalidation(750.99, 'call', result.boundary));
});
