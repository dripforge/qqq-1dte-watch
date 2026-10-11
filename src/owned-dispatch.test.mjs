import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEntryIntent} from './entry-recovery.mjs';
import {confirmPositionOwnership} from './position-ownership.mjs';
import {assertFlatPositionSnapshot,createOwnershipDispatchGuard} from './owned-dispatch.mjs';
const at=Date.parse('2026-10-09T14:00:00Z');
const original={option_id:'00000000-0000-4000-8000-000000000001',trade_id:'00000000-0000-4000-8000-000000000002',option_type:'call',expiration_date:'2026-10-12',quantity:1,entry_premium:4,qqq_invalidation:746};
const intent={...prepareEntryIntent({arm:original,setupId:'setup',policySnapshot:{revision:1},now:at}),dispatch_phase:'dispatch_started',dispatch_started_at:new Date(at+100).toISOString()};
const position={chain_symbol:'QQQ',option_id:original.option_id,type:'long',quantity:'1',trade_value_multiplier:'100',expiration_date:original.expiration_date,average_price:'390',opened_at:new Date(at+1000).toISOString()};
const arm=confirmPositionOwnership({arm:original,intent,position,now:at+60000}).arm;
const load=name=>({'arm.json':arm,'entry-intent.json':intent,'stop-intent.json':{order_id:'stop'}}[name]);
test('final ownership read follows order reads; replacement during order lookup blocks dispatch',async()=>{
 const calls=[];let reopened=false,sent=false;
 const guard=createOwnershipDispatchGuard({account:'test',arm,load,clock:()=>at+60000,beforeSend:()=>{sent=true;}});
 await assert.rejects(()=>guard({read:async name=>{calls.push(name);if(name==='get_option_orders'){reopened=true;return {orders:[]};}return {positions:[reopened?{...position,opened_at:new Date(at+20000).toISOString()}:position]};}}),error=>error.ownership_status==='position_ownership_changed');
 assert.deepEqual(calls,['get_option_orders','get_option_positions']);assert.equal(sent,false);
});
test('verified closing fill blocks another old-life action despite stale held-position publication',async()=>{
 let sent=false,positionReads=0;
 const guard=createOwnershipDispatchGuard({account:'test',arm,load,clock:()=>at+60000,beforeSend:()=>{sent=true;}});
 await assert.rejects(()=>guard({read:async name=>{if(name==='get_option_positions'){positionReads++;return {positions:[position]};}return {orders:[{id:'stop',state:'filled',processed_quantity:'1',processed_premium:'300',last_transaction_at:new Date(at+20000).toISOString(),legs:[{option_id:arm.option_id,side:'sell',position_effect:'close'}]}]};}}),error=>error.ownership_status==='closing_fill_waiting_position');
 assert.equal(sent,false);assert.equal(positionReads,0);
});
test('valid exact lifetime permits callback only after final position verification',async()=>{
 const calls=[];
 await createOwnershipDispatchGuard({account:'test',arm,load,clock:()=>at+60000,beforeSend:()=>calls.push('send')})({read:async name=>{calls.push(name);return name==='get_option_orders'?{orders:[]}:{positions:[position]};}});
 assert.deepEqual(calls,['get_option_orders','get_option_positions','send']);
});
test('flat entry requires a complete valid snapshot, and rejects every QQQ position',()=>{
 assert.doesNotThrow(()=>assertFlatPositionSnapshot({positions:[]}));
 for(const snapshot of [{},{positions:null},{positions:[] ,next:'cursor'},{positions:[null]},{positions:[{chain_symbol:'QQQ',quantity:'bad'}]},{positions:[{chain_symbol:'QQQ',quantity:null}]},{positions:[position]}])assert.throws(()=>assertFlatPositionSnapshot(snapshot));
});
