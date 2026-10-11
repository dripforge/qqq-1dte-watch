import { HALT_URL } from './halt-context.mjs';
import { etParts } from './session.mjs';
export const EVENT_SOURCES=Object.freeze({bls:'https://www.bls.gov/schedule/news_release/bls.ics',bea:'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics',fed:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'});
const iso=n=>new Date(n).toISOString();
const clean=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#\d+;|&[a-z]+;/gi,' ').replace(/[\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,240);
function localTime(date,hour,minute){
 const noon=Date.parse(date+'T12:00:00Z');
 for(const offset of [4,5]){const n=Date.parse(`${date}T${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}:00Z`)+offset*3600000;const p=etParts(new Date(n));if(p.date===date&&p.minute===hour*60+minute)return iso(n);}
 throw Error('event_timezone_unverified');
}
export function parseIcs(text,source){
 if(!text.includes('BEGIN:VCALENDAR')||!text.includes('END:VCALENDAR'))throw Error('calendar_format_unverified');
 const unfolded=text.replace(/\r?\n[ \t]/g,''),events=[];
 for(const match of unfolded.matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)){
  const body=match[1];if(/^STATUS:CANCELLED\s*$/m.test(body))continue;
  if(/^RRULE:/m.test(body))throw Error('calendar_recurrence_unsupported');
  const start=body.match(/^DTSTART([^:]*):([^\r\n]+)/m),summary=body.match(/^SUMMARY(?:;[^:]*)?:([^\r\n]+)/m);if(!start||!summary)throw Error('calendar_event_incomplete');
  const s=start[2].trim(),m=s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);if(!m)throw Error('calendar_date_unverified');
  const date=`${m[1]}-${m[2]}-${m[3]}`;
  if(new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw Error('calendar_date_invalid');
  let at=null;
  if(m[4]){
   if(Number(m[4])>23||Number(m[5])>59||Number(m[6])>59)throw Error('calendar_time_invalid');
   if(m[7])at=`${date}T${m[4]}:${m[5]}:${m[6]}Z`;
   else if(/TZID=(?:"?)(America\/New_York|US\/Eastern)(?:"?)(?:;|$)/.test(start[1]))at=localTime(date,Number(m[4]),Number(m[5]));
   else throw Error('calendar_timezone_missing');
  }
  const eventDate=at?etParts(new Date(at)).date:date;
  events.push({source,source_url:EVENT_SOURCES[source],title:clean(summary[1].replace(/\\[,;]/g,x=>x.slice(1)).replace(/\\n/gi,' ')),date:eventDate,at,time_precision:at?'exact':'date_only',verified:true});
 }
 if(!events.length)throw Error('calendar_empty_unverified');return events;
}
export function parseFed(text){
 const headers=[...text.matchAll(/(20\d{2}) FOMC Meetings/g)],months=['January','February','March','April','May','June','July','August','September','October','November','December'],events=[];
 for(let i=0;i<headers.length;i++){
  const section=text.slice(headers[i].index,headers[i+1]?.index??text.length),year=headers[i][1];
  for(const m of section.matchAll(/class="[^"]*fomc-meeting__month[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div class="[^"]*fomc-meeting__date[^"]*"[^>]*>([\s\S]*?)<\/div>/g)){
   const month=clean(m[1]).split('/').at(-1),days=clean(m[2]).replace(/\*/g,'');
   const monthNumber=months.findIndex(x=>x===month||x.startsWith(month))+1;
   if(!monthNumber||!/^\d{1,2}(?:-\d{1,2})?$/.test(days))continue;
   const date=`${year}-${String(monthNumber).padStart(2,'0')}-${days.split('-').at(-1).padStart(2,'0')}`;
   if(new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw Error('fed_date_invalid');
   events.push({source:'fed',source_url:EVENT_SOURCES.fed,title:'FOMC meeting final day',date,at:null,time_precision:'date_only',verified:true});
  }
 }
 if(events.length<4)throw Error('fed_calendar_format_unverified');return events;
}
export function normalizeEarnings(data){
 if(!Array.isArray(data?.results))throw Error('earnings_format_unverified');
 return data.results.filter(r=>/^[A-Z][A-Z.\-]{0,9}$/.test(r.symbol??'')&&/^\d{4}-\d{2}-\d{2}$/.test(r.report?.date??'')).map(r=>({source:'robinhood_earnings',title:`${r.symbol} earnings`,symbol:r.symbol,date:r.report.date,at:null,time_precision:['am','pm'].includes(r.report.timing)?r.report.timing:'date_only',verified:r.report.verified===true,already_reported:r.eps?.actual!==null&&r.eps?.actual!==undefined}));
}
export function eventContext(cache,{now=Date.now()}={}){
 const date=etParts(new Date(now)).date,horizon=iso(now+7*86400000).slice(0,10),sources={},events=[];
 for(const name of [...Object.keys(EVENT_SOURCES),'earnings']){
  const v=cache?.sources?.[name],age=now-Date.parse(v?.fetched_at??''),fresh=Number.isFinite(age)&&age>=-5000&&age<=86400000;
  const usable=fresh&&v?.status==='available';sources[name]={status:usable?'available':v?.status==='unavailable'?'unavailable':v?'stale':'missing',fetched_at:v?.fetched_at??null,last_attempt_at:v?.attempted_at??null,reason:v?.reason??null};
  if(!usable)continue;
  for(const row of v.events??[]){
   if(row.date<date||row.date>horizon)continue;
   const delta=row.at?(Date.parse(row.at)-now)/60000:null;
   if(delta!==null&&delta< -60)continue;
   events.push({...row,minutes_until:delta,calendar_age_ms:age});
  }
 }
 return {version:1,observed_at:iso(now),status:Object.values(sources).every(s=>s.status==='available')?'available':'partial',coverage:'BLS releases, BEA releases, FOMC final meeting dates, and broker high-market-cap earnings; not a complete news or macro calendar',sources,events:events.sort((a,b)=>a.date.localeCompare(b.date)||(a.at??'').localeCompare(b.at??'')).slice(0,60),research_only:true,live_filter:false};
}
export async function boundedPublicFetch(url,{fetcher=fetch,timeoutMs=2500}={}){
 if(![...Object.values(EVENT_SOURCES),HALT_URL].includes(url))throw Error('calendar_source_not_allowed');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
 try{
  const response=await fetcher(url,{headers:{'User-Agent':'QQQ personal research calendar/1.0'},signal:controller.signal,redirect:'error'});
  if(!response.ok)throw Error('calendar_http_'+response.status);
  const reader=response.body.getReader(),chunks=[];let count=0;
  for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;if(count>1000000){await reader.cancel();throw Error('calendar_response_too_large');}chunks.push(value);}
  return Buffer.concat(chunks).toString('utf8');
 }finally{clearTimeout(timer);}
}
export async function refreshOneCalendar(cache,{now=Date.now(),fetchText=boundedPublicFetch}={}){
 cache=structuredClone(cache??{version:1,sources:{}});cache.sources??={};
 const name=Object.keys(EVENT_SOURCES).find(name=>{const v=cache.sources[name],age=now-Date.parse(v?.attempted_at??'');return !Number.isFinite(age)||age>=(v?.status==='available'?6*3600000:3600000);});
 if(!name)return cache;
 const old=cache.sources[name]??{},at=iso(now);
 try{
  const text=await fetchText(EVENT_SOURCES[name]);const events=name==='fed'?parseFed(text):parseIcs(text,name);
  const date=etParts(new Date(now)).date,retained=events.filter(e=>e.date>=date&&e.date<=iso(now+370*86400000).slice(0,10));
  if(!retained.length)throw Error('calendar_has_no_future_coverage');
  cache.sources[name]={status:'available',attempted_at:at,fetched_at:at,events:retained.slice(0,400),reason:null};
 }catch(error){cache.sources[name]={...old,status:'unavailable',attempted_at:at,reason:/^calendar_http_\d+$/.test(error.message)?error.message:'calendar_fetch_or_parse_unverified'};}
 return cache;
}
