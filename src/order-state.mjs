export const ZERO_FILL_TERMINAL_STATES = new Set(['cancelled', 'canceled', 'rejected', 'failed', 'voided']);
export const ACCEPTED_ORDER_STATES = new Set(['unconfirmed', 'confirmed', 'queued', 'pending',
  'pending_new', 'pending_cancelled', 'pending_canceled', 'partially_filled', 'filled']);

export function stateOf(order) {
  return typeof order?.state === 'string' ? order.state.toLowerCase() : 'unknown';
}

// A cancellation can race a fill; its state alone never establishes zero fills.
export function filledQuantity(order) {
  for (const key of ['processed_quantity', 'filled_quantity']) {
    if (order?.[key] !== undefined && order[key] !== null && order[key] !== '') {
      const value = Number(order[key]);
      return Number.isFinite(value) && value >= 0 ? value : null;
    }
  }
  return null;
}

export function isVerifiedZeroFillTerminal(order) {
  return ZERO_FILL_TERMINAL_STATES.has(stateOf(order)) && filledQuantity(order) === 0;
}

export function isFilledOrder(order) {
  return stateOf(order) === 'filled';
}

export function isWorkingOrder(order) {
  const state = stateOf(order);
  if (isFilledOrder(order) || ZERO_FILL_TERMINAL_STATES.has(state)) return false;
  // Pending quantity protects against an unfamiliar state introduced by the broker.
  return Number(order?.pending_quantity) > 0 || ACCEPTED_ORDER_STATES.has(state);
}

export function isAcceptedOrder(order) {
  return typeof order?.id === 'string' && order.id.length > 0 && ACCEPTED_ORDER_STATES.has(stateOf(order));
}
