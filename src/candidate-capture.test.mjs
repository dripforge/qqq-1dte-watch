import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildCandidateResearchObservation,captureCandidateObservations} from './candidate-capture.mjs';
import {readResearchState} from './research-record.mjs';
import {scanSetups} from './setup-scan.mjs';
import {collectResearchTick} from './research-collector-policy.mjs';
import {DEFAULT_RISK_POLICY} from './risk-policy.mjs';

const AT='2026-10-09T14:00:02Z',NOW=Date.parse(AT);
const at=ms=>new Date(ms).toISOString();
function bar(began,open,high,low,close){return {begins_at:began,open_price:String(open),high_price:String(high),low_price:String(low),close_price:String(close),volume:1000,interpolated:false,session:'reg'};}
function evidence(){
  const fiveMinuteBars=[bar('2026-10-09T13:45:00Z',500.3,500.4,500.1,500.2),bar('2026-10-09T13:50:00Z',500.2,500.3,499.7,499.8),bar('2026-10-09T13:55:00Z',499.8,500.1,499.6,499.7)];
  const oneMinuteBars=Array.from({length:10},(_,i)=>{const close=499.95-i*.025;return bar(at(Date.parse('2026-10-09T13:50:00Z')+i*60000),close+.015,close+.04,close-.04,close);});
  oneMinuteBars[8]=bar('2026-10-09T13:58:00Z',499.9,499.95,499.7,499.8);oneMinuteBars[9]=bar('2026-10-09T13:59:00Z',499.8,499.85,499.6,499.7);
  const qqq={symbol:'QQQ',state:'active',has_traded:true,last_trade_price:'499.7',venue_last_trade_time:AT};
  const record={candidate:{version:1,direction:'put',pattern:'break_failed_reclaim',level:500,break_bar_at:fiveMinuteBars[1].begins_at,confirm_bar_at:fiveMinuteBars[2].begins_at,
    confirmation_1m_at:oneMinuteBars.at(-1).begins_at,rationale:'Known completed reference broke and a later completed bar failed to reclaim it.'},
    structural_qualified:true,qualified:true,reason:'Completed structure and latest one-minute follow-through qualify; fresh entry gate still required',
    latest_one_minute_qualified:true,reentry_qualified:true,reference:{kind:'explicit_plan',established_at:'2026-10-09T13:45:00Z'},requires_fresh_entry_gate:true};
  return {now:NOW,qqq,oneMinuteBars,fiveMinuteBars,record};
}
function fixture(t){const folder=mkdtempSync(join(tmpdir(),'qqq-candidate-capture-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  writeFileSync(join(folder,'health.json'),JSON.stringify({at:AT,live:true,status:'idle',version:'2.4.0'}));return folder;}
function capture(folder,snapshot=evidence(),extra={}){return captureCandidateObservations({folder,...snapshot,candidates:[snapshot.record],...extra});}
function journal(folder){return readFileSync(join(folder,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);}

test('automatic snapshot capture creates actual same-day research evidence without option or live approval',t=>{
  const folder=fixture(t),snapshot=evidence(),result=capture(folder,snapshot);assert.equal(result.status,'captured');assert.equal(result.captured,1);assert.equal(result.research_events,1);assert.equal(result.queued,1);
  const item=readResearchState(folder).cases[result.cases[0].case_id];assert.equal(item.first_observed_at,at(NOW));assert.equal(item.primary_instrument_id,null);
  assert.equal(item.setup_evidence.live_qualified,false);assert.equal(item.bases.case.reference_observed_at,null);
  const record=JSON.parse(readFileSync(join(folder,'research-journal.jsonl'),'utf8').trim());assert.equal(record.selected_contract,null);
  assert.equal(record.one_minute_bars.at(-1).begins_at,snapshot.oneMinuteBars.at(-1).begins_at);assert.equal(record.observed_at,at(NOW));
  const queue=JSON.parse(readFileSync(join(folder,'research-collector-queue.json'),'utf8')).cases[item.case_id];assert.equal(queue.entry_gate.status,'unknown');
  const event=journal(folder)[0];assert.equal(event.event,'candidate_capture');assert.equal(event.scanner_qualified,true);assert.equal(event.structural_qualified,true);assert.equal(event.live_qualified,false);
  assert.equal(event.causal_reference.established_at,'2026-10-09T13:45:00Z');assert.equal(event.causal_reference.level,500);
  assert.equal(event.latest_one_minute_bar.begins_at,snapshot.oneMinuteBars.at(-1).begins_at);assert.equal(event.latest_five_minute_bar.begins_at,snapshot.fiveMinuteBars.at(-1).begins_at);
});
test('a completed structural candidate with failed latest one-minute confirmation remains recorded with exact blocked reason',t=>{
  const folder=fixture(t),snapshot=evidence();snapshot.oneMinuteBars[9]=bar('2026-10-09T13:59:00Z',499.8,499.9,499.75,499.85);
  snapshot.qqq.last_trade_price='499.85';snapshot.record.qualified=false;snapshot.record.latest_one_minute_qualified=false;snapshot.record.reentry_qualified=null;
  snapshot.record.reason='Completed one-minute bars do not show directional follow-through';
  const result=capture(folder,snapshot);assert.equal(result.status,'captured');assert.equal(readResearchState(folder).created_cases,1);
  const entry=JSON.parse(readFileSync(join(folder,'research-collector-queue.json'),'utf8')).cases[result.cases[0].case_id].entry_gate;
  assert.equal(entry.status,'blocked');assert.equal(entry.reason,snapshot.record.reason);assert.equal(entry.checked_at,at(NOW));
  const event=journal(folder)[0];assert.equal(event.scanner_qualified,false);assert.equal(event.structural_qualified,true);assert.equal(event.latest_one_minute_qualified,false);assert.equal(event.scanner_reason,snapshot.record.reason);
});
test('unchanged ten-second ticks change neither case count nor watch journal observations',t=>{
  const folder=fixture(t),snapshot=evidence();capture(folder,snapshot);
  const later=structuredClone(snapshot);later.now+=10000;later.qqq.venue_last_trade_time=at(later.now);later.qqq.last_trade_price='499.72';
  const result=capture(folder,later);assert.equal(result.captured,0);assert.equal(result.duplicate_transitions,1);
  assert.equal(readResearchState(folder).created_cases,1);assert.equal(readResearchState(folder).recorded_events,1);assert.equal(journal(folder).length,1);
});
test('a changed actual one-minute confirmation updates meaningful evidence while retaining one underlying case',t=>{
  const folder=fixture(t),snapshot=evidence();capture(folder,snapshot);
  const later=structuredClone(snapshot);later.now+=60000;later.qqq.venue_last_trade_time=at(later.now);
  later.oneMinuteBars.push(bar('2026-10-09T14:00:00Z',499.75,499.8,499.5,499.6));later.record.candidate.confirmation_1m_at=later.oneMinuteBars.at(-1).begins_at;
  later.record.qualified=false;later.record.reason='Re-entry is blocked until a newer completed break after the verified closure';later.record.reentry_qualified=false;
  writeFileSync(join(folder,'health.json'),JSON.stringify({at:at(later.now),status:'idle',live:true}));const result=capture(folder,later);
  assert.equal(result.captured,1);assert.equal(readResearchState(folder).created_cases,1);assert.equal(journal(folder).length,2);
  const event=journal(folder).at(-1);assert.equal(event.observed_at,at(later.now));assert.equal(event.latest_one_minute_bar.begins_at,'2026-10-09T14:00:00Z');assert.equal(event.reentry_qualified,false);
});
test('a causal reference established after the break and a forged reference level are rejected',t=>{
  for(const change of [{established_at:'2026-10-09T13:51:00Z'},{level:501}]){const snapshot=evidence();snapshot.record.reference={...snapshot.record.reference,...change};
    assert.throws(()=>buildCandidateResearchObservation(snapshot),/reference_not_causal/);}
});
test('forming bars are omitted; fabricated or stale completed evidence cannot generate a case',t=>{
  const snapshot=evidence();snapshot.oneMinuteBars.push(bar('2026-10-09T14:00:00Z',499.7,500,499.5,499.8));snapshot.fiveMinuteBars.push(bar('2026-10-09T14:00:00Z',499.7,500,499.5,499.8));
  const built=buildCandidateResearchObservation(snapshot);assert.equal(built.input.one_minute_bars.length,10);assert.equal(built.input.five_minute_bars.length,3);
  for(const apply of [s=>s.oneMinuteBars.at(-1).interpolated=true,s=>s.fiveMinuteBars.at(-1).session='post',s=>s.record.candidate.confirm_bar_at='2026-10-09T14:00:00Z',
    s=>s.record.candidate.confirmation_1m_at=s.oneMinuteBars.at(-2).begins_at,s=>s.oneMinuteBars.splice(7,1),s=>s.now+=90001]){
    const changed=evidence();apply(changed);const folder=fixture(t);const result=capture(folder,changed);assert.equal(result.captured,0);assert.equal(readResearchState(folder).created_cases,0);
  }
});
test('stale, empty, crossed identity and invalid current QQQ quotes cannot produce actual capture evidence',t=>{
  for(const change of [{last_trade_price:null},{last_trade_price:''},{last_trade_price:'NaN'},{last_trade_price:'0'},{symbol:'SPY'},{has_traded:false},
    {venue_last_trade_time:at(NOW-10001)},{venue_last_trade_time:at(NOW+5001)}]){const snapshot=evidence();Object.assign(snapshot.qqq,change);
    assert.throws(()=>buildCandidateResearchObservation(snapshot));}
});
test('capture yields to live intents, all trading locks and busy broker lock',t=>{
  for(const name of ['arm.json','entry-intent.json','exit-intent.json','profit-plan.json','profit-exit-request.json','entry.lock','profit.lock','exit.lock','state.lock','broker.lock']){
    const folder=fixture(t);writeFileSync(join(folder,name),'{}');const result=capture(folder);assert.equal(result.status,'skipped');assert.equal(readResearchState(folder).created_cases,0);
    assert.equal(existsSync(join(folder,'research-collector-queue.json')),false);assert.equal(existsSync(join(folder,'journal.jsonl')),false);
  }
});
test('capture requires fresh exact-idle live monitor health and a verified open regular session',t=>{
  for(const health of [{at:AT,status:'unarmed_qqq_position',live:true},{at:AT,status:'idle',live:false},{at:at(NOW-60001),status:'idle',live:true},{}]){
    const folder=fixture(t);writeFileSync(join(folder,'health.json'),JSON.stringify(health));const result=capture(folder);assert.equal(result.reason,'monitor_idle_unverified');assert.equal(result.captured,0);
  }
  for(const [now,reason] of [[Date.parse('2026-10-10T14:00:02Z'),'market_closed'],[Date.parse('2029-01-02T15:00:02Z'),'calendar_unverified']]){
    const folder=fixture(t),snapshot=evidence();snapshot.now=now;const result=capture(folder,snapshot);assert.equal(result.status,'skipped');assert.equal(result.reason,reason);
  }
});
test('one malformed candidate does not prevent another meaningful candidate from being captured',t=>{
  const folder=fixture(t),snapshot=evidence();const result=capture(folder,snapshot,{candidates:[{candidate:{},qualified:false,reason:'Malformed'},snapshot.record]});
  assert.equal(result.captured,1);assert.equal(result.failures.length,1);assert.equal(readResearchState(folder).created_cases,1);
});
test('optional capture file failures return a visible result and do not throw into live execution',t=>{
  const folder=fixture(t);writeFileSync(join(folder,'candidate-capture-state.json'),'broken');assert.doesNotThrow(()=>capture(folder));
  const result=captureCandidateObservations({folder:join(folder,'missing'),now:NOW,candidates:[]});assert.equal(result.status,'error');assert.equal(result.execution_unaffected,true);
});
test('missing broker flags remain unknown in strict research instead of being fabricated or dropping the candidate',t=>{
  const folder=fixture(t),snapshot=evidence();for(const bar of [...snapshot.oneMinuteBars,...snapshot.fiveMinuteBars])delete bar.interpolated;
  const result=capture(folder,snapshot);assert.equal(result.captured,1);const record=JSON.parse(readFileSync(join(folder,'research-journal.jsonl'),'utf8').trim());
  assert.equal(record.one_minute_bars.at(-1).interpolated,null);assert.equal(record.shadow_comparison.reason,'both_variants_confirmed');
  assert.equal(record.candle_quality.one_minute.verification_basis,'inferred_positive_broker_volume');
  assert.equal(record.candle_quality.one_minute.usable,true);assert.equal(journal(folder)[0].latest_five_minute_bar.interpolated,null);
});
test('actual scanner output feeds a prospective research baseline automatically using only fake read tools',async t=>{
  const folder=fixture(t),snapshot=evidence();
  const scan=scanSetups({oneMinuteBars:snapshot.oneMinuteBars,fiveMinuteBars:snapshot.fiveMinuteBars,now:new Date(NOW),qqqPrice:499.7,
    explicitReferences:[{direction:'put',level:500,established_at:'2026-10-09T13:45:00Z',rationale:'Previously known explicit level for the deterministic offline fixture.'}]});
  assert.equal(scan.status,'complete');assert.ok(scan.candidates.length>0);
  const captured=captureCandidateObservations({folder,...snapshot,candidates:scan.candidates});assert.ok(captured.captured>0);
  assert.ok(Object.values(readResearchState(folder).cases).every(item=>item.first_observed_at===at(NOW)&&item.primary_instrument_id===null));
  writeFileSync(join(folder,'policy.json'),JSON.stringify({schema_version:1,policy_id:'qqq-1dte-risk',revision:1,approved:true,recorded_at:at(NOW),...DEFAULT_RISK_POLICY}));
  const sampleAt=NOW+1000,ID='11111111-1111-4111-8111-111111111111',CHAIN='cccccccc-cccc-4ccc-8ccc-cccccccccccc',sent=[];
  const broker={read:async(name,args,options)=>{options.beforeSend();sent.push(name);
    if(name==='get_equity_quotes')return {results:[{quote:{...snapshot.qqq,venue_last_trade_time:at(sampleAt)}}]};
    if(name==='get_option_chains')return {chains:[{id:CHAIN,symbol:'QQQ',trade_value_multiplier:'100',expiration_dates:['2026-10-12']}]};
    if(name==='get_option_instruments')return {instruments:[{id:ID,chain_id:CHAIN,chain_symbol:'QQQ',expiration_date:'2026-10-12',type:args.type,state:'active',tradability:'tradable',trade_value_multiplier:'100',strike_price:args.strike_price}]};
    if(name==='get_option_quotes')return {results:[{quote:{instrument_id:ID,bid_price:'1.95',ask_price:'2',bid_size:10,ask_size:10,updated_at:at(sampleAt),delta:'-.48',theta:'-.2'}}]};
    throw Error('Mutation or unexpected tool');}};
  const priced=await collectResearchTick({folder,broker,clock:()=>sampleAt});assert.equal(priced.priced_cases,1);
  assert.deepEqual(sent,['get_equity_quotes','get_option_chains','get_option_instruments','get_option_quotes']);
  const item=Object.values(readResearchState(folder).cases).find(item=>item.primary_instrument_id===ID);assert.equal(item.bases.case.reference_observed_at,at(sampleAt));
  assert.equal(item.first_observed_at,at(NOW));assert.equal(item.live_qualified_seen,false);assert.notEqual(item.baseline_selection_context.entry_gate.status,'qualified');
});
test('returning to an earlier scanner state is a meaningful current transition, not a permanent historical duplicate',t=>{
  const folder=fixture(t),snapshot=evidence();capture(folder,snapshot);
  const blocked=structuredClone(snapshot);blocked.now+=1000;blocked.qqq.venue_last_trade_time=at(blocked.now);blocked.record.qualified=false;blocked.record.reason='Current QQQ is back across the setup reference';
  assert.equal(capture(folder,blocked).captured,1);
  const restored=structuredClone(snapshot);restored.now+=2000;restored.qqq.venue_last_trade_time=at(restored.now);
  assert.equal(capture(folder,restored).captured,1);assert.equal(journal(folder).length,3);assert.equal(journal(folder).at(-1).scanner_qualified,true);
  assert.equal(readResearchState(folder).created_cases,1);assert.equal(capture(folder,restored).duplicate_transitions,1);
});
test('missing or unusable 1m evidence preserves valid 5m structure as metadata only, without a fabricated research case',t=>{
  for(const mode of ['null','empty','stale','gap']){
    const folder=fixture(t),snapshot=evidence();snapshot.record.qualified=false;snapshot.record.latest_one_minute_qualified=false;snapshot.record.reentry_qualified=null;
    snapshot.record.reason='Actual one-minute evidence is unavailable; scanner blocks follow-through';
    if(mode==='null'){snapshot.oneMinuteBars=null;snapshot.record.candidate.confirmation_1m_at=null;}
    if(mode==='empty'){snapshot.oneMinuteBars=[];snapshot.record.candidate.confirmation_1m_at=null;}
    if(mode==='stale'){snapshot.oneMinuteBars=snapshot.oneMinuteBars.slice(0,7);snapshot.record.candidate.confirmation_1m_at=snapshot.oneMinuteBars.at(-1).begins_at;}
    if(mode==='gap')snapshot.oneMinuteBars.splice(8,1);
    const result=capture(folder,snapshot);assert.equal(result.captured,1);assert.equal(result.metadata_only,1);assert.equal(result.research_events,0);assert.equal(result.queued,0);
    assert.equal(readResearchState(folder).created_cases,0);assert.equal(existsSync(join(folder,'research-journal.jsonl')),false);assert.equal(existsSync(join(folder,'research-collector-queue.json')),false);
    const event=journal(folder)[0];assert.equal(event.case_id,null);assert.match(event.candidate_id,/^[a-f0-9]{64}$/);assert.equal(event.research_skipped,true);
    assert.equal(event.latest_one_minute_bar,null);assert.equal(event.latest_five_minute_bar.begins_at,snapshot.fiveMinuteBars.at(-1).begins_at);
    assert.equal(event.scanner_reason,snapshot.record.reason);assert.equal(event.entry_gate.status,'blocked');assert.equal(event.live_qualified,false);
    assert.equal(event.confirmation_1m_at,snapshot.record.candidate.confirmation_1m_at);assert.equal(capture(folder,snapshot).duplicate_transitions,1);
  }
});
test('metadata-only fallback cannot turn invalid five-minute structure into a captured candidate',t=>{
  const folder=fixture(t),snapshot=evidence();snapshot.oneMinuteBars=null;snapshot.record.candidate.confirmation_1m_at=null;snapshot.record.qualified=false;snapshot.record.latest_one_minute_qualified=false;
  snapshot.fiveMinuteBars[2].close_price='500.2';const result=capture(folder,snapshot);assert.equal(result.captured,0);assert.equal(result.metadata_only,0);assert.equal(existsSync(join(folder,'journal.jsonl')),false);
});
test('later actual usable 1m data creates a new current research observation, never backdating the metadata-only record',t=>{
  const folder=fixture(t),missing=evidence();missing.oneMinuteBars=null;missing.record.candidate.confirmation_1m_at=null;missing.record.qualified=false;missing.record.latest_one_minute_qualified=false;missing.record.reason='One-minute broker data unavailable';
  assert.equal(capture(folder,missing).metadata_only,1);
  const actual=evidence();actual.now+=1000;actual.qqq.venue_last_trade_time=at(actual.now);const result=capture(folder,actual);assert.equal(result.research_events,1);assert.equal(result.metadata_only,0);
  assert.equal(readResearchState(folder).created_cases,1);assert.equal(Object.values(readResearchState(folder).cases)[0].first_observed_at,at(actual.now));
  const events=journal(folder);assert.equal(events.length,2);assert.equal(events[0].research_skipped,true);assert.equal(events[1].research_skipped,false);assert.equal(events[0].confirmation_1m_at,null);
});
