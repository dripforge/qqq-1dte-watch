import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStop, emergencyStopPrice } from './emergency.mjs';
import { testArm as arm, testStop } from './protection-fixtures.mjs';
function store(initial) { let v = initial; return {load:()=>v,save:x=>{v=x;}}; }
function broker() { return { orders:async()=>[], optionQuote:async()=>({bid_price:'1.70',ask_price:'1.74',updated_at:'2026-10-08T15:30:00Z'}),
  placeStop:async()=>({order:testStop()}) }; }
const clock = () => Date.parse('2026-10-08T15:30:01Z');
test('a rejected stop is never reported as armed and retry gets a fresh reference only after verification', async()=>{
 const b=broker(), s=store(); const refs=[];
 b.placeStop=async args=>{refs.push(args.ref_id);return {order:{id:'bad',state:'rejected'}};};
 assert.equal((await ensureStop({arm,broker:b,intentStore:s,clock})).status,'stop_rejected');
 b.order=async()=>testStop(arm,{id:'bad',state:'rejected'});
 await ensureStop({arm,broker:b,intentStore:s,clock}); assert.notEqual(refs[0],refs[1]);
});
test('an unknown transport outcome keeps the exact stop reference',async()=>{
 const b=broker(),s=store();const refs=[];
 b.placeStop=async args=>{refs.push(args.ref_id);if(refs.length===1)throw Error('network');return {order:testStop()};};
 assert.equal((await ensureStop({arm,broker:b,intentStore:s,clock})).status,'stop_outcome_unknown');
 await ensureStop({arm,broker:b,intentStore:s,clock}); assert.equal(refs[0],refs[1]);
});
test('queued stop is pending protection rather than armed',async()=>{
 const b=broker();b.placeStop=async()=>({order:testStop(arm,{state:'queued'})});
 assert.equal((await ensureStop({arm,broker:b,intentStore:store(),clock})).status,'stop_pending');
});
test('unconfirmed is a valid initial stop response with its identity retained',async()=>{
 const b=broker(),s=store();b.placeStop=async()=>({order:testStop(arm,{state:'unconfirmed'})});
 assert.equal((await ensureStop({arm,broker:b,intentStore:s,clock})).status,'stop_pending');
 assert.equal(s.load().order_id,'stop');
});
test('slow reads crossing the close prevent a stop placement',async()=>{
 let time=Date.parse('2026-10-08T19:59:59Z');const b=broker();
 b.optionQuote=async()=>{time+=2000;return {bid_price:'1.70',ask_price:'1.74',updated_at:new Date(time).toISOString()};};
 b.placeStop=async()=>{throw Error('stop must not be placed after close');};
 assert.equal((await ensureStop({arm,broker:b,intentStore:store(),clock:()=>time})).status,'stop_unavailable_now');
});
test('pre-9:45 overnight position still gets a local emergency premium exit',async()=>{
 const b=broker();b.optionQuote=async()=>({bid_price:'1.20',ask_price:'1.25',updated_at:'2026-10-09T13:35:00Z'});
 b.placeStop=async()=>{throw Error('cannot place early stop');};
 const r=await ensureStop({arm,broker:b,intentStore:store(),clock:()=>Date.parse('2026-10-09T13:35:01Z')});
 assert.equal(r.needs_exit,true);assert.equal(r.reason,'emergency_premium');
});
test('stop rounds upward so the planned loss does not exceed 25 percent',()=>assert.equal(emergencyStopPrice(1.77),1.33));
