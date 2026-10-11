import { optionResearchFields } from './option-research-fields.mjs';
import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from './process-lock.mjs';
import { marketSession, sessionForDate } from './session.mjs';
import { readServiceHealth } from './service-health.mjs';
import {loadApprovedRiskPolicy} from './approved-risk-policy.mjs';
import {DEFAULT_RISK_POLICY} from './risk-policy.mjs';
import {requireNearMoneyContract} from './contract-selection.mjs';
import { readResearchState, dueResearchFollowups, dueResearchScalps, recordResearchEvent } from './research-record.mjs';

export const RESEARCH_READ_TOOLS=Object.freeze(['get_option_chains','get_option_instruments','get_option_quotes','get_equity_quotes']);
export const RESEARCH_WORKER_LIMITS=Object.freeze({tick_budget_ms:10000,max_quote_instruments:5,max_initial_case_age_ms:900000,cash_max_age_ms:120000});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const tradeFiles=['arm.json','entry-intent.json','exit-intent.json','profit-exit-request.json','profit-plan.json'];
const tradingLocks=['entry.lock','profit.lock','exit.lock','state.lock'];
const numeric=value=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const fresh=(value,now,max=10000)=>iso(value)&&now-Date.parse(value)>=-5000&&now-Date.parse(value)<=max;
function atomic(folder,name,value){const file=join(folder,name),tmp=`${file}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,file);}
function json(folder,name,defaultValue){const path=join(folder,name);if(!existsSync(path))return defaultValue;if(statSync(path).size>1024*1024)throw Error('research_file_too_large');return JSON.parse(readFileSync(path,'utf8'));}
function hashMap(value){return value&&typeof value==='object'&&!Array.isArray(value);}
export function researchIdleReason(folder,{now=Date.now(),checkBrokerLock=true}={}){
  if(tradeFiles.some(name=>existsSync(join(folder,name))))return 'live_trade_priority';
  if(tradingLocks.some(name=>existsSync(join(folder,name))))return 'live_trade_priority';
  if(checkBrokerLock&&['broker.lock','broker-access.lock'].some(name=>existsSync(join(folder,name))))return 'broker_busy';
  const session=marketSession(new Date(now));
  if(!session.verified)return 'calendar_unverified';if(!session.is_open)return 'market_closed';
  const health=readServiceHealth(folder,{now,maxAgeMs:60000,hasState:false});
  return health.live_verified&&health.reported_status==='idle'&&!health.data_unavailable&&health.deadline_exceeded!==true?null:'monitor_idle_unverified';
}
function validContext(value){return value&&UUID.test(value.prior_trade_id??'')&&iso(value.closed_at)&&
  Number.isFinite(numeric(value.prior_invalidation))&&numeric(value.prior_invalidation)>0&&['call','put'].includes(value.prior_direction);}
function verifiedStopContext(lastExit,now){
  if(lastExit?.version!==1||lastExit.closure_verified!==true||lastExit.post_stop!==true)return null;
  const context={prior_trade_id:lastExit.trade_id,closed_at:lastExit.closed_at,
    prior_invalidation:lastExit.original_qqq_invalidation,prior_direction:lastExit.direction};
  if(!validContext(context)||Date.parse(context.closed_at)>now||marketSession(new Date(context.closed_at)).date!==marketSession(new Date(now)).date)return null;
  return context;
}
export function enqueueResearchCase(input,{folder,now=Date.now()}={}){
  if(!input||!HASH.test(input.case_id??'')||Object.keys(input).some(key=>!['case_id','cash_snapshot','entry_gate','post_stop_context'].includes(key)))throw Error('research_queue_input_invalid');
  if(input.cash_snapshot&&(!iso(input.cash_snapshot.observed_at)||typeof input.cash_snapshot.available_cash_dollars!=='number'||!Number.isFinite(input.cash_snapshot.available_cash_dollars)||input.cash_snapshot.available_cash_dollars<0||Object.keys(input.cash_snapshot).some(key=>!['observed_at','available_cash_dollars'].includes(key))))throw Error('research_cash_snapshot_invalid');
  if(input.entry_gate&&(!['qualified','blocked','unknown'].includes(input.entry_gate.status)||typeof input.entry_gate.reason!=='string'||!input.entry_gate.reason.trim()||input.entry_gate.reason.length>500||input.entry_gate.checked_at!==null&&!iso(input.entry_gate.checked_at)||Object.keys(input.entry_gate).some(key=>!['status','reason','checked_at'].includes(key))))throw Error('research_entry_gate_invalid');
  if(input.post_stop_context&&(!validContext(input.post_stop_context)||Object.keys(input.post_stop_context).some(key=>!['prior_trade_id','closed_at','prior_invalidation','prior_direction'].includes(key))))throw Error('research_post_stop_context_invalid');
  const release=acquireProcessLock(join(folder,'research-queue.lock'));
  try{
    const queue=json(folder,'research-collector-queue.json',{version:1,cases:{}});
    if(queue.version!==1||!hashMap(queue.cases))throw Error('research_queue_invalid');
    queue.cases[input.case_id]={...queue.cases[input.case_id],...input,queued_at:new Date(now).toISOString()};
    const sorted=Object.values(queue.cases).sort((a,b)=>Date.parse(b.queued_at)-Date.parse(a.queued_at));
    queue.cases=Object.fromEntries(sorted.slice(0,200).map(item=>[item.case_id,item]));
    atomic(folder,'research-collector-queue.json',queue);return {status:'queued',case_id:input.case_id};
  }finally{release();}
}
function hydrateCases(folder,state){
  const cases=structuredClone(state.cases),path=join(folder,'research-journal.jsonl');
  if(!existsSync(path))return cases;
  if(statSync(path).size>8*1024*1024)return cases;
  for(const line of readFileSync(path,'utf8').split('\n').filter(Boolean)){
    let event;try{event=JSON.parse(line);}catch{continue;}
    const item=cases[event.case_id];if(!item||!['setup','early_break'].includes(event.event_kind))continue;
    item.first_event_kind??=event.event_kind;item.setup_evidence??=event.setup??(event.early_setup?{reference_level:event.early_setup.reference_level,break_bar_at:event.early_setup.break_bar_at}:null);item.early_setup_evidence??=event.early_setup??null;
    if(event.selected_contract?.instrument_id===item.primary_instrument_id)item.primary_contract_metadata??={instrument_id:event.selected_contract.instrument_id,
      expiration:event.selected_contract.expiration,strike:event.selected_contract.strike};
  }
  return cases;
}
function quoteInput(raw,metadata,now){
  if(raw?.instrument_id!==metadata?.instrument_id||!UUID.test(metadata?.instrument_id??''))return null;
  const nullable=value=>Number.isFinite(numeric(value))?numeric(value):null;
  const result={instrument_id:metadata.instrument_id,expiration:metadata.expiration,strike:metadata.strike,
    bid:nullable(raw.bid_price),ask:nullable(raw.ask_price),bid_size:nullable(raw.bid_size),ask_size:nullable(raw.ask_size),
    updated_at:iso(raw.updated_at)?raw.updated_at:null,delta:nullable(raw.delta),theta:nullable(raw.theta),...optionResearchFields(raw)};
  if(result.delta!==null&&Math.abs(result.delta)>1)result.delta=null;
  if(!fresh(result.updated_at,now)||result.bid===null||result.bid<=0||result.ask===null||result.ask<result.bid)return null;
  for(const key of ['bid_size','ask_size'])if(result[key]!==null&&(!Number.isInteger(result[key])||result[key]<0))result[key]=null;
  return result;
}
export function researchSelectionContext(item,queued,lastExit,now,premiumCeiling=DEFAULT_RISK_POLICY.opening_premium_ceiling){
  if(!Number.isFinite(premiumCeiling)||premiumCeiling<=0||premiumCeiling>500)throw Error('research_premium_ceiling_invalid');
  const cash=queued?.cash_snapshot,cashKnown=cash&&fresh(cash.observed_at,now,RESEARCH_WORKER_LIMITS.cash_max_age_ms);
  const ceiling=cashKnown?Math.min(premiumCeiling,cash.available_cash_dollars):premiumCeiling;
  const context=queued?.post_stop_context??verifiedStopContext(lastExit,now);
  const breakAt=item.setup_evidence?.break_bar_at;
  const completed=iso(breakAt)?Date.parse(breakAt)+300000:null;
  const post=context?{prior_trade_id:context.prior_trade_id,closed_at:context.closed_at,
    prior_invalidation:numeric(context.prior_invalidation),prior_direction:context.prior_direction,
    setup_break_bar_at:iso(breakAt)?breakAt:null,setup_break_completed_at:completed===null?null:new Date(completed).toISOString(),
    new_completed_setup:completed!==null&&completed>Date.parse(context.closed_at)&&completed<=now-1000}:null;
  let gate=queued?.entry_gate&&fresh(queued.entry_gate.checked_at,now,120000)?queued.entry_gate:
    {status:'unknown',reason:'Current live entry risk and setup gates have not been verified for this research quote.',checked_at:null};
  if(post&&!post.new_completed_setup)gate={status:'blocked',reason:'No newer completed five-minute break after the verified stop closure.',checked_at:new Date(now).toISOString()};
  return {premium_ceiling_dollars:ceiling,cash_snapshot_at:cashKnown?cash.observed_at:null,
    affordability:cashKnown?'verified_snapshot':'unknown',entry_gate:gate,post_stop_context:post};
}
function collectorState(folder){const state=json(folder,'research-collector-state.json',{version:1,totals:{priced_cases:0,followups:0,scalp_observations:0,gaps:0,failures:0},gap_keys:[],pricing_attempts:{}});
  if(state.version!==1||!hashMap(state.totals)||!['priced_cases','followups','gaps','failures'].every(key=>Number.isSafeInteger(state.totals[key])&&state.totals[key]>=0)||!Array.isArray(state.gap_keys)||!hashMap(state.pricing_attempts))throw Error('research_collector_state_invalid');state.totals.scalp_observations??=0;if(!Number.isSafeInteger(state.totals.scalp_observations)||state.totals.scalp_observations<0)throw Error('research_collector_state_invalid');return state;}
export function recordResearchCollectorUnavailable(folder,{now=Date.now(),reason='research_connection_unavailable'}={}){
  const state=collectorState(folder);state.totals.failures++;
  const status={version:1,at:new Date(now).toISOString(),status:'error',reason,priced_cases:0,followups:0,scalp_observations:0,gaps:0,
    failures:[reason],broker_reads:0,execution_unaffected:true,totals:state.totals};
  atomic(folder,'research-collector-state.json',state);atomic(folder,'research-collector-status.json',status);return status;
}
function gap(folder,state,key,event){if(state.gap_keys.includes(key))return;appendFileSync(join(folder,'research-collector-journal.jsonl'),JSON.stringify({version:1,event_kind:'sampling_gap',...event})+'\n',{mode:0o600});state.gap_keys.push(key);state.gap_keys=state.gap_keys.slice(-2000);state.totals.gaps++;}
function stockQuote(data,now){const quote=data?.results?.find(value=>value?.quote?.symbol==='QQQ')?.quote;
  const price=numeric(quote?.last_trade_price);if(quote?.state!=='active'||quote.has_traded!==true||!Number.isFinite(price)||price<=0||!fresh(quote.venue_last_trade_time,now))throw Error('fresh_qqq_quote_unavailable');
  return {price,last_trade_at:quote.venue_last_trade_time};}

// The supplied broker exposes only four market-data reads. Every read is gated
// before its SDK lock, and its beforeSend callback is checked inside that lock.
export async function collectResearchTick({folder,broker,clock=()=>Date.now(),budgetMs=10000}={}){
  const began=clock(),deadline=began+Math.min(budgetMs,RESEARCH_WORKER_LIMITS.tick_budget_ms);
  const result={version:1,at:new Date(began).toISOString(),status:'idle',reason:null,priced_cases:0,followups:0,scalp_observations:0,gaps:0,failures:[],broker_reads:0,execution_unaffected:true};
  let state;
  const persist=()=>{result.at=new Date(clock()).toISOString();if(state){result.totals=state.totals;atomic(folder,'research-collector-state.json',state);}atomic(folder,'research-collector-status.json',result);return result;};
  try{
    state=collectorState(folder);const research=readResearchState(folder),cases=hydrateCases(folder,research);
    const queue=json(folder,'research-collector-queue.json',{version:1,cases:{}});
    if(queue.version!==1||!hashMap(queue.cases))throw Error('research_queue_invalid');
    const session=marketSession(new Date(began)),due=dueResearchFollowups(folder,{now:began}),scalps=dueResearchScalps(folder,{now:began});
    const beforeGaps=state.totals.gaps;
    for(const expired of due.expired)for(const horizon of expired.missed_horizons_minutes)gap(folder,state,`${expired.case_id}:${expired.basis_id}:${horizon}`,{
      case_id:expired.case_id,basis_id:expired.basis_id,horizon_minutes:horizon,recorded_at:new Date(began).toISOString(),reason:'actual_sampling_window_missed_no_quote_backfill'});
    for(const expired of scalps.expired)for(const horizon of expired.missed_horizons_seconds)gap(folder,state,`${expired.case_id}:${expired.basis_id}:seconds:${horizon}`,{
      case_id:expired.case_id,basis_id:expired.basis_id,horizon_seconds:horizon,recorded_at:new Date(began).toISOString(),reason:'actual_scalp_sampling_window_missed_no_quote_backfill'});
    const initial=[];
    for(const item of Object.values(cases)){
      if(!['setup','early_break'].includes(item.first_event_kind)||item.bases?.case?.reference_observed_at||!item.bases?.case||!HASH.test(item.case_id??'')||!['call','put'].includes(item.direction))continue;
      const age=began-Date.parse(item.first_observed_at),observedSession=marketSession(new Date(item.first_observed_at));
      if(age>RESEARCH_WORKER_LIMITS.max_initial_case_age_ms||observedSession.date!==session.date){gap(folder,state,`${item.case_id}:unpriced`,{case_id:item.case_id,basis_id:'case',horizon_minutes:null,
        recorded_at:new Date(began).toISOString(),reason:'setup_expired_without_a_prospective_option_baseline'});continue;}
      if(age>=-5000)initial.push(item);
    }
    result.gaps=state.totals.gaps-beforeGaps;
    const idleReason=researchIdleReason(folder,{now:began});if(idleReason){result.status='skipped';result.reason=idleReason;return persist();}
    if(!due.due.length&&!scalps.due.length&&!initial.length){result.reason='no_due_quotes_or_recent_unpriced_setups';return persist();}
    const read=async(name,args)=>{
      if(!RESEARCH_READ_TOOLS.includes(name))throw Error('research_read_tool_not_allowed');
      const remaining=deadline-clock();if(remaining<=0)throw Error('research_tick_budget_exhausted');
      const reason=researchIdleReason(folder,{now:clock()});if(reason)throw Error(reason);
      const beforeSend=()=>{const reason=researchIdleReason(folder,{now:clock(),checkBrokerLock:false});if(reason)throw Error(reason);if(clock()>=deadline)throw Error('research_tick_budget_exhausted');};
      result.broker_reads++;
      const response=await broker.read(name,args,{timeoutMs:Math.max(1,Math.min(2000,remaining)),maxTotalTimeoutMs:Math.max(1,Math.min(2500,remaining)),lockTimeoutMs:0,beforeSend});
      if(clock()>=deadline)throw Error('research_tick_budget_exhausted');return response;
    };
    const premiumCeiling=loadApprovedRiskPolicy(folder).policy.opening_premium_ceiling;
    const qqq=stockQuote(await read('get_equity_quotes',{symbols:['QQQ']}),clock());
    const ids=[...new Set([...scalps.instrument_ids,...due.instrument_ids])].slice(0,5),metadata={...due.contract_metadata,...scalps.contract_metadata};
    let candidate,selection,candidateMetadata;
    initial.sort((a,b)=>Date.parse(b.first_observed_at)-Date.parse(a.first_observed_at));
    if(ids.length<5&&initial.length){
      candidate=initial[0];const lastExit=json(folder,'last-exit.json',null);
      selection=researchSelectionContext(candidate,queue.cases[candidate.case_id],lastExit,clock(),premiumCeiling);
      if(selection.premium_ceiling_dollars>0&&candidate.primary_instrument_id){
        const existing=candidate.primary_contract_metadata;
        if(existing?.instrument_id===candidate.primary_instrument_id&&UUID.test(existing.instrument_id)&&existing.expiration>session.date&&sessionForDate(existing.expiration).is_trading_day&&
            Number.isFinite(existing.strike)&&existing.strike>0){candidateMetadata=existing;metadata[existing.instrument_id]=existing;if(!ids.includes(existing.instrument_id))ids.push(existing.instrument_id);}
      }else if(selection.premium_ceiling_dollars>0){
        const chains=await read('get_option_chains',{underlying_symbol:'QQQ'});
        const chain=chains.chains?.find(value=>value?.symbol==='QQQ'&&numeric(value.trade_value_multiplier)===100);
        const expiration=chain?.expiration_dates?.filter(date=>date>session.date&&sessionForDate(date).verified&&sessionForDate(date).is_trading_day).sort()[0];
        if(!chain?.id||!expiration)throw Error('next_qqq_expiry_unavailable');
        const attempt=state.pricing_attempts[candidate.case_id]??0,sign=candidate.direction==='call'?1:-1;
        const offset=[0,-sign,sign,-2*sign,2*sign][attempt%5],strike=Math.round(qqq.price)+offset;
        const instruments=await read('get_option_instruments',{chain_id:chain.id,expiration_dates:expiration,type:candidate.direction,
          strike_price:Math.max(1,strike).toFixed(4),state:'active',tradability:'tradable'});
        state.pricing_attempts[candidate.case_id]=attempt+1;
        const instrument=instruments.instruments?.find(value=>value&&UUID.test(value.id??'')&&value.chain_symbol==='QQQ'&&value.chain_id===chain.id&&
          value.type===candidate.direction&&value.expiration_date===expiration&&value.state==='active'&&value.tradability==='tradable'&&numeric(value.trade_value_multiplier)===100&&
          Number.isFinite(numeric(value.strike_price))&&Math.abs(numeric(value.strike_price)-qqq.price)<=qqq.price*0.005);
        if(instrument){candidateMetadata={instrument_id:instrument.id,expiration:instrument.expiration_date,strike:numeric(instrument.strike_price)};
          metadata[instrument.id]=candidateMetadata;if(!ids.includes(instrument.id))ids.push(instrument.id);}
      }
    }
    if(!ids.length){result.reason='near_atm_research_contract_not_resolved';return persist();}
    const response=await read('get_option_quotes',{instrument_ids:ids.slice(0,5)}),observed=clock();
    const raw=Object.fromEntries((response.results??[]).filter(value=>value?.quote?.instrument_id&&ids.includes(value.quote.instrument_id)).map(value=>[value.quote.instrument_id,value.quote]));
    const usable=Object.fromEntries(ids.map(id=>[id,quoteInput(raw[id],metadata[id],observed)]).filter(([,value])=>value));
    const record=input=>{const reason=researchIdleReason(folder,{now:clock()});if(reason)throw Error(reason);return recordResearchEvent(input,{folder,now:clock()});};
    if(candidateMetadata){
      const selected=usable[candidateMetadata.instrument_id];
      selection=researchSelectionContext(candidate,queue.cases[candidate.case_id],json(folder,'last-exit.json',null),observed,premiumCeiling);
      let nearMoney=false;try{requireNearMoneyContract({direction:candidate.direction,strike:candidateMetadata.strike,qqqPrice:qqq.price});nearMoney=true;}catch{}
      if(nearMoney&&selected&&selected.ask*100<=selection.premium_ceiling_dollars+1e-8&&selected.bid_size>=1&&selected.ask_size>=1&&
          selected.ask-selected.bid<=Math.min(0.10,(selected.ask+selected.bid)/2*0.05)+1e-8){
        const event={version:1,event_kind:'quote_baseline',source:'robinhood_trading_mcp',observed_at:new Date(observed).toISOString(),
          case_id:candidate.case_id,direction:candidate.direction,trade_id:candidate.trade_id,qqq_quote:qqq,selected_contract:selected,alternatives:[],
          basis_ids:Object.entries(candidate.bases).filter(([,basis])=>!basis.reference_observed_at).map(([id])=>id),selection_context:selection};
        const recorded=record(event);if(recorded.status==='recorded'){result.priced_cases++;state.totals.priced_cases++;}
      }else result.reason='candidate_quote_unusable_or_exceeds_research_premium_ceiling';
    }
    for(const item of scalps.due){const selected=usable[item.primary_instrument_id];if(!selected){result.failures.push('scalp_option_quote_unavailable');continue;}
      const basis=cases[item.case_id].bases[item.basis_id],last=basis.scalp?.instruments?.[item.primary_instrument_id]?.samples?.at(-1);
      if(last&&Date.parse(selected.updated_at)<=Date.parse(last.quote_at))continue;
      let horizon=item.horizon_seconds;const actualSeconds=(observed-Date.parse(basis.reference_observed_at))/1000;
      if(horizon!==null&&(actualSeconds<horizon||actualSeconds>=horizon+20||Date.parse(selected.updated_at)<Date.parse(basis.reference_observed_at)+horizon*1000))horizon=null;
      if(horizon===null&&(actualSeconds<10||actualSeconds>120))continue;
      const event={version:1,event_kind:'scalp_observation',source:'robinhood_trading_mcp',observed_at:new Date(observed).toISOString(),case_id:item.case_id,
        direction:item.direction,trade_id:item.trade_id,qqq_quote:qqq,selected_contract:selected,
        alternatives:item.instrument_ids.filter(id=>id!==item.primary_instrument_id).map(id=>usable[id]).filter(Boolean).slice(0,4),basis_id:item.basis_id,horizon_seconds:horizon};
      const recorded=record(event);if(recorded.status==='recorded'){result.scalp_observations++;state.totals.scalp_observations++;}
    }
    for(const item of due.due){if(!ids.includes(item.primary_instrument_id))continue;const selected=usable[item.primary_instrument_id];if(!selected){result.failures.push('due_option_quote_unavailable');continue;}
      const event={version:1,event_kind:'followup',source:'robinhood_trading_mcp',observed_at:new Date(observed).toISOString(),case_id:item.case_id,
        direction:item.direction,trade_id:item.trade_id,qqq_quote:qqq,selected_contract:selected,
        alternatives:item.instrument_ids.filter(id=>id!==item.primary_instrument_id).map(id=>usable[id]).filter(Boolean).slice(0,4),basis_id:item.basis_id,horizon_minutes:item.horizon_minutes};
      const recorded=record(event);if(recorded.status==='recorded'){result.followups++;state.totals.followups++;}}
    result.status=result.priced_cases||result.followups||result.scalp_observations?'collected':result.failures.length?'partial':'idle';
    if(result.failures.length)state.totals.failures+=result.failures.length;
    state.pricing_attempts=Object.fromEntries(Object.entries(state.pricing_attempts).filter(([id])=>cases[id]).slice(-200));
    return persist();
  }catch(error){const known=['live_trade_priority','broker_busy','market_closed','calendar_unverified','research_tick_budget_exhausted','monitor_idle_unverified'];
    result.status=known.includes(error.message)?'skipped':'error';result.reason=known.includes(error.message)?error.message:'research_market_data_or_recording_unavailable';
    result.failures.push(result.reason);if(state)state.totals.failures++;return persist();}
}
