import { validateEntryIntent } from './entry-recovery.mjs';

export const FIRST_POSITION_WINDOW_MS = 120000;
export const FIRST_FILL_OFFSET_MS = 5000;
export const POSITION_COST_TOLERANCE_DOLLARS = 1;
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/;
function stamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(iso), at = Date.parse(value);
  if (!match || Number(value.slice(11,13))>23 || Number(value.slice(14,16))>59 || Number(value.slice(17,19))>59 ||
      !Number.isFinite(at) || new Date(`${value.slice(0,10)}T12:00:00Z`).toISOString().slice(0,10) !== value.slice(0,10)) return null;
  // Preserve sub-millisecond identity even though JavaScript dates truncate it.
  return { raw:value, at, precise:BigInt(at)*1000000n+BigInt((match[1]??'').padEnd(9,'0').slice(3)) };
}
function number(value) {
  return (typeof value === 'number' || typeof value === 'string' && /^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;
}
function result(status, reason, extra = {}) {
  return { status, owned:status==='position_owned', first_binding:false, reason, ...extra };
}
function sameContract(position,arm) {
  return position?.chain_symbol==='QQQ' && position.option_id===arm?.option_id && position.type==='long' &&
    number(position.quantity)===1 && number(position.trade_value_multiplier)===100 && position.expiration_date===arm?.expiration_date;
}

export function assessPositionOwnership({arm,intent,position,now=Date.now(),firstPositionWindowMs=FIRST_POSITION_WINDOW_MS,
  fillOffsetMs=FIRST_FILL_OFFSET_MS,costToleranceDollars=POSITION_COST_TOLERANCE_DOLLARS}={}) {
  if (!Number.isFinite(now) || !Number.isFinite(firstPositionWindowMs) || firstPositionWindowMs<0 ||
      !Number.isFinite(fillOffsetMs) || fillOffsetMs<0 || !Number.isFinite(costToleranceDollars) || costToleranceDollars<0) {
    return result('position_ownership_unverified','ownership_settings_invalid');
  }
  if (!position) return result('position_absent','broker_position_absent');
  if (!arm || typeof arm.trade_id!=='string' || !arm.trade_id) return result('position_ownership_unverified','armed_trade_identity_unavailable');
  if (!sameContract(position,arm)) return result('position_ownership_changed','broker_position_contract_or_size_changed');
  const opened=stamp(position.opened_at),cost=number(position.average_price);
  if (!opened || opened.at>now+5000) return result('position_ownership_unverified','broker_position_open_time_unavailable');
  if (cost===null || cost<=0) return result('position_ownership_unverified','broker_position_cost_unavailable');
  let original;
  try { original=validateEntryIntent(intent,arm); }
  catch { return result('position_ownership_unverified','original_entry_intent_unavailable'); }
  if (intent.ref_id!==arm.trade_id) return result('position_ownership_unverified','original_trade_reference_unavailable');
  const ceiling=Number(original.price)*100+costToleranceDollars;
  if (cost>ceiling+1e-8) return result('position_ownership_changed','position_cost_exceeds_original_authorized_limit');
  const extra={broker_opened_at:opened.raw,basis_premium:cost/100,broker_cost_per_contract:cost};

  if (Object.hasOwn(arm,'broker_position_opened_at')) {
    const pinned=stamp(arm.broker_position_opened_at),pinnedCost=number(arm.position_cost_at_bind);
    if (!pinned || pinnedCost===null || pinnedCost<=0 || arm.position_owner_trade_id!==arm.trade_id) {
      return result('position_ownership_unverified','persisted_position_owner_invalid',extra);
    }
    if (pinned.precise!==opened.precise) return result('position_ownership_changed','broker_position_lifetime_changed',extra);
    if (Math.abs(cost-pinnedCost)>costToleranceDollars+1e-8) return result('position_ownership_changed','broker_position_cost_materially_changed',extra);
    return result('position_owned','exact_broker_lifetime_verified',extra);
  }

  let proof;
  const intentTime=stamp(intent.created_at);
  if (!intentTime || opened.at<intentTime.at-fillOffsetMs) return result('position_ownership_unverified','position_precedes_original_entry',extra);
  if (intent.fill_checked===true) {
    const filled=stamp(intent.filled_at),fillPrice=number(intent.fill_price);
    if (typeof intent.order_id!=='string' || !intent.order_id || !filled || fillPrice===null || fillPrice<=0 ||
        fillPrice>Number(original.price)+1e-8 || Math.abs(opened.at-filled.at)>fillOffsetMs ||
        Math.abs(cost-fillPrice*100)>costToleranceDollars+1e-8) {
      return result('position_ownership_unverified','position_does_not_correlate_with_verified_fill',extra);
    }
    proof='verified_entry_fill_time';
  } else if (arm.entry_basis_verified===true && arm.entry_basis_source==='broker_position_cost') {
    // Prior position-cost recovery normalized its timestamp to milliseconds.
    const prior=stamp(arm.opened_at),priorPrice=number(arm.entry_premium);
    if (!prior || priorPrice===null || priorPrice<=0 || prior.at!==opened.at || Math.abs(cost-priorPrice*100)>costToleranceDollars+1e-8) {
      return result('position_ownership_changed','position_differs_from_verified_cost_lifetime',extra);
    }
    proof='verified_position_cost_time';
  } else {
    const dispatch=stamp(intent.dispatch_started_at);
    const knownOrder=typeof intent.order_id==='string' && !!intent.order_id;
    if (intent.local_not_sent===true || !dispatch && !knownOrder || intent.dispatch_phase==='prepared') {
      return result('position_ownership_unverified','original_entry_was_not_dispatched',extra);
    }
    const began=dispatch?.at??intentTime.at;
    if (began<intentTime.at-fillOffsetMs || opened.at<began-fillOffsetMs || opened.at>intentTime.at+firstPositionWindowMs+fillOffsetMs) {
      return result('position_ownership_unverified','first_position_outside_original_entry_window',extra);
    }
    proof='bounded_original_entry_time';
  }
  return result('position_owned','first_broker_lifetime_correlated',{...extra,first_binding:true,binding_basis:proof});
}

// Caller persists this arm atomically before authorizing old-trade actions.
// The helper changes ownership metadata only; it cannot adopt a replacement,
// cancel any order, infer an execution fill, or change the trading strategy.
export function confirmPositionOwnership(input) {
  const assessment=assessPositionOwnership(input);
  if (!assessment.owned || !assessment.first_binding) return {arm:input.arm,assessment,changed:false};
  return {arm:{...input.arm,broker_position_opened_at:assessment.broker_opened_at,
    position_owner_trade_id:input.arm.trade_id,position_cost_at_bind:assessment.broker_cost_per_contract,
    ownership_verified_at:new Date(input.now??Date.now()).toISOString(),ownership_binding_basis:assessment.binding_basis},assessment,changed:true};
}

export function assertPositionOwnership(input,{requirePinned=true}={}) {
  const assessment=assessPositionOwnership(input);
  if (!assessment.owned || requirePinned && assessment.first_binding) {
    const error=new Error(`Position ownership blocked: ${requirePinned&&assessment.first_binding?'first broker lifetime must be persisted':assessment.reason}`);
    error.code='LOCAL_PREFLIGHT';
    error.ownership_status=assessment.owned?'position_ownership_unverified':assessment.status;
    error.ownership_reason=assessment.owned?'position_owner_not_persisted':assessment.reason;
    throw error;
  }
  return assessment;
}

export function validatePositionSnapshot(snapshot,{complete=true}={}) {
  if (!snapshot || complete && snapshot.next || !Array.isArray(snapshot.positions) || snapshot.positions.some(position=>
    !position || typeof position.chain_symbol!=='string' || number(position.quantity)===null)) {
    const error=new Error('Position ownership blocked: complete broker position snapshot unavailable');
    error.code='LOCAL_PREFLIGHT';error.ownership_status='position_ownership_unverified';throw error;
  }
  return snapshot.positions;
}

export function positionFromCompleteSnapshot(snapshot,arm) {
  validatePositionSnapshot(snapshot);
  const qqq=snapshot.positions.filter(position=>position.chain_symbol==='QQQ'&&number(position.quantity)!==0);
  if (qqq.length>1 || qqq.length===1 && qqq[0].option_id!==arm?.option_id) {
    const error=new Error('Position ownership blocked: broker QQQ positions changed');
    error.code='LOCAL_PREFLIGHT';error.ownership_status='position_ownership_changed';throw error;
  }
  return qqq[0]??null;
}

export function assertOwnedPositionSnapshot({snapshot,...input},options) {
  const position=positionFromCompleteSnapshot(snapshot,input.arm);
  return assertPositionOwnership({...input,position},options);
}

// Exact old-life closing proof can be recorded while a manual replacement is
// present. The caller deduplicates closure_key under its state lock. Old trade
// files and old working stops stay untouched pending an explicit disposition.
export function confirmedOldClosure({arm,order,replacementPosition,recordedClosureKeys=[],now=Date.now()}={}) {
  const opened=stamp(arm?.broker_position_opened_at),replacement=stamp(replacementPosition?.opened_at);
  const leg=Array.isArray(order?.legs)&&order.legs.length===1?order.legs[0]:null;
  if (!opened || arm.position_owner_trade_id!==arm.trade_id || typeof order?.id!=='string' || !order.id ||
      order.state!=='filled' || order.chain_symbol!=='QQQ' || order.direction!=='credit' || number(order.quantity)!==1 ||
      number(order.processed_quantity)!==1 || number(order.trade_value_multiplier)!==100 || !leg ||
      leg.option_id!==arm.option_id || leg.side!=='sell' || leg.position_effect!=='close' || number(leg.ratio_quantity)!==1 ||
      leg.expiration_date!==arm.expiration_date || leg.option_type!==arm.option_type ||
      !sameContract(replacementPosition,arm) || !replacement || replacement.precise<=opened.precise) return null;
  let closed=stamp(order.last_transaction_at),premium=number(order.processed_premium);
  const executions=leg.executions;
  if (executions!==null && executions!==undefined) {
    if (!Array.isArray(executions) || !executions.length) return null;
    let total=0,quantity=0;const times=[];
    for (const execution of executions) {
      const at=stamp(execution?.timestamp),price=number(execution?.price),count=number(execution?.quantity);
      if (!at || price===null || price<0 || count===null || count<=0 || at.precise<opened.precise) return null;
      quantity+=count;total+=price*count*100;times.push(at);
    }
    if (Math.abs(quantity-1)>1e-8 || premium===null || Math.abs(total-premium)>0.02) return null;
    premium=total;closed=times.reduce((latest,value)=>value.precise>latest.precise?value:latest);
  }
  if (!closed || premium===null || premium<0 || closed.precise<opened.precise || closed.precise>replacement.precise || closed.at>now+5000) return null;
  const closureKey=`${arm.trade_id}:${order.id}`;
  const basis=number(arm.entry_premium);
  const verifiedBasis=arm.entry_basis_verified===true && basis!==null && basis>0;
  const premiumCents=Math.round(premium*100)/100;
  return {closure_key:closureKey,already_recorded:recordedClosureKeys.includes(closureKey),old_close_verified:true,
    order_id:order.id,closed_at:closed.raw,exit_premium_total:premiumCents,
    realized_pnl:verifiedBasis?Math.round((premiumCents-basis*100)*100)/100:null,
    pnl_basis:!verifiedBasis?'unverified_entry_basis':arm.entry_basis_source==='broker_position_cost'?'broker_position_cost_unknown_fees':'fill_premiums_gross',
    fees:null,replacement_present:true,archive_safe:false,required_action:'retain_position_ownership_changed_alert'};
}
