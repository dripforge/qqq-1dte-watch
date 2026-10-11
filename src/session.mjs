import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ET = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function checkedDate(date) {
  const parsed = typeof date === 'string' ? new Date(`${date}T12:00:00Z`) : null;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(parsed?.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid market calendar date');
  }
  return date;
}

// Deliberately bounded to exchange-published years. No guessed holiday algorithm
// can silently treat an unsupported year as a verified open market.
const calendar = JSON.parse(readFileSync(fileURLToPath(new URL('./session-calendar.json', import.meta.url)), 'utf8'));
if (calendar.version !== 1 || !calendar.sources?.length || !calendar.years ||
    checkedDate(calendar.valid_from) > checkedDate(calendar.valid_through)) {
  throw new Error('Market calendar data is invalid');
}
for (const [year, data] of Object.entries(calendar.years)) {
  if (!Array.isArray(data.closed) || !data.early_close || typeof data.early_close !== 'object') throw new Error('Market calendar year is invalid');
  for (const date of [...data.closed, ...Object.keys(data.early_close)]) {
    if (!checkedDate(date).startsWith(`${year}-`) || date < calendar.valid_from || date > calendar.valid_through) throw new Error('Market calendar exception is invalid');
  }
  for (const [date, minute] of Object.entries(data.early_close)) {
    if (data.closed.includes(date) || !Number.isInteger(minute) || minute <= 9 * 60 + 45 || minute >= 16 * 60) throw new Error('Market early close is invalid');
  }
}

export const CALENDAR_METADATA = Object.freeze({
  version: calendar.version, verified_at: calendar.verified_at,
  valid_from: calendar.valid_from, valid_through: calendar.valid_through,
  sources: Object.freeze([...calendar.sources]),
});

export function etParts(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid market observation time');
  const parts = Object.fromEntries(ET.formatToParts(now).map(item => [item.type, item.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function sessionForDate(date) {
  checkedDate(date);
  const data = calendar.years[date.slice(0, 4)];
  if (!data || date < calendar.valid_from || date > calendar.valid_through) {
    return { date, verified: false, is_trading_day: false, reason: 'calendar_unverified',
      open_minute: null, close_minute: null, entry_start_minute: null,
      entry_cutoff_minute: null, expiration_cutoff_minute: null };
  }
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const reason = day === 0 || day === 6 ? 'weekend' : data.closed.includes(date) ? 'exchange_holiday' : 'trading_day';
  if (reason !== 'trading_day') return { date, verified: true, is_trading_day: false, reason,
    open_minute: null, close_minute: null, entry_start_minute: null,
    entry_cutoff_minute: null, expiration_cutoff_minute: null };
  const close = data.early_close[date] ?? 16 * 60;
  return { date, verified: true, is_trading_day: true, reason: close < 16 * 60 ? 'early_close' : 'regular_session',
    open_minute: 9 * 60 + 30, close_minute: close,
    entry_start_minute: 9 * 60 + 45, entry_cutoff_minute: close < 16 * 60 ? close - 60 : 15 * 60 + 58,
    expiration_cutoff_minute: close - 15 };
}

export function marketSession(now = new Date()) {
  const parts = etParts(now);
  const session = sessionForDate(parts.date);
  const is_open = session.verified && session.is_trading_day && parts.minute >= session.open_minute && parts.minute < session.close_minute;
  return { ...session, minute: parts.minute, is_open,
    can_enter: is_open && parts.minute >= session.entry_start_minute && parts.minute < session.entry_cutoff_minute,
    calendar_valid_through: calendar.valid_through };
}

export function nextTradingDate(date) {
  checkedDate(date);
  const day = new Date(`${date}T12:00:00Z`);
  for (let count = 0; count < 10; count++) {
    day.setUTCDate(day.getUTCDate() + 1);
    const next = day.toISOString().slice(0, 10);
    const session = sessionForDate(next);
    if (!session.verified) throw new Error('Next trading day is outside the verified market calendar');
    if (session.is_trading_day) return next;
  }
  throw new Error('Next trading day is unavailable');
}

export function expirationStatus(expirationDate, now = new Date()) {
  const session = marketSession(now);
  const expiration = sessionForDate(expirationDate);
  const expired = session.date > expirationDate;
  const verified = session.verified && expiration.verified && expiration.is_trading_day;
  const cutoff_reached = verified && (expired || session.date === expirationDate && session.minute >= expiration.expiration_cutoff_minute);
  const window_missed = expired || verified && session.date === expirationDate && session.minute >= expiration.close_minute;
  return { verified, expired, cutoff_reached, window_missed,
    cutoff_minute: expiration.expiration_cutoff_minute, close_minute: expiration.close_minute,
    reason: !expiration.verified || !session.verified ? 'calendar_unverified' : !expiration.is_trading_day ? 'expiration_not_trading_day' : window_missed ? 'expiration_window_missed' : cutoff_reached ? 'expiration_cutoff' : 'before_expiration_cutoff' };
}
