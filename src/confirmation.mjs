export const BASE_CROSS_CONFIRM_MS = 0;

export function confirmBaseCross(arm, decision, previous, now = new Date()) {
  // Price noise is handled in level placement, without consuming exit time.
  return { decision, candidate: null };
}
