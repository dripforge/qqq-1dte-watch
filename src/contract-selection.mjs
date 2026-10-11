export function requireNearMoneyContract({direction,strike,qqqPrice}){
 const number=(value)=>typeof value==='number'||typeof value==='string'&&value.trim()!==''?Number(value):NaN;
 strike=number(strike);qqqPrice=number(qqqPrice);
 if(!['call','put'].includes(direction)||!Number.isFinite(strike)||!Number.isFinite(qqqPrice)||strike<=0||qqqPrice<=0)throw Error('Contract moneyness cannot be verified');
 const distance=Math.abs(strike-qqqPrice),outOfMoney=direction==='call'?strike>qqqPrice:strike<qqqPrice;
 if(distance>qqqPrice*.005+1e-8)throw Error('Contract is too far from the money');
 if(outOfMoney&&distance>1+1e-8)throw Error('Out-of-money fallback must be within $1 of QQQ');
 return {moneyness:distance<=1e-8?'at_the_money':outOfMoney?'out_of_the_money':'in_the_money',strike,qqq_price:qqqPrice,distance_dollars:distance,out_of_money_limit_dollars:1};
}
