import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordResearch, readResearchState, dueResearchFollowups, researchSchema } from './research-record.mjs';
import { summarizeResearch, renderResearchReport } from './research-report.mjs';
import { AT, ID, iso, setup, retouch, trail, quote, followup } from './research-fixtures.mjs';

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'qqq-research-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, record(input) { const path = join(folder, 'candidate.json');
    writeFileSync(path, JSON.stringify(input));
    return recordResearch(path, { folder, now: Date.parse(input.observed_at) }); } };
}
test('recorder persists exact evidence and deduplicates the same event', t => {
  const f = fixture(t), input = setup();
  const first = f.record(input), second = f.record(input);
  assert.equal(first.status, 'recorded');
  assert.equal(second.status, 'deduplicated');
  assert.equal(readResearchState(f.folder).recorded_events, 1);
  const lines = readFileSync(join(f.folder, 'research-journal.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.selected_contract.updated_at, AT);
  assert.equal(record.selected_contract.bid_size, 40);
  assert.equal(record.selected_contract.theta, -.2);
  assert.match(record.notice, /no entry or exit fills/);
});
test('record input must be contained after resolving symlinks and bounded', t => {
  const f = fixture(t), outside = mkdtempSync(join(tmpdir(), 'qqq-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const path = join(outside, 'foreign.json'); writeFileSync(path, JSON.stringify(setup()));
  assert.throws(() => recordResearch(path, { folder: f.folder, now: Date.parse(AT) }), /inside/);
  symlinkSync(path, join(f.folder, 'escape.json'));
  assert.throws(() => recordResearch('escape.json', { folder: f.folder, now: Date.parse(AT) }), /inside/);
  writeFileSync(join(f.folder, 'too-large.json'), ' '.repeat(16385));
  assert.throws(() => recordResearch('too-large.json', { folder: f.folder, now: Date.parse(AT) }), /16 KiB/);
});
test('bearish variants receive independent first actual quotes and freeze alternatives', t => {
  const f = fixture(t), hold = f.record(setup());
  const extraId = '22222222-2222-4222-8222-222222222222';
  f.record(retouch({ selected_contract: quote('2026-10-08T18:05:02Z', ID, { bid: 2.4, ask: 2.5 }),
    alternatives: [quote('2026-10-08T18:05:02Z', extraId)] }));
  const item = readResearchState(f.folder).cases[hold.case_id];
  assert.equal(item.bases.bearish_break_hold.reference_contracts[ID].ask, 2);
  assert.equal(item.bases.bearish_failed_reclaim.reference_contracts[ID].ask, 2.5);
  assert.equal(item.bases.bearish_break_hold.reference_contracts[extraId], undefined);
  assert.equal(item.bases.bearish_failed_reclaim.reference_contracts[extraId].ask, 2);
  assert.equal(item.bases.bearish_failed_reclaim.reference_observed_at, '2026-10-08T18:05:02Z');
});
test('due endpoints keep intended windows distinct and expose gaps without later backfill', t => {
  const f = fixture(t), first = f.record(setup());
  const sevenAt = '2026-10-08T18:07:02Z';
  let due = dueResearchFollowups(f.folder, { now: Date.parse(sevenAt) });
  assert.equal(due.due[0].horizon_minutes, 5);
  assert.equal(due.due[0].actual_elapsed_minutes, 7);
  assert.deepEqual(due.instrument_ids, [ID]);
  assert.deepEqual(due.contract_metadata[ID], { instrument_id: ID, expiration: '2026-10-09', strike: 500 });
  assert.equal(Object.hasOwn(due.contract_metadata[ID], 'bid'), false);
  f.record(followup(first.case_id, sevenAt));
  const basis = readResearchState(f.folder).cases[first.case_id].bases.case;
  assert.equal(basis.horizons['5'].delay_minutes, 2);
  assert.ok(Math.abs(basis.horizons['5'].quoted_movements[ID].bid_minus_reference_ask_per_contract - 20) < 1e-8);
  const sixteenAt = '2026-10-08T18:16:02Z';
  due = dueResearchFollowups(f.folder, { now: Date.parse(sixteenAt) });
  assert.equal(due.due[0].horizon_minutes, 15);
  assert.ok(due.expired.some(value => value.basis_id === 'bearish_break_hold' && value.missed_horizons_minutes.includes(5)));
  assert.throws(() => f.record(followup(first.case_id, sixteenAt, { basis_id: 'bearish_break_hold', horizon_minutes: 5 })), /do not backfill/);
  f.record(followup(first.case_id, sixteenAt, { horizon_minutes: 15 }));
  assert.equal(readResearchState(f.folder).cases[first.case_id].bases.case.horizons['15'].actual_elapsed_minutes, 16);
  due = dueResearchFollowups(f.folder, { now: Date.parse('2026-10-08T18:46:02Z') });
  assert.equal(due.due.length, 0);
  assert.equal(due.instrument_ids.length, 0);
  assert.ok(due.expired.some(value => value.missed_horizons_minutes.includes(30)));
});
test('due planner bounds one batch to five instruments and defers additional cases', t => {
  const f = fixture(t);
  for (let i = 1; i <= 7; i++) {
    const id = `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;
    f.record(setup(AT, { selected_contract: quote(AT, id) }));
  }
  const due = dueResearchFollowups(f.folder, { now: Date.parse('2026-10-08T18:06:02Z') });
  assert.equal(due.instrument_ids.length, 5);
  assert.equal(due.due.length, 10);
  assert.equal(due.deferred_due_count, 4);
  assert.ok(due.due.every(value => value.instrument_ids.every(id => due.instrument_ids.includes(id))));
});
test('followup rejects another contract and leaves prior journal unchanged', t => {
  const f = fixture(t), first = f.record(setup());
  const at = '2026-10-08T18:06:02Z';
  assert.throws(() => f.record(followup(first.case_id, at, { selected_contract: quote(at, '22222222-2222-4222-8222-222222222222') })), /identity/);
  assert.equal(readResearchState(f.folder).recorded_events, 1);
});
test('missing future option quote is an explicit missing endpoint rather than zero return', t => {
  const f = fixture(t), first = f.record(setup());
  f.record(followup(first.case_id, '2026-10-08T18:06:02Z', { selected_contract: null }));
  const endpoint = readResearchState(f.folder).cases[first.case_id].bases.case.horizons['5'];
  assert.deepEqual(endpoint.quoted_movements, {});
  const report = summarizeResearch(f.folder, { now: Date.parse('2026-10-08T18:06:02Z') });
  assert.equal(report.endpoints[0].quoted_bid_minus_reference_ask, null);
  assert.match(renderResearchReport(report), /not realized P&L/);
});
test('unchanged swings still capture an actual later sampled cross, without assumed sell fills', t => {
  const f = fixture(t), first = f.record(trail());
  const at = '2026-10-08T18:00:06Z';
  f.record(trail({ observed_at: at, qqq_quote: { price: 499.3, last_trade_at: at },
    selected_contract: quote(at, ID, { bid: 1.8, ask: 1.9, delta: .48 }) }));
  const item = readResearchState(f.folder).cases[first.case_id];
  assert.equal(item.trails.one_minute.cross_observed_at, at);
  assert.equal(item.trails.five_minute.cross_observed_at, undefined);
  assert.equal(item.trails.one_minute.selected_option_quote_at_cross.bid, 1.8);
  assert.match(item.trails.one_minute.interpretation, /no sell order/);
  assert.equal(readResearchState(f.folder).recorded_events, 2);
});
test('summary recovers a journal append without writing duplicate evidence', t => {
  const f = fixture(t), first = f.record(setup());
  const statePath = join(f.folder, 'research-state.json');
  writeFileSync(statePath, JSON.stringify({ version: 1, recorded_events: 0, created_cases: 0, seen_event_ids: [], cases: {} }));
  const second = f.record(setup());
  assert.equal(second.case_id, first.case_id);
  assert.equal(readResearchState(f.folder).recorded_events, 1);
  assert.equal(readFileSync(join(f.folder, 'research-journal.jsonl'), 'utf8').trim().split('\n').length, 1);
});
test('schema is local, bounded and states optional research priority', () => {
  const schema = researchSchema();
  assert.equal(schema.limits.max_alternatives, 4);
  assert.equal(schema.contract_quote_template.theta, null);
  assert.ok(schema.instructions.some(value => /never block protection/.test(value)));
});
