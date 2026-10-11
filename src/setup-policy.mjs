import { createHash } from 'node:crypto';

export function completedBars(bars, intervalMs, now = new Date(), { count = 10, maxAgeMs = intervalMs + 30000 } = {}) {
  if (!Array.isArray(bars)) throw new Error('Completed bars unavailable');
  if (!Number.isInteger(count) || count < 1) throw new Error('Completed bar count is invalid');
  const parsed = bars.filter(b => b && Number.isFinite(Date.parse(b.begins_at ?? '')) &&
    Date.parse(b.begins_at) + intervalMs <= now.getTime() - 1000)
    .sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at));
  const recent = parsed.slice(-count);
  if (recent.length !== count) throw new Error(`${count} completed bars are required`);
  for (let i = 0; i < recent.length; i++) {
    const bar = recent[i];
    const prices = ['open_price', 'high_price', 'low_price', 'close_price'].map(k => {
      if (bar[k] === null || bar[k] === undefined || bar[k] === '') throw new Error('Bar prices unavailable');
      return Number(bar[k]);
    });
    const [open, high, low, close] = prices;
    if (bar.interpolated === true || prices.some(p => !Number.isFinite(p) || p <= 0) ||
        high < Math.max(open, close) || low > Math.min(open, close) || low > high ||
        (bar.session && bar.session !== 'reg')) throw new Error('Completed bar is invalid, interpolated, or outside regular hours');
    if (i && Date.parse(bar.begins_at) - Date.parse(recent[i - 1].begins_at) !== intervalMs) {
      throw new Error('Completed bars have a gap or duplicate timestamp');
    }
  }
  const end = Date.parse(recent.at(-1).begins_at) + intervalMs;
  if (now.getTime() - end > maxAgeMs) throw new Error('Completed bars are stale');
  return recent;
}

export function validateSetupStructure(candidate, { direction, fiveMinuteBars, now = new Date(), previous }) {
  if (!candidate || candidate.version !== 1 || candidate.direction !== direction) throw new Error('Structured setup evidence required');
  const patterns = direction === 'call' ? ['break_hold', 'break_retest'] : ['break_hold', 'break_failed_reclaim'];
  if (!patterns.includes(candidate.pattern)) throw new Error('Setup pattern does not match direction');
  if (typeof candidate.rationale !== 'string' || candidate.rationale.trim().length < 8 || candidate.rationale.length > 2000) {
    throw new Error('Setup rationale is required');
  }
  const level = Number(candidate.level);
  if (candidate.level === null || candidate.level === undefined || !Number.isFinite(level) || level <= 0) throw new Error('Setup reference level is invalid');
  const five = completedBars(fiveMinuteBars, 300000, now, { count: Math.min(24, fiveMinuteBars?.filter(b =>
    b && Date.parse(b.begins_at) + 300000 <= now.getTime() - 1000).length ?? 0), maxAgeMs: 330000 });
  if (five.length < 3) throw new Error('At least three completed five-minute bars are required');
  const breakIndex = five.findIndex(b => b.begins_at === candidate.break_bar_at);
  const confirmIndex = five.findIndex(b => b.begins_at === candidate.confirm_bar_at);
  if (breakIndex < 1 || confirmIndex <= breakIndex) throw new Error('Setup bars are missing or out of order');
  const brokenAt = Date.parse(candidate.break_bar_at);
  const confirmedAt = Date.parse(candidate.confirm_bar_at) + 300000;
  if (now.getTime() - confirmedAt > 600000) throw new Error('Setup confirmation is stale');
  const sign = direction === 'call' ? 1 : -1;
  const before = Number(five[breakIndex - 1].close_price);
  const broken = Number(five[breakIndex].close_price);
  const confirmed = Number(five[confirmIndex].close_price);
  if (sign * (before - level) > 0 || sign * (broken - level) <= 0 || sign * (confirmed - level) <= 0) {
    throw new Error('Completed five-minute bars do not show the claimed break and confirmation');
  }
  if (candidate.pattern === 'break_retest' && Number(five[confirmIndex].low_price) > level) throw new Error('Confirmed retest did not reach support');
  if (candidate.pattern === 'break_failed_reclaim' && Number(five[confirmIndex].high_price) < level) throw new Error('Failed reclaim did not reach resistance');
  if (five.slice(breakIndex + 1, confirmIndex + 1).some(b => sign * (Number(b.close_price) - level) <= 0)) {
    throw new Error('The claimed level did not hold on completed five-minute bars');
  }
  if(five.slice(confirmIndex+1).some(b=>sign*(Number(b.close_price)-level)<=0))throw new Error('Completed bars reversed after the claimed confirmation');
  const setupId = createHash('sha256').update([direction, candidate.pattern, candidate.break_bar_at, level.toFixed(4)].join('|')).digest('hex');
  if (previous && (previous.setup_id === setupId || !Number.isFinite(Date.parse(previous.break_bar_at ?? '')) ||
      brokenAt <= Date.parse(previous.break_bar_at))) throw new Error('A new completed break is required after the prior entry attempt');
  return { ...candidate, level, setup_id: setupId };
}

export function validateSetup(candidate, { direction, fiveMinuteBars, oneMinuteBars, now = new Date(), previous }) {
  const setup = validateSetupStructure(candidate, { direction, fiveMinuteBars, now, previous });
  const minute = completedBars(oneMinuteBars, 60000, now);
  const oneIndex = minute.findIndex(b => b.begins_at === candidate.confirmation_1m_at);
  if (oneIndex < 1) throw new Error('Setup bars are missing or out of order');
  if (oneIndex !== minute.length - 1) throw new Error('Setup must use the latest completed one-minute follow-through');
  const oneEnd = Date.parse(candidate.confirmation_1m_at) + 60000;
  if (now.getTime() - oneEnd > 120000 || oneEnd < Date.parse(candidate.confirm_bar_at) + 300000) {
    throw new Error('Setup confirmation is stale or precedes the five-minute confirmation');
  }
  const sign = direction === 'call' ? 1 : -1, one = minute[oneIndex], level = setup.level;
  if (sign * (Number(one.close_price) - Number(one.open_price)) <= 0 ||
      sign * (Number(one.close_price) - Number(minute[oneIndex - 1].close_price)) <= 0 ||
      sign * (Number(one.close_price) - level) <= 0 ||
      sign * (Number(minute[oneIndex - 1].close_price) - level) <= 0) {
    throw new Error('Completed one-minute bars do not show directional follow-through');
  }
  return setup;
}
