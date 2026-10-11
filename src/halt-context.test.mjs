import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseHalts,haltContext} from './halt-context.mjs';
import {summarizeDepth} from './analysis-context.mjs';
test('depth has a short shelf life and never claims a durable level',()=>{
 const now=Date.parse('2026-10-09T19:40:00Z'),data={books:[{symbol:'QQQ',updated_at:new Date(now).toISOString(),bids:[{price:'750',quantity:100}],asks:[{price:'750.01',quantity:200}]}]};
 assert.equal(summarizeDepth(data,now).usable,true);assert.equal(summarizeDepth(data,now+10001).usable,false);assert.equal(summarizeDepth(data,now).venue_coverage,'unspecified_by_source');
});
