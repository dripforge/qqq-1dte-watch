import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assessServiceHealth} from './service-health.mjs';
import {watchdogIssues} from './watchdog-policy.mjs';
import {appendJournal,journalDailyRealized} from './journal.mjs';
import {reserveRisk} from './risk-policy.mjs';
const now=Date.parse('2026-10-08T14:35:00Z');
const raw={at:new Date(now).toISOString(),version:'2.2.0',status:'holding',live:true,
  entry_recovery_status:'entry_outcome_unknown',entry_basis_verified:true,entry_fill_verified:false,
  protection_readiness:{phase:'opening_local_watch',ready_for_session:false,issues:['local_coverage_gap']}};
test('a held position with verified basis still alerts on uncertain opening identity and a local coverage gap',()=>{
  const health=assessServiceHealth(raw,{now});
  assert.equal(health.live_verified,true);
  assert.equal(health.entry_basis_verified,true);
  assert.equal(health.entry_fill_verified,false);
  const issues=watchdogIssues({health,hasState:true,session:{verified:true,is_open:true},now,
    watch:{observed_at:new Date(now-60000).toISOString(),outcome:'holding',positions_open:1}});
  assert.deepEqual(issues.map(x=>x.code),['entry_recovery_unverified','protection_readiness_failed']);
  assert(issues.every(x=>x.urgent));
});
test('overnight carry is visible without claiming broker protection or emitting an expected-session failure',()=>{
  const health=assessServiceHealth({...raw,entry_recovery_status:'entry_filled',
    protection_readiness:{phase:'carry_waiting_session',ready_for_session:false,issues:[]}},{now});
  assert.equal(health.protection_phase,'carry_waiting_session');
  assert.equal(health.protection_ready,false);
  assert.deepEqual(watchdogIssues({health,hasState:true,session:{verified:true,is_open:false},now}),[]);
});
test('position-cost realized loss reaches daily capacity while unknown fees remain explicitly labeled',()=>{
  const root=mkdtempSync(join(tmpdir(),'qqq-basis-risk-'));
  try{
    appendJournal(root,'trade_closed',{trade_id:'test-trade',option_id:'test-option',closed_at:new Date(now).toISOString(),
      realized_pnl:-100,pnl_basis:'broker_position_cost_unknown_fees',fees:null});
    const realized=journalDailyRealized(root,'2026-10-08');
    assert.equal(realized.pnl_basis,'broker_position_cost_unknown_fees');
    const portfolio={total_value:'400',cash:'400',buying_power:{buying_power:'400',unleveraged_buying_power:'400'}};
    const risk=reserveRisk({policy:{per_trade_risk_fraction:.70,daily_loss_fraction:.50,absolute_daily_loss:250},portfolio,premium:2,brokerRealized:{realized_pnl:0,number_of_trades:0},localRealized:realized});
    assert.equal(risk.remaining_daily_risk,100);
  }finally{rmSync(root,{recursive:true,force:true});}
});
