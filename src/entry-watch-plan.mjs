import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {marketSession,sessionForDate} from './session.mjs';
import {assessServiceHealth} from './service-health.mjs';
import {validateSetupStructure,validateSetup,completedBars} from './setup-policy.mjs';
import {requireFreshReentry,recentExitContext} from './reentry.mjs';
import {validateProfitProtectionEvidence} from './profit-protection.mjs';

export const ENTRY_WATCH_MAX_AGE_MS=180000;
export const ENTRY_WATCH_STATE_FILE='entry-watch-state.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH=/^[0-9a-f]{64}$/;
const setupFields=['version','direction','pattern','break_bar_at','confirm_bar_at','level','rationale'];
const inputFields=['version','option_id','direction','expiration','qqq_invalidation','setup','profit_protection'];
const planFields=['version','plan_id','created_at','expires_at','session_date','policy_snapshot','option_id','direction','expiration','qqq_invalidation','setup','profit_protection','plan_sha256'];
const stateFields=['version','plan_id','plan_sha256','status','attempted_at','attempt_id','activation_evidence_sha256'];
const terminalStates=new Set(['dispatch_started','completed','blocked','spawn_failed','outcome_unknown']);
function fail(message){throw Error(`Entry watch blocked: ${message}`);}
function exact(value,keys,label){if(!value||typeof value!=='object'||Array.isArray(value)||keys.some(k=>!Object.hasOwn(value,k))||Object.keys(value).some(k=>!keys.includes(k)))fail(`${label} fields invalid`);}
function at(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||
      new Date(value).toISOString().slice(0,19)!==value.slice(0,19))fail(`${label} timestamp invalid`);
  return Date.parse(value);
}
function positive(value,label){if(typeof value!=='number'||!Number.isFinite(value)||value<=0)fail(`${label} unavailable`);return value;}
function snapshot(value){
  exact(value,['schema_version','policy_id','revision','sha256'],'approved policy snapshot');
  if(value.schema_version!==1||value.policy_id!=='qqq-1dte-risk'||!Number.isSafeInteger(value.revision)||value.revision<1||!HASH.test(value.sha256))fail('approved policy snapshot invalid');
  return {...value};
}
function canonical(plan){return Object.fromEntries(planFields.filter(k=>k!=='plan_sha256').map(k=>[k,plan[k]]));}
function checksum(plan){return createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');}
function checkedSession(now,expected){
  if(!Number.isFinite(now))fail('observation time invalid');
  const current=marketSession(new Date(now));
  if(!current.verified||!current.can_enter)fail('outside verified entry session');
  if(expected&&(expected.date!==current.date||expected.verified!==true||expected.can_enter!==true))fail('session identity changed');
  return current;
}
function structureInput(input){
  exact(input,inputFields,'entry plan input');exact(input.setup,setupFields,'five-minute setup');
  if(input.version!==1||!UUID.test(input.option_id)||!['call','put'].includes(input.direction)||input.setup.version!==1||input.setup.direction!==input.direction)fail('contract or setup identity invalid');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.expiration)||!sessionForDate(input.expiration).verified||!sessionForDate(input.expiration).is_trading_day)fail('expiration unavailable');
  at(input.setup.break_bar_at,'break');at(input.setup.confirm_bar_at,'confirmation');
  positive(input.qqq_invalidation,'fixed invalidation');positive(input.setup.level,'reference level');
  validateProfitProtectionEvidence(input.profit_protection);
}
function currentQuote(plan,quote,now){
  if(quote?.symbol!=='QQQ'||quote.state!=='active'||quote.has_traded!==true)fail('fresh QQQ quote unavailable');
  const price=Number(quote.last_trade_price),time=at(quote.venue_last_trade_time,'QQQ quote');
  if(!Number.isFinite(price)||price<=0||now-time>10000||time>now+5000)fail('fresh QQQ quote unavailable');
  const sign=plan.direction==='call'?1:-1;
  if(sign*(price-plan.setup.level)<=0)fail('current quote lost the original setup level');
  if(sign*(price-plan.qqq_invalidation)<=0||Math.abs(price-plan.qqq_invalidation)>price*.01)fail('fixed invalidation is no longer eligible');
  return price;
}
function reentryStructure(lastExit,setup,now){
  const context=recentExitContext(lastExit,now);
  if(!context?.evaluation_required)return;
  const closed=at(context.closed_at,'prior verified close');
  if(at(setup.break_bar_at,'new break')+300000<=closed||at(setup.confirm_bar_at,'new confirmation')+300000<=closed)fail('new five-minute structure after the prior close is required');
}

export function createEntryWatchPlan(input,{fiveMinuteBars,qqqQuote,policySnapshot,session,now=Date.now(),previous,lastExit,
  ttlMs=ENTRY_WATCH_MAX_AGE_MS,planId=randomUUID()}={}){
  structureInput(input);const current=checkedSession(now,session);
  if(input.expiration<=current.date||!UUID.test(planId)||!Number.isSafeInteger(ttlMs)||ttlMs<=0||ttlMs>ENTRY_WATCH_MAX_AGE_MS)fail('plan identity, lifetime or expiry invalid');
  const verified=validateSetupStructure(input.setup,{direction:input.direction,fiveMinuteBars,now:new Date(now),previous});
  reentryStructure(lastExit,verified,now);currentQuote(input,qqqQuote,now);
  const plan={version:1,plan_id:planId,created_at:new Date(now).toISOString(),expires_at:new Date(now+ttlMs).toISOString(),
    session_date:current.date,policy_snapshot:snapshot(policySnapshot),option_id:input.option_id,direction:input.direction,
    expiration:input.expiration,qqq_invalidation:input.qqq_invalidation,setup:Object.fromEntries(setupFields.map(k=>[k,verified[k]])),
    profit_protection:{...input.profit_protection}};
  plan.plan_sha256=checksum(plan);return plan;
}

export function validateEntryWatchPlan(plan,{policySnapshot,session,now=Date.now(),allowExpired=false,requireEntrySession=true}={}){
  exact(plan,planFields,'saved entry plan');
  structureInput(Object.fromEntries(inputFields.map(k=>[k,plan[k]])));
  const created=at(plan.created_at,'plan creation'),expires=at(plan.expires_at,'plan expiry');
  if(!UUID.test(plan.plan_id)||!HASH.test(plan.plan_sha256)||checksum(plan)!==plan.plan_sha256||expires<=created||expires-created>ENTRY_WATCH_MAX_AGE_MS||created>now+5000)fail('saved plan identity, integrity or lifetime invalid');
  snapshot(plan.policy_snapshot);
  if(policySnapshot){const current=snapshot(policySnapshot);if(JSON.stringify(current)!==JSON.stringify(snapshot(plan.policy_snapshot)))fail('approved policy changed');}
  if(!allowExpired&&now>=expires)fail('plan expired');
  if(!Number.isFinite(now))fail('observation time invalid');
  if(plan.session_date!==marketSession(new Date(created)).date||plan.expiration<=plan.session_date)fail('saved plan session identity invalid');
  if(requireEntrySession){const current=checkedSession(now,session);if(plan.session_date!==current.date)fail('saved plan belongs to another session');}
  return plan;
}

export function validateEntryWatchState(state,plan){
  if(state===null||state===undefined)return null;
  exact(state,stateFields,'plan attempt state');
  if(state.version!==1||state.plan_id!==plan.plan_id||state.plan_sha256!==plan.plan_sha256||
      !(state.status==='prepared'||terminalStates.has(state.status)))fail('attempt state identity or status invalid');
  if(state.status==='prepared'){
    if(state.attempted_at!==null||state.attempt_id!==null||state.activation_evidence_sha256!==null)fail('prepared plan has an attempt');
  }else{
    if(!UUID.test(state.attempt_id)||!HASH.test(state.activation_evidence_sha256??''))fail('attempt identity invalid');
    const time=at(state.attempted_at,'plan attempt');
    if(time<at(plan.created_at,'plan creation')||time>=at(plan.expires_at,'plan expiry'))fail('attempt lies outside original plan lifetime');
  }
  return state;
}

export function assessEntryWatchPlan({plan,state=null,policySnapshot,session,health,localState,brokerSnapshot,qqqQuote,
  fiveMinuteBars,oneMinuteBars,previous,lastExit,now=Date.now()}={}){
  const result=(status,reason,extra={})=>({status,ready:status==='ready',reason,plan_id:plan?.plan_id,
    plan_sha256:plan?.plan_sha256,checked_at:Number.isFinite(now)?new Date(now).toISOString():null,...extra});
  try{
    // Unknown policy is never interpreted as approval for a fast entry.
    snapshot(policySnapshot);validateEntryWatchPlan(plan,{policySnapshot,session,now,allowExpired:true});
    validateEntryWatchState(state,plan);
    if(state&&terminalStates.has(state.status))return result('attempted','original_plan_attempt_already_consumed');
    if(now>=Date.parse(plan.expires_at))return result('expired','original_plan_expired');
    if(!localState||localState.trade_state_present!==false||localState.entry_busy!==false)return result('blocked','local_trade_priority_or_state_unknown');
    const service=assessServiceHealth(health,{now,maxAgeMs:60000,hasState:false});
    if(!service.live_verified||service.reported_status!=='idle'||service.data_unavailable||service.deadline_exceeded)return result('blocked','exit_monitor_not_verified_idle');
    if(brokerSnapshot!==undefined){
      if(!brokerSnapshot||brokerSnapshot.next||!Array.isArray(brokerSnapshot.positions)||brokerSnapshot.positions.some(p=>!p||typeof p.chain_symbol!=='string'||
          !['number','string'].includes(typeof p.quantity)||typeof p.quantity==='string'&&!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(p.quantity.trim())||!Number.isFinite(Number(p.quantity))))return result('blocked','broker_position_snapshot_unverified');
      if(brokerSnapshot.positions.some(p=>p.chain_symbol==='QQQ'&&Number(p.quantity)!==0))return result('blocked','manual_or_other_qqq_position');
    }
    const verified=validateSetupStructure(plan.setup,{direction:plan.direction,fiveMinuteBars,now:new Date(now),previous});
    reentryStructure(lastExit,verified,now);const qqqPrice=currentQuote(plan,qqqQuote,now);
    const minutes=completedBars(oneMinuteBars,60000,new Date(now));
    const candidate={...plan.setup,confirmation_1m_at:minutes.at(-1).begins_at};
    let ready;
    try{ready=validateSetup(candidate,{direction:plan.direction,fiveMinuteBars,oneMinuteBars,now:new Date(now),previous});}
    catch(error){
      if(String(error.message).includes('directional follow-through'))return result('waiting','latest_completed_minute_followthrough_pending',{qqq_price:qqqPrice,one_minute_at:minutes.at(-1).begins_at});
      throw error;
    }
    requireFreshReentry(lastExit,ready,now);
    return result('ready','fresh_followthrough_matches_original_plan',{qqq_price:qqqPrice,setup:{...ready,profit_protection:{...plan.profit_protection}}});
  }catch(error){return result('blocked',String(error.message).slice(0,300));}
}

export function buildEntryDispatch(plan,assessment,{now=Date.now()}={}){
  if(!assessment?.ready||assessment.status!=='ready'||assessment.plan_id!==plan.plan_id||assessment.plan_sha256!==plan.plan_sha256)fail('a fresh ready assessment is required');
  const checked=at(assessment.checked_at,'activation assessment');
  if(!Number.isFinite(now)||now-checked>10000||checked>now+5000||now>=at(plan.expires_at,'plan expiry')||checksum(plan)!==plan.plan_sha256)fail('activation assessment expired or plan changed');
  const evidence=assessment.setup;
  if(!evidence||setupFields.some(key=>evidence[key]!==plan.setup[key])||JSON.stringify(evidence.profit_protection)!==JSON.stringify(plan.profit_protection))fail('activation evidence differs from the immutable plan');
  at(evidence.confirmation_1m_at,'latest minute');
  return {args:[plan.option_id,plan.direction,plan.expiration,String(plan.qqq_invalidation)],setup:structuredClone(evidence)};
}

// Caller holds the plan lock, rereads the plan/state, saves this result
// atomically, and only then spawns entry.mjs. Every non-prepared outcome is
// consumed; a crash or missing child response cannot authorize another buy.
export function claimEntryWatchPlan(plan,state,{assessment,now=Date.now(),attemptId=randomUUID()}={}){
  validateEntryWatchState(state,plan);
  if(state&&state.status!=='prepared')fail('plan attempt was already consumed');
  if(!UUID.test(attemptId))fail('attempt identity invalid');
  const dispatch=buildEntryDispatch(plan,assessment,{now});
  return {version:1,plan_id:plan.plan_id,plan_sha256:plan.plan_sha256,status:'dispatch_started',attempted_at:new Date(now).toISOString(),attempt_id:attemptId,
    activation_evidence_sha256:activationEvidenceHash(dispatch.setup)};
}

function activationEvidenceHash(evidence){
  const fields=[...setupFields,'confirmation_1m_at','setup_id','profit_protection'];
  exact(evidence,fields,'activation evidence');validateProfitProtectionEvidence(evidence.profit_protection);
  if(!HASH.test(evidence.setup_id??''))fail('activation setup identity invalid');
  at(evidence.confirmation_1m_at,'activation minute');
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(fields.map(key=>[key,key==='profit_protection'?
    {version:evidence.profit_protection.version,mode:evidence.profit_protection.mode,rationale:evidence.profit_protection.rationale}:evidence[key]])))).digest('hex');
}

export function validateEntryWatchClaim({plan,state,planId,optionId,direction,expiration,invalidation,candidate,
  policySnapshot,now=Date.now(),expectedAttemptId}={}){
  snapshot(policySnapshot);
  validateEntryWatchPlan(plan,{policySnapshot,now});validateEntryWatchState(state,plan);
  if(!UUID.test(planId??'')||plan.plan_id!==planId||state?.status!=='dispatch_started'||
      expectedAttemptId&&state.attempt_id!==expectedAttemptId)fail('saved child claim changed or was cancelled');
  if(optionId!==plan.option_id||direction!==plan.direction||expiration!==plan.expiration||invalidation!==plan.qqq_invalidation||
      setupFields.some(key=>candidate?.[key]!==plan.setup[key])||activationEvidenceHash(candidate)!==state.activation_evidence_sha256)fail('entry command or evidence differs from the original claimed plan');
  return {plan,state,setup_id:candidate.setup_id};
}

// The agent authorized the fixed five-minute structure and runtime one-minute
// confirmation. Preserve the original file/claim proof and derive only the
// latest real completed minute for the existing full entry validator.
export function refreshClaimedEntryEvidence(candidate,claim,{oneMinuteBars,now=Date.now()}={}){
  if(!claim?.plan||!claim.state)fail('verified original fast claim required');
  validateEntryWatchPlan(claim.plan,{now});validateEntryWatchState(claim.state,claim.plan);
  if(claim.state.status!=='dispatch_started'||setupFields.some(key=>candidate?.[key]!==claim.plan.setup[key])||
      activationEvidenceHash(candidate)!==claim.state.activation_evidence_sha256)fail('original activation evidence or claim changed');
  const minutes=completedBars(oneMinuteBars,60000,new Date(now));
  return {...structuredClone(candidate),confirmation_1m_at:minutes.at(-1).begins_at};
}

export function entryAttemptPrevious(lastSetup,lastFastAttempt,{ownPlanId,ownSetupId,ownAttemptedAt}={}){
  const valid=(value,label)=>{if(value&&(!HASH.test(value.setup_id??'')||!Number.isFinite(Date.parse(value.break_bar_at??''))))fail(`${label} attempt history invalid`);return value;};
  const prior=valid(lastSetup,'direct'),fast=valid(lastFastAttempt,'fast');
  if(fast&&(!UUID.test(fast.plan_id??'')||!Number.isFinite(Date.parse(fast.attempted_at??''))))fail('fast attempt identity invalid');
  if(ownPlanId){
    if(!fast||ownPlanId!==fast.plan_id||ownSetupId!==fast.setup_id||ownAttemptedAt!==fast.attempted_at)fail('own fast attempt history unavailable or changed');
    return prior??null;
  }
  if(!prior)return fast??null;if(!fast)return prior;
  return Date.parse(fast.break_bar_at)>Date.parse(prior.break_bar_at)?fast:prior;
}

export function assertDirectEntryPlanClear({plan,state,now=Date.now()}={}){
  if(!plan){if(state)fail('unmatched fast entry attempt state requires review');return;}
  validateEntryWatchPlan(plan,{now,allowExpired:true,requireEntrySession:false});validateEntryWatchState(state,plan);
  if(!state||['prepared','dispatch_started','outcome_unknown'].includes(state.status))fail('cancel or resolve the pending fast entry plan before a direct entry');
}

export function readEntryWatchState(folder,{plan,filename=ENTRY_WATCH_STATE_FILE}={}){
  if(filename!==ENTRY_WATCH_STATE_FILE)fail('attempt state filename invalid');
  const file=join(folder,filename);
  try{
    const size=statSync(file).size;if(size>65536)fail('attempt state too large');
    const state=JSON.parse(readFileSync(file,'utf8'));if(!plan)fail('saved plan required for state identity');
    return validateEntryWatchState(state,plan);
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export function readEntryWatchPlan(folder,options={}){
  const file=join(folder,'entry-watch-plan.json');
  try{
    if(statSync(file).size>65536)fail('saved plan too large');
    return validateEntryWatchPlan(JSON.parse(readFileSync(file,'utf8')),options);
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
