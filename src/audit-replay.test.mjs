import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeManifest,validateDecisionAudit,attachDecisionAudit,AUDIT_STAGES } from './audit-record.mjs';
import { explainMinute,recordCollectorTelemetry,summarizeReliability,writeDecisionAudit,renderAuditReport } from './decision-audit.mjs';
import { replayQuotePath,replayResearchState,greekAttribution,REPLAY_SPEC,REPLAY_SPEC_HASH } from './conservative-replay.mjs';
import { refreshDecisionAudit } from './research-collector.mjs';

const NOW=Date.parse('2026-10-09T15:00:00Z'),stamp=x=>new Date(x).toISOString(),ID='contract';
function folder(t){const p=mkdtempSync(join(tmpdir(),'qqq-audit-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
function audit(){return {version:1,started_at:stamp(NOW-30000),runtime_hash:'a'.repeat(64),checks:Object.fromEntries(AUDIT_STAGES.map(k=>[k,{status:'not_evaluated',reason:'Not reached'}])),facts:{quote_at:stamp(NOW-1000)}};}
function basis(){return {reference_observed_at:stamp(NOW),reference_contracts:{[ID]:{ask:2,quote_usable:true}},scalp:{instruments:{[ID]:{samples:Array.from({length:13},(_,i)=>({quote_at:stamp(NOW+i*10000),observed_at:stamp(NOW+i*10000),bid:i===0?1.95:2+i*.01,ask:i===0?2:1.96+i*.01,bid_size:10,ask_size:10}))}}}};}
// Default coherent path: an initial pullback allows a delayed fixed-limit entry.
function goodBasis(){const b=basis();for(const [i,s] of b.scalp.instruments[ID].samples.entries()){s.ask=i===0?2:i<=3?1.95:2+i*.01;s.bid=s.ask-.05;}return b;}
const run=(b,scenario=REPLAY_SPEC.scenarios[0])=>replayQuotePath({basis:b,instrumentId:ID,scenario,now:NOW+150000});

test('audit rejects future evidence, forming bars, invalid fields and missing stages',()=>{
 assert.equal(validateDecisionAudit(audit(),stamp(NOW)).version,1);
 for(const mutation of [a=>a.facts.quote_at=stamp(NOW+1),a=>a.facts.confirm_bar_at=stamp(NOW-60000),a=>a.checks.account='private',a=>delete a.checks.risk,a=>a.started_at=stamp(NOW+1)]){const a=audit();mutation(a);assert.throws(()=>validateDecisionAudit(a,stamp(NOW)));}
});
test('runtime manifest hashes program bytes and detects a changed running revision',t=>{
 const p=folder(t);writeFileSync(join(p,'a.mjs'),'export const x=1;');const m=runtimeManifest(p,NOW);
 const value={observed_at:stamp(NOW),audit:{...audit(),runtime_hash:m.runtime_hash}};
 assert.equal(attachDecisionAudit(value,p,NOW).runtime_matches_start,true);
 writeFileSync(join(p,'a.mjs'),'export const x=2;');const changed=attachDecisionAudit(value,p,NOW);
 assert.equal(changed.runtime_matches_start,false);assert.equal(changed.check_duration_ms,30000);
 assert.ok(existsSync(join(p,changed.runtime_manifest_at_record.manifest_file)));
});
test('minute explanation preserves legacy unknowns and never borrows a future check',()=>{
 const r={event:'watch_run',observed_at:stamp(NOW),outcome:'entry_blocked',reason:'Discretionary obstacle rejection',decision_stage:'room'};
 const found=explainMinute([r],{date:'2026-10-09',minute:'11:00'});assert.equal(found.checks[0].stages.structure.status,'unavailable');
 assert.equal(found.checks[0].decision_stage,'room');assert.equal(explainMinute([r],{date:'2026-10-09',minute:'10:59'}).status,'no_recorded_check');
 assert.throws(()=>explainMinute([],{date:'2026-10-09',minute:'25:00'}));
});
test('replay uses observed ask/bid and separate hypothetical fees, with no fill claim',()=>{
 const r=run(goodBasis());assert.equal(r.status,'quote_scenario');assert.equal(r.actual_fills,false);
 assert.ok(Math.abs(r.quote_scenario_pnl_dollars-1)<1e-9);assert.ok(Math.abs(r.fee_stress_pnl_dollars+.3)<1e-9);
 assert.equal(r.live_eligibility,'unknown');
});
test('delayed entry keeps the original limit and refuses to chase',()=>{
 const b=goodBasis();b.scalp.instruments[ID].samples[1].ask=2.10;
 assert.equal(run(b,REPLAY_SPEC.scenarios[1]).status,'not_marketable_at_sample');
 const r=run(goodBasis(),REPLAY_SPEC.scenarios[1]);assert.equal(r.status,'quote_scenario');assert.equal(r.entry_delay_seconds,10);
});
test('unobserved intervals and future/stale quotes cannot produce a replay return',()=>{
 const b=goodBasis();b.scalp.instruments[ID].samples=b.scalp.instruments[ID].samples.filter((s,i)=>![1,2,3].includes(i));assert.equal(run(b).status,'unavailable');
 const old=goodBasis();for(const s of old.scalp.instruments[ID].samples)s.quote_at=stamp(Date.parse(s.observed_at)-6000);assert.equal(run(old).status,'unavailable');
 const future=goodBasis();for(const s of future.scalp.instruments[ID].samples)s.quote_at=stamp(Date.parse(s.observed_at)+1);assert.equal(run(future).status,'unavailable');
});
test('missing sizes, crossed books, cap breaches and incomplete horizons are explicit',()=>{
 const b=goodBasis();for(const s of b.scalp.instruments[ID].samples){s.bid_size=0;}assert.equal(run(b).status,'unavailable');
 const bad=goodBasis();for(const s of bad.scalp.instruments[ID].samples)s.bid=s.ask+1;assert.equal(run(bad).status,'unavailable');
 const cap=goodBasis();cap.reference_contracts[ID].ask=4;cap.scalp.instruments[ID].samples[0].ask=4;assert.equal(run(cap).status,'outside_research_cap');
 const short=goodBasis();short.scalp.instruments[ID].samples=short.scalp.instruments[ID].samples.slice(0,4);assert.equal(run(short).status,'unavailable');
});
test('unknown Greek units remain unknown; confirmed units produce a residual, not realized P&L',()=>{
 const start={observed_at:stamp(NOW),spot:500,bid:1.95,ask:2,delta:.5,gamma:.05,theta:-1,vega:.1,iv:.2};
 const end={observed_at:stamp(NOW+60000),spot:501,bid:2.45,ask:2.50,iv:.21};
 assert.equal(greekAttribution({start,end}).status,'unavailable');
 const r=greekAttribution({start,end,greekUnits:{theta:'per_calendar_day',vega:'per_volatility_point'}});
 assert.equal(r.status,'approximate');assert.equal(r.delta,50);assert.ok(Math.abs(r.gamma-2.5)<1e-9);assert.ok(Number.isFinite(r.unexplained_residual_dollars));
});
test('research freeze is required and future cases never enter the sample',()=>{
 const item={case_id:'a',first_observed_at:stamp(NOW),last_observed_at:stamp(NOW+120000),direction:'call',first_event_kind:'setup',primary_instrument_id:ID,bases:{case:goodBasis()}};
 const state={cases:{a:item,b:{...item,case_id:'b',first_observed_at:stamp(NOW+999999)}}};
 const r=replayResearchState(state,{now:NOW+150000});assert.equal(r.rows.length,3);assert.equal(r.freeze_verified,false);assert.ok(r.rows.every(x=>x.cohort==='exploratory'));
 const frozen=replayResearchState(state,{now:NOW+150000,freeze:{recorded_at:stamp(NOW-1),spec_hash:REPLAY_SPEC_HASH,spec:REPLAY_SPEC}});
 assert.equal(frozen.freeze_verified,true);assert.equal(frozen.split_verified,false);assert.ok(frozen.rows.every(x=>x.cohort==='split_unavailable'));
});
test('overlapping cases do not inflate replay episode counts or replace an unavailable first case',()=>{
 const item={case_id:'a',first_observed_at:stamp(NOW),last_observed_at:stamp(NOW+120000),direction:'call',first_event_kind:'setup',primary_instrument_id:ID,bases:{case:goodBasis()},setup_evidence:{reference_level:500,break_bar_at:stamp(NOW-600000)}};
 const state={cases:{a:{...item,bases:{}},b:{...item,case_id:'b',first_observed_at:stamp(NOW+1000)}}};
 const r=replayResearchState(state,{now:NOW+150000});const s=r.summaries.find(s=>s.scenario==='immediate_touch'&&s.cohort==='exploratory'&&s.signal_kind==='setup');
 assert.equal(s.episodes,1);assert.equal(s.usable_episodes,0);assert.equal(s.unavailable_or_not_marketable,1);
});
test('collector telemetry is bounded and skips weekends without writing',t=>{
 const p=folder(t);const sunday=Date.parse('2026-10-11T15:00:00Z');assert.equal(recordCollectorTelemetry(p,{began:sunday-10,ended:sunday}).status,'skipped');assert.equal(existsSync(join(p,'audit-telemetry')),false);
 for(let i=0;i<100;i++)recordCollectorTelemetry(p,{began:NOW-100,ended:NOW,tick:{reason:'broker_busy'},rssBytes:123});
 const v=JSON.parse(readFileSync(join(p,'audit-telemetry/2026-10-09.json')));assert.equal(v.samples,100);assert.equal(v.broker_busy_skips,100);assert.equal(v.duration_histogram.length,10);assert.equal(v.p95_cycle_ms_upper_bound,100);assert.equal(v.broker_wait_ms,null);
});
test('reliability distinguishes completion gaps from known scheduled misses',()=>{
 const r=[0,100000].map(n=>({event:'watch_run',observed_at:stamp(NOW+n),service_fresh:false,decision_audit:{check_duration_ms:30000}}));
 const s=summarizeReliability(r,[],{now:NOW+150000});assert.equal(s.days[0].gaps_over_90_seconds,1);assert.equal(s.days[0].p95_check_duration_ms,30000);assert.equal(s.days[0].stale_service_reports,2);
});
test('report escapes untrusted text, tolerates research gaps, writes only analysis files',t=>{
 const p=folder(t);writeFileSync(join(p,'journal.jsonl'),JSON.stringify({event:'watch_run',observed_at:stamp(NOW),outcome:'no_setup',reason:'<script>alert(1)</script>'})+'\n');
 const before=readFileSync(join(p,'journal.jsonl'),'utf8');const status=writeDecisionAudit(p,{now:NOW+150000});assert.equal(status.status,'written');
 assert.equal(readFileSync(join(p,'journal.jsonl'),'utf8'),before);const html=readFileSync(join(p,'decision-audit.html'),'utf8');assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)'));
 assert.ok(existsSync(join(p,'audit-reports/2026-10-09.json')));assert.equal(existsSync(join(p,'arm.json')),false);
});
test('automatic audit refresh yields while market is closed',t=>{
 const p=folder(t);const r=refreshDecisionAudit(p,{now:Date.parse('2026-10-11T15:00:00Z')});assert.equal(r.status,'skipped');assert.equal(existsSync(join(p,'decision-audit.html')),false);
});

test('chronological boundaries are calendar-fixed and cannot move with retained cases',async()=>{
 const {createReplayFreeze}=await import('./conservative-replay.mjs');
 const freeze=createReplayFreeze('2026-10-11T13:00:00Z');assert.equal(freeze.calibration_dates[0],'2026-10-12');
 assert.equal(freeze.calibration_dates.length,20);assert.equal(freeze.evaluation_dates.length,10);
 let r=replayResearchState({cases:{}},{now:Date.parse('2026-10-12T20:00:00Z'),freeze});assert.equal(r.split_verified,true);
 const changed=structuredClone(freeze);changed.calibration_dates[0]='2026-10-09';r=replayResearchState({cases:{}},{now:Date.parse('2026-10-12T20:00:00Z'),freeze:changed});assert.equal(r.split_verified,false);
});
