import { evaluate } from './logic.mjs';
import { effectiveExitLevel } from './profit-policy.mjs';

export function decideExit({ arm, position, quote, now = new Date(), pendingExit, profitRequest, profitPlan }) {
  const level = effectiveExitLevel(arm, profitPlan);
  if (pendingExit?.option_id === arm.option_id && (!arm.trade_id || !pendingExit.trade_id || pendingExit.trade_id === arm.trade_id)) {
    return { exit: true, reason: pendingExit.reason, observed_at: pendingExit.breach_at,
      qqq_exit_level: level };
  }
  if (profitRequest?.option_id === arm.option_id && (!arm.trade_id || profitRequest.trade_id === arm.trade_id)) {
    return { exit: true, reason: 'profit_discretion',
      observed_at: profitRequest.requested_at, qqq_exit_level: level };
  }
  const decision = evaluate({ ...arm, qqq_invalidation: level }, position, quote, now);
  if (decision.exit && decision.reason === 'qqq_invalidation' && level !== arm.qqq_invalidation) {
    decision.reason = 'qqq_profit_trail';
  }
  return { ...decision, qqq_exit_level: level };
}
