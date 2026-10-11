import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { acquireProcessLock } from './process-lock.mjs';
import { loadApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { scanSetups } from './setup-scan.mjs';
import { SETUP_REVIEW_VERSION } from './setup-review.mjs';
import { captureCandidateObservations } from './candidate-capture.mjs';
import { detectEarlyBreakSignals } from './edge-comparisons.mjs';
import { captureEarlyBreakObservations } from './early-break-capture.mjs';
import { buildMarketContext, readContextHistory, sessionOpenAt, collectContextHistoryTick } from './market-context.mjs';
import { assessEntryWatchPlan, claimEntryWatchPlan, buildEntryDispatch, readEntryWatchState } from './entry-watch-plan.mjs';
import { appendJournal } from './journal.mjs';
import { boundedMarketReader, durableJson, fastIdleReason, fastLocalState, freshQqqQuote,
  latestPrevious, qqqBars, readLocalJson, fastReason } from './entry-watch-runtime.mjs';

const root=dirname(fileURLToPath(import.meta.url));
export function dispatchExistingEntry({folder,plan,assessment,spawnImpl=spawn,node=process.execPath,clock=()=>Date.now(),
  timeoutMs=180000,signal}){
  const dispatch=buildEntryDispatch(plan,assessment,{now:clock()});
  const evidence=join(folder,`entry-watch-evidence-${plan.plan_id}.json`);
  durableJson(folder,`entry-watch-evidence-${plan.plan_id}.json`,dispatch.setup);
  return new Promise(resolveDispatch=>{
    let output='',settled=false,timer,child;
    const finish=result=>{if(!settled){settled=true;clearTimeout(timer);signal?.removeEventListener('abort',interrupted);resolveDispatch(result);}};
    const interrupted=()=>{
      // A terminated process may already have sent an order. Retain its consumed claim and original broker intent.
      finish({status:'outcome_unknown',exit_code:null,reason:'Entry process interrupted or exceeded its deadline; reconcile the original intent, never repeat this plan.'});
      try{child?.kill('SIGTERM');}catch{}
    };
    try{child=spawnImpl(node,[join(folder,'entry.mjs'),...dispatch.args,'--setup-json',evidence,'--entry-watch-plan',plan.plan_id],{cwd:folder,stdio:['ignore','pipe','pipe']});}
    catch{return finish({status:'dispatch_failed',exit_code:null,reason:'entry_process_start_failed'});}
    for(const stream of [child.stdout,child.stderr])stream?.on('data',chunk=>{if(output.length<16384)output+=String(chunk).slice(0,16384-output.length);});
    child.once('error',()=>finish({status:'dispatch_failed',exit_code:null,reason:'entry_process_start_failed'}));
    child.once('close',code=>finish({status:code===0?'entry_gate_completed':'entry_gate_blocked',exit_code:code,
      // Only a bounded gate result is stored; raw broker responses and identifiers are never copied here.
      reason:code===0?'Existing entry gate completed; verify its saved order and fill state.':
        output.split('\n').filter(line=>/^Entry blocked:/.test(line)).at(-1)?.slice(0,500)??'Existing entry gate did not complete; inspect its state before any new attempt.'}));
    timer=setTimeout(interrupted,Math.max(1,Math.min(180000,timeoutMs)));
    signal?.addEventListener('abort',interrupted,{once:true});if(signal?.aborted)interrupted();
  });
}

export async function runFastWatchCycle({folder=root,clock=()=>Date.now(),session={client:null},
  mcpLoader=()=>import('./mcp.mjs'),dispatch=dispatchExistingEntry,budgetMs=10000,signal}={}){
  const status={version:1,at:new Date(clock()).toISOString(),status:'idle',reason:null,interval_ms:10000,
    setup_review_version:SETUP_REVIEW_VERSION,
    broker_reads:0,candidates:0,plan_id:null,plan_status:null,entry_dispatched:false};
  const save=()=>{status.at=new Date(clock()).toISOString();durableJson(folder,'fast-watch-status.json',status);return status;};
  try{
    const idle=fastIdleReason(folder,{now:clock()});if(idle){status.status='skipped';status.reason=idle;return save();}
    const read=await boundedMarketReader({folder,clock,session,mcpLoader,budgetMs});
    const startTime=sessionOpenAt(clock());
    const fiveMinuteBars=qqqBars(await read('get_equity_historicals',{symbols:['QQQ'],interval:'5minute',start_time:startTime,bounds:'regular'}),'5minute');status.broker_reads++;
    const oneMinuteBars=qqqBars(await read('get_equity_historicals',{symbols:['QQQ'],interval:'minute',start_time:startTime,bounds:'regular'}),'minute');status.broker_reads++;
    const quoteData=await read('get_equity_quotes',{symbols:['QQQ']});status.broker_reads++;
    const qqq=freshQqqQuote(quoteData,clock()),rawQqq=quoteData.results.find(row=>row?.quote?.symbol==='QQQ').quote;
    const now=new Date(clock()),previous=latestPrevious(folder),lastExit=readLocalJson(folder,'last-exit.json');
    let release;
    try{
      release=acquireProcessLock(join(folder,'entry-watch-plan.lock'));
      const plan=readLocalJson(folder,'entry-watch-plan.json'),state=readEntryWatchState(folder,{plan});
      if(plan){
        status.plan_id=plan.plan_id;
        const assessment=assessEntryWatchPlan({plan,state,policySnapshot:loadApprovedRiskPolicy(folder).snapshot,
          health:readLocalJson(folder,'health.json'),localState:fastLocalState(folder),
          qqqQuote:rawQqq,fiveMinuteBars,oneMinuteBars,now:clock(),previous,lastExit});
        status.plan_status=assessment.status;status.reason=assessment.reason;
        if(assessment.status==='ready'){
          const idle=fastIdleReason(folder,{now:clock()});if(idle)throw Error(idle);
          const claimed=claimEntryWatchPlan(plan,state,{now:clock(),attemptId:randomUUID(),assessment});
          durableJson(folder,'entry-watch-state.json',claimed);
          durableJson(folder,'entry-watch-last-attempt.json',{version:1,plan_id:plan.plan_id,
            setup_id:assessment.setup.setup_id,break_bar_at:assessment.setup.break_bar_at,attempted_at:claimed.attempted_at});
          status.status='dispatch_started';status.entry_dispatched=true;status.plan_status='dispatch_started';save();
          appendJournal(folder,'entry_watch_dispatch_started',{plan_id:plan.plan_id,option_id:plan.option_id,
            direction:plan.direction,setup_id:assessment.setup.setup_id,attempt_id:claimed.attempt_id});
          // Keep the plan lock while the child owns the entry lock; never retry this plan after an ambiguous interruption.
          const result=await dispatch({folder,plan,assessment,clock,signal});
          durableJson(folder,'entry-watch-state.json',{...claimed,status:result.status==='entry_gate_completed'?'completed':
            result.status==='dispatch_failed'?'spawn_failed':result.status==='outcome_unknown'?'outcome_unknown':'blocked'});
          status.status=result.status;status.plan_status=result.status;status.reason=result.reason;
          appendJournal(folder,'entry_watch_dispatch_result',{plan_id:plan.plan_id,status:result.status,exit_code:result.exit_code,reason:result.reason});
          return save();
        }
      }
    }catch(error){
      status.plan_status='blocked';status.reason='Saved entry plan or attempt cannot be verified; review before another entry.';
    }finally{release?.();}
    if(fastIdleReason(folder,{now:clock()}))return save();
    let context;
    try { context=buildMarketContext({now:clock(),qqqPrice:qqq.price,oneMinuteBars,fiveMinuteBars,history:readContextHistory(folder)});
      durableJson(folder,'market-context-latest.json',context);status.context_status='recorded';
    } catch {status.context_status='unavailable';}
    const scan=scanSetups({oneMinuteBars,fiveMinuteBars,now:new Date(clock()),previous,lastExit,qqqPrice:qqq.price});
    status.candidates=scan.candidates.length;status.scan_status=scan.status;
    if(scan.status!=='complete')throw Error('fresh_qqq_bars_unavailable');
    durableJson(folder,'fast-watch-candidates.json',{...scan,qqq_price:qqq.price,qqq_quote_at:qqq.last_trade_at});
    const capture=captureCandidateObservations({folder,now:clock(),qqq:rawQqq,oneMinuteBars,fiveMinuteBars,candidates:scan.candidates,marketContext:context});
    status.capture_status=capture.status;
    try {
      const early=detectEarlyBreakSignals({oneMinuteBars,fiveMinuteBars,now:new Date(now),qqqPrice:qqq.price});
      const captured=captureEarlyBreakObservations({folder,now:now.getTime(),qqq:rawQqq,oneMinuteBars,fiveMinuteBars,signals:early.signals,marketContext:context});
      status.early_capture_status=captured.status;status.early_signals=early.signals.length;
    } catch {status.early_capture_status='unavailable';}
    // Extra historical context follows all live plan decisions and local captures.
    // Never warm it while an entry plan is pending or outcome is unresolved.
    try {
      const plan=readLocalJson(folder,'entry-watch-plan.json');
      const state=plan?readEntryWatchState(folder,{plan}):null;
      const planPending=!!plan&&(!state||!['completed','cancelled','blocked','spawn_failed'].includes(state.status))&&
        (!Number.isFinite(Date.parse(plan.expires_at))||Date.parse(plan.expires_at)>clock()||['dispatch_started','outcome_unknown'].includes(state?.status));
      if(context?.vwap.status==='available')status.history=await collectContextHistoryTick({folder,read:async(name,args)=>{const value=await read(name,args);status.broker_reads++;return value;},now:clock(),planPending});
    } catch {status.history={status:'unavailable',reason:'context_history_unavailable'};}
    status.status='watching';status.reason??='No agent plan is ready; automatic setup capture continues.';
    return save();
  }catch(error){status.reason=fastReason(error);status.status=['live_trade_priority','broker_busy','market_closed'].includes(status.reason)?'skipped':'unavailable';return save();}
}

export async function runFastWatch({folder=root,once=false,intervalMs=10000,clock=()=>Date.now(),
  mcpLoader=()=>import('./mcp.mjs'),signal,dispatch=dispatchExistingEntry}={}){
  const release=acquireProcessLock(join(folder,'fast-watch.lock')),session={client:null};
  try{do{
    const began=clock();await runFastWatchCycle({folder,clock,session,mcpLoader,dispatch,signal});
    if(once||signal?.aborted)break;
    await new Promise(done=>{const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);done();};
      const timer=setTimeout(finish,Math.max(1,intervalMs-(clock()-began)));signal?.addEventListener('abort',finish,{once:true});});
  }while(!signal?.aborted);}finally{try{await session.client?.close();}catch{}release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),controller=new AbortController();
  process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
  if(args.length!==1||!['--live','--once'].includes(args[0])){process.stderr.write('Usage: fast-watch.mjs --live | --once\n');process.exitCode=1;}
  else runFastWatch({once:args[0]==='--once',signal:controller.signal}).catch(()=>{process.stderr.write('Fast entry watch unavailable; existing position protection continues.\n');process.exitCode=1;});
}
