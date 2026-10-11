import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AT,ID,TRADE,setup,quote} from './research-fixtures.mjs';
import {recordResearchEvent,readResearchState,dueResearchFollowups} from './research-record.mjs';
import {validateResearchEvent} from './research-policy.mjs';
import {collectResearchTick as collectTick,enqueueResearchCase,researchSelectionContext,RESEARCH_READ_TOOLS} from './research-collector-policy.mjs';
import {runResearchCollectorCycle,runResearchCollector} from './research-collector.mjs';
import {DEFAULT_RISK_POLICY} from './risk-policy.mjs';

const BASE=Date.parse(AT),CHAIN='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const stamp=ms=>new Date(ms).toISOString();
function idleHealth(folder,now=BASE){writeFileSync(join(folder,'health.json'),JSON.stringify({at:stamp(now),version:'2.3.0',status:'idle',live:true}));}
function collectResearchTick(options){idleHealth(options.folder,options.clock());return collectTick(options);}
function fixture(t,{priced=false,extra={}}={}){
  const folder=mkdtempSync(join(tmpdir(),'qqq-research-worker-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  idleHealth(folder);
  writeFileSync(join(folder,'policy.json'),JSON.stringify({schema_version:1,policy_id:'qqq-1dte-risk',revision:2,approved:true,recorded_at:AT,...DEFAULT_RISK_POLICY}));
  const input=setup(AT,{selected_contract:priced?quote():null,...extra});
  const saved=recordResearchEvent(input,{folder,now:BASE});
  return {folder,id:saved.case_id,input};
}
function fake(clock,{before,overrides={}}={}){
  const sent=[];
  const broker={read:async(name,args,options)=>{
    await before?.(name,args,options);options.beforeSend();
    sent.push({name,args,options});const at=stamp(clock());
    const defaults={
      get_equity_quotes:{results:[{quote:{symbol:'QQQ',state:'active',has_traded:true,last_trade_price:'499.7',venue_last_trade_time:at}}]},
      get_option_chains:{chains:[{id:CHAIN,symbol:'QQQ',trade_value_multiplier:'100',expiration_dates:['2026-10-08','2026-10-09','2026-10-12']}]},
      get_option_instruments:{instruments:[{id:ID,chain_id:CHAIN,chain_symbol:'QQQ',expiration_date:args.expiration_dates??'2026-10-09',type:args.type??'put',
        state:'active',tradability:'tradable',trade_value_multiplier:'100',strike_price:args.strike_price??'500.0000'}]},
      get_option_quotes:{results:(args.instrument_ids??[ID]).map(id=>({quote:{instrument_id:id,bid_price:'1.95',ask_price:'2',bid_size:10,ask_size:10,updated_at:at,delta:'-.48',theta:'-.2'}}))}
    };
    const value=overrides[name];return typeof value==='function'?value(defaults[name],args):value??defaults[name];
  }};return {broker,sent};
}
function json(folder,name){return JSON.parse(readFileSync(join(folder,name),'utf8'));}
function baseline(f,at=stamp(BASE+30000)){
  return {version:1,event_kind:'quote_baseline',source:'robinhood_trading_mcp',observed_at:at,case_id:f.id,direction:'put',trade_id:null,
    qqq_quote:{price:499.7,last_trade_at:at},selected_contract:quote(at,ID,{bid:1.95}),alternatives:[],basis_ids:['case','bearish_break_hold'],
    selection_context:{premium_ceiling_dollars:500,cash_snapshot_at:null,affordability:'unknown',entry_gate:{status:'unknown',reason:'Not evaluated.',checked_at:null},post_stop_context:null}};
}

test('later actual baseline preserves original setup and timestamps; duplicates and replacements cannot change it',t=>{
  const f=fixture(t),input=baseline(f),at=Date.parse(input.observed_at);
  recordResearchEvent(input,{folder:f.folder,now:at});
  let item=readResearchState(f.folder).cases[f.id];
  assert.equal(item.first_observed_at,AT);assert.deepEqual(item.setup_evidence,f.input.setup);
  assert.equal(item.bases.case.qualified_at,AT);assert.equal(item.bases.case.reference_observed_at,input.observed_at);
  assert.equal(item.bases.case.reference_contracts[ID].updated_at,input.observed_at);assert.equal(item.bases.case.baseline_delay_minutes,.5);
  const journal=readFileSync(join(f.folder,'research-journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal[0].one_minute_bars.map(bar=>bar.begins_at),f.input.one_minute_bars.map(bar=>bar.begins_at));
  assert.equal(recordResearchEvent(input,{folder:f.folder,now:at}).status,'deduplicated');
  const later=baseline(f,stamp(at+30000));assert.throws(()=>recordResearchEvent(later,{folder:f.folder,now:at+30000}),/already exists/);
  assert.equal(readResearchState(f.folder).recorded_events,2);
  assert.throws(()=>recordResearchEvent({...input,case_id:'f'.repeat(64)},{folder:f.folder,now:at}),/existing research/);
});
test('baseline rejects absent cash provenance, wide books and fabricated post-stop completion',t=>{
  const f=fixture(t),input=baseline(f),at=Date.parse(input.observed_at);
  const absent=structuredClone(input);absent.selection_context.affordability='verified_snapshot';
  assert.throws(()=>validateResearchEvent(absent,at),/affordability/);
  const wide=structuredClone(input);wide.selected_contract.bid=1;assert.throws(()=>validateResearchEvent(wide,at),/liquidity/);
  const post=structuredClone(input);post.selection_context.post_stop_context={prior_trade_id:TRADE,closed_at:stamp(BASE-600000),prior_invalidation:500.5,
    prior_direction:'put',setup_break_bar_at:'2026-10-08T17:50:00Z',setup_break_completed_at:'2026-10-08T17:56:00Z',new_completed_setup:true};
  assert.throws(()=>validateResearchEvent(post,at),/newer completed/);
});
test('collector prices a new case without a cash snapshot, visibly unknown for live affordability and risk',async t=>{
  const f=fixture(t),now=BASE+30000,{broker,sent}=fake(()=>now);
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});
  assert.equal(result.status,'collected');assert.equal(result.priced_cases,1);
  assert.deepEqual(sent.map(call=>call.name),RESEARCH_READ_TOOLS.toSorted((a,b)=>['get_equity_quotes','get_option_chains','get_option_instruments','get_option_quotes'].indexOf(a)-['get_equity_quotes','get_option_chains','get_option_instruments','get_option_quotes'].indexOf(b)));
  assert.equal(sent.filter(call=>call.name==='get_option_quotes').length,1);
  assert.equal(sent[2].args.expiration_dates,'2026-10-09');assert.equal(sent[2].args.type,'put');
  const item=readResearchState(f.folder).cases[f.id];assert.equal(item.baseline_selection_context.affordability,'unknown');
  assert.equal(item.baseline_selection_context.entry_gate.status,'unknown');assert.equal(item.baseline_selection_context.premium_ceiling_dollars,300);
  assert.equal(item.bases.case.reference_observed_at,stamp(now));
  assert.ok(sent.every(call=>call.options.lockTimeoutMs===0&&call.options.timeoutMs<=2000&&call.options.maxTotalTimeoutMs<=2500));
});
test('fresh cash lowers the ceiling; stale cash permits research pricing while marking eligibility unknown',async t=>{
  const f=fixture(t),now=BASE+30000,{broker}=fake(()=>now);
  enqueueResearchCase({case_id:f.id,cash_snapshot:{available_cash_dollars:195,observed_at:stamp(now)}},{folder:f.folder,now});
  const first=await collectResearchTick({folder:f.folder,broker,clock:()=>now});
  assert.equal(first.priced_cases,0);assert.equal(readResearchState(f.folder).cases[f.id].primary_instrument_id,null);
  const later=now+120001,{broker:next}=fake(()=>later);
  const second=await collectResearchTick({folder:f.folder,broker:next,clock:()=>later});assert.equal(second.priced_cases,1);
  assert.equal(readResearchState(f.folder).cases[f.id].baseline_selection_context.affordability,'unknown');
});
test('fresh cash and fresh gate provenance are preserved for a prospective quote',async t=>{
  const f=fixture(t),now=BASE+30000,{broker}=fake(()=>now);
  enqueueResearchCase({case_id:f.id,cash_snapshot:{available_cash_dollars:400,observed_at:stamp(now)},
    entry_gate:{status:'blocked',reason:'Daily loss gate blocked this setup.',checked_at:stamp(now)}},{folder:f.folder,now});
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.priced_cases,1);
  const context=readResearchState(f.folder).cases[f.id].baseline_selection_context;
  assert.equal(context.premium_ceiling_dollars,300);assert.equal(context.affordability,'verified_snapshot');assert.equal(context.entry_gate.status,'blocked');
});
test('old cases expire without broker work or invented baselines, with deduplicated gaps',async t=>{
  const f=fixture(t),now=BASE+900001,{broker,sent}=fake(()=>now);
  for(let i=0;i<2;i++){const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.broker_reads,0);}
  assert.equal(sent.length,0);assert.equal(json(f.folder,'research-collector-state.json').totals.gaps,1);
  const item=readResearchState(f.folder).cases[f.id];assert.equal(item.bases.case.reference_observed_at,null);
  assert.equal(item.primary_instrument_id,null);
});
test('a prior-session setup is never re-priced in the next session',async t=>{
  const f=fixture(t),now=Date.parse('2026-10-09T13:30:02Z'),{broker,sent}=fake(()=>now);
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(sent.length,0);assert.equal(result.gaps,1);
  assert.equal(readResearchState(f.folder).recorded_events,1);
});
test('market closures, unknown calendar and all live intent files skip reads and credentials',async t=>{
  for(const name of ['arm.json','entry-intent.json','exit-intent.json','profit-exit-request.json','profit-plan.json','entry.lock','profit.lock','exit.lock','state.lock','broker.lock','broker-access.lock']){
    const f=fixture(t);writeFileSync(join(f.folder,name),'{}');let imports=0;
    const result=await runResearchCollectorCycle({folder:f.folder,clock:()=>BASE+1000,mcpLoader:async()=>{imports++;throw Error('must not load');}});
    assert.equal(result.status,'skipped');assert.equal(imports,0);assert.ok(['broker_busy','live_trade_priority'].includes(result.reason));
  }
  for(const [date,reason] of [['2026-10-10T18:00:00Z','market_closed'],['2029-01-02T15:00:00Z','calendar_unverified']]){
    const f=fixture(t);let imports=0;
    const result=await runResearchCollectorCycle({folder:f.folder,clock:()=>Date.parse(date),mcpLoader:async()=>{imports++;}});
    assert.equal(result.status,'skipped');assert.equal(result.reason,reason);assert.equal(imports,0);
  }
});
test('new trade state between scheduling and broker lock prevents the read at beforeSend',async t=>{
  const f=fixture(t),now=BASE+30000;
  const {broker,sent}=fake(()=>now,{before:()=>writeFileSync(join(f.folder,'arm.json'),'{}')});
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.status,'skipped');assert.equal(result.reason,'live_trade_priority');
  assert.equal(sent.length,0);assert.equal(readResearchState(f.folder).recorded_events,1);
});
test('fake slow reads exhaust a bounded tick before another read can start',async t=>{
  const f=fixture(t);let now=BASE+30000;
  const {broker,sent}=fake(()=>now,{before:()=>{now+=10001;}});
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.reason,'research_tick_budget_exhausted');assert.equal(sent.length,0);
  assert.equal(readResearchState(f.folder).recorded_events,1);
});
test('incompatible instruments and invalid books cannot establish an option baseline',async t=>{
  for(const change of [{type:'call'},{trade_value_multiplier:'10'},{chain_symbol:'SPY'},{chain_id:ID},{expiration_date:'2026-10-12'},{strike_price:'550.0000'}]){
    const f=fixture(t),now=BASE+30000,{broker}=fake(()=>now,{overrides:{get_option_instruments:data=>({instruments:[{...data.instruments[0],...change}]})}});
    const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.priced_cases,0);assert.equal(readResearchState(f.folder).cases[f.id].primary_instrument_id,null);
  }
  for(const change of [{bid_price:null},{bid_price:''},{bid_price:'NaN'},{ask_price:'1'},{bid_size:0},{ask_size:null},{ask_price:'6',bid_price:'5.95'},{updated_at:stamp(BASE-1000)},{updated_at:stamp(BASE+36000)}]){
    const f=fixture(t),now=BASE+30000,{broker}=fake(()=>now,{overrides:{get_option_quotes:data=>({results:[{quote:{...data.results[0].quote,...change}}]})}});
    const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.priced_cases,0);assert.equal(readResearchState(f.folder).cases[f.id].primary_instrument_id,null);
  }
});
test('invalid underlying quotes stop research before option discovery',async t=>{
  for(const value of [null,'','NaN','0','-1']){
    const f=fixture(t),now=BASE+30000,{broker,sent}=fake(()=>now,{overrides:{get_equity_quotes:data=>({results:[{quote:{...data.results[0].quote,last_trade_price:value}}]})}});
    const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.status,'error');assert.deepEqual(sent.map(item=>item.name),['get_equity_quotes']);
  }
});
test('existing stale contract metadata receives an actual same-instrument quote without changing identity',async t=>{
  const f=fixture(t,{extra:{selected_contract:quote('2026-10-08T17:59:00Z')}}),now=BASE+30000,{broker,sent}=fake(()=>now);
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.priced_cases,1);
  assert.deepEqual(sent.map(call=>call.name),['get_equity_quotes','get_option_quotes']);
  assert.equal(readResearchState(f.folder).cases[f.id].primary_instrument_id,ID);
});
test('actual 5/15/30-minute followups use one batched read and preserve the actual reference time',async t=>{
  const f=fixture(t);let now=BASE+30000;
  let b=fake(()=>now);await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>now});const reference=now;
  for(const horizon of [5,15,30]){now=reference+horizon*60000+30000;b=fake(()=>now);
    const result=await collectResearchTick({folder:f.folder,broker:b.broker,clock:()=>now});assert.ok(result.followups>=1);
    assert.deepEqual(b.sent.map(call=>call.name),['get_equity_quotes','get_option_quotes']);
    const endpoint=readResearchState(f.folder).cases[f.id].bases.case.horizons[horizon];assert.equal(endpoint.actual_elapsed_minutes,horizon+.5);
    assert.equal(endpoint.quoted_movements[ID].reference_quote_at,stamp(reference));assert.match(endpoint.interpretation,/neither price is an assumed fill/);
  }
});
test('missed followup windows create explicit gaps; later observations cannot backfill earlier endpoints',async t=>{
  const f=fixture(t,{priced:true}),now=BASE+31*60000,{broker}=fake(()=>now);
  const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.gaps,10);assert.equal(result.followups,2);
  const basis=readResearchState(f.folder).cases[f.id].bases.case;assert.equal(basis.horizons['5'],undefined);assert.equal(basis.horizons['15'],undefined);assert.ok(basis.horizons['30']);
  const again=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(again.gaps,0);assert.equal(again.followups,0);
});
test('seven due cases produce only one quote batch with at most five instruments',async t=>{
  const f=fixture(t,{priced:true});
  for(let i=2;i<=7;i++){const id=`${i}${'0'.repeat(7)}-1111-4111-8111-${'0'.repeat(11)}${i}`;recordResearchEvent(setup(AT,{selected_contract:quote(AT,id)}),{folder:f.folder,now:BASE});}
  const now=BASE+6*60000,{broker,sent}=fake(()=>now);const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});
  const batch=sent.filter(call=>call.name==='get_option_quotes');assert.equal(batch.length,1);assert.equal(batch[0].args.instrument_ids.length,5);assert.equal(result.followups,10);
  assert.equal(dueResearchFollowups(f.folder,{now}).deferred_due_count,0); // two uncollected cases remain due for the next tick
  assert.equal(dueResearchFollowups(f.folder,{now}).due.length,4);
});
test('root verified stop context evaluates completion after closure, including a bar that began before closure',async t=>{
  const f=fixture(t),now=BASE+30000;
  const last={version:1,closure_verified:true,post_stop:true,trade_id:TRADE,option_id:ID,direction:'put',
    closed_at:'2026-10-08T17:53:00Z',closing_order_id:CHAIN,reason:'broker_emergency_stop',original_qqq_invalidation:500.5};
  writeFileSync(join(f.folder,'last-exit.json'),JSON.stringify(last));
  enqueueResearchCase({case_id:f.id,entry_gate:{status:'qualified',reason:'Actual fresh live gates passed.',checked_at:stamp(now)}},{folder:f.folder,now});
  const {broker}=fake(()=>now);const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.priced_cases,1);
  const context=readResearchState(f.folder).cases[f.id].baseline_selection_context;
  assert.equal(context.post_stop_context.new_completed_setup,true);assert.equal(context.post_stop_context.setup_break_completed_at,'2026-10-08T17:55:00.000Z');
  assert.equal(context.entry_gate.status,'qualified');assert.equal(context.post_stop_context.prior_trade_id,TRADE);
});
test('a setup completed before closure is researched as blocked; yesterday and non-stop closures are ignored',t=>{
  const f=fixture(t),item=readResearchState(f.folder).cases[f.id],now=BASE+30000;
  const last={version:1,closure_verified:true,post_stop:true,trade_id:TRADE,direction:'put',closed_at:'2026-10-08T17:56:00Z',original_qqq_invalidation:500.5};
  let context=researchSelectionContext(item,{entry_gate:{status:'qualified',reason:'Gate check.',checked_at:stamp(now)}},last,now);
  assert.equal(context.post_stop_context.new_completed_setup,false);assert.equal(context.entry_gate.status,'blocked');
  context=researchSelectionContext(item,null,{...last,closed_at:'2026-10-07T17:56:00Z'},now);assert.equal(context.post_stop_context,null);
  context=researchSelectionContext(item,null,{...last,post_stop:false},now);assert.equal(context.post_stop_context,null);
});
test('lazy connection uses only saved-auth read APIs and repeats the trade-state guard inside the SDK lock',async t=>{
  const f=fixture(t),now=BASE+30000,connection=[],{broker,sent}=fake(()=>now);
  const mcp={connectReadOnly:async options=>{connection.push(options);options.beforeConnect();return {close:async()=>{}};},call:async(client,name,args,options)=>broker.read(name,args,options)};
  const result=await runResearchCollectorCycle({folder:f.folder,clock:()=>now,mcpLoader:async()=>mcp});assert.equal(result.priced_cases,1);
  assert.equal(connection.length,1);assert.equal(connection[0].lockTimeoutMs,0);assert.equal(connection[0].timeoutMs,2000);
  assert.ok(sent.every(item=>RESEARCH_READ_TOOLS.includes(item.name)));
  const other=fixture(t);let attempted=0;
  const race={connectReadOnly:async options=>{writeFileSync(join(other.folder,'entry-intent.json'),'{}');options.beforeConnect();attempted++;},call:()=>{throw Error('must not call');}};
  const skipped=await runResearchCollectorCycle({folder:other.folder,clock:()=>now,mcpLoader:async()=>race});assert.equal(skipped.reason,'live_trade_priority');assert.equal(attempted,0);
});
test('one offline runner cycle releases its process lock and records unavailable reads without leaking broker details',async t=>{
  const f=fixture(t),now=BASE+30000;await runResearchCollector({folder:f.folder,once:true,clock:()=>now,mcpLoader:async()=>{throw Error('secret auth text');}});
  assert.equal(existsSync(join(f.folder,'research-collector.lock')),false);
  const status=json(f.folder,'research-collector-status.json');assert.equal(status.status,'error');assert.equal(status.totals.failures,1);assert.equal(JSON.stringify(status).includes('secret'),false);
});
test('research requires fresh live idle monitor health, so unarmed positions and health failure cannot trigger reads',async t=>{
  const now=BASE+30000;
  for(const value of [null,{}, {at:stamp(now-60001),status:'idle',live:true},
    {at:stamp(now+5001),status:'idle',live:true},{at:stamp(now),status:'idle',live:false},
    {at:stamp(now),status:'unarmed_qqq_position',live:true},{at:stamp(now),status:'holding',live:true},
    {at:stamp(now),status:'idle',live:true,data_error:'Unavailable'}, {at:stamp(now),status:'idle',live:true,deadline_exceeded:true}]){
    const f=fixture(t);writeFileSync(join(f.folder,'health.json'),JSON.stringify(value));let imports=0;
    const result=await runResearchCollectorCycle({folder:f.folder,clock:()=>now,mcpLoader:async()=>{imports++;throw Error('must not load');}});
    assert.equal(result.status,'skipped');assert.equal(result.reason,'monitor_idle_unverified');assert.equal(imports,0);
  }
});
test('monitor health and trading locks are rechecked immediately before a read can be sent',async t=>{
  for(const name of ['entry.lock','profit.lock','exit.lock','state.lock','health.json']){
    const f=fixture(t),now=BASE+30000;
    const {broker,sent}=fake(()=>now,{before:()=>writeFileSync(join(f.folder,name),name==='health.json'?JSON.stringify({at:stamp(now),status:'unarmed_qqq_position',live:true}):'{}')});
    const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});assert.equal(result.status,'skipped');
    assert.equal(result.reason,name==='health.json'?'monitor_idle_unverified':'live_trade_priority');assert.equal(sent.length,0);
  }
});


test('collector cannot establish a new baseline above the approved premium limit',async t=>{
 const f=fixture(t),now=BASE+30000;
 const {broker}=fake(()=>now,{overrides:{get_option_quotes:(data)=>({results:data.results.map(row=>({quote:{...row.quote,bid_price:'3.20',ask_price:'3.01'}}))})}});
 const result=await collectResearchTick({folder:f.folder,broker,clock:()=>now});
 assert.equal(result.priced_cases,0);assert.equal(readResearchState(f.folder).cases[f.id].bases.case.reference_observed_at,null);
});
