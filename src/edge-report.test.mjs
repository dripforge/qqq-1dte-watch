import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDGE_RESEARCH_SPEC, EDGE_RESEARCH_SPEC_HASH } from './edge-comparisons.mjs';
import { readEdgeJournal, readEdgeResearchSpec, summarizeEdgeReport, renderEdgeResearchReport, writeEdgeResearchReport } from './edge-report.mjs';
import { recordResearch } from './research-record.mjs';
import { AT, setup, quote, ID } from './research-fixtures.mjs';

function fixture(t) {
  const folder = mkdtempSync(join(tmpdir(), 'qqq-edge-report-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, freeze(at = '2026-10-08T17:59:00Z', changes = {}) {
    writeFileSync(join(folder, 'edge-research-spec.json'), JSON.stringify({ version: 1, recorded_at: at,
      spec: EDGE_RESEARCH_SPEC, spec_hash: EDGE_RESEARCH_SPEC_HASH, ...changes }));
  }, record(input = setup()) {
    const path = join(folder, 'input.json'); writeFileSync(path, JSON.stringify(input));
    return recordResearch(path, { folder, now: Date.parse(input.observed_at) });
  } };
}
test('missing or changed frozen specification never labels evidence prospective', t => {
  const f = fixture(t); f.record();
  let report = summarizeEdgeReport(f.folder, { now: Date.parse(AT) });
  assert.equal(report.specification.status, 'unverified');
  assert.equal(report.sample_units.prospective_cases, 0);
  f.freeze(undefined, { spec_hash: 'bad' });
  report = summarizeEdgeReport(f.folder, { now: Date.parse(AT) });
  assert.equal(report.specification.reason, 'spec_hash_mismatch');
  assert.equal(report.sample_units.prospective_cases, 0);
  f.freeze(undefined, { spec: { ...EDGE_RESEARCH_SPEC, quote_path_interval_seconds: 1 } });
  assert.equal(readEdgeResearchSpec(f.folder, { now: Date.parse(AT) }).reason, 'spec_hash_mismatch');
  f.freeze();
  assert.equal(summarizeEdgeReport(f.folder, { now: Date.parse(AT) }).sample_units.prospective_cases, 1);
  f.freeze('2026-10-08T18:01:00Z');
  assert.equal(readEdgeResearchSpec(f.folder, { now: Date.parse(AT) }).reason, 'invalid_freeze_record');
});
test('small overlapping sample and missing option prices are reported without invented outcomes', t => {
  const f = fixture(t); f.freeze(); f.record(setup(AT, { selected_contract: null, alternatives: [] }));
  const report = summarizeEdgeReport(f.folder, { now: Date.parse(AT) + 180000 });
  assert.equal(report.sample_units.prospective_cases, 1);
  assert.equal(report.sample_units.market_episodes, 1);
  assert.equal(report.sample_units.sessions, 1);
  assert.deepEqual(report.short_horizons.horizons.map(value => value.captured_quote_comparisons), [0, 0, 0]);
  assert.equal(report.quote_comparisons.length, 0);
  assert.equal(report.actual_fills.length, 0);
  assert.match(renderEdgeResearchReport(report), /No statistical edge/);
  assert.match(renderEdgeResearchReport(report), /No actual closed fills/);
  assert.equal(report.context.cases_without_context, 1);
});
test('actual scalp endpoint and coverage use comparison APIs and current time', t => {
  const f = fixture(t); f.freeze(); const first = f.record();
  const at = new Date(Date.parse(AT) + 30000).toISOString();
  f.record({ version: 1, source: 'robinhood_trading_mcp', event_kind: 'scalp_observation',
    observed_at: at, case_id: first.case_id, basis_id: 'case', direction: 'put', trade_id: null,
    qqq_quote: { price: 499, last_trade_at: at }, selected_contract: quote(at, ID, { bid: 2.2, ask: 2.3 }),
    alternatives: [], horizon_seconds: 30 });
  const report = summarizeEdgeReport(f.folder, { now: Date.parse(AT) + 180000 });
  const endpoint = report.quote_comparisons.find(value => value.intended_seconds === 30);
  assert.ok(Math.abs(endpoint.quote_bid_minus_reference_ask_per_contract - 20) < 1e-6);
  assert.equal(endpoint.execution_basis, 'actual_quote_ask_to_bid_only_no_assumed_fills');
  assert.equal(endpoint.fees, null); assert.equal(endpoint.net_pnl, null);
  const path = report.scalp_paths.find(value => value.basis_id === 'case');
  assert.equal(path.coverage.window_complete, true);
  assert.deepEqual(path.coverage.missing_horizons_seconds, [60, 120]);
  assert.equal(report.short_horizons.horizons[0].captured_quote_comparisons, 1);
});
test('bounded journal records omissions and first case context without replacing it later', t => {
  const f = fixture(t); f.freeze(); const first = f.record();
  const journal = [
    { event: 'candidate_capture', case_id: first.case_id, observed_at: AT, market_context: { vwap: 'above' } },
    { event: 'candidate_capture', case_id: first.case_id, observed_at: new Date(Date.parse(AT) + 10000).toISOString(), market_context: { vwap: 'below' } },
    { event: 'trade_closed', trade_id: 'actual', option_id: ID, realized_pnl: -16, pnl_basis: 'broker_reported', closed_at: AT,
      historical_backfill: true, source: 'Robinhood verified filled orders and realized P&L' },
  ];
  writeFileSync(join(f.folder, 'journal.jsonl'), journal.map(value => JSON.stringify(value)).join('\n') + '\ninvalid\n');
  const report = summarizeEdgeReport(f.folder, { now: Date.parse(AT) + 180000 });
  assert.equal(report.journal_coverage.malformed_lines, 1);
  assert.equal(report.context.cases[0].market_context.vwap, 'above');
  assert.equal(report.actual_fills[0].gross_realized_pnl, null);
  assert.equal(report.actual_fills[0].net_realized_pnl, null);
  assert.equal(report.broker_reported_results[0].realized_pnl, -16);
  const bounded = readEdgeJournal(f.folder, { maxBytes: 80 });
  assert.equal(bounded.coverage.truncated, true);
  assert.equal(bounded.coverage.discarded_partial_first_line, true);
  assert.equal(bounded.coverage.bytes_read, 80);
});
test('report writer saves readable JSON and Markdown without changing research or trading files', t => {
  const f = fixture(t); f.freeze(); f.record();
  const before = readFileSync(join(f.folder, 'research-state.json'), 'utf8');
  const written = writeEdgeResearchReport(f.folder, { now: Date.parse(AT) + 180000 });
  assert.equal(written.status, 'written');
  assert.equal(JSON.parse(readFileSync(written.json_path, 'utf8')).specification.status, 'verified');
  assert.match(readFileSync(written.markdown_path, 'utf8'), /# QQQ prospective edge research/);
  assert.equal(readFileSync(join(f.folder, 'research-state.json'), 'utf8'), before);
});
