import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectEarlyBreakSignals, EDGE_RESEARCH_SPEC, EDGE_RESEARCH_SPEC_HASH, groupResearchEpisodes,
  replayProfitModes, summarizeEdgeResearch } from './edge-comparisons.mjs';

const TRADE = '99999999-9999-4999-8999-999999999999', OPTION = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-10-09T14:00:00Z');
const iso = seconds => new Date(T0 + seconds * 1000).toISOString();
const bar = (at, open, high, low, close, extra = {}) => ({ begins_at: at, open_price: String(open),
  high_price: String(high), low_price: String(low), close_price: String(close), volume: 1000,
  session: 'reg', interpolated: false, ...extra });
function early() {
  return { now: new Date('2026-10-09T13:40:02Z'), qqqPrice: 751.1,
    fiveMinuteBars: [bar('2026-10-09T13:30:00Z', 749, 750.5, 748.5, 750), bar('2026-10-09T13:35:00Z', 750, 752, 749.7, 751)],
    oneMinuteBars: [bar('2026-10-09T13:38:00Z', 750.9, 751.4, 750.8, 751), bar('2026-10-09T13:39:00Z', 751, 751.5, 750.8, 751.1)] };
}
function entry(extra = {}) {
  return { trade_id: TRADE, option_id: OPTION, direction: 'call', expiration_date: '2026-10-12',
    premium: 2, opened_at: iso(0), entry_basis_verified: true, qqq_invalidation: 748, ...extra };
}
function sample(seconds, bid, extra = {}) {
  return { trade_id: TRADE, option_id: OPTION, event: 'price_observation', observed_at: iso(seconds),
    option_quote_at: iso(seconds), option_bid: bid, option_ask: bid + .01, option_bid_size: 10, option_ask_size: 20,
    position_verified: true, entry_basis_verified: true, session: { verified: true, is_open: true, date: '2026-10-09' },
    qqq_price: 750, qqq_quote_at: iso(seconds), qqq_exit_level: 748, ...extra };
}

test('small frozen specification has only two entry families and two protection modes', () => {
  assert.deepEqual(EDGE_RESEARCH_SPEC.entries, ['early_break_shadow', 'completed_hold_or_retest']);
  assert.deepEqual(EDGE_RESEARCH_SPEC.exits, ['scalp', 'trend']);
  assert.equal(Object.isFrozen(EDGE_RESEARCH_SPEC.fast_horizons_seconds), true);
  assert.match(EDGE_RESEARCH_SPEC_HASH, /^[a-f0-9]{64}$/);
});

test('early shadow uses only completed prior reference and break with actual latest minute; no fictional confirmation', () => {
  const result = detectEarlyBreakSignals(early());
  assert.equal(result.status, 'complete'); assert.equal(result.signals.length, 2);
  const signal = result.signals.find(value => value.reference_kind === 'prior_5m_close');
  assert.equal(signal.break_completed_at, '2026-10-09T13:40:00.000Z');
  assert.equal(signal.reference_established_at, '2026-10-09T13:35:00.000Z');
  assert.equal(signal.signal_capture_delay_seconds, 2);
  assert.equal(signal.live_qualified, false); assert.equal(signal.entry_gate.status, 'unknown');
  assert.equal(Object.hasOwn(signal, 'confirm_bar_at'), false);
});

test('reference first established after break began cannot appear as early shadow', () => {
  const args = early(); args.explicitReferences = [{ direction: 'call', level: 750.2,
    established_at: '2026-10-09T13:36:00Z', rationale: 'A late hindsight level must not qualify.' }];
  const result = detectEarlyBreakSignals(args);
  assert.equal(result.signals.some(value => value.reference_kind === 'explicit_plan'), false);
});

test('forming candles never become an early signal and missing metadata does not become regular', () => {
  const args = early(); args.fiveMinuteBars.push(bar('2026-10-09T13:40:00Z', 751, 755, 751, 754));
  assert.equal(detectEarlyBreakSignals(args).signals.every(value => value.break_bar_at === '2026-10-09T13:35:00Z'), true);
  args.fiveMinuteBars[1].session = undefined;
  assert.equal(detectEarlyBreakSignals(args).status, 'data_unavailable');
});

test('actual QQQ reversal and stale completed minute suppress early research signal', () => {
  assert.equal(detectEarlyBreakSignals({ ...early(), qqqPrice: 749 }).signals.length, 0);
  const args = early(); args.oneMinuteBars[0].begins_at = '2026-10-09T13:36:00Z';
  assert.equal(detectEarlyBreakSignals(args).status, 'data_unavailable');
});

test('overlapping direction/level/option observations are grouped; distinct sessions stay separate', () => {
  const cases = [
    { case_id: 'a', first_observed_at: '2026-10-09T13:40:00Z', direction: 'put', primary_instrument_id: 'one' },
    { case_id: 'b', first_observed_at: '2026-10-09T13:45:00Z', direction: 'call', primary_instrument_id: 'two' },
    { case_id: 'c', first_observed_at: '2026-10-09T15:00:00Z', direction: 'call', primary_instrument_id: 'one' },
    { case_id: 'd', first_observed_at: '2026-10-12T13:40:00Z', direction: 'put', primary_instrument_id: 'one' },
  ];
  const grouped = groupResearchEpisodes(cases);
  assert.equal(grouped.length, 3); assert.deepEqual(grouped[0].case_ids, ['a', 'b']);
  assert.deepEqual(grouped[0].instrument_ids, ['one', 'two']);
});

test('scalp/trend replay reuses live protection and quotes only; never claims alternative fill or net PnL', () => {
  const result = replayProfitModes({ entry: entry(), samples: [sample(0, 2), sample(5, 2.6), sample(10, 2.3), sample(15, 2.1)] });
  assert.equal(result.status, 'evaluated');
  assert.equal(result.modes.scalp.trigger.quote_at, iso(10));
  assert.equal(result.modes.trend.trigger.quote_at, iso(15));
  assert.ok(Math.abs(result.modes.scalp.quote_bid_minus_actual_entry_per_contract - 30) < 1e-8);
  assert.equal(result.modes.scalp.net_pnl, null); assert.equal(result.modes.trend.fees, null);
});

test('legacy missing sizes or verified basis is unavailable, not invented', () => {
  assert.equal(replayProfitModes({ entry: entry({ entry_basis_verified: false }), samples: [sample(0, 2)] }).status, 'unavailable');
  const invalid = sample(0, 2); delete invalid.option_bid_size;
  const result = replayProfitModes({ entry: entry(), samples: [invalid] });
  assert.equal(result.status, 'unavailable'); assert.equal(result.modes.scalp.rejected_samples, 1);
});

test('QQQ invalidation, emergency sampled boundary and expiry cut-off are retained in both alternatives', () => {
  for (const [s, reason] of [[sample(5, 2.2, { qqq_price: 747.9 }), 'sampled_qqq_invalidation'],
    [sample(5, 1.49), 'sampled_emergency_bid_boundary'],
    [sample(5, 2.2, { mandatory_exit_at: iso(4) }), 'mandatory_exit_boundary']]) {
    const result = replayProfitModes({ entry: entry(), samples: [s] });
    for (const mode of ['scalp', 'trend']) assert.equal(result.modes[mode].trigger.reason, reason);
  }
});

test('alternative hold beyond verified actual closure is censored and later quotes are not a held position', () => {
  const result = replayProfitModes({ entry: entry(), samples: [sample(0, 2), sample(5, 2.6), sample(10, 2.3), sample(15, 2.1)],
    closure: { trade_id: TRADE, closed_at: iso(12), reason: 'manual', gross_realized_pnl: 28, fees: null } });
  assert.equal(result.modes.scalp.status, 'sampled_trigger'); assert.equal(result.modes.trend.status, 'right_censored');
  assert.equal(result.actual_closure.gross_realized_pnl, 28); assert.equal(result.actual_closure.net_realized_pnl, null);
});

test('summary separates actual broker fills, quote-reference comparisons and prospective cohorts', () => {
  const researchState = { cases: { old: { case_id: 'old', first_event_kind: 'setup', direction: 'put',
    first_observed_at: iso(-100), primary_instrument_id: OPTION, bases: {} }, fresh: { case_id: 'fresh', first_event_kind: 'early_break', direction: 'put',
    first_observed_at: iso(0), primary_instrument_id: OPTION, bases: { early_break: { qualified_at: iso(0), reference_observed_at: iso(3),
      reference_contracts: { [OPTION]: { ask: 2, updated_at: iso(2) } }, scalp: { instruments: {}, horizons: { '30': { intended_seconds: 30,
        actual_elapsed_seconds: 31, delay_seconds: 1, observed_at: iso(34), quoted_movements: { [OPTION]: { reference_ask: 2,
          observed_bid: 2.3, bid_minus_reference_ask_per_contract: 30, reference_quote_at: iso(2), observed_quote_at: iso(34), actual_quote_elapsed_seconds: 32 } } } } } } } } } };
  const journal = [{ event: 'entry_filled', trade_id: TRADE, option_id: OPTION, premium: 2, filled_at: iso(0), fees: .04 },
    { event: 'trade_closed', trade_id: TRADE, option_id: OPTION, closed_at: iso(34), gross_realized_pnl: 28, fees: .05 }];
  const report = summarizeEdgeResearch({ researchState, journal, specRecordedAt: iso(-1), now: T0 + 35000 });
  assert.equal(report.sample_units.retained_cases, 2); assert.equal(report.sample_units.market_episodes, 1);
  assert.equal(report.sample_units.prospective_cases, 1); assert.equal(report.quote_comparisons[0].baseline_delay_seconds, 3);
  assert.equal(report.quote_comparisons[0].net_pnl, null); assert.equal(report.actual_fills[0].net_realized_pnl, 27.91);
  assert.equal(report.quote_comparisons[0].evidence_cohort, 'prospective_after_spec_freeze');
  assert.equal(report.actual_entry_profit_mode_replays[0].status, 'unavailable');
  assert.equal(report.live_strategy_changes, false);
});

test('primary invalidation still preempts profit replay with a wide-spread actual quote', () => {
  const result = replayProfitModes({ entry: entry(), samples: [sample(5, 2, { option_ask: 2.3, qqq_price: 747.9 })] });
  assert.equal(result.modes.scalp.trigger.reason, 'sampled_qqq_invalidation');
  assert.equal(result.modes.trend.trigger.reason, 'sampled_qqq_invalidation');
});

test('old trade basis cannot attach to an observed replacement lifetime', () => {
  const result = replayProfitModes({ entry: entry(), samples: [sample(5, 2.6, { entry_premium: 2.4, opened_at: iso(4) })] });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.modes.scalp.rejected_reasons, ['Actual position basis or lifetime changed']);
});

test('summary recovers future actual basis from enriched samples without mutating caller entry objects', () => {
  const owned = entry(); delete owned.direction; delete owned.expiration_date;
  const journal = [sample(0, 2, { entry_premium: 2, opened_at: iso(0), direction: 'call', expiration_date: '2026-10-12' })];
  const report = summarizeEdgeResearch({ entries: [owned], journal, now: T0 + 1000 });
  assert.equal(report.actual_entry_profit_mode_replays[0].status, 'evaluated');
  assert.equal(Object.hasOwn(owned, 'direction'), false);
});

test('closed legacy trade without an entry basis stays an unavailable replay', () => {
  const closure={event:'trade_closed',trade_id:TRADE,option_id:OPTION,closed_at:iso(60),gross_realized_pnl:-16,fees:null,historical_backfill:true};
  const report=summarizeEdgeResearch({journal:[closure,closure],specRecordedAt:iso(0),now:T0+61000});
  assert.equal(report.actual_entry_profit_mode_replays.length,1);
  const replay=report.actual_entry_profit_mode_replays[0];
  assert.equal(replay.status,'unavailable');
  assert.match(replay.reason,/Verified actual entry basis/);
  assert.equal(replay.actual_closure.gross_realized_pnl,-16);
  assert.equal(replay.evidence_cohort,'legacy_exploratory');
  assert.deepEqual(replay.modes,{});
});
