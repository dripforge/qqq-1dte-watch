import {candidateContext} from './market-context.mjs';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync,renameSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {acquireProcessLock} from './process-lock.mjs';
import {marketSession} from './session.mjs';
import {validateResearchEvent} from './research-policy.mjs';
import {safeRecordResearchEvent} from './research-hooks.mjs';
import {researchIdleReason,enqueueResearchCase} from './research-collector-policy.mjs';
import {appendJournal} from './journal.mjs';
import {completedBars,validateSetupStructure} from './setup-policy.mjs';

export const CANDIDATE_CAPTURE_LIMITS=Object.freeze({max_candidates:4,max_retained_cases:200,max_bars:24,quote_max_age_ms:10000});
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const number=value=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
const nullable=value=>Number.isFinite(number(value))?number(value):null;
function time(value){if(typeof value!=='string'||!ISO.test(value)||!Number.isFinite(Date.parse(value))||new Date(`${value.slice(0,19)}Z`).toISOString().slice(0,19)!==value.slice(0,19))throw Error('capture_timestamp_invalid');return Date.parse(value);}
function text(value,limit,name){if(typeof value!=='string'||!value.trim()||value.length>limit)throw Error(name);return value.trim();}
function atomic(folder,name,value){const path=join(folder,name),tmp=`${path}.${process.pid}.tmp`;writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,path);}
function state(folder){const path=join(folder,'candidate-capture-state.json');if(!existsSync(path))return {version:1,cases:{},totals:{captured:0,research_events:0,queued:0,failures:0,metadata_only:0}};
  if(statSync(path).size>1024*1024)throw Error('capture_state_too_large');const value=JSON.parse(readFileSync(path,'utf8'));
  if(value.version!==1||!value.cases||typeof value.cases!=='object'||Array.isArray(value.cases)||!value.totals||!['captured','research_events','queued','failures'].every(key=>Number.isSafeInteger(value.totals[key])&&value.totals[key]>=0))throw Error('capture_state_invalid');
  value.totals.metadata_only??=0;if(!Number.isSafeInteger(value.totals.metadata_only)||value.totals.metadata_only<0)throw Error('capture_state_invalid');return value;}
function bars(input,interval,now){
  if(!Array.isArray(input))throw Error('capture_completed_bars_unavailable');const date=marketSession(new Date(now)).date;
  const keys=['begins_at','open_price','high_price','low_price','close_price','interpolated','session'];
  const completed=input.filter(bar=>bar&&time(bar.begins_at)+interval<=now-1000)
    .sort((a,b)=>time(a.begins_at)-time(b.begins_at)).slice(-24).map(bar=>{
      if(bar.interpolated===true||bar.interpolated!==undefined&&bar.interpolated!==null&&typeof bar.interpolated!=='boolean'||bar.session!==undefined&&bar.session!==null&&!['reg',''].includes(bar.session)||marketSession(new Date(time(bar.begins_at))).date!==date||!marketSession(new Date(time(bar.begins_at))).is_open)throw Error('capture_regular_bars_unverified');
      const result=Object.fromEntries(keys.filter(key=>bar[key]!==undefined&&bar[key]!==null).map(key=>[key,bar[key]]));if(bar.volume!==undefined&&bar.volume!==null)result.volume=number(bar.volume);return result;
    });
  const minimum=interval===60000?2:3;
  if(completed.length<minimum||now-(time(completed.at(-1).begins_at)+interval)>interval+30000)throw Error('capture_completed_bars_stale');
  return completed;
}
function reference(value,candidate){
  if(value===undefined||value===null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw Error('capture_reference_invalid');
  const level=value.level===undefined?candidate.level:number(value.level);if(!Number.isFinite(level)||level!==candidate.level||time(value.established_at)>time(candidate.break_bar_at))throw Error('capture_reference_not_causal');
  const result={level,established_at:value.established_at};
  for(const key of ['source','kind','rationale','bar_at'])if(value[key]!==undefined)result[key]=text(value[key],key==='rationale'?2000:100,'capture_reference_invalid');
  return result;
}

// Consumes an already fetched broker snapshot. No network or order API exists.
export function buildCandidateResearchObservation({now=Date.now(),qqq,oneMinuteBars,fiveMinuteBars,record}={}){
  now=now instanceof Date?now.getTime():now;if(!Number.isFinite(now))throw Error('capture_observation_time_invalid');
  const session=marketSession(new Date(now));if(!session.verified||!session.is_open)throw Error('capture_session_unavailable');
  const price=number(qqq?.last_trade_price),quoteAt=time(qqq?.venue_last_trade_time);
  if(qqq?.symbol!=='QQQ'||qqq.state!=='active'||qqq.has_traded!==true||!Number.isFinite(price)||price<=0||now-quoteAt>10000||quoteAt-now>5000)throw Error('capture_fresh_qqq_unavailable');
  const candidate=record?.candidate;if(!candidate||candidate.version!==1||!['call','put'].includes(candidate.direction)||typeof record.qualified!=='boolean'||record.structural_qualified===false||
    typeof candidate.pattern!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(candidate.pattern))throw Error('capture_candidate_invalid');
  const level=number(candidate.level);if(!Number.isFinite(level)||level<=0)throw Error('capture_candidate_level_invalid');
  const rationale=text(candidate.rationale,2000,'capture_candidate_rationale_invalid'),reason=text(record.reason,500,'capture_candidate_reason_invalid');
  const minute=bars(oneMinuteBars,60000,now),five=bars(fiveMinuteBars,300000,now);
  const breakAt=time(candidate.break_bar_at),confirmAt=time(candidate.confirm_bar_at),oneAt=time(candidate.confirmation_1m_at);
  const breakIndex=five.findIndex(bar=>time(bar.begins_at)===breakAt),confirmIndex=five.findIndex(bar=>time(bar.begins_at)===confirmAt);
  if(breakIndex<1||confirmIndex<=breakIndex||oneAt!==time(minute.at(-1).begins_at)||oneAt+60000<confirmAt+300000||now-(confirmAt+300000)>600000)throw Error('capture_candidate_bar_identity_invalid');
  const causal=reference(record.causal_reference??record.reference,{...candidate,level});
  const gate=record.qualified?{status:'unknown',reason:`Setup scan passed: ${reason} Full live risk and option gates have not been evaluated.`.slice(0,500),checked_at:null}:
    {status:'blocked',reason,checked_at:new Date(now).toISOString()};
  const input={version:1,event_kind:'setup',observed_at:new Date(now).toISOString(),source:'robinhood_trading_mcp',case_id:null,direction:candidate.direction,trade_id:null,
    qqq_quote:{price,last_trade_at:qqq.venue_last_trade_time},selected_contract:null,alternatives:[],
    setup:{reference_level:level,qqq_invalidation:nullable(record.qqq_invalidation),next_obstacle:nullable(record.next_obstacle),
      break_bar_at:candidate.break_bar_at,confirm_bar_at:candidate.confirm_bar_at,confirmation_1m_at:candidate.confirmation_1m_at,live_qualified:false},
    one_minute_bars:minute,five_minute_bars:five};
  const validated=validateResearchEvent(input,now);
  const metadata={case_id:validated.case_id,observed_at:input.observed_at,source:input.source,direction:candidate.direction,
    pattern:candidate.pattern,level,break_bar_at:candidate.break_bar_at,confirm_bar_at:candidate.confirm_bar_at,confirmation_1m_at:candidate.confirmation_1m_at,
    rationale,structural_qualified:record.structural_qualified??true,scanner_qualified:record.qualified,scanner_reason:reason,
    latest_one_minute_qualified:typeof record.latest_one_minute_qualified==='boolean'?record.latest_one_minute_qualified:null,
    reentry_qualified:typeof record.reentry_qualified==='boolean'?record.reentry_qualified:null,
    live_qualified:false,entry_gate:gate,causal_reference:causal,
    qqq_quote:input.qqq_quote,latest_one_minute_bar:validated.one_minute_bars.at(-1),latest_five_minute_bar:validated.five_minute_bars.at(-1),
    selected_contract:null,research_skipped:false,research_interpretation:'Actual completed setup observation only; no option quote, entry, exit, or fill is assumed.'};
  // Quote/tick timestamps are intentionally excluded from transition identity.
  const fingerprint=createHash('sha256').update(JSON.stringify({case_id:validated.case_id,pattern:candidate.pattern,
    break_bar_at:candidate.break_bar_at,confirm_bar_at:candidate.confirm_bar_at,confirmation_1m_at:candidate.confirmation_1m_at,
    rationale,scanner_qualified:record.qualified,scanner_reason:reason,
    latest_one_minute_qualified:metadata.latest_one_minute_qualified,reentry_qualified:metadata.reentry_qualified,causal_reference:causal})).digest('hex');
  return {input,metadata,fingerprint,case_id:validated.case_id,state_key:validated.case_id,entry_gate:gate};
}

// Strict research v1 requires a real latest 1m confirmation. Preserve a blocked
// five-minute observation separately when that evidence is unavailable.
export function buildMetadataOnlyCandidateObservation({now=Date.now(),qqq,oneMinuteBars,fiveMinuteBars,record}={}){
  now=now instanceof Date?now.getTime():now;const session=marketSession(new Date(now));
  const price=number(qqq?.last_trade_price),quoteAt=time(qqq?.venue_last_trade_time);
  if(!session.verified||!session.is_open||qqq?.symbol!=='QQQ'||qqq.state!=='active'||qqq.has_traded!==true||!Number.isFinite(price)||price<=0||now-quoteAt>10000||quoteAt-now>5000)throw Error('capture_fresh_qqq_unavailable');
  if(record?.qualified!==false||record.structural_qualified===false||record.latest_one_minute_qualified===true)throw Error('capture_metadata_fallback_not_applicable');
  const reason=text(record.reason,500,'capture_candidate_reason_invalid'),five=bars(fiveMinuteBars,300000,now);
  const candidate=validateSetupStructure(record.candidate,{direction:record.candidate?.direction,fiveMinuteBars:five,now:new Date(now)});
  let unavailable=false;
  try{const minute=bars(oneMinuteBars,60000,now);completedBars(minute,60000,new Date(now),{count:minute.length,maxAgeMs:90000});
    const oneAt=time(candidate.confirmation_1m_at);
    if(oneAt!==time(minute.at(-1).begins_at)||oneAt+60000<time(candidate.confirm_bar_at)+300000)throw Error('capture_latest_1m_unavailable');
  }catch{unavailable=true;}
  if(!unavailable)throw Error('capture_metadata_fallback_not_applicable');
  const causal=reference(record.causal_reference??record.reference,candidate),observed_at=new Date(now).toISOString();
  let confirmation=null;try{time(candidate.confirmation_1m_at);confirmation=candidate.confirmation_1m_at;}catch{}
  const gate={status:'blocked',reason,checked_at:observed_at};
  const latest=five.at(-1),normalizedFive={...latest,interpolated:latest.interpolated??null,session:latest.session??null,volume:nullable(latest.volume)};
  for(const key of ['open_price','high_price','low_price','close_price'])normalizedFive[key]=number(latest[key]);
  const metadata={case_id:null,candidate_id:candidate.setup_id,observed_at,source:'robinhood_trading_mcp',direction:candidate.direction,
    pattern:candidate.pattern,level:candidate.level,break_bar_at:candidate.break_bar_at,confirm_bar_at:candidate.confirm_bar_at,confirmation_1m_at:confirmation,
    rationale:candidate.rationale,structural_qualified:true,scanner_qualified:false,scanner_reason:reason,
    latest_one_minute_qualified:typeof record.latest_one_minute_qualified==='boolean'?record.latest_one_minute_qualified:null,
    reentry_qualified:typeof record.reentry_qualified==='boolean'?record.reentry_qualified:null,live_qualified:false,entry_gate:gate,causal_reference:causal,
    qqq_quote:{price,last_trade_at:qqq.venue_last_trade_time},latest_one_minute_bar:null,latest_five_minute_bar:normalizedFive,selected_contract:null,
    research_skipped:true,research_skip_reason:'Strict research requires an actual usable latest one-minute bar and confirmation timestamp; no case or quote baseline was created.',
    research_interpretation:'Actual completed five-minute structure only; one-minute confirmation is unavailable. No option quote or fill is assumed.'};
  const fingerprint=createHash('sha256').update(JSON.stringify({candidate_id:candidate.setup_id,confirm_bar_at:candidate.confirm_bar_at,
    confirmation_1m_at:confirmation,scanner_reason:reason,latest_one_minute_qualified:metadata.latest_one_minute_qualified,reentry_qualified:metadata.reentry_qualified,causal_reference:causal})).digest('hex');
  return {input:null,metadata,fingerprint,case_id:null,candidate_id:candidate.setup_id,state_key:`metadata:${candidate.setup_id}`,entry_gate:gate};
}

export function captureCandidateObservations({folder,now=Date.now(),qqq,oneMinuteBars,fiveMinuteBars,candidates=[],cashSnapshot,marketContext}={}){
  now=now instanceof Date?now.getTime():now;
  const result={version:1,at:Number.isFinite(now)?new Date(now).toISOString():null,status:'idle',reason:null,candidates_seen:0,captured:0,metadata_only:0,duplicate_transitions:0,research_events:0,queued:0,failures:[],cases:[],execution_unaffected:true};
  let release,summary;
  const persist=()=>{try{if(summary){result.totals=summary.totals;atomic(folder,'candidate-capture-state.json',summary);}atomic(folder,'candidate-capture-status.json',result);}
    catch{result.status='error';result.reason='candidate_capture_status_unavailable';if(!result.failures.includes(result.reason))result.failures.push(result.reason);}return result;};
  try{
    const idle=researchIdleReason(folder,{now});if(idle){result.status='skipped';result.reason=idle;return persist();}
    if(!Array.isArray(candidates)||candidates.length>4)throw Error('capture_candidate_batch_invalid');
    release=acquireProcessLock(join(folder,'candidate-capture.lock'));summary=state(folder);
    for(const record of candidates){result.candidates_seen++;
      try{
        const args={now,qqq,oneMinuteBars,fiveMinuteBars,record};let observation;
        try{observation=buildCandidateResearchObservation(args);}catch{observation=buildMetadataOnlyCandidateObservation(args);}
        const previous=summary.cases[observation.state_key];
        if((previous?.last_fingerprint??previous?.fingerprints?.at(-1))===observation.fingerprint){result.duplicate_transitions++;continue;}
        const idle=researchIdleReason(folder,{now});if(idle){result.status='skipped';result.reason=idle;break;}
        if(observation.input){const saved=safeRecordResearchEvent(observation.input,{folder,now});
        if(!['recorded','deduplicated'].includes(saved.status))throw Error('capture_research_record_unavailable');
        if(saved.status==='recorded'){result.research_events++;summary.totals.research_events++;}
        // Scanner qualification is structural only. It never becomes live approval.
        const queued=enqueueResearchCase({case_id:observation.case_id,entry_gate:observation.entry_gate,
          ...(cashSnapshot?{cash_snapshot:cashSnapshot}:{})},{folder,now});
        if(queued.status==='queued'){result.queued++;summary.totals.queued++;}}
        else{result.metadata_only++;summary.totals.metadata_only++;}
        if(marketContext)observation.metadata.market_context=candidateContext(marketContext,{direction:record.candidate.direction,level:record.candidate.level,qqqPrice:Number(qqq.last_trade_price)});
        if(record.room_review?.version===1)observation.metadata.room_review=record.room_review;
        appendJournal(folder,'candidate_capture',observation.metadata);
        summary.cases[observation.state_key]={case_id:observation.case_id,state_key:observation.state_key,candidate_id:observation.candidate_id??null,last_observed_at:observation.metadata.observed_at,
          last_fingerprint:observation.fingerprint,
          fingerprints:[...(previous?.fingerprints??[]),observation.fingerprint].slice(-24)};
        result.captured++;summary.totals.captured++;result.cases.push({case_id:observation.case_id,candidate_id:observation.candidate_id??null,research_skipped:!observation.input,scanner_qualified:record.qualified,entry_gate:observation.entry_gate});
      }catch{result.failures.push('candidate_evidence_or_recording_unavailable');summary.totals.failures++;}
    }
    summary.cases=Object.fromEntries(Object.values(summary.cases).sort((a,b)=>Date.parse(b.last_observed_at)-Date.parse(a.last_observed_at)).slice(0,200).map(item=>[item.state_key??item.case_id,item]));
    if(result.status!=='skipped')result.status=result.captured?'captured':result.failures.length?'partial':'idle';
    return persist();
  }catch{result.status='error';result.reason='candidate_capture_unavailable';result.failures.push(result.reason);if(summary)summary.totals.failures++;return persist();}
  finally{try{release?.();}catch{}}
}
