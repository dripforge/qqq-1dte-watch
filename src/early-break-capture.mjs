import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectEarlyBreakSignals } from './edge-comparisons.mjs';
import { validateResearchEvent } from './research-policy.mjs';
import { safeRecordResearchEvent } from './research-hooks.mjs';
import { researchIdleReason, enqueueResearchCase } from './research-collector-policy.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { appendJournal } from './journal.mjs';
import { candidateContext } from './market-context.mjs';

function atomic(folder, name, value) {
  const path = join(folder, name), temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
function completed(input, interval, now) {
  const fields = ['begins_at', 'open_price', 'high_price', 'low_price', 'close_price', 'volume', 'session', 'interpolated'];
  return input.filter(bar => bar && Number.isFinite(Date.parse(bar.begins_at)) && Date.parse(bar.begins_at) + interval <= now - 1000)
    .sort((a, b) => Date.parse(a.begins_at) - Date.parse(b.begins_at)).slice(-24)
    .map(bar => Object.fromEntries(fields.filter(key => bar[key] !== undefined && bar[key] !== null).map(key => [key, key === 'volume' ? Number(bar[key]) : bar[key]])));
}

export function buildEarlyBreakResearchObservation({ now = Date.now(), qqq, oneMinuteBars, fiveMinuteBars, signal } = {}) {
  now = now instanceof Date ? now.getTime() : now;
  const observedAt = new Date(now).toISOString();
  const quotedAt = Date.parse(qqq?.venue_last_trade_time ?? '');
  const price = Number(qqq?.last_trade_price);
  if (qqq?.symbol !== 'QQQ' || qqq.state !== 'active' || qqq.has_traded !== true || !Number.isFinite(price) || price <= 0 ||
      !Number.isFinite(quotedAt) || now - quotedAt < -5000 || now - quotedAt > 10000) throw new Error('Actual fresh active QQQ quote is required');
  if (!signal || signal.observed_at !== observedAt || signal.live_qualified !== false || signal.pattern !== 'early_break_shadow') throw new Error('Actual research-only early break signal is required');
  const scan = detectEarlyBreakSignals({ oneMinuteBars, fiveMinuteBars, now: new Date(now), qqqPrice: price,
    explicitReferences: signal.reference_kind === 'explicit_plan' ? [{ direction: signal.direction, level: signal.reference_level,
      established_at: signal.reference_established_at, rationale: signal.rationale }] : [] });
  const verified = scan.signals.find(value => value.signal_id === signal.signal_id && value.reference_kind === signal.reference_kind &&
    value.reference_established_at === signal.reference_established_at);
  if (!verified) throw new Error('Early break no longer matches the actual causal completed snapshot');
  const input = { version: 1, event_kind: 'early_break', observed_at: observedAt, source: 'robinhood_trading_mcp',
    case_id: null, direction: signal.direction, trade_id: null,
    qqq_quote: { price, last_trade_at: qqq.venue_last_trade_time }, selected_contract: null, alternatives: [],
    early_setup: Object.fromEntries(['reference_level', 'break_bar_at', 'break_completed_at', 'latest_completed_1m_at',
      'reference_kind', 'reference_established_at', 'live_qualified'].map(key => [key, verified[key]])),
    one_minute_bars: completed(oneMinuteBars, 60000, now), five_minute_bars: completed(fiveMinuteBars, 300000, now) };
  const validated = validateResearchEvent(input, now);
  return { input, case_id: validated.case_id, signal_id: verified.signal_id, entry_gate: verified.entry_gate,
    candle_quality: verified.candle_quality, signal_capture_delay_seconds: verified.signal_capture_delay_seconds };
}

// Local recording only. The caller provides the market snapshot after its core
// trading decisions; no broker connection or order function is available here.
export function captureEarlyBreakObservations({ folder, now = Date.now(), qqq, oneMinuteBars, fiveMinuteBars, signals = [], market_context = null, marketContext = market_context } = {}) {
  now = now instanceof Date ? now.getTime() : now;
  const result = { version: 1, at: new Date(now).toISOString(), status: 'idle', captured: 0, deduplicated: 0,
    queued: 0, failures: [], cases: [], execution_unaffected: true };
  let release, state;
  const persist = () => {
    try {
      if (state) {
        state.signals = Object.fromEntries(Object.entries(state.signals).sort(([, a], [, b]) => Date.parse(b.first_observed_at) - Date.parse(a.first_observed_at)).slice(0, 200));
        atomic(folder, 'early-break-capture-state.json', state);
      }
      atomic(folder, 'early-break-capture-status.json', result);
    } catch { result.status = 'error'; result.failures.push('Early shadow capture status could not be persisted'); }
    return result;
  };
  try {
    const idle = researchIdleReason(folder, { now });
    if (idle) { result.status = 'skipped'; result.reason = idle; return persist(); }
    if (!Array.isArray(signals) || signals.length > 4) throw new Error('Early signal batch exceeds its bound');
    release = acquireProcessLock(join(folder, 'early-break-capture.lock'));
    const path = join(folder, 'early-break-capture-state.json');
    if (existsSync(path)) {
      if (statSync(path).size > 1024 * 1024) throw new Error('Early capture state exceeds its bound');
      state = JSON.parse(readFileSync(path, 'utf8'));
      if (state.version !== 1 || !state.signals || typeof state.signals !== 'object' || Array.isArray(state.signals)) throw new Error('Early capture state is invalid');
    } else state = { version: 1, signals: {} };
    for (const signal of signals) {
      const idle = researchIdleReason(folder, { now });
      if (idle) { result.status = 'skipped'; result.reason = idle; break; }
      try {
        const previous = state.signals[signal.signal_id];
        if (previous?.queued === true) { result.deduplicated++; continue; }
        const observation = previous ? { case_id: previous.case_id, entry_gate: previous.entry_gate } :
          buildEarlyBreakResearchObservation({ now, qqq, oneMinuteBars, fiveMinuteBars, signal });
        if (!previous) {
          const saved = safeRecordResearchEvent(observation.input, { folder, now });
          if (!['recorded', 'deduplicated'].includes(saved.status)) throw new Error(saved.reason ?? 'Early research event could not be recorded');
          state.signals[signal.signal_id] = { case_id: observation.case_id, first_observed_at: signal.observed_at, entry_gate: observation.entry_gate, queued: false };
          result.captured += Number(saved.status === 'recorded');
          if (saved.status === 'recorded') appendJournal(folder, 'early_break_capture', {
            case_id: observation.case_id, signal_id: signal.signal_id, observed_at: signal.observed_at,
            direction: signal.direction, pattern: signal.pattern, reference_level: signal.reference_level,
            break_bar_at: signal.break_bar_at, break_completed_at: signal.break_completed_at,
            reference_kind: signal.reference_kind, reference_established_at: signal.reference_established_at,
            live_qualified: false, entry_gate: observation.entry_gate, candle_quality: observation.candle_quality,
            signal_capture_delay_seconds: observation.signal_capture_delay_seconds,
            market_context: marketContext && Array.isArray(marketContext.confirmed_levels) ?
              candidateContext(marketContext, { direction: signal.direction, level: signal.reference_level, qqqPrice: Number(qqq.last_trade_price) }) : null,
          });
        }
        const queued = enqueueResearchCase({ case_id: observation.case_id, entry_gate: observation.entry_gate }, { folder, now });
        state.signals[signal.signal_id].queued = queued.status === 'queued';
        result.queued += Number(queued.status === 'queued');
        result.cases.push({ case_id: observation.case_id, signal_id: signal.signal_id, live_qualified: false });
      } catch (error) { result.failures.push(String(error.message).slice(0, 250)); }
    }
    if (result.status !== 'skipped') result.status = result.captured ? 'captured' : result.failures.length ? 'partial' : 'idle';
    return persist();
  } catch (error) { result.status = 'error'; result.failures.push(String(error.message).slice(0, 250)); return persist(); }
  finally { try { release?.(); } catch {} }
}
