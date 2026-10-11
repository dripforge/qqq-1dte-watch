import { runtimeDirectory } from './runtime-paths.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, realpathSync, statSync,
  openSync, readSync, closeSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
import { validateResearchEvent, quoteReferenceMovement, RESEARCH_LIMITS } from './research-policy.mjs';
import { initializeScalpBasis, applyScalpObservation, dueScalpResearch, SCALP_RESEARCH_LIMITS } from './scalp-research.mjs';

const root = runtimeDirectory();
const MAX_CASES = 200;
const MAX_SEEN = 1000;
const HORIZONS = [5, 15, 30];
export const RESEARCH_NOTICE = 'Research uses actual timestamped quotes and completed broker bars. It assumes no entry or exit fills, places no orders, and does not establish profitable expectancy.';

function atomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} is not valid JSON`); }
}
export function readResearchState(folder) {
  const path = join(folder, 'research-state.json');
  if (!existsSync(path)) {
    if (existsSync(join(folder, 'research-journal.jsonl'))) throw new Error('Research state is missing while its journal exists; recover research separately');
    return { version: 1, recorded_events: 0, created_cases: 0, seen_event_ids: [], cases: {} };
  }
  if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Research state exceeds its bound');
  const state = parseJson(readFileSync(path, 'utf8'), 'Research state');
  if (state.version !== 1 || !Number.isSafeInteger(state.recorded_events) || state.recorded_events < 0 ||
      !Number.isSafeInteger(state.created_cases) || state.created_cases < 0 || !Array.isArray(state.seen_event_ids) ||
      !state.cases || typeof state.cases !== 'object' || Array.isArray(state.cases)) throw new Error('Research state is invalid');
  return state;
}
function quotes(event) { return [event.selected_contract, ...event.alternatives].filter(value => value?.quote_usable); }
function ensureBasis(item, name, event) {
  if (!item.bases[name]) item.bases[name] = { qualified_at: event.observed_at,
    reference_observed_at: null, reference_contracts: {}, horizons: {} };
  const basis = item.bases[name];
  // Freeze all contracts at one observation. A later alternative cannot inherit
  // an earlier baseline time and pretend it was observable then.
  if (!basis.reference_observed_at) {
    for (const quote of quotes(event)) basis.reference_contracts[quote.instrument_id] = quote;
    if (Object.keys(basis.reference_contracts).length) { basis.reference_observed_at = event.observed_at; initializeScalpBasis(basis,event); }
  }
  return basis;
}
function updateQuotes(item, event) {
  for (const quote of quotes(event)) {
    const previous = item.latest_quotes[quote.instrument_id];
    if (!previous || Date.parse(quote.updated_at) >= Date.parse(previous.updated_at)) item.latest_quotes[quote.instrument_id] = quote;
  }
}
function updateTrails(item, event) {
  if (event.trail_comparison) {
    for (const key of ['one_minute', 'five_minute']) {
      const candidate = event.trail_comparison[key];
      if (!candidate || item.trails[key]?.cross_observed_at) continue;
      const previous = item.trails[key];
      const level = previous ? event.direction === 'call' ? Math.max(previous.level, candidate.level) : Math.min(previous.level, candidate.level) : candidate.level;
      if (previous && level === previous.level) continue;
      item.trails[key] = { ...candidate, level, first_level_observed_at: previous?.first_level_observed_at ?? event.observed_at,
        last_level_observed_at: event.observed_at, buffer: event.trail_comparison.buffer };
    }
  }
  if (!event.qqq_quote.quote_usable) return;
  for (const trail of Object.values(item.trails)) {
    if (trail.cross_observed_at) continue;
    const crossed = event.direction === 'call' ? event.qqq_quote.price <= trail.level : event.qqq_quote.price >= trail.level;
    if (!crossed) continue;
    trail.cross_observed_at = event.observed_at;
    trail.qqq_quote_at_cross = event.qqq_quote;
    trail.selected_option_quote_at_cross = event.selected_contract?.quote_usable ? event.selected_contract : null;
    trail.interpretation = 'First sampled crossing only; no sell order or execution price is assumed.';
  }
}

function horizonFor(elapsed) {
  if (elapsed >= 45 || elapsed < 5) return null;
  return elapsed >= 30 ? 30 : elapsed >= 15 ? 15 : 5;
}
function applyEvent(state, event) {
  let item = state.cases[event.case_id];
  if (!item) {
    if (['followup','quote_baseline','scalp_observation'].includes(event.event_kind)) throw new Error('Followup or quote baseline requires an existing research case');
    item = { case_id: event.case_id, direction: event.direction, trade_id: event.trade_id,
      first_observed_at: event.observed_at, last_observed_at: event.observed_at,
      primary_instrument_id: event.selected_contract?.instrument_id ?? null,
      primary_contract_metadata: event.selected_contract?{instrument_id:event.selected_contract.instrument_id,expiration:event.selected_contract.expiration,strike:event.selected_contract.strike}:null,
      bases: {}, trails: {}, latest_quotes: {}, measurements: null,
      shadow_comparison: null, live_qualified_seen: false, first_event_kind:event.event_kind,
      setup_evidence:event.setup??(event.early_setup?{reference_level:event.early_setup.reference_level,break_bar_at:event.early_setup.break_bar_at}:null),
      early_setup_evidence:event.early_setup??null, baseline_selection_context:null };
    state.cases[event.case_id] = item;
    state.created_cases++;
  }
  if (item.direction !== event.direction || item.trade_id && event.trade_id && item.trade_id !== event.trade_id ||
      item.primary_instrument_id && event.selected_contract && item.primary_instrument_id !== event.selected_contract.instrument_id) {
    throw new Error('Research case identity does not match this observation');
  }
  if (Date.parse(event.observed_at) < Date.parse(item.last_observed_at)) throw new Error('Research followup is older than the current case');
  if (!item.primary_instrument_id && event.selected_contract) item.primary_instrument_id = event.selected_contract.instrument_id;
  if(!item.primary_contract_metadata&&event.selected_contract)item.primary_contract_metadata={instrument_id:event.selected_contract.instrument_id,expiration:event.selected_contract.expiration,strike:event.selected_contract.strike};
  if (!item.trade_id && event.trade_id) item.trade_id = event.trade_id;
  if (event.event_kind==='quote_baseline') {
    for(const name of event.basis_ids){
      const basis=item.bases[name];
      if(!basis)throw new Error('Quote baseline requires a previously observed qualified basis');
      if(basis.reference_observed_at)throw new Error('An actual baseline already exists and cannot be replaced');
      ensureBasis(item,name,event);
      basis.baseline_delay_minutes=(Date.parse(event.observed_at)-Date.parse(basis.qualified_at))/60000;
    }
    item.baseline_selection_context=event.selection_context;
  } else if(!['followup','scalp_observation'].includes(event.event_kind))ensureBasis(item,'case',event);
  if(event.event_kind==='scalp_observation')applyScalpObservation(item.bases[event.basis_id],event);
  if(event.setup&&!item.setup_evidence)item.setup_evidence=event.setup;
  if (event.measurements) item.measurements = event.measurements;
  if(event.candle_quality)item.candle_quality=event.candle_quality;
  if(event.comparison_quality)item.comparison_quality=event.comparison_quality;
  if (event.shadow_comparison) {
    item.shadow_comparison = event.shadow_comparison;
    if (event.shadow_comparison.break_hold === true) ensureBasis(item, 'bearish_break_hold', event);
    if (event.shadow_comparison.failed_reclaim === true) ensureBasis(item, 'bearish_failed_reclaim', event);
  }
  if (event.setup?.live_qualified === true) item.live_qualified_seen = true;
  updateQuotes(item, event);
  updateTrails(item, event);
  if (event.event_kind === 'followup') {
    const basis = item.bases[event.basis_id];
    if (!basis?.reference_observed_at) throw new Error('Followup basis has no actual reference quote');
    const elapsed = (Date.parse(event.observed_at) - Date.parse(basis.reference_observed_at)) / 60000;
    if (elapsed < 0) throw new Error('Followup precedes its actual reference quote');
    const intended = event.horizon_minutes;
    if (intended !== null) {
      if (horizonFor(elapsed) !== intended) throw new Error('Followup horizon does not match its actual time window; do not backfill a missed endpoint');
      if (basis.horizons[String(intended)]) throw new Error('This comparison endpoint is already recorded');
      const movements = Object.fromEntries(quotes(event).map(quote => [quote.instrument_id,
        quoteReferenceMovement(basis.reference_contracts[quote.instrument_id], quote)]));
      basis.horizons[String(intended)] = { intended_minutes: intended, actual_elapsed_minutes: elapsed,
        delay_minutes: elapsed - intended, observed_at: event.observed_at, quoted_movements: movements,
        interpretation: 'Actual later bid compared with the captured reference ask; neither price is an assumed fill.' };
    }
  }
  item.last_observed_at = event.observed_at;
  state.recorded_events++;
  state.seen_event_ids.push(event.event_id);
  state.seen_event_ids = state.seen_event_ids.slice(-MAX_SEEN);
  const old = Object.values(state.cases).sort((a, b) => Date.parse(a.last_observed_at) - Date.parse(b.last_observed_at));
  while (old.length > MAX_CASES) delete state.cases[old.shift().case_id];
}

function recentJournalContains(folder, eventId) {
  const path = join(folder, 'research-journal.jsonl');
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  const length = Math.min(size, 1024 * 1024);
  const bytes = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try { readSync(fd, bytes, 0, length, size - length); } finally { closeSync(fd); }
  const lines = bytes.toString('utf8').split('\n');
  if (size > length) lines.shift();
  return lines.filter(Boolean).some(line => { try { return JSON.parse(line).event_id === eventId; } catch { return false; } });
}

export function recordResearch(inputPath, { folder = root, now = Date.now() } = {}) {
  const actualRoot = realpathSync(folder);
  const candidate = realpathSync(resolve(actualRoot, inputPath));
  const within = relative(actualRoot, candidate);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith('../')) throw new Error('Research input must be inside its configured folder');
  const stat = statSync(candidate);
  if (!stat.isFile() || stat.size > RESEARCH_LIMITS.max_input_bytes) throw new Error('Research input must be a JSON file no larger than 16 KiB');
  return recordResearchEvent(parseJson(readFileSync(candidate, 'utf8'), 'Research input'), { folder: actualRoot, now });
}

export function recordResearchEvent(input, { folder = root, now = Date.now() } = {}) {
  const actualRoot = realpathSync(folder);
  if (Buffer.byteLength(JSON.stringify(input), 'utf8') > RESEARCH_LIMITS.max_input_bytes) throw new Error('Research input must be no larger than 16 KiB');
  const event = validateResearchEvent(input, now);
  const release = acquireProcessLock(join(actualRoot, 'research.lock'));
  try {
    const state = readResearchState(actualRoot);
    if (state.seen_event_ids.includes(event.event_id)) return { status: 'deduplicated', case_id: event.case_id, event_id: event.event_id };
    applyEvent(state, event);
    const record = { ...event, recorded_at: new Date(now).toISOString(), notice: RESEARCH_NOTICE };
    // If an earlier append survived a crash before the summary write, recover
    // that summary without appending the same evidence a second time.
    if (!recentJournalContains(actualRoot, event.event_id)) appendFileSync(join(actualRoot, 'research-journal.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 });
    atomic(join(actualRoot, 'research-state.json'), state);
    atomic(join(actualRoot, 'research-latest.json'), record);
    return { status: 'recorded', case_id: event.case_id, event_id: event.event_id,
      missing_data: event.missing_data, shadow_comparison: event.shadow_comparison,
      trail_comparison: event.trail_comparison, notice: RESEARCH_NOTICE };
  } finally { release(); }
}

export function dueResearchScalps(folder,{now=Date.now()}={}) { return dueScalpResearch(readResearchState(folder),{now}); }

export function dueResearchFollowups(folder, { now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error('Followup observation time is invalid');
  const state = readResearchState(folder);
  const pending = [], expired = [];
  for (const item of Object.values(state.cases)) {
    for (const [basisId, basis] of Object.entries(item.bases)) {
      if (!basis.reference_observed_at) continue;
      const elapsed = (now - Date.parse(basis.reference_observed_at)) / 60000;
      const missing = HORIZONS.filter(value => !basis.horizons[String(value)]);
      const horizon = horizonFor(elapsed);
      const past = missing.filter(value => elapsed >= (value === 5 ? 15 : value === 15 ? 30 : 45));
      if (past.length) expired.push({ case_id: item.case_id, basis_id: basisId,
        missed_horizons_minutes: past, actual_elapsed_minutes: elapsed });
      if (horizon === null || !missing.includes(horizon)) continue;
      const ids = Object.keys(basis.reference_contracts);
      pending.push({ case_id: item.case_id, basis_id: basisId, direction: item.direction,
        trade_id: item.trade_id, primary_instrument_id: item.primary_instrument_id,
        horizon_minutes: horizon, intended_at: new Date(Date.parse(basis.reference_observed_at) + horizon * 60000).toISOString(),
        actual_elapsed_minutes: elapsed, instrument_ids: ids });
    }
  }
  pending.sort((a, b) => Date.parse(a.intended_at) - Date.parse(b.intended_at));
  const requested = new Set();
  const selected = [];
  for (const item of pending) {
    const primary = item.primary_instrument_id;
    if (!primary || !item.instrument_ids.includes(primary)) continue;
    if (!requested.has(primary) && requested.size >= 5) continue;
    if (selected.length >= 10) break;
    requested.add(primary);
    selected.push(item);
  }
  for (const item of selected) for (const id of item.instrument_ids) if (requested.has(id) || requested.size < 5) requested.add(id);
  const metadata = {};
  for (const item of selected) {
    const reference = state.cases[item.case_id].bases[item.basis_id].reference_contracts;
    for (const id of requested) {
      const contract = reference[id];
      if (contract) metadata[id] = { instrument_id: id, expiration: contract.expiration, strike: contract.strike };
    }
  }
  return { version: 1, observed_at: new Date(now).toISOString(), due: selected.slice(0, 10).map(item => ({
    ...item, instrument_ids: item.instrument_ids.filter(id => requested.has(id)) })),
    instrument_ids: [...requested], contract_metadata: metadata, expired: expired.slice(-20),
    deferred_due_count: pending.length - Math.min(selected.length, 10),
    notice: 'At most one extra batched quote read with five instruments. Use existing fresh QQQ data; skip research if protection or core completion needs attention.' };
}

export function researchSchema() {
  const emptyQuote = { instrument_id: 'OPTION_UUID', expiration: 'YYYY-MM-DD', strike: 0,
    bid: null, ask: null, bid_size: null, ask_size: null, updated_at: null, delta: null, theta: null, gamma: null, vega: null, implied_volatility: null, volume: null, open_interest: null };
  const base = { version: 1, event_kind: 'setup', observed_at: 'ISO_UTC', source: 'robinhood_trading_mcp',
    case_id: null, direction: 'put', trade_id: null, qqq_quote: { price: null, last_trade_at: null },
    selected_contract: null, alternatives: [] };
  return { version: 1, setup_template: { ...base, setup: { reference_level: null, qqq_invalidation: null,
    next_obstacle: null, break_bar_at: 'EXACT_BROKER_BEGINS_AT', confirm_bar_at: 'EXACT_BROKER_BEGINS_AT',
    confirmation_1m_at: 'EXACT_BROKER_BEGINS_AT', live_qualified: null }, one_minute_bars: null, five_minute_bars: null },
    trail_template: { ...base, event_kind: 'trail', trade_id: 'TRADE_UUID', opened_at: 'VERIFIED_FILL_ISO',
      one_minute_bars: null, five_minute_bars: null },
    followup_template: { ...base, event_kind: 'followup', case_id: 'CASE_SHA256_FROM_DUE',
      basis_id: 'case', horizon_minutes: 5 }, contract_quote_template: emptyQuote,
    scalp_template: {...base,event_kind:'scalp_observation',case_id:'EXISTING_CASE_SHA256',basis_id:'case',horizon_seconds:30,selected_contract:emptyQuote},
    early_break_template:{...base,event_kind:'early_break',early_setup:{reference_level:0,break_bar_at:'EXACT_BROKER_BEGINS_AT',break_completed_at:'BREAK_BEGIN_PLUS_FIVE_MINUTES',latest_completed_1m_at:'EXACT_BROKER_BEGINS_AT',reference_kind:'prior_5m_close',reference_established_at:'PRIOR_BAR_COMPLETION_TIME',live_qualified:false},one_minute_bars:null,five_minute_bars:null},
    quote_baseline_template:{...base,event_kind:'quote_baseline',case_id:'EXISTING_SETUP_CASE_SHA256',basis_ids:['case'],
      selected_contract:emptyQuote,selection_context:{premium_ceiling_dollars:500,cash_snapshot_at:null,affordability:'unknown',
        entry_gate:{status:'unknown',reason:'Live eligibility has not been checked.',checked_at:null},post_stop_context:null}},
    queue_template:{case_id:'EXISTING_SETUP_CASE_SHA256',cash_snapshot:{available_cash_dollars:0,observed_at:'ACTUAL_SNAPSHOT_ISO'},
      entry_gate:{status:'blocked',reason:'Exact result from an actual fresh gate check.',checked_at:'ACTUAL_CHECK_ISO'}},
    instructions: ['Use actual broker timestamps and values; every missing quote or Greek field is null.',
      'Map broker instrument_id, expiration_date, strike_price, bid_price, ask_price, bid_size, ask_size, updated_at, delta, theta, gamma, vega, implied_volatility, volume, open_interest to the quote template; numeric fields are numbers.',
      'Copy completed broker bars only, no more than 24 per interval; retain interpolated and session fields. Include at least 10 one-minute bars for trail comparisons.',
      'The separate read-only collector may price a setup within 15 minutes in the same verified session. It pauses for any local trade intent, arm, or busy broker lock; the scheduled watch should not repeat these extra reads.',
      'A later quote_baseline records a current quote for an existing setup basis. It preserves the original setup and observation time and cannot replace an earlier actual baseline. Missing cash or fresh entry gates remain unknown and do not authorize a trade.',
      'Record setup once a completed 5m candidate changes. For an active trade, reuse already fetched data to record a trail observation once per watch, so sampled crossings remain observable.',
      'Followups use the case_id/basis_id/horizon returned by --due; one extra batched quote call at most, only after core work and within its time budget.',
      'Do not backfill a missed 5-minute observation with a 15-minute quote. Timing and absent endpoints remain explicit.',
      'Scalp observations use actual 30/60/120-second endpoints, each within 20 seconds of its target, plus a bounded 10-second quote path through the first 120 seconds after the actual baseline. Missing endpoints and sparse coverage remain explicit; later quotes never replace missed prices.',
      'Early-break observations are research-only completed breaks without later confirmation. They are never marked live-qualified and do not change entry rules.',
      'The collector records actual 5/15/30-minute endpoints from the captured quote time. Old or prior-session unpriced cases expire without a retrospective quote baseline.',
      'Research failure is optional data loss and must never block protection, live trading gates, or a completion report.'],
    limits: RESEARCH_LIMITS, scalp_limits: SCALP_RESEARCH_LIMITS, notice: RESEARCH_NOTICE };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flag = args.indexOf('--folder');
    const folder = flag >= 0 && args[flag + 1] ? runtimeDirectory(resolve(args[flag + 1])) : root;
    if (args[0] === '--schema') process.stdout.write(JSON.stringify(researchSchema()) + '\n');
    else if (args[0] === '--due-scalp') process.stdout.write(JSON.stringify(dueResearchScalps(folder)) + '\n');
    else if (args[0] === '--due') process.stdout.write(JSON.stringify(dueResearchFollowups(folder)) + '\n');
    else if (args[0]) process.stdout.write(JSON.stringify(recordResearch(args[0], { folder })) + '\n');
    else throw new Error('Usage: research-record.mjs --schema | --due [--folder FOLDER] | INPUT_JSON [--folder FOLDER]');
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'research_skipped', reason: String(error.message).slice(0, 500),
      execution_unaffected: true }) + '\n');
    process.exitCode = 1;
  }
}
