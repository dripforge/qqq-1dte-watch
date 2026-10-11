import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIcs,parseFed,normalizeEarnings,eventContext,refreshOneCalendar,boundedPublicFetch } from './event-context.mjs';
const now=Date.parse('2026-10-09T19:50:00Z');
const wrap=s=>'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n'+s+'\r\nEND:VEVENT\r\nEND:VCALENDAR';
test('calendar unfolds titles and handles UTC, Eastern DST and date-only without guessed times',()=>{
 const a=parseIcs(wrap('SUMMARY:Consumer Price\\,\r\n  Index\r\nDTSTART;TZID=America/New_York:20261014T083000'),'bls')[0];assert.equal(a.at,'2026-10-14T12:30:00.000Z');
 const b=parseIcs(wrap('SUMMARY:Test\r\nDTSTART;TZID=America/New_York:20261114T083000'),'bls')[0];assert.equal(b.at,'2026-11-14T13:30:00.000Z');
 assert.equal(parseIcs(wrap('SUMMARY:Test\r\nDTSTART;VALUE=DATE:20261014'),'bls')[0].at,null);
 for(const time of ['20261014T083000','20261314T083000Z'])assert.throws(()=>parseIcs(wrap('SUMMARY:Bad\r\nDTSTART:'+time),'bls'));
});
test('missing, malformed and failed calendars do not imply an event-free day',async()=>{
 const cache=await refreshOneCalendar(null,{now,fetchText:async()=>{throw Error('calendar_http_403');}});
 const x=eventContext(cache,{now});assert.equal(x.status,'partial');assert.equal(x.sources.bls.status,'unavailable');assert.equal(x.sources.bls.reason,'calendar_http_403');assert.equal(x.sources.bea.status,'missing');
 assert.throws(()=>parseIcs('<html>Access denied</html>','bls'));assert.throws(()=>parseFed('<html>Changed layout</html>'));
});
test('calendar stale/future timestamps hide events; earnings timing and tentative status are preserved',()=>{
 const events=normalizeEarnings({results:[{symbol:'AAPL',report:{date:'2026-10-12',timing:'pm',verified:false},eps:{actual:null}}]});assert.equal(events[0].at,null);assert.equal(events[0].verified,false);
 for(const age of [86400001,-6000]){const c={sources:{earnings:{status:'available',fetched_at:new Date(now-age).toISOString(),events}}};assert.equal(eventContext(c,{now}).events.length,0);}
});
test('calendar refresh has a retry cooldown and refuses unapproved hosts',async()=>{
 let calls=0;const first=await refreshOneCalendar(null,{now,fetchText:async()=>{calls++;throw Error('offline');}});const second=await refreshOneCalendar(first,{now:now+1000,fetchText:async()=>{calls++;throw Error('offline');}});assert.equal(calls,2);assert.ok(second.sources.bea);await assert.rejects(boundedPublicFetch('https://example.com'),/not_allowed/);
});
