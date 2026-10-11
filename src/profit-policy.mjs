export function effectiveExitLevel(arm, plan) {
  const base = Number(arm.qqq_invalidation);
  if (!plan || plan.option_id !== arm.option_id || arm.trade_id && plan.trade_id !== arm.trade_id) return base;
  const level = Number(plan.qqq_trailing_level);
  if (!Number.isFinite(level) || level <= 0) return base;
  if (arm.option_type === 'call') return Math.max(base, level);
  return Math.min(base, level);
}

export function validateTightening(arm, plan, proposed, qqqPrice) {
  const level = Number(proposed);
  const price = Number(qqqPrice);
  if (!Number.isFinite(level) || level <= 0 || !Number.isFinite(price) || price <= 0) {
    throw new Error('QQQ price or proposed exit level is invalid');
  }
  const current = effectiveExitLevel(arm, plan);
  if (arm.option_type === 'call') {
    if (level <= current) throw new Error('A call exit level may only move higher');
    if (level >= price) throw new Error('Proposed level is already crossed; request a sell instead');
  } else {
    if (level >= current) throw new Error('A put exit level may only move lower');
    if (level <= price) throw new Error('Proposed level is already crossed; request a sell instead');
  }
  return level;
}

export function profitTrailBoundary(bars, arm, now = new Date()) {
  const completed=completedBars(bars,60000,now);
  const ranges=completed.map(b=>Number(b.high_price)-Number(b.low_price)).sort((a,b)=>a-b);
  const buffer=Math.min(0.25,Math.max(0.08,(ranges[4]+ranges[5])/4));
  const opened=Date.parse(arm.opened_at??'');
  if(!Number.isFinite(opened))throw new Error('Verified entry time required for a profit swing');
  let swing;
  for(let i=1;i<completed.length-1;i++) {
    const middle=completed[i],left=completed[i-1],right=completed[i+1];
    if(Date.parse(middle.begins_at)<opened)continue;
    const key=arm.option_type==='call'?'low_price':'high_price';
    const value=Number(middle[key]),a=Number(left[key]),b=Number(right[key]);
    if(arm.option_type==='call'?(value<=a&&value<=b&&(value<a||value<b)):(value>=a&&value>=b&&(value>a||value>b))) {
      swing={price:value,at:middle.begins_at,confirmed_at:right.begins_at};
    }
  }
  if(!swing)throw new Error('No newly confirmed favorable swing after entry');
  const raw=arm.option_type==='call'?swing.price-buffer:swing.price+buffer;
  const boundary=arm.option_type==='call'?Math.floor(raw*100+1e-8)/100:Math.ceil(raw*100-1e-8)/100;
  return {boundary,buffer,swing_price:swing.price,swing_at:swing.at,confirmation_bar_at:swing.confirmed_at};
}

export function validateBufferedTrail(arm, plan, proposed, qqqPrice, bars, now=new Date()) {
  const level=validateTightening(arm,plan,proposed,qqqPrice);
  const swing=profitTrailBoundary(bars,arm,now);
  if(arm.option_type==='call'?level>swing.boundary+1e-8:level<swing.boundary-1e-8)throw new Error('Profit trail must sit beyond the confirmed swing and volatility buffer');
  if(Math.abs(Number(qqqPrice)-level)<swing.buffer-1e-8)throw new Error('Profit trail is inside current price noise');
  return {level,...swing};
}

export function profitCushion(arm, option) {
  const bid=Number(option?.bid_price),ask=Number(option?.ask_price);
  if(option?.bid_price==null||option?.ask_price==null||!Number.isFinite(bid)||!Number.isFinite(ask)||bid<=0||ask<bid)throw new Error('Option market unavailable');
  const cushion=Math.max(0.02,ask-bid);
  if(bid-Number(arm.entry_premium)<cushion-1e-8)throw new Error('Quoted profit is too small relative to spread and execution costs');
  return {bid,ask,cushion,quoted_gross_profit:(bid-arm.entry_premium)*100};
}
import { completedBars } from './setup-policy.mjs';
