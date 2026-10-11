import { QUOTE_SYMBOLS,freshness } from './analysis-context.mjs';
export const HALT_URL='https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';
export function parseHalts(text){
 if(!/<rss\s/.test(text)||!text.includes('NASDAQ Trade Halts')||!text.includes('</rss>'))throw Error('halt_feed_unverified');
 const at=text.match(/<pubDate>([^<]+)<\/pubDate>/)?.[1],stamp=Date.parse(at??'');if(!Number.isFinite(stamp))throw Error('halt_feed_time_missing');
 const items=[...text.matchAll(/<item>([\s\S]*?)<\/item>/g)],count=Number(text.match(/<ndaq:numItems>(\d+)<\/ndaq:numItems>/)?.[1]);if(!Number.isInteger(count)||count!==items.length)throw Error('halt_feed_incomplete');
 const rows=[];for(const [,body] of items){const field=name=>body.match(new RegExp('<ndaq:'+name+'>([^<]*)</ndaq:'+name+'>'))?.[1]?.trim()??null;
  const symbol=field('IssueSymbol');if(!symbol)throw Error('halt_symbol_missing');if(!QUOTE_SYMBOLS.includes(symbol))continue;
  rows.push({symbol,halt_date:field('HaltDate'),halt_time_et:field('HaltTime'),reason_code:field('ReasonCode'),resumption_date:field('ResumptionDate'),resumption_trade_time_et:field('ResumptionTradeTime'),status:field('ResumptionTradeTime')?'resumption_time_reported':'halt_without_reported_trade_resumption'});
 }
 return {source_url:HALT_URL,feed_at:new Date(stamp).toISOString(),rows,feed_items:count,coverage:'Only the monitored ETF and large-cap basket; absence is not broker tradability verification.'};
}
export function haltContext(saved,now=Date.now()){
 const t=freshness(saved?.feed_at,now,120000),received=freshness(saved?.received_at,now,120000),usable=saved?.status==='available'&&t.fresh&&received.fresh;
 return {status:usable?'available':saved?.status==='unavailable'?'unavailable':'stale_or_missing',feed_at:saved?.feed_at??null,received_at:saved?.received_at??null,age_ms:t.age_ms,rows:usable?saved.rows:[],reason:saved?.reason??null,coverage:saved?.coverage??'Monitored basket only',research_only:true,live_filter:false};
}
