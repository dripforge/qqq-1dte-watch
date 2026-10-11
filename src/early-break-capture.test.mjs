import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEarlyBreakSignals } from './edge-comparisons.mjs';
import { buildEarlyBreakResearchObservation, captureEarlyBreakObservations } from './early-break-capture.mjs';
import { readResearchState } from './research-record.mjs';

const NOW = Date.parse('2026-10-09T13:40:02Z');
const bar = (at, open, high, low, close) => ({ begins_at: at, open_price: String(open), high_price: String(high),
  low_price: String(low), close_price: String(close), volume: 1000, interpolated: false, session: 'reg' });
function snapshot(now = NOW) {
  const fiveMinuteBars = [bar('2026-10-09T13:30:00Z', 749, 750.5, 748.5, 750), bar('2026-10-09T13:35:00Z', 750, 752, 749.7, 751)];
  const oneMinuteBars = [bar('2026-10-09T13:38:00Z', 750.9, 751.4, 750.8, 751), bar('2026-10-09T13:39:00Z', 751, 751.5, 750.8, 751.1)];
  const qqq = { symbol: 'QQQ', state: 'active', has_traded: true, last_trade_price: '751.1', venue_last_trade_time: new Date(now).toISOString() };
  const signals = detectEarlyBreakSignals({ oneMinuteBars, fiveMinuteBars, qqqPrice: 751.1, now: new Date(now) }).signals;
  return { now, qqq, oneMinuteBars, fiveMinuteBars, signals };
}
function folder(t) {
  const value = mkdtempSync(join(tmpdir(), 'qqq-early-capture-'));
  t.after(() => rmSync(value, { recursive: true, force: true }));
  writeFileSync(join(value, 'health.json'), JSON.stringify({ at: new Date(NOW).toISOString(), live: true, status: 'idle', version: '2.4.0' }));
  return value;
}

test('early record contains actual completed break only and unknown live eligibility', t => {
  const path = folder(t), evidence = snapshot();
  const result = captureEarlyBreakObservations({ folder: path, ...evidence, market_context: { version: 1, trend_15m: 'down',
    confirmed_levels: [{ price: 752, kind: 'prior_high', known_at: '2026-10-09T13:30:00Z' }] } });
  assert.equal(result.status, 'captured'); assert.equal(result.captured, 2); assert.equal(result.queued, 2);
  const state = readResearchState(path);
  for (const item of Object.values(state.cases)) {
    assert.equal(item.first_event_kind, 'early_break'); assert.equal(item.early_setup_evidence.live_qualified, false);
    assert.equal(Object.hasOwn(item.early_setup_evidence, 'confirm_bar_at'), false);
    assert.equal(item.bases.case.reference_observed_at, null);
    assert.equal(item.primary_instrument_id, null);
  }
  const queue = JSON.parse(readFileSync(join(path, 'research-collector-queue.json'), 'utf8'));
  assert.equal(Object.values(queue.cases).every(item => item.entry_gate.status === 'unknown'), true);
  const journal = readFileSync(join(path, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(journal[0].market_context.trend_15m, 'down');
  assert.equal(journal[0].candle_quality.five_minute.verification_basis, 'explicit_broker_non_interpolated');
});

test('ten-second repeated scans preserve first evidence and do not create independent cases', t => {
  const path = folder(t);
  captureEarlyBreakObservations({ folder: path, ...snapshot() });
  const result = captureEarlyBreakObservations({ folder: path, ...snapshot(NOW + 10000) });
  assert.equal(result.captured, 0); assert.equal(result.deduplicated, 2);
  assert.equal(readResearchState(path).recorded_events, 2);
  assert.equal(Object.values(readResearchState(path).cases).every(item => item.first_observed_at === new Date(NOW).toISOString()), true);
});

test('forged causal signal and stale quote are rejected rather than manufactured', () => {
  const evidence = snapshot(), signal = structuredClone(evidence.signals[0]);
  signal.reference_established_at = '2026-10-09T13:36:00Z';
  assert.throws(() => buildEarlyBreakResearchObservation({ ...evidence, signal }), /actual causal/);
  evidence.qqq.venue_last_trade_time = '2026-10-09T13:39:00Z';
  assert.throws(() => buildEarlyBreakResearchObservation({ ...evidence, signal: evidence.signals[0] }), /fresh/);
});

test('live position state wins over early research work', t => {
  const path = folder(t);
  writeFileSync(join(path, 'arm.json'), '{}');
  const result = captureEarlyBreakObservations({ folder: path, ...snapshot() });
  assert.equal(result.status, 'skipped'); assert.equal(result.reason, 'live_trade_priority'); assert.equal(result.captured, 0);
});
