import { optionResearchFields } from './option-research-fields.mjs';
import { recordResearchEvent } from './research-record.mjs';
import { validateResearchEvent } from './research-policy.mjs';

// These hooks consume evidence the trading gate already fetched. They have no
// broker client and cannot place orders or delay execution with network work.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function contract(option, metadata) {
  const strike = numeric(metadata?.strike_price);
  if (!uuid.test(option?.instrument_id ?? '') || metadata?.id !== option.instrument_id ||
      typeof metadata.expiration_date !== 'string' || !strike || strike <= 0) return null;
  return { instrument_id: option.instrument_id, expiration: metadata.expiration_date, strike,
    bid: numeric(option.bid_price), ask: numeric(option.ask_price), bid_size: numeric(option.bid_size),
    ask_size: numeric(option.ask_size), updated_at: option.updated_at ?? null,
    delta: numeric(option.delta), theta: numeric(option.theta), ...optionResearchFields(option) };
}
function completed(values, interval, now) {
  if (!Array.isArray(values)) return null;
  const keys = ['begins_at', 'open_price', 'high_price', 'low_price', 'close_price', 'interpolated', 'session'];
  return values.filter(b => b && Number.isFinite(Date.parse(b.begins_at)) &&
    Date.parse(b.begins_at) + interval <= now - 1000)
    .sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at)).slice(-24)
    .map(b => { const result = Object.fromEntries(keys.filter(k => b[k] !== undefined).map(k => [k, b[k]]));
      if (b.volume !== undefined && b.volume !== null) result.volume = numeric(b.volume);
      return result; });
}
function common({ now, direction, tradeId, qqq, option, instrument, alternatives }) {
  return { version: 1, event_kind: 'setup', observed_at: new Date(now).toISOString(),
    source: 'robinhood_trading_mcp', case_id: null, direction, trade_id: tradeId ?? null,
    qqq_quote: { price: numeric(qqq?.last_trade_price), last_trade_at: qqq?.venue_last_trade_time ?? null },
    selected_contract: contract(option, instrument),
    alternatives: alternatives.map(value => contract(value.option, value.instrument)).filter(Boolean).slice(0, 4) };
}
export function buildEntryResearchEvent({ now = Date.now(), direction, qqqInvalidation, qqq, option,
  instrument, setup, oneMinuteBars, fiveMinuteBars, tradeId = null, alternatives = [] } = {}) {
  try {
    const input = { ...common({ now, direction, tradeId, qqq, option, instrument, alternatives }),
      setup: { reference_level: numeric(setup?.level), qqq_invalidation: numeric(qqqInvalidation),
        next_obstacle: numeric(setup?.next_obstacle), break_bar_at: setup?.break_bar_at,
        confirm_bar_at: setup?.confirm_bar_at, confirmation_1m_at: setup?.confirmation_1m_at,
        live_qualified: true },
      one_minute_bars: completed(oneMinuteBars, 60000, now), five_minute_bars: completed(fiveMinuteBars, 300000, now) };
    validateResearchEvent(input, now);
    return input;
  } catch { return null; }
}
export function buildProfitResearchEvent({ now = Date.now(), arm, qqq, option,
  oneMinuteBars, fiveMinuteBars = null } = {}) {
  try {
    const instrument = { id: arm?.option_id, expiration_date: arm?.expiration_date, strike_price: arm?.contract_strike };
    const input = { ...common({ now, direction: arm?.option_type, tradeId: arm?.trade_id, qqq,
      option, instrument, alternatives: [] }), event_kind: 'trail', opened_at: arm?.opened_at,
      one_minute_bars: completed(oneMinuteBars, 60000, now), five_minute_bars: completed(fiveMinuteBars, 300000, now) };
    if (!uuid.test(arm?.trade_id ?? '')) return null;
    validateResearchEvent(input, now);
    return input;
  } catch { return null; }
}
export function safeRecordResearchEvent(input, options = {}) {
  try {
    if (!input) return { status: 'research_skipped', reason: 'Verified research evidence unavailable', execution_unaffected: true };
    return recordResearchEvent(input, options);
  } catch (error) {
    return { status: 'research_skipped', reason: String(error.message).slice(0, 250), execution_unaffected: true };
  }
}
