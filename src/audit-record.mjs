import { SOURCE_DIR } from './runtime-paths.mjs';
import { VERSION, PACKAGE_FILE } from './version.mjs';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const AUDIT_VERSION = '1.0.0';
export const AUDIT_STAGES = Object.freeze(['session','service','position','structure','follow_through','room','contract','risk','entry']);
const states = new Set(['pass','block','not_evaluated','unavailable']);
const finite = x => typeof x === 'number' && Number.isFinite(x);
export const timeMs = x => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x)) ? Date.parse(x) : null;
const hash = x => createHash('sha256').update(x).digest('hex');
function exact(obj, keys) { return obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).every(k => keys.includes(k)); }

// Only local program files, never grants, broker records, or account identifiers.
export function runtimeManifest(folder = SOURCE_DIR, now = Date.now()) {
  const files = readdirSync(folder).filter(name => name.endsWith('.mjs') && !name.endsWith('.test.mjs') || name === 'package.json').sort();
  const hashes = {};
  for (const name of files) {
    const path = join(folder, name), stat = statSync(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw Error('Runtime file exceeds audit bound');
    hashes[name] = hash(readFileSync(path));
  }
  if (folder === SOURCE_DIR) hashes['package.json'] = hash(readFileSync(PACKAGE_FILE));
  if (!files.length || files.length > 250) throw Error('Runtime manifest unavailable');
  return { version: AUDIT_VERSION, application_version: VERSION, captured_at: new Date(now).toISOString(), runtime_hash: hash(JSON.stringify(hashes)), files: hashes };
}

export function validateDecisionAudit(audit, observedAt) {
  const observed = timeMs(observedAt);
  if (!exact(audit, ['version','started_at','runtime_hash','checks','facts','case_id']) || audit.version !== 1) throw Error('Invalid decision audit');
  const started = timeMs(audit.started_at);
  if (started === null || observed === null || started > observed || observed - started > 900000 || !/^[a-f0-9]{64}$/.test(audit.runtime_hash ?? '')) throw Error('Invalid audit start or runtime hash');
  if (!exact(audit.checks, AUDIT_STAGES) || AUDIT_STAGES.some(k => !Object.hasOwn(audit.checks, k))) throw Error('All nine audit stages are required');
  for (const row of Object.values(audit.checks)) {
    if (!exact(row, ['status','reason']) || !states.has(row.status) || typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 400) throw Error('Invalid audit stage evidence');
  }
  if (audit.case_id !== undefined && audit.case_id !== null && !/^[a-f0-9]{64}$/.test(audit.case_id)) throw Error('Invalid audit case identity');
  const facts = audit.facts ?? {};
  const fields = ['direction','reference_level','invalidation','obstacle','room','adverse_distance','option_bid','option_ask','quote_at','break_bar_at','confirm_bar_at','option_quote_at'];
  if (!exact(facts, fields)) throw Error('Invalid audit facts');
  for (const [key, value] of Object.entries(facts)) {
    if (value === null) continue;
    if (key === 'direction') { if (!['call','put'].includes(value)) throw Error('Invalid direction'); }
    else if (key.endsWith('_at')) {
      const at = timeMs(value); if (at === null || at > observed) throw Error('Audit evidence is later than the decision');
      if (['break_bar_at','confirm_bar_at'].includes(key) && (at % 300000 !== 0 || at + 300000 > observed)) throw Error('Audit five-minute evidence is incomplete');
    } else if (!finite(value) || value < 0) throw Error('Invalid numeric audit fact');
  }
  if (finite(facts.option_bid) && finite(facts.option_ask) && facts.option_ask < facts.option_bid) throw Error('Crossed audit quote');
  return structuredClone(audit);
}

export function attachDecisionAudit(value, folder, now, { programFolder = SOURCE_DIR } = {}) {
  try {
    const manifest = runtimeManifest(programFolder, now);
    mkdirSync(join(folder,'audit-manifests'),{recursive:true});
    const path=join(folder,'audit-manifests',`${manifest.runtime_hash}.json`);
    if(!existsSync(path))writeFileSync(path,JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    return { audit_version: AUDIT_VERSION, runtime_manifest_at_record: {version:manifest.version,captured_at:manifest.captured_at,runtime_hash:manifest.runtime_hash,manifest_file:`audit-manifests/${manifest.runtime_hash}.json`},
      runtime_matches_start: value.audit ? value.audit.runtime_hash === manifest.runtime_hash : null,
      check_duration_ms: value.audit ? timeMs(value.observed_at) - timeMs(value.audit.started_at) : null,
      recording_delay_ms: now - timeMs(value.observed_at),
      provenance: value.audit ? 'Agent-reported stage evidence; on-disk code hash measured locally, not proof of each resident service version. A pass is not independent broker authorization.' : 'Legacy check: structured stage evidence and start time were not captured.' };
  } catch { return { audit_version: AUDIT_VERSION, runtime_manifest_at_record: null, runtime_matches_start: null,
    check_duration_ms: null, recording_delay_ms: now - timeMs(value.observed_at), provenance: 'Local runtime manifest unavailable.' }; }
}
