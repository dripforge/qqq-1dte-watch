export function matchingClosingFill(order, arm, openedAt) {
  if (!order || order.state !== 'filled' || Number(order.processed_quantity) !== 1 ||
      !order.legs?.some(l => l?.option_id === arm.option_id && l.side === 'sell' && l.position_effect === 'close')) return null;
  const opened = Date.parse(openedAt ?? '');
  const closed = Date.parse(order.last_transaction_at ?? order.updated_at ?? order.created_at ?? '');
  if (!Number.isFinite(opened) || !Number.isFinite(closed) || closed < opened) return null;
  const leg = order.legs.find(l => l?.option_id === arm.option_id && l.side === 'sell' && l.position_effect === 'close');
  const executions = (leg.executions ?? []).filter(Boolean);
  const premium = executions.length
    ? executions.reduce((sum, e) => sum + Number(e.price) * Number(e.quantity) * 100, 0)
    : order.processed_premium == null ? NaN : Number(order.processed_premium);
  if (!Number.isFinite(premium) || premium < 0) return null;
  return { order_id: order.id, closed_at: new Date(closed).toISOString(),
    exit_premium_total: premium, gross_realized_pnl: premium - arm.entry_premium * 100,
    executions, fees: null };
}
