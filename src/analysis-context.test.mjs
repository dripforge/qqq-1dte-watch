import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizeBars,summarizeQuotes,summarizeIndexes,readAnalysisPacket,analysisSession } from './analysis-context.mjs';
const now=Date.parse('2026-10-09T19:43:57Z');
const bars=()=>Array.from({length:20},(_,i)=>({begins_at:new Date(now-57000-(20-i)*60000).toISOString(),open_price:100+i,close_price:101+i,high_price:102+i,low_price:99+i,volume:100,session:'reg',interpolated:false}));
const data=b=>({results:[{symbol:'QQQ',interval:'minute',bounds:'regular',bars:b}]});
test('completed aligned returns reject forming, missing, stale and interpolated evidence',()=>{
 const good=bars();assert.equal(summarizeBars(data(good),now)[0].quality[15].usable,true);
 for(const bad of [[...good.slice(0,-1),{...good.at(-1),interpolated:true}],good.filter((_,i)=>i!==10),good.map(b=>({...b,volume:0,interpolated:null})),good.slice(0,-3)])assert.equal(summarizeBars(data(bad),now)[0].returns_pct[15],null);
 const forming={...good.at(-1),begins_at:'2026-10-09T19:43:00Z',close_price:1000,high_price:1000};assert.deepEqual(summarizeBars(data([...good,forming]),now),summarizeBars(data(good),now));
});
test('packet recomputes freshness at read time, clears stale values and requires matching windows',()=>{
 const rows=summarizeBars(data(bars()),now);rows.push({...rows[0],symbol:'SPY',completed_through:'2026-10-09T19:41:00Z'});
 const cache={version:1,analysis_version:'1.0.0',comparisons:rows,equity_quotes:[{symbol:'QQQ',quote_at:new Date(now).toISOString(),usable:true,last:500}],indexes:[{symbol:'VIX',quote_at:new Date(now).toISOString(),usable:true,value:15}]};
 let out=readAnalysisPacket(cache,{now});assert.equal(out.comparisons.at(-1).relative_to_qqq_5m_pct,null);
 out=readAnalysisPacket(cache,{now:now+120000});assert.equal(out.comparisons[0].returns_pct[5],null);assert.equal(out.equity_quotes[0].last,null);assert.equal(out.indexes[0].value,null);
});
test('individual stock and index timestamps govern usability; no stale fallback',()=>{
 assert.equal(summarizeQuotes({results:[{quote:{symbol:'QQQ',last_trade_price:500,state:'active',has_traded:true,venue_last_trade_time:new Date(now-31000).toISOString()}}]},now)[0].usable,false);
 assert.equal(summarizeIndexes({quotes:[{symbol:'VIX',value:'15',venue_timestamp:new Date(now-31000).toISOString()}]},now)[0].value,null);
});
test('closing-auction time is descriptive, preserves 15:58 cutoff and does not guess half-day timing',()=>{
 const s=analysisSession(Date.parse('2026-10-09T19:56:00Z'));assert.equal(s.closing_auction_phase,'closing_auction_final_five_minutes');assert.equal(s.minutes_to_entry_cutoff,2);assert.equal(s.live_entry_filter,false);
 assert.equal(analysisSession(Date.parse('2026-11-27T17:55:00Z')).closing_auction_phase,'outside_verified_regular_close_window');
});
