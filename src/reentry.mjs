import { marketSession } from './session.mjs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function verifiedExitContext({arm,proof,reason}){
  const at=Date.parse(proof?.closed_at??'');
  if(!uuid.test(arm?.trade_id??'')||!uuid.test(arm?.option_id??'')||!uuid.test(proof?.order_id??'')||
    !Number.isFinite(at)||!['call','put'].includes(arm.option_type)||
    typeof reason!=='string'||!/^[a-z][a-z0-9_]{0,99}$/.test(reason))throw Error('Verified exit context unavailable');
  return {version:1,closure_verified:true,trade_id:arm.trade_id,option_id:arm.option_id,direction:arm.option_type,
    closed_at:new Date(at).toISOString(),closing_order_id:proof.order_id,reason,
    original_qqq_invalidation:arm.qqq_invalidation,
    post_stop:['qqq_invalidation','emergency_premium','emergency_exit','broker_stop_or_external_close'].includes(reason)};
}
export function recentExitContext(lastExit,now=Date.now()){
  if(!lastExit)return null;
  if(lastExit.version!==1||lastExit.closure_verified!==true||!uuid.test(lastExit.trade_id??'')||
    !uuid.test(lastExit.option_id??'')||!Number.isFinite(Date.parse(lastExit.closed_at??'')))throw Error('Last exit context is unverified');
  const closed=Date.parse(lastExit.closed_at),time=now instanceof Date?now.getTime():now;
  if(closed>time+5000)throw Error('Last exit context is in the future');
  const current=marketSession(new Date(time)),previous=marketSession(new Date(closed));
  return {...lastExit,same_session:current.date===previous.date,elapsed_ms:time-closed,
    evaluation_required:current.date===previous.date};
}
export function requireFreshReentry(lastExit,setup,now=Date.now()){
  const context=recentExitContext(lastExit,now);
  if(!context?.evaluation_required)return {status:'not_required',context};
  const closed=Date.parse(context.closed_at),broken=Date.parse(setup?.break_bar_at??'')+300000,
    confirmed=Date.parse(setup?.confirm_bar_at??'')+300000,followed=Date.parse(setup?.confirmation_1m_at??'')+60000;
  if(![broken,confirmed,followed].every(Number.isFinite)||broken<=closed||confirmed<=closed||followed<=closed)
    throw Error('Re-entry needs a new break completed after the verified prior exit and fresh follow-through');
  return {status:'fresh_setup_after_verified_exit',context,break_completed_at:new Date(broken).toISOString()};
}
