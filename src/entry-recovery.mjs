import { ACCEPTED_ORDER_STATES, ZERO_FILL_TERMINAL_STATES, stateOf, filledQuantity,
  isVerifiedZeroFillTerminal } from './order-state.mjs';
import { createHash } from 'node:crypto';

const phases = new Set(['prepared', 'dispatch_started', 'response_received', 'local_not_sent']);
const submissionKeys = ['legs', 'quantity', 'type', 'price', 'time_in_force', 'market_hours', 'ref_id'];
const legKeys = ['option_id', 'side', 'position_effect', 'ratio_quantity'];
const fail = message => { throw new Error(`Entry recovery blocked: ${message}`); };
function numeric(value, name) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) fail(`${name} unavailable`);
  return Number(value);
}
function time(value, name) { const at = Date.parse(value ?? ''); if (!Number.isFinite(at)) fail(`${name} unavailable`); return at; }
function submissionHash(args) { return createHash('sha256').update(JSON.stringify(Object.fromEntries(submissionKeys.map(key=>[key,args[key]])))).digest('hex'); }

export function openingSubmission(arm, refId, price = arm.entry_premium) {
  return { legs: [{ option_id: arm.option_id, side: 'buy', position_effect: 'open', ratio_quantity: 1 }],
    quantity: '1', type: 'limit', price: Number(price).toFixed(2), time_in_force: 'gfd',
    market_hours: 'regular_hours', ref_id: refId };
}

export function prepareEntryIntent({ arm, setupId, policySnapshot, now = Date.now() }) {
  const intent = { version: 1, option_id: arm.option_id, ref_id: arm.trade_id, trade_id: arm.trade_id,
    setup_id: setupId, policy_snapshot: policySnapshot, created_at: new Date(now).toISOString(),
    original_limit_premium: arm.entry_premium, dispatch_phase: 'prepared', dispatch_attempts: 0,
    submission_args: openingSubmission(arm, arm.trade_id) };
  intent.submission_sha256 = submissionHash(intent.submission_args);
  validateEntryIntent(intent, arm);
  return intent;
}

export function validateEntryIntent(intent, arm) {
  if (!intent || intent.option_id !== arm.option_id || typeof intent.ref_id !== 'string' || !intent.ref_id ||
      arm.trade_id && intent.trade_id && arm.trade_id !== intent.trade_id) fail('intent identity differs from armed contract');
  time(intent.created_at, 'original creation time');
  if (intent.dispatch_phase !== undefined && !phases.has(intent.dispatch_phase)) fail('dispatch phase is malformed');
  // Legacy known-ID records may be read and filled, but never resent without saved arguments.
  const args = intent.submission_args ?? openingSubmission(arm, intent.ref_id, intent.original_limit_premium ?? arm.entry_premium);
  if (!args || Object.keys(args).some(key => !submissionKeys.includes(key)) || submissionKeys.some(key => !Object.hasOwn(args, key))) fail('saved submission fields are malformed');
  const leg = args.legs?.[0];
  if (!Array.isArray(args.legs) || args.legs.length !== 1 || !leg || Object.keys(leg).some(key => !legKeys.includes(key)) ||
      leg.option_id !== arm.option_id || leg.side !== 'buy' || leg.position_effect !== 'open' || leg.ratio_quantity !== 1 ||
      args.quantity !== '1' || args.type !== 'limit' || args.time_in_force !== 'gfd' || args.market_hours !== 'regular_hours' || args.ref_id !== intent.ref_id ||
      typeof args.price !== 'string' || !/^\d+\.\d{2}$/.test(args.price) || numeric(args.price, 'limit price') <= 0 || Number(args.price) > 5) fail('saved submission differs from the authorized one-contract limit buy');
  if (intent.original_limit_premium !== undefined && Math.abs(numeric(intent.original_limit_premium, 'original premium') - Number(args.price)) > 1e-8) fail('original limit price changed');
  if (intent.submission_args && (typeof intent.submission_sha256 !== 'string' || intent.submission_sha256 !== submissionHash(args))) fail('saved submission checksum changed');
  if (intent.dispatch_started_at !== undefined) time(intent.dispatch_started_at, 'dispatch start');
  return args;
}

export function validateOpeningOrder(order, intent, arm, { requireReference = false, now = Date.now() } = {}) {
  const args = validateEntryIntent(intent, arm);
  if (!order || typeof order.id !== 'string' || !order.id || !Array.isArray(order.legs) || order.legs.length !== 1) fail('opening order identity or legs unavailable');
  if (intent.order_id && order.id !== intent.order_id) fail('broker order identity differs from saved order ID');
  const leg = order.legs[0];
  if (!leg || leg.option_id !== arm.option_id || leg.side !== 'buy' || leg.position_effect !== 'open' || numeric(leg.ratio_quantity, 'leg ratio') !== 1 ||
      numeric(order.quantity, 'order quantity') !== 1 || order.type !== args.type || order.trigger !== 'immediate' ||
      numeric(order.price, 'order price') !== Number(args.price) || order.direction !== 'debit' ||
      order.time_in_force !== args.time_in_force || order.market_hours !== args.market_hours || numeric(order.trade_value_multiplier, 'multiplier') !== 100) fail('broker opening order does not match saved submission');
  if (requireReference && order.ref_id !== intent.ref_id || order.ref_id !== undefined && order.ref_id !== intent.ref_id) fail('broker client reference does not match');
  const created = time(order.created_at, 'broker creation time');
  if (created < time(intent.created_at, 'original creation time') - 5000 || created > now + 5000) fail('broker order time does not match original attempt');
  const state = stateOf(order), quantity = filledQuantity(order);
  if (!ACCEPTED_ORDER_STATES.has(state) && !ZERO_FILL_TERMINAL_STATES.has(state)) fail('broker opening order state is unknown');
  if (quantity === null || quantity < 0 || quantity > 1 || quantity !== 0 && quantity !== 1) fail('broker opening fill quantity is unverified');
  return order;
}

export function verifiedEntryFill(order, intent, arm, { now = Date.now() } = {}) {
  validateOpeningOrder(order, intent, arm, { now });
  if (stateOf(order) !== 'filled' || filledQuantity(order) !== 1) fail('complete opening fill is not verified');
  const limit = Number(validateEntryIntent(intent, arm).price);
  const executions = order.legs[0].executions;
  let premium = numeric(order.processed_premium, 'processed opening premium') / 100;
  let filledAt = time(order.last_transaction_at, 'opening fill time');
  if (executions !== undefined && executions !== null) {
    if (!Array.isArray(executions) || !executions.length || executions.some(value => !value)) fail('opening executions are malformed');
    let quantity = 0, total = 0;
    const timestamps = [];
    for (const execution of executions) {
      const price = numeric(execution.price, 'execution price'), count = numeric(execution.quantity, 'execution quantity');
      if (price <= 0 || price > limit + 1e-8 || count <= 0) fail('opening execution exceeds the original limit or has invalid quantity');
      quantity += count; total += price * count; timestamps.push(time(execution.timestamp, 'execution time'));
    }
    if (Math.abs(quantity - 1) > 1e-8 || Math.abs(total - premium) > 0.0002) fail('opening execution totals disagree');
    premium = total; filledAt = Math.max(...timestamps);
  }
  if (!Number.isFinite(premium) || premium <= 0 || premium > limit + 1e-8 || filledAt < Date.parse(order.created_at) - 5000 || filledAt > now + 5000) fail('opening premium or fill time is unverified');
  return { order_id: order.id, premium, filled_at: new Date(filledAt).toISOString(), executions: executions ?? [], fees: null };
}

// The positions API reports total contract cost basis, not per-share premium.
// This proves the current entry basis without claiming an opening order identity or fee-free fill.
export function verifiedPositionEntryBasis(position, intent, arm, { now = Date.now() } = {}) {
  const limit = Number(validateEntryIntent(intent, arm).price);
  if (!position || position.chain_symbol !== 'QQQ' || position.option_id !== arm.option_id ||
      position.expiration_date !== arm.expiration_date || position.type !== 'long' ||
      numeric(position.quantity, 'position quantity') !== 1 || numeric(position.trade_value_multiplier, 'position multiplier') !== 100) fail('position entry basis has an incompatible identity');
  const openedAt = time(position.opened_at, 'position open time');
  const premium = numeric(position.average_price, 'position cost basis') / 100;
  if (openedAt < time(intent.created_at, 'original creation time') - 5000 || openedAt > now + 5000 ||
      premium <= 0 || premium > limit + 1e-8) fail('position entry basis differs from the original entry');
  return { premium, opened_at: new Date(openedAt).toISOString(), basis: 'broker_position_cost', fees: null,
    order_identity_verified: false, execution_fill_verified: false };
}

export async function readAllEntryOrders(broker, createdAt, { maxPages = 5, budgetMs = 30000 } = {}) {
  time(createdAt, 'order search start');
  const result = [], cursors = new Set(), began = Date.now(); let cursor;
  for (let page = 0; page < maxPages; page++) {
    const remaining = budgetMs - (Date.now() - began);
    if (remaining <= 0) fail('complete opening-order search exceeded its time budget');
    let timer;
    const query = broker.ordersPage({ created_at_gte: new Date(Date.parse(createdAt) - 5000).toISOString(), ...(cursor ? { cursor } : {}) });
    let response;
    try { response = await Promise.race([query,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Entry recovery blocked: complete opening-order search exceeded its time budget')),remaining);})]); }
    finally { clearTimeout(timer); }
    if (!response || !Array.isArray(response.orders) || response.orders.some(order => !order || typeof order !== 'object')) fail('opening-order history is incomplete or malformed');
    result.push(...response.orders);
    if (!response.next) return result;
    if (typeof response.next !== 'string' || cursors.has(response.next)) fail('opening-order pagination is malformed');
    cursor = response.next; cursors.add(cursor);
  }
  fail('opening-order history exceeds the complete-search limit');
}

// Risk exits must be decided before potentially slow opening-fill research.
export async function priorityEntryExit({ readPrimaryDecision, submitPrimaryExit }) {
  let decision;
  try { decision = await readPrimaryDecision(); }
  catch(error) { return { priority_exit:false, primary_error:String(error.message).slice(0,200) }; }
  if (!decision?.exit) return { priority_exit:false };
  await submitPrimaryExit(decision);
  return { priority_exit:true, decision };
}

// This function only reads/reconciles. It never places or repeats a buy.
export async function recoverEntry({ intent, arm, broker, save = () => {}, entryProcessActive = false, now = Date.now() }) {
  validateEntryIntent(intent, arm);
  if (intent.local_not_sent === true && !intent.dispatch_started_at && !intent.order_id ||
      intent.dispatch_phase === 'prepared' && !intent.dispatch_started_at && !intent.order_id && !entryProcessActive) {
    return { status: 'entry_not_submitted', verified_not_sent: true };
  }
  if (intent.dispatch_phase === 'prepared' && !intent.order_id && entryProcessActive) return { status: 'entry_preparing' };
  let current;
  if (intent.order_id) current = await broker.order(intent.order_id);
  else {
    const history = await readAllEntryOrders(broker, intent.created_at);
    const matches = history.filter(order => order.ref_id === intent.ref_id);
    if (matches.length > 1) fail('more than one broker order has the original reference');
    if (!matches.length) return { status: 'entry_outcome_unknown', message: 'Original buy reference cannot be located; retained without a duplicate buy' };
    current = validateOpeningOrder(matches[0], intent, arm, { requireReference: true, now });
    intent = { ...intent, order_id: current.id, recovered_at: new Date(now).toISOString(), dispatch_phase: 'response_received' };
    save(intent);
  }
  validateOpeningOrder(current, intent, arm, { now });
  if (isVerifiedZeroFillTerminal(current)) return { status: 'entry_not_filled', order: current, verified_zero_fill: true };
  if (stateOf(current) === 'filled') return { status: 'entry_filled', order: current, fill: verifiedEntryFill(current, intent, arm, { now }) };
  if (ZERO_FILL_TERMINAL_STATES.has(stateOf(current)) || filledQuantity(current) !== 0) fail('terminal or partial opening fill remains unverified');
  return { status: 'entry_pending', order: current };
}

export async function dispatchEntry({ intent, arm, save, place, preflight, now = () => Date.now(), retry = false }) {
  const args = structuredClone(validateEntryIntent(intent, arm));
  for (const leg of args.legs) Object.freeze(leg);
  Object.freeze(args.legs); Object.freeze(args);
  if (!intent.submission_args) fail('legacy submission arguments cannot be replayed');
  const attempts = intent.dispatch_attempts ?? 0;
  if (intent.order_id || intent.local_not_sent || retry && (attempts !== 1 || intent.dispatch_phase !== 'dispatch_started' || !intent.dispatch_started_at || now() - Date.parse(intent.created_at) > 120000) ||
      !retry && (attempts !== 0 || intent.dispatch_phase !== 'prepared')) fail('buy dispatch or retry is not eligible');
  // Retry preflight must freshly recheck the full original entry eligibility.
  await preflight({ retry, beforeSend: false });
  const original = JSON.stringify(args);
  const result = await place(args, () => {
    const checked = preflight({ retry, beforeSend: true });
    if (checked && typeof checked.then === 'function') fail('final dispatch guard must be synchronous');
    if (JSON.stringify(validateEntryIntent(intent, arm)) !== original || retry && now() - Date.parse(intent.created_at) > 120000) fail('saved buy arguments or retry age changed');
    intent = { ...intent, dispatch_phase: 'dispatch_started', dispatch_started_at: intent.dispatch_started_at ?? new Date(now()).toISOString(),
      last_dispatch_at: new Date(now()).toISOString(), dispatch_attempts: attempts + 1 };
    save(intent);
  });
  if (!result?.order?.id) fail('buy response has no order identity; outcome remains unknown');
  validateOpeningOrder(result.order, intent, arm, { now: now() });
  save({ ...intent, order_id: result.order.id, dispatch_phase: 'response_received', response_received_at: new Date(now()).toISOString() });
  return result;
}
