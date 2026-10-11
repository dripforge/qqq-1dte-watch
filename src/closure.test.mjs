import test from 'node:test';
import assert from 'node:assert/strict';
import { matchingClosingFill } from './closure.mjs';
const arm={option_id:'option',entry_premium:1.77};
const open='2026-10-08T15:47:32Z';
const order={id:'sell',state:'filled',processed_quantity:'1',processed_premium:'161',last_transaction_at:'2026-10-08T15:51:06Z',
 legs:[{option_id:'option',side:'sell',position_effect:'close',executions:[{price:'1.61',quantity:'1'}]}]};
test('only a full closing fill after this entry proves closure',()=>{
 assert.equal(matchingClosingFill(order,arm,open).gross_realized_pnl,-16);
 assert.equal(matchingClosingFill({...order,state:'confirmed'},arm,open),null);
 assert.equal(matchingClosingFill(order,arm,'2026-10-08T16:00:00Z'),null);
 assert.equal(matchingClosingFill(order,arm,null),null);
 assert.equal(matchingClosingFill({...order,processed_quantity:'0'},arm,open),null);
});
