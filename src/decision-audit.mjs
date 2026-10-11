import { existsSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { readEdgeJournal } from './edge-report.mjs';
import { readResearchState } from './research-record.mjs';
import { marketSession, sessionForDate } from './session.mjs';
import { replayResearchState } from './conservative-replay.mjs';
import { timeMs, AUDIT_STAGES } from './audit-record.mjs';

const iso = x => new Date(x).toISOString();
const finite = x => typeof x === 'number' && Number.isFinite(x);
const dateFormat = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
export const etDate = at => dateFormat.format(new Date(at));
function local(folder, name, limit = 1024 * 1024) {
  try { const p=join(folder,name); if(statSync(p).size>limit)return null;return JSON.parse(readFileSync(p,'utf8')); } catch {return null;}
}
function atomic(folder,name,value) {
  const p=join(folder,name),tmp=`${p}.${process.pid}.tmp`;writeFileSync(tmp, typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,p);
}
const histogramBounds=[10,50,100,500,1000,2500,5000,10000,30000,Infinity];
function upperPercentile(hist,total,p) {if(!total)return null;let n=0;for(let i=0;i<hist.length;i++){n+=hist[i];if(n>=Math.ceil(total*p))return Number.isFinite(histogramBounds[i])?histogramBounds[i]: '>30000';}return null;}

// One small aggregate per verified open-session tick. No broker calls, full
// journal scans, or new scheduler. Outside market hours this function writes nothing.
export function recordCollectorTelemetry(folder,{began,ended,tick,rssBytes=process.memoryUsage().rss}={}) {
  try {
    const session=marketSession(new Date(ended));if(!session.verified||!session.is_open)return {status:'skipped'};
    if(!finite(began)||!finite(ended)||ended<began)return {status:'unavailable'};
    const date=etDate(ended),name=`audit-telemetry/${date}.json`;
    mkdirSync(join(folder,'audit-telemetry'),{recursive:true});
    const previous=local(folder,name),same=previous?.version===1&&previous.date===date;
    const value=same?previous:{version:1,date,first_at:iso(ended),samples:0,duration_histogram:Array(10).fill(0),max_cycle_ms:0,max_rss_bytes:0,broker_busy_skips:0,other_skips:0,collected:0};
    const duration=ended-began;value.samples++;value.at=iso(ended);value.duration_histogram[histogramBounds.findIndex(b=>duration<=b)]++;
    value.max_cycle_ms=Math.max(value.max_cycle_ms,duration);value.max_rss_bytes=Math.max(value.max_rss_bytes,finite(rssBytes)?rssBytes:0);
    value.latest_rss_bytes=finite(rssBytes)?rssBytes:null;
    if(tick?.reason==='broker_busy')value.broker_busy_skips++;else if(tick?.status==='collected')value.collected++;else value.other_skips++;
    value.p95_cycle_ms_upper_bound=upperPercentile(value.duration_histogram,value.samples,.95);
    value.broker_wait_ms=null;value.broker_wait_note='Read-only research does not wait for the lock; broker_busy records yielded attempts. Live order-path wait time is not instrumented here.';
    value.scope='Research collector only; these timings are not protection-loop latency.';
    atomic(folder,name,value);return {status:'recorded'};
  }catch{return {status:'unavailable'};}
}

export function explainMinute(records,{date,minute}={}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'')||!/^\d{2}:\d{2}$/.test(minute??'')||Number(minute.slice(0,2))>23||Number(minute.slice(3))>59)throw Error('Use YYYY-MM-DD and HH:MM Eastern');
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const rows=records.filter(r=>r.event==='watch_run'&&timeMs(r.observed_at)!==null&&etDate(r.observed_at)===date&&fmt.format(new Date(r.observed_at))===minute);
  if(!rows.length)return {date,minute,status:'no_recorded_check',checks:[],reason:'No recorded completion in this minute. This does not prove no signal or no running check; it may reflect cadence, an in-progress run, or omitted history.'};
  return {date,minute,status:'recorded',checks:rows.map(r=>({observed_at:r.observed_at,recorded_at:r.recorded_at??r.at,
    outcome:r.outcome,decision_stage:r.decision_stage??null,reason:r.reason,
    policy_revision:r.policy_snapshot_at_record?.revision??null,
    service:{status:r.service_status??null,fresh:r.service_fresh??null,age_ms:r.service_age_ms??null,reported_version:r.engine_reported_version??null},
    qqq_price:r.qqq_price,one_minute_at:r.one_minute_at,five_minute_at:r.five_minute_at,
    runtime_hash:r.decision_audit?.runtime_manifest_at_record?.runtime_hash??null,
    runtime_matches_start:r.decision_audit?.runtime_matches_start??null,
    check_duration_ms:r.decision_audit?.check_duration_ms??null,
    facts:r.audit?.facts??null,case_id:r.audit?.case_id??null,
    stages:Object.fromEntries(AUDIT_STAGES.map(k=>[k,r.audit?.checks?.[k]??{status:'unavailable',reason:'Not captured in this historical record'}])),
    evidence_source:r.audit?'Agent-reported check evidence, recorded at completion':'Legacy summary only; no stage outcomes reconstructed'}))};
}

export function summarizeReliability(records,telemetry,{now=Date.now()}={}) {
  const runs=records.filter(r=>r.event==='watch_run'&&timeMs(r.observed_at)!==null&&timeMs(r.observed_at)<=now).sort((a,b)=>timeMs(a.observed_at)-timeMs(b.observed_at));
  const days=[...new Set(runs.map(r=>etDate(r.observed_at)))].sort().slice(-5);
  return {scope:'Last five retained dates with recorded checks, plus available collector session telemetry. Missing records are not proof of inactivity.',days:days.map(date=>{
    const selected=runs.filter(r=>etDate(r.observed_at)===date&&marketSession(new Date(r.observed_at)).is_open);
    const gaps=selected.slice(1).map((r,i)=>(timeMs(r.observed_at)-timeMs(selected[i].observed_at))/1000);
    const durations=selected.map(r=>r.decision_audit?.check_duration_ms).filter(finite).sort((a,b)=>a-b);
    const minuteCount=new Set(selected.map(r=>Math.floor(timeMs(r.observed_at)/60000))).size;
    const quoteAges=selected.filter(r=>timeMs(r.audit?.facts?.quote_at)!==null).map(r=>timeMs(r.observed_at)-timeMs(r.audit.facts.quote_at));
    return {date,completed_open_session_checks:selected.length,minutes_with_completion:minuteCount,
      maximum_between_completion_seconds:gaps.length?Math.max(...gaps):null,gaps_over_90_seconds:gaps.filter(x=>x>90).length,
      measured_duration_count:durations.length,p95_check_duration_ms:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,
      maximum_recorded_qqq_quote_age_ms:quoteAges.length?Math.max(...quoteAges):null,
      stale_service_reports:selected.filter(r=>r.service_fresh===false).length,
      runtime_changed_during_check:selected.filter(r=>r.decision_audit?.runtime_matches_start===false).length};}),collector_sessions:telemetry,
    limitations:['No expected-run count is inferred from the schedule: scheduler catch-up and long-running checks are not independently observed.',
      'Collector memory is measured separately from the live exit monitor. Broker lock contention is a skip count, not measured live broker waiting time.']};
}

const escape=x=>String(x??'unknown').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderAuditReport(report) {
  const decisions=report.decisions.flatMap(m=>m.checks.map(c=>({...c,date:m.date,minute:m.minute})));
  const rows=decisions.map(c=>`<tr data-search="${escape([c.date,c.minute,c.outcome,c.decision_stage,c.reason].join(' '))}"><td class="time">${escape(c.minute)}<small>${escape(c.date)} · ET</small></td><td><span class="tag">${escape(c.outcome)}</span><small>${escape(c.decision_stage)}</small></td><td>${escape(c.reason)}<details><summary>Evidence and revisions</summary><pre>${escape(JSON.stringify(c,null,2))}</pre></details></td></tr>`).join('');
  const counts=report.replay.rows.reduce((acc,row)=>{acc[row.status]=(acc[row.status]??0)+1;return acc;},{});
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQQ 1DTE Watch · Decision audit</title><style>
  :root{color-scheme:dark;--bg:#101820;--panel:#17232e;--line:#2d4050;--muted:#a3b6c4;--mint:#86e6bf}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:#eef4f7;font:16px/1.55 system-ui,-apple-system,sans-serif}main{max-width:1180px;margin:auto;padding:44px 28px 80px}.eyebrow{letter-spacing:.16em;font-size:12px;color:var(--mint);font-weight:700}header{padding:18px 0 30px;border-bottom:1px solid var(--line)}h1{font-size:clamp(30px,5vw,52px);letter-spacing:-.04em;line-height:1.12;margin:18px 0}h2{font-size:22px;letter-spacing:-.025em;margin:36px 0 16px}.subtitle{font-size:18px;color:var(--muted);max-width:750px}.meta,small{color:var(--muted);font-size:12px}small{display:block;margin-top:6px}.notice{border:1px solid #42775e;border-radius:10px;padding:16px 20px;color:#b7ebd2;background:#152d27;margin:24px 0}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px}.card strong{display:block;font-size:32px;font-weight:600}.card span{color:var(--muted);font-size:13px}.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:12px}table{border-collapse:collapse;width:100%;background:var(--panel)}td,th{text-align:left;padding:18px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}tr:last-child td{border:0}.time{white-space:nowrap;font-variant-numeric:tabular-nums}.tag{display:inline-block;font:12px ui-monospace,monospace;border:1px solid #426174;color:#bde0f4;padding:5px 8px;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,monospace;background:#111c25;padding:18px;border-radius:8px;max-height:480px;overflow:auto}details{margin:10px 0}summary{cursor:pointer;color:var(--mint);font-size:13px}input{width:100%;padding:13px 16px;border:1px solid var(--line);border-radius:8px;background:#111c25;color:inherit;font:inherit;margin-bottom:16px}input:focus{outline:2px solid var(--mint)}footer{margin-top:42px;color:var(--muted);font-size:12px}a{color:var(--mint)}@media(max-width:650px){main{padding:24px 16px}.cards{grid-template-columns:1fr;gap:8px}.card{padding:14px 18px}.card strong{font-size:24px}td,th{padding:12px}}
  </style></head><body><main><header><div class="eyebrow">QQQ / 1DTE WATCH</div><h1>Every check tells a story.</h1><p class="subtitle">Trace a setup from completed candles to a recorded decision. Keep missing evidence visible.</p><p class="meta">As of ${escape(report.as_of)} · audit format 1.0.0</p></header>
  <div class="notice">${report.synthetic?'<strong>SYNTHETIC DEMO</strong> · All prices, decisions and quote paths are invented. No broker connection.<br>':''}Research only. Quote scenarios are not fills or verified strategy returns. Historical gaps remain unknown.</div>
  <section class="cards" aria-label="Report summary"><div class="card"><strong>${decisions.length}</strong><span>Recorded checks in this view</span></div><div class="card"><strong>${report.replay.rows.length}</strong><span>Quote scenarios examined</span></div><div class="card"><strong>${report.replay.freeze_verified?'Frozen':'Exploratory'}</strong><span>Research specification status</span></div></section>
  <h2>Decision history</h2><p class="meta">${escape(report.coverage.records_read)} retained records · ${escape(report.coverage.malformed_lines)} malformed lines omitted · earlier history ${report.coverage.truncated?'truncated':'not truncated'}. Latest 200 recorded decision minutes.</p><label for="filter" class="meta">Search by time, outcome or explanation</label><input id="filter" type="search" placeholder="Try “risk” or “follow-through”"><div class="table-wrap"><table id="decisions"><thead><tr><th>Eastern time</th><th>Outcome / stage</th><th>Recorded explanation</th></tr></thead><tbody>${rows||'<tr><td colspan="3">No recorded decisions available.</td></tr>'}</tbody></table></div>
  <h2>Conservative quote replay</h2><p class="subtitle">The entry limit stays fixed. A later ask above that limit remains nonmarketable; missing quotes stay unavailable.</p><pre>${escape(JSON.stringify(counts,null,2))}</pre><details><summary>Scenario summaries and research boundaries</summary><pre>${escape(JSON.stringify({freeze_verified:report.replay.freeze_verified,split_verified:report.replay.split_verified,calibration_dates:report.replay.calibration_dates,evaluation_dates:report.replay.evaluation_dates,summaries:report.replay.summaries,greek_attribution:report.replay.greek_attribution},null,2))}</pre></details><p class="meta">${escape(report.replay.interpretation)}</p>
  <h2>Timing and reliability</h2><details><summary>Inspect completion gaps, durations and revision evidence</summary><pre>${escape(JSON.stringify(report.reliability,null,2))}</pre></details><footer>QQQ 1DTE Watch · A missing minute does not prove that a setup was evaluated and rejected.<br>Source: <a href="https://github.com/jonrogol/qqq-1dte-watch">jonrogol/qqq-1dte-watch</a></footer></main><script>document.getElementById('filter').addEventListener('input',function(){const q=this.value.toLowerCase();for(const r of document.querySelectorAll('#decisions tbody tr'))r.hidden=!(r.dataset.search??r.textContent).toLowerCase().includes(q)});</script></body></html>`;
}

export function writeDecisionAudit(folder,{now=Date.now()}={}) {
  const began=performance.now(),{records,coverage}=readEdgeJournal(folder);
  const usable=records.filter(r=>timeMs(r.observed_at??r.at)!==null&&timeMs(r.observed_at??r.at)<=now);
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const indexed=new Map();
  for(const r of usable.filter(r=>r.event==='watch_run'&&timeMs(r.observed_at)!==null)){const key=`${etDate(r.observed_at)} ${fmt.format(new Date(r.observed_at))}`;if(!indexed.has(key))indexed.set(key,[]);indexed.get(key).push(r);}
  const minutes=[...indexed.keys()].sort().slice(-200);
  const decisions=minutes.reverse().map(s=>explainMinute(indexed.get(s),{date:s.slice(0,10),minute:s.slice(11)}));
  let state, researchError=null;try{state=readResearchState(folder);}catch{state={cases:{}};researchError='Research state unavailable; no replay inferred.';}
  const telemetryDir=join(folder,'audit-telemetry'),telemetry=existsSync(telemetryDir)?readdirSync(telemetryDir).filter(n=>/^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-5).map(n=>local(folder,`audit-telemetry/${n}`)).filter(Boolean):[];
  const report={version:1,as_of:iso(now),research_only:true,live_strategy_changes:false,coverage,decisions,
    reliability:summarizeReliability(usable,telemetry,{now}),replay:replayResearchState(state,{now,freeze:local(folder,'audit-replay-spec.json')}),research_error:researchError};
  report.build_duration_ms=Math.round((performance.now()-began)*1000)/1000;
  atomic(folder,'decision-audit-latest.json',report);atomic(folder,'decision-audit.html',renderAuditReport(report));
  // Preserve each session's latest read-only report beyond the research cache's 200-case retention.
  mkdirSync(join(folder,'audit-reports'),{recursive:true});atomic(folder,`audit-reports/${etDate(now)}.json`,report);
  const status={version:1,at:iso(now),status:'written',build_duration_ms:report.build_duration_ms,
    decisions:decisions.length,replay_rows:report.replay.rows.length,journal_truncated:coverage.truncated,research_error:researchError};
  atomic(folder,'decision-audit-status.json',status);return status;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),folder=args[0]?resolve(args[0]):dirname(fileURLToPath(import.meta.url));
    if(args.length===3){const {records,coverage}=readEdgeJournal(folder);console.log(JSON.stringify({...explainMinute(records,{date:args[1],minute:args[2]}),coverage},null,2));}
    else if(args.length<=1)console.log(JSON.stringify(writeDecisionAudit(folder)));
    else throw Error('Usage: decision-audit.mjs [FOLDER [YYYY-MM-DD HH:MM]]');
  }catch(e){console.error(e.message);process.exitCode=1;}
}
