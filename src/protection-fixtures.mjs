export const testArm={option_id:'00000000-0000-4000-8000-000000000001',option_type:'put',
  expiration_date:'2026-10-09',entry_premium:1.77,quantity:1,opened_at:'2026-10-08T14:00:00Z',trade_id:'trade-1'};
export function testStop(arm=testArm, {id='stop',state='confirmed',created='2026-10-08T15:30:00Z',stopPrice='1.33',...fields}={}) {
  return {id,state,created_at:created,chain_symbol:'QQQ',direction:'credit',type:'market',trigger:'stop',
    time_in_force:'gfd',market_hours:'regular_hours',trade_value_multiplier:'100',quantity:'1',
    pending_quantity:['filled','cancelled','rejected','failed','voided'].includes(state)?'0':'1',
    processed_quantity:state==='filled'?'1':'0',stop_price:stopPrice,
    legs:[{option_id:arm.option_id,option_type:arm.option_type,expiration_date:arm.expiration_date,
      side:'sell',position_effect:'close',ratio_quantity:1}],...fields};
}
