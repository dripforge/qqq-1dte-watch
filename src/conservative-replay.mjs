import { nextTradingDate } from './session.mjs';
import { createHash } from 'node:crypto';
import { timeMs } from './audit-record.mjs';
import { groupResearchEpisodes } from './edge-comparisons.mjs';

export const REPLAY_SPEC = Object.freeze({ version: 1, horizon_seconds: 60, maximum_lateness_seconds: 20,
  maximum_quote_age_seconds: 5, maximum_path_gap_seconds: 20, quantity: 1, multiplier: 100,
  premium_cap_dollars: 325, session_split: { calibration_sessions: 20, evaluation_sessions: 10 },
  scenarios: [{ name: 'immediate_touch', latency_seconds: 0, slippage_per_side: 0 },
    { name: 'ten_second_delay', latency_seconds: 10, slippage_per_side: 0.01 },
    { name: 'thirty_second_delay', latency_seconds: 30, slippage_per_side: 0.03 }],
  fee_stress_per_side_dollars: 0.65,
  interpretation: 'Fixed-horizon quote stress scenarios, not fills, live strategy backtests, or execution guarantees. No stop crossing is inferred between samples.' });
export const REPLAY_SPEC_HASH = createHash('sha256').update(JSON.stringify(REPLAY_SPEC)).digest('hex');
const finite = x => typeof x === 'number' && Number.isFinite(x);
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = at => dateFormat.format(new Date(at));

export function createReplayFreeze(recordedAt) {
  if(timeMs(recordedAt)===null)throw Error('Invalid research freeze time');
  const dates=[];let cursor=day(recordedAt);
  for(let i=0;i<30;i++){cursor=nextTradingDate(cursor);dates.push(cursor);}
  return {version:1,recorded_at:recordedAt,spec_hash:REPLAY_SPEC_HASH,spec:REPLAY_SPEC,
    calibration_dates:dates.slice(0,20),evaluation_dates:dates.slice(20),
    note:'Fixed chronological research windows, not a declaration that 30 sessions proves an edge. Changes require a new prospective specification.'};
}

function validSample(row, now) {
  const q = timeMs(row?.quote_at), o = timeMs(row?.observed_at);
  return q !== null && o !== null && q <= o && o <= now && o - q <= REPLAY_SPEC.maximum_quote_age_seconds * 1000 &&
    finite(row.bid) && finite(row.ask) && row.bid > 0 && row.ask >= row.bid && row.bid_size >= 1 && row.ask_size >= 1;
}
export function replayQuotePath({ basis, instrumentId, scenario, now = Date.now() }) {
  const origin = timeMs(basis?.reference_observed_at), ref = basis?.reference_contracts?.[instrumentId];
  const result = { scenario: scenario.name, status: 'unavailable', reason: null, entry_at: null, exit_at: null,
    quote_scenario_pnl_dollars: null, fee_stress_pnl_dollars: null, actual_fills: false, live_eligibility: 'unknown' };
  const unavailable = reason => ({ ...result, reason });
  if (origin === null || origin > now || !ref?.quote_usable || !finite(ref.ask)) return unavailable('Missing actual usable baseline');
  const raw = basis.scalp?.instruments?.[instrumentId]?.samples ?? [];
  const samples = raw.filter(row => validSample(row, now) && day(row.observed_at)===day(origin)).sort((a, b) => timeMs(a.observed_at) - timeMs(b.observed_at));
  const target = origin + scenario.latency_seconds * 1000;
  const entry = samples.find(row => timeMs(row.observed_at) >= target && timeMs(row.observed_at) <= target + 20000 &&
    (scenario.latency_seconds === 0 || timeMs(row.quote_at) >= target));
  if (!entry) return unavailable('No fresh post-latency entry quote inside the capture window');
  // The original ask is the fixed limit. A later higher ask does not get chased.
  const entryCost = entry.ask + scenario.slippage_per_side;
  if (entryCost > ref.ask + 1e-9) return { ...result, status: 'not_marketable_at_sample', reason: 'Observed ask plus stress cost exceeds the fixed original ask limit' };
  if (entryCost * 100 > REPLAY_SPEC.premium_cap_dollars) return { ...result, status: 'outside_research_cap', reason: 'Scenario exceeds the existing one-contract premium ceiling' };
  const exitTarget = timeMs(entry.observed_at) + REPLAY_SPEC.horizon_seconds * 1000;
  const exit = samples.find(row => timeMs(row.quote_at) >= exitTarget && timeMs(row.observed_at) <= exitTarget + 20000);
  if (!exit) return unavailable('Missing fresh quote at or after the exit horizon');
  const path = samples.filter(row => timeMs(row.observed_at) >= timeMs(entry.observed_at) && timeMs(row.observed_at) <= timeMs(exit.observed_at));
  const gaps = path.slice(1).map((row, i) => timeMs(row.quote_at) - timeMs(path[i].quote_at));
  if (gaps.some(gap => gap < 0 || gap > REPLAY_SPEC.maximum_path_gap_seconds * 1000)) return unavailable('Quote path has a gap or reversed timestamps; no continuous holding/stop path is inferred');
  const exitPrice = Math.max(0, exit.bid - scenario.slippage_per_side);
  const pnl = (exitPrice - entryCost) * 100;
  return { ...result, status: 'quote_scenario', reason: 'Observed executable-side quotes with explicit costs; execution remains unverified',
    entry_at: entry.observed_at, entry_quote_at: entry.quote_at, exit_at: exit.observed_at, exit_quote_at: exit.quote_at,
    original_limit: ref.ask, entry_price_assumption: entryCost, exit_price_assumption: exitPrice,
    entry_delay_seconds: (timeMs(entry.observed_at) - origin) / 1000,
    actual_hold_seconds: (timeMs(exit.observed_at) - timeMs(entry.observed_at)) / 1000,
    quote_scenario_pnl_dollars: pnl, fee_stress_pnl_dollars: pnl - 2 * REPLAY_SPEC.fee_stress_per_side_dollars,
    actual_fees: null, maximum_sample_gap_seconds: gaps.length ? Math.max(...gaps) / 1000 : null };
}

// Starting Greeks explain local price changes approximately. They are neither a
// pricing oracle nor a complete attribution. Units must be explicitly confirmed.
export function greekAttribution({ start, end, greekUnits = null }) {
  const unavailable = reason => ({ status: 'unavailable', reason });
  if (!greekUnits || greekUnits.theta !== 'per_calendar_day' || greekUnits.vega !== 'per_volatility_point') return unavailable('Greek units have not been verified');
  const a = timeMs(start?.observed_at), b = timeMs(end?.observed_at);
  if (a === null || b === null || b <= a || b - a > 30 * 60000) return unavailable('Invalid or excessive attribution interval');
  if (![start.spot,end.spot,start.bid,start.ask,end.bid,end.ask,start.delta,start.gamma,start.theta,start.vega,start.iv,end.iv].every(finite) ||
    start.ask < start.bid || end.ask < end.bid) return unavailable('Missing or invalid paired prices and Greeks');
  const ds = end.spot - start.spot, delta = start.delta * ds * 100, gamma = .5 * start.gamma * ds * ds * 100;
  const theta = start.theta * ((b - a) / 86400000) * 100, vega = start.vega * ((end.iv - start.iv) * 100) * 100;
  const markMove = ((end.ask + end.bid) / 2 - (start.ask + start.bid) / 2) * 100;
  return { status: 'approximate', delta, gamma, theta, vega, midpoint_change_dollars: markMove,
    unexplained_residual_dollars: markMove - delta - gamma - theta - vega,
    spread_crossing_cost_dollars: ((start.ask - start.bid) + (end.ask - end.bid)) * 50,
    interpretation: 'Local Taylor approximation using starting Greeks, including a residual. Not realized P&L or a forecast.' };
}

export function replayResearchState(state, { now = Date.now(), freeze = null } = {}) {
  const cases = Object.values(state.cases ?? {}).filter(item => timeMs(item.first_observed_at) !== null && timeMs(item.first_observed_at) <= now);
  const episodes = groupResearchEpisodes(cases), byCase = new Map(episodes.flatMap(e => e.case_ids.map(id => [id, e])));
  const freezeAt = freeze?.spec_hash === REPLAY_SPEC_HASH && JSON.stringify(freeze.spec) === JSON.stringify(REPLAY_SPEC) ? timeMs(freeze.recorded_at) : null;
  const rows = [];
  for (const item of cases) {
    // One primary contract and original basis per case; alternative bases are not independent trades.
    const basis = item.bases?.case, episode = byCase.get(item.case_id);
    for (const scenario of REPLAY_SPEC.scenarios) rows.push({ case_id: item.case_id, episode_id: episode?.episode_id ?? null,
      session_date: day(item.first_observed_at), first_observed_at: item.first_observed_at,
      direction: item.direction, event_kind: item.first_event_kind ?? 'unknown',
      prospective: freezeAt !== null && freezeAt <= now && timeMs(item.first_observed_at) >= freezeAt,
      ...replayQuotePath({ basis, instrumentId: item.primary_instrument_id, scenario, now }) });
  }
  const dates = [...new Set(rows.filter(r => r.prospective).map(r => r.session_date))].sort();
  // Boundaries are frozen by the deployment date and verified session calendar,
  // not by which profitable cases happen to remain in the 200-case cache.
  const calibration = freeze?.calibration_dates ?? [], evaluation = freeze?.evaluation_dates ?? [];
  let expected=null;try{if(freezeAt!==null)expected=createReplayFreeze(freeze.recorded_at);}catch{}
  const validSplit = expected!==null && JSON.stringify(calibration)===JSON.stringify(expected.calibration_dates) && JSON.stringify(evaluation)===JSON.stringify(expected.evaluation_dates) && freezeAt !== null && calibration.length === 20 && evaluation.length === 10 &&
    new Set([...calibration,...evaluation]).size === 30 && calibration.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) &&
    evaluation.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) && calibration.at(-1) < evaluation[0] &&
    JSON.stringify(calibration) === JSON.stringify([...calibration].sort()) && JSON.stringify(evaluation) === JSON.stringify([...evaluation].sort());
  for (const row of rows) row.cohort = !row.prospective ? 'exploratory' : !validSplit ? 'split_unavailable' :
    calibration.includes(row.session_date) ? 'calibration' : evaluation.includes(row.session_date) ? 'evaluation' : 'outside_frozen_windows';
  const summaries = [];
  for (const scenario of REPLAY_SPEC.scenarios) for (const cohort of ['exploratory','calibration','evaluation']) for (const kind of ['early_break','setup','other']) {
    const selected = rows.filter(r => r.scenario === scenario.name && r.cohort === cohort && (['early_break','setup'].includes(r.event_kind)?r.event_kind:'other')===kind);
    // Earliest case in each episode is selected before looking at its outcome;
    // unavailable first cases cannot be replaced with later winners.
    const unique = new Map();
    for (const row of selected.toSorted((a,b) => a.first_observed_at.localeCompare(b.first_observed_at) || a.case_id.localeCompare(b.case_id))) if (!unique.has(row.episode_id ?? row.case_id)) unique.set(row.episode_id ?? row.case_id,row);
    const kept = [...unique.values()], usable = kept.filter(r => r.status === 'quote_scenario');
    summaries.push({ scenario: scenario.name, cohort, signal_kind:kind, episodes: kept.length, usable_episodes: usable.length,
      sessions: new Set(usable.map(r => r.session_date)).size, unavailable_or_not_marketable: kept.length - usable.length,
      mean_quote_scenario_dollars: usable.length ? usable.reduce((s,r) => s+r.quote_scenario_pnl_dollars,0)/usable.length : null,
      range_quote_scenario_dollars: usable.length ? [Math.min(...usable.map(r=>r.quote_scenario_pnl_dollars)),Math.max(...usable.map(r=>r.quote_scenario_pnl_dollars))] : null,
      uncertainty: 'No confidence interval or edge claim: retained observational quotes are selected, dependent, and may omit earlier sessions.' });
  }
  return { version: 1, research_only: true, live_strategy_changes: false, spec_hash: REPLAY_SPEC_HASH, specification: REPLAY_SPEC,
    freeze_verified: freezeAt !== null && freezeAt <= now, split_verified: validSplit, observed_prospective_sessions: dates,
    calibration_dates: validSplit ? calibration : [], evaluation_dates: validSplit ? evaluation : [], rows, summaries,
    greek_attribution: { status: 'unavailable', reason: 'Paired point-in-time Greeks/underlying timestamps and broker Greek-unit verification are required; do not infer from latest cached values.' },
    interpretation: 'Retained-case report only. Missing/censored cases remain visible. None of these scenarios establishes entry eligibility, fills, or performance of the live stop strategy.' };
}
