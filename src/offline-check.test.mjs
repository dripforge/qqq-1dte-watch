import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOfflineCheck } from './offline-check.mjs';
import { syntheticChecks } from '../examples/synthetic-session.mjs';
import { VERSION } from './version.mjs';
import { validateOptionMarket } from './contract-selection.mjs';

const complete=()=>syntheticChecks(VERSION).at(-1);
test('demo decisions arise from actual failing stages and never authorize orders',()=>{
  const rows=syntheticChecks(VERSION).map(input=>evaluateOfflineCheck(input));
  assert.deepEqual(rows.map(r=>r.decision_stage),['structure','follow_through','risk','entry']);
  assert.ok(rows.every(r=>r.execution_authorized===false&&r.application_version===VERSION));
  assert.equal(rows[0].audit.checks.risk.status,'not_evaluated');
  const last=rows.at(-1);assert.equal(last.audit.checks.risk.status,'pass');
  assert.equal(last.computed_evidence.risk.planned_risk,51);
  assert.equal(last.audit.checks.room.status,'not_evaluated');
  assert.equal(last.computed_evidence.room.status,'reviewed');
  assert.equal(last.audit.checks.entry.status,'block');
});
test('changed synthetic inputs change the explanation rather than preserving a scripted label',()=>{
  const low=syntheticChecks(VERSION)[2];
  low.portfolio.total_value=10000;
  assert.equal(evaluateOfflineCheck(low).decision_stage,'entry');
  const stale=complete();stale.health.at=new Date(stale.now.getTime()-120000).toISOString();
  assert.equal(evaluateOfflineCheck(stale).decision_stage,'service');
  const missing=complete();missing.positions={};
  assert.equal(evaluateOfflineCheck(missing).decision_stage,'position');
  const badContract=complete();badContract.option.ask_price=3;
  assert.equal(evaluateOfflineCheck(badContract).decision_stage,'contract');
});
test('option market validation shared with entry rejects stale, crossed and mismatched quotes',()=>{
  const input=complete(),options={now:input.now.getTime(),optionId:input.instrument.id};
  assert.deepEqual(validateOptionMarket(input.option,options),{ask:2,bid:1.95});
  for(const mutation of [{updated_at:new Date(options.now-11000).toISOString()},{bid_price:3},{bid_price:null},{ask_size:0},{instrument_id:'other'}]) {
    assert.throws(()=>validateOptionMarket({...input.option,...mutation},options));
  }
  assert.throws(()=>evaluateOfflineCheck({...input,synthetic:false}),/synthetic/);
});
