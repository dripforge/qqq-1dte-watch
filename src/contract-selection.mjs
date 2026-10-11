export function requireNearMoneyContract({direction,strike,qqqPrice}){
 const number=(value)=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
 strike=number(strike);qqqPrice=number(qqqPrice);
 if(!['call','put'].includes(direction)||!Number.isFinite(strike)||!Number.isFinite(qqqPrice)||strike<=0||qqqPrice<=0)throw Error('Contract moneyness cannot be verified');
 const distance=Math.abs(strike-qqqPrice),outOfMoney=direction==='call'?strike>qqqPrice:strike<qqqPrice;
 if(distance>qqqPrice*.005+1e-8)throw Error('Contract is too far from the money');
 if(outOfMoney&&distance>1+1e-8)throw Error('Out-of-money fallback must be within $1 of QQQ');
 return {moneyness:distance<=1e-8?'at_the_money':outOfMoney?'out_of_the_money':'in_the_money',strike,qqq_price:qqqPrice,distance_dollars:distance,out_of_money_limit_dollars:1};
}

export function validateOptionMarket(option, { now = Date.now(), optionId } = {}) {
  const age=now-Date.parse(option?.updated_at??'');
  if (!Number.isFinite(age)||age< -5000||age>10000) throw Error('Option quote is stale');
  if (optionId && option?.instrument_id!==optionId) throw Error('Option quote identity mismatch');
  const numeric=value=>value!==null&&value!==undefined&&value!==''?Number(value):NaN;
  const ask=numeric(option.ask_price),bid=numeric(option.bid_price);
  if (!Number.isFinite(ask)||!Number.isFinite(bid)||bid<=0||ask<bid||ask<=0||!Number.isFinite(Number(option.ask_size))||!Number.isFinite(Number(option.bid_size))||Number(option.ask_size)<1||Number(option.bid_size)<1) throw Error('Option market is not liquid');
  if (ask-bid>Math.min(.10,(ask+bid)/2*.05)+1e-8) throw Error('Option spread exceeds 5% of midpoint or $0.10');
  return {ask,bid};
}
