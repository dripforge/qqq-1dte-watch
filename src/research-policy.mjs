import { OPTION_RESEARCH_FIELDS } from './option-research-fields.mjs';
import { createHash } from 'node:crypto';
import { researchCandleQuality, assessResearchBars } from './research-candle-quality.mjs';

export const RESEARCH_LIMITS = Object.freeze({ max_alternatives: 4, max_bars_per_interval: 24,
  max_input_bytes: 16384, quote_freshness_ms: 10000, max_record_age_ms: 120000 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const common = ['version', 'event_kind', 'observed_at', 'source', 'case_id', 'direction', 'trade_id',
  'qqq_quote', 'selected_contract', 'alternatives'];
const optionKeys = ['instrument_id', 'expiration', 'strike', 'bid', 'ask', 'bid_size', 'ask_size', 'updated_at', 'delta', 'theta'];

function exact(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${name} must use exactly its documented fields`);
  }
}
function at(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`${name} must be a valid zoned ISO timestamp`);
  return Date.parse(value);
}
function number(value, name, { nullable = false, minimum = -Infinity, maximum = Infinity, integer = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || integer && !Number.isInteger(value)) {
    throw new Error(`${name} is not a valid number`);
  }
  return value;
}
function uuid(value, name, nullable = false) {
  if (nullable && value === null) return null;
  if (!UUID.test(value ?? '')) throw new Error(`${name} must be an instrument or trade UUID`);
  return value;
}
function fresh(timestamp, observed) {
  return timestamp !== null && observed - timestamp >= -5000 && observed - timestamp <= RESEARCH_LIMITS.quote_freshness_ms;
}
function freshCash(timestamp,observed){const value=Date.parse(timestamp??'');return Number.isFinite(value)&&observed-value>=-5000&&observed-value<=120000;}
function option(value, observed) {
  if (value === null) return null;
  exact(Object.fromEntries(Object.entries(value).filter(([key])=>!OPTION_RESEARCH_FIELDS.includes(key))), optionKeys, 'Contract quote');
  const extra=Object.fromEntries(OPTION_RESEARCH_FIELDS.map(key=>[key,value[key]??null]));
  for(const key of OPTION_RESEARCH_FIELDS)number(extra[key],key,{nullable:true,minimum:0,integer:['volume','open_interest'].includes(key)});
  uuid(value.instrument_id, 'Contract instrument');
  if (typeof value.expiration !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.expiration) ||
      !Number.isFinite(Date.parse(`${value.expiration}T00:00:00Z`)) ||
      new Date(`${value.expiration}T00:00:00Z`).toISOString().slice(0, 10) !== value.expiration) throw new Error('Contract expiration is invalid');
  number(value.strike, 'Strike', { minimum: Number.MIN_VALUE });
  for (const key of ['bid', 'ask']) number(value[key], key, { nullable: true, minimum: 0 });
  for (const key of ['bid_size', 'ask_size']) number(value[key], key, { nullable: true, minimum: 0, integer: true });
  number(value.delta, 'Delta', { nullable: true, minimum: -1, maximum: 1 });
  number(value.theta, 'Theta', { nullable: true });
  const updated = at(value.updated_at, 'Option quote time', true);
  const usable = fresh(updated, observed) && value.bid !== null && value.ask !== null &&
    value.bid > 0 && value.ask >= value.bid;
  return { ...value, ...extra, quote_fresh: fresh(updated, observed), quote_usable: usable,
    spread: usable ? value.ask - value.bid : null,
    spread_fraction_midpoint: usable ? (value.ask - value.bid) / ((value.ask + value.bid) / 2) : null };
}
function bars(value, interval, observed, name) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > RESEARCH_LIMITS.max_bars_per_interval) throw new Error(`${name} must contain at most 24 broker bars or null`);
  let previous;
  return value.map(bar => {
    const allowed = ['begins_at', 'open_price', 'high_price', 'low_price', 'close_price', 'volume', 'interpolated', 'session'];
    if (!bar || typeof bar !== 'object' || Array.isArray(bar) || Object.keys(bar).some(key => !allowed.includes(key))) throw new Error(`${name} contains unknown bar fields`);
    const began = at(bar.begins_at, 'Bar start');
    if (began % interval !== 0 || began + interval > observed - 1000 || previous !== undefined && began - previous !== interval) {
      throw new Error(`${name} must contain contiguous, ordered, completed broker bars`);
    }
    previous = began;
    const values = {};
    for (const key of ['open_price', 'high_price', 'low_price', 'close_price']) {
      if (bar[key] === null || bar[key] === undefined || bar[key] === '' || !Number.isFinite(Number(bar[key])) || Number(bar[key]) <= 0) {
        throw new Error('Broker bar prices are invalid');
      }
      values[key] = Number(bar[key]);
    }
    if (values.high_price < Math.max(values.open_price, values.close_price) ||
        values.low_price > Math.min(values.open_price, values.close_price)) throw new Error('Broker bar range is invalid');
    if (bar.volume !== undefined) number(bar.volume, 'Bar volume', { minimum: 0, nullable: true });
    if (bar.interpolated !== undefined && bar.interpolated !== null && typeof bar.interpolated !== 'boolean') throw new Error('Bar interpolation flag is invalid');
    if (bar.session !== undefined && bar.session !== null && !['reg', ''].includes(bar.session)) throw new Error('Research requires regular-session bars');
    const result = { begins_at: bar.begins_at, ...values, interpolated: bar.interpolated ?? null,
      session: bar.session ?? null, volume: bar.volume ?? null };
    return { ...result, research_quality: researchCandleQuality(result, { intervalMs: interval, observedAt: observed }) };
  });
}
function usableBars(value, interval, observed, minimum) {
  return assessResearchBars(value, { intervalMs: interval, observedAt: observed, minimum }).usable;
}

export function compareBearishSetups(setup, minute, five, qqq, observed) {
  const result = { break_hold: null, failed_reclaim: null, reason: 'incomplete_evidence' };
  if (!usableBars(minute, 60000, observed, 2) || !usableBars(five, 300000, observed, 3) ||
      !qqq.quote_usable || setup.reference_level === null) return result;
  const breakIndex = five.findIndex(b => b.begins_at === setup.break_bar_at);
  const confirmIndex = five.findIndex(b => b.begins_at === setup.confirm_bar_at);
  if (breakIndex < 1 || confirmIndex <= breakIndex) return result;
  const level = setup.reference_level;
  const one = minute.at(-1), prior = minute.at(-2);
  const follows = one.begins_at === setup.confirmation_1m_at && one.close_price < one.open_price &&
    one.close_price < prior.close_price && one.close_price < level && prior.close_price < level &&
    Date.parse(one.begins_at) + 60000 >= Date.parse(five[confirmIndex].begins_at) + 300000;
  const held = five[breakIndex - 1].close_price >= level && five[breakIndex].close_price < level &&
    five.slice(breakIndex + 1).every(b => b.close_price < level) && qqq.price < level && follows;
  return { break_hold: held, failed_reclaim: held && five[confirmIndex].high_price >= level,
    reason: !held ? 'completed_confirmation_not_met' : five[confirmIndex].high_price >= level ? 'both_variants_confirmed' : 'hold_confirmed_without_retouch' };
}

function swing(value, direction, opened, buffer) {
  let found = null;
  for (let i = 1; i < value.length - 1; i++) {
    const left = value[i - 1], middle = value[i], right = value[i + 1];
    if (Date.parse(middle.begins_at) < opened) continue;
    const key = direction === 'call' ? 'low_price' : 'high_price';
    const m = middle[key], l = left[key], r = right[key];
    if (direction === 'call' ? m <= l && m <= r && (m < l || m < r) : m >= l && m >= r && (m > l || m > r)) {
      const raw = direction === 'call' ? m - buffer : m + buffer;
      found = { level: direction === 'call' ? Math.floor(raw * 100 + 1e-8) / 100 : Math.ceil(raw * 100 - 1e-8) / 100,
        swing_price: m, swing_at: middle.begins_at, confirmation_bar_at: right.begins_at };
    }
  }
  return found;
}
export function compareProfitTrails(direction, minute, five, openedAt, observed) {
  const result = { one_minute: null, five_minute: null, buffer: null,
    method: 'confirmed_swing_with_shared_live_1m_volatility_buffer' };
  if (!usableBars(minute, 60000, observed, 10)) return result;
  const ranges = minute.slice(-10).map(b => b.high_price - b.low_price).sort((a, b) => a - b);
  const buffer = Math.min(0.25, Math.max(0.08, (ranges[4] + ranges[5]) / 4));
  const opened = at(openedAt, 'Verified position entry time');
  result.buffer = buffer;
  result.one_minute = swing(minute.slice(-10), direction, opened, buffer);
  if (usableBars(five, 300000, observed, 3)) result.five_minute = swing(five, direction, opened, buffer);
  return result;
}

export function validateResearchEvent(input, now = Date.now()) {
  const kinds = ['setup', 'trail', 'followup', 'quote_baseline', 'scalp_observation', 'early_break'];
  if (!kinds.includes(input?.event_kind)) throw new Error('Research event kind is invalid');
  const extra = input.event_kind === 'setup' ? ['setup', 'one_minute_bars', 'five_minute_bars'] :
    input.event_kind === 'trail' ? ['opened_at', 'one_minute_bars', 'five_minute_bars'] :
    input.event_kind === 'quote_baseline' ? ['basis_ids','selection_context'] :
    input.event_kind === 'early_break' ? ['early_setup','one_minute_bars','five_minute_bars'] :
    input.event_kind === 'scalp_observation' ? ['basis_id','horizon_seconds'] : ['basis_id', 'horizon_minutes'];
  exact(input, [...common, ...extra], 'Research event');
  if (input.version !== 1 || input.source !== 'robinhood_trading_mcp' || !['call', 'put'].includes(input.direction)) throw new Error('Research version, source or direction is invalid');
  const observed = at(input.observed_at, 'Research observation time');
  if (!Number.isFinite(now) || now - observed > RESEARCH_LIMITS.max_record_age_ms || observed - now > 5000) throw new Error('Research observation is stale or in the future');
  uuid(input.trade_id, 'Trade identity', true);
  if (input.case_id !== null && !HASH.test(input.case_id ?? '') || ['followup','quote_baseline','scalp_observation'].includes(input.event_kind) && input.case_id === null) throw new Error('Research case identity is invalid');
  exact(input.qqq_quote, ['price', 'last_trade_at'], 'QQQ quote');
  number(input.qqq_quote.price, 'QQQ price', { nullable: true, minimum: Number.MIN_VALUE });
  const stockAt = at(input.qqq_quote.last_trade_at, 'QQQ quote time', true);
  const qqq = { ...input.qqq_quote, quote_fresh: fresh(stockAt, observed),
    quote_usable: input.qqq_quote.price !== null && fresh(stockAt, observed) };
  const selected = option(input.selected_contract, observed);
  if (!Array.isArray(input.alternatives) || input.alternatives.length > RESEARCH_LIMITS.max_alternatives) throw new Error('Research may compare at most four nearby alternatives');
  const alternatives = input.alternatives.map(value => option(value, observed));
  if (alternatives.some(value => value === null)) throw new Error('A missing alternative must be omitted from the list');
  const instruments = [selected, ...alternatives].filter(Boolean).map(value => value.instrument_id);
  if (new Set(instruments).size !== instruments.length) throw new Error('Research contract alternatives must be distinct');
  const result = { ...input, qqq_quote: qqq, selected_contract: selected, alternatives,
    missing_data: [], measurements: null, shadow_comparison: null, trail_comparison: null,
    candle_quality: null, comparison_quality: null };
  if (!qqq.quote_usable) result.missing_data.push('fresh_qqq_quote');
  if (!selected?.quote_usable) result.missing_data.push('fresh_selected_option_quote');
  if (selected?.delta === null || !selected) result.missing_data.push('selected_delta');
  if (selected?.theta === null || !selected) result.missing_data.push('selected_theta');
  if (extra.includes('one_minute_bars')) {
    result.one_minute_bars = bars(input.one_minute_bars, 60000, observed, 'One-minute bars');
    result.five_minute_bars = bars(input.five_minute_bars, 300000, observed, 'Five-minute bars');
    result.candle_quality = {
      one_minute: assessResearchBars(result.one_minute_bars, { intervalMs: 60000, observedAt: observed, minimum: input.event_kind === 'trail' ? 10 : 2 }),
      five_minute: assessResearchBars(result.five_minute_bars, { intervalMs: 300000, observedAt: observed, minimum: 3 }) };
    if (!result.candle_quality.one_minute.usable) result.missing_data.push('usable_completed_1m_bars');
    if (!result.candle_quality.five_minute.usable) result.missing_data.push('usable_completed_5m_bars');
    result.comparison_quality = {
      method: 'completed_broker_bars_at_actual_observation', research_only: true,
      one_minute_basis: result.candle_quality.one_minute.verification_basis,
      five_minute_basis: result.candle_quality.five_minute.verification_basis,
      one_minute_usable: result.candle_quality.one_minute.usable,
      five_minute_usable: result.candle_quality.five_minute.usable,
      fresh_qqq_quote: qqq.quote_usable,
      live_gate_validation_unchanged: true };
  }
  if (input.event_kind === 'setup') {
    exact(input.setup, ['reference_level', 'qqq_invalidation', 'next_obstacle', 'break_bar_at', 'confirm_bar_at', 'confirmation_1m_at', 'live_qualified'], 'Setup evidence');
    for (const key of ['reference_level', 'qqq_invalidation', 'next_obstacle']) number(input.setup[key], key, { nullable: true, minimum: Number.MIN_VALUE });
    for (const key of ['break_bar_at', 'confirm_bar_at', 'confirmation_1m_at']) at(input.setup[key], key);
    if (input.setup.live_qualified !== null && typeof input.setup.live_qualified !== 'boolean') throw new Error('Live setup qualification must be known boolean or null');
    const sign = input.direction === 'call' ? 1 : -1;
    const distance = qqq.quote_usable && input.setup.qqq_invalidation !== null ? sign * (qqq.price - input.setup.qqq_invalidation) : null;
    const room = qqq.quote_usable && input.setup.next_obstacle !== null ? sign * (input.setup.next_obstacle - qqq.price) : null;
    result.measurements = { room_to_obstacle: room, distance_to_invalidation: distance,
      underlying_room_risk_ratio: room !== null && room >= 0 && distance !== null && distance > 0 ? room / distance : null,
      option_spread_cost: selected?.spread !== null && selected ? selected.spread * 100 : null,
      planned_25pct_premium_stop_plus_1: selected?.quote_usable ? selected.ask * 100 * 0.25 + 1 : null };
    if (input.direction === 'put') result.shadow_comparison = compareBearishSetups(input.setup, result.one_minute_bars, result.five_minute_bars, qqq, observed);
  } else if (input.event_kind === 'trail') {
    at(input.opened_at, 'Verified position entry time');
    if (Date.parse(input.opened_at) > observed) throw new Error('Position entry time is after the research observation');
    result.trail_comparison = compareProfitTrails(input.direction, result.one_minute_bars, result.five_minute_bars, input.opened_at, observed);
  } else if(input.event_kind==='quote_baseline') {
    if(!qqq.quote_usable||!selected?.quote_usable)throw new Error('A new baseline requires actual fresh underlying and selected option quotes');
    if(!Array.isArray(input.basis_ids)||!input.basis_ids.length||input.basis_ids.length>3||new Set(input.basis_ids).size!==input.basis_ids.length||input.basis_ids.some(id=>!['case','bearish_break_hold','bearish_failed_reclaim'].includes(id)))throw new Error('Baseline basis identities are invalid');
    const context=input.selection_context;
    exact(context,['premium_ceiling_dollars','cash_snapshot_at','affordability','entry_gate','post_stop_context'],'Selection context');
    number(context.premium_ceiling_dollars,'Research premium ceiling',{minimum:0,maximum:500});
    at(context.cash_snapshot_at,'Cash snapshot time',true);
    if(!['verified_snapshot','unknown'].includes(context.affordability)||context.affordability==='verified_snapshot'&&context.cash_snapshot_at===null)throw new Error('Research affordability context is invalid');
    if(context.affordability==='verified_snapshot'&&!freshCash(context.cash_snapshot_at,observed))throw new Error('Verified research cash snapshot is stale');
    if(selected.ask*100>context.premium_ceiling_dollars+1e-8||selected.bid_size===null||selected.bid_size<1||selected.ask_size===null||selected.ask_size<1||selected.spread>Math.min(0.10,(selected.ask+selected.bid)/2*0.05)+1e-8)throw new Error('Baseline contract exceeds its research premium or liquidity limits');
    exact(context.entry_gate,['status','reason','checked_at'],'Entry gate context');
    if(!['qualified','blocked','unknown'].includes(context.entry_gate.status)||typeof context.entry_gate.reason!=='string'||!context.entry_gate.reason.trim()||context.entry_gate.reason.length>500)throw new Error('Research entry gate context is invalid');
    at(context.entry_gate.checked_at,'Entry gate check time',true);
    if(context.entry_gate.status!=='unknown'&&context.entry_gate.checked_at===null)throw new Error('A known entry gate result needs an actual check timestamp');
    if(context.entry_gate.status!=='unknown'&&!freshCash(context.entry_gate.checked_at,observed))throw new Error('Research entry gate result is stale');
    if(context.post_stop_context!==null){
      const post=context.post_stop_context;
      exact(post,['prior_trade_id','closed_at','prior_invalidation','prior_direction','setup_break_bar_at','setup_break_completed_at','new_completed_setup'],'Post-stop context');
      uuid(post.prior_trade_id,'Prior trade');at(post.closed_at,'Prior verified closure');
      number(post.prior_invalidation,'Prior invalidation',{minimum:Number.MIN_VALUE});
      if(!['call','put'].includes(post.prior_direction)||typeof post.new_completed_setup!=='boolean')throw new Error('Post-stop setup context is invalid');
      at(post.setup_break_bar_at,'New setup break time',true);
      at(post.setup_break_completed_at,'New setup completion time',true);
      if(post.new_completed_setup&&(!post.setup_break_bar_at||Date.parse(post.setup_break_completed_at)!==Date.parse(post.setup_break_bar_at)+300000||Date.parse(post.setup_break_completed_at)<=Date.parse(post.closed_at)||Date.parse(post.setup_break_completed_at)>observed-1000))throw new Error('Reentry research requires a newer completed setup after closure');
    }
  } else if(input.event_kind==='early_break') {
    exact(input.early_setup,['reference_level','break_bar_at','break_completed_at','latest_completed_1m_at','reference_kind','reference_established_at','live_qualified'],'Early break evidence');
    const early=input.early_setup;
    number(early.reference_level,'Early break reference',{minimum:Number.MIN_VALUE});
    for(const key of ['break_bar_at','break_completed_at','latest_completed_1m_at','reference_established_at'])at(early[key],key);
    if(early.live_qualified!==false)throw new Error('Early break research is never a live-qualified entry');
    if(!['explicit_plan','prior_5m_close','prior_5m_high','prior_5m_low'].includes(early.reference_kind))throw new Error('Early break reference kind is invalid');
    const began=Date.parse(early.break_bar_at);
    if(Date.parse(early.break_completed_at)!==began+300000||Date.parse(early.break_completed_at)>observed-1000||Date.parse(early.reference_established_at)>began)throw new Error('Early break requires a causal completed five-minute break');
    const five=result.five_minute_bars,minute=result.one_minute_bars;
    if(!usableBars(five,300000,observed,2)||!usableBars(minute,60000,observed,2))throw new Error('Early break requires usable actual completed candles');
    const index=five.findIndex(bar=>bar.begins_at===early.break_bar_at);
    if(index<1||index!==five.length-1||minute.at(-1).begins_at!==early.latest_completed_1m_at||Date.parse(minute.at(-1).begins_at)+60000<Date.parse(early.break_completed_at))throw new Error('Early break requires the latest completed five-minute break and one-minute timestamp');
    const prior=five[index-1],broken=five[index],sign=input.direction==='call'?1:-1;
    const key={prior_5m_close:'close_price',prior_5m_high:'high_price',prior_5m_low:'low_price'}[early.reference_kind];
    if(early.reference_kind!=='explicit_plan'&&(early.reference_level!==prior[key]||Date.parse(early.reference_established_at)!==Date.parse(prior.begins_at)+300000)||sign*(prior.close_price-early.reference_level)>0||sign*(broken.close_price-early.reference_level)<=0||!qqq.quote_usable||sign*(qqq.price-early.reference_level)<=0)throw new Error('Early break is not a causal crossing of the supplied prior-bar reference');
  } else {
    if (!['case', 'bearish_break_hold', 'bearish_failed_reclaim'].includes(input.basis_id)) throw new Error('Followup quote basis is invalid');
    if(input.event_kind==='scalp_observation'){
      if(input.horizon_seconds!==null&&![30,60,120].includes(input.horizon_seconds))throw new Error('Scalp horizon must be 30, 60, 120 or null');
      if(!qqq.quote_usable||!selected?.quote_usable)throw new Error('Scalp observation requires actual fresh underlying and option quotes');
    }else if (input.horizon_minutes !== null && ![5, 15, 30].includes(input.horizon_minutes)) throw new Error('Followup horizon must be 5, 15, 30 or null');
  }
  const basis = input.event_kind === 'setup' ? ['setup', input.direction, input.setup.break_bar_at,
    input.setup.reference_level, selected?.instrument_id ?? 'underlying_only'] : input.event_kind==='early_break'?
    ['early_break',input.direction,input.early_setup.break_bar_at,input.early_setup.reference_level,selected?.instrument_id??'underlying_only']:
    ['trail', input.direction, input.trade_id, input.opened_at, selected?.instrument_id ?? 'underlying_only'];
  result.case_id = input.case_id ?? createHash('sha256').update(JSON.stringify(basis)).digest('hex');
  const eventBasis = input.event_kind === 'setup' ? [result.case_id, 'setup', input.setup.confirm_bar_at,
    result.shadow_comparison, input.setup.live_qualified, selected?.updated_at,
    alternatives.map(quote => [quote.instrument_id, quote.updated_at])] : input.event_kind==='early_break'?
    [result.case_id,'early_break',input.early_setup,selected?.updated_at] : input.event_kind === 'trail' ?
    [result.case_id, 'trail', result.trail_comparison, qqq.last_trade_at, selected?.updated_at] : input.event_kind==='quote_baseline'?
    [result.case_id,'quote_baseline',input.basis_ids,selected?.instrument_id,selected?.updated_at,input.selection_context]:[result.case_id, input.event_kind, input.basis_id,
      input.event_kind==='scalp_observation'?input.horizon_seconds:input.horizon_minutes, qqq.last_trade_at, selected?.instrument_id, selected?.updated_at];
  result.event_id = createHash('sha256').update(JSON.stringify(eventBasis)).digest('hex');
  return result;
}

export function quoteReferenceMovement(reference, current) {
  if (!reference?.quote_usable || !current?.quote_usable || reference.instrument_id !== current.instrument_id ||
      Date.parse(current.updated_at) < Date.parse(reference.updated_at)) return null;
  return { reference_ask: reference.ask, observed_bid: current.bid,
    bid_minus_reference_ask_per_contract: (current.bid - reference.ask) * 100,
    reference_quote_at: reference.updated_at, observed_quote_at: current.updated_at,
    actual_quote_elapsed_minutes: (Date.parse(current.updated_at) - Date.parse(reference.updated_at)) / 60000,
    basis: 'actual_quotes_only_no_assumed_entry_or_exit_fill' };
}
