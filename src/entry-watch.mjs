import { existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
import { loadApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { createEntryWatchPlan, validateEntryWatchPlan, readEntryWatchState } from './entry-watch-plan.mjs';
import { appendJournal } from './journal.mjs';
import { boundedMarketReader, durableJson, fastIdleReason, latestPrevious, qqqBars,
  freshQqqQuote, readLocalJson } from './entry-watch-runtime.mjs';

const root=dirname(fileURLToPath(import.meta.url));
function archivePlan(folder,plan,state,reason,now){
  mkdirSync(join(folder,'entry-watch-history'),{recursive:true,mode:0o700});
  durableJson(join(folder,'entry-watch-history'),`${plan.plan_id}.json`,{version:1,plan,state,reason,ended_at:new Date(now).toISOString()});
  // The history remains available for review. A partial removal blocks future activation.
  unlinkSync(join(folder,'entry-watch-plan.json'));
  if(existsSync(join(folder,'entry-watch-state.json')))unlinkSync(join(folder,'entry-watch-state.json'));
}
function current(folder){
  const plan=readLocalJson(folder,'entry-watch-plan.json');
  if(!plan){if(existsSync(join(folder,'entry-watch-state.json')))throw Error('Orphan plan state requires review');return {plan:null,state:null};}
  validateEntryWatchPlan(plan,{now:Date.parse(plan.created_at),allowExpired:true});
  return {plan,state:readEntryWatchState(folder,{plan})};
}
export async function prepareAgentEntryWatch(input,{folder=root,clock=()=>Date.now(),mcpLoader=()=>import('./mcp.mjs')}={}){
  const release=acquireProcessLock(join(folder,'entry-watch-plan.lock')),session={client:null};
  try{
    const idle=fastIdleReason(folder,{now:clock()});if(idle)throw Error(idle);
    const old=current(folder);
    if(old.plan&&(!old.state||old.state.status==='prepared')&&clock()<Date.parse(old.plan.expires_at)){
      throw Error('An unsent plan is already pending; retain it or explicitly cancel it before replacement');
    }
    const read=await boundedMarketReader({folder,clock,session,mcpLoader});
    const fiveMinuteBars=qqqBars(await read('get_equity_historicals',{symbols:['QQQ'],interval:'5minute',bounds:'regular',
      start_time:new Date(clock()-120*60000).toISOString()}),'5minute');
    const quoteData=await read('get_equity_quotes',{symbols:['QQQ']});freshQqqQuote(quoteData,clock());
    const qqqQuote=quoteData.results.find(row=>row?.quote?.symbol==='QQQ').quote;
    const plan=createEntryWatchPlan(input,{fiveMinuteBars,qqqQuote,policySnapshot:loadApprovedRiskPolicy(folder).snapshot,
      now:clock(),previous:latestPrevious(folder),lastExit:readLocalJson(folder,'last-exit.json')});
    const idleNow=fastIdleReason(folder,{now:clock()});if(idleNow)throw Error(idleNow);
    if(old.plan)archivePlan(folder,old.plan,old.state,'Expired or consumed plan replaced after a fresh agent review.',clock());
    durableJson(folder,'entry-watch-plan.json',plan);
    durableJson(folder,'entry-watch-state.json',{version:1,plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,
      status:'prepared',attempted_at:null,attempt_id:null,activation_evidence_sha256:null});
    appendJournal(folder,'entry_watch_prepared',{plan_id:plan.plan_id,option_id:plan.option_id,direction:plan.direction,
      expires_at:plan.expires_at,qqq_invalidation:plan.qqq_invalidation,setup:plan.setup,
      profit_protection:plan.profit_protection,policy_snapshot:plan.policy_snapshot});
    return {status:'prepared',plan_id:plan.plan_id,expires_at:plan.expires_at,direction:plan.direction,
      option_id:plan.option_id,qqq_invalidation:plan.qqq_invalidation,reason:'Mac watches for actual latest-minute confirmation; full entry checks remain required.'};
  }finally{try{await session.client?.close();}catch{}release();}
}
export function cancelAgentEntryWatch(planId,reason,{folder=root,now=Date.now()}={}){
  if(typeof reason!=='string'||reason.trim().length<8||reason.length>500)throw Error('A specific cancellation reason is required');
  const release=acquireProcessLock(join(folder,'entry-watch-plan.lock'));
  try{
    const {plan,state}=current(folder);
    if(!plan||plan.plan_id!==planId)throw Error('Pending plan identity does not match');
    if(state&&state.status!=='prepared')throw Error('This plan was already attempted; cancellation cannot change its order state');
    archivePlan(folder,plan,state,reason.trim(),now);
    appendJournal(folder,'entry_watch_cancelled',{plan_id:plan.plan_id,reason:reason.trim()});
    return {status:'cancelled',plan_id:plan.plan_id,reason:reason.trim()};
  }finally{release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const [action,file,reason,...extra]=process.argv.slice(2);if(extra.length)throw Error('Invalid command arguments');
    if(action==='create'&&file&&!reason){
      const path=realpathSync(resolve(file));if(!path.startsWith(root+sep))throw Error('Plan input must be a saved file inside the trading folder');
      const input=readLocalJson(dirname(path),path.slice(path.lastIndexOf(sep)+1));
      process.stdout.write(JSON.stringify(await prepareAgentEntryWatch(input))+'\n');
    }else if(action==='cancel'&&file&&reason)process.stdout.write(JSON.stringify(cancelAgentEntryWatch(file,reason))+'\n');
    else if(action==='status'&&!file)process.stdout.write(JSON.stringify({...current(root),service:readLocalJson(root,'fast-watch-status.json')})+'\n');
    else throw Error('Use entry-watch.mjs create INPUT.json | cancel PLAN_ID REASON | status');
  }catch(error){process.stderr.write(`Entry watch blocked: ${String(error.message).slice(0,500)}\n`);process.exitCode=1;}
}
