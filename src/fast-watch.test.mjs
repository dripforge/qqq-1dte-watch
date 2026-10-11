import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { prepareAgentEntryWatch, cancelAgentEntryWatch } from './entry-watch.mjs';
import { runFastWatchCycle, dispatchExistingEntry } from './fast-watch.mjs';
import { assessEntryWatchPlan } from './entry-watch-plan.mjs';
import { loadApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { durableJson, readLocalJson } from './entry-watch-runtime.mjs';

const NOW=Date.parse('2026-10-09T14:15:02Z'),stamp=value=>new Date(value).toISOString();
const ID='00000000-0000-4000-8000-000000000001';
const policy={schema_version:1,policy_id:'qqq-1dte-risk',revision:2,approved:true,recorded_at:'2026-10-08T22:47:04Z',
  per_trade_risk_fraction:.7,daily_loss_fraction:.5,absolute_daily_loss:250,emergency_stop_fraction:.25,
  execution_cushion:1,opening_premium_ceiling:325};
const bar=(at,o,h,l,c)=>({begins_at:at,open_price:String(o),high_price:String(h),low_price:String(l),close_price:String(c),interpolated:false,session:'reg'});
const five=()=>[bar('2026-10-09T13:55:00.000Z',99,100,98,99),bar('2026-10-09T14:00:00.000Z',99,101,99,100.5),
  bar('2026-10-09T14:05:00.000Z',100.5,101.5,100.2,101),bar('2026-10-09T14:10:00.000Z',101,101.6,100.7,101.2)];
const minute=()=>{const bars=Array.from({length:10},(_,i)=>bar(stamp(NOW-602000+i*60000),101,101.4,100.8,101.1));
  bars[9]=bar(bars[9].begins_at,101.1,101.4,101,101.3);return bars;};
const quote=()=>({symbol:'QQQ',state:'active',has_traded:true,last_trade_price:'101.3',venue_last_trade_time:stamp(NOW-1000)});
const input=()=>({version:1,option_id:ID,direction:'call',expiration:'2026-10-12',qqq_invalidation:100.6,
  setup:{version:1,direction:'call',pattern:'break_hold',break_bar_at:'2026-10-09T14:00:00.000Z',confirm_bar_at:'2026-10-09T14:05:00.000Z',level:100,rationale:'Completed breakout held; remaining room before the next resistance supports this entry'},
  profit_protection:{version:1,mode:'trend',rationale:'Completed structure supports a sustained trend with room before opposition'}});
function fixture(){const folder=mkdtempSync(join(tmpdir(),'qqq-fast-'));durableJson(folder,'policy.json',policy);
  durableJson(folder,'health.json',{at:stamp(NOW),version:'2.4.0',live:true,status:'idle'});return folder;}
function broker({minutes=minute(),beforeSend}={}){
  const calls=[],mcp={connectReadOnly:async options=>{await options.beforeConnect();return {close:async()=>{}};},
    call:async(client,name,args,options)=>{await beforeSend?.(name);await options.beforeSend();calls.push({name,args,options});
      if(name==='get_equity_quotes')return {results:[{quote:quote()}]};
      if(name==='get_equity_historicals')return {results:[{symbol:'QQQ',interval:args.interval,bounds:'regular',bars:args.interval==='minute'?minutes:five()}]};
      throw Error('Unexpected broker operation');}};
  return {calls,mcpLoader:async()=>mcp};
}
const options=(folder,b)=>({folder,clock:()=>NOW,mcpLoader:b.mcpLoader});
test('real runtime durably consumes an agent plan before exactly one mocked existing-gate dispatch',async()=>{
  const folder=fixture(),b=broker();let dispatches=0;
  try{
    await prepareAgentEntryWatch(input(),options(folder,b));
    const dispatch=async({plan,assessment})=>{dispatches++;
      const state=readLocalJson(folder,'entry-watch-state.json'),history=readLocalJson(folder,'entry-watch-last-attempt.json');
      assert.equal(state.status,'dispatch_started');assert.match(state.activation_evidence_sha256,/^[0-9a-f]{64}$/);
      assert.equal(history.plan_id,plan.plan_id);assert.equal(history.setup_id,assessment.setup.setup_id);
      return {status:'entry_gate_completed',exit_code:0,reason:'Mocked gate completed; no broker writes performed'};};
    const result=await runFastWatchCycle({...options(folder,b),dispatch});
    assert.equal(result.entry_dispatched,true);assert.equal(readLocalJson(folder,'entry-watch-state.json').status,'completed');
    await runFastWatchCycle({...options(folder,b),dispatch});assert.equal(dispatches,1);
    assert.ok(b.calls.every(c=>['get_equity_historicals','get_equity_quotes'].includes(c.name)));
    assert.ok(b.calls.every(c=>c.options.lockTimeoutMs===0&&c.options.maxTotalTimeoutMs<=2500));
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('pending one-minute direction waits while automatically capturing truthful blocked comparisons',async()=>{
  const folder=fixture(),pending=minute();pending[9]=bar(pending[9].begins_at,101.1,101.2,100.7,100.8);const b=broker({minutes:pending});
  try{
    await prepareAgentEntryWatch(input(),options(folder,b));
    const result=await runFastWatchCycle({...options(folder,b),dispatch:()=>{throw Error('Must not dispatch');}});
    assert.equal(result.setup_review_version,'1.0.0');
    assert.equal(result.plan_status,'waiting');assert.equal(result.entry_dispatched,false);
    assert.equal(readLocalJson(folder,'entry-watch-state.json').status,'prepared');
    assert.ok(existsSync(join(folder,'research-journal.jsonl')));
    const events=readFileSync(join(folder,'research-journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(events.every(e=>(e.setup?.live_qualified===false||e.early_setup?.live_qualified===false)&&e.selected_contract===null));
    assert.ok(readFileSync(join(folder,'journal.jsonl'),'utf8').includes('directional follow-through'));
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('live trade state wins before reads and again inside broker access',async()=>{
  for(const inside of [false,true]){
    const folder=fixture(),b=broker({beforeSend:inside?()=>durableJson(folder,'arm.json',{option_id:ID}):undefined});
    try{
      if(!inside)durableJson(folder,'arm.json',{option_id:ID});
      const result=await runFastWatchCycle({...options(folder,b),dispatch:()=>{throw Error('Must not dispatch');}});
      assert.equal(result.reason,'live_trade_priority');assert.equal(b.calls.length,0);
    }finally{rmSync(folder,{recursive:true,force:true});}
  }
});
test('interrupted dispatch remains consumed and cannot be cancelled or replayed',async()=>{
  const folder=fixture(),b=broker();let attempts=0;
  try{
    const prepared=await prepareAgentEntryWatch(input(),options(folder,b));
    const dispatch=async()=>{attempts++;throw Error('Simulated parent interruption after durable claim');};
    await runFastWatchCycle({...options(folder,b),dispatch});
    assert.equal(readLocalJson(folder,'entry-watch-state.json').status,'dispatch_started');
    assert.throws(()=>cancelAgentEntryWatch(prepared.plan_id,'Original plan cannot be replayed',{folder,now:NOW}),/already attempted/);
    await runFastWatchCycle({...options(folder,b),dispatch});assert.equal(attempts,1);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('unsent plan cancellation changes only local instructions and keeps reviewable history',async()=>{
  const folder=fixture(),b=broker();
  try{
    const prepared=await prepareAgentEntryWatch(input(),options(folder,b));
    await assert.rejects(()=>prepareAgentEntryWatch(input(),options(folder,b)),/already pending/);
    const count=b.calls.length;cancelAgentEntryWatch(prepared.plan_id,'Completed structure no longer supports this trade',{folder,now:NOW});
    assert.equal(b.calls.length,count);assert.equal(existsSync(join(folder,'entry-watch-plan.json')),false);
    assert.ok(existsSync(join(folder,'entry-watch-history',`${prepared.plan_id}.json`)));
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('bounded child timeout is outcome unknown and retains exact evidence and plan arguments',async()=>{
  const folder=fixture(),b=broker();let killed=false,args;
  try{
    await prepareAgentEntryWatch(input(),options(folder,b));const plan=readLocalJson(folder,'entry-watch-plan.json');
    const assessment=assessEntryWatchPlan({plan,state:readLocalJson(folder,'entry-watch-state.json'),policySnapshot:loadApprovedRiskPolicy(folder).snapshot,
      now:NOW,health:readLocalJson(folder,'health.json'),localState:{trade_state_present:false,entry_busy:false},
      qqqQuote:quote(),fiveMinuteBars:five(),oneMinuteBars:minute()});
    const result=await dispatchExistingEntry({folder,plan,assessment,clock:()=>NOW,timeoutMs:1,
      spawnImpl:(node,argv)=>{args=argv;const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{killed=true;};return child;}});
    assert.equal(result.status,'outcome_unknown');assert.equal(killed,true);
    assert.deepEqual(args.slice(1,5),[ID,'call','2026-10-12','100.6']);
    assert.deepEqual(args.slice(-2),['--entry-watch-plan',plan.plan_id]);
    assert.equal(readLocalJson(folder,`entry-watch-evidence-${plan.plan_id}.json`).confirmation_1m_at,minute().at(-1).begins_at);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test('only a confirmed dead process lock can be recovered, without clearing any unresolved intent',async()=>{
  const pid=Number(spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'}).stdout);
  assert.ok(pid>0);
  for(const unresolved of [false,true]){
    const folder=fixture(),b=broker();
    try{
      durableJson(folder,'entry.lock',{pid,token:'finished-child',at:stamp(NOW)});
      if(unresolved)durableJson(folder,'entry-intent.json',{ref_id:ID,dispatch_phase:'outcome_unknown'});
      const result=await runFastWatchCycle(options(folder,b));
      if(unresolved){assert.equal(result.reason,'live_trade_priority');assert.ok(existsSync(join(folder,'entry.lock')));
        assert.ok(existsSync(join(folder,'entry-intent.json')));assert.equal(b.calls.length,0);}
      else{assert.equal(existsSync(join(folder,'entry.lock')),false);assert.equal(b.calls.length,3);}
    }finally{rmSync(folder,{recursive:true,force:true});}
  }
});

test('research context uses session-open bars and extra history follows core reads, yielding to pending plans',async()=>{
  const full=Array.from({length:45},(_,i)=>({...bar(stamp(Date.parse('2026-10-09T13:30:00Z')+i*60000),101,101.4,100.8,101.1),volume:100}));
  full[44]={...bar(full[44].begins_at,101.1,101.4,101,101.3),volume:100};
  for(const pending of [false,true]){
    const folder=fixture(),minutes=full.map(b=>({...b}));
    if(pending)minutes[44]={...bar(minutes[44].begins_at,101.1,101.2,100.7,100.8),volume:100};
    const b=broker({minutes});
    try{
      if(pending)await prepareAgentEntryWatch(input(),options(folder,b));
      const first=b.calls.length,result=await runFastWatchCycle({...options(folder,b),dispatch:()=>{throw Error('No ready dispatch expected');}});
      const cycle=b.calls.slice(first);assert.equal(cycle[0].args.start_time,'2026-10-09T13:30:00.000Z');
      assert.equal(cycle[1].args.start_time,'2026-10-09T13:30:00.000Z');assert.equal(cycle[2].name,'get_equity_quotes');
      assert.equal(readLocalJson(folder,'market-context-latest.json').vwap.status,'available');
      if(pending){assert.equal(cycle.length,3);assert.equal(result.history.reason,'pending_entry_plan_priority');}
      else{assert.equal(cycle.length,4);assert.ok(cycle[3].args.end_time);assert.equal(result.history.status,'unavailable');}
      const rows=readFileSync(join(folder,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.ok(rows.some(row=>row.event==='candidate_capture'&&row.market_context?.live_filter===false));
    }finally{rmSync(folder,{recursive:true,force:true});}
  }
});
