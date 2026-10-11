import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assessServiceHealth, readServiceHealth } from './service-health.mjs';

const now = Date.parse('2026-10-08T17:37:04Z');
const report = (age, status = 'idle') => ({ at: new Date(now - age).toISOString(), status, live: true });

test('idle service gets 60 seconds while active state and holding get 30 seconds', () => {
  const idle = assessServiceHealth(report(45000), { now });
  assert.equal(idle.fresh, true);
  assert.equal(idle.live_verified, true);
  assert.equal(idle.max_age_ms, 60000);
  for (const result of [assessServiceHealth(report(45000, 'holding'), { now }),
    assessServiceHealth(report(45000), { now, hasState: true })]) {
    assert.equal(result.status, 'stale');
    assert.equal(result.age_ms, 45000);
    assert.equal(result.live_verified, false);
    assert.equal(result.service_live, false);
    assert.equal(result.service_reported_live, true);
    assert.equal(result.max_age_ms, 30000);
  }
});

test('freshness boundaries and explicit age overrides are deterministic', () => {
  assert.equal(assessServiceHealth(report(60000), { now }).fresh, true);
  assert.equal(assessServiceHealth(report(60001), { now }).fresh, false);
  assert.equal(assessServiceHealth(report(30000, 'holding'), { now }).fresh, true);
  assert.equal(assessServiceHealth(report(30001, 'holding'), { now }).fresh, false);
  assert.equal(assessServiceHealth(report(20000, 'holding'), { now, maxAgeMs: 15000 }).fresh, false);
  assert.equal(assessServiceHealth(report(20000, 'holding'), { now, maxAgeMs: 30000 }).fresh, true);
});

test('malformed, unavailable, future and dry-run reports never claim verified live protection', () => {
  assert.equal(assessServiceHealth(null, { now }).status, 'unavailable');
  assert.equal(assessServiceHealth({ ...report(1000), live: 'true' }, { now }).status, 'invalid');
  assert.equal(assessServiceHealth({ ...report(1000), at: 'unknown' }, { now }).age_ms, null);
  const future = assessServiceHealth(report(-5001), { now });
  assert.equal(future.status, 'clock_error');
  assert.equal(future.live_verified, false);
  assert.equal(future.reported_live, true);
  assert.equal(assessServiceHealth(report(-5000), { now }).fresh, true);
  const dry = assessServiceHealth({ ...report(1000), live: false }, { now });
  assert.equal(dry.fresh, true);
  assert.equal(dry.live_verified, false);
});

test('health derivation copies only known operational fields', () => {
  const result = assessServiceHealth({ ...report(1000), version: '2.1.0', deadline_exceeded: true,
    access_token: 'private-value', account_number: 'private-id', message: 'sensitive diagnostic' }, { now });
  assert.equal(result.reported_version, '2.1.0');
  assert.equal(result.service_reported_version, '2.1.0');
  assert.equal(result.deadline_exceeded, true);
  assert.equal(result.service_deadline_exceeded, true);
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(JSON.stringify(result).includes('sensitive diagnostic'), false);
  const unknown = assessServiceHealth({ ...report(1000), version: 'private-value', deadline_exceeded: 'true' }, { now });
  assert.equal(unknown.reported_version, null);
  assert.equal(unknown.deadline_exceeded, null);
  assert.equal(unknown.live_verified, true);
});

test('stop diagnostics expose only safe statuses and data failure flags', () => {
  for (const stop_status of ['stop_armed', 'stop_pending', 'close_order_working',
    'stop_filled_waiting_position', 'stop_repeatedly_rejected', 'stop_unavailable_now',
    'emergency_exit', 'local_premium_watch_only', 'stop_rejected', 'stop_outcome_unknown']) {
    const result = assessServiceHealth({ ...report(1000, 'holding'), stop_status,
      data_error: 'private account-id cannot load data', stop_reject_reason: 'private account-id' }, { now });
    assert.equal(result.stop_status, stop_status);
    assert.equal(result.reported_stop_status, stop_status);
    assert.equal(result.service_stop_status, stop_status);
    assert.equal(result.service_data_unavailable, true);
    assert.equal(result.data_unavailable, true);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  const invalid = assessServiceHealth({ ...report(1000), stop_status: 'private account-id', data_error: '   ' }, { now });
  assert.equal(invalid.stop_status, null);
  assert.equal(invalid.service_stop_status, null);
  assert.equal(invalid.data_unavailable, false);
  assert.equal(assessServiceHealth(null, { now }).data_unavailable, false);
});

test('local reader derives active-state presence and distinguishes missing from malformed health', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qqq-service-health-'));
  try {
    const health = join(folder, 'health.json');
    writeFileSync(health, JSON.stringify(report(45000)));
    assert.equal(readServiceHealth(folder, { now }).fresh, true);
    writeFileSync(join(folder, 'arm.json'), '{}');
    const armed = readServiceHealth(folder, { now });
    assert.equal(armed.has_state, true);
    assert.equal(armed.fresh, false);
    writeFileSync(health, '{broken');
    assert.equal(readServiceHealth(folder, { now }).status, 'invalid');
    unlinkSync(health);
    assert.equal(readServiceHealth(folder, { now }).status, 'unavailable');
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
