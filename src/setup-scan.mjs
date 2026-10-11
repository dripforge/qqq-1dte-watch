import { completedBars, validateSetup, validateSetupStructure } from './setup-policy.mjs';
import { requireFreshReentry } from './reentry.mjs';
import { reviewSetupRoom } from './setup-review.mjs';

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = value => ET.format(new Date(value));
function references(input) {
  if (!Array.isArray(input) || input.length > 4) throw new Error('At most four explicit causal references are allowed');
  return input.map(value => {
    if (!value || !['call', 'put'].includes(value.direction) || typeof value.level !== 'number' ||
        !Number.isFinite(value.level) || value.level <= 0 || typeof value.established_at !== 'string' ||
        !Number.isFinite(Date.parse(value.established_at)) || typeof value.rationale !== 'string' ||
        value.rationale.trim().length < 8 || value.rationale.length > 1500) throw new Error('Explicit reference evidence is invalid');
    return { ...value, kind: 'explicit_plan', priority: 0 };
  });
}

export function scanSetups({ oneMinuteBars, fiveMinuteBars, now = new Date(), previous = null,
  lastExit = null, explicitReferences = [], qqqPrice = null } = {}) {
  try {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Setup scan time is invalid');
    const explicit = references(explicitReferences), today = day(now);
    const rawFive = Array.isArray(fiveMinuteBars) ? fiveMinuteBars.filter(b => b &&
      Number.isFinite(Date.parse(b.begins_at)) && day(b.begins_at) === today) : null;
    const count = Math.min(24, rawFive?.filter(b => Date.parse(b.begins_at) + 300000 <= now.getTime() - 1000).length ?? 0);
    const five = completedBars(rawFive, 300000, now, { count: Math.max(1, count), maxAgeMs: 330000 });
    if (five.length < 3) throw new Error('At least three completed current-session five-minute bars are required');
    let minute = null, minuteError = null;
    try { minute = completedBars(oneMinuteBars, 60000, now); }
    catch (error) { minuteError = error.message; }
    const latestMinute = minute?.at(-1) ?? (Array.isArray(oneMinuteBars) ? oneMinuteBars.filter(b => b &&
      Number.isFinite(Date.parse(b.begins_at)) && Date.parse(b.begins_at) + 60000 <= now.getTime() - 1000)
      .sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at)).at(-1) : null);
    const records = [], seen = new Set();
    // Four recent completed breaks, three already-known predecessor levels,
    // and at most four explicit levels keep discovery deterministic and small.
    for (let index = five.length - 2; index >= Math.max(1, five.length - 5); index--) {
      const before = five[index - 1], broken = five[index];
      const knownAt = new Date(Date.parse(before.begins_at) + 300000).toISOString();
      const automatic = ['high_price', 'low_price', 'close_price'].map(key => ({ level: Number(before[key]),
        kind: `prior_5m_${key.replace('_price', '')}`, priority: key === 'close_price' ? 2 : 1,
        established_at: knownAt, rationale: `Prior completed five-minute ${key.replace('_price', '')} existed before the break.` }));
      for (const reference of [...explicit, ...automatic]) {
        if (Date.parse(reference.established_at) > Date.parse(broken.begins_at)) continue;
        const priorClose = Number(before.close_price), breakClose = Number(broken.close_price), level = reference.level;
        const direction = priorClose <= level && breakClose > level ? 'call' : priorClose >= level && breakClose < level ? 'put' : null;
        if (!direction || reference.direction && reference.direction !== direction) continue;
        const key = `${direction}|${broken.begins_at}|${level}`;
        if (seen.has(key)) continue;
        for (let confirm = five.length - 1; confirm > index; confirm--) {
          const bar = five[confirm], retouched = direction === 'call' ? Number(bar.low_price) <= level : Number(bar.high_price) >= level;
          const candidate = { version: 1, direction, pattern: retouched ? direction === 'call' ? 'break_retest' : 'break_failed_reclaim' : 'break_hold',
            break_bar_at: broken.begins_at, confirm_bar_at: bar.begins_at,
            confirmation_1m_at: latestMinute?.begins_at ?? null, level,
            rationale: `${reference.rationale} Completed break followed by a later completed ${retouched ? 'retest' : 'hold'}.` };
          let structure;
          try { structure = validateSetupStructure(candidate, { direction, fiveMinuteBars: five, now }); }
          catch { continue; }
          let qualified = false, reason = minuteError, oneMinuteQualified = null, reentryQualified = null;
          try {
            validateSetup(candidate, { direction, fiveMinuteBars: five, oneMinuteBars, now, previous });
            oneMinuteQualified = true;
            requireFreshReentry(lastExit, candidate, now);
            reentryQualified = true;
            if (typeof qqqPrice !== 'number' || !Number.isFinite(qqqPrice) || qqqPrice <= 0) throw new Error('Fresh current QQQ price unavailable to scanner');
            if (direction === 'call' ? qqqPrice <= level : qqqPrice >= level) throw new Error('Current QQQ is back across the setup reference');
            qualified = true; reason = 'Completed structure and latest one-minute follow-through qualify; fresh entry gate still required';
          } catch (error) {
            reason = error.message;
            if (oneMinuteQualified === null && /one-minute|follow-through|bars.*required|gap|interpolated|stale/.test(reason)) oneMinuteQualified = false;
            if (oneMinuteQualified && /[Rr]e-entry|exit context/.test(reason)) reentryQualified = false;
          }
          records.push({ candidate: structure, structural_qualified: true, qualified, reason,
            room_review: reviewSetupRoom({ candidate: structure, oneMinuteBars, fiveMinuteBars: five, qqqPrice, now }),
            latest_one_minute_qualified: oneMinuteQualified, reentry_qualified: reentryQualified,
            reference: { kind: reference.kind, established_at: reference.established_at },
            requires_fresh_entry_gate: true, priority: reference.priority });
          seen.add(key); break;
        }
      }
    }
    records.sort((a, b) => Number(b.qualified) - Number(a.qualified) || a.priority - b.priority ||
      Date.parse(b.candidate.break_bar_at) - Date.parse(a.candidate.break_bar_at) ||
      Date.parse(b.candidate.confirm_bar_at) - Date.parse(a.candidate.confirm_bar_at) || a.candidate.level - b.candidate.level);
    return { version: 1, observed_at: now.toISOString(), status: 'complete', candidates: records.slice(0, 4).map(({ priority, ...row }) => row),
      examined_breaks: Math.min(4, five.length - 2), suppressed_candidate_count: Math.max(0, records.length - 4),
      reason: records.length ? 'Causal completed setup candidates found' : 'No recent causal completed break and later confirmation found' };
  } catch (error) {
    return { version: 1, observed_at: now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : null,
      status: 'data_unavailable', candidates: [], reason: String(error.message).slice(0, 250) };
  }
}
