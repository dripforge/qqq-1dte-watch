import { quoteReferenceMovement } from './research-policy.mjs';

export const SCALP_RESEARCH_LIMITS = Object.freeze({ interval_seconds: 10, path_seconds: 120,
  horizons_seconds: Object.freeze([30, 60, 120]), endpoint_lateness_seconds: 20,
  max_samples_per_instrument: 16, coverage_gap_seconds: 20, scheduling_lead_seconds: 2.5 });

const elapsed = (basis, now) => (now - Date.parse(basis.reference_observed_at)) / 1000;
function createScalp() { return { version: 1, interval_seconds: 10, horizons: {}, instruments: {} }; }
function coverage(series, basis, now) {
  const rows = series.samples, origin = Date.parse(basis.reference_observed_at);
  // Grid coverage counts only actual quote timestamps, never interpolated prices.
  // The baseline itself occupies the initial slot even if its quote precedes the read.
  const slots = new Set([0]);
  for (const row of rows.slice(1)) {
    const at = (Date.parse(row.quote_at) - origin) / 1000;
    if (at >= 0 && at <= 120) slots.add(Math.floor(at / 10));
  }
  const time = rows.map(row => Date.parse(row.quote_at));
  const gaps = time.slice(1).map((at, index) => (at - time[index]) / 1000);
  return { sample_count: rows.length, expected_sample_count: 13,
    observed_grid_slot_count: slots.size, expected_grid_slot_count: 13,
    grid_coverage_fraction: slots.size / 13,
    max_observed_gap_seconds: gaps.length ? Math.max(...gaps) : null,
    large_gap_count: gaps.filter(value => value > SCALP_RESEARCH_LIMITS.coverage_gap_seconds).length,
    missing_horizons_seconds: SCALP_RESEARCH_LIMITS.horizons_seconds.filter(value => !basis.scalp.horizons[String(value)]),
    window_complete: elapsed(basis, now) >= 140,
    interpretation: 'Sampled quote coverage only. Missing intervals may contain unseen prices; no fill or continuous path is assumed.' };
}
function addSample(basis, quote, event) {
  if (!quote?.quote_usable) return;
  const reference = basis.reference_contracts[quote.instrument_id];
  const movement = quoteReferenceMovement(reference, quote);
  if (!movement) return;
  const scalp = basis.scalp ??= createScalp();
  const series = scalp.instruments[quote.instrument_id] ??= { reference_ask: reference.ask,
    reference_quote_at: reference.updated_at, reference_observed_at: basis.reference_observed_at, samples: [] };
  if (series.samples.some(row => row.quote_at === quote.updated_at)) return;
  if (series.samples.length && Date.parse(quote.updated_at) <= Date.parse(series.samples.at(-1).quote_at)) return;
  if (series.samples.length >= SCALP_RESEARCH_LIMITS.max_samples_per_instrument) return;
  series.samples.push({ observed_at: event.observed_at, quote_at: quote.updated_at, bid: quote.bid, ask: quote.ask,
    bid_size: quote.bid_size, ask_size: quote.ask_size, qqq_price: event.qqq_quote?.quote_usable ? event.qqq_quote.price : null,
    bid_minus_reference_ask_per_contract: movement.bid_minus_reference_ask_per_contract });
  const values = series.samples.map(row => row.bid_minus_reference_ask_per_contract);
  series.sampled_max_bid_minus_reference_ask_per_contract = Math.max(...values);
  series.sampled_min_bid_minus_reference_ask_per_contract = Math.min(...values);
  series.ask_to_bid_mfe_dollars = Math.max(0, Math.max(...values));
  series.ask_to_bid_mae_dollars = Math.max(0, -Math.min(...values));
  series.coverage = coverage(series, basis, Date.parse(event.observed_at));
  series.interpretation = 'Sampled future bid minus actual baseline ask, multiplied by 100. Includes observed spread cost; fees, slippage and fills are unknown.';
}

export function initializeScalpBasis(basis, event) {
  if (!basis.reference_observed_at || basis.scalp) return;
  basis.scalp = createScalp();
  // Primary paths stay bounded even when an observation compares four optional
  // alternative contracts. Alternatives retain their actual endpoint prices.
  const primary = basis.reference_contracts[event.selected_contract?.instrument_id];
  if (primary) addSample(basis, primary, event);
}

export function applyScalpObservation(basis, event) {
  if (!basis?.reference_observed_at) throw Error('Scalp basis has no actual reference quote');
  const observed = Date.parse(event.observed_at), seconds = elapsed(basis, observed), intended = event.horizon_seconds;
  if (seconds < 0) throw Error('Scalp observation precedes its actual baseline');
  if (intended === null && (seconds < 10 || seconds > 120)) throw Error('Scalp path observation is outside its actual first-120-second window');
  if (intended !== null && (seconds < intended || seconds >= intended + 20)) throw Error('Scalp endpoint does not match its actual time window; do not backfill');
  const selected = event.selected_contract;
  if (!selected?.quote_usable) throw Error('Scalp observation requires an actual fresh selected option quote');
  if (Date.parse(selected.updated_at) <= Date.parse(basis.reference_contracts[selected.instrument_id]?.updated_at)) throw Error('Scalp observation requires a newer actual quote than its baseline');
  // Old version-one cases retain an actual baseline quote in their ledger. Add
  // only that documented observation, never any missing intermediate prices.
  if (!basis.scalp) initializeScalpBasis(basis, { observed_at: basis.reference_observed_at,
    selected_contract: event.selected_contract, qqq_quote: { quote_usable: false } });
  const scalp = basis.scalp;
  if (intended !== null) {
    if (scalp.horizons[String(intended)]) throw Error('This scalp endpoint is already recorded');
    const intendedAt = Date.parse(basis.reference_observed_at) + intended * 1000;
    if (Date.parse(selected.updated_at) < intendedAt) throw Error('Scalp endpoint quote precedes its intended timestamp');
    const usable = [event.selected_contract, ...event.alternatives].filter(quote => quote?.quote_usable && Date.parse(quote.updated_at) >= intendedAt);
    const movements = Object.fromEntries(usable.map(quote => {
      const movement = quoteReferenceMovement(basis.reference_contracts[quote.instrument_id], quote);
      return [quote.instrument_id, movement ? { ...movement, actual_quote_elapsed_seconds: movement.actual_quote_elapsed_minutes * 60 } : null];
    }));
    if (!movements[selected.instrument_id]) throw Error('Scalp endpoint has no same-contract actual reference quote');
    scalp.horizons[String(intended)] = { intended_seconds: intended, actual_elapsed_seconds: seconds,
      delay_seconds: seconds - intended, observed_at: event.observed_at, quoted_movements: movements,
      interpretation: 'Actual later bid compared with captured baseline ask; neither price is an assumed fill.' };
  }
  // After 120 seconds only the bounded 120-second endpoint may append a quote.
  addSample(basis, event.selected_contract, event);
  for (const series of Object.values(scalp.instruments)) series.coverage = coverage(series, basis, observed);
}

export function summarizeScalpBasis(basis, { now = Date.now() } = {}) {
  if (!basis?.scalp) return null;
  const result = structuredClone(basis.scalp), copy = { ...basis, scalp: result };
  for (const series of Object.values(result.instruments)) series.coverage = coverage(series, copy, now);
  return result;
}

export function dueScalpResearch(state, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw Error('Scalp observation time is invalid');
  const pending = [], expired = [];
  for (const item of Object.values(state.cases)) for (const [basisId, basis] of Object.entries(item.bases)) {
    if (!basis.reference_observed_at) continue;
    const seconds = elapsed(basis, now), horizons = basis.scalp?.horizons ?? {};
    const missed = SCALP_RESEARCH_LIMITS.horizons_seconds.filter(value => !horizons[String(value)] && seconds >= value + 20);
    if (missed.length) expired.push({ case_id: item.case_id, basis_id: basisId,
      missed_horizons_seconds: missed, actual_elapsed_seconds: seconds });
    // Eligibility is assessed before the bounded broker reads. Allow their
    // latency here; recording still requires actual post-target quote times.
    const lead = SCALP_RESEARCH_LIMITS.scheduling_lead_seconds;
    const endpoint = SCALP_RESEARCH_LIMITS.horizons_seconds.find(value => !horizons[String(value)] && seconds >= value - lead && seconds < value + 20) ?? null;
    const primary = item.primary_instrument_id, samples = basis.scalp?.instruments?.[primary]?.samples ?? [];
    const lastObserved = samples.length ? Date.parse(samples.at(-1).observed_at) : Date.parse(basis.reference_observed_at);
    const pathDue = seconds >= 10 - lead && seconds <= 120 && now - lastObserved >= (10 - lead) * 1000;
    if (endpoint === null && !pathDue) continue;
    if (!primary || !basis.reference_contracts[primary]) continue;
    pending.push({ case_id: item.case_id, basis_id: basisId, direction: item.direction,
      trade_id: item.trade_id, primary_instrument_id: primary, horizon_seconds: endpoint,
      intended_at: new Date(Date.parse(basis.reference_observed_at) + (endpoint ?? Math.min(120, Math.floor(seconds / 10) * 10)) * 1000).toISOString(),
      actual_elapsed_seconds: seconds, instrument_ids: Object.keys(basis.reference_contracts) });
  }
  // Endpoint deadlines outrank path samples; the oldest intended observation wins ties.
  pending.sort((a, b) => Number(b.horizon_seconds !== null) - Number(a.horizon_seconds !== null) || Date.parse(a.intended_at) - Date.parse(b.intended_at));
  const requested = new Set(), selected = [];
  for (const item of pending) {
    if (!requested.has(item.primary_instrument_id) && requested.size >= 5 || selected.length >= 10) continue;
    requested.add(item.primary_instrument_id); selected.push(item);
  }
  for (const item of selected) for (const id of item.instrument_ids) if (requested.has(id) || requested.size < 5) requested.add(id);
  const metadata = {};
  for (const item of selected) for (const id of requested) {
    const quote = state.cases[item.case_id].bases[item.basis_id].reference_contracts[id];
    if (quote) metadata[id] = { instrument_id: id, expiration: quote.expiration, strike: quote.strike };
  }
  return { version: 1, observed_at: new Date(now).toISOString(), due: selected.map(item => ({ ...item,
    instrument_ids: item.instrument_ids.filter(id => requested.has(id)) })), instrument_ids: [...requested],
    contract_metadata: metadata, expired: expired.slice(-200), deferred_due_count: pending.length - selected.length };
}
