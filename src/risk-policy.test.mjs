import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerDailyRealized, reserveRisk as reserveRiskBase, riskPolicy } from './risk-policy.mjs';
import { loadApprovedRiskPolicy, validateApprovedRiskPolicy, assertApprovedRiskPolicy } from './approved-risk-policy.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const reserveRisk = input => reserveRiskBase({...input, policy: {per_trade_risk_fraction:0.70,daily_loss_fraction:0.50,absolute_daily_loss:250,opening_premium_ceiling:500,...input.policy}});
const portfolio = { total_value: '500', cash: '500', buying_power: {
  buying_power: '500', unleveraged_buying_power: '500' } };
const zero = { realized_pnl: 0, number_of_trades: 0 };
test('risk reserve reflects equity, 25% stop and execution cushion', () => {
  const result = reserveRisk({ portfolio, premium: 3.19, brokerRealized: zero });
  assert.ok(Math.abs(result.planned_risk - 80.75) < 1e-8);
  assert.ok(Math.abs(result.per_trade_limit - 350) < 1e-8);
  assert.ok(Math.abs(result.daily_limit - 250) < 1e-8);
  assert.doesNotThrow(() => reserveRisk({ portfolio: { ...portfolio, total_value: '400', cash: '400' }, premium: 3.19, brokerRealized: zero }));
  assert.throws(() => reserveRisk({ portfolio: { ...portfolio, total_value: '400', cash: '400' }, premium: 3.19,
    brokerRealized: zero, policy: { per_trade_risk_fraction: 0.15 } }), /trade risk/);
});
test('larger risk tolerance still enforces the absolute daily ceiling', () => {
  const funded = { total_value: '1000', cash: '1000', buying_power: {
    buying_power: '1000', unleveraged_buying_power: '1000' } };
  const result = reserveRisk({ portfolio: funded, premium: 3.19, brokerRealized: zero });
  assert.equal(result.daily_limit, 250);
  assert.throws(() => reserveRisk({ portfolio: funded, premium: 3.19,
    brokerRealized: { ...zero, realized_pnl: -170 } }), /remaining daily/);
});
test('daily budget reserves risk before opening, and local loss handles broker lag', () => {
  assert.throws(() => reserveRisk({ portfolio, premium: 3.19, brokerRealized: { ...zero, realized_pnl: -180 } }), /remaining daily/);
  assert.throws(() => reserveRisk({ portfolio, premium: 3.19, brokerRealized: zero,
    localRealized: { realized_pnl: -180, number_of_trades: 1, pnl_basis: 'net_after_fees' } }), /remaining daily/);
});
test('cannot use margin affordability or missing account value', () => {
  assert.throws(() => reserveRisk({ portfolio: { ...portfolio, buying_power: {
    buying_power: '1000', unleveraged_buying_power: '100' } }, premium: 1.77, brokerRealized: zero }), /unleveraged/);
  assert.throws(() => reserveRisk({ portfolio: { ...portfolio, total_value: null }, premium: 1.77, brokerRealized: zero }), /unavailable/);
});
test('valid no-trade total is zero, transfer-null and inconsistent totals fail closed', () => {
  assert.deepEqual(brokerDailyRealized({ data_points: [], total_returns: '0' }), zero);
  assert.throws(() => brokerDailyRealized({ data_points: [{ number_of_trades: 0, realized_gain: null }], total_returns: '0' }), /bucket/);
  assert.throws(() => brokerDailyRealized({ data_points: [], total_returns: null }), /unavailable/);
  assert.throws(() => brokerDailyRealized({ data_points: [{ number_of_trades: 1, realized_gain: '-16' }], total_returns: '0' }), /disagree/);
});

test('known gross fill basis uses the worse loss while broker totals catch up', () => {
  const result = reserveRisk({ portfolio, premium: 1.77, brokerRealized: zero,
    localRealized: { realized_pnl: -16, number_of_trades: 1, pnl_basis: 'fill_premiums_gross' } });
  assert.equal(result.realized_pnl, -16);
  assert.throws(() => reserveRisk({ portfolio, premium: 1.77, brokerRealized: zero,
    localRealized: { realized_pnl: -16, number_of_trades: 1, pnl_basis: 'unknown' } }), /basis is unknown/);
});

const approvedRecord = { schema_version: 1, policy_id: 'qqq-1dte-risk', revision: 1,
  approved: true, recorded_at: '2026-10-08T17:45:07Z', per_trade_risk_fraction: 0.70,
  daily_loss_fraction: 0.50, absolute_daily_loss: 250, emergency_stop_fraction: 0.25,
  execution_cushion: 1, opening_premium_ceiling: 500 };
test('approved policy contains every explicit limit and rejects unknown or malformed input', () => {
  const { policy, snapshot } = validateApprovedRiskPolicy(approvedRecord);
  assert.equal(policy.per_trade_risk_fraction, 0.70);
  assert.equal(policy.daily_loss_fraction, 0.50);
  assert.equal(policy.opening_premium_ceiling, 500);
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => validateApprovedRiskPolicy({ ...approvedRecord, approved: false }), /approval/);
  assert.throws(() => validateApprovedRiskPolicy({ ...approvedRecord, schema_version: 2 }), /schema/);
  assert.throws(() => validateApprovedRiskPolicy({ ...approvedRecord, recorded_at: '2026-02-30T17:45:07Z' }), /time is invalid/);
  assert.throws(() => validateApprovedRiskPolicy({ ...approvedRecord, speculative: true }), /Unknown/);
  assert.throws(() => validateApprovedRiskPolicy({ ...approvedRecord, per_trade_risk_fraction: '0.70' }), /finite number/);
  const missing = { ...approvedRecord }; delete missing.daily_loss_fraction;
  assert.throws(() => validateApprovedRiskPolicy(missing), /missing daily/);
  assert.throws(() => riskPolicy({ daily_loss_fraction: null }), /finite number/);
  assert.throws(() => riskPolicy({ absolute_daily_loss: 251 }), /invalid/);
});
test('policy hash survives key order and formatting but detects a changed value or revision', () => {
  const original = validateApprovedRiskPolicy(approvedRecord).snapshot;
  const reordered = Object.fromEntries(Object.entries(approvedRecord).reverse());
  assert.equal(validateApprovedRiskPolicy(reordered).snapshot.sha256, original.sha256);
  const root = mkdtempSync(join(tmpdir(), 'qqq-approved-policy-'));
  try {
    writeFileSync(join(root, 'policy.json'), JSON.stringify(reordered, null, 2));
    assert.deepEqual(assertApprovedRiskPolicy(root, original).snapshot, original);
    writeFileSync(join(root, 'policy.json'), JSON.stringify({ ...approvedRecord, daily_loss_fraction: 0.40 }));
    assert.throws(() => assertApprovedRiskPolicy(root, original), /changed/);
    writeFileSync(join(root, 'policy.json'), JSON.stringify({ ...approvedRecord, revision: 2 }));
    assert.throws(() => assertApprovedRiskPolicy(root, original), /changed/);
  } finally { rmSync(root, { recursive: true }); }
});
test('missing, truncated and legacy unversioned policy files cannot fall back to defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'qqq-approved-policy-'));
  try {
    assert.throws(() => loadApprovedRiskPolicy(root), /unavailable/);
    writeFileSync(join(root, 'policy.json'), '{');
    assert.throws(() => loadApprovedRiskPolicy(root), /unavailable/);
    writeFileSync(join(root, 'policy.json'), JSON.stringify({ per_trade_risk_fraction: 0.7 }));
    assert.throws(() => loadApprovedRiskPolicy(root), /missing schema/);
  } finally { rmSync(root, { recursive: true }); }
});


test('approved $300 cap permits $3.00 but blocks $3.01 including original-limit retries',()=>{
  const record={...approvedRecord,revision:2,opening_premium_ceiling:300};
  const {policy}=validateApprovedRiskPolicy(record);
  assert.equal(riskPolicy().opening_premium_ceiling,300);
  assert.doesNotThrow(()=>reserveRisk({portfolio,premium:3.00,brokerRealized:zero,policy}));
  assert.throws(()=>reserveRisk({portfolio,premium:3.01,brokerRealized:zero,policy}),/premium/);
  assert.throws(()=>reserveRisk({portfolio:{...portfolio,buying_power:{buying_power:'300',unleveraged_buying_power:'300'}},premium:3.00,brokerRealized:zero,policy}),/buying-power/);
  for(const opening_premium_ceiling of [0,-1,500.01])assert.throws(()=>riskPolicy({opening_premium_ceiling}),/invalid/);
});


test('affordability uses broker buying power even when cash lags reusable sale proceeds',()=>{
 const funded={...portfolio,cash:'10',buying_power:{buying_power:'400',unleveraged_buying_power:'400'}};
 assert.equal(reserveRisk({portfolio:funded,premium:3.00,brokerRealized:zero}).spendable,400);
 for(const cash of [undefined,null,'unknown'])assert.doesNotThrow(()=>reserveRisk({portfolio:{...funded,cash},premium:3.00,brokerRealized:zero}));
 assert.throws(()=>reserveRisk({portfolio:funded,premium:4.01,brokerRealized:zero}),/buying-power/);
});
test('removing the raw cash gate cannot authorize leverage, deficits or missing spendable data',()=>{
 for(const buying_power of [{buying_power:'1000',unleveraged_buying_power:'200'},
  {buying_power:'200',unleveraged_buying_power:'1000'},
  {buying_power:'1000',unleveraged_buying_power:'-1'}]){
  assert.throws(()=>reserveRisk({portfolio:{...portfolio,cash:'1000',buying_power},premium:3.00,brokerRealized:zero}),/unleveraged/);
 }
 for(const buying_power of [null,{buying_power:null,unleveraged_buying_power:'400'},{buying_power:'400',unleveraged_buying_power:null}]){
  assert.throws(()=>reserveRisk({portfolio:{...portfolio,buying_power},premium:3.00,brokerRealized:zero}),/unavailable/);
 }
});
