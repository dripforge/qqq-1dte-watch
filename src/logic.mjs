import { marketSession, expirationStatus } from './session.mjs';
export { etParts } from './session.mjs';

export function validateArm(arm) {
  if (!arm || typeof arm !== 'object') throw new Error('No armed position');
  if (!/^[0-9a-f-]{36}$/i.test(arm.option_id ?? '')) throw new Error('Invalid option ID');
  if (!['call', 'put'].includes(arm.option_type)) throw new Error('Invalid option type');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arm.expiration_date ?? '')) throw new Error('Invalid expiration');
  const level = Number(arm.qqq_invalidation);
  const premium = Number(arm.entry_premium);
  if (!Number.isFinite(level) || level <= 0) throw new Error('Invalid QQQ invalidation');
  if (!Number.isFinite(premium) || premium <= 0 || premium * 100 > 500) throw new Error('Invalid entry premium');
  if (arm.quantity !== 1) throw new Error('Only one contract is allowed');
  return { ...arm, qqq_invalidation: level, entry_premium: premium };
}

export function evaluate(armInput, position, quote, now = new Date()) {
  const arm = validateArm(armInput);
  if (!position || position.option_id !== arm.option_id || position.type !== 'long' ||
      Number(position.quantity) !== 1 || position.chain_symbol !== 'QQQ' ||
      position.expiration_date !== arm.expiration_date) {
    throw new Error('Armed contract does not match exactly one open long QQQ position');
  }
  const session = marketSession(now);
  const expiration = expirationStatus(arm.expiration_date, now);
  if (!expiration.verified) throw new Error(`Market calendar unavailable: ${expiration.reason}`);
  if (expiration.window_missed) throw new Error('Expiration-day exit window missed');
  if (expiration.cutoff_reached) {
    return { exit: true, reason: 'expiration_cutoff', observed_at: now.toISOString() };
  }
  if (!session.is_open) {
    return { exit: false, reason: 'market_closed' };
  }
  const q = quote?.results?.find(x => x?.quote?.symbol === 'QQQ')?.quote;
  if (!q || q.state !== 'active' || q.has_traded !== true) throw new Error('QQQ quote unavailable');
  const rawPrice=q.last_trade_price;
  if(!['number','string'].includes(typeof rawPrice)||typeof rawPrice==='string'&&!rawPrice.trim())throw new Error('QQQ quote invalid');
  const price = Number(rawPrice);
  const tradedAt = Date.parse(q.venue_last_trade_time);
  if (!Number.isFinite(price) || price<=0 || !Number.isFinite(tradedAt)) throw new Error('QQQ quote invalid');
  const ageMs = now.getTime() - tradedAt;
  if (ageMs < -5000 || ageMs > 10000) throw new Error('QQQ quote stale');
  const crossed = arm.option_type === 'call'
    ? price <= arm.qqq_invalidation
    : price >= arm.qqq_invalidation;
  return {
    exit: crossed, reason: crossed ? 'qqq_invalidation' : 'holding',
    qqq_price: price, observed_at: q.venue_last_trade_time, quote_age_ms: ageMs,
  };
}
