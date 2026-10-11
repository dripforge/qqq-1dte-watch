import { etParts, marketSession, sessionForDate } from './session.mjs';

export const LOCAL_QUOTE_MAX_AGE_MS = 10000;
export const LOCAL_COVERAGE_MAX_GAP_MS = 20000;
export const OPENING_FIRST_CHECK_GRACE_MS = 30000;
export const STOP_CONFIRMATION_MAX_WAIT_MS = 30000;
const pending = new Set(['unconfirmed', 'queued', 'pending', 'pending_new', 'confirmed', 'partially_filled', 'pending_cancelled', 'pending_canceled']);
const number = value => typeof value === 'number' || typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;

export function freshOptionMarket(quote, now = Date.now()) {
  const age = now - Date.parse(quote?.updated_at ?? '');
  const bid = number(quote?.bid_price), ask = number(quote?.ask_price);
  return {valid:!!quote && Number.isFinite(age) && age >= -5000 && age <= LOCAL_QUOTE_MAX_AGE_MS &&
    Number.isFinite(bid) && bid >= 0 && Number.isFinite(ask) && ask > 0 && ask >= bid,
    bid,ask,age_ms:age};
}

export function emergencyStopPrice(premium) {
  return Math.max(0.01, Math.ceil(Number(premium) * 0.75 * 100 - 1e-9) / 100);
}

export function entryBasisVerified(arm, explicit) {
  return typeof explicit === 'boolean' ? explicit : arm?.entry_fill_verified === true ||
    Number.isFinite(Date.parse(arm?.opened_at ?? ''));
}

export function matchingStopIdentity(order, arm) {
  const leg = Array.isArray(order?.legs) && order.legs.length === 1 ? order.legs[0] : null;
  return typeof order?.id === 'string' && !!order.id && order.chain_symbol === 'QQQ' && order.direction === 'credit' &&
    number(order.trade_value_multiplier) === 100 && number(order.quantity) === 1 && !!leg &&
    leg.option_id === arm?.option_id && leg.side === 'sell' && leg.position_effect === 'close' &&
    number(leg.ratio_quantity) === 1 && leg.expiration_date === arm?.expiration_date && leg.option_type === arm?.option_type;
}

// Verify the full broker read rather than trusting a local order ID or the
// word "confirmed". Robinhood represents stop_market as market + stop.
export function inspectEmergencyStop(order, arm, { now = new Date(), entryFillVerified } = {}) {
  const problems = [];
  const basis = entryBasisVerified(arm, entryFillVerified);
  const expected = basis ? emergencyStopPrice(arm?.entry_premium) : null;
  if (!basis || !Number.isFinite(number(arm?.entry_premium)) || number(arm.entry_premium) <= 0) problems.push('entry_fill_unverified');
  if (!order || typeof order.id !== 'string' || !order.id) problems.push('stop_identity_unverified');
  if (order?.chain_symbol !== 'QQQ' || order?.direction !== 'credit' || number(order?.trade_value_multiplier) !== 100 ||
      order?.type !== 'market' || order?.trigger !== 'stop' || order?.time_in_force !== 'gfd' || order?.market_hours !== 'regular_hours') problems.push('stop_type_mismatch');
  if (number(order?.quantity) !== 1) problems.push('stop_quantity_mismatch');
  const leg = Array.isArray(order?.legs) && order.legs.length === 1 ? order.legs[0] : null;
  if (!leg || leg.option_id !== arm?.option_id || leg.side !== 'sell' || leg.position_effect !== 'close' ||
      number(leg.ratio_quantity) !== 1 || leg.expiration_date !== arm?.expiration_date || leg.option_type !== arm?.option_type) problems.push('stop_contract_mismatch');
  if (expected !== null && (!Number.isFinite(number(order?.stop_price)) || Math.abs(number(order.stop_price) - expected) > 1e-8)) problems.push('stop_price_mismatch');
  const filled = order?.state === 'filled';
  if (filled ? number(order?.processed_quantity) !== 1 : !pending.has(order?.state) ||
      number(order?.processed_quantity) !== 0 || number(order?.pending_quantity) !== 1) problems.push('stop_state_unverified');
  let createdSession = null;
  const created = Date.parse(order?.created_at ?? '');
  if (!Number.isFinite(created) || created > now.getTime() + 5000) problems.push('stop_session_unverified');
  else {
    const parts = etParts(new Date(created));
    const day = sessionForDate(parts.date);
    if (!day.verified || !day.is_trading_day || parts.minute < day.entry_start_minute || parts.minute >= day.close_minute) problems.push('stop_session_unverified');
    else createdSession = parts.date;
  }
  const session = marketSession(now);
  let expirationVerified=false;
  try {const expiry=sessionForDate(arm?.expiration_date);expirationVerified=expiry.verified&&expiry.is_trading_day;}
  catch {}
  if(!expirationVerified) problems.push('expiration_calendar_unverified');
  if(session.date>arm?.expiration_date) problems.push('expiration_window_missed');
  const valid = problems.length === 0;
  const current_session = valid && createdSession === session.date && session.is_open;
  const renewal_required = valid && !filled && !current_session;
  const broker_armed = valid && !filled && current_session && order.state === 'confirmed';
  const safe_to_replace = basis && expirationVerified && session.date<=arm.expiration_date && !filled && matchingStopIdentity(order,arm) &&
    pending.has(order.state) && number(order.processed_quantity) === 0 && number(order.pending_quantity) === 1;
  return { valid, broker_armed, renewal_required, current_session, filled,
    safe_to_replace,
    order_id: typeof order?.id === 'string' ? order.id : null,
    created_session: createdSession, expected_stop_price: expected, issues: [...new Set(problems)] };
}

export function protectionReadiness({ arm, now = new Date(), orderAssessment, quote, previous,
  entryFillVerified, status, pendingAt, extraIssues = [] } = {}) {
  const session = marketSession(now);
  const issues = [...extraIssues, ...(orderAssessment?.issues ?? [])];
  const basis = entryBasisVerified(arm, entryFillVerified);
  if (!basis) issues.push('entry_fill_unverified');
  const market=freshOptionMarket(quote,now.getTime());
  const age=market.age_ms,localFresh=market.valid;
  const brokerVerified = !!orderAssessment?.broker_armed && basis;
  const opening = session.is_open && session.minute < session.entry_start_minute;
  const previousOpening = previous?.phase === 'opening_local_watch' && previous?.session_date === session.date;
  const priorAt = previousOpening ? Date.parse(previous.checked_at ?? '') : NaN;
  const gap = Number.isFinite(priorAt) ? now.getTime() - priorAt : null;
  const maxGap = opening ? Math.max(previousOpening ? previous.max_local_gap_ms ?? 0 : 0, Number.isFinite(gap) ? Math.max(0,gap) : 0) : null;
  const quoteFailureSeen = opening && (previousOpening && previous.opening_quote_failure_seen === true || !localFresh);
  const sinceOpen = (session.minute - (session.open_minute ?? session.minute)) * 60000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  const lateOpeningStart = opening && (previousOpening ? previous.opening_started_late === true : sinceOpen > OPENING_FIRST_CHECK_GRACE_MS);
  if (!session.verified) issues.push('calendar_unverified');
  if (session.is_open && !brokerVerified && !localFresh) issues.push('local_quote_unavailable');
  if (opening && (maxGap > LOCAL_COVERAGE_MAX_GAP_MS || gap !== null && gap < -5000)) issues.push('local_coverage_gap');
  if (quoteFailureSeen) issues.push('opening_local_coverage_unverified');
  if (lateOpeningStart) issues.push('opening_coverage_started_late');
  const pending = Date.parse(pendingAt ?? '');
  if (session.is_open && !opening && !brokerVerified && status === 'stop_pending' &&
      Number.isFinite(pending) && now.getTime() - pending >= STOP_CONFIRMATION_MAX_WAIT_MS) issues.push('stop_confirmation_delayed');
  if (session.is_open && !opening && ['stop_rejected','stop_repeatedly_rejected','stop_session_expired','stop_rearm_pending','stop_repair_required','stop_order_unverified','stop_unavailable_now','stop_outcome_unknown'].includes(status)) issues.push('broker_stop_unverified');
  const phase = !session.verified ? 'calendar_unverified' : !session.is_open ? 'carry_waiting_session' :
    brokerVerified ? 'broker_stop_armed' : status === 'close_order_working' ? 'closing_order_working' : opening ? 'opening_local_watch' : 'broker_rearm_required';
  return { version: 1, phase, checked_at: now.toISOString(), session_date: session.date,
    broker_stop_verified: brokerVerified, local_coverage_verified: session.is_open && localFresh && basis,
    ready_for_session: session.is_open && (brokerVerified || opening && localFresh && basis && issues.length === 0),
    carry_mode: !session.is_open, requires_live_monitor: !brokerVerified,
    next_local_watch_et: '09:30', broker_stop_expected_et: '09:45',
    quote_at: localFresh ? quote.updated_at : null, quote_age_ms: quote ? Number.isFinite(age) ? age : null : null,
    local_gap_ms: gap, max_local_gap_ms: maxGap, opening_started_late: lateOpeningStart,
    opening_quote_failure_seen: quoteFailureSeen,
    issues: [...new Set(issues)] };
}
