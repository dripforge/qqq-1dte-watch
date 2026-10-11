import { runtimeDirectory } from './runtime-paths.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_RISK_POLICY, riskPolicy } from './risk-policy.mjs';

const METADATA = ['schema_version', 'policy_id', 'revision', 'approved', 'recorded_at'];
const RISK_FIELDS = Object.keys(DEFAULT_RISK_POLICY);
const ALL_FIELDS = [...METADATA, ...RISK_FIELDS];

export function validateApprovedRiskPolicy(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Approved risk policy must be an object');
  for (const key of Object.keys(record)) {
    if (!ALL_FIELDS.includes(key)) throw new Error(`Unknown approved policy field: ${key}`);
  }
  for (const key of ALL_FIELDS) {
    if (!Object.hasOwn(record, key)) throw new Error(`Approved risk policy missing ${key}`);
  }
  if (record.schema_version !== 1 || record.policy_id !== 'qqq-1dte-risk' ||
      !Number.isSafeInteger(record.revision) || record.revision < 1 || record.approved !== true) {
    throw new Error('Risk policy approval or schema is invalid');
  }
  if (typeof record.recorded_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(record.recorded_at) ||
      !Number.isFinite(Date.parse(record.recorded_at)) ||
      new Date(record.recorded_at).toISOString().slice(0, 19) !== record.recorded_at.slice(0, 19)) {
    throw new Error('Risk policy recorded time is invalid');
  }
  const policy = riskPolicy(Object.fromEntries(RISK_FIELDS.map(key => [key, record[key]])));
  // Hash a fixed field order so formatting changes do not invalidate a trade;
  // every approval field and risk value is included in the snapshot.
  const canonical = Object.fromEntries(ALL_FIELDS.map(key => [key, record[key]]));
  const sha256 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const snapshot = Object.freeze({ schema_version: record.schema_version,
    policy_id: record.policy_id, revision: record.revision, sha256 });
  return Object.freeze({ policy: Object.freeze(policy), snapshot });
}

export function loadApprovedRiskPolicy(root) {
  let record;
  try { record = JSON.parse(readFileSync(join(root, 'policy.json'), 'utf8')); }
  catch (error) { throw new Error(`Approved risk policy unavailable: ${error.message}`); }
  return validateApprovedRiskPolicy(record);
}

export function assertApprovedRiskPolicy(root, expected) {
  if (!expected || expected.schema_version !== 1 || expected.policy_id !== 'qqq-1dte-risk' ||
      !Number.isSafeInteger(expected.revision) || !/^[0-9a-f]{64}$/.test(expected.sha256 ?? '')) {
    throw new Error('Approved policy snapshot is invalid');
  }
  const current = loadApprovedRiskPolicy(root);
  if (current.snapshot.revision !== expected.revision || current.snapshot.sha256 !== expected.sha256) {
    throw new Error('Approved risk policy changed during this decision; obtain a fresh snapshot');
  }
  return current;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = process.argv[2] ? runtimeDirectory(resolve(process.argv[2])) : runtimeDirectory();
    process.stdout.write(JSON.stringify(loadApprovedRiskPolicy(root)) + '\n');
  } catch (error) {
    process.stderr.write(`Policy blocked: ${error.message}\n`);
    process.exitCode = 1;
  }
}
