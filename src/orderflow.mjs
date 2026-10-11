import { randomUUID } from 'node:crypto';
import { marketSession, expirationStatus } from './session.mjs';
import { stateOf, isFilledOrder, isWorkingOrder, isAcceptedOrder,
  isVerifiedZeroFillTerminal, ZERO_FILL_TERMINAL_STATES } from './order-state.mjs';

export { stateOf, isFilledOrder, isWorkingOrder, isAcceptedOrder,
  isVerifiedZeroFillTerminal } from './order-state.mjs';

export const SUBMISSION_TARGET_MS = 120000;
export const CANCELLATION_RESERVE_MS = 30000;
export const MAX_CANCELLATION_WAIT_MS = 90000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rethrowOwnership = error => {if(error?.ownership_status)throw error;};
const errorMessage = error => String(error?.message ?? error).slice(0, 200);

export function pendingClose(order, optionId) {
  return isWorkingOrder(order) && order.legs?.some(leg =>
    leg.option_id === optionId && leg.side === 'sell' && leg.position_effect === 'close');
}

export async function submitExit({ arm, decision, broker, intentStore,
  clock = () => Date.now(), sleep = pause }) {
  const started = clock();
  let intent = intentStore.load();
  if (intent && intent.option_id !== arm.option_id) throw new Error('Unresolved exit intent for another option');
  if (intent?.trade_id && arm.trade_id && intent.trade_id !== arm.trade_id) {
    throw new Error('Unresolved exit intent belongs to another trade');
  }
  if (!intent) {
    if (!Number.isFinite(Date.parse(decision.observed_at ?? ''))) throw new Error('Exit observation time is invalid');
    intent = { option_id: arm.option_id, ...(arm.trade_id ? { trade_id: arm.trade_id } : {}), ref_id: randomUUID(), reason: decision.reason,
      breach_at: decision.observed_at, created_at: new Date(started).toISOString(), attempts: [] };
    intentStore.save(intent);
  }
  const breach = Date.parse(intent.breach_at ?? '');
  if (!Number.isFinite(breach)) throw new Error('Saved exit observation time is invalid');
  const deadline = breach + SUBMISSION_TARGET_MS;
  const save = change => { intent = { ...intent, ...change }; intentStore.save(intent); };
  const result = (status, extra = {}) => {
    const accepted = Date.parse(intent.first_accepted_submission_at ?? '');
    const elapsed = (Number.isFinite(accepted) ? accepted : clock()) - breach;
    return { status, reason: intent.reason, breach_at: intent.breach_at,
      deadline_at: new Date(deadline).toISOString(), elapsed_ms: elapsed,
      deadline_met: Number.isFinite(accepted) ? elapsed <= SUBMISSION_TARGET_MS : clock() > deadline ? false : null,
      deadline_exceeded: Number.isFinite(accepted) ? accepted > deadline : clock() > deadline,
      remaining_ms: Math.max(0, deadline - clock()),
      first_accepted_submission_at: Number.isFinite(accepted) ? new Date(accepted).toISOString() : null,
      ...extra };
  };
  const recordAcceptance = (order, acknowledgedAt) => {
    const created = Date.parse(order.created_at ?? '');
    const acknowledged = Date.parse(acknowledgedAt);
    // Broker creation time is evidence of receipt. An outbound SDK call can still
    // spend time authorizing or waiting for network access, so it earns no timing credit.
    const acceptedAt = Number.isFinite(created) && created >= breach - 5000 && created <= acknowledged + 5000
      ? new Date(created).toISOString() : acknowledgedAt;
    const first = intent.first_accepted_submission_at ?? acceptedAt;
    save({ order_id: order.id, submitted_at: first, first_accepted_submission_at: first,
      last_order_state: stateOf(order) });
  };

  // Reconcile a saved response before retrying. A missing order is an unknown outcome.
  if (intent.order_id) {
    let prior;
    try { prior = await broker.order(intent.order_id); }
    catch (error) { rethrowOwnership(error); return result('exit_outcome_unknown', { order_id: intent.order_id, message: errorMessage(error) }); }
    if (!prior) return result('exit_outcome_unknown', { order_id: intent.order_id });
    if (isFilledOrder(prior)) {
      if (!intent.first_accepted_submission_at) {
        recordAcceptance({ ...prior, id: prior.id ?? intent.order_id }, new Date(clock()).toISOString());
      }
      return result('closed_by_exit', { closure_verified: true,
        order_id: prior.id ?? intent.order_id, order_state: stateOf(prior) });
    }
    if (isWorkingOrder(prior)) {
      if (!intent.first_accepted_submission_at && isAcceptedOrder(prior)) {
        recordAcceptance(prior, new Date(clock()).toISOString());
      }
      const currentSession = marketSession(new Date(clock()));
      const urgentLimit = prior.trigger === 'immediate' &&
        (prior.type ?? intent.submission_parameters?.type) === 'limit' &&
        currentSession.is_open && currentSession.minute >= currentSession.entry_start_minute &&
        (!arm.expiration_date || currentSession.date <= arm.expiration_date);
      if (!urgentLimit) return result('exit_order_working', {
        order_id: prior.id ?? intent.order_id, order_state: stateOf(prior) });
      // An early bid limit can remain unfilled after the market moves away. Once
      // market closes are available, replace it only after final zero-fill proof.
      const id = prior.id ?? intent.order_id;
      if (!['pending_cancelled', 'pending_canceled'].includes(stateOf(prior))) {
        try { await broker.cancel(id); }
        catch (error) { rethrowOwnership(error); return result('exit_outcome_unknown', { order_id: id, message: errorMessage(error) }); }
      }
      let current;
      try { current = await broker.order(id); }
      catch (error) { rethrowOwnership(error); return result('exit_outcome_unknown', { order_id: id, message: errorMessage(error) }); }
      if (!current) return result('exit_outcome_unknown', { order_id: id });
      if (isFilledOrder(current)) return result('closed_by_exit', { closure_verified: true,
        order_id: id, order_state: stateOf(current) });
      if (!isVerifiedZeroFillTerminal(current)) return result(isWorkingOrder(current) ? 'exit_cancel_pending' : 'exit_outcome_unknown', {
        order_id: id, order_state: stateOf(current) });
      prior = current;
    }
    if (!isVerifiedZeroFillTerminal(prior)) return result('exit_outcome_unknown', {
      order_id: prior.id ?? intent.order_id, order_state: stateOf(prior) });
    // Only a verified terminal, zero-fill order permits a new idempotency reference.
    save({ prior_orders: [...(intent.prior_orders ?? []), { order_id: intent.order_id,
      ref_id: intent.ref_id, state: stateOf(prior), reconciled_at: new Date(clock()).toISOString() }],
      order_id: null, ref_id: randomUUID(), submission_parameters: null, last_order_state: stateOf(prior),
      ...(!intent.first_accepted_submission_at ? { submitted_at: null } : {}) });
  }

  const marketClosed = session => !session.is_open ||
    (arm.expiration_date && session.date > arm.expiration_date);
  const waitingMarket = (session, extra = {}) => result('exit_waiting_market', {
    calendar_verified: session.verified, market_reason: session.reason,
    session_close_minute: session.close_minute,
    expiration_window_missed: !!arm.expiration_date && expirationStatus(arm.expiration_date,new Date(clock())).window_missed,
    ...extra });
  let session = marketSession(new Date(clock()));
  if (marketClosed(session)) return waitingMarket(session);

  let orders;
  try { orders = await broker.orders(arm.option_id); }
  catch (error) { rethrowOwnership(error); return result('exit_outcome_unknown', { message: errorMessage(error) }); }
  const working = orders.filter(isWorkingOrder);
  if (working.length) save({ observed_working_order_ids: working.map(order => order.id).filter(Boolean) });
  const opaque = working.find(order => !['stop', 'immediate'].includes(order.trigger));
  if (opaque) return result('exit_outcome_unknown', { order_id: opaque.id, order_state: stateOf(opaque),
    message: 'A working close has an unknown trigger; no additional sell submitted' });
  const immediate = working.find(order => order.trigger === 'immediate');
  if (immediate) {
    if (immediate.id) {
      if (isAcceptedOrder(immediate)) recordAcceptance(immediate, new Date(clock()).toISOString());
      else save({ order_id: immediate.id, last_order_state: stateOf(immediate) });
    }
    return result('exit_order_working', { order_id: immediate.id, order_state: stateOf(immediate) });
  }
  // The deadline includes cancellation and later position/quote verification.
  const waitUntil = Math.min(clock() + MAX_CANCELLATION_WAIT_MS, Math.max(clock(), deadline - CANCELLATION_RESERVE_MS));
  for (const stop of orders.filter(order => order.trigger === 'stop' && isWorkingOrder(order))) {
    if (!stop.id) return result('stop_outcome_unknown');
    if (!['pending_cancelled', 'pending_canceled'].includes(stateOf(stop))) {
      try { await broker.cancel(stop.id); }
      catch (error) { rethrowOwnership(error); return result('stop_outcome_unknown', { stop_order_id: stop.id, message: errorMessage(error) }); }
    }
    for (;;) {
      let current;
      try { current = await broker.order(stop.id); }
      catch (error) { rethrowOwnership(error); return result('stop_outcome_unknown', { stop_order_id: stop.id, message: errorMessage(error) }); }
      if (!current) return result('stop_outcome_unknown', { stop_order_id: stop.id });
      if (isFilledOrder(current)) return result('closed_by_stop', { closure_verified: true,
        order_id: stop.id, order_state: stateOf(current) });
      if (isVerifiedZeroFillTerminal(current)) break;
      if (!isWorkingOrder(current)) return result('stop_outcome_unknown', {
        stop_order_id: stop.id, order_state: stateOf(current) });
      if (clock() >= waitUntil) return result('stop_cancel_pending', {
        stop_order_id: stop.id, order_state: stateOf(current) });
      await sleep(Math.min(1500, Math.max(0, waitUntil - clock())));
    }
  }

  // An empty positions response alone never proves the contract has closed.
  let position;
  try { position = await broker.position(arm.option_id); }
  catch (error) { rethrowOwnership(error); return result('closure_pending_verification', { message: errorMessage(error) }); }
  if (!position) return result('closure_pending_verification');
  session = marketSession(new Date(clock()));
  if (marketClosed(session)) return waitingMarket(session);
  let type = intent.submission_parameters?.type ?? 'market';
  let price = intent.submission_parameters?.price;
  if (!intent.submission_parameters && session.minute < session.entry_start_minute) {
    const quote = await broker.optionQuote(arm.option_id);
    const bid = Number(quote?.bid_price);
    const age = clock() - Date.parse(quote?.updated_at ?? '');
    if (!Number.isFinite(bid) || bid <= 0 || !Number.isFinite(age) || age < -5000 || age > 10000) {
      return result('exit_quote_unavailable');
    }
    type = 'limit'; price = bid.toFixed(2);
  }
  // Quote requests can be slow enough to cross the closing bell.
  session = marketSession(new Date(clock()));
  if (marketClosed(session)) return waitingMarket(session);
  const outbound = new Date(clock()).toISOString();
  const parameters = { type, ...(price ? { price } : {}) };
  // Every transport retry of one reference repeats exactly the same order arguments.
  const attempt = { ref_id: intent.ref_id, outbound_at: outbound, type,
    ...(price ? { price } : {}), outcome: 'unknown' };
  save({ submission_parameters: parameters, attempts: [...(intent.attempts ?? []), attempt], last_attempt_at: outbound,
    local_not_sent: false });
  let placed;
  try { placed = await broker.place({ option_id: arm.option_id, ref_id: intent.ref_id,
    type, ...(price ? { price } : {}) }); }
  catch (error) { rethrowOwnership(error);
    if (error.code === 'LOCAL_PREFLIGHT') {
      const blockedAt = new Date(clock()).toISOString();
      const attempts = [...intent.attempts];
      attempts[attempts.length - 1] = { ...attempt, responded_at: blockedAt, outcome: 'local_not_sent' };
      save({ attempts, local_not_sent: true, blocked_at: blockedAt,
        last_response_at: blockedAt, last_attempt_error: errorMessage(error) });
      return waitingMarket(marketSession(new Date(clock())), {
        local_not_sent: true, order_type: type, message: errorMessage(error) });
    }
    save({ last_response_at: new Date(clock()).toISOString(), last_attempt_error: errorMessage(error) });
    return result('exit_outcome_unknown', { order_type: type, message: errorMessage(error) });
  }
  const order = placed?.order;
  const responseAt = new Date(clock()).toISOString();
  const accepted = isAcceptedOrder(order);
  const zeroTerminal = isVerifiedZeroFillTerminal(order);
  const attempts = [...intent.attempts];
  attempts[attempts.length - 1] = { ...attempt, responded_at: responseAt,
    ...(order?.id ? { order_id: order.id } : {}), order_state: stateOf(order),
    outcome: accepted ? 'accepted' : zeroTerminal ? 'terminal_zero_fill' : 'unknown' };
  save({ attempts, last_response_at: responseAt, last_order_state: stateOf(order),
    ...(order?.id ? { order_id: order.id } : {}) });
  if (!accepted) return result(ZERO_FILL_TERMINAL_STATES.has(stateOf(order)) ? 'exit_rejected' : 'exit_outcome_unknown', {
    order_type: type, order_id: order?.id, order_state: stateOf(order) });
  recordAcceptance(order, responseAt);
  return result(isFilledOrder(order) ? 'closed_by_exit' : 'exit_submitted', {
    order_state: stateOf(order), order_id: order.id, order_type: type,
    closure_verified: isFilledOrder(order), acknowledged_at: responseAt });
}
