import test from 'node:test';
import assert from 'node:assert/strict';
import { CALENDAR_METADATA, etParts, sessionForDate, marketSession, nextTradingDate, expirationStatus } from './session.mjs';
import { evaluate } from './logic.mjs';
import { submitExit } from './orderflow.mjs';
import { testStop } from './protection-fixtures.mjs';
import { ensureStop } from './emergency.mjs';

const at = value => new Date(value);
const arm = { option_id: '00000000-0000-4000-8000-000000000001', option_type: 'call',
  expiration_date: '2026-11-27', qqq_invalidation: 750, entry_premium: 1.5, quantity: 1 };
const position = { option_id: arm.option_id, type: 'long', quantity: '1', chain_symbol: 'QQQ', expiration_date: arm.expiration_date };
function store(initial) { let saved=initial;return {load:()=>saved,save:value=>{saved=value;}}; }

test('normal entries end at 15:58 ET while expiration exits stay at 15:45', () => {
  const day = sessionForDate('2026-10-08');
  assert.equal(day.open_minute, 570);
  assert.equal(day.close_minute, 960);
  assert.equal(day.entry_start_minute, 585);
  assert.equal(day.entry_cutoff_minute, 958);
  assert.equal(day.expiration_cutoff_minute, 945);
  assert.equal(marketSession(at('2026-10-08T13:44:59Z')).can_enter, false);
  assert.equal(marketSession(at('2026-10-08T13:45:00Z')).can_enter, true);
  assert.equal(marketSession(at('2026-10-08T18:59:59Z')).can_enter, true);
  assert.equal(marketSession(at('2026-10-08T19:00:00Z')).can_enter, true);
  assert.equal(marketSession(at('2026-10-08T19:57:59Z')).can_enter, true);
  assert.equal(marketSession(at('2026-10-08T19:58:00Z')).can_enter, false);
  assert.equal(marketSession(at('2026-10-08T20:00:00Z')).can_enter, false);
});

test('early close moves the last entry to noon and expiration exit to 12:45 ET', () => {
  const day = sessionForDate('2026-11-27');
  assert.equal(day.reason, 'early_close');
  assert.equal(day.close_minute, 780);
  assert.equal(day.entry_cutoff_minute, 720);
  assert.equal(day.expiration_cutoff_minute, 765);
  assert.equal(marketSession(at('2026-11-27T16:59:59Z')).can_enter, true);
  assert.equal(marketSession(at('2026-11-27T17:00:00Z')).can_enter, false);
  assert.equal(expirationStatus(arm.expiration_date,at('2026-11-27T17:44:59Z')).cutoff_reached, false);
  assert.equal(evaluate(arm, position, null, at('2026-11-27T17:45:00Z')).reason, 'expiration_cutoff');
  assert.equal(marketSession(at('2026-11-27T17:59:59Z')).is_open, true);
  assert.equal(marketSession(at('2026-11-27T18:00:00Z')).is_open, false);
});

test('open expiration positions after an early close remain errors instead of silent market-closed results', () => {
  assert.throws(() => evaluate(arm, position, null, at('2026-11-27T18:00:00Z')), /window missed/);
  assert.throws(() => evaluate(arm, position, null, at('2026-11-30T15:00:00Z')), /window missed/);
  assert.equal(expirationStatus(arm.expiration_date,at('2026-11-27T18:00:00Z')).window_missed, true);
});

test('published holidays and weekends block entries with no quote assumption', () => {
  for (const date of ['2026-11-26','2026-12-25','2027-06-18','2027-07-05','2028-07-04','2026-10-10']) {
    const session = marketSession(at(`${date}T16:00:00Z`));
    assert.equal(session.verified, true);
    assert.equal(session.is_trading_day, false);
    assert.equal(session.can_enter, false);
  }
  assert.equal(evaluate(arm, position, null, at('2026-11-26T16:00:00Z')).reason, 'market_closed');
});

test('next trading date follows Thanksgiving and observed holidays without guessing future years', () => {
  assert.equal(nextTradingDate('2026-11-25'),'2026-11-27');
  assert.equal(nextTradingDate('2026-11-27'),'2026-11-30');
  assert.equal(nextTradingDate('2027-12-23'),'2027-12-27');
  assert.equal(sessionForDate('2027-12-31').is_trading_day,true);
  assert.equal(sessionForDate('2028-07-03').reason,'early_close');
  assert.throws(() => nextTradingDate('2028-12-29'), /outside.*verified/);
});

test('New York daylight-saving transitions preserve ET entry windows', () => {
  assert.deepEqual(etParts(at('2026-10-30T13:45:00Z')), {date:'2026-10-30',minute:585});
  assert.deepEqual(etParts(at('2026-11-02T14:45:00Z')), {date:'2026-11-02',minute:585});
  assert.equal(marketSession(at('2026-11-02T13:45:00Z')).can_enter,false);
  assert.equal(marketSession(at('2026-11-02T14:45:00Z')).can_enter,true);
  assert.equal(marketSession(at('2026-11-02T20:57:59Z')).can_enter,true);
  assert.equal(marketSession(at('2026-11-02T20:58:00Z')).can_enter,false);
});

test('unsupported or malformed dates never become verified sessions', () => {
  assert.equal(CALENDAR_METADATA.valid_through,'2028-12-31');
  assert.equal(marketSession(at('2029-01-02T16:00:00Z')).verified,false);
  assert.equal(marketSession(at('2029-01-02T16:00:00Z')).is_open,false);
  assert.equal(marketSession(at('2029-01-02T16:00:00Z')).can_enter,false);
  for (const date of ['2026-02-30','2026-13-01','not-a-date']) assert.throws(()=>sessionForDate(date),/Invalid/);
});

test('pending early-close expiration exit stays armed after close without broker submission', async () => {
  const time = Date.parse('2026-11-27T18:00:00Z');
  const intentStore=store();
  const result=await submitExit({arm,decision:{reason:'expiration_cutoff',observed_at:'2026-11-27T17:45:00Z'},
    intentStore,clock:()=>time,broker:{orders:async()=>{throw Error('Must not access broker to submit after close');}}});
  assert.equal(result.status,'exit_waiting_market');
  assert.equal(result.expiration_window_missed,true);
  assert.equal(result.session_close_minute,780);
  assert.ok(intentStore.load().ref_id);
});

test('slow stop cancellation crossing an early close cannot queue an overnight sell', async () => {
  let time=Date.parse('2026-11-27T17:59:55Z');
  let placements=0;
  const intentStore=store();
  const result=await submitExit({arm,decision:{reason:'expiration_cutoff',observed_at:'2026-11-27T17:45:00Z'},intentStore,clock:()=>time,
    broker:{orders:async()=>[{id:'stop',trigger:'stop',state:'confirmed'}],cancel:async()=>{},
      order:async()=>{time+=10000;return {id:'stop',state:'cancelled',processed_quantity:'0'};},
      position:async()=>position,place:async()=>{placements++;return {};}}});
  assert.equal(result.status,'exit_waiting_market');
  assert.equal(result.expiration_window_missed,true);
  assert.equal(placements,0);
});

test('holidays and unverified calendars retain exit intent and prevent placement', async () => {
  for (const observed of ['2026-11-26T16:00:00Z','2029-01-02T16:00:00Z']) {
    const time=Date.parse(observed),intentStore=store();
    const result=await submitExit({arm:{...arm,expiration_date:observed.slice(0,10)},
      decision:{reason:'qqq_invalidation',observed_at:observed},intentStore,clock:()=>time,
      broker:{orders:async()=>{throw Error('No broker submission on closed/unverified session');}}});
    assert.equal(result.status,'exit_waiting_market');
    assert.ok(intentStore.load().ref_id);
    assert.equal(result.calendar_verified,observed.startsWith('2026'));
  }
});

test('emergency stops are not newly placed after an early close but existing stops are reconciled', async () => {
  const time=Date.parse('2026-11-27T18:00:00Z');
  const broker={orders:async()=>[],optionQuote:async()=>{throw Error('Do not submit outside the session');}};
  const result=await ensureStop({arm,broker,intentStore:store(),clock:()=>time,entryFillVerified:true});
  assert.equal(result.status,'stop_unavailable_now');
  broker.orders=async()=>[testStop(arm,{id:'working-stop',created:new Date(time-1000).toISOString(),stopPrice:'1.13'})];
  const closed=await ensureStop({arm,broker,intentStore:store(),clock:()=>time,entryFillVerified:true});
  assert.equal(closed.status,'stop_unavailable_now');
  assert.equal(closed.readiness.broker_stop_verified,false);
});

test('slow emergency quote crossing an early close cannot submit a new stop', async () => {
  let time=Date.parse('2026-11-27T17:59:59Z');
  const broker={orders:async()=>[],optionQuote:async()=>{time+=2000;return {bid_price:'1.50',ask_price:'1.54',updated_at:new Date(time).toISOString()};},
    placeStop:async()=>{throw Error('No stop after early close');}};
  assert.equal((await ensureStop({arm,broker,intentStore:store(),clock:()=>time,entryFillVerified:true})).status,'stop_unavailable_now');
});
