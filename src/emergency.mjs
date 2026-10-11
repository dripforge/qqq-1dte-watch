import { randomUUID } from 'node:crypto';
import { marketSession } from './session.mjs';
import { sessionSubmissionGuard } from './session-guard.mjs';
import { isWorkingOrder, isVerifiedZeroFillTerminal } from './order-state.mjs';
import { emergencyStopPrice, entryBasisVerified, freshOptionMarket, matchingStopIdentity, inspectEmergencyStop, protectionReadiness } from './protection-readiness.mjs';
export { emergencyStopPrice } from './protection-readiness.mjs';

const terminal = new Set(['cancelled', 'rejected', 'failed', 'voided']);
const pending = new Set(['unconfirmed', 'queued', 'pending', 'pending_new', 'confirmed', 'partially_filled', 'pending_cancelled', 'pending_canceled']);
const rethrowOwnership = error => {if(error?.ownership_status)throw error;};
const message = error => String(error?.message ?? error).slice(0, 200);

// A missing response keeps its exact reference and arguments. A new reference
// is allowed only after a known order is verified terminal with zero fills.
export async function ensureStop({ arm, broker, intentStore, clock = () => Date.now(), entryFillVerified }) {
  const initialNow = new Date(clock());
  let intent = intentStore.load();
  if (intent && (intent.option_id !== arm.option_id || intent.trade_id && arm.trade_id && intent.trade_id !== arm.trade_id)) {
    throw new Error('Emergency stop intent belongs to another trade');
  }
  const previousReadiness = intent?.readiness;
  const verifiedBasis = entryBasisVerified(arm, entryFillVerified);
  const save = change => {
    intent = { option_id: arm.option_id, ...(arm.trade_id ? {trade_id: arm.trade_id} : {}), ...intent, ...change };
    intentStore.save(intent);
  };
  const finish = (status, extra = {}, { assessment, quote, issues = [] } = {}) => {
    const readiness = protectionReadiness({arm,now:new Date(clock()),orderAssessment:assessment,quote,
      previous:previousReadiness,entryFillVerified:verifiedBasis,status,pendingAt:intent?.pending_at,extraIssues:issues});
    save({readiness});
    return {status,...extra,readiness,protection_phase:readiness.phase,protection_ready:readiness.ready_for_session};
  };
  let orders;
  try { orders = (await broker.orders(arm.option_id)).filter(Boolean); }
  catch (error) { rethrowOwnership(error); return finish('stop_outcome_unknown',{message:message(error)},{issues:['stop_lookup_unavailable']}); }
  const working = orders.filter(isWorkingOrder);
  const stops = working.filter(order => order.trigger === 'stop');
  if (working.length > 1) return finish('stop_order_unverified',{}, {issues:['multiple_closing_orders']});
  if (working.length && !stops.length) return finish('close_order_working',{order_id:working[0].id});

  let observed = stops[0] ?? null;
  if (!observed && intent?.order_id) {
    try { observed = await broker.order(intent.order_id); }
    catch (error) { rethrowOwnership(error); return finish('stop_outcome_unknown',{order_id:intent.order_id,message:message(error)},{issues:['stop_lookup_unavailable']}); }
    if (!observed) return finish('stop_outcome_unknown',{order_id:intent.order_id},{issues:['stop_lookup_unavailable']});
  }
  let assessment;
  let provisionalStatus;
  if (observed && (isWorkingOrder(observed) || observed.state === 'filled')) {
    assessment = inspectEmergencyStop(observed,arm,{now:new Date(clock()),entryFillVerified:verifiedBasis});
    save({order_id:observed.id,order_state:observed.state});
    if (observed.state==='filled'&&matchingStopIdentity(observed,arm)&&Number(observed.processed_quantity)===1) {
      return finish('stop_filled_waiting_position',{order_id:observed.id},{assessment});
    }
    if (!assessment.valid) provisionalStatus = assessment.safe_to_replace ? 'stop_repair_required' : 'stop_order_unverified';
    else if (assessment.filled) return finish('stop_filled_waiting_position',{order_id:observed.id},{assessment});
    else if (assessment.broker_armed) return finish('stop_armed',{order_id:observed.id},{assessment});
    else if (assessment.renewal_required) provisionalStatus = 'stop_session_expired';
    else provisionalStatus = 'stop_pending';
    if (provisionalStatus === 'stop_pending') save({pending_at:intent?.pending_at ?? new Date(clock()).toISOString()});
  } else if (observed) {
    if (!matchingStopIdentity(observed,arm)||!isVerifiedZeroFillTerminal(observed)) return finish('stop_outcome_unknown',{
      order_id:observed.id,order_state:observed.state},{issues:['stop_final_fill_unverified']});
    const currentDate=marketSession(new Date(clock())).date;
    const sameFailureSession=intent?.failure_session===currentDate;
    const failures=(sameFailureSession?intent.failures??0:0)+(['rejected','failed'].includes(observed.state)?1:0);
    // Count each verified rejected order once, even if the monitor revisits it.
    const total=intent?.last_failure_order_id===observed.id?(sameFailureSession?intent.failures??0:0):failures;
    if(total>=3) return finish('stop_repeatedly_rejected',{needs_exit:true,reason:'emergency_stop_unavailable',
      observed_at:new Date(clock()).toISOString()},{issues:['stop_rearm_failed']});
    save({option_id:arm.option_id,order_id:null,ref_id:randomUUID(),attempt:(intent?.attempt??1)+1,
      replaces_verified_order_id:observed.id,created_at:new Date(clock()).toISOString(),
      stop_price:null,pending_at:null,cancellation_requested_at:null,
      failure_session:currentDate,failures:total,last_failure_order_id:observed.id});
    observed=null;
  }

  let session=marketSession(new Date(clock()));
  if(!session.is_open||session.date>arm.expiration_date) return finish(provisionalStatus==='stop_order_unverified'?provisionalStatus:'stop_unavailable_now',{
    calendar_verified:session.verified,market_reason:session.reason,order_id:observed?.id},{assessment});
  let quote;
  try { quote = await broker.optionQuote(arm.option_id); }
  catch(error) { rethrowOwnership(error); return finish(provisionalStatus??'stop_unavailable_now',{message:message(error),order_id:observed?.id},
    {assessment,issues:['local_quote_unavailable']}); }
  const market=freshOptionMarket(quote,clock());
  if(!market.valid) {
    return finish(provisionalStatus??'stop_unavailable_now',{order_id:observed?.id},{assessment,quote,issues:['local_quote_unavailable']});
  }
  if(!verifiedBasis) return finish('stop_order_unverified',{order_id:observed?.id},{assessment,quote,issues:['entry_fill_unverified']});
  const stopPrice=emergencyStopPrice(arm.entry_premium);
  if(market.bid<=stopPrice) return finish('emergency_exit',{needs_exit:true,reason:'emergency_premium',observed_at:quote.updated_at,
    quote,stop_price:stopPrice},{assessment,quote});
  session=marketSession(new Date(clock()));
  if(!session.is_open||session.date>arm.expiration_date) return finish('stop_unavailable_now',{
    quote,stop_price:stopPrice,calendar_verified:session.verified,market_reason:session.reason},{assessment,quote});
  if(session.minute<session.entry_start_minute) return finish('local_premium_watch_only',{
    quote,stop_price:stopPrice,order_id:observed?.id},{assessment,quote});
  if(provisionalStatus==='stop_order_unverified') return finish(provisionalStatus,{order_id:observed.id},{assessment,quote});
  if(provisionalStatus==='stop_pending') return finish(provisionalStatus,{order_id:observed.id},{assessment,quote});

  // A GFD order from a previous session cannot be claimed as overnight broker
  // protection. If the broker still reports it working, cancel and prove zero
  // fills before creating today's order. Never sell twice during this renewal.
  if(['stop_session_expired','stop_repair_required'].includes(provisionalStatus)) {
    if(typeof broker.cancel!=='function') return finish(provisionalStatus,{order_id:observed.id},{assessment,quote,issues:['stop_rearm_unavailable']});
    if(!['pending_cancelled','pending_canceled'].includes(observed.state)&&!intent?.cancellation_requested_at) {
      try { await broker.cancel(observed.id);save({cancellation_requested_at:new Date(clock()).toISOString()}); }
      catch(error) { rethrowOwnership(error);return finish('stop_outcome_unknown',{order_id:observed.id,message:message(error)},{assessment,quote,issues:['stop_cancel_unverified']});}
    }
    let final;
    try { final=await broker.order(observed.id); }
    catch(error) { rethrowOwnership(error);return finish('stop_outcome_unknown',{order_id:observed.id,message:message(error)},{assessment,quote,issues:['stop_cancel_unverified']});}
    if(final?.state==='filled') {
      const filled=inspectEmergencyStop(final,arm,{now:new Date(clock()),entryFillVerified:verifiedBasis});
      return finish(matchingStopIdentity(final,arm)&&Number(final.processed_quantity)===1?'stop_filled_waiting_position':'stop_order_unverified',{order_id:observed.id},{assessment:filled,quote});
    }
    if(!matchingStopIdentity(final,arm)||!isVerifiedZeroFillTerminal(final)) return finish(isWorkingOrder(final)?'stop_rearm_pending':'stop_outcome_unknown',{
      order_id:observed.id,order_state:final?.state},{assessment,quote,issues:['stop_cancel_unverified']});
    save({order_id:null,ref_id:randomUUID(),attempt:(intent?.attempt??1)+1,
      replaces_verified_order_id:observed.id,created_at:new Date(clock()).toISOString(),stop_price:null,pending_at:null,
      cancellation_requested_at:null,failure_session:session.date,failures:0});
  }
  const current=marketSession(new Date(clock()));
  if(!current.is_open||current.minute<current.entry_start_minute||current.date>arm.expiration_date) return finish('stop_unavailable_now',{
    quote,stop_price:stopPrice,calendar_verified:current.verified,market_reason:current.reason},{quote});
  if(!freshOptionMarket(quote,clock()).valid) {
    try {quote=await broker.optionQuote(arm.option_id);}
    catch(error) { rethrowOwnership(error);return finish('stop_unavailable_now',{message:message(error)},{quote,issues:['local_quote_unavailable']});}
    const renewedMarket=freshOptionMarket(quote,clock());
    if(!renewedMarket.valid) return finish('stop_unavailable_now',{quote},{quote,issues:['local_quote_unavailable']});
    if(renewedMarket.bid<=stopPrice) return finish('emergency_exit',{needs_exit:true,reason:'emergency_premium',
      observed_at:quote.updated_at,quote,stop_price:stopPrice},{quote});
  }
  const dispatchSession=marketSession(new Date(clock()));
  if(!dispatchSession.is_open||dispatchSession.minute<dispatchSession.entry_start_minute||dispatchSession.date>arm.expiration_date) return finish('stop_unavailable_now',{
    quote,stop_price:stopPrice,calendar_verified:dispatchSession.verified,market_reason:dispatchSession.reason},{quote});
  if(!intent?.ref_id) save({ref_id:randomUUID(),attempt:1,created_at:initialNow.toISOString()});
  // Freeze the exact arguments for a reference across every transport retry.
  save({stop_price:intent.stop_price??stopPrice.toFixed(2),local_not_sent:false});
  let result;
  try {result=await broker.placeStop({option_id:arm.option_id,ref_id:intent.ref_id,stop_price:intent.stop_price},{beforeSend:()=>{
    sessionSubmissionGuard(arm,{stop:true,clock})();
    if(!freshOptionMarket(quote,clock()).valid) {
      const error=new Error('Option quote became stale before emergency stop submission');error.code='LOCAL_PREFLIGHT';throw error;
    }
  }});}
  catch(error) { rethrowOwnership(error);
    if(error.code==='LOCAL_PREFLIGHT') {
      save({local_not_sent:true,blocked_at:new Date(clock()).toISOString(),block_reason:message(error)});
      const next=marketSession(new Date(clock()));
      return finish('stop_unavailable_now',{local_not_sent:true,quote,stop_price:stopPrice,
        calendar_verified:next.verified,market_reason:next.reason,message:message(error)},{quote});
    }
    return finish('stop_outcome_unknown',{message:message(error),quote,stop_price:stopPrice},{quote,issues:['stop_submission_unknown']});
  }
  const order=result?.order;
  if(!order?.id||(!pending.has(order.state)&&!terminal.has(order.state)&&order.state!=='filled')) return finish('stop_outcome_unknown',{
    quote,stop_price:stopPrice},{quote,issues:['stop_submission_unknown']});
  save({order_id:order.id,order_state:order.state,submitted_at:new Date(clock()).toISOString(),local_not_sent:false,
    pending_at:order.state==='confirmed'?null:new Date(clock()).toISOString()});
  if(terminal.has(order.state)) return finish('stop_rejected',{order_id:order.id,order_state:order.state,
    reject_reason:order.reject_reason,quote,stop_price:stopPrice},{quote,issues:['stop_rearm_failed']});
  const placed=inspectEmergencyStop(order,arm,{now:new Date(clock()),entryFillVerified:verifiedBasis});
  return finish(!placed.valid?'stop_order_unverified':placed.filled?'stop_filled_waiting_position':placed.broker_armed?'stop_armed':'stop_pending',
    {order_id:order.id,quote,stop_price:stopPrice},{assessment:placed,quote});
}
