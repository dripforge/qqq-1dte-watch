import test from 'node:test';
import assert from 'node:assert/strict';
import { stateOf, filledQuantity, isWorkingOrder, isAcceptedOrder, isVerifiedZeroFillTerminal } from './order-state.mjs';

test('zero-fill terminal requires explicit valid fill quantity', () => {
  for (const state of ['cancelled', 'rejected', 'failed', 'voided']) {
    assert.equal(isVerifiedZeroFillTerminal({ state, processed_quantity: '0' }), true);
    assert.equal(isVerifiedZeroFillTerminal({ state }), false);
    assert.equal(isVerifiedZeroFillTerminal({ state, processed_quantity: '1' }), false);
    assert.equal(isWorkingOrder({ state, pending_quantity: '1' }), false);
  }
  assert.equal(filledQuantity({ processed_quantity: 'bad' }), null);
  assert.equal(filledQuantity({ filled_quantity: 0 }), 0);
});

test('acceptance requires a recognized state and a verifiable order ID', () => {
  for (const state of ['unconfirmed', 'queued', 'confirmed', 'partially_filled', 'filled']) {
    assert.equal(isAcceptedOrder({ id: 'order-1', state }), true);
    assert.equal(isAcceptedOrder({ state }), false);
  }
  assert.equal(isAcceptedOrder({ id: 'order-1', state: 'rejected' }), false);
  assert.equal(isAcceptedOrder({ id: 'order-1', state: 'unrecognized' }), false);
  assert.equal(stateOf({ state: 'CONFIRMED' }), 'confirmed');
  assert.equal(isWorkingOrder({ state: 'unrecognized', pending_quantity: '1' }), true);
});
