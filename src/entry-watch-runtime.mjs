import { existsSync, readFileSync, statSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { marketSession } from './session.mjs';
import { readServiceHealth } from './service-health.mjs';
import { acquireProcessLock } from './process-lock.mjs';

export const FAST_READ_TOOLS=Object.freeze(['get_equity_quotes','get_equity_historicals']);
export const TRADE_STATE_FILES=Object.freeze(['arm.json','entry-intent.json','exit-intent.json','profit-exit-request.json',
  'profit-plan.json','profit-protection-plan.json','profit-protection-state.json','stop-intent.json']);
const LOCKS=['entry.lock','profit.lock','exit.lock','state.lock'];
export function readLocalJson(folder,name,fallback=null){
  const path=join(folder,name);
  try{const stat=statSync(path);if(!stat.isFile()||stat.size>65536)throw Error('local_file_invalid');return JSON.parse(readFileSync(path,'utf8'));}
  catch(error){if(error.code==='ENOENT')return fallback;throw Error(`Cannot verify ${name}`);}
}
// Flush the attempt record before a child can enter the existing broker gate.
export function durableJson(folder,name,value){
  const path=join(folder,name),tmp=`${path}.${process.pid}.tmp`,fd=openSync(tmp,'w',0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,path);
  const directory=openSync(folder,'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
export function fastLocalState(folder){return {
  trade_state_present:TRADE_STATE_FILES.some(name=>existsSync(join(folder,name))),
  entry_busy:LOCKS.some(name=>existsSync(join(folder,name)))
};}
export function fastIdleReason(folder,{now=Date.now(),insideLock=false}={}){
  // A timed-out child can leave a process lock. Recover confirmed dead owners
  // only; trade/intent records are never cleared by this service.
  if(!TRADE_STATE_FILES.some(name=>existsSync(join(folder,name)))){
    for(const name of LOCKS){
      if(!existsSync(join(folder,name)))continue;
      const owner=readLocalJson(folder,name);
      if(!Number.isInteger(owner?.pid)||owner.pid<=0||typeof owner.token!=='string'||!owner.token)throw Error('Trading lock ownership is invalid');
      let dead=false;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')dead=true;else if(error.code!=='EPERM')throw error;}
      if(dead){const release=acquireProcessLock(join(folder,name));release();}
    }
  }
  const state=fastLocalState(folder);
  if(state.trade_state_present||state.entry_busy)return 'live_trade_priority';
  if(!insideLock&&['broker.lock','broker-access.lock'].some(name=>existsSync(join(folder,name))))return 'broker_busy';
  const session=marketSession(new Date(now));
  if(!session.verified)return 'calendar_unverified';if(!session.is_open)return 'market_closed';
  const health=readServiceHealth(folder,{now,maxAgeMs:60000,hasState:false});
  if(!health.live_verified||health.reported_status!=='idle'||health.data_unavailable||health.deadline_exceeded===true)return 'monitor_idle_unverified';
  return null;
}
export function freshQqqQuote(data,now=Date.now()){
  const raw=data?.results?.find(row=>row?.quote?.symbol==='QQQ')?.quote;
  const price=Number(raw?.last_trade_price),at=raw?.venue_last_trade_time,age=now-Date.parse(at??'');
  if(raw?.state!=='active'||raw.has_traded!==true||!Number.isFinite(price)||price<=0||!Number.isFinite(age)||age < -5000||age>10000)throw Error('fresh_qqq_quote_unavailable');
  return {price,last_trade_at:at};
}
export function qqqBars(data,interval){
  const row=data?.results?.find(item=>item?.symbol==='QQQ');
  if(row?.interval!==interval||row.bounds!=='regular'||!Array.isArray(row.bars))throw Error('fresh_qqq_bars_unavailable');
  return row.bars;
}
export function latestPrevious(folder){
  const prior=readLocalJson(folder,'last-setup.json'),fast=readLocalJson(folder,'entry-watch-last-attempt.json');
  if(!fast)return prior;
  if(typeof fast.setup_id!=='string'||!Number.isFinite(Date.parse(fast.break_bar_at??'')))throw Error('Fast entry attempt history is invalid');
  if(!prior)return fast;
  if(!Number.isFinite(Date.parse(prior.break_bar_at??'')))throw Error('Entry attempt history is invalid');
  return Date.parse(fast.break_bar_at)>Date.parse(prior.break_bar_at)?fast:prior;
}
export function fastReason(error){
  const reason=String(error?.message??error);
  const known=['live_trade_priority','broker_busy','calendar_unverified','market_closed','monitor_idle_unverified',
    'fast_watch_budget_exhausted','fresh_qqq_quote_unavailable','fresh_qqq_bars_unavailable'];
  return known.includes(reason)?reason:'fast_watch_data_or_state_unavailable';
}
export async function boundedMarketReader({folder,clock=()=>Date.now(),session={client:null},mcpLoader=()=>import('./mcp.mjs'),budgetMs=10000}={}){
  const deadline=clock()+Math.min(10000,budgetMs);
  const guard=(insideLock=false)=>{
    const reason=fastIdleReason(folder,{now:clock(),insideLock});if(reason)throw Error(reason);
    if(clock()>=deadline)throw Error('fast_watch_budget_exhausted');
  };
  return async(name,args)=>{
    if(!FAST_READ_TOOLS.includes(name))throw Error('fast_watch_read_tool_not_allowed');
    guard();const mcp=await mcpLoader();guard();
    if(!session.client){session.client=await mcp.connectReadOnly({timeoutMs:Math.max(1,Math.min(2000,deadline-clock())),lockTimeoutMs:0,
      beforeConnect:()=>guard(true)});guard();}
    const remaining=deadline-clock();
    const result=await mcp.call(session.client,name,args,{timeoutMs:Math.max(1,Math.min(2000,remaining)),
      maxTotalTimeoutMs:Math.max(1,Math.min(2500,remaining)),lockTimeoutMs:0,beforeSend:()=>guard(true)});
    guard();return result;
  };
}
