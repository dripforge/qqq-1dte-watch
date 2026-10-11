import test from 'node:test';
import assert from 'node:assert/strict';
import { watchdogIssues, changedIssues } from './watchdog-policy.mjs';
const now = Date.parse('2026-10-08T17:00:00Z');
const health = {fresh: true, live_verified: true, reported_status: 'holding', condition: 'fresh'};
const watch = {observed_at: new Date(now - 88000).toISOString(), positions_open: 1, outcome: 'holding'};
const open = {verified: true, is_open: true};
test('healthy holding checks are quiet at the observed scheduling cadence', () => {
  assert.deepEqual(watchdogIssues({health, watch, session: open, now}), []);
});
test('stopped monitor and delayed profit reviews alert independently', () => {
  const issues = watchdogIssues({health: {...health, fresh: false, live_verified: false, condition: 'stale'},
    watch: {...watch, observed_at: new Date(now - 121000).toISOString()}, session: open, hasState: true, now});
  assert.deepEqual(issues.map(i => i.code), ['monitor_unverified', 'watch_delayed']);
  assert.ok(issues.every(i => i.urgent));
});
test('market closure suppresses expected out-of-hours profit-review delay', () => {
  assert.deepEqual(watchdogIssues({health, watch: {...watch, observed_at: new Date(now - 3600000).toISOString()},
    session: {...open, is_open: false}, hasState: true, now}), []);
});
test('fresh idle broker health overrides an older holding report', () => {
  assert.deepEqual(watchdogIssues({health: {...health, reported_status: 'idle'},
    watch: {...watch, observed_at: new Date(now - 3600000).toISOString()}, session: open, now}), []);
});
test('unknown order, missed expiration and policy failure stay visible', () => {
  const issues = watchdogIssues({health: {...health, reported_status: 'expiration_window_missed', deadline_exceeded: true},
    watch, session: open, policyError: true, stateError: true, now});
  assert.deepEqual(issues.map(i => i.code), ['monitor_expiration_window_missed', 'exit_deadline_missed', 'policy_unavailable', 'trade_state_unavailable']);
});
test('only new issues notify and a resolved issue records recovery', () => {
  const a = [{code: 'monitor_unverified', message: 'old'}];
  assert.deepEqual(changedIssues(a, [{...a[0], message: 'older'}]).added, []);
  assert.deepEqual(changedIssues(a, []).recovered, a);
});
test('missing primary data and unverified broker protection cannot appear healthy', () => {
  const issues = watchdogIssues({health: {...health, data_unavailable: true, stop_status: 'stop_pending'},
    watch, session: {...open, minute: 600, entry_start_minute: 585}, now,
    stopPendingAt: new Date(now - 31000).toISOString()});
  assert.deepEqual(issues.map(i => i.code), ['primary_data_unavailable', 'broker_protection_unverified']);
  assert.deepEqual(watchdogIssues({health: {...health, stop_status: 'local_premium_watch_only'},
    watch, session: {...open, minute: 575, entry_start_minute: 585}, now}), []);
});
test('an existing warning alerts again if a possible trade makes it urgent', () => {
  const warning = {code: 'monitor_unverified', urgent: false};
  assert.equal(changedIssues([warning], [{...warning, urgent: true}]).added.length, 1);
});
