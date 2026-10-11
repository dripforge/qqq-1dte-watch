import { marketSession,etParts } from './session.mjs';
import { assessResearchBars } from './research-candle-quality.mjs';
export const ANALYSIS_VERSION='1.0.0';
export const COMPARISON_SYMBOLS=Object.freeze(['QQQ','SPY','SMH','IWM','RSP']);
export const QUOTE_SYMBOLS=Object.freeze([...COMPARISON_SYMBOLS,'AAPL','MSFT','NVDA','AMZN','META','GOOGL','AVGO','TSLA']);
const number=x=>(typeof x==='number'||typeof x==='string'&&x.trim()!=='')&&Number.isFinite(Number(x))?Number(x):null;
const age=(s,now)=>{const n=now-Date.parse(s??'');return Number.isFinite(n)?n:null;};
export function freshness(at,now,max){const a=age(at,now);return {age_ms:a,fresh:a!==null&&a>=-5000&&a<=max};}
export function summarizeBars(data,now=Date.now()){
 const date=etParts(new Date(now)).date;
 return COMPARISON_SYMBOLS.map(symbol=>{
  const row=data?.results?.find(r=>r?.symbol===symbol);
  const bars=(Array.isArray(row?.bars)?row.bars:[]).filter(b=>Number.isFinite(Date.parse(b?.begins_at))&&Date.parse(b.begins_at)+60000<=now-1000&&etParts(new Date(b.begins_at)).date===date).sort((a,b)=>Date.parse(a.begins_at)-Date.parse(b.begins_at));
  const result={symbol,completed_through:bars.length?new Date(Date.parse(bars.at(-1).begins_at)+60000).toISOString():null,returns_pct:{},quality:{}};
  for(const horizon of [1,5,15]){
   const slice=bars.slice(-horizon-1),quality=assessResearchBars(slice,{intervalMs:60000,observedAt:now,minimum:horizon+1});
   const valid=row?.interval==='minute'&&row?.bounds==='regular'&&quality.usable;
   result.returns_pct[horizon]=valid?(Number(slice.at(-1).close_price)/Number(slice[0].close_price)-1)*100:null;
   result.quality[horizon]={usable:valid,reason:valid?null:row?.interval!=='minute'||row?.bounds!=='regular'?'bar_metadata_unverified':quality.reason,verification_basis:quality.verification_basis};
  }
  return result;
 });
}
export function summarizeQuotes(data,now=Date.now()){
 return QUOTE_SYMBOLS.map(symbol=>{
  const row=data?.results?.find(r=>r?.quote?.symbol===symbol),q=row?.quote,price=number(q?.last_trade_price),timing=freshness(q?.venue_last_trade_time,now,30000);
  const usable=timing.fresh&&q?.state==='active'&&q?.has_traded===true&&price>0;
  const close=row?.close,prior=number(close?.price),priorUsable=prior>0&&close?.interpolated===false&&close?.date<etParts(new Date(now)).date;
  return {symbol,quote_at:q?.venue_last_trade_time??null,...timing,usable,last:usable?price:null,change_from_verified_close_pct:usable&&priorUsable?(price/prior-1)*100:null,
   prior_close_date:priorUsable?close.date:null,reason:usable?null:'quote_stale_or_unverified'};
 });
}
export function summarizeIndexes(data,now=Date.now()){
 return ['VIX','NDX','SPX'].map(symbol=>{const q=data?.quotes?.find(r=>r?.symbol===symbol),timing=freshness(q?.venue_timestamp,now,30000),value=number(q?.value);
  return {symbol,quote_at:q?.venue_timestamp??null,...timing,usable:timing.fresh&&value>0,value:timing.fresh&&value>0?value:null,reason:timing.fresh&&value>0?null:'index_stale_or_unavailable'};});
}
export function analysisSession(now=Date.now()){
 const s=marketSession(new Date(now));return {session_date:s.date,is_open:s.is_open,minutes_to_entry_cutoff:s.is_open?s.entry_cutoff_minute-s.minute:null,minutes_to_close:s.is_open?s.close_minute-s.minute:null,
  closing_auction_phase:s.is_open&&s.close_minute===960&&s.minute>=950?(s.minute>=955?'closing_auction_final_five_minutes':'closing_auction_imbalance_window'):'outside_verified_regular_close_window',auction_imbalance:'unavailable_no_entitled_feed',live_entry_filter:false};
}
export function readAnalysisPacket(cache,{now=Date.now()}={}){
 const result={version:1,analysis_version:ANALYSIS_VERSION,observed_at:new Date(now).toISOString(),research_only:true,live_filter:false,status:'unavailable',session:analysisSession(now),comparisons:[],equity_quotes:[],indexes:[],errors:[],collected_at:cache?.collected_at??null};
 if(cache?.version!==1||cache.analysis_version!==ANALYSIS_VERSION)return result;
 result.errors=Array.isArray(cache.errors)?cache.errors.slice(0,6):[];
 result.comparisons=(cache.comparisons??[]).filter(r=>COMPARISON_SYMBOLS.includes(r.symbol)).slice(0,5).map(r=>{
  const timing=freshness(r.completed_through,now,90000),sameDay=r.completed_through?.slice(0,10)===result.session.session_date;
  return {...r,...timing,fresh:timing.fresh&&sameDay,returns_pct:timing.fresh&&sameDay?r.returns_pct:{1:null,5:null,15:null}};
 });
 const qqq=result.comparisons.find(r=>r.symbol==='QQQ');
 for(const row of result.comparisons){row.relative_to_qqq_5m_pct=null;if(row.fresh&&qqq?.fresh&&row.completed_through===qqq.completed_through&&Number.isFinite(row.returns_pct[5])&&Number.isFinite(qqq.returns_pct[5]))row.relative_to_qqq_5m_pct=row.returns_pct[5]-qqq.returns_pct[5];}
 result.equity_quotes=(cache.equity_quotes??[]).slice(0,13).map(r=>{const t=freshness(r.quote_at,now,30000);return {...r,...t,usable:r.usable&&t.fresh,last:r.usable&&t.fresh?r.last:null,change_from_verified_close_pct:r.usable&&t.fresh?r.change_from_verified_close_pct:null};});
 result.indexes=(cache.indexes??[]).slice(0,3).map(r=>{const t=freshness(r.quote_at,now,30000);return {...r,...t,usable:r.usable&&t.fresh,value:r.usable&&t.fresh?r.value:null};});
 result.status=result.comparisons.some(r=>r.fresh&&Object.values(r.returns_pct).some(Number.isFinite))?'available':'stale_or_unavailable';
 if(cache.depth){const t=freshness(cache.depth.quote_at,now,10000);result.depth={...cache.depth,...t,usable:cache.depth.usable&&t.fresh,bids:t.fresh?cache.depth.bids:[],asks:t.fresh?cache.depth.asks:[]};}
 result.coverage={constituent_weights:'unavailable_unweighted_quotes_only',news:'not_connected',auction_imbalance:'not_connected'};
 return result;
}
export function summarizeDepth(data,now=Date.now()){
 const b=data?.books?.find(r=>r.symbol==='QQQ'),timing=freshness(b?.updated_at,now,10000);
 const levels=side=>(Array.isArray(b?.[side])?b[side]:[]).slice(0,5).map(x=>({price:number(x.price),size:number(x.quantity)}));
 const bids=levels('bids'),asks=levels('asks'),valid=timing.fresh&&bids.length>0&&asks.length>0&&[...bids,...asks].every(x=>x.price>0&&Number.isSafeInteger(x.size)&&x.size>=0)&&asks[0].price>=bids[0].price;
 return {symbol:'QQQ',quote_at:b?.updated_at??null,...timing,usable:valid,bids:valid?bids:[],asks:valid?asks:[],venue_coverage:'unspecified_by_source',interpretation:'Transient displayed depth; not a confirmed barrier or auction imbalance.'};
}
