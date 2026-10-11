import test from 'node:test';
import assert from 'node:assert/strict';
import { submitExit, pendingClose, SUBMISSION_TARGET_MS, CANCELLATION_RESERVE_MS } from './orderflow.mjs';

const optionId = '00000000-0000-4000-8000-000000000001';
const arm = { option_id: optionId, expiration_date: '2026-10-09' };
const breach = Date.parse('2026-10-08T15:30:02Z');
const decision = { reason: 'qqq_invalidation', observed_at: new Date(breach).toISOString() };
const legs = [{ option_id: optionId, side: 'sell', position_effect: 'close' }];
const stop = { id: 'stop-1', trigger: 'stop', state: 'confirmed', pending_quantity: '1', processed_quantity: '0', legs };
const cancelled = { id: 'stop-1', state: 'cancelled', processed_quantity: '0', pending_quantity: '0' };
function harness({ now = breach + 3000, initial = null, overrides = {} } = {}) {
  let time = now, saved = initial;
  const calls = [];
  const broker = {
    orders: async () => { calls.push('orders'); return []; },
    order: async id => { calls.push(`order:${id}`); return cancelled; },
    cancel: async id => { calls.push(`cancel:${id}`); },
    position: async () => { calls.push('position'); return { quantity: '1' }; },
    optionQuote: async () => ({ bid_price: '1.23', updated_at: new Date(time - 2000).toISOString() }),
    place: async args => { calls.push({ place: args }); return { order: { id: 'close-1', state: 'confirmed', pending_quantity: '1' } }; },
    ...overrides,
  };
  const intentStore = { load: () => saved, save: value => { saved = value; } };
  return { broker, intentStore, calls, advance: ms => { time += ms; },
    clock: () => time, sleep: async ms => { time += ms; }, saved: () => saved,
    submit: (input = {}) => submitExit({ arm, decision, broker, intentStore, clock: () => time,
      sleep: async ms => { time += ms; }, ...input }) };
}

test('confirms zero-fill stop cancellation before one accepted market submission', async () => {
  const h = harness({ overrides: { orders: async () => [stop] } });
  const result = await h.submit();
  assert.deepEqual(h.calls.slice(0, 3), ['cancel:stop-1', 'order:stop-1', 'position']);
  assert.equal(h.calls[3].place.type, 'market');
  assert.equal(result.status, 'exit_submitted');
  assert.equal(result.elapsed_ms, 3000);
  assert.equal(result.deadline_met, true);
  assert.equal(h.saved().attempts[0].outcome, 'accepted');
});

test('stop fill racing cancellation verifies closure without a duplicate sell', async () => {
  const h = harness({ overrides: { orders: async () => [stop],
    order: async () => ({ id: stop.id, state: 'filled', processed_quantity: '1' }) } });
  const result = await h.submit();
  assert.equal(result.status, 'closed_by_stop');
  assert.equal(result.closure_verified, true);
  assert.equal(h.calls.some(call => call.place), false);
});

test('cancelled stop without zero-fill proof keeps the exit armed', async () => {
  for (const current of [{ state: 'cancelled' }, { state: 'cancelled', processed_quantity: '0.5' }]) {
    const h = harness({ overrides: { orders: async () => [stop], order: async () => current } });
    const result = await h.submit();
    assert.equal(result.status, 'stop_outcome_unknown');
    assert.ok(h.saved().ref_id);
    assert.equal(h.calls.some(call => call.place), false);
  }
});

test('integrated cancellation uses remaining breach budget and surfaces a late safe submission', async () => {
  let canceled = false;
  const h = harness({ now: breach + 75000, overrides: {
    orders: async () => [{ ...stop, state: 'pending_cancelled' }],
    order: async () => canceled ? cancelled : { ...stop, state: 'pending_cancelled' },
  } });
  const first = await h.submit();
  assert.equal(first.status, 'stop_cancel_pending');
  assert.equal(h.clock(), breach + SUBMISSION_TARGET_MS - CANCELLATION_RESERVE_MS);
  assert.equal(first.remaining_ms, CANCELLATION_RESERVE_MS);
  assert.equal(first.deadline_met, null);
  assert.equal(h.calls.some(call => call.place), false);
  h.advance(35000);
  const expired = await h.submit();
  assert.equal(expired.deadline_met, false);
  assert.equal(expired.deadline_exceeded, true);
  assert.equal(h.calls.some(call => call.place), false);
  canceled = true;
  const late = await h.submit();
  assert.equal(late.status, 'exit_submitted');
  assert.equal(late.elapsed_ms, 125000);
  assert.equal(late.deadline_met, false);
  assert.equal(late.deadline_exceeded, true);
  assert.equal(h.saved().breach_at, decision.observed_at);
});

test('pending cancellation is polled without another cancellation request', async () => {
  const states = [{ ...stop, state: 'pending_cancelled' }, cancelled];
  const h = harness({ overrides: { orders: async () => [{ ...stop, state: 'pending_cancelled' }],
    order: async () => states.shift() } });
  assert.equal((await h.submit()).status, 'exit_submitted');
  assert.equal(h.calls.some(call => typeof call === 'string' && call.startsWith('cancel:')), false);
});

test('unknown cancellation response never causes a second sell', async () => {
  const h = harness({ overrides: { orders: async () => [stop],
    cancel: async () => { throw new Error('Network disconnected after cancel request'); } } });
  const result = await h.submit();
  assert.equal(result.status, 'stop_outcome_unknown');
  assert.equal(result.message, 'Network disconnected after cancel request');
  assert.equal(h.calls.some(call => call.place), false);
});

test('rejected close requires a verified zero-fill reconciliation before a new reference', async () => {
  const refs = [];
  const rejected = { id: 'close-rejected', state: 'rejected', processed_quantity: '0' };
  const h = harness({ overrides: {
    order: async () => rejected,
    place: async args => { refs.push(args.ref_id); return { order: refs.length === 1 ? rejected :
      { id: 'close-accepted', state: 'queued', pending_quantity: '1' } }; },
  } });
  const first = await h.submit();
  assert.equal(first.status, 'exit_rejected');
  assert.equal(first.first_accepted_submission_at, null);
  assert.equal(first.deadline_met, null);
  h.advance(2000);
  const second = await h.submit();
  assert.equal(second.status, 'exit_submitted');
  assert.notEqual(refs[0], refs[1]);
  assert.equal(h.saved().prior_orders[0].order_id, rejected.id);
  assert.deepEqual(h.saved().attempts.map(a => a.outcome), ['terminal_zero_fill', 'accepted']);
});

test('terminal close with missing fill data does not get a fresh reference', async () => {
  const saved = { option_id: optionId, ref_id: 'same-ref', order_id: 'terminal', reason: 'qqq_invalidation',
    breach_at: decision.observed_at, created_at: decision.observed_at };
  for (const order of [{ id: 'terminal', state: 'cancelled' }, { id: 'terminal', state: 'failed', processed_quantity: '0.5' }]) {
    const h = harness({ initial: saved, overrides: { order: async () => order } });
    assert.equal((await h.submit()).status, 'exit_outcome_unknown');
    assert.equal(h.saved().ref_id, 'same-ref');
    assert.equal(h.calls.some(call => call.place), false);
  }
});

test('unknown placement outcome preserves its reference across a retry', async () => {
  const refs = [];
  const h = harness({ overrides: { place: async args => {
    refs.push(args.ref_id);
    if (refs.length === 1) throw new Error('Response lost after submission');
    return { order: { id: 'close-1', state: 'confirmed' } };
  } } });
  const unknown = await h.submit();
  assert.equal(unknown.status, 'exit_outcome_unknown');
  assert.equal(unknown.message, 'Response lost after submission');
  h.advance(5000);
  assert.equal((await h.submit()).status, 'exit_submitted');
  assert.equal(refs[0], refs[1]);
  assert.equal(h.saved().attempts.length, 2);
  assert.notEqual(h.saved().attempts[0].outbound_at, h.saved().attempts[1].outbound_at);
});

test('response lacking an order ID stays unknown and retains its reference', async () => {
  const h = harness({ overrides: { place: async () => ({ order: { state: 'confirmed' } }) } });
  assert.equal((await h.submit()).status, 'exit_outcome_unknown');
  const ref = h.saved().ref_id;
  assert.equal((await h.submit()).status, 'exit_outcome_unknown');
  assert.equal(h.saved().ref_id, ref);
  assert.equal(h.saved().first_accepted_submission_at, undefined);
});

test('missing saved order cannot be retried as a new order', async () => {
  const h = harness({ initial: { option_id: optionId, ref_id: 'prior-ref', order_id: 'unknown',
    breach_at: decision.observed_at, reason: 'qqq_invalidation' }, overrides: { order: async () => null } });
  assert.equal((await h.submit()).status, 'exit_outcome_unknown');
  assert.equal(h.saved().ref_id, 'prior-ref');
  assert.equal(h.calls.some(call => call.place), false);
});

test('reconciles a queued or partially filled close before doing anything else', async () => {
  for (const state of ['queued', 'confirmed', 'partially_filled']) {
    const initial = { option_id: optionId, ref_id: 'prior-ref', order_id: 'working',
      breach_at: decision.observed_at, reason: 'qqq_invalidation', first_accepted_submission_at: new Date(breach + 2000).toISOString() };
    const h = harness({ initial, overrides: { order: async () => ({ id: 'working', state, pending_quantity: '1' }),
      orders: async () => { throw new Error('Do not query or resubmit a known working order'); } } });
    const result = await h.submit();
    assert.equal(result.status, 'exit_order_working');
    assert.equal(result.elapsed_ms, 2000);
    assert.equal(h.calls.some(call => call.place), false);
  }
});

test('a previously accepted then cancelled close preserves first acceptance across replacement', async () => {
  const initial = { option_id: optionId, ref_id: 'prior-ref', order_id: 'cancelled-close',
    breach_at: decision.observed_at, reason: 'qqq_invalidation', submitted_at: new Date(breach + 2000).toISOString(),
    first_accepted_submission_at: new Date(breach + 2000).toISOString() };
  const h = harness({ now: breach + 150000, initial, overrides: {
    order: async () => ({ id: 'cancelled-close', state: 'cancelled', processed_quantity: '0' }),
  } });
  const result = await h.submit();
  assert.equal(result.status, 'exit_submitted');
  assert.equal(result.elapsed_ms, 2000);
  assert.equal(result.deadline_met, true);
  assert.equal(h.saved().submitted_at, initial.submitted_at);
  assert.equal(h.saved().last_attempt_at, new Date(breach + 150000).toISOString());
});

test('an unverified empty position response never declares closure or submits a sell', async () => {
  const h = harness({ overrides: { position: async () => null } });
  const result = await h.submit();
  assert.equal(result.status, 'closure_pending_verification');
  assert.notEqual(result.closure_verified, true);
  assert.ok(h.saved().ref_id);
  assert.equal(h.calls.some(call => call.place), false);
});

test('a verified filled close can prove closure even before positions catch up', async () => {
  const h = harness({ initial: { option_id: optionId, ref_id: 'prior-ref', order_id: 'filled-close',
    breach_at: decision.observed_at, reason: 'qqq_invalidation' }, overrides: {
    order: async () => ({ id: 'filled-close', state: 'filled', processed_quantity: '1' }),
  } });
  const result = await h.submit();
  assert.equal(result.status, 'closed_by_exit');
  assert.equal(result.closure_verified, true);
  assert.equal(h.calls.some(call => call.place), false);
});

test('an immediate filled placement is reported as verified closure', async () => {
  const h = harness({ overrides: { place: async () => ({ order: { id: 'filled-close', state: 'filled' } }) } });
  const result = await h.submit();
  assert.equal(result.status, 'closed_by_exit');
  assert.equal(result.closure_verified, true);
});

test('uses a fresh bid limit for an urgent early-session exit', async () => {
  const early = Date.parse('2026-10-08T13:40:04Z');
  const h = harness({ now: early });
  const result = await h.submit({ decision: { reason: 'qqq_invalidation', observed_at: new Date(early - 3000).toISOString() } });
  assert.equal(result.order_type, 'limit');
  assert.equal(h.calls.find(call => call.place).place.price, '1.23');
});

test('a stale early-session bid retains the exit intent without placing', async () => {
  const early = Date.parse('2026-10-08T13:40:04Z');
  const h = harness({ now: early, overrides: { optionQuote: async () => ({ bid_price: '1.23', updated_at: new Date(early - 20000).toISOString() }) } });
  const result = await h.submit({ decision: { reason: 'qqq_invalidation', observed_at: new Date(early - 3000).toISOString() } });
  assert.equal(result.status, 'exit_quote_unavailable');
  assert.ok(h.saved().ref_id);
  assert.equal(h.calls.some(call => call.place), false);
});

test('pending exits remain saved outside regular hours and report missed expiry', async () => {
  const late = Date.parse('2026-10-09T20:01:00Z');
  const h = harness({ now: late });
  const result = await h.submit();
  assert.equal(result.status, 'exit_waiting_market');
  assert.equal(result.expiration_window_missed, true);
  assert.equal(result.deadline_met, false);
  assert.equal(h.calls.length, 0);
  assert.ok(h.saved().ref_id);
});

test('rechecks market hours after slow cancellation to avoid queuing an overnight sell', async () => {
  const beforeClose = Date.parse('2026-10-08T19:59:55Z');
  let h;
  h = harness({ now: beforeClose, overrides: { orders: async () => [stop],
    order: async () => { h.advance(10000); return cancelled; } } });
  const result = await h.submit({ decision: { reason: 'profit_discretion', observed_at: new Date(beforeClose).toISOString() } });
  assert.equal(result.status, 'exit_waiting_market');
  assert.equal(h.calls.some(call => call.place), false);
});

test('without broker creation time a slow acceptance conservatively misses the deadline', async () => {
  let h;
  h = harness({ overrides: { place: async () => { h.advance(130000); return { order: { id: 'close-1', state: 'confirmed' } }; } } });
  const result = await h.submit();
  assert.equal(result.deadline_met, false);
  assert.equal(result.deadline_exceeded, true);
  assert.equal(result.elapsed_ms, 133000);
  assert.equal(h.saved().first_accepted_submission_at, new Date(breach + 133000).toISOString());
  assert.equal(h.saved().attempts[0].outbound_at, new Date(breach + 3000).toISOString());
  assert.equal(result.acknowledged_at, new Date(breach + 133000).toISOString());
});

test('an earlier immediate limit close prevents a duplicate sell', async () => {
  const working = { id: 'close-1', trigger: 'immediate', type: 'limit', state: 'confirmed', pending_quantity: '1', legs };
  const h = harness({ overrides: { orders: async () => [working] } });
  assert.equal(pendingClose(working, optionId), true);
  assert.equal((await h.submit()).status, 'exit_order_working');
  assert.equal(h.calls.some(call => call.place), false);
});


test('unknown early limit retry freezes type and price across 9:45 and changed quotes', async () => {
  const early = Date.parse('2026-10-08T13:44:55Z');
  const placements = [];
  const h = harness({ now: early, overrides: { place: async args => {
    placements.push(args);
    if (placements.length === 1) throw new Error('Unknown outcome');
    return { order: { id: 'recovered-close', state: 'confirmed' } };
  }, optionQuote: async () => ({ bid_price: placements.length ? '0.75' : '1.23', updated_at: new Date(early).toISOString() }) } });
  const input = { decision: { reason: 'qqq_invalidation', observed_at: new Date(early - 2000).toISOString() } };
  assert.equal((await h.submit(input)).status, 'exit_outcome_unknown');
  h.advance(10000);
  assert.equal((await h.submit(input)).status, 'exit_submitted');
  assert.deepEqual(placements[1], placements[0]);
  assert.equal(placements[1].type, 'limit');
  assert.equal(placements[1].price, '1.23');
});

test('broker creation after 150 seconds proves a missed target even if outbound call was early', async () => {
  let h;
  h = harness({ overrides: { place: async () => {
    h.advance(147000);
    return { order: { id: 'late-close', state: 'confirmed', created_at: new Date(breach + 150000).toISOString() } };
  } } });
  const result = await h.submit();
  assert.equal(result.elapsed_ms, 150000);
  assert.equal(result.deadline_met, false);
  assert.equal(result.deadline_exceeded, true);
  assert.equal(h.saved().attempts[0].outbound_at, new Date(breach + 3000).toISOString());
});

test('broker creation before target earns timing credit despite a delayed acknowledgement', async () => {
  let h;
  h = harness({ overrides: { place: async () => {
    h.advance(147000);
    return { order: { id: 'early-close', state: 'confirmed', created_at: new Date(breach + 4000).toISOString() } };
  } } });
  const result = await h.submit();
  assert.equal(result.elapsed_ms, 4000);
  assert.equal(result.deadline_met, true);
  assert.equal(result.deadline_exceeded, false);
});

test('an unknown working close trigger retains its ID and blocks another sell', async () => {
  const h = harness({ overrides: { orders: async () => [{ id: 'opaque-close', state: 'confirmed', trigger: 'new_broker_trigger', pending_quantity: '1', legs }] } });
  const result = await h.submit();
  assert.equal(result.status, 'exit_outcome_unknown');
  assert.deepEqual(h.saved().observed_working_order_ids, ['opaque-close']);
  assert.equal(h.calls.some(call => call.place), false);
});


test('an early limit that is still working after 9:45 is cancelled and replaced only after zero-fill proof', async () => {
  const afterMarketOpen = Date.parse('2026-10-08T13:46:00Z');
  const originallyAccepted = '2026-10-08T13:44:55.000Z';
  const earlyIntent = { option_id: optionId, ref_id: 'limit-ref', order_id: 'early-limit',
    breach_at: '2026-10-08T13:44:53.000Z', reason: 'qqq_invalidation',
    first_accepted_submission_at: originallyAccepted, submitted_at: originallyAccepted,
    submission_parameters: { type: 'limit', price: '1.23' }, attempts: [] };
  let cancellationFinal = false;
  const reads = [];
  const placements = [];
  const earlyOrder = { id: 'early-limit', type: 'limit', trigger: 'immediate',
    state: 'confirmed', pending_quantity: '1', processed_quantity: '0', created_at: originallyAccepted };
  const h = harness({ now: afterMarketOpen, initial: earlyIntent, overrides: {
    order: async id => { reads.push(id); return cancellationFinal
      ? { ...earlyOrder, state: 'cancelled', pending_quantity: '0', processed_quantity: '0' }
      : { ...earlyOrder, state: reads.length === 1 ? 'confirmed' : 'pending_cancelled' }; },
    place: async args => { placements.push(args); return { order: { id: 'market-replacement', state: 'confirmed' } }; },
  } });
  const pending = await h.submit();
  assert.equal(pending.status, 'exit_cancel_pending');
  assert.equal(placements.length, 0);
  assert.equal(h.saved().ref_id, earlyIntent.ref_id);
  assert.equal(h.calls.filter(call => call === 'cancel:early-limit').length, 1);
  h.advance(5000);
  assert.equal((await h.submit()).status, 'exit_cancel_pending');
  assert.equal(h.calls.filter(call => call === 'cancel:early-limit').length, 1);
  cancellationFinal = true;
  const replaced = await h.submit();
  assert.equal(replaced.status, 'exit_submitted');
  assert.equal(placements.length, 1);
  assert.equal(placements[0].type, 'market');
  assert.equal(placements[0].price, undefined);
  assert.notEqual(placements[0].ref_id, earlyIntent.ref_id);
  assert.equal(h.saved().first_accepted_submission_at, originallyAccepted);
  assert.equal(replaced.elapsed_ms, 2000);
});

test('an early limit filling during its cancellation is never followed by a market sell', async () => {
  const afterMarketOpen = Date.parse('2026-10-08T13:46:00Z');
  let reads = 0;
  const h = harness({ now: afterMarketOpen, initial: { option_id: optionId, ref_id: 'limit-ref', order_id: 'early-limit',
    breach_at: '2026-10-08T13:44:53.000Z', reason: 'qqq_invalidation',
    submission_parameters: { type: 'limit', price: '1.23' } }, overrides: {
    order: async () => ++reads === 1
      ? { id: 'early-limit', trigger: 'immediate', type: 'limit', state: 'confirmed', created_at: '2026-10-08T13:44:55Z' }
      : { id: 'early-limit', trigger: 'immediate', type: 'limit', state: 'filled', processed_quantity: '1' },
  } });
  const result = await h.submit();
  assert.equal(result.status, 'closed_by_exit');
  assert.equal(result.closure_verified, true);
  assert.equal(h.calls.some(call => call.place), false);
});

test('an early limit cancellation with incomplete fill data cannot be replaced', async () => {
  let reads = 0;
  const h = harness({ initial: { option_id: optionId, ref_id: 'limit-ref', order_id: 'early-limit',
    breach_at: decision.observed_at, reason: 'qqq_invalidation' }, overrides: {
    order: async () => ++reads === 1 ? { id: 'early-limit', trigger: 'immediate', type: 'limit', state: 'confirmed' }
      : { id: 'early-limit', state: 'cancelled' },
  } });
  assert.equal((await h.submit()).status, 'exit_outcome_unknown');
  assert.equal(h.saved().ref_id, 'limit-ref');
  assert.equal(h.calls.some(call => call.place), false);
});

test('intent carries the trade ID and rejects a different trade reusing the same contract', async () => {
  const h = harness();
  await h.submit({ arm: { ...arm, trade_id: 'trade-a' } });
  assert.equal(h.saved().trade_id, 'trade-a');
  await assert.rejects(h.submit({ arm: { ...arm, trade_id: 'trade-b' } }), /another trade/);
});
