process.env.QQQ_ENABLE_BROKER='1';
process.env.QQQ_ENABLE_LIVE_ORDERS='1';
process.env.QQQ_ACCOUNT_NUMBER='test-account';
import test from 'node:test';
import assert from 'node:assert/strict';
import { call } from './mcp.mjs';

test('async ownership check completes under lock before a mutation is sent',async()=>{
  const events=[];
  const client={callTool:async({name})=>{events.push(name);return {structuredContent:{data:{name}}};}};
  await call(client,'place_option_order',{account_number:'test-account'}, {beforeSend:async({read})=>{
    events.push('guard_started');await Promise.resolve();
    await read('get_option_positions',{});events.push('guard_verified');
  }});
  assert.deepEqual(events,['guard_started','get_option_positions','guard_verified','place_option_order']);
});
test('failed ownership and mutation through the read adapter never send an order',async()=>{
  const sent=[];const client={callTool:async({name})=>{sent.push(name);return {structuredContent:{data:{}}};}};
  await assert.rejects(call(client,'place_option_order',{account_number:'test-account'}, {beforeSend:async()=>{await Promise.resolve();throw Error('position lifetime changed');}}),/lifetime/);
  await assert.rejects(call(client,'cancel_option_order',{account_number:'test-account'}, {beforeSend:async({read})=>read('cancel_option_order',{})}),/read tools only/);
  assert.deepEqual(sent,[]);
});
