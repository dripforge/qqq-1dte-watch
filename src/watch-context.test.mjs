import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWatchContext } from './watch-context.mjs';

const now = Date.parse('2026-10-08T17:45:00Z');
const option = '11111111-1111-4111-8111-111111111111';
const trade = '22222222-2222-4222-8222-222222222222';
const policy = { schema_version: 1, policy_id: 'qqq-1dte-risk', revision: 1, approved: true,
  recorded_at: '2026-10-08T17:45:07Z', per_trade_risk_fraction: 0.7, daily_loss_fraction: 0.5,
  absolute_daily_loss: 250, emergency_stop_fraction: 0.25, execution_cushion: 1, opening_premium_ceiling: 500 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qqq-watch-context-'));
  writeFileSync(join(root, 'policy.json'), JSON.stringify(policy));
  writeFileSync(join(root, 'health.json'), JSON.stringify({ live: true, status: 'idle', at: new Date(now - 1000).toISOString() }));
  return root;
}
test('local context shows session, approved version, health and previous watch age without broker data', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'watch-status.json'), JSON.stringify({ observed_at: new Date(now - 90000).toISOString(),
      outcome: 'no_setup', account_number: 'must-not-appear' }));
    const result = await readWatchContext(root, { now });
    assert.equal(result.critical_block, false);
    assert.equal(result.market_session.can_enter, true);
    assert.equal(result.approved_risk.policy.per_trade_risk_fraction, 0.7);
    assert.equal(result.approved_risk.snapshot.revision, 1);
    assert.equal(result.service_health.live_verified, true);
    assert.equal(result.last_watch.age_ms, 90000);
    assert.equal(result.active_state.arm, false);
    assert.equal(JSON.stringify(result).includes('must-not-appear'), false);
  } finally { rmSync(root, { recursive: true }); }
});
test('malformed policy blocks while available service and active identity still report', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'policy.json'), '{');
    writeFileSync(join(root, 'arm.json'), JSON.stringify({ option_id: option, trade_id: trade, access_token: 'must-not-appear' }));
    const result = await readWatchContext(root, { now });
    assert.equal(result.critical_block, true);
    assert.equal(result.approved_risk, null);
    assert.equal(result.service_health.live_verified, true);
    assert.equal(result.service_health.max_age_ms, 30000);
    assert.equal(result.active_state.arm, true);
    assert.equal(result.active_state.trade_id, trade);
    assert.equal(JSON.stringify(result).includes('must-not-appear'), false);
  } finally { rmSync(root, { recursive: true }); }
});
test('unknown state and stale health remain explicit and cannot imply a flat healthy account', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'arm.json'), '{');
    writeFileSync(join(root, 'health.json'), JSON.stringify({ live: true, status: 'holding', at: new Date(now - 31000).toISOString() }));
    writeFileSync(join(root, 'watch-status.json'), '{');
    const result = await readWatchContext(root, { now });
    assert.equal(result.active_state.arm, null);
    assert.equal(result.service_health.live_verified, false);
    assert.equal(result.service_health.condition, 'stale');
    assert.ok(result.errors.some(e => e.component === 'active_state'));
    assert.ok(result.errors.some(e => e.component === 'last_watch'));
  } finally { rmSync(root, { recursive: true }); }
});
test('unsupported calendar date fails closed while all local components remain available', async () => {
  const root = fixture();
  try {
    const result = await readWatchContext(root, { now: Date.parse('2040-10-08T17:45:00Z') });
    assert.equal(result.critical_block, true);
    assert.equal(result.market_session.verified, false);
    assert.equal(result.market_session.reason, 'calendar_unverified');
    assert.ok(result.approved_risk);
    assert.ok(result.service_health);
    assert.ok(result.errors.some(e => e.code === 'calendar_unverified'));
  } finally { rmSync(root, { recursive: true }); }
});
test('different local trade UUIDs are reported as a conflict rather than selecting an identity', async () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'arm.json'), JSON.stringify({ option_id: option, trade_id: trade }));
    writeFileSync(join(root, 'entry-intent.json'), JSON.stringify({ option_id: option,
      trade_id: '33333333-3333-4333-8333-333333333333' }));
    const result = await readWatchContext(root, { now });
    assert.equal(result.active_state.trade_id, null);
    assert.equal(result.active_state.option_id, option);
    assert.ok(result.errors.some(e => e.code === 'conflicting_trade_identity'));
  } finally { rmSync(root, { recursive: true }); }
});
test('optional cached context is local, ages honestly and cannot block core trading health',async()=>{
 const root=fixture();try{
  writeFileSync(join(root,'analysis-context-latest.json'),JSON.stringify({version:1,analysis_version:'1.0.0',equity_quotes:[{symbol:'QQQ',quote_at:new Date(now-60000).toISOString(),usable:true,last:500}]}));
  let result=await readWatchContext(root,{now});assert.equal(result.critical_block,false);assert.equal(result.analysis_context.equity_quotes[0].last,null);assert.equal(result.event_context.status,'partial');
  writeFileSync(join(root,'analysis-events-cache.json'),'{');result=await readWatchContext(root,{now});assert.equal(result.critical_block,false);assert.equal(result.event_context.status,'unavailable');
 }finally{rmSync(root,{recursive:true});}
});
