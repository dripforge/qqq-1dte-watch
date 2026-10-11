import { runtimeDirectory } from './runtime-paths.mjs';
import { HALT_URL,parseHalts,haltContext } from './halt-context.mjs';
import { existsSync,readFileSync,statSync,appendFileSync,mkdirSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
import { durableJson,readLocalJson } from './entry-watch-runtime.mjs';
import { researchIdleReason } from './research-collector-policy.mjs';
import { marketSession } from './session.mjs';
import { ANALYSIS_VERSION,COMPARISON_SYMBOLS,QUOTE_SYMBOLS,summarizeBars,summarizeQuotes,summarizeIndexes,summarizeDepth,readAnalysisPacket } from './analysis-context.mjs';
import { normalizeEarnings,eventContext,refreshOneCalendar,boundedPublicFetch } from './event-context.mjs';
const root=runtimeDirectory();
export const ANALYSIS_READ_TOOLS=Object.freeze(['get_equity_historicals','get_equity_quotes','get_indexes','get_index_quotes','get_earnings_calendar','get_equity_price_book']);
const iso=n=>new Date(n).toISOString();
export function readEventCache(folder){
 const path=join(folder,'analysis-events-cache.json');if(!existsSync(path))return {version:1,sources:{}};
 if(statSync(path).size>512000)throw Error('calendar_cache_too_large');const x=JSON.parse(readFileSync(path,'utf8'));if(x.version!==1||!x.sources)throw Error('calendar_cache_invalid');return x;
}
export function analysisIdleReason(folder,{now=Date.now(),insideLock=false}={}){
 if(['entry-watch-plan.json','stop-intent.json','profit-protection-plan.json'].some(n=>existsSync(join(folder,n))))return 'live_plan_priority';
 return researchIdleReason(folder,{now,checkBrokerLock:!insideLock});
}
export async function collectAnalysisCycle({folder=root,clock=()=>Date.now(),session={client:null},mcpLoader=()=>import('./mcp.mjs'),budgetMs=5000}={}){
 const began=clock(),deadline=began+Math.min(5000,budgetMs);let reads=0,cache,state,events;
 const status={version:1,analysis_version:ANALYSIS_VERSION,at:iso(began),status:'idle',broker_reads:0,elapsed_ms:0,errors:[],read_only:true};
 const guard=(insideLock=false)=>{const why=analysisIdleReason(folder,{now:clock(),insideLock});if(why)throw Error(why);if(clock()>=deadline||reads>=4)throw Error('analysis_budget_exhausted');};
 try{
  state=readLocalJson(folder,'analysis-collector-state.json',{version:1,attempts:{}});if(state.version!==1||!state.attempts)throw Error('analysis_state_invalid');
  cache=readLocalJson(folder,'analysis-context-latest.json',{version:1,analysis_version:ANALYSIS_VERSION});events=readEventCache(folder);
  guard();
  const due=(key,interval)=>!Number.isFinite(Date.parse(state.attempts[key]??''))||clock()-Date.parse(state.attempts[key])>=interval;
  const read=async(name,args)=>{
   if(!ANALYSIS_READ_TOOLS.includes(name))throw Error('analysis_read_not_allowed');guard();
   const mcp=await mcpLoader();guard();
   if(!session.client)session.client=await mcp.connectReadOnly({folder,timeoutMs:Math.max(1,Math.min(1000,deadline-clock())),lockTimeoutMs:0,beforeConnect:()=>guard(true)});
   guard();const remaining=deadline-clock();
   // Count after the final dispatch guard so max four calls can actually be sent.
   return mcp.call(session.client,name,args,{timeoutMs:Math.max(1,Math.min(1000,remaining)),maxTotalTimeoutMs:Math.max(1,Math.min(1200,remaining)),lockTimeoutMs:0,beforeSend:()=>{guard(true);reads++;}});
  };
  const attempt=async(key,action)=>{
   try{guard();}catch(error){status.errors.push({source:key,reason:['live_plan_priority','live_trade_priority','broker_busy','monitor_idle_unverified','analysis_budget_exhausted','market_closed'].includes(error.message)?error.message:'optional_data_unavailable'});return;}
   state.attempts[key]=iso(clock());durableJson(folder,'analysis-collector-state.json',state);
   try{await action();}catch(error){const reason=['live_plan_priority','live_trade_priority','broker_busy','monitor_idle_unverified','analysis_budget_exhausted','market_closed'].includes(error.message)?error.message:'optional_data_unavailable';status.errors.push({source:key,reason});}
  };
  if(due('bars',60000))await attempt('bars',async()=>{
   const now=clock(),day=marketSession(new Date(now)).date;
   const response=await read('get_equity_historicals',{symbols:COMPARISON_SYMBOLS,interval:'minute',bounds:'regular',start_time:iso(now-21*60000),end_time:iso(now)});
   cache.comparisons=summarizeBars(response,clock());cache.bars_received_at=iso(clock());cache.session_date=day;
  });
  if(due('quotes',30000))await attempt('quotes',async()=>{cache.equity_quotes=summarizeQuotes(await read('get_equity_quotes',{symbols:QUOTE_SYMBOLS}),clock());cache.quotes_received_at=iso(clock());});
  if(!state.index_ids||due('index_catalog',86400000))await attempt('index_catalog',async()=>{
   const data=await read('get_indexes',{});if(!Array.isArray(data.indexes))throw Error('index_catalog_unavailable');
   state.index_ids=data.indexes.filter(r=>['VIX','NDX','SPX'].includes(r.symbol)&&/^[0-9a-f-]{36}$/i.test(r.id??'')).map(r=>r.id);durableJson(folder,'analysis-collector-state.json',state);
  });
  if(state.index_ids?.length&&due('indexes',30000))await attempt('indexes',async()=>{cache.indexes=summarizeIndexes(await read('get_index_quotes',{instrument_ids:state.index_ids}),clock());cache.indexes_received_at=iso(clock());});
  if(due('earnings',6*3600000))await attempt('earnings',async()=>{
   const now=clock(),date=marketSession(new Date(now)).date;
   try{events.sources.earnings={status:'available',attempted_at:iso(now),fetched_at:iso(clock()),events:normalizeEarnings(await read('get_earnings_calendar',{start_date:date,days:8,filter:'high_market_cap'})),reason:null};}
   catch(error){events.sources.earnings={...events.sources.earnings,status:'unavailable',attempted_at:iso(now),reason:'earnings_unavailable'};state.attempts.earnings=iso(now-6*3600000+300000);throw error;}
   finally{durableJson(folder,'analysis-events-cache.json',events);}
  });
  const scan=readLocalJson(folder,'fast-watch-candidates.json');
  if(scan?.status==='complete'&&clock()-Date.parse(scan.observed_at)>=0&&clock()-Date.parse(scan.observed_at)<=30000&&scan.candidates?.some(r=>r.structural_qualified===true)&&due('depth',60000))await attempt('depth',async()=>{cache.depth=summarizeDepth(await read('get_equity_price_book',{symbols:['QQQ']}),clock());});
  cache.version=1;cache.analysis_version=ANALYSIS_VERSION;cache.collected_at=iso(clock());cache.errors=status.errors;
  durableJson(folder,'analysis-context-latest.json',cache);durableJson(folder,'analysis-collector-state.json',state);
  status.status=reads?'collected':'cached';
  if(due('journal',60000)&&reads){const packet=readAnalysisPacket(cache,{now:clock()}),date=packet.session.session_date;
   const history=join(folder,'analysis-context-history');mkdirSync(history,{recursive:true});appendFileSync(join(history,date+'.jsonl'),JSON.stringify({...packet,event_context:eventContext(events,{now:clock()})})+'\n',{mode:0o600});state.attempts.journal=iso(clock());durableJson(folder,'analysis-collector-state.json',state);}
 }catch(error){status.status='skipped';status.errors.push({source:'collector',reason:['live_plan_priority','live_trade_priority','broker_busy','monitor_idle_unverified','calendar_unverified','market_closed','analysis_budget_exhausted'].includes(error.message)?error.message:'analysis_unavailable'});}
 status.broker_reads=reads;status.elapsed_ms=clock()-began;status.at=iso(clock());durableJson(folder,'analysis-collector-status.json',status);return status;
}
export async function refreshCalendarCycle({folder=root,now=Date.now(),fetchText}={}){
 try{const before=readEventCache(folder),after=await refreshOneCalendar(before,{now,fetchText});durableJson(folder,'analysis-events-cache.json',after);return eventContext(after,{now});}
 catch{return {status:'unavailable'};}
}
export async function refreshHaltCycle({folder=root,now=Date.now(),fetchText=boundedPublicFetch}={}){
 let saved;try{saved=readLocalJson(folder,'analysis-halts-cache.json');const age=now-Date.parse(saved?.attempted_at??'');
  if(!marketSession(new Date(now)).is_open||Number.isFinite(age)&&age<60000)return haltContext(saved,now);
  const attempted_at=iso(now);durableJson(folder,'analysis-halts-cache.json',{...saved,attempted_at});
  try{const data=parseHalts(await fetchText(HALT_URL));saved={...data,status:'available',attempted_at,received_at:iso(now),reason:null};}
  catch{saved={...saved,status:'unavailable',attempted_at,reason:'halt_feed_unavailable'};}
  durableJson(folder,'analysis-halts-cache.json',saved);return haltContext(saved,now);
 }catch{return {status:'unavailable'};}
}
export async function runAnalysisCollector({folder=root,once=false,signal,clock=()=>Date.now(),mcpLoader,fetchText}={}){
 const release=acquireProcessLock(join(folder,'analysis-collector.lock')),session={client:null};
 try{do{const began=clock();await collectAnalysisCycle({folder,clock,session,mcpLoader});await refreshCalendarCycle({folder,now:clock(),fetchText});await refreshHaltCycle({folder,now:clock(),fetchText});if(once||signal?.aborted)break;
  await new Promise(resolveWait=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolveWait();};const timer=setTimeout(done,Math.max(1,10000-(clock()-began)));signal?.addEventListener('abort',done,{once:true});});
 }while(!signal?.aborted);}finally{try{await session.client?.close();}catch{}release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(args.length!==1||!['--live','--once'].includes(args[0]))throw Error('Use --live or --once');
 const controller=new AbortController();process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
 runAnalysisCollector({once:args[0]==='--once',signal:controller.signal}).catch(()=>{process.stderr.write('Optional analysis collector unavailable.\n');process.exitCode=1;});
}
