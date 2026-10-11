import { runtimeManifest } from './audit-record.mjs';
import { haltContext } from './halt-context.mjs';
import { readAnalysisPacket } from './analysis-context.mjs';
import { eventContext } from './event-context.mjs';
import { readEventCache } from './analysis-collector.mjs';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { readServiceHealth } from './service-health.mjs';
import { recentExitContext } from './reentry.mjs';
import { validateEntryWatchPlan, readEntryWatchState } from './entry-watch-plan.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const OUTCOMES = new Set(['no_setup', 'entry_blocked', 'entry_submitted', 'holding', 'profit_action',
  'market_closed', 'data_unavailable', 'error']);
const STATE_FILES = { arm: 'arm.json', entry_intent: 'entry-intent.json',
  exit_intent: 'exit-intent.json', profit_request: 'profit-exit-request.json', profit_plan: 'profit-plan.json' };

function localJson(folder, filename) {
  const path = join(folder, filename);
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 65536) return { present: true, invalid: true };
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { present: true, invalid: true };
    return { present: true, value };
  } catch (error) {
    return error.code === 'ENOENT' ? { present: false } : { present: null, invalid: true };
  }
}

// This is a local operational snapshot. It neither verifies broker positions
// nor caches market quotes, and the trading gates still perform fresh reads.
export async function readWatchContext(folder, { now = Date.now() } = {}) {
  const time = now instanceof Date ? now.getTime() : now;
  const validTime = Number.isFinite(time) && Number.isFinite(new Date(time).getTime());
  const errors = [];
  let critical = !validTime;
  const error = (component, code, message) => errors.push({ component, code, message });
  if (!validTime) error('observation', 'invalid_time', 'The observation time is invalid.');
  const result = { version: 1, observed_at: validTime ? new Date(time).toISOString() : null,
    market_session: null, calendar_metadata: null, approved_risk: null,
    service_health: null, last_watch: null, last_exit:null,active_state: null, fast_entry:null, candidate_capture:null,
    last_fast_attempt:null,fast_candidates:null,market_context:null,edge_research:null,errors, critical_block: false };
  try {
    const previous=localJson(folder,'last-exit.json');
    if(previous.invalid)throw Error('invalid');
    if(previous.present)result.last_exit=recentExitContext(previous.value,time);
  } catch {error('last_exit','exit_context_unverified','Last verified exit context needs review before re-entry.');}

  try { result.approved_risk = loadApprovedRiskPolicy(folder); }
  catch {
    critical = true;
    error('approved_risk', 'policy_invalid', 'The approved risk policy is missing, malformed, or not approved.');
  }
  try {
    const { marketSession, CALENDAR_METADATA } = await import('./session.mjs');
    result.calendar_metadata = CALENDAR_METADATA;
    result.market_session = marketSession(new Date(time));
    if (!result.market_session.verified) {
      critical = true;
      error('market_session', 'calendar_unverified', 'The date is outside the verified market calendar.');
    }
  } catch {
    critical = true;
    result.market_session = { verified: false, reason: 'calendar_unavailable', is_open: null, can_enter: false };
    error('market_session', 'calendar_unavailable', 'A verified market session could not be determined.');
  }

  try {
    result.service_health = readServiceHealth(folder, { now: time });
    if (!result.service_health.fresh) error('service_health', result.service_health.condition,
      'The local exit service does not have a fresh valid health report.');
  } catch {
    error('service_health', 'health_unavailable', 'The local exit service health could not be read.');
  }

  const active = { arm: false, entry_intent: false, exit_intent: false,
    profit_request: false, profit_plan: false, trade_id: null, option_id: null };
  const trades = new Set();
  const options = new Set();
  for (const [key, filename] of Object.entries(STATE_FILES)) {
    const state = localJson(folder, filename);
    if (!state.present && !state.invalid) continue;
    if (state.invalid || !UUID.test(state.value.option_id ?? '') ||
        state.value.trade_id !== undefined && !UUID.test(state.value.trade_id ?? '')) {
      active[key] = null;
      error('active_state', 'state_unverified', `${filename} cannot be verified as valid local trade state.`);
      continue;
    }
    active[key] = true;
    options.add(state.value.option_id);
    if (state.value.trade_id) trades.add(state.value.trade_id);
  }
  if (trades.size === 1) active.trade_id = [...trades][0];
  if (options.size === 1) active.option_id = [...options][0];
  if (trades.size > 1 || options.size > 1) error('active_state', 'conflicting_trade_identity',
    'Local state files refer to different trade identities; verify before taking action.');
  result.active_state = active;

  const fastService=localJson(folder,'fast-watch-status.json'),pending=localJson(folder,'entry-watch-plan.json');
  result.fast_entry={service:null,plan:null,attempt:null};
  if(fastService.present&&!fastService.invalid){
    const value=fastService.value,at=value.at,age=time-Date.parse(at??'');
    if(!ISO.test(at??'')||!Number.isFinite(age)||age < -5000){error('fast_entry','fast_status_invalid','The fast entry service report cannot be verified.');}
    else result.fast_entry.service={at,age_ms:age,fresh:age<=30000,status:String(value.status??'').slice(0,80),
      reason:String(value.reason??'').slice(0,300),interval_ms:value.interval_ms===10000?10000:null,
      setup_review_version:typeof value.setup_review_version==='string'?value.setup_review_version.slice(0,32):null,
      entry_dispatched:value.entry_dispatched===true,plan_status:typeof value.plan_status==='string'?value.plan_status.slice(0,80):null};
  }else if(fastService.invalid)error('fast_entry','fast_status_invalid','The fast entry service report cannot be verified.');
  if(pending.present||pending.invalid){
    try{
      if(pending.invalid)throw Error('invalid');
      const plan=validateEntryWatchPlan(pending.value,{now:Date.parse(pending.value.created_at),allowExpired:true});
      const state=readEntryWatchState(folder,{plan});
      result.fast_entry.plan={plan_id:plan.plan_id,option_id:plan.option_id,direction:plan.direction,expiration:plan.expiration,
        created_at:plan.created_at,expires_at:plan.expires_at,expired:time>=Date.parse(plan.expires_at),
        qqq_invalidation:plan.qqq_invalidation,setup:plan.setup,profit_protection:plan.profit_protection,
        policy_snapshot:plan.policy_snapshot};
      result.fast_entry.attempt=state?{status:state.status,attempted_at:state.attempted_at,attempt_id:state.attempt_id}:null;
    }catch{critical=true;error('fast_entry','entry_plan_unverified','A saved fast entry plan or attempt requires review before a new entry.');}
  }
  const lastFast=localJson(folder,'entry-watch-last-attempt.json');
  if(lastFast.present||lastFast.invalid){
    if(lastFast.invalid||!UUID.test(lastFast.value?.plan_id??'')||!/^[0-9a-f]{64}$/.test(lastFast.value?.setup_id??'')||
      !ISO.test(lastFast.value?.break_bar_at??'')||!ISO.test(lastFast.value?.attempted_at??'')){
      critical=true;error('fast_entry','fast_attempt_unverified','The last fast entry attempt cannot be verified.');
    }else result.last_fast_attempt={plan_id:lastFast.value.plan_id,setup_id:lastFast.value.setup_id,
      break_bar_at:lastFast.value.break_bar_at,attempted_at:lastFast.value.attempted_at};
  }
  const capture=localJson(folder,'candidate-capture-status.json');
  if(capture.present&&!capture.invalid)result.candidate_capture={at:capture.value.at??null,status:capture.value.status??null,
    reason:typeof capture.value.reason==='string'?capture.value.reason.slice(0,300):null};
  const scanned=localJson(folder,'fast-watch-candidates.json');
  if(scanned.present&&!scanned.invalid){
    const value=scanned.value,age=time-Date.parse(value.observed_at??'');
    if(value.version===1&&value.status==='complete'&&Number.isFinite(age)&&age>=-5000&&Array.isArray(value.candidates)&&value.candidates.length<=4){
      result.fast_candidates={observed_at:value.observed_at,age_ms:age,fresh:age<=30000,
        qqq_price:Number.isFinite(value.qqq_price)?value.qqq_price:null,
        candidates:value.candidates.map(row=>({direction:row.candidate?.direction,pattern:row.candidate?.pattern,
          level:row.candidate?.level,break_bar_at:row.candidate?.break_bar_at,confirm_bar_at:row.candidate?.confirm_bar_at,
          confirmation_1m_at:row.candidate?.confirmation_1m_at,structural_qualified:row.structural_qualified===true,
          scanner_qualified:row.qualified===true,reason:typeof row.reason==='string'?row.reason.slice(0,300):null,
          room_review:row.room_review?.version===1?row.room_review:null,
          reference:row.reference?{kind:row.reference.kind,established_at:row.reference.established_at}:null}))};
    }
  }

  const marketContext=localJson(folder,'market-context-latest.json');
  if(marketContext.present&&!marketContext.invalid&&marketContext.value.research_only===true){
    const age=time-Date.parse(marketContext.value.observed_at??'');
    if(Number.isFinite(age)&&age>=-5000)result.market_context={...marketContext.value,age_ms:age,fresh:age<=30000};
  }
  if(validTime){
    try{const saved=localJson(folder,'analysis-context-latest.json');result.analysis_context=readAnalysisPacket(saved.invalid?null:saved.value,{now:time});}catch{result.analysis_context={status:'unavailable',research_only:true,live_filter:false};}
    try{result.event_context=eventContext(readEventCache(folder),{now:time});}catch{result.event_context={status:'unavailable',reason:'optional_calendar_unverified',research_only:true,live_filter:false};}
    try{const halts=localJson(folder,'analysis-halts-cache.json');result.halt_context=haltContext(halts.invalid?null:halts.value,time);}catch{result.halt_context={status:'unavailable'};}
    const worker=localJson(folder,'analysis-collector-status.json');if(worker.present&&!worker.invalid)result.analysis_service=worker.value;
  }
  const report=localJson(folder,'edge-report-status.json');
  if(report.present&&!report.invalid)result.edge_research=report.value;
  const watch = localJson(folder, 'watch-status.json');
  result.last_watch = { present: watch.present, observed_at: null, age_ms: null, outcome: null };
  if (watch.present || watch.invalid) {
    const at = watch.value?.observed_at;
    if (watch.invalid || typeof at !== 'string' || !ISO.test(at) || !Number.isFinite(Date.parse(at)) ||
        !OUTCOMES.has(watch.value?.outcome)) {
      error('last_watch', 'watch_unverified', 'The previous watch result is missing valid observation fields.');
    } else {
      result.last_watch.observed_at = at;
      result.last_watch.age_ms = validTime ? time - Date.parse(at) : null;
      result.last_watch.outcome = watch.value.outcome;
      if (validTime && result.last_watch.age_ms < -5000) error('last_watch', 'watch_clock_error',
        'The previous watch observation is in the future.');
    }
  }
  try { const manifest = runtimeManifest(folder, time); result.audit_start = { version: 1, started_at: result.observed_at, runtime_hash: manifest.runtime_hash }; }
  catch { result.audit_start = null; }
  result.critical_block = critical;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('usage');
    const folder = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url));
    const context = await readWatchContext(folder);
    process.stdout.write(JSON.stringify(context) + '\n');
    if (context.critical_block) process.exitCode = 1;
  } catch {
    process.stdout.write(JSON.stringify({ version: 1, critical_block: true,
      errors: [{ component: 'context', code: 'context_unavailable', message: 'Use watch-context.mjs with at most one folder argument.' }] }) + '\n');
    process.exitCode = 1;
  }
}
