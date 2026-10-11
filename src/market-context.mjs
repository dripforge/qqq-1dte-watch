import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { marketSession, sessionForDate, etParts } from './session.mjs';
import { researchCandleQuality } from './research-candle-quality.mjs';
import { durableJson } from './entry-watch-runtime.mjs';

export const CONTEXT_SPEC=Object.freeze({version:1,history_target_sessions:20,history_minimum_sessions:5,
  vwap_method:'completed_1m_typical_price_volume_weighted_estimate',trend_method:'three_completed_15m_closes',
  relative_volume_method:'cumulative_volume_vs_prior_same_clock_same_session_length_mean',research_only:true});
function numeric(value){return value===null||value===undefined||value===''?null:Number.isFinite(Number(value))?Number(value):null;}
export function sessionBoundary(date,minute){
  const origin=Date.parse(`${date}T12:00:00Z`);
  for(let offset=0;offset<12*60;offset++){
    const time=origin+offset*60000,et=etParts(new Date(time));if(et.date===date&&et.minute===minute)return new Date(time).toISOString();
  }
  throw Error('Verified session UTC boundary unavailable');
}
export function sessionOpenAt(now=Date.now()){
  const session=marketSession(new Date(now));if(!session.verified||!session.is_trading_day)throw Error('Context session unavailable');
  return sessionBoundary(session.date,session.open_minute);
}
export function priorContextSessions(date,{count=20}={}){
  const current=sessionForDate(date),dates=[],cursor=new Date(`${date}T12:00:00Z`);
  if(!current.verified||!current.is_trading_day)throw Error('Context date unavailable');
  for(let n=0;n<90&&dates.length<count;n++){
    cursor.setUTCDate(cursor.getUTCDate()-1);const previous=sessionForDate(cursor.toISOString().slice(0,10));
    if(!previous.verified)break;
    if(previous.is_trading_day&&previous.close_minute===current.close_minute)dates.push(previous.date);
  }
  return dates;
}
export function readContextHistory(folder){
  const path=join(folder,'market-context-history.json');if(!existsSync(path))return {version:1,sessions:{},last_attempt_at:null};
  if(statSync(path).size>1024*1024)throw Error('Context history too large');const value=JSON.parse(readFileSync(path,'utf8'));
  if(value.version!==1||!value.sessions||typeof value.sessions!=='object'||Array.isArray(value.sessions))throw Error('Context history invalid');
  return value;
}
export function historicalVolumeSession(data,date,observedAt){
  const session=sessionForDate(date),row=data?.results?.find(item=>item?.symbol==='QQQ');
  if(!session.verified||!session.is_trading_day||row?.interval!=='minute'||row.bounds!=='regular'||!Array.isArray(row.bars))throw Error('Historical context unavailable');
  const expected=session.close_minute-session.open_minute,start=Date.parse(sessionBoundary(date,session.open_minute));
  const bars=row.bars.filter(b=>b&&etParts(new Date(b.begins_at)).date===date).sort((a,b)=>Date.parse(a.begins_at)-Date.parse(b.begins_at));
  if(bars.length!==expected)throw Error('Historical context session incomplete');
  const cumulative=[];let volume=0;
  for(let i=0;i<bars.length;i++){
    const bar=bars[i],quality=researchCandleQuality(bar,{intervalMs:60000,observedAt});
    if(Date.parse(bar.begins_at)!==start+i*60000||!quality.usable||numeric(bar.volume)===null||Number(bar.volume)<0)throw Error('Historical context bar unverified');
    volume+=Number(bar.volume);cumulative.push(volume);
  }
  return {date,source:'robinhood_trading_mcp',observed_at:new Date(observedAt).toISOString(),
    close_minute:session.close_minute,bar_count:bars.length,cumulative_volume:cumulative,
    high:Math.max(...bars.map(b=>Number(b.high_price))),low:Math.min(...bars.map(b=>Number(b.low_price))),
    verification_basis:bars.some(b=>b.interpolated===undefined)?'contains_positive_volume_inference':'explicit_broker_flags'};
}
export async function collectContextHistoryTick({folder,read,now=Date.now(),planPending=false}={}){
  if(planPending)return {status:'skipped',reason:'pending_entry_plan_priority'};
  const session=marketSession(new Date(now));if(!session.verified||!session.is_open)return {status:'skipped',reason:'market_closed'};
  const history=readContextHistory(folder);
  if(history.last_attempt_at&&now-Date.parse(history.last_attempt_at)<10000)return {status:'skipped',reason:'history_cadence'};
  history.failures??={};
  const needed=priorContextSessions(session.date).find(date=>!history.sessions[date]&&
    (!history.failures[date]||now-Date.parse(history.failures[date].at)>=300000));
  if(!needed){const count=priorContextSessions(session.date).filter(date=>history.sessions[date]).length;return {status:count===20?'ready':'warming',sessions:count,reason:count===20?null:'missing_sessions_in_retry_cooldown'};}
  history.last_attempt_at=new Date(now).toISOString();durableJson(folder,'market-context-history.json',history);
  try{
    const data=await read('get_equity_historicals',{symbols:['QQQ'],interval:'minute',bounds:'regular',
      start_time:sessionBoundary(needed,sessionForDate(needed).open_minute),end_time:sessionBoundary(needed,sessionForDate(needed).close_minute)});
    history.sessions[needed]=historicalVolumeSession(data,needed,now);delete history.failures[needed];
  }catch{
    history.failures[needed]={at:new Date(now).toISOString(),reason:'historical_session_unverified_or_unavailable'};
    durableJson(folder,'market-context-history.json',history);return {status:'unavailable',date:needed,reason:history.failures[needed].reason};
  }
  const retained=Object.keys(history.sessions).sort().slice(-45);history.sessions=Object.fromEntries(retained.map(date=>[date,history.sessions[date]]));
  durableJson(folder,'market-context-history.json',history);
  return {status:'collected',date:needed,sessions:priorContextSessions(session.date).filter(date=>history.sessions[date]).length};
}
function completed(values,interval,now,date){
  if(!Array.isArray(values))return [];
  return values.filter(b=>b&&Number.isFinite(Date.parse(b.begins_at))&&Date.parse(b.begins_at)+interval<=now-1000&&
    etParts(new Date(b.begins_at)).date===date).sort((a,b)=>Date.parse(a.begins_at)-Date.parse(b.begins_at));
}
function estimateVwap(bars){let numerator=0,denominator=0;for(const b of bars){const v=Number(b.volume);numerator+=(Number(b.high_price)+Number(b.low_price)+Number(b.close_price))/3*v;denominator+=v;}
  return denominator>0?numerator/denominator:null;}
export function buildMarketContext({now=Date.now(),qqqPrice,oneMinuteBars,fiveMinuteBars,history={sessions:{}}}={}){
  const session=marketSession(new Date(now)),minute=completed(oneMinuteBars,60000,now,session.date),five=completed(fiveMinuteBars,300000,now,session.date);
  const result={version:1,spec:CONTEXT_SPEC,observed_at:new Date(now).toISOString(),session_date:session.date,
    time_of_day:{minute_et:session.minute,bucket:session.minute<600?'opening':session.minute<690?'morning':session.minute<840?'midday':'afternoon'},
    trend_15m:{status:'unknown',reason:'insufficient_complete_15m_bars',closes:[],last_completed_at:null},
    vwap:{status:'unknown',price:null,position:null,slope_5m:null,method:CONTEXT_SPEC.vwap_method,reason:null},
    relative_volume:{status:'unknown',ratio:null,sessions_used:0,target_sessions:20,minimum_sessions:5,
      method:CONTEXT_SPEC.relative_volume_method,reason:null},confirmed_levels:[],research_only:true,live_filter:false};
  if(!session.verified||!session.is_open||!Number.isFinite(qqqPrice)||qqqPrice<=0){result.vwap.reason='session_or_quote_unavailable';return result;}
  const groups=new Map();for(const b of five){const start=Math.floor(Date.parse(b.begins_at)/900000)*900000;
    if(!groups.has(start))groups.set(start,[]);groups.get(start).push(b);}
  const closes=[];
  for(const [start,group] of groups){if(group.length===3&&group.every((b,i)=>Date.parse(b.begins_at)===start+i*300000&&researchCandleQuality(b,{intervalMs:300000,observedAt:now}).usable)&&start+900000<=now-1000)
    closes.push({at:new Date(start+900000).toISOString(),close:Number(group.at(-1).close_price)});}
  const recent=closes.slice(-3);result.trend_15m.closes=recent;result.trend_15m.last_completed_at=recent.at(-1)?.at??null;
  if(recent.length===3&&recent.every((b,i)=>!i||Date.parse(b.at)-Date.parse(recent[i-1].at)===900000)){
    result.trend_15m.status=recent[0].close<recent[1].close&&recent[1].close<recent[2].close?'up':
      recent[0].close>recent[1].close&&recent[1].close>recent[2].close?'down':'mixed';result.trend_15m.reason=null;}
  const expectedStart=Date.parse(sessionOpenAt(now));
  const full=minute.length&&Date.parse(minute[0].begins_at)===expectedStart&&minute.every((b,i)=>Date.parse(b.begins_at)===expectedStart+i*60000&&
    researchCandleQuality(b,{intervalMs:60000,observedAt:now}).usable&&numeric(b.volume)!==null&&Number(b.volume)>=0)&&
    now-(Date.parse(minute.at(-1).begins_at)+60000)<=90000;
  if(full){
    const high=Math.max(...minute.map(b=>Number(b.high_price))),low=Math.min(...minute.map(b=>Number(b.low_price))),opening=minute.slice(0,15);
    result.price_location={completed_through:new Date(Date.parse(minute.at(-1).begins_at)+60000).toISOString(),session_high:high,session_low:low,
      range_position:high>low?(qqqPrice-low)/(high-low):null,
      opening_15m_high:opening.length===15?Math.max(...opening.map(b=>Number(b.high_price))):null,
      opening_15m_low:opening.length===15?Math.min(...opening.map(b=>Number(b.low_price))):null,
      opening_range_known_at:opening.length===15?new Date(expectedStart+15*60000).toISOString():null,research_only:true};
    const price=estimateVwap(minute),prior=minute.length>5?estimateVwap(minute.slice(0,-5)):null;
    result.vwap={...result.vwap,status:price===null?'unknown':'available',price,position:price===null?null:qqqPrice>price?'above':qqqPrice<price?'below':'at',
      slope_5m:prior===null||price===null?null:price-prior,completed_through:new Date(Date.parse(minute.at(-1).begins_at)+60000).toISOString(),
      bar_count:minute.length,contains_positive_volume_inference:minute.some(b=>b.interpolated!==false),reason:price===null?'zero_session_volume':null};
    const priorDays=priorContextSessions(session.date).map(date=>history.sessions?.[date]).filter(row=>row&&row.close_minute===session.close_minute&&
      Array.isArray(row.cumulative_volume)&&row.cumulative_volume.length>=minute.length&&Number.isFinite(row.cumulative_volume[minute.length-1])&&row.cumulative_volume[minute.length-1]>0);
    result.relative_volume.sessions_used=priorDays.length;
    if(priorDays.length>=5){const current=minute.reduce((sum,b)=>sum+Number(b.volume),0),mean=priorDays.reduce((sum,row)=>sum+row.cumulative_volume[minute.length-1],0)/priorDays.length;
      result.relative_volume={...result.relative_volume,status:'available',ratio:current/mean,current_cumulative_volume:current,historical_same_clock_mean:mean,
        sample_dates:priorDays.map(row=>row.date),coverage:priorDays.length===20?'target_complete':'partial_history',reason:null};}
    else result.relative_volume.reason='historical_same_clock_volume_warming_up';
  }else{result.vwap.reason='full_regular_session_minute_coverage_unavailable';result.relative_volume.reason='current_session_volume_incomplete';}
  for(let i=1;i<five.length-1;i++){
    const [left,middle,right]=five.slice(i-1,i+2);if(![left,middle,right].every(b=>researchCandleQuality(b,{intervalMs:300000,observedAt:now}).usable))continue;
    if(Number(middle.high_price)>=Number(left.high_price)&&Number(middle.high_price)>=Number(right.high_price))result.confirmed_levels.push({price:Number(middle.high_price),kind:'confirmed_5m_swing_high',known_at:new Date(Date.parse(right.begins_at)+300000).toISOString()});
    if(Number(middle.low_price)<=Number(left.low_price)&&Number(middle.low_price)<=Number(right.low_price))result.confirmed_levels.push({price:Number(middle.low_price),kind:'confirmed_5m_swing_low',known_at:new Date(Date.parse(right.begins_at)+300000).toISOString()});
  }
  const prior=priorContextSessions(session.date,{count:1})[0],priorData=history.sessions?.[prior];
  if(priorData)for(const key of ['high','low'])if(Number.isFinite(priorData[key]))result.confirmed_levels.push({price:priorData[key],kind:`prior_session_${key}`,known_at:sessionBoundary(prior,sessionForDate(prior).close_minute)});
  result.confirmed_levels=result.confirmed_levels.slice(-40);return result;
}
export function candidateContext(context,{direction,level,qqqPrice}={}){
  const sign=direction==='call'?1:-1,levels=context.confirmed_levels.filter(item=>sign*(item.price-qqqPrice)>0)
    .sort((a,b)=>Math.abs(a.price-qqqPrice)-Math.abs(b.price-qqqPrice));
  return {version:1,observed_at:context.observed_at,session_date:context.session_date,time_of_day:context.time_of_day,
    trend_15m:context.trend_15m,vwap:context.vwap,relative_volume:context.relative_volume,
    next_obstacle:levels[0]??null,room_to_obstacle:levels.length?Math.abs(levels[0].price-qqqPrice):null,
    reference_level:level,research_only:true,live_filter:false};
}
