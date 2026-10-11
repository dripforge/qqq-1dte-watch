import { completedBars, validateSetupStructure } from './setup-policy.mjs';
import { bufferedInvalidationBoundary } from './invalidation.mjs';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SETUP_REVIEW_VERSION = '1.0.0';
const time = bar => Date.parse(bar.begins_at);
const end = bar => new Date(time(bar) + 300000).toISOString();

// Local evidence only. This module cannot authorize entries or modify a stop.
// A previous candle close is a possible breakout reference, not automatically
// resistance/support. Keep it distinct from a confirmed reversal extreme.
export function reviewSetupRoom({ candidate, oneMinuteBars, fiveMinuteBars,
  qqqPrice, now = new Date() } = {}) {
  const result = { version: 1, review_version: SETUP_REVIEW_VERSION,
    observed_at: now.toISOString(), status: 'unavailable', reason: null,
    entry_eligibility: 'not_evaluated', live_filter: false,
    minimum_room_risk_ratio: null, stop_policy_changed: false };
  try {
    if (!Number.isFinite(qqqPrice) || qqqPrice <= 0) throw Error('QQQ price unavailable');
    const direction = candidate?.direction;
    if (!['call', 'put'].includes(direction)) throw Error('Setup direction unavailable');
    const setup = validateSetupStructure(candidate, { direction, fiveMinuteBars, now });
    const count = Math.min(24, fiveMinuteBars.filter(b => b && time(b) + 300000 <= now.getTime() - 1000).length);
    const five = completedBars(fiveMinuteBars, 300000, now, { count, maxAgeMs: 330000 });
    const sign = direction === 'call' ? 1 : -1;
    if (sign * (qqqPrice - setup.level) <= 0) throw Error('Current QQQ is back across the setup reference');
    const boundary = bufferedInvalidationBoundary(oneMinuteBars, direction, now);
    const distance = sign * (qqqPrice - boundary.boundary);
    if (distance <= 0) throw Error('Buffered invalidation is not adverse to current QQQ');
    const key = direction === 'call' ? 'high_price' : 'low_price';
    const barriers = [];
    for (let i = 1; i < five.length - 1; i++) {
      const [left, middle, right] = five.slice(i - 1, i + 2);
      const value = Number(middle[key]);
      // At least one strict comparison avoids fabricating swings on flat bars.
      if (sign * (value - Number(left[key])) >= 0 && sign * (value - Number(right[key])) >= 0 &&
          (sign * (value - Number(left[key])) > 0 || sign * (value - Number(right[key])) > 0)) {
        barriers.push({ price: value, kind: direction === 'call' ? 'confirmed_5m_swing_high' : 'confirmed_5m_swing_low',
          bar_at: middle.begins_at, known_at: end(right) });
      }
    }
    // A level is not considered an unbroken barrier if a subsequent completed
    // five-minute close crossed it. A later newly confirmed swing can restore it.
    const active = barriers.filter(item => sign * (item.price - qqqPrice) > 0 &&
      !five.some(bar => time(bar) + 300000 > Date.parse(item.known_at) &&
        sign * (Number(bar.close_price) - item.price) > 0))
      .sort((a, b) => sign * (a.price - b.price));
    const obstacle = active[0] ?? null;
    const room = obstacle ? sign * (obstacle.price - qqqPrice) : null;
    const minor = five.slice(-3).flatMap(bar => [key, 'close_price'].map(field => ({
      price: Number(bar[field]), kind: `recent_5m_${field.replace('_price', '')}`,
      bar_at: bar.begins_at, known_at: end(bar), automatic_veto: false,
    }))).filter(item => sign * (item.price - qqqPrice) > 0 &&
      !active.some(level => Math.abs(level.price - item.price) < 1e-8))
      .sort((a, b) => sign * (a.price - b.price)).slice(0, 4);
    const confirm = five.find(bar => bar.begins_at === setup.confirm_bar_at);
    const shadowLevel = direction === 'call'
      ? Math.min(setup.level, Number(confirm.low_price)) - boundary.buffer
      : Math.max(setup.level, Number(confirm.high_price)) + boundary.buffer;
    const shadowDistance = sign * (qqqPrice - shadowLevel);
    return { ...result, status: 'reviewed', direction, setup_level: setup.level,
      break_bar_at: setup.break_bar_at, confirm_bar_at: setup.confirm_bar_at,
      qqq_price: qqqPrice, current_invalidation: boundary.boundary,
      invalidation_swing: boundary.swing, invalidation_buffer: boundary.buffer,
      distance_to_invalidation: distance, next_confirmed_obstacle: obstacle,
      room_to_obstacle: room, room_risk_ratio: room === null ? null : room / distance,
      minor_levels: minor, coverage: { from: five[0].begins_at, through: end(five.at(-1)), bars: five.length },
      interpretation: 'Evidence for discretionary review, not an entry gate. No obstacle in this window means unknown room, not unlimited upside/downside. External/session levels need separate timestamped evidence. There is no configured minimum room/risk ratio.',
      setup_stop_shadow: { enabled: false, research_only: true,
        method: 'beyond_confirmed_5m_retest_or_hold_and_reference_with_existing_buffer',
        confirmation_known_at: end(confirm), level: shadowLevel, distance: shadowDistance,
        tighter: shadowDistance > 0 && shadowDistance < distance - 1e-8,
        room_risk_ratio: room !== null && shadowDistance > 0 ? room / shadowDistance : null,
        execution_eligible: false, reason: 'Comparison only; the live ten-minute buffered invalidation remains required.' } };
  } catch (error) {
    return { ...result, reason: String(error.message).slice(0, 250) };
  }
}

export function reviewFreshSnapshot(input, now = new Date()) {
  if (input?.version !== 1) throw Error('Review snapshot version is invalid');
  const at = Date.parse(input.qqq_quote?.last_trade_at ?? '');
  if (!Number.isFinite(at) || now.getTime() - at > 10000 || at - now.getTime() > 5000) {
    throw Error('Review requires a fresh QQQ quote');
  }
  return reviewSetupRoom({ candidate: input.candidate, oneMinuteBars: input.one_minute_bars,
    fiveMinuteBars: input.five_minute_bars, qqqPrice: input.qqq_quote.price, now });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || statSync(process.argv[2]).size > 256000) throw Error('Use setup-review.mjs SNAPSHOT_JSON (maximum 256KB)');
    const review = reviewFreshSnapshot(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify(review) + '\n');
    if (review.status !== 'reviewed') process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'unavailable', reason: String(error.message).slice(0, 250),
      entry_eligibility: 'not_evaluated', stop_policy_changed: false }) + '\n');
    process.exitCode = 1;
  }
}
