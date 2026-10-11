import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateWatchRun, recordWatchRun } from './record-run.mjs';
import { validateApprovedRiskPolicy } from './approved-risk-policy.mjs';

const now = Date.parse('2026-10-08T17:37:04Z');
const base = { version: 1, observed_at: new Date(now).toISOString(), outcome: 'no_setup',
  reason: 'The completed five-minute break has no later confirmation.', qqq_price: 745.66,
  five_minute_at: '2026-10-08T17:30:00Z', one_minute_at: '2026-10-08T17:36:00Z', positions_open: 0, orders_working: 0 };
const approvedPolicy = { schema_version: 1, policy_id: 'qqq-1dte-risk', revision: 1,
  approved: true, recorded_at: '2026-10-08T17:00:00Z', per_trade_risk_fraction: 0.70,
  daily_loss_fraction: 0.50, absolute_daily_loss: 250, emergency_stop_fraction: 0.25,
  execution_cushion: 1, opening_premium_ceiling: 500 };

test('discretionary room skips remain distinguishable from missing structure and invalid labels fail', () => {
  const result = validateWatchRun({ ...base, outcome: 'entry_blocked', decision_stage: 'room',
    reason: 'Discretionary room rejection; completed structure exists; no broker gate was attempted.' }, now);
  assert.equal(result.decision_stage, 'room');
  assert.throws(() => validateWatchRun({ ...base, decision_stage: 'secret arbitrary field' }, now), /Decision stage/);
  assert.equal(validateWatchRun(base, now).decision_stage, undefined);
});

for (const outcome of ['no_setup', 'entry_blocked', 'entry_submitted', 'holding', 'profit_action']) {
  test(`${outcome} requires actual known price, completed bars and counts`, () => {
    const valid = { ...base, outcome, positions_open: ['holding', 'profit_action'].includes(outcome) ? 1 : 0,
      orders_working: outcome === 'entry_submitted' ? 1 : 0 };
    assert.equal(validateWatchRun(valid, now).outcome, outcome);
    for (const key of ['qqq_price', 'five_minute_at', 'one_minute_at', 'positions_open', 'orders_working']) {
      assert.throws(() => validateWatchRun({ ...valid, [key]: null }, now), /require|known/);
    }
  });
}

test('active conclusions reject stale and forming bars even with a fresh report timestamp', () => {
  assert.throws(() => validateWatchRun({ ...base, one_minute_at: '2026-10-08T17:37:00Z' }, now), /forming/);
  assert.throws(() => validateWatchRun({ ...base, five_minute_at: '2026-10-08T17:35:00Z' }, now), /forming/);
  assert.throws(() => validateWatchRun({ ...base, one_minute_at: '2026-10-08T17:34:00Z' }, now), /stale/);
  assert.throws(() => validateWatchRun({ ...base, five_minute_at: '2026-10-08T17:20:00Z' }, now), /stale/);
  assert.throws(() => validateWatchRun({ ...base, one_minute_at: '2026-10-08T17:35:45Z' }, now), /boundary/);
  assert.throws(() => validateWatchRun({ ...base, observed_at: '2026-10-08T17:37:00Z' }, now), /just-completing/);
});

test('closed-market and failed checks preserve honest unknowns and reject fabricated counts', () => {
  for (const outcome of ['market_closed', 'data_unavailable', 'error']) {
    const unknown = { ...base, outcome, qqq_price: null, five_minute_at: null, one_minute_at: null, positions_open: null, orders_working: null };
    assert.equal(validateWatchRun(unknown, now).positions_open, null);
    assert.throws(() => validateWatchRun({ ...unknown, positions_open: -1 }, now), /known/);
  }
  assert.throws(() => validateWatchRun({ ...base, observed_at: new Date(now - 120001).toISOString() }, now), /stale/);
  assert.throws(() => validateWatchRun({ ...base, observed_at: new Date(now + 5001).toISOString() }, now), /future/);
  assert.throws(() => validateWatchRun({ ...base, account_number: 'private' }, now), /forbidden/);
});

test('recorder persists derived stale health rather than copying its old live flag', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qqq-watch-status-'));
  const outside = mkdtempSync(join(tmpdir(), 'qqq-watch-outside-'));
  try {
    writeFileSync(join(folder, 'policy.json'), JSON.stringify(approvedPolicy));
    writeFileSync(join(folder, 'health.json'), JSON.stringify({ at: new Date(now - 45000).toISOString(), status: 'holding', live: true }));
    writeFileSync(join(folder, 'arm.json'), '{}');
    writeFileSync(join(folder, 'candidate.json'), JSON.stringify({ ...base, outcome: 'holding', positions_open: 1 }));
    const record = recordWatchRun('candidate.json', { folder, now });
    assert.equal(record.service_live, false);
    assert.equal(record.service_reported_live, true);
    assert.equal(record.service_status, 'stale');
    assert.equal(record.service_fresh, false);
    assert.equal(record.service_age_ms, 45000);
    assert.equal(record.service_max_age_ms, 30000);
    assert.equal(record.service_has_state, true);
    assert.equal(record.policy_status, 'approved');
    assert.deepEqual(record.policy_snapshot_at_record, validateApprovedRiskPolicy(approvedPolicy).snapshot);
    const persisted = JSON.parse(readFileSync(join(folder, 'watch-status.json'), 'utf8'));
    assert.equal(persisted.service_live, false);
    const event = JSON.parse(readFileSync(join(folder, 'journal.jsonl'), 'utf8'));
    assert.equal(event.event, 'watch_run');
    assert.equal(event.service_status, 'stale');
    assert.deepEqual(event.policy_snapshot_at_record, record.policy_snapshot_at_record);
    assert.equal(existsSync(join(folder, 'watch-status.lock')), false);
    writeFileSync(join(folder, 'candidate.json'), JSON.stringify({ ...base, observed_at: new Date(now - 1000).toISOString() }));
    assert.throws(() => recordWatchRun('candidate.json', { folder, now }), /newer/);
    writeFileSync(join(outside, 'candidate.json'), JSON.stringify(base));
    symlinkSync(join(outside, 'candidate.json'), join(folder, 'escape.json'));
    assert.throws(() => recordWatchRun('escape.json', { folder, now }), /inside/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('failed policy verification permits honest failure reports and blocks active conclusions', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qqq-watch-policy-'));
  const candidate = join(folder, 'candidate.json');
  try {
    for (const rawPolicy of [null, '{broken', JSON.stringify({ ...approvedPolicy, approved: false })]) {
      if (rawPolicy !== null) writeFileSync(join(folder, 'policy.json'), rawPolicy);
      for (const outcome of ['no_setup', 'entry_blocked', 'entry_submitted', 'holding', 'profit_action']) {
        writeFileSync(candidate, JSON.stringify({ ...base, outcome }));
        assert.throws(() => recordWatchRun('candidate.json', { folder, now }), /valid locally approved risk policy/);
        assert.equal(existsSync(join(folder, 'watch-status.lock')), false);
      }
      writeFileSync(candidate, JSON.stringify({ ...base, outcome: 'error', reason: 'Risk policy verification failed.',
        qqq_price: null, five_minute_at: null, one_minute_at: null, positions_open: null, orders_working: null }));
      const record = recordWatchRun('candidate.json', { folder, now });
      assert.equal(record.policy_snapshot_at_record, null);
      assert.equal(record.policy_status, 'unavailable');
    }
    writeFileSync(join(folder, 'policy.json'), JSON.stringify({ ...approvedPolicy, revision: 2 }));
    writeFileSync(candidate, JSON.stringify(base));
    const recovered = recordWatchRun('candidate.json', { folder, now });
    assert.equal(recovered.policy_snapshot_at_record.revision, 2);
    assert.equal(recovered.policy_status, 'approved');
    assert.throws(() => validateWatchRun({ ...base, policy_snapshot_at_record: recovered.policy_snapshot_at_record }, now), /forbidden/);
    assert.throws(() => validateWatchRun({ ...base, policy_status: 'approved' }, now), /forbidden/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
