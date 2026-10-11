import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AT, ID, setup, quote, bar, iso } from './research-fixtures.mjs';
import { recordResearchEvent, readResearchState, dueResearchScalps } from './research-record.mjs';
import { validateResearchEvent } from './research-policy.mjs';
import { collectResearchTick } from './research-collector-policy.mjs';
import { DEFAULT_RISK_POLICY } from './risk-policy.mjs';

const BASE=Date.parse(AT),stamp=seconds=>new Date(BASE+seconds*1000).toISOString();
function fixture(t){
  const folder=mkdtempSync(join(tmpdir(),'qqq-scalp-research-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const id=recordResearchEvent(setup(),{folder,now:BASE}).case_id;
  writeFileSync(join(folder,'policy.json'),JSON.stringify({schema_version:1,policy_id:'qqq-1dte-risk',revision:2,approved:true,recorded_at:AT,...DEFAULT_RISK_POLICY}));
  return {folder,id};
}
function event(id,seconds,horizon=null,extra={}){
  const at=stamp(seconds);
  return {version:1,event_kind:'scalp_observation',observed_at:at,source:'robinhood_trading_mcp',case_id:id,direction:'put',trade_id:null,
    qqq_quote:{price:499,last_trade_at:at},selected_contract:quote(at,ID,{bid:2.2,ask:2.25}),alternatives:[],basis_id:'case',horizon_seconds:horizon,...extra};
}
function health(folder,seconds){writeFileSync(join(folder,'health.json'),JSON.stringify({at:stamp(seconds),version:'2.4.0',status:'idle',live:true}));}
function fake(seconds,{before,quoteAt=stamp(seconds),bid='2.2'}={}){
  const sent=[];return {sent,broker:{read:async(name,args,options)=>{
    before?.(name);options.beforeSend();sent.push({name,args,options});
    if(name==='get_equity_quotes')return {results:[{quote:{symbol:'QQQ',state:'active',has_traded:true,last_trade_price:'499',venue_last_trade_time:stamp(seconds)}}]};
    if(name==='get_option_chains')return {chains:[{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',symbol:'QQQ',trade_value_multiplier:'100',expiration_dates:['2026-10-09']}]};
    if(name==='get_option_instruments')return {instruments:[{id:ID,chain_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',chain_symbol:'QQQ',type:args.type,
      expiration_date:args.expiration_dates,state:'active',tradability:'tradable',trade_value_multiplier:'100',strike_price:args.strike_price}]};
    if(name==='get_option_quotes')return {results:args.instrument_ids.map(id=>({quote:{instrument_id:id,bid_price:bid,ask_price:String(Number(bid)+.05),bid_size:10,ask_size:10,updated_at:quoteAt,delta:'-.5',theta:'-.2'}}))};
    throw Error('Unexpected research tool');
  }}};
}
test('actual 10-second path freezes baseline ask and captures sparse ask-to-bid extrema without fills',t=>{
  const f=fixture(t);
  for(const [seconds,bid] of [[10,1.8],[20,2.1],[30,2.3],[60,2.5],[120,2.1]])recordResearchEvent(event(f.id,seconds,[30,60,120].includes(seconds)?seconds:null,{selected_contract:quote(stamp(seconds),ID,{bid,ask:bid+.05})}),{folder:f.folder,now:BASE+seconds*1000});
  const basis=readResearchState(f.folder).cases[f.id].bases.case,series=basis.scalp.instruments[ID];
  assert.equal(series.reference_ask,2);assert.equal(series.samples.length,6);
  assert.equal(series.ask_to_bid_mfe_dollars,50);assert.ok(Math.abs(series.ask_to_bid_mae_dollars-20)<1e-8);
  assert.equal(series.coverage.observed_grid_slot_count,6);assert.equal(series.coverage.grid_coverage_fraction,6/13);
  assert.equal(series.coverage.max_observed_gap_seconds,60);assert.equal(series.coverage.large_gap_count,2);
  for(const horizon of [30,60,120]){
    const point=basis.scalp.horizons[horizon];assert.equal(point.actual_elapsed_seconds,horizon);assert.equal(point.delay_seconds,0);
    assert.equal(point.quoted_movements[ID].reference_quote_at,AT);assert.equal(point.quoted_movements[ID].actual_quote_elapsed_seconds,horizon);
    assert.match(point.interpretation,/neither price is an assumed fill/);
  }
});
test('optional alternatives retain actual endpoint comparisons while the primary path stays bounded',t=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-scalp-alternatives-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const alternative='22222222-2222-4222-8222-222222222222';
  const id=recordResearchEvent(setup(AT,{alternatives:[quote(AT,alternative,{strike:499})]}),{folder,now:BASE}).case_id;
  recordResearchEvent(event(id,30,30,{alternatives:[quote(stamp(30),alternative,{strike:499,bid:2.4,ask:2.45})]}),{folder,now:BASE+30000});
  const scalp=readResearchState(folder).cases[id].bases.case.scalp;
  assert.deepEqual(Object.keys(scalp.instruments),[ID]);assert.ok(scalp.horizons['30'].quoted_movements[alternative]);
  assert.ok(Math.abs(scalp.horizons['30'].quoted_movements[alternative].bid_minus_reference_ask_per_contract-40)<1e-8);
});
function earlyInput(extra={}){
  const original=setup();
  return {version:1,event_kind:'early_break',observed_at:AT,source:'robinhood_trading_mcp',case_id:null,direction:'put',trade_id:null,
    qqq_quote:original.qqq_quote,selected_contract:null,alternatives:[],one_minute_bars:original.one_minute_bars,five_minute_bars:original.five_minute_bars,
    early_setup:{reference_level:499.8,break_bar_at:iso(55),break_completed_at:iso(60),latest_completed_1m_at:iso(59),reference_kind:'prior_5m_close',reference_established_at:iso(55),live_qualified:false},...extra};
}
test('early-break research preserves a real completed break without fictional later confirmation',t=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-early-research-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const saved=recordResearchEvent(earlyInput(),{folder,now:BASE}),item=readResearchState(folder).cases[saved.case_id];
  assert.equal(item.first_event_kind,'early_break');assert.deepEqual(item.setup_evidence,{reference_level:499.8,break_bar_at:iso(55)});
  assert.equal(item.early_setup_evidence.live_qualified,false);assert.equal(item.bases.case.reference_observed_at,null);
  assert.equal(item.setup_evidence.confirm_bar_at,undefined);assert.equal(item.live_qualified_seen,false);
});
test('early-break schema rejects hindsight references, false live qualification and an uncompleted or mismatched break',()=>{
  for(const change of [{reference_established_at:iso(56)},{live_qualified:true},{break_completed_at:iso(61)},{reference_level:499.9},{latest_completed_1m_at:iso(58)},{break_bar_at:iso(50),break_completed_at:iso(55)}]){
    const input=earlyInput();input.early_setup={...input.early_setup,...change};assert.throws(()=>validateResearchEvent(input,BASE));
  }
  const explicit=earlyInput();explicit.early_setup={...explicit.early_setup,reference_kind:'explicit_plan',reference_level:499.75,reference_established_at:iso(50)};
  assert.equal(validateResearchEvent(explicit,BASE).early_setup.reference_kind,'explicit_plan');
});
test('collector can prospectively price an early-break-only case while keeping live eligibility unknown',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-early-price-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const saved=recordResearchEvent(earlyInput(),{folder,now:BASE});
  writeFileSync(join(folder,'policy.json'),JSON.stringify({schema_version:1,policy_id:'qqq-1dte-risk',revision:2,approved:true,recorded_at:AT,...DEFAULT_RISK_POLICY}));
  health(folder,10);const {broker,sent}=fake(10);const result=await collectResearchTick({folder,broker,clock:()=>BASE+10000});
  assert.equal(result.priced_cases,1);assert.equal(sent.filter(row=>row.name==='get_option_quotes').length,1);
  const item=readResearchState(folder).cases[saved.case_id];assert.equal(item.first_event_kind,'early_break');assert.equal(item.bases.case.reference_observed_at,stamp(10));
  assert.equal(item.baseline_selection_context.entry_gate.status,'unknown');assert.equal(item.live_qualified_seen,false);
});
test('strict scalp schema rejects fabricated horizon, missing quote, unknown fields and unknown case',t=>{
  const f=fixture(t);
  for(const input of [event(f.id,30,5),event(f.id,30,30,{selected_contract:null}),event(f.id,30,30,{horizon_minutes:.5})])assert.throws(()=>validateResearchEvent(input,BASE+30000));
  assert.throws(()=>recordResearchEvent(event('f'.repeat(64),30,30),{folder:f.folder,now:BASE+30000}),/existing research case/);
  assert.equal(readResearchState(f.folder).recorded_events,1);
});
test('scalp endpoints cannot be backfilled or mislabeled with a cached pre-target quote',t=>{
  const f=fixture(t);
  for(const [seconds,horizon,updated] of [[29,30,stamp(29)],[50,30,stamp(50)],[31,30,stamp(29)],[140,120,stamp(140)]]){
    assert.throws(()=>recordResearchEvent(event(f.id,seconds,horizon,{selected_contract:quote(updated)}),{folder:f.folder,now:BASE+seconds*1000}),/window|precedes/);
  }
  assert.throws(()=>recordResearchEvent(event(f.id,121,null),{folder:f.folder,now:BASE+121000}),/window/);
  recordResearchEvent(event(f.id,35,30),{folder:f.folder,now:BASE+35000});
  const point=readResearchState(f.folder).cases[f.id].bases.case.scalp.horizons['30'];assert.equal(point.delay_seconds,5);
  assert.throws(()=>recordResearchEvent(event(f.id,36,30),{folder:f.folder,now:BASE+36000}),/already recorded/);
  assert.equal(readResearchState(f.folder).recorded_events,2);
});
test('a missing early endpoint remains missing while the 60-second endpoint can still record',t=>{
  const f=fixture(t),due=dueResearchScalps(f.folder,{now:BASE+60000});
  assert.equal(due.due[0].horizon_seconds,60);assert.deepEqual(due.expired[0].missed_horizons_seconds,[30]);
  recordResearchEvent(event(f.id,60,60),{folder:f.folder,now:BASE+60000});
  const basis=readResearchState(f.folder).cases[f.id].bases.case;assert.equal(basis.scalp.horizons['30'],undefined);assert.ok(basis.scalp.horizons['60']);
  const later=dueResearchScalps(f.folder,{now:BASE+140000});assert.deepEqual(later.expired[0].missed_horizons_seconds,[30,120]);assert.equal(later.due.length,0);
});
test('legacy version-one records stay readable without assuming a retrospective sampled path',t=>{
  const f=fixture(t),path=join(f.folder,'research-state.json'),state=readResearchState(f.folder);
  for(const basis of Object.values(state.cases[f.id].bases))delete basis.scalp;
  writeFileSync(path,JSON.stringify(state));assert.equal(readResearchState(f.folder).cases[f.id].bases.case.reference_observed_at,AT);
  const due=dueResearchScalps(f.folder,{now:BASE+30000});assert.equal(due.due[0].horizon_seconds,30);
  recordResearchEvent(event(f.id,30,30),{folder:f.folder,now:BASE+30000});
  const series=readResearchState(f.folder).cases[f.id].bases.case.scalp.instruments[ID];assert.equal(series.samples.length,2);
  assert.equal(series.coverage.grid_coverage_fraction,2/13);assert.equal(series.reference_quote_at,AT);
});
test('collector uses one bounded batched short-horizon read and retains longer-horizon planner',async t=>{
  const f=fixture(t);
  for(const seconds of [10,20,30,40,50,60,70,80,90,100,110,120]){
    health(f.folder,seconds);const {broker,sent}=fake(seconds);const result=await collectResearchTick({folder:f.folder,broker,clock:()=>BASE+seconds*1000});
    assert.equal(result.status,'collected');assert.equal(result.scalp_observations,2);assert.equal(result.followups,0);
    assert.deepEqual(sent.map(row=>row.name),['get_equity_quotes','get_option_quotes']);
    assert.ok(sent.every(row=>row.options.lockTimeoutMs===0&&row.options.timeoutMs<=2000&&row.options.maxTotalTimeoutMs<=2500));
    assert.ok(sent[1].args.instrument_ids.length<=5);
  }
  let basis=readResearchState(f.folder).cases[f.id].bases.case;assert.equal(basis.scalp.instruments[ID].samples.length,13);
  assert.deepEqual(Object.keys(basis.scalp.horizons),['30','60','120']);
  health(f.folder,300);const {broker}=fake(300);const result=await collectResearchTick({folder:f.folder,broker,clock:()=>BASE+300000});
  assert.equal(result.followups,2);basis=readResearchState(f.folder).cases[f.id].bases.case;assert.ok(basis.horizons['5']);
});
test('unchanged or pre-target quote does not masquerade as a fresh endpoint',async t=>{
  const f=fixture(t);health(f.folder,30);let b=fake(30,{quoteAt:stamp(29)});
  await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>BASE+30000});
  let basis=readResearchState(f.folder).cases[f.id].bases.case;assert.equal(basis.scalp.horizons['30'],undefined);assert.equal(basis.scalp.instruments[ID].samples.at(-1).quote_at,stamp(29));
  health(f.folder,31);b=fake(31,{quoteAt:stamp(29)});const result=await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>BASE+31000});
  assert.equal(result.scalp_observations,0);assert.equal(readResearchState(f.folder).cases[f.id].bases.case.scalp.horizons['30'],undefined);
});
test('armed state and an inside-lock race suppress short-horizon reads before SDK dispatch',async t=>{
  for(const race of [false,true]){
    const f=fixture(t);health(f.folder,30);
    if(!race)writeFileSync(join(f.folder,'arm.json'),'{}');
    const {broker,sent}=fake(30,{before:()=>{if(race)writeFileSync(join(f.folder,'arm.json'),'{}');}});
    const result=await collectResearchTick({folder:f.folder,broker,clock:()=>BASE+30000});
    assert.equal(result.reason,'live_trade_priority');assert.equal(sent.length,0);assert.equal(readResearchState(f.folder).recorded_events,1);
  }
});
test('missed short windows record one explicit gap per basis and horizon with no quote read or backfill',async t=>{
  const f=fixture(t);health(f.folder,140);let b=fake(140),result=await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>BASE+140000});
  assert.equal(result.gaps,6);assert.equal(b.sent.length,0);
  const journal=readFileSync(join(f.folder,'research-collector-journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(journal.every(row=>[30,60,120].includes(row.horizon_seconds)&&row.reason==='actual_scalp_sampling_window_missed_no_quote_backfill'));
  result=await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>BASE+140000});assert.equal(result.gaps,0);
  assert.equal(Object.keys(readResearchState(f.folder).cases[f.id].bases.case.scalp.horizons).length,0);
});

test('bounded read latency does not turn fixed ten-second starts into twenty-second paths',async t=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-scalp-latency-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const baseline=stamp(.8),id=recordResearchEvent(setup(baseline),{folder,now:BASE+800}).case_id;
  writeFileSync(join(folder,'policy.json'),JSON.stringify({schema_version:1,policy_id:'qqq-1dte-risk',revision:2,approved:true,recorded_at:AT,...DEFAULT_RISK_POLICY}));
  for(const seconds of [10,20,30,40,50,60,70,80,90,100,110,120]){
    let now=BASE+seconds*1000;health(folder,seconds);
    const broker={read:async(name,args,options)=>{
      options.beforeSend();now+=400;
      if(name==='get_equity_quotes')return {results:[{quote:{symbol:'QQQ',state:'active',has_traded:true,last_trade_price:'499',venue_last_trade_time:new Date(now).toISOString()}}]};
      if(name==='get_option_quotes')return {results:args.instrument_ids.map(instrument_id=>({quote:{instrument_id,bid_price:'2.2',ask_price:'2.25',bid_size:10,ask_size:10,updated_at:new Date(now).toISOString(),delta:'-.5',theta:'-.2'}}))};
      throw Error('Unexpected research tool');
    }};
    const result=await collectResearchTick({folder,broker,clock:()=>now});
    assert.equal(result.status,'collected');assert.equal(result.scalp_observations,2);
  }
  const basis=readResearchState(folder).cases[id].bases.case;
  const samples=basis.scalp.instruments[ID].samples;
  assert.equal(samples.length,13);
  assert.ok(samples.every((sample,index)=>!index||Date.parse(sample.observed_at)-Date.parse(samples[index-1].observed_at)===10000));
  for(const seconds of [30,60,120]){
    assert.equal(basis.scalp.horizons[seconds].actual_elapsed_seconds,seconds);
    assert.equal(basis.scalp.horizons[seconds].quoted_movements[ID].actual_quote_elapsed_seconds,seconds);
  }
});

test('scheduling lead reads retain actual-time endpoint and first-path boundaries',async t=>{
  const f=fixture(t);
  health(f.folder,8);let b=fake(8);let result=await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>BASE+8000});
  assert.equal(b.sent.length,2);assert.equal(result.scalp_observations,0);
  health(f.folder,28);b=fake(28,{quoteAt:stamp(30)});
  result=await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>BASE+28000});
  assert.equal(result.status,'collected');
  const basis=readResearchState(f.folder).cases[f.id].bases.case;
  assert.equal(basis.scalp.horizons['30'],undefined);
  assert.equal(basis.scalp.instruments[ID].samples.at(-1).observed_at,stamp(28));
});
