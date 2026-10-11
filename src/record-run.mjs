import { validateDecisionAudit, attachDecisionAudit } from './audit-record.mjs';
import { readFileSync, writeFileSync, renameSync, realpathSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendJournal } from './journal.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { readServiceHealth } from './service-health.mjs';
import { loadApprovedRiskPolicy } from './approved-risk-policy.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const outcomes = new Set(['no_setup', 'entry_blocked', 'entry_submitted', 'holding', 'profit_action',
  'market_closed', 'data_unavailable', 'error']);
const unknownCounts = new Set(['market_closed', 'data_unavailable', 'error']);
const activeOutcomes = new Set(['no_setup', 'entry_blocked', 'entry_submitted', 'holding', 'profit_action']);
export const BAR_PUBLICATION_GRACE_MS = 30000;
const keys = ['version', 'observed_at', 'outcome', 'reason', 'qqq_price', 'five_minute_at',
  'one_minute_at', 'positions_open', 'orders_working'];
const decisionStages = new Set(['structure', 'follow_through', 'room', 'contract', 'risk',
  'service', 'session', 'entry', 'position', 'data']);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
function timestamp(value, name) {
  if (typeof value !== 'string' || !iso.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp with a timezone`);
  }
  return Date.parse(value);
}

export function validateWatchRun(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A watch-run JSON object is required');
  if (Object.keys(value).some(key => !keys.includes(key) && key !== 'decision_stage' && key !== 'audit') || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('Use exactly the documented watch-run fields; account identifiers and credentials are forbidden');
  }
  if (Object.hasOwn(value, 'decision_stage') && !decisionStages.has(value.decision_stage)) {
    throw new Error('Decision stage must be one of the documented categories');
  }
  if (value.version !== 1 || !outcomes.has(value.outcome)) throw new Error('Watch-run version or outcome is invalid');
  const observed = timestamp(value.observed_at, 'observed_at');
  if (now - observed > 120000 || observed - now > 5000) throw new Error('Watch observation is stale or in the future');
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 3000) {
    throw new Error('Reason must contain 1–3000 characters');
  }
  if (value.qqq_price !== null && (typeof value.qqq_price !== 'number' || !Number.isFinite(value.qqq_price) || value.qqq_price <= 0)) {
    throw new Error('QQQ price must be a positive number or null when unavailable');
  }
  for (const key of ['five_minute_at', 'one_minute_at']) {
    if (value[key] !== null && timestamp(value[key], key) > observed + 5000) throw new Error(`${key} is later than the observation`);
  }
  for (const key of ['positions_open', 'orders_working']) {
    if (value[key] === null && unknownCounts.has(value.outcome)) continue;
    if (!Number.isInteger(value[key]) || value[key] < 0) throw new Error(`${key} must be a known nonnegative integer for this outcome`);
  }
  if (activeOutcomes.has(value.outcome)) {
    if (value.qqq_price === null || value.five_minute_at === null || value.one_minute_at === null) {
      throw new Error('Normal market-hours outcomes require the QQQ price and both chart timestamps; use data_unavailable for failed reads');
    }
    for (const [key, interval] of [['five_minute_at', 300000], ['one_minute_at', 60000]]) {
      const began = timestamp(value[key], key);
      if (began % interval !== 0) throw new Error(`${key} is not a broker bar boundary`);
      if (began + interval > observed - 1000) throw new Error(`${key} refers to a forming or just-completing bar`);
      if (observed - began > 2 * interval + BAR_PUBLICATION_GRACE_MS) throw new Error(`${key} is stale`);
    }
  }
  if (value.audit !== undefined) validateDecisionAudit(value.audit, value.observed_at);
  return { ...value, reason: value.reason.trim() };
}

export function recordWatchRun(inputPath, { folder = root, now = Date.now() } = {}) {
  const actualRoot = realpathSync(folder);
  const candidate = realpathSync(resolve(actualRoot, inputPath));
  const within = relative(actualRoot, candidate);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith('../')) throw new Error('Input must be a file inside the monitor folder');
  const stat = statSync(candidate);
  if (!stat.isFile() || stat.size > 16384) throw new Error('Input must be a JSON file smaller than 16 KiB');
  const value = validateWatchRun(JSON.parse(readFileSync(candidate, 'utf8')), now);
  const release = acquireProcessLock(join(actualRoot, 'watch-status.lock'));
  try {
    const latest = join(actualRoot, 'watch-status.json');
    if (existsSync(latest)) {
      const previous = JSON.parse(readFileSync(latest, 'utf8'));
      if (!Number.isFinite(Date.parse(previous.observed_at ?? ''))) throw new Error('Existing watch status has an invalid observation time');
      if (Date.parse(value.observed_at) < Date.parse(previous.observed_at)) throw new Error('A newer watch observation is already recorded');
    }
    let policySnapshot = null;
    try { policySnapshot = loadApprovedRiskPolicy(actualRoot).snapshot; }
    catch {
      if (activeOutcomes.has(value.outcome)) {
        throw new Error('Active watch outcome requires a valid locally approved risk policy; use error or data_unavailable when policy verification fails');
      }
    }
    const service = readServiceHealth(actualRoot, { now });
    const serviceFields = Object.fromEntries(Object.entries(service).filter(([key]) => key.startsWith('service_')));
    const record = { ...value, recorded_at: new Date(now).toISOString(), ...serviceFields, engine_reported_version: service.reported_version ?? null,
      policy_status: policySnapshot ? 'approved' : 'unavailable', policy_snapshot_at_record: policySnapshot, decision_audit: attachDecisionAudit(value, actualRoot, now) };
    appendJournal(actualRoot, 'watch_run', record);
    const temporary = `${latest}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, latest);
    return record;
  } finally { release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: record-run.mjs PATH_TO_WATCH_RUN_JSON');
    const record = recordWatchRun(process.argv[2]);
    process.stdout.write(JSON.stringify({ status: 'recorded', outcome: record.outcome,
      observed_at: record.observed_at, reason: record.reason.slice(0, 500),
      service_status: record.service_status, service_live: record.service_live,
      service_fresh: record.service_fresh, service_age_ms: record.service_age_ms,
      policy_revision: record.policy_snapshot_at_record?.revision ?? null }) + '\n');
  } catch (error) {
    process.stderr.write(`Watch run was not recorded: ${String(error.message).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
