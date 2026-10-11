import { createHash } from 'node:crypto';

export const PROFIT_PROTECTION_DEFAULTS = Object.freeze({
  scalp: Object.freeze({ entry_fraction: .05, activation_spreads: 3, minimum_activation: .05, retained_gain: .60 }),
  trend: Object.freeze({ entry_fraction: .15, activation_spreads: 4, minimum_activation: .10, retained_gain: .35 }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const EPS = 1e-8;
const ceilCent = value => Math.ceil(value * 100 - EPS) / 100;
const floorCent = value => Math.floor(value * 100 + EPS) / 100;
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`${label} fields invalid`);
}
function numeric(value, label) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' &&
      !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`${label} unavailable`);
  const result = Number(value);
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${label} invalid`);
  return result;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || !ISO.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(`${value.slice(0, 19)}Z`).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error(`${label} invalid`);
  return Date.parse(value);
}
function identity(arm) {
  if (!UUID.test(arm?.trade_id ?? '') || !UUID.test(arm?.option_id ?? '') || arm.quantity !== 1) throw new Error('Exact trade identity unavailable');
}
export function validateProfitProtectionEvidence(evidence) {
  exact(evidence, ['version', 'mode', 'rationale'], 'Profit protection evidence');
  if (evidence.version !== 1 || !Object.hasOwn(PROFIT_PROTECTION_DEFAULTS, evidence.mode) ||
      typeof evidence.rationale !== 'string' || evidence.rationale.trim().length < 12 || evidence.rationale.length > 2000) throw new Error('Agent-selected profit protection evidence required');
  return evidence;
}
export function createProfitProtectionPlan({ arm, evidence, now = Date.now() }) {
  identity(arm);
  validateProfitProtectionEvidence(evidence);
  if (!Number.isFinite(now)) throw new Error('Profit protection selection time invalid');
  return { ...evidence, option_id: arm.option_id, trade_id: arm.trade_id, selected_at: new Date(now).toISOString() };
}
export function validateProfitProtectionPlan(plan, { arm, now = Date.now() }) {
  identity(arm);
  exact(plan, ['version', 'mode', 'rationale', 'option_id', 'trade_id', 'selected_at'], 'Profit protection plan');
  validateProfitProtectionEvidence({ version: plan.version, mode: plan.mode, rationale: plan.rationale });
  if (plan.option_id !== arm.option_id || plan.trade_id !== arm.trade_id) throw new Error('Profit protection plan belongs to another position lifetime');
  if (timestamp(plan.selected_at, 'Plan selection time') > now + 5000) throw new Error('Profit protection plan is from the future');
  return plan;
}
function checkedState(state, arm, basis, entry) {
  if (!state) return null;
  const fields = ['version', 'option_id', 'trade_id', 'basis_key', 'mode', 'activated', 'exit_requested', 'triggered_at',
    'peak_bid', 'peak_at', 'floor_bid', 'floor_set_at', 'last_quote_at', 'last_bid', 'last_ask', 'last_observed_at',
    'activation_gain', 'drawdown_buffer_at_last_tightening', 'spread_at_last_tightening', 'retained_fraction_at_last_tightening'];
  exact(state, fields, 'Profit protection state');
  if (state.version !== 1 || state.option_id !== arm.option_id || state.trade_id !== arm.trade_id ||
      state.basis_key !== basis || !Object.hasOwn(PROFIT_PROTECTION_DEFAULTS, state.mode) ||
      typeof state.activated !== 'boolean' || typeof state.exit_requested !== 'boolean') throw new Error('Profit protection state identity or verified basis changed');
  for (const key of ['peak_bid', 'last_bid', 'last_ask', 'activation_gain']) numeric(state[key], `State ${key}`);
  for (const key of ['peak_at', 'last_quote_at', 'last_observed_at']) timestamp(state[key], `State ${key}`);
  if (state.floor_bid !== null) {
    numeric(state.floor_bid, 'Armed floor'); timestamp(state.floor_set_at, 'Floor time');
    if (!state.activated || state.floor_bid < entry + .02 - EPS || state.floor_bid > state.peak_bid - .03 + EPS ||
        !Number.isFinite(state.drawdown_buffer_at_last_tightening) || state.drawdown_buffer_at_last_tightening < .03 ||
        !Number.isFinite(state.spread_at_last_tightening) || state.spread_at_last_tightening < 0 ||
        state.drawdown_buffer_at_last_tightening + EPS < state.spread_at_last_tightening * 2 ||
        ![.60, .35].includes(state.retained_fraction_at_last_tightening)) throw new Error('Armed profit floor is malformed');
  } else if (state.activated || state.exit_requested || state.floor_set_at !== null) throw new Error('Activated protection lacks its floor');
  if (state.exit_requested) {
    const triggered = timestamp(state.triggered_at, 'Profit trigger time');
    if (triggered < timestamp(arm.opened_at, 'Actual entry time') || triggered > Date.parse(state.last_quote_at) ||
        triggered > Date.parse(state.last_observed_at) + 5000) throw new Error('Latched profit trigger time is inconsistent');
  } else if (state.triggered_at !== null) throw new Error('Untriggered profit state has a trigger time');
  if (state.last_ask < state.last_bid || state.peak_bid < state.last_bid) throw new Error('Profit protection sample history is malformed');
  return state;
}
function activationGain(entry, spread, profile, drawBuffer, cushion) {
  let gain = ceilCent(Math.max(entry * profile.entry_fraction, spread * profile.activation_spreads,
    profile.minimum_activation, cushion / profile.retained_gain, drawBuffer / (1 - profile.retained_gain)));
  // Find the smallest cent increment that also survives floor-price rounding.
  for (let i = 0; i < 5; i++, gain = ceilCent(gain + .01)) {
    const floor = ceilCent(entry + profile.retained_gain * gain);
    if (floor >= ceilCent(entry + cushion) && floor <= floorCent(entry + gain - drawBuffer)) return gain;
  }
  throw new Error('Buffered profit activation unavailable');
}

export function evaluateProfitProtection({ arm, position, plan, state = null, quote, session, now = Date.now() }) {
  let latched = null;
  function unavailable(reason) {
    if (latched) return { status: 'exit_requested', reason: 'profit_protection', state: latched, exit_requested: true,
      observed_at: latched.triggered_at, trigger_age_ms: now - Date.parse(latched.triggered_at),
      quote_age_ms: null, quote_unavailable_reason: reason };
    return { status: 'unavailable', reason, state, exit_requested: false };
  }
  try {
    if (!Number.isFinite(now)) return unavailable('profit_observation_time_invalid');
    if (!plan) return unavailable('profit_protection_plan_unavailable');
    validateProfitProtectionPlan(plan, { arm, now });
    if (session?.verified !== true || session.is_open !== true || typeof session.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(session.date) || session.date > arm.expiration_date) return unavailable('outside_verified_regular_session');
    if (!position || position.option_id !== arm.option_id || position.chain_symbol !== 'QQQ' || position.type !== 'long' ||
        numeric(position.quantity, 'Position quantity') !== 1 || position.expiration_date !== arm.expiration_date) return unavailable('position_not_verified');
    if (arm.entry_basis_verified !== true) return unavailable('actual_entry_basis_unverified');
    const entry = numeric(arm.entry_premium, 'Actual entry premium');
    if (entry > 5) return unavailable('actual_entry_premium_exceeds_authorized_cap');
    const opened = timestamp(arm.opened_at, 'Actual entry time');
    if (opened > now) return unavailable('actual_entry_time_in_future');
    const basis = createHash('sha256').update(JSON.stringify([arm.trade_id, arm.option_id, opened, entry, 1])).digest('hex');
    const previous = checkedState(state, arm, basis, entry);
    // Only a validated latch belonging to this verified live position may
    // survive a missing later quote. Ownership/session failures cannot do so.
    if (previous?.exit_requested) latched = previous;
    if (quote?.instrument_id !== arm.option_id) return unavailable('option_quote_identity_mismatch');
    const quotedAt = timestamp(quote.updated_at, 'Option quote time');
    if (!Number.isFinite(now) || now - quotedAt > 10000 || quotedAt > now + 5000 || quotedAt < opened) return unavailable('option_quote_stale_or_precedes_entry');
    const bid = numeric(quote.bid_price, 'Option bid'), ask = numeric(quote.ask_price, 'Option ask');
    for (const key of ['bid_size', 'ask_size']) if (!Number.isSafeInteger(numeric(quote[key], key))) return unavailable('option_quote_sizes_invalid');
    const spread = ask - bid;
    if (spread < 0 || spread > Math.min(.10, (ask + bid) / 2 * .05) + EPS) return unavailable('option_quote_spread_invalid');
    if (previous && (quotedAt < Date.parse(previous.last_quote_at) || quotedAt === Date.parse(previous.last_quote_at) &&
        (bid !== previous.last_bid || ask !== previous.last_ask))) return unavailable('option_quote_out_of_order_or_conflicting');
    const profile = PROFIT_PROTECTION_DEFAULTS[plan.mode], drawBuffer = Math.max(.03, spread * 2), cushion = Math.max(.02, spread);
    // Cent rounding plus retained gain must leave both a profitable floor and
    // the minimum giveback buffer. Wide spreads can delay scalp activation.
    const activation = activationGain(entry, spread, profile, drawBuffer, cushion);
    const peak = Math.max(previous?.peak_bid ?? bid, bid), gain = Math.max(0, peak - entry);
    const next = previous ? { ...previous } : { version: 1, option_id: arm.option_id, trade_id: arm.trade_id,
      basis_key: basis, activated: false, exit_requested: false, triggered_at: null, floor_bid: null, floor_set_at: null,
      drawdown_buffer_at_last_tightening: null, spread_at_last_tightening: null, retained_fraction_at_last_tightening: null };
    Object.assign(next, { mode: plan.mode, peak_bid: peak, peak_at: peak > (previous?.peak_bid ?? -Infinity) ? quote.updated_at : previous.peak_at,
      last_quote_at: quote.updated_at, last_bid: bid, last_ask: ask, last_observed_at: new Date(now).toISOString(), activation_gain: activation });
    const candidate = ceilCent(entry + profile.retained_gain * gain), profitableFloor = ceilCent(entry + cushion), bufferedMaximum = floorCent(peak - drawBuffer);
    if ((next.activated || gain + EPS >= activation) && candidate >= profitableFloor && candidate <= bufferedMaximum &&
        (next.floor_bid === null || candidate > next.floor_bid)) Object.assign(next, { activated: true,
      floor_bid: candidate, floor_set_at: new Date(now).toISOString(), drawdown_buffer_at_last_tightening: drawBuffer,
      spread_at_last_tightening: spread, retained_fraction_at_last_tightening: profile.retained_gain });
    if (next.activated && bid <= next.floor_bid + EPS && !next.exit_requested) {
      next.exit_requested = true;
      next.triggered_at = quote.updated_at;
    }
    return { status: next.exit_requested ? 'exit_requested' : next.activated ? 'armed' : 'watching',
      reason: next.exit_requested ? 'profit_protection' : next.activated ? 'sampled_profit_floor_armed' : 'activation_not_reached',
      state: next, exit_requested: next.exit_requested, quoted_gain: bid - entry,
      observed_at: next.exit_requested ? next.triggered_at : quote.updated_at, quote_age_ms: now - quotedAt,
      trigger_age_ms: next.exit_requested ? now - Date.parse(next.triggered_at) : null,
      current_drawdown_buffer_satisfied: next.floor_bid === null ? null : peak - next.floor_bid + EPS >= drawBuffer };
  } catch (error) { return unavailable(String(error.message).slice(0, 200)); }
}
