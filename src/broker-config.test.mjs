import test from 'node:test';
import { readFileSync } from 'node:fs';
import { validateApprovedRiskPolicy } from './approved-risk-policy.mjs';
import assert from 'node:assert/strict';
import { assertBrokerEnabled, assertBrokerCall, requireConfiguredAccount } from './broker-config.mjs';
import { connectReadOnly, call } from './mcp.mjs';
import { DEFAULT_RISK_POLICY, reserveRisk } from './risk-policy.mjs';

const read = { QQQ_ENABLE_BROKER:'1', QQQ_ACCOUNT_NUMBER:'synthetic-account' };
const live = { ...read, QQQ_ENABLE_LIVE_ORDERS:'1' };
test('broker gates fail closed and separate reads from writes', () => {
  for (const value of [undefined,'true','0','yes']) assert.throws(()=>assertBrokerEnabled({QQQ_ENABLE_BROKER:value}),/disabled/);
  assert.doesNotThrow(()=>assertBrokerCall('get_accounts',{},read));
  assert.throws(()=>assertBrokerCall('place_option_order',{account_number:read.QQQ_ACCOUNT_NUMBER},read),/disabled/);
  assert.doesNotThrow(()=>assertBrokerCall('place_option_order',{account_number:live.QQQ_ACCOUNT_NUMBER},live));
  assert.throws(()=>assertBrokerCall('cancel_option_order',{account_number:'other'},live),/does not match/);
  assert.throws(()=>assertBrokerCall('transfer_money',{account_number:live.QQQ_ACCOUNT_NUMBER},live),/not supported/);
});
test('account selection requires an exact eligible identity and rejects ambiguity', () => {
  const account={account_number:read.QQQ_ACCOUNT_NUMBER,agentic_allowed:true};
  assert.equal(requireConfiguredAccount([account],read),account);
  for (const accounts of [[],[account,account],[{...account,agentic_allowed:false}],[{...account,account_number:'other'}]]) {
    assert.throws(()=>requireConfiguredAccount(accounts,read),/unavailable or ambiguous/);
  }
  for (const value of ['',undefined,' synthetic-account ']) assert.throws(()=>requireConfiguredAccount([account],{QQQ_ACCOUNT_NUMBER:value}),/exact/);
});
test('disabled adapter rejects before credentials, networking or client dispatch', async () => {
  const old=process.env.QQQ_ENABLE_BROKER;
  delete process.env.QQQ_ENABLE_BROKER;
  try {
    await assert.rejects(connectReadOnly(),/Broker disabled/);
    let sent=false;
    await assert.rejects(call({callTool:()=>{sent=true;}},'place_option_order',{}),/Broker disabled/);
    assert.equal(sent,false);
  } finally { if(old===undefined) delete process.env.QQQ_ENABLE_BROKER; else process.env.QQQ_ENABLE_BROKER=old; }
});
test('public arithmetic defaults constrain small accounts without authorizing execution', () => {
  assert.equal(DEFAULT_RISK_POLICY.per_trade_risk_fraction,.01);
  assert.equal(DEFAULT_RISK_POLICY.daily_loss_fraction,.03);
  const example=JSON.parse(readFileSync(new URL('../examples/policy.example.json',import.meta.url),'utf8'));
  for(const [key,value] of Object.entries(DEFAULT_RISK_POLICY)) assert.equal(example[key],value);
  assert.equal(example.approved,false);
  assert.throws(()=>validateApprovedRiskPolicy(example),/approval/);
  const portfolio={total_value:10000,buying_power:{buying_power:10000,unleveraged_buying_power:10000}};
  const result=reserveRisk({portfolio,premium:3,brokerRealized:{realized_pnl:0}});
  assert.equal(result.daily_limit,100);
  assert.equal(result.planned_risk,76);
  assert.throws(()=>reserveRisk({portfolio,premium:3.01,brokerRealized:{realized_pnl:0}}),/premium/);
  assert.throws(()=>reserveRisk({portfolio,premium:3,brokerRealized:{realized_pnl:-25}}),/remaining daily/);
  assert.throws(()=>reserveRisk({portfolio:{total_value:500,buying_power:{buying_power:500,unleveraged_buying_power:500}},premium:2,brokerRealized:{realized_pnl:0}}),/trade risk/);
});
