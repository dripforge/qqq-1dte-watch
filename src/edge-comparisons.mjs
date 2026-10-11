import { createHash } from 'node:crypto';
import { completedBars } from './setup-policy.mjs';
import { createProfitProtectionPlan, evaluateProfitProtection, PROFIT_PROTECTION_DEFAULTS } from './profit-protection.mjs';
import { summarizeScalpBasis } from './scalp-research.mjs';
import { assessResearchBars } from './research-candle-quality.mjs';

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ms = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const day = value => ms(value) === null ? null : DAY.format(new Date(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Freeze this small comparison set before recording prospective results. It is
// research configuration only; none of these exports can submit an order.
export const EDGE_RESEARCH_SPEC = Object.freeze({
  version: 1,
  spec_id: 'qqq-prospective-edge-v1',
  entries: Object.freeze(['early_break_shadow', 'completed_hold_or_retest']),
  exits: Object.freeze(['scalp', 'trend']),
  fast_horizons_seconds: Object.freeze([30, 60, 120]),
  quote_path_interval_seconds: 10,
  episode_overlap_minutes: 30,
  profit_profiles: PROFIT_PROTECTION_DEFAULTS,
  eligibility: 'Early signals and quote comparisons have unknown live entry eligibility until the independent entry gate actually checks it.',
  execution: 'Actual captured ask to actual later bid is a quote comparison, never an assumed fill. Missing prices are not backfilled.',
});
export const EDGE_RESEARCH_SPEC_HASH = hash(EDGE_RESEARCH_SPEC);

export function detectEarlyBreakSignals({ oneMinuteBars, fiveMinuteBars, now = new Date(), explicitReferences = [], qqqPrice = null } = {}) {
  const observed = now instanceof Date ? now.getTime() : NaN;
  const unavailable = reason => ({ version: 1, spec_id: EDGE_RESEARCH_SPEC.spec_id,
    observed_at: Number.isFinite(observed) ? now.toISOString() : null, status: 'data_unavailable', signals: [], reason });
  try {
    if (!Number.isFinite(observed)) throw new Error('Observation time is invalid');
    if (!finite(qqqPrice) || qqqPrice <= 0) throw new Error('Actual current QQQ price is unavailable');
    if (!Array.isArray(explicitReferences) || explicitReferences.length > 4) throw new Error('At most four causal explicit references are allowed');
    const today = day(now.toISOString());
    const rawFive = (fiveMinuteBars ?? []).filter(bar => bar && day(bar.begins_at) === today);
    const count = Math.min(24, rawFive.filter(bar => ms(bar.begins_at) !== null && ms(bar.begins_at) + 300000 <= observed - 1000).length);
    const five = completedBars(rawFive, 300000, now, { count: Math.max(2, count), maxAgeMs: 330000 });
    const minute = completedBars((oneMinuteBars ?? []).filter(bar => bar && day(bar.begins_at) === today), 60000, now, { count: 2, maxAgeMs: 90000 });
    const candleQuality = { one_minute: assessResearchBars(minute, { intervalMs: 60000, observedAt: observed, minimum: 2 }),
      five_minute: assessResearchBars(five, { intervalMs: 300000, observedAt: observed, minimum: 2 }) };
    if (!candleQuality.one_minute.usable || !candleQuality.five_minute.usable) throw new Error('Usable completed research candle evidence is required');
    const before = five.at(-2), broken = five.at(-1), breakStart = ms(broken.begins_at), completedAt = breakStart + 300000;
    if (ms(minute.at(-1).begins_at) + 60000 < completedAt) throw new Error('Latest actual completed minute precedes the break completion');
    const automatic = ['high_price', 'low_price', 'close_price'].map(key => ({
      level: Number(before[key]), kind: `prior_5m_${key.replace('_price', '')}`,
      established_at: new Date(ms(before.begins_at) + 300000).toISOString(),
      rationale: 'Reference was already observable in the prior completed five-minute bar.',
    }));
    const explicit = explicitReferences.map(reference => {
      if (!reference || !['call', 'put'].includes(reference.direction) || !finite(reference.level) || reference.level <= 0 ||
          ms(reference.established_at) === null || typeof reference.rationale !== 'string' || reference.rationale.trim().length < 8) throw new Error('Explicit reference evidence is invalid');
      return { ...reference, kind: 'explicit_plan' };
    });
    const seen = new Set(), signals = [];
    for (const reference of [...explicit, ...automatic]) {
      if (ms(reference.established_at) > breakStart) continue;
      const prior = Number(before.close_price), current = Number(broken.close_price), level = reference.level;
      const direction = prior <= level && current > level ? 'call' : prior >= level && current < level ? 'put' : null;
      if (!direction || reference.direction && direction !== reference.direction) continue;
      if (direction === 'call' ? qqqPrice <= level : qqqPrice >= level) continue;
      const identity = [today, direction, broken.begins_at, level];
      const signalId = hash(['early_break_shadow', ...identity]);
      if (seen.has(signalId)) continue;
      seen.add(signalId);
      signals.push({ version: 1, spec_id: EDGE_RESEARCH_SPEC.spec_id, spec_hash: EDGE_RESEARCH_SPEC_HASH,
        signal_id: signalId, symbol: 'QQQ', direction, pattern: 'early_break_shadow', reference_level: level,
        reference_kind: reference.kind, reference_established_at: reference.established_at,
        break_bar_at: broken.begins_at, break_completed_at: new Date(completedAt).toISOString(),
        latest_completed_1m_at: minute.at(-1).begins_at, observed_at: now.toISOString(),
        signal_capture_delay_seconds: (observed - completedAt) / 1000,
        candle_quality: candleQuality,
        qqq_price: qqqPrice, current_price_on_break_side: direction === 'call' ? qqqPrice > level : qqqPrice < level,
        live_qualified: false, entry_gate: { status: 'unknown', reason: 'Research-only completed break; later hold/retest and fresh live entry gate have not qualified.', checked_at: null },
        rationale: reference.rationale,
      });
    }
    return { version: 1, spec_id: EDGE_RESEARCH_SPEC.spec_id, observed_at: now.toISOString(),
      status: 'complete', signals: signals.slice(0, 4), reason: signals.length ? 'Actual completed causal breaks recorded for shadow research only' : 'No newly completed causal break' };
  } catch (error) { return unavailable(String(error.message).slice(0, 250)); }
}

function caseInterval(item) {
  const signal = item.early_break_signal ?? item.signal ?? null;
  const start = ms(signal?.break_completed_at ?? item.setup_evidence?.break_bar_at ?? item.first_observed_at);
  if (start === null) return null;
  const ends = [start, ms(item.last_observed_at), ms(item.first_observed_at)];
  for (const basis of Object.values(item.bases ?? {})) {
    ends.push(ms(basis.reference_observed_at));
    for (const endpoint of Object.values(basis.horizons ?? {})) ends.push(ms(endpoint.observed_at));
    for (const instrument of Object.values(basis.scalp?.instruments ?? {})) for (const sample of instrument.samples ?? []) ends.push(ms(sample.observed_at));
  }
  // Thirty minutes is the predeclared comparison window. Grouping across
  // directions, levels, and options conservatively avoids counting one move
  // as many independent opportunities.
  const end = Math.max(start + EDGE_RESEARCH_SPEC.episode_overlap_minutes * 60000, ...ends.filter(Number.isFinite));
  return { case_id: item.case_id, symbol: item.symbol ?? 'QQQ', session_date: day(new Date(start).toISOString()),
    start_ms: start, end_ms: end, direction: item.direction, instrument_id: item.primary_instrument_id ?? null };
}

export function groupResearchEpisodes(cases = []) {
  const sorted = (Array.isArray(cases) ? cases : Object.values(cases ?? {})).map(caseInterval).filter(Boolean)
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.session_date.localeCompare(b.session_date) || a.start_ms - b.start_ms);
  const episodes = [];
  for (const item of sorted) {
    const previous = episodes.at(-1);
    if (previous && previous.symbol === item.symbol && previous.session_date === item.session_date && item.start_ms <= previous.end_ms) {
      previous.end_ms = Math.max(previous.end_ms, item.end_ms);
      previous.case_ids.push(item.case_id);
      if (item.direction && !previous.directions.includes(item.direction)) previous.directions.push(item.direction);
      if (item.instrument_id && !previous.instrument_ids.includes(item.instrument_id)) previous.instrument_ids.push(item.instrument_id);
    } else episodes.push({ symbol: item.symbol, session_date: item.session_date, start_ms: item.start_ms,
      end_ms: item.end_ms, case_ids: [item.case_id], directions: item.direction ? [item.direction] : [], instrument_ids: item.instrument_id ? [item.instrument_id] : [] });
  }
  return episodes.map(({ start_ms, end_ms, ...episode }) => ({ ...episode,
    episode_id: hash([episode.symbol, episode.session_date, new Date(start_ms).toISOString()]),
    starts_at: new Date(start_ms).toISOString(), ends_at: new Date(end_ms).toISOString(), observation_count: episode.case_ids.length,
    interpretation: 'Overlapping comparison windows are one market episode; episodes within one day may still be dependent.' }));
}

function sampleQuote(sample) {
  return { instrument_id: sample.option_id ?? sample.instrument_id,
    updated_at: sample.option_quote_at ?? sample.quote_at,
    bid_price: sample.option_bid ?? sample.bid, ask_price: sample.option_ask ?? sample.ask,
    bid_size: sample.option_bid_size ?? sample.bid_size, ask_size: sample.option_ask_size ?? sample.ask_size };
}
function sampledBoundary(entry, sample, quotedAt, bid) {
  if (sample.mandatory_exit_due === true || ms(sample.mandatory_exit_at ?? entry.mandatory_exit_at) !== null && quotedAt >= ms(sample.mandatory_exit_at ?? entry.mandatory_exit_at)) return 'mandatory_exit_boundary';
  const level = sample.qqq_exit_level ?? entry.qqq_invalidation;
  const price = sample.qqq_price, qqqAt = ms(sample.qqq_quote_at);
  if (finite(level) && finite(price) && qqqAt !== null && quotedAt - qqqAt >= -5000 && quotedAt - qqqAt <= 10000 &&
      (entry.direction === 'call' ? price <= level : price >= level)) return 'sampled_qqq_invalidation';
  const emergency = sample.emergency_stop_price ?? entry.emergency_stop_price ?? entry.premium * .75;
  if (finite(emergency) && emergency > 0 && bid <= emergency + 1e-8) return 'sampled_emergency_bid_boundary';
  return null;
}

export function replayProfitModes({ entry, samples = [], closure = null } = {}) {
  const result = { trade_id: entry?.trade_id ?? closure?.trade_id ?? null, option_id: entry?.option_id ?? closure?.option_id ?? null,
    basis: 'Actual verified entry basis and observed quotes; alternative mode triggers are hypothetical and have no assumed sell fills.',
    actual_closure: closure ? { closed_at: closure.closed_at ?? closure.filled_at ?? null, reason: closure.reason ?? null,
      gross_realized_pnl: finite(closure.gross_realized_pnl) ? closure.gross_realized_pnl : null,
      fees: finite(closure.fees) ? closure.fees : null, net_realized_pnl: null } : null, modes: {}, status: 'unavailable', reason: null };
  if (!entry || entry.entry_basis_verified !== true || !finite(entry.premium) || entry.premium <= 0 || ms(entry.opened_at) === null ||
      !['call', 'put'].includes(entry.direction) || typeof entry.expiration_date !== 'string' || !entry.trade_id || !entry.option_id) {
    result.reason = 'Verified actual entry basis, lifetime, direction or expiration is missing'; return result;
  }
  const closed = ms(closure?.closed_at ?? closure?.filled_at);
  const sorted = samples.filter(sample => sample?.trade_id === entry.trade_id && (sample.option_id ?? sample.instrument_id) === entry.option_id)
    .sort((a, b) => (ms(a.option_quote_at ?? a.quote_at) ?? Infinity) - (ms(b.option_quote_at ?? b.quote_at) ?? Infinity));
  const arm = { trade_id: entry.trade_id, option_id: entry.option_id, quantity: 1, direction: entry.direction,
    expiration_date: entry.expiration_date, opened_at: entry.opened_at, entry_premium: entry.premium, entry_basis_verified: true };
  const position = { option_id: entry.option_id, chain_symbol: 'QQQ', type: 'long', quantity: 1, expiration_date: entry.expiration_date };
  for (const mode of EDGE_RESEARCH_SPEC.exits) {
    let state = null, previousAt = null;
    const replay = { mode, status: 'right_censored', observed_samples: 0, rejected_samples: 0, rejected_reasons: [],
      maximum_sample_gap_seconds: null, trigger: null, activated: false, sampled_peak_bid: null,
      quote_bid_minus_actual_entry_per_contract: null, fees: null, net_pnl: null };
    const plan = createProfitProtectionPlan({ arm, evidence: { version: 1, mode, rationale: `Frozen research replay of ${mode} protection using actual observed quotes.` }, now: ms(entry.opened_at) });
    for (const sample of sorted) {
      const quote = sampleQuote(sample), quotedAt = ms(quote.updated_at), observedAt = ms(sample.observed_at ?? sample.at);
      if (quotedAt === null || observedAt === null || quotedAt < ms(entry.opened_at) || closed !== null && observedAt > closed) continue;
      if (sample.position_verified !== true || sample.entry_basis_verified !== true || sample.session?.verified !== true) {
        replay.rejected_samples++; replay.rejected_reasons.push('Actual held lifetime, entry basis or regular session verification missing'); continue;
      }
      if (sample.entry_premium !== undefined && sample.entry_premium !== entry.premium ||
          sample.opened_at !== undefined && ms(sample.opened_at) !== ms(entry.opened_at) ||
          sample.expiration_date !== undefined && sample.expiration_date !== entry.expiration_date ||
          sample.direction !== undefined && sample.direction !== entry.direction || sample.quantity !== undefined && Number(sample.quantity) !== 1) {
        replay.rejected_samples++; replay.rejected_reasons.push('Actual position basis or lifetime changed'); continue;
      }
      const rawUsable = Number.isFinite(Number(quote.bid_price)) && Number(quote.bid_price) > 0 &&
        Number.isFinite(Number(quote.ask_price)) && Number(quote.ask_price) >= Number(quote.bid_price) &&
        observedAt - quotedAt >= -5000 && observedAt - quotedAt <= 10000 && sample.session.is_open === true && sample.session.date <= entry.expiration_date;
      const boundary = rawUsable ? sampledBoundary(entry, sample, quotedAt, Number(quote.bid_price)) : null;
      const evaluation = evaluateProfitProtection({ arm, position, plan, state, quote, session: sample.session, now: observedAt });
      if (evaluation.status === 'unavailable' && !boundary) { replay.rejected_samples++; replay.rejected_reasons.push(evaluation.reason); continue; }
      if (evaluation.status !== 'unavailable') state = evaluation.state;
      replay.observed_samples++;
      if (previousAt !== null) replay.maximum_sample_gap_seconds = Math.max(replay.maximum_sample_gap_seconds ?? 0, (quotedAt - previousAt) / 1000);
      previousAt = quotedAt;
      replay.activated = state?.activated ?? false; replay.sampled_peak_bid = state?.peak_bid ?? Number(quote.bid_price);
      if (boundary || evaluation.exit_requested) {
        replay.status = 'sampled_trigger';
        replay.trigger = { reason: boundary ?? 'profit_protection', quote_at: quote.updated_at, observed_at: new Date(observedAt).toISOString(), bid: Number(quote.bid_price),
          interpretation: boundary === 'sampled_emergency_bid_boundary' ? 'Observed bid crossed the emergency boundary; actual broker stop trigger/fill is not reconstructed.' : 'First sampled trigger; neither a sell order nor a fill is assumed.' };
        replay.quote_bid_minus_actual_entry_per_contract = (Number(quote.bid_price) - entry.premium) * 100;
        break;
      }
    }
    replay.rejected_reasons = [...new Set(replay.rejected_reasons)];
    if (!replay.observed_samples) replay.status = 'unavailable';
    result.modes[mode] = replay;
  }
  result.status = Object.values(result.modes).some(mode => mode.observed_samples > 0) ? 'evaluated' : 'unavailable';
  result.reason = result.status === 'unavailable' ? 'No usable actual held-position quote samples' : 'Only captured prices before verified actual closure can be replayed; continuation beyond closure is censored.';
  return result;
}

function actualFills(journal) {
  const closureMap = new Map();
  for (const record of journal.filter(value => value.event === 'trade_closed')) {
    closureMap.set([record.trade_id, record.option_id, record.closed_at ?? record.filled_at ?? 'unknown'].join('|'), record);
  }
  const closures = [...closureMap.values()];
  return closures.map(record => {
    const entry = journal.find(value => value.event === 'entry_filled' && value.trade_id === record.trade_id && value.option_id === record.option_id);
    const verified = !!entry || record.entry_fill_verified === true || record.historical_backfill === true && record.source === 'Robinhood verified filled orders and realized P&L';
    const feesKnown = finite(record.fees) && (entry ? finite(entry.fees) : false);
    const gross = finite(record.gross_realized_pnl) ? record.gross_realized_pnl : null;
    return { trade_id: record.trade_id, option_id: record.option_id, closed_at: record.closed_at ?? record.filled_at ?? null,
      verified_fills: verified, reason: record.reason ?? null, entry_fill_premium: entry?.premium ?? record.entry_premium ?? (finite(record.entry_premium_total) ? record.entry_premium_total / 100 : null),
      gross_realized_pnl: gross, entry_fees: entry && finite(entry.fees) ? entry.fees : null,
      exit_fees: finite(record.fees) ? record.fees : null, net_realized_pnl: verified && feesKnown && gross !== null ? gross - entry.fees - record.fees : null,
      pnl_basis: record.pnl_basis ?? null, interpretation: 'Broker fill results are separate from research quote movements; net result is unknown unless both fee amounts are recorded.' };
  });
}

function quoteComparisons(cases) {
  const rows = [];
  for (const item of cases) for (const [basisId, basis] of Object.entries(item.bases ?? {})) {
    const references = basis.reference_contracts ?? {};
    const baselineAt = ms(basis.reference_observed_at), qualifiedAt = ms(basis.qualified_at ?? item.first_observed_at);
    const entryGate = item.baseline_selection_context?.entry_gate ?? item.entry_gate ?? { status: 'unknown', reason: 'Fresh complete entry gate was not checked for this research quote', checked_at: null };
    for (const endpoint of [...Object.values(basis.horizons ?? {}), ...Object.values(basis.scalp?.horizons ?? {})]) {
      const targetSeconds = finite(endpoint.intended_seconds) ? endpoint.intended_seconds : finite(endpoint.intended_minutes) ? endpoint.intended_minutes * 60 : null;
      for (const [instrumentId, movement] of Object.entries(endpoint.quoted_movements ?? {})) {
        if (!movement || !finite(movement.bid_minus_reference_ask_per_contract)) continue;
        rows.push({ case_id: item.case_id, direction: item.direction, basis_id: basisId, instrument_id: instrumentId,
          reference_ask: movement.reference_ask ?? references[instrumentId]?.ask ?? null, observed_bid: movement.observed_bid ?? null,
          quote_bid_minus_reference_ask_per_contract: movement.bid_minus_reference_ask_per_contract,
          baseline_observed_at: basis.reference_observed_at ?? null,
          baseline_delay_seconds: baselineAt !== null && qualifiedAt !== null ? (baselineAt - qualifiedAt) / 1000 : null,
          reference_quote_at: movement.reference_quote_at ?? references[instrumentId]?.updated_at ?? null,
          endpoint_observed_at: endpoint.observed_at ?? null, endpoint_quote_at: movement.observed_quote_at ?? null,
          intended_seconds: targetSeconds,
          actual_elapsed_seconds: finite(endpoint.actual_elapsed_seconds) ? endpoint.actual_elapsed_seconds : finite(endpoint.actual_elapsed_minutes) ? endpoint.actual_elapsed_minutes * 60 : null,
          delay_seconds: finite(endpoint.delay_seconds) ? endpoint.delay_seconds : finite(endpoint.delay_minutes) ? endpoint.delay_minutes * 60 : null,
          actual_quote_elapsed_seconds: finite(movement.actual_quote_elapsed_seconds) ? movement.actual_quote_elapsed_seconds : finite(movement.actual_quote_elapsed_minutes) ? movement.actual_quote_elapsed_minutes * 60 : null,
          entry_gate: entryGate, fees: null, net_pnl: null, execution_basis: 'actual_quote_ask_to_bid_only_no_assumed_fills' });
      }
    }
  }
  return rows;
}

export function summarizeEdgeResearch({ researchState = {}, journal = [], context = null, entries = [], specRecordedAt = null, now = Date.now() } = {}) {
  const cases = Object.values(researchState.cases ?? {}), episodes = groupResearchEpisodes(cases);
  const specAt = ms(specRecordedAt);
  const isProspective = item => specAt !== null && ms(item.first_observed_at) !== null && ms(item.first_observed_at) >= specAt;
  const episodeFor = new Map(episodes.flatMap(episode => episode.case_ids.map(id => [id, episode.episode_id])));
  const byCase = new Map(cases.map(item => [item.case_id, item]));
  const quoteRows = quoteComparisons(cases).map(row => ({ ...row, episode_id: episodeFor.get(row.case_id) ?? null,
    evidence_cohort: isProspective(byCase.get(row.case_id)) ? 'prospective_after_spec_freeze' : 'legacy_exploratory' }));
  const normalizedEntries = entries.map(entry => ({ ...entry }));
  for (const record of journal.filter(value => value.event === 'entry_filled')) {
    if (normalizedEntries.some(entry => entry.trade_id === record.trade_id)) continue;
    normalizedEntries.push({ ...record, premium: record.premium, opened_at: record.filled_at,
      entry_basis_verified: true, entry_fill_verified: true, entry_basis_source: 'broker_order_fill' });
  }
  // Future held observations carry the actual arm basis. Legacy observations
  // without that provenance remain unavailable rather than receiving guesses.
  for (const record of journal.filter(value => value.event === 'price_observation' && value.entry_basis_verified === true)) {
    const previous = normalizedEntries.find(value => value.trade_id === record.trade_id);
    const actual = { trade_id: record.trade_id, option_id: record.option_id, direction: record.direction,
      expiration_date: record.expiration_date, premium: record.entry_premium, opened_at: record.opened_at,
      entry_basis_verified: true, entry_fill_verified: record.entry_fill_verified === true,
      entry_basis_source: record.entry_basis_source, qqq_invalidation: record.qqq_invalidation,
      mandatory_exit_at: record.mandatory_exit_at };
    if (!previous) normalizedEntries.push(actual);
    else for (const [key, value] of Object.entries(actual)) if (previous[key] === undefined && value !== undefined) previous[key] = value;
  }
  // A verified closure without the old entry basis is still an unavailable
  // comparison, rather than disappearing from the replay denominator.
  for (const record of journal.filter(value => value.event === 'trade_closed' && value.trade_id)) {
    if (normalizedEntries.some(entry => entry.trade_id === record.trade_id)) continue;
    normalizedEntries.push({ trade_id: record.trade_id, option_id: record.option_id,
      entry_basis_verified: false, entry_basis_source: 'historical_closure_only' });
  }
  const replays = normalizedEntries.map(entry => replayProfitModes({ entry,
    samples: journal.filter(value => value.event === 'price_observation'),
    closure: journal.find(value => value.event === 'trade_closed' && value.trade_id === entry.trade_id) ?? null }))
    .map((replay, index) => ({ ...replay, evidence_cohort: specAt !== null && ms(normalizedEntries[index].opened_at) >= specAt ? 'prospective_after_spec_freeze' : 'legacy_exploratory' }));
  const paths = [];
  for (const item of cases) for (const [basisId, basis] of Object.entries(item.bases ?? {})) {
    const scalp = summarizeScalpBasis(basis, { now });
    for (const [instrumentId, path] of Object.entries(scalp?.instruments ?? {})) {
      paths.push({ case_id: item.case_id, episode_id: episodeFor.get(item.case_id) ?? null, basis_id: basisId, instrument_id: instrumentId,
        coverage: path.coverage ?? null, ask_to_bid_mfe_dollars: path.ask_to_bid_mfe_dollars ?? null,
        ask_to_bid_mae_dollars: path.ask_to_bid_mae_dollars ?? null,
        interpretation: 'Extrema among captured quotes only; intervening highs and lows may be missed. No fills or fees assumed.' });
    }
  }
  const gateCounts = { qualified: 0, blocked: 0, unknown: 0 }, gateReasons = {};
  for (const item of cases) {
    const gate = item.baseline_selection_context?.entry_gate ?? item.entry_gate ?? { status: 'unknown', reason: 'No complete live entry gate was checked' };
    gateCounts[['qualified', 'blocked', 'unknown'].includes(gate.status) ? gate.status : 'unknown']++;
    gateReasons[gate.reason] = (gateReasons[gate.reason] ?? 0) + 1;
  }
  const paired = episodes.map(episode => {
    const selected = cases.filter(item => episode.case_ids.includes(item.case_id) && isProspective(item));
    const early = selected.filter(item => item.first_event_kind === 'early_break' || item.signal?.pattern === 'early_break_shadow' || item.early_break_signal);
    const confirmed = selected.filter(item => item.first_event_kind === 'setup');
    return { episode_id: episode.episode_id, session_date: episode.session_date,
      early_shadow_cases: early.map(item => item.case_id), completed_setup_cases: confirmed.map(item => item.case_id),
      same_instrument_comparable: early.some(first => confirmed.some(second => first.primary_instrument_id && first.primary_instrument_id === second.primary_instrument_id)),
      interpretation: 'Pair within the same market episode and compare captured prices on the same contract; baseline delay and eligibility remain visible.' };
  });
  return { version: 1, as_of: new Date(now).toISOString(), research_spec: EDGE_RESEARCH_SPEC, research_spec_hash: EDGE_RESEARCH_SPEC_HASH,
    spec_recorded_at: specAt === null ? null : new Date(specAt).toISOString(),
    sample_units: { retained_cases: cases.length, market_episodes: episodes.length,
      sessions: new Set(episodes.map(episode => episode.session_date)).size,
      prospective_cases: cases.filter(isProspective).length,
      prospective_market_episodes: new Set(cases.filter(isProspective).map(item => episodeFor.get(item.case_id))).size,
      prospective_sessions: new Set(cases.filter(isProspective).map(item => day(item.first_observed_at))).size,
      overlapping_cases_grouped: cases.length - episodes.reduce((sum, episode) => sum + Number(episode.case_ids.length > 0), 0),
      interpretation: 'Case and endpoint counts are dependent observations; use market episodes and sessions when evaluating prospective evidence.' },
    entry_gate_counts: gateCounts, entry_gate_reasons: gateReasons, episodes, prospective_entry_pairs: paired, quote_comparisons: quoteRows,
    scalp_paths: paths, actual_fills: actualFills(journal), actual_entry_profit_mode_replays: replays,
    context, live_strategy_changes: false,
    limitations: ['The fixed specification is research-only and does not alter live entry or exit rules.',
      'No statistical edge or profitable expectancy is established by a small set of overlapping observations.',
      'Quote movements are separate from actual fills; spreads are included by ask-to-bid comparison, while fees and execution slippage remain unknown.',
      'Missing or delayed endpoints are not reconstructed from candle highs or marks.',
      'Held-trade alternate exits stop at actual closure unless a separate prospective quote path continues; no post-close position is assumed.'] };
}
