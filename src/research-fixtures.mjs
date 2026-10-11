export const AT = '2026-10-08T18:00:02Z';
export const ID = '11111111-1111-4111-8111-111111111111';
export const TRADE = '99999999-9999-4999-8999-999999999999';
export function iso(minute) { return new Date(Date.parse('2026-10-08T17:00:00Z') + minute * 60000).toISOString(); }
export function quote(at = AT, id = ID, extra = {}) {
  return { instrument_id: id, expiration: '2026-10-09', strike: 500, bid: 1.9, ask: 2,
    bid_size: 40, ask_size: 20, updated_at: at, delta: -0.48, theta: -0.2, ...extra };
}
export function bar(minute, open, high, low, close, extra = {}) {
  return { begins_at: iso(minute), open_price: String(open), high_price: String(high),
    low_price: String(low), close_price: String(close), volume: 1000,
    interpolated: false, session: 'reg', ...extra };
}
export function setup(at = AT, extra = {}) {
  return { version: 1, event_kind: 'setup', observed_at: at, source: 'robinhood_trading_mcp',
    case_id: null, direction: 'put', trade_id: null,
    qqq_quote: { price: 499.7, last_trade_at: at }, selected_contract: quote(at), alternatives: [],
    setup: { reference_level: 500, qqq_invalidation: 500.5, next_obstacle: 498.5,
      break_bar_at: iso(50), confirm_bar_at: iso(55), confirmation_1m_at: iso(59), live_qualified: false },
    one_minute_bars: [bar(58, 499.9, 499.95, 499.7, 499.8), bar(59, 499.8, 499.85, 499.6, 499.7)],
    five_minute_bars: [bar(45, 500.3, 500.4, 500.1, 500.2), bar(50, 500.2, 500.3, 499.7, 499.8),
      bar(55, 499.8, 499.95, 499.6, 499.7)], ...extra };
}
export function retouch(extra = {}) {
  const at = '2026-10-08T18:05:02Z';
  const original = setup(at);
  return { ...original,
    setup: { ...original.setup, confirm_bar_at: iso(60), confirmation_1m_at: iso(64), live_qualified: true },
    qqq_quote: { price: 499.5, last_trade_at: at },
    one_minute_bars: [bar(63, 499.8, 499.85, 499.6, 499.7), bar(64, 499.7, 499.75, 499.4, 499.5)],
    five_minute_bars: [...original.five_minute_bars, bar(60, 499.7, 500.1, 499.4, 499.5)], ...extra };
}
export function trail(extra = {}) {
  const lows = [499.5, 499.6, 499.7, 499.4, 499.8, 499.9, 499.8, 499.7, 499.6, 499.7];
  return { version: 1, event_kind: 'trail', observed_at: AT, source: 'robinhood_trading_mcp',
    case_id: null, direction: 'call', trade_id: TRADE, opened_at: iso(49),
    qqq_quote: { price: 500, last_trade_at: AT }, selected_contract: quote(AT, ID, { delta: 0.48 }), alternatives: [],
    one_minute_bars: lows.map((low, index) => bar(50 + index, 499.9, 500.1, low, 499.95)),
    five_minute_bars: [bar(45, 499.9, 500.1, 499.7, 499.95), bar(50, 499.9, 500.1, 499.3, 499.95),
      bar(55, 499.9, 500.1, 499.8, 499.95)], ...extra };
}
export function followup(caseId, at, extra = {}) {
  return { version: 1, event_kind: 'followup', observed_at: at, source: 'robinhood_trading_mcp',
    case_id: caseId, direction: 'put', trade_id: null, qqq_quote: { price: 499, last_trade_at: at },
    selected_contract: quote(at, ID, { bid: 2.2, ask: 2.3 }), alternatives: [],
    basis_id: 'case', horizon_minutes: 5, ...extra };
}
