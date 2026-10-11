import { marketSession } from './session.mjs';
import { assessServiceHealth } from './service-health.mjs';
import { assertFlatPositionSnapshot } from './owned-dispatch.mjs';
import { isWorkingOrder } from './order-state.mjs';
import { validateSetupStructure,validateSetup } from './setup-policy.mjs';
import { reviewSetupRoom } from './setup-review.mjs';
import { requireNearMoneyContract,validateOptionMarket } from './contract-selection.mjs';
import { brokerDailyRealized,reserveRisk } from './risk-policy.mjs';
import { AUDIT_STAGES,runtimeManifest,validateDecisionAudit,attachDecisionAudit } from './audit-record.mjs';
import { VERSION } from './version.mjs';

/** Offline evaluation only. No broker adapter, order dispatcher or live approval. */
export function evaluateOfflineCheck(input, {folder} = {}) {
  if(input?.synthetic!==true)throw Error('Offline demo requires explicitly synthetic input');
  const now=input.now.getTime(),observed_at=new Date(now).toISOString();
  const audit={version:1,started_at:observed_at,runtime_hash:runtimeManifest(undefined,now).runtime_hash,
    checks:Object.fromEntries(AUDIT_STAGES.map(stage=>[stage,{status:'not_evaluated',reason:'An earlier stage stopped this check.'}])),facts:{}};
  let stage='session',outcome='entry_blocked',reason,setup,room,risk,contract;
  const pass=(name,detail)=>{audit.checks[name]={status:'pass',reason:detail};};
  try {
    const session=marketSession(input.now);
    if(!session.verified||!session.can_enter)throw Error('Outside the verified entry session');
    pass(stage,'Synthetic observation falls inside the verified entry session.');
    stage='service';const health=assessServiceHealth(input.health,{now,hasState:false});
    if(!health.live_verified||health.reported_status!=='idle'||health.data_unavailable||health.deadline_exceeded===true)throw Error('Synthetic monitor evidence is stale or not idle');
    pass(stage,'Synthetic service fixture satisfies the same freshness and idle-state checks.');
    stage='position';assertFlatPositionSnapshot(input.positions);
    if(!Array.isArray(input.orders)||input.orders.some(isWorkingOrder))throw Error('Order snapshot is missing or a working order exists');
    pass(stage,'Complete synthetic position snapshot is flat and no working orders exist.');
    stage='structure';setup=validateSetupStructure(input.candidate,{direction:input.candidate.direction,fiveMinuteBars:input.fiveMinuteBars,now:input.now});
    audit.facts={direction:setup.direction,reference_level:setup.level,break_bar_at:setup.break_bar_at,confirm_bar_at:setup.confirm_bar_at};
    pass(stage,'Completed five-minute break and later confirmation validated.');
    stage='follow_through';validateSetup(input.candidate,{direction:setup.direction,fiveMinuteBars:input.fiveMinuteBars,oneMinuteBars:input.oneMinuteBars,now:input.now});
    pass(stage,'The latest completed one-minute bar confirms directional follow-through.');
    stage='room';room=reviewSetupRoom({...input,candidate:setup});
    if(room.status!=='reviewed')throw Error(room.reason??'Room evidence unavailable');
    audit.facts.invalidation=room.current_invalidation;audit.facts.room=room.room_to_obstacle;
    audit.facts.obstacle=room.next_confirmed_obstacle?.price??null;audit.facts.adverse_distance=room.distance_to_invalidation;
    // No configured automatic room threshold exists. Calculating evidence cannot imply approval.
    audit.checks.room={status:'not_evaluated',reason:`Room evidence calculated; ${room.next_confirmed_obstacle?'confirmed obstacle found':'no confirmed obstacle in this window'}. Discretionary approval remains unevaluated.`};
    stage='contract';const {chain,instrument,option}=input;
    const nextExpiry=chain.expiration_dates.filter(date=>date>session.date).sort()[0];
    if(chain.symbol!=='QQQ'||!chain.can_open_position||Number(chain.trade_value_multiplier)!==100||instrument.chain_id!==chain.id||instrument.type!==setup.direction||instrument.expiration_date!==nextExpiry||instrument.state!=='active'||instrument.tradability!=='tradable')throw Error('Synthetic contract identity or next expiration is invalid');
    contract={...requireNearMoneyContract({direction:setup.direction,strike:instrument.strike_price,qqqPrice:input.qqqPrice}),...validateOptionMarket(option,{now,optionId:instrument.id})};
    audit.facts.option_bid=contract.bid;audit.facts.option_ask=contract.ask;audit.facts.option_quote_at=option.updated_at;
    pass(stage,'Synthetic contract identity, next expiration, moneyness, quote freshness and spread validated.');
    stage='risk';risk=reserveRisk({portfolio:input.portfolio,premium:contract.ask,brokerRealized:brokerDailyRealized(input.realized),policy:input.policy});
    pass(stage,`Illustrative risk calculation passed: $${risk.planned_risk.toFixed(2)} reserved against $${risk.per_trade_limit.toFixed(2)} per-trade capacity.`);
    stage='entry';reason='Mechanical checks completed. Offline mode cannot approve discretionary room or submit an order.';
    audit.checks.entry={status:'block',reason};
  } catch(error) {
    reason=String(error.message).slice(0,400);audit.checks[stage]={status:'block',reason};
    if(stage==='structure')outcome='no_setup';
    if(stage==='session')outcome='market_closed';
  }
  validateDecisionAudit(audit,observed_at);
  return {event:'watch_run',version:1,application_version:VERSION,synthetic:true,observed_at,recorded_at:observed_at,
    outcome,decision_stage:stage,reason,qqq_price:input.qqqPrice,audit,
    decision_audit:folder?{...attachDecisionAudit({audit,observed_at},folder,now),provenance:'Computed offline validators over invented inputs. No broker authorization.'}:null,
    computed_evidence:{room,contract,risk},execution_authorized:false};
}
