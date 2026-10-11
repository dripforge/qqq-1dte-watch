import test from 'node:test';
import assert from 'node:assert/strict';
import {requireNearMoneyContract} from './contract-selection.mjs';
test('direction-aware near-money gate retains nearby ITM and ATM, limiting OTM to one dollar',()=>{
 for(const direction of ['call','put'])assert.equal(requireNearMoneyContract({direction,strike:750,qqqPrice:750}).moneyness,'at_the_money');
 assert.equal(requireNearMoneyContract({direction:'call',strike:748,qqqPrice:750}).moneyness,'in_the_money');
 assert.equal(requireNearMoneyContract({direction:'put',strike:752,qqqPrice:750}).moneyness,'in_the_money');
 for(const [direction,strike] of [['call',751],['put',749]])assert.equal(requireNearMoneyContract({direction,strike,qqqPrice:750}).moneyness,'out_of_the_money');
 for(const [direction,strike] of [['call',751.01],['put',748.99]])assert.throws(()=>requireNearMoneyContract({direction,strike,qqqPrice:750}),/within \$1/);
 for(const [direction,strike] of [['call',746],['put',754]])assert.throws(()=>requireNearMoneyContract({direction,strike,qqqPrice:750}),/too far/);
});
test('a crossing into farther OTM before retry or final dispatch fails the same gate',()=>{
 assert.doesNotThrow(()=>requireNearMoneyContract({direction:'call',strike:751,qqqPrice:750.5}));
 assert.throws(()=>requireNearMoneyContract({direction:'call',strike:751,qqqPrice:749.9}),/within \$1/);
 for(const qqqPrice of [null,undefined,'',0,NaN])assert.throws(()=>requireNearMoneyContract({direction:'call',strike:750,qqqPrice}));
});
