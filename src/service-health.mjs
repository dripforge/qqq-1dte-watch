import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const IDLE_HEALTH_MAX_AGE_MS = 60000;
export const ACTIVE_HEALTH_MAX_AGE_MS = 30000;
const idleStatuses = new Set(['idle', 'closed', 'market_closed']);
const stopStatuses = new Set(['stop_armed', 'stop_pending', 'close_order_working',
  'stop_filled_waiting_position', 'stop_repeatedly_rejected', 'stop_unavailable_now',
  'emergency_exit', 'local_premium_watch_only', 'stop_rejected', 'stop_outcome_unknown',
  'stop_order_unverified', 'stop_session_expired', 'stop_repair_required', 'stop_rearm_pending']);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

// "Live" describes a recent local service report, not a broker fill or stop guarantee.
export function assessServiceHealth(raw, { now = Date.now(), maxAgeMs,
  idleMaxAgeMs = IDLE_HEALTH_MAX_AGE_MS, activeMaxAgeMs = ACTIVE_HEALTH_MAX_AGE_MS,
  futureToleranceMs = 5000, hasState = null } = {}) {
  for (const value of [now, idleMaxAgeMs, activeMaxAgeMs, futureToleranceMs]) {
    if (!Number.isFinite(value) || value < 0) throw new Error('Health time settings must be finite and nonnegative');
  }
  if (maxAgeMs !== undefined && (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)) throw new Error('Health maximum age is invalid');
  if (hasState !== null && typeof hasState !== 'boolean') throw new Error('Health state presence must be boolean or unknown');
  const object = !!raw && typeof raw === 'object' && !Array.isArray(raw);
  const reportedStatus = object && typeof raw.status === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(raw.status) ? raw.status : null;
  const reportedLive = object && typeof raw.live === 'boolean' ? raw.live : null;
  const reportedVersion = object && typeof raw.version === 'string' && raw.version.length <= 64
    && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(raw.version) ? raw.version : null;
  const deadlineExceeded = object && typeof raw.deadline_exceeded === 'boolean' ? raw.deadline_exceeded : null;
  const reportedStopStatus = object && typeof raw.stop_status === 'string' && stopStatuses.has(raw.stop_status) ? raw.stop_status : null;
  const recoveryStatus = object && typeof raw.entry_recovery_status === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(raw.entry_recovery_status) ? raw.entry_recovery_status : null;
  const basisVerified = object && typeof raw.entry_basis_verified === 'boolean' ? raw.entry_basis_verified : null;
  const fillVerified = object && typeof raw.entry_fill_verified === 'boolean' ? raw.entry_fill_verified : null;
  const ownershipVerified=object&&typeof raw.position_ownership_verified==='boolean'?raw.position_ownership_verified:null;
  const profitStatus=object&&['watching','armed','exit_requested','unavailable'].includes(raw.profit_protection_status)?raw.profit_protection_status:null;
  const profitMode=object&&['scalp','trend'].includes(raw.profit_protection_mode)?raw.profit_protection_mode:null;
  const readiness = object && raw.protection_readiness && typeof raw.protection_readiness === 'object' ? raw.protection_readiness : null;
  const phase = readiness && ['broker_stop_armed','opening_local_watch','carry_waiting_session','broker_rearm_required','closing_order_working','calendar_unverified'].includes(readiness.phase) ? readiness.phase : null;
  const protectionReady = readiness && typeof readiness.ready_for_session === 'boolean' ? readiness.ready_for_session : null;
  const protectionIssues = readiness && Array.isArray(readiness.issues) && readiness.issues.length <= 32 && readiness.issues.every(code => typeof code === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(code)) ? readiness.issues : [];
  const dataUnavailable = object && typeof raw.data_error === 'string' && raw.data_error.trim().length > 0;
  const at = object && typeof raw.at === 'string' && iso.test(raw.at) && Number.isFinite(Date.parse(raw.at)) ? raw.at : null;
  const age = at === null ? null : now - Date.parse(at);
  const maximum = maxAgeMs ?? (hasState === true || !idleStatuses.has(reportedStatus) ? activeMaxAgeMs : idleMaxAgeMs);
  let condition = raw === null || raw === undefined ? 'unavailable' : 'invalid';
  if (reportedStatus !== null && reportedLive !== null && at !== null) {
    condition = age < -futureToleranceMs ? 'clock_error' : age > maximum ? 'stale' : 'fresh';
  }
  const fresh = condition === 'fresh';
  const status = fresh ? reportedStatus : condition;
  const liveVerified = fresh && reportedLive === true;
  return {
    status, condition, fresh, age_ms: age, live_verified: liveVerified,
    reported_status: reportedStatus, reported_live: reportedLive, reported_version: reportedVersion,
    deadline_exceeded: deadlineExceeded, stop_status: reportedStopStatus, reported_stop_status: reportedStopStatus,
    data_unavailable: dataUnavailable, at,
    entry_recovery_status:recoveryStatus,entry_basis_verified:basisVerified,entry_fill_verified:fillVerified,
    position_ownership_verified:ownershipVerified,profit_protection_status:profitStatus,profit_protection_mode:profitMode,
    protection_phase:phase,protection_ready:protectionReady,protection_issues:protectionIssues,
    max_age_ms: maximum, has_state: hasState,
    service_status: status, service_condition: condition, service_fresh: fresh,
    service_age_ms: age, service_live: liveVerified, service_verified_live: liveVerified,
    service_reported_status: reportedStatus, service_reported_live: reportedLive,
    service_reported_version: reportedVersion, service_deadline_exceeded: deadlineExceeded,
    service_stop_status: reportedStopStatus, service_reported_stop_status: reportedStopStatus,
    service_data_unavailable: dataUnavailable,
    service_at: at, service_max_age_ms: maximum, service_has_state: hasState,
  };
}

export function readServiceHealth(folder, options = {}) {
  let raw;
  const hasState = options.hasState ?? ['arm.json', 'entry-intent.json', 'exit-intent.json']
    .some(name => existsSync(join(folder, name)));
  try { raw = JSON.parse(readFileSync(join(folder, 'health.json'), 'utf8')); }
  catch (error) { raw = error.code === 'ENOENT' ? null : {}; }
  return assessServiceHealth(raw, { ...options, hasState });
}
