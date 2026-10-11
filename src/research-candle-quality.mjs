// Research comparisons may infer that a bar contains real trades from positive
// broker volume when Robinhood omits its interpolation flag. This inference is
// deliberately separate from all live entry, stop and risk validation.
export const RESEARCH_CANDLE_NOTICE = 'A missing interpolation flag remains unknown. Positive broker-reported volume supports a research-only inference of traded activity; it is not an explicit broker non-interpolation flag.';

const PRICE_KEYS = ['open_price', 'high_price', 'low_price', 'close_price'];
function value(number) {
  if (number === null || number === undefined || number === '') return null;
  const result = Number(number);
  return Number.isFinite(result) ? result : null;
}
function timestamp(input) {
  return input instanceof Date ? input.getTime() : typeof input === 'number' ? input : Date.parse(input ?? '');
}

export function researchCandleQuality(bar, { intervalMs, observedAt } = {}) {
  const observed = timestamp(observedAt), began = Date.parse(bar?.begins_at ?? '');
  const result = { usable: false, verification_basis: null, reason: null, research_only: true };
  const reject = reason => ({ ...result, reason });
  if (!Number.isFinite(observed) || !Number.isFinite(intervalMs) || intervalMs <= 0 ||
      !Number.isFinite(began) || began % intervalMs !== 0) return reject('invalid_bar_time_or_interval');
  if (began + intervalMs > observed - 1000) return reject('bar_not_completed_at_observation');
  const prices = Object.fromEntries(PRICE_KEYS.map(key => [key, value(bar?.[key])]));
  if (PRICE_KEYS.some(key => prices[key] === null || prices[key] <= 0) ||
      prices.high_price < Math.max(prices.open_price, prices.close_price) ||
      prices.low_price > Math.min(prices.open_price, prices.close_price)) return reject('invalid_ohlc');
  if (bar.session !== 'reg') return reject('regular_session_unverified');
  if (bar.interpolated === true) return reject('explicit_interpolated_bar');
  if (bar.interpolated !== null && bar.interpolated !== undefined && bar.interpolated !== false) return reject('invalid_interpolation_flag');
  if (bar.volume !== null && bar.volume !== undefined &&
      (typeof bar.volume !== 'number' || !Number.isFinite(bar.volume) || bar.volume < 0)) return reject('invalid_broker_volume');
  if (bar.interpolated === false) return { ...result, usable: true,
    verification_basis: 'explicit_broker_non_interpolated', reason: 'explicit_broker_flag' };
  if (bar.volume === null || bar.volume === undefined) return reject('missing_volume_and_interpolation_flag');
  if (bar.volume === 0) return reject('zero_volume_with_missing_interpolation_flag');
  return { ...result, usable: true, verification_basis: 'inferred_positive_broker_volume',
    reason: 'positive_broker_volume_with_missing_interpolation_flag' };
}

export function assessResearchBars(bars, { intervalMs, observedAt, minimum = 1 } = {}) {
  const observed = timestamp(observedAt);
  const available = Array.isArray(bars) ? bars : [];
  const quality = available.map(bar => researchCandleQuality(bar, { intervalMs, observedAt: observed }));
  const explicit = quality.filter(bar => bar.usable && bar.verification_basis === 'explicit_broker_non_interpolated').length;
  const inferred = quality.filter(bar => bar.usable && bar.verification_basis === 'inferred_positive_broker_volume').length;
  const latest = Date.parse(available.at(-1)?.begins_at ?? '') + intervalMs;
  let reason = null;
  if (!Number.isInteger(minimum) || minimum < 1 || !Number.isFinite(observed) ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) reason = 'invalid_comparison_parameters';
  else if (available.length < minimum) reason = 'insufficient_completed_bars';
  else if (quality.some(bar => !bar.usable)) reason = quality.find(bar => !bar.usable).reason;
  else if (available.some((bar, index) => index > 0 && Date.parse(bar.begins_at) - Date.parse(available[index - 1].begins_at) !== intervalMs)) reason = 'noncontiguous_or_unordered_bars';
  else if (observed - latest > intervalMs + 30000) reason = 'latest_completed_bar_stale';
  return { usable: reason === null, reason, source: 'robinhood_trading_mcp', interval_ms: intervalMs,
    required_bars: minimum, observed_bars: available.length, explicit_non_interpolated_bars: explicit,
    inferred_positive_volume_bars: inferred, unusable_bars: quality.filter(bar => !bar.usable).length,
    verification_basis: explicit && inferred ? 'mixed_explicit_flags_and_positive_volume_inference' :
      inferred ? 'inferred_positive_broker_volume' : explicit ? 'explicit_broker_non_interpolated' : 'unknown',
    latest_completed_at: Number.isFinite(latest) ? new Date(latest).toISOString() : null,
    research_only: true, inference_notice: inferred ? RESEARCH_CANDLE_NOTICE : null };
}
