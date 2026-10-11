import { writeDecisionAudit, recordCollectorTelemetry } from './decision-audit.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeEdgeResearchReport } from './edge-report.mjs';
import { durableJson, readLocalJson } from './entry-watch-runtime.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { collectResearchTick, researchIdleReason, RESEARCH_READ_TOOLS, recordResearchCollectorUnavailable } from './research-collector-policy.mjs';

const root=dirname(fileURLToPath(import.meta.url));
// Authentication uses the monitor's saved Keychain grant. This runner never
// opens an authorization flow and cannot submit or cancel an order.
export async function runResearchCollectorCycle({folder=root,clock=()=>Date.now(),session={client:null},
  mcpLoader=()=>import('./mcp.mjs'),budgetMs=10000}={}){
  const deadline=clock()+Math.min(10000,budgetMs);
  const assertIdle=({insideLock=false}={})=>{
    const reason=researchIdleReason(folder,{now:clock(),checkBrokerLock:!insideLock});
    if(reason)throw Error(reason);
    if(clock()>=deadline)throw Error('research_tick_budget_exhausted');
  };
  const broker={read:async(name,args,options)=>{
    if(!RESEARCH_READ_TOOLS.includes(name))throw Error('research_read_tool_not_allowed');
    assertIdle();
    const mcp=await mcpLoader();assertIdle();
    if(!session.client){
      session.client=await mcp.connectReadOnly({timeoutMs:Math.max(1,Math.min(2000,deadline-clock())),lockTimeoutMs:0,
        beforeConnect:()=>assertIdle({insideLock:true})});
      assertIdle();
    }
    const remaining=deadline-clock();
    return mcp.call(session.client,name,args,{...options,timeoutMs:Math.max(1,Math.min(options.timeoutMs,remaining)),
      maxTotalTimeoutMs:Math.max(1,Math.min(options.maxTotalTimeoutMs,remaining)),lockTimeoutMs:0,
      beforeSend:()=>{assertIdle({insideLock:true});options.beforeSend();}});
  }};
  try{return await collectResearchTick({folder,broker,clock,budgetMs:Math.max(1,deadline-clock())});}
  catch{return recordResearchCollectorUnavailable(folder,{now:clock()});}
}


// Report writing has no broker access and runs only after the sampling tick.
export function refreshResearchReport(folder,{now=Date.now()}={}){
  try {
    const idle=researchIdleReason(folder,{now});if(idle)return {status:'skipped',reason:idle};
    const previous=readLocalJson(folder,'edge-report-status.json');
    if(previous?.at&&now-Date.parse(previous.at)<60000)return {status:'skipped',reason:'report_cadence'};
    const result=writeEdgeResearchReport(folder,{now});durableJson(folder,'edge-report-status.json',result);return result;
  } catch {
    const result={version:1,at:new Date(now).toISOString(),status:'unavailable',reason:'edge_research_report_unavailable'};
    try{durableJson(folder,'edge-report-status.json',result);}catch{}return result;
  }
}

export function refreshDecisionAudit(folder,{now=Date.now()}={}){
  try {
    const idle=researchIdleReason(folder,{now});if(idle)return {status:'skipped',reason:idle};
    const previous=readLocalJson(folder,'decision-audit-status.json');
    if(previous?.at&&now-Date.parse(previous.at)<300000)return {status:'skipped',reason:'audit_cadence'};
    return writeDecisionAudit(folder,{now});
  } catch {
    const result={version:1,at:new Date(now).toISOString(),status:'unavailable',reason:'decision_audit_unavailable'};
    try{durableJson(folder,'decision-audit-status.json',result);}catch{}return result;
  }
}

export async function runResearchCollector({folder=root,once=false,intervalMs=10000,clock=()=>Date.now(),
  mcpLoader=()=>import('./mcp.mjs'),signal}={}){
  const release=acquireProcessLock(join(folder,'research-collector.lock'));
  const session={client:null};
  try{
    do{
      const began=clock();
      const tick=await runResearchCollectorCycle({folder,clock,session,mcpLoader});
      recordCollectorTelemetry(folder,{began,ended:clock(),tick});
      refreshResearchReport(folder,{now:clock()});
      refreshDecisionAudit(folder,{now:clock()});
      if(once||signal?.aborted)break;
      await new Promise(resolveWait=>{
        const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolveWait();};
        const timer=setTimeout(done,tick.reason==='broker_busy'?1000:Math.max(1,intervalMs-(clock()-began)));
        signal?.addEventListener('abort',done,{once:true});
      });
    }while(!signal?.aborted);
  }finally{
    // SDK close only releases this read-only transport; it places no orders.
    try{await session.client?.close();}catch{}
    release();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),flag=args.indexOf('--folder');
  const folder=flag>=0&&args[flag+1]?resolve(args[flag+1]):root;
  const controller=new AbortController();
  process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
  if(args.some((arg,index)=>!['--live','--once','--folder'].includes(arg)&&!(flag>=0&&index===flag+1))||flag>=0&&!args[flag+1]||
      args.includes('--live')===args.includes('--once')){
    process.stderr.write('Usage: research-collector.mjs --live | --once [--folder FOLDER]\n');process.exitCode=1;
  }else{
    runResearchCollector({folder,once:args.includes('--once'),signal:controller.signal}).catch(()=>{
      process.stderr.write('Read-only research collector unavailable; trade protection is unaffected.\n');process.exitCode=1;
    });
  }
}
