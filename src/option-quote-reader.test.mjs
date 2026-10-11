import test from 'node:test';
import assert from 'node:assert/strict';
import {optionQuoteReader} from './option-quote-reader.mjs';
const time=Date.parse('2026-10-08T15:00:00Z');
test('a protection refresh after cancellation observes the new bid rather than the original cached quote',async()=>{
  const old={bid_price:'2.00',updated_at:new Date(time).toISOString()};
  const fresh={bid_price:'1.00',updated_at:new Date(time+3000).toISOString()};
  let calls=0;
  const read=optionQuoteReader(old,async()=>{calls++;return fresh;},{clock:()=>time});
  assert.equal(await read(),old);assert.equal(await read(),fresh);assert.equal(calls,1);
});
test('a stale or implausibly future cached quote is refreshed immediately',async()=>{
  for(const updated_at of [new Date(time-10001).toISOString(),new Date(time+5001).toISOString(),'invalid']){
    let calls=0;const fresh={bid_price:'1.50'};
    const read=optionQuoteReader({updated_at},async()=>{calls++;return fresh;},{clock:()=>time});
    assert.equal(await read(),fresh);assert.equal(calls,1);
  }
});
