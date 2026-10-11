export const DEFAULT_RISK_POLICY = Object.freeze({ per_trade_risk_fraction: 0.01, daily_loss_fraction: 0.03,
  absolute_daily_loss: 250, emergency_stop_fraction: 0.25, execution_cushion: 1,
  opening_premium_ceiling: 325 });

function number(value, name) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
    throw new Error(`${name} unavailable`);
  }
  return Number(value);
}
export function riskPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Risk policy must be an object');
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(DEFAULT_RISK_POLICY, key)) throw new Error(`Unknown risk policy field: ${key}`);
    if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) throw new Error(`${key} must be a finite number`);
  }
  const policy = { ...DEFAULT_RISK_POLICY, ...input };
  for (const name of ['per_trade_risk_fraction', 'daily_loss_fraction', 'emergency_stop_fraction']) {
    const value = number(policy[name], name);
    if (value <= 0 || value > 1) throw new Error(`${name} must be between zero and one`);
    policy[name] = value;
  }
  policy.absolute_daily_loss = number(policy.absolute_daily_loss, 'Daily loss cap');
  policy.execution_cushion = number(policy.execution_cushion, 'Execution cushion');
  policy.opening_premium_ceiling = number(policy.opening_premium_ceiling, 'Opening premium ceiling');
  if(policy.emergency_stop_fraction!==0.25)throw new Error('Reserved stop fraction must match the 25% broker stop');
  if (policy.absolute_daily_loss <= 0 || policy.absolute_daily_loss > 250 || policy.execution_cushion < 1 ||
      policy.opening_premium_ceiling <= 0 || policy.opening_premium_ceiling > 500) throw new Error('Risk limits or cushion are invalid');
  return policy;
}
export function brokerDailyRealized(pnl) {
  if (!pnl || !Array.isArray(pnl.data_points)) throw new Error('Today’s realized P&L is unavailable');
  const total = number(pnl.total_returns, 'Today’s realized P&L total');
  const points = pnl.data_points;
  if (!points.length) {
    if (total !== 0) throw new Error('Realized P&L totals disagree with empty history');
    return { realized_pnl: 0, number_of_trades: 0 };
  }
  let count = 0;
  let sum = 0;
  for (const point of points) {
    if (!Number.isInteger(point.number_of_trades) || point.number_of_trades < 0) throw new Error('Realized trade count unavailable');
    count += point.number_of_trades;
    // Null can represent lots with no cost basis. It is never a safe loss total.
    sum += number(point.realized_gain, 'Today’s realized P&L bucket');
  }
  if (Math.abs(sum - total) > 0.02) throw new Error('Realized P&L bucket and total disagree');
  return { realized_pnl: total, number_of_trades: count };
}
export function reserveRisk({ portfolio, premium, brokerRealized, localRealized, policy: input }) {
  const policy = riskPolicy(input);
  const equity = number(portfolio?.total_value, 'Account value');
  const buyingPower = number(portfolio?.buying_power?.buying_power, 'Buying power');
  const unleveraged = number(portfolio?.buying_power?.unleveraged_buying_power, 'Unleveraged buying power');
  const entry = number(premium, 'Entry premium');
  if (equity <= 0 || entry <= 0) throw new Error('Account value or premium is invalid');
  // Broker buying power includes eligible sale proceeds; raw cash is not an order gate.
  const spendable = Math.min(buyingPower, unleveraged);
  if (entry * 100 + policy.execution_cushion > Math.min(policy.opening_premium_ceiling + policy.execution_cushion, spendable)) {
    throw new Error('Contract exceeds premium or unleveraged buying-power limit');
  }
  let realized = number(brokerRealized?.realized_pnl, 'Broker daily P&L');
  if (localRealized) {
    const local = number(localRealized.realized_pnl, 'Local daily P&L');
    if (!['broker_reported', 'net_after_fees', 'fill_premiums_gross', 'broker_position_cost_unknown_fees', 'mixed_known'].includes(localRealized.pnl_basis)) {
      throw new Error('Local realized P&L basis is unknown');
    }
    // If the local journal contains only some historical trades, use the more
    // conservative loss rather than pretending its history is complete.
    realized = Math.min(realized, local);
  }
  const dailyLimit = Math.min(policy.absolute_daily_loss, equity * policy.daily_loss_fraction);
  const remainingDailyRisk = Math.max(0, dailyLimit - Math.max(0, -realized));
  const perTradeLimit = equity * policy.per_trade_risk_fraction;
  const plannedRisk = entry * 100 * policy.emergency_stop_fraction + policy.execution_cushion;
  if (plannedRisk > perTradeLimit + 1e-8) throw new Error('Planned stop loss exceeds the account-relative trade risk limit');
  if (plannedRisk > remainingDailyRisk + 1e-8) throw new Error('Planned stop loss exceeds the remaining daily loss budget');
  return { equity, spendable, planned_risk: plannedRisk, per_trade_limit: perTradeLimit,
    daily_limit: dailyLimit, remaining_daily_risk: remainingDailyRisk, realized_pnl: realized };
}
