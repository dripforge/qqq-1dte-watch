import {assertOwnedPositionSnapshot,positionFromCompleteSnapshot} from './position-ownership.mjs';
import {matchingClosingFill} from './closure.mjs';
import {sessionSubmissionGuard} from './session-guard.mjs';
export function assertFlatPositionSnapshot(snapshot){
  const position=positionFromCompleteSnapshot(snapshot,{});
  if(position){const error=Error('A QQQ position appeared before entry dispatch');error.code='LOCAL_PREFLIGHT';throw error;}
}
export function createOwnershipDispatchGuard({account,arm,load,place=false,stop=false,beforeSend,clock=()=>Date.now()}){
  return async({read})=>{
    const checkLocal=()=>{
      const current=load('arm.json');
      if(current?.trade_id!==arm.trade_id||current?.broker_position_opened_at!==arm.broker_position_opened_at){
        const error=Error('Position ownership changed in local state');error.code='LOCAL_PREFLIGHT';error.ownership_status='position_ownership_changed';throw error;
      }
    };
    checkLocal();
    // A filled stop can precede broker position publication. Check close proofs
    // first, leaving positions as the last broker read before dispatch.
    for(const id of new Set([load('stop-intent.json')?.order_id,load('exit-intent.json')?.order_id].filter(Boolean))){
      const orders=await read('get_option_orders',{account_number:account,order_id:id});
      if(!Array.isArray(orders.orders)||orders.orders.some(order=>!order)||orders.next){
        const error=Error('Complete closing-order snapshot unavailable');error.code='LOCAL_PREFLIGHT';error.ownership_status='position_ownership_unverified';throw error;
      }
      if(matchingClosingFill(orders.orders.find(order=>order.id===id),arm,arm.opened_at??arm.broker_position_opened_at)){
        const error=Error('Closing fill verified; waiting for position publication');error.code='LOCAL_PREFLIGHT';error.ownership_status='closing_fill_waiting_position';throw error;
      }
    }
    const snapshot=await read('get_option_positions',{account_number:account,nonzero:true});
    checkLocal();
    try{assertOwnedPositionSnapshot({snapshot,arm,intent:load('entry-intent.json'),now:clock()});}
    catch(error){if(error.ownership_status==='position_absent')error.ownership_status='position_ownership_unverified';throw error;}
    if(place)sessionSubmissionGuard(arm,{stop,clock})();
    beforeSend?.();
  };
}
