import { expirationStatus, sessionForDate } from './session.mjs';
import { sessionBoundary } from './market-context.mjs';
import { emergencyStopPrice } from './protection-readiness.mjs';

function knownNumber(value){if(value===null||value===undefined||value==='')return null;return Number.isFinite(Number(value))?Number(value):null;}
// Metadata from the monitor's existing verified snapshot and quote only. It
// adds no broker reads and never changes its decision or protection plan.
export function researchTradeSample({arm,position,option,session,decision,now=Date.now()}={}){
  const verified=!!position&&position.option_id===arm?.option_id&&position.chain_symbol==='QQQ'&&position.type==='long'&&
    knownNumber(position.quantity)===1&&position.expiration_date===arm?.expiration_date;
  const expiry=sessionForDate(arm.expiration_date),expiration=expirationStatus(arm.expiration_date,new Date(now));
  return {research_sample_version:1,observed_at:new Date(now).toISOString(),direction:arm.option_type,
    expiration_date:arm.expiration_date,quantity:arm.quantity,entry_premium:knownNumber(arm.entry_premium),
    opened_at:arm.opened_at??null,entry_basis_verified:arm.entry_basis_verified===true,
    entry_fill_verified:arm.entry_fill_verified===true,entry_recovery_status:arm.entry_recovery_status??null,
    position_verified:verified,position_opened_at:position?.opened_at??null,
    option_bid_size:knownNumber(option?.bid_size),option_ask_size:knownNumber(option?.ask_size),
    session:{verified:session?.verified===true,is_open:session?.is_open===true,date:session?.date??null},
    qqq_invalidation:knownNumber(arm.qqq_invalidation),qqq_exit_level:knownNumber(decision?.qqq_exit_level),
    emergency_stop_price:arm.entry_basis_verified===true?emergencyStopPrice(arm.entry_premium):null,
    mandatory_exit_at:expiry.verified&&expiry.is_trading_day?sessionBoundary(arm.expiration_date,expiry.expiration_cutoff_minute):null,
    mandatory_exit_due:expiration.cutoff_reached||expiration.window_missed,
    fees:null,fees_status:'not_supplied_by_quote_observation',interpretation:'Actual sampled quote and verified position snapshot; no alternative fill is assumed.'};
}
