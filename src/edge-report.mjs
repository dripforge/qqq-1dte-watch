import { createHash } from 'node:crypto';
import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readResearchState } from './research-record.mjs';
import { EDGE_RESEARCH_SPEC_HASH, summarizeEdgeResearch } from './edge-comparisons.mjs';
import { RESEARCH_CANDLE_NOTICE } from './research-candle-quality.mjs';

export const EDGE_REPORT_LIMITS = Object.freeze({ journal_bytes: 8 * 1024 * 1024, metadata_bytes: 1024 * 1024 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// Read the bounded tail independently of the live trading journal reader. A
// partial first line is discarded and every omission is reported explicitly.
export function readEdgeJournal(folder, { maxBytes = EDGE_REPORT_LIMITS.journal_bytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > EDGE_REPORT_LIMITS.journal_bytes) throw Error('Invalid journal report bound');
  const path = join(folder, 'journal.jsonl');
  const coverage = { available: false, bytes_on_disk: 0, bytes_read: 0, truncated: false,
    discarded_partial_first_line: false, malformed_lines: 0, records_read: 0, earliest_record_at: null, latest_record_at: null };
  if (!existsSync(path)) return { records: [], coverage };
  const fileSize = statSync(path).size, start = Math.max(0, fileSize - maxBytes);
  const descriptor = openSync(path, 'r');
  let bytesRead, buffer;
  try { buffer = Buffer.alloc(fileSize - start); bytesRead = readSync(descriptor, buffer, 0, buffer.length, start); }
  finally { closeSync(descriptor); }
  let text = buffer.subarray(0, bytesRead).toString('utf8');
  Object.assign(coverage, { available: true, bytes_on_disk: fileSize, bytes_read: bytesRead, truncated: start > 0 });
  if (start > 0) {
    const firstNewline = text.indexOf('\n');
    text = firstNewline < 0 ? '' : text.slice(firstNewline + 1);
    coverage.discarded_partial_first_line = true;
  }
  const records = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.event !== 'string') throw Error('invalid journal record');
      records.push(value);
    } catch { coverage.malformed_lines++; }
  }
  coverage.records_read = records.length;
  const observed = records.map(record => record.observed_at ?? record.at).filter(value => timestamp(value) !== null).sort();
  coverage.earliest_record_at = observed.at(0) ?? null;
  coverage.latest_record_at = observed.at(-1) ?? null;
  return { records, coverage };
}

function boundedMetadata(folder, name) {
  const path = join(folder, name);
  if (!existsSync(path)) return { value: null, reason: 'missing' };
  if (statSync(path).size > EDGE_REPORT_LIMITS.metadata_bytes) return { value: null, reason: 'exceeds_report_bound' };
  try { return { value: JSON.parse(readFileSync(path, 'utf8')), reason: null }; }
  catch { return { value: null, reason: 'invalid_json' }; }
}

export function readEdgeResearchSpec(folder, { now = Date.now() } = {}) {
  const result = boundedMetadata(folder, 'edge-research-spec.json');
  const unavailable = reason => ({ status: 'unverified', recorded_at: null, spec_hash: null, reason,
    interpretation: 'No valid prior specification freeze is available. All observations are exploratory.' });
  if (!result.value) return unavailable(result.reason);
  const value = result.value, spec = value.spec ?? value.research_spec, declared = value.spec_hash ?? value.research_spec_hash;
  const recordedAt = timestamp(value.recorded_at), calculated = spec && typeof spec === 'object'
    ? createHash('sha256').update(JSON.stringify(spec)).digest('hex') : null;
  if (value.version !== 1 || recordedAt === null || recordedAt > now) return unavailable('invalid_freeze_record');
  if (declared !== EDGE_RESEARCH_SPEC_HASH || calculated !== EDGE_RESEARCH_SPEC_HASH) return unavailable('spec_hash_mismatch');
  return { status: 'verified', recorded_at: new Date(recordedAt).toISOString(), spec_hash: calculated, reason: null,
    interpretation: 'Only cases first observed after this fixed specification was recorded are prospective.' };
}

function provenance(cases) {
  const intervals = { one_minute: { cases_usable: 0, cases_unusable: 0, cases_unknown: 0,
    explicit_non_interpolated_bar_observations: 0, inferred_positive_volume_bar_observations: 0 },
  five_minute: { cases_usable: 0, cases_unusable: 0, cases_unknown: 0,
    explicit_non_interpolated_bar_observations: 0, inferred_positive_volume_bar_observations: 0 } };
  for (const item of cases) for (const [name, count] of Object.entries(intervals)) {
    const quality = item.candle_quality?.[name];
    count[quality?.usable === true ? 'cases_usable' : quality?.usable === false ? 'cases_unusable' : 'cases_unknown']++;
    if (Number.isSafeInteger(quality?.explicit_non_interpolated_bars)) count.explicit_non_interpolated_bar_observations += quality.explicit_non_interpolated_bars;
    if (Number.isSafeInteger(quality?.inferred_positive_volume_bars)) count.inferred_positive_volume_bar_observations += quality.inferred_positive_volume_bars;
  }
  return { intervals, notice: RESEARCH_CANDLE_NOTICE,
    interpretation: 'Counts describe retained case evidence and may count the same broker candle more than once. Missing flags are never rewritten as false; legacy cases without quality records remain unknown.' };
}

function collectContext(cases, journal, folder) {
  const contexts = new Map();
  for (const record of journal) {
    if (!['candidate_capture', 'early_break_capture'].includes(record.event) || !record.case_id || !record.market_context || typeof record.market_context !== 'object') continue;
    // Use the first recorded context for the case; later observations cannot
    // silently replace the environment that was observable when it began.
    if (!contexts.has(record.case_id)) contexts.set(record.case_id, {
      case_id: record.case_id, observed_at: record.observed_at ?? record.at ?? null,
      source_event: record.event, market_context: record.market_context });
  }
  const rows = cases.map(item => contexts.get(item.case_id) ?? { case_id: item.case_id, observed_at: null,
    source_event: null, market_context: null });
  const latest = boundedMetadata(folder, 'market-context-latest.json');
  const history = boundedMetadata(folder, 'market-context-history.json');
  return { research_only: true, live_filter: false, cases_with_context: rows.filter(row => row.market_context).length,
    cases_without_context: rows.filter(row => !row.market_context).length, cases: rows,
    latest: latest.value, latest_status: latest.reason ?? 'available',
    historical_sessions_cached: history.value?.version === 1 && history.value.sessions && typeof history.value.sessions === 'object'
      ? Object.keys(history.value.sessions).length : 0,
    history_status: history.reason ?? 'available',
    interpretation: 'Context consists of observed research tags only. Missing legacy tags are not reconstructed. OHLC-volume VWAP estimates are not tick-level broker VWAP; relative volume remains unknown until matching prior sessions are available.' };
}

export function summarizeEdgeReport(folder, { now = Date.now(), researchState = null } = {}) {
  if (!Number.isFinite(now)) throw Error('Invalid report observation time');
  const state = researchState ?? readResearchState(folder), cases = Object.values(state.cases ?? {});
  const { records: journal, coverage } = readEdgeJournal(folder);
  const specification = readEdgeResearchSpec(folder, { now });
  const context = collectContext(cases, journal, folder);
  const report = summarizeEdgeResearch({ researchState: state, journal, context,
    specRecordedAt: specification.recorded_at, now });
  const horizons = [30, 60, 120].map(seconds => ({ intended_seconds: seconds,
    captured_quote_comparisons: report.quote_comparisons.filter(row => row.intended_seconds === seconds).length }));
  const expected = cases.reduce((sum, item) => sum + Object.values(item.bases ?? {}).filter(basis => basis.reference_observed_at).length, 0);
  return { ...report, specification, journal_coverage: coverage, candle_provenance: provenance(cases),
    short_horizons: { horizons, actual_baseline_bases: expected,
      interpretation: 'Each contract endpoint is an actual quote comparison, not an independent trade. Missing prices remain missing.' },
    broker_reported_results: journal.filter(record => record.event === 'trade_closed' && finite(record.realized_pnl)).map(record => ({
      trade_id: record.trade_id ?? null, realized_pnl: record.realized_pnl, pnl_basis: record.pnl_basis ?? 'unknown',
      interpretation: 'Reported amount and basis are preserved; this amount is not relabeled gross or fee-inclusive net.' })),
    evidence_scope: { recorded_events: state.recorded_events, total_cases_created: state.created_cases,
      retained_case_limit: 200, journal_tail_byte_limit: EDGE_REPORT_LIMITS.journal_bytes,
      interpretation: 'Case details are bounded to the most recent 200 cases. Actual fill/replay and context rows use the journal tail described above; missing earlier records can make results unavailable.' } };
}

const money = value => finite(value) ? `$${value.toFixed(2)}` : 'unknown';
export function renderEdgeResearchReport(report) {
  const units = report.sample_units;
  const lines = ['# QQQ prospective edge research', '', `Updated ${report.as_of}.`, '',
    `Specification: ${report.specification.status}${report.specification.recorded_at ? `; frozen ${report.specification.recorded_at}` : ` (${report.specification.reason})`}.`, '',
    `Retained evidence: ${units.retained_cases} cases, grouped into ${units.market_episodes} market episodes across ${units.sessions} sessions.`,
    `Prospective evidence after the freeze: ${units.prospective_cases} cases, ${units.prospective_market_episodes} episodes and ${units.prospective_sessions} sessions. Earlier observations are exploratory.`, '',
    '## Fast scalp observations', '',
    'Actual baseline ask is compared with later captured bids. These prices are quotes; no entry or sell fill is assumed.', '',
    '| Target | Captured contract quote comparisons |', '| --- | ---: |',
    ...report.short_horizons.horizons.map(row => `| ${row.intended_seconds} seconds | ${row.captured_quote_comparisons} |`), '',
    `${report.scalp_paths.length} sampled contract paths. A path targets quotes about every 10 seconds during its first two minutes; missing intervals can conceal highs, lows or exit triggers.`];
  if (report.scalp_paths.length) {
    lines.push('', '| Case / basis | Samples | Grid coverage | Largest observed gap | Missing targets |', '| --- | ---: | ---: | --- | --- |');
    for (const row of report.scalp_paths.slice(-10)) {
      const coverage = row.coverage;
      lines.push(`| ${row.case_id.slice(0, 10)} / ${row.basis_id} | ${coverage?.sample_count ?? 'unknown'} | ${finite(coverage?.grid_coverage_fraction) ? `${(coverage.grid_coverage_fraction * 100).toFixed(0)}%` : 'unknown'} | ${finite(coverage?.max_observed_gap_seconds) ? `${coverage.max_observed_gap_seconds.toFixed(1)}s` : 'unknown'} | ${coverage?.missing_horizons_seconds?.join(', ') || 'none recorded missing'} |`);
    }
  }
  const recentQuotes = report.quote_comparisons.filter(row => [30, 60, 120].includes(row.intended_seconds)).slice(-10);
  if (recentQuotes.length) {
    lines.push('', 'Recent actual short-horizon quotes (per contract; fees and execution slippage unknown):', '',
      '| Case / basis | Target / actual elapsed | Baseline delay | Bid minus captured ask | Evidence |',
      '| --- | --- | --- | ---: | --- |');
    for (const row of recentQuotes) lines.push(`| ${String(row.case_id).slice(0, 10)} / ${row.basis_id} | ${row.intended_seconds}s / ${finite(row.actual_elapsed_seconds) ? `${row.actual_elapsed_seconds.toFixed(1)}s` : 'unknown'} | ${finite(row.baseline_delay_seconds) ? `${row.baseline_delay_seconds.toFixed(1)}s` : 'unknown'} | ${money(row.quote_bid_minus_reference_ask_per_contract)} | ${row.evidence_cohort === 'prospective_after_spec_freeze' ? 'prospective' : 'exploratory'} |`);
  }
  const pairs = report.prospective_entry_pairs.filter(pair => pair.early_shadow_cases.length && pair.completed_setup_cases.length);
  lines.push('', '## Entry and exit comparisons', '',
    `Early-break versus completed hold/retest: ${pairs.length} prospective paired episodes; ${pairs.filter(pair => pair.same_instrument_comparable).length} have the same contract available for comparison.`,
    `Entry eligibility: ${report.entry_gate_counts.qualified} qualified, ${report.entry_gate_counts.blocked} blocked, ${report.entry_gate_counts.unknown} unknown. A research signal does not establish permission to trade.`,
    `Scalp versus trend: ${report.actual_entry_profit_mode_replays.filter(row => row.status === 'evaluated').length} actual-entry replays evaluated; ${report.actual_entry_profit_mode_replays.filter(row => row.status !== 'evaluated').length} unavailable. Alternate triggers have no assumed sell fills. Quotes after an actual closure do not imply the position remained open.`, '',
    '## Actual trading results', '');
  if (!report.actual_fills.length) lines.push('No actual closed fills appear in the available journal.');
  else {
    lines.push('| Trade | Verified fills | Gross realized P&L | Entry / exit fees | Net after known fees |', '| --- | --- | ---: | --- | ---: |');
    for (const row of report.actual_fills.slice(-10)) lines.push(`| ${String(row.trade_id ?? 'unknown').slice(0, 12)} | ${row.verified_fills ? 'yes' : 'unverified'} | ${money(row.gross_realized_pnl)} | ${money(row.entry_fees)} / ${money(row.exit_fees)} | ${money(row.net_realized_pnl)} |`);
  }
  for (const row of report.broker_reported_results.slice(-10)) lines.push(`Recorded realized result: ${money(row.realized_pnl)} (${row.pnl_basis}). Preserved as reported; unknown fees are not guessed.`);
  lines.push('', '## Candle provenance and market context', '', report.candle_provenance.notice,
    `1-minute retained cases: ${report.candle_provenance.intervals.one_minute.cases_usable} usable, ${report.candle_provenance.intervals.one_minute.cases_unusable} unusable, ${report.candle_provenance.intervals.one_minute.cases_unknown} unknown.`,
    `5-minute retained cases: ${report.candle_provenance.intervals.five_minute.cases_usable} usable, ${report.candle_provenance.intervals.five_minute.cases_unusable} unusable, ${report.candle_provenance.intervals.five_minute.cases_unknown} unknown.`,
    `Bar observations using explicit broker flags: ${report.candle_provenance.intervals.one_minute.explicit_non_interpolated_bar_observations} at 1 minute and ${report.candle_provenance.intervals.five_minute.explicit_non_interpolated_bar_observations} at 5 minutes. Positive-volume inference: ${report.candle_provenance.intervals.one_minute.inferred_positive_volume_bar_observations} and ${report.candle_provenance.intervals.five_minute.inferred_positive_volume_bar_observations}. These counts can repeat the same bar across cases.`,
    `Market-context tags: ${report.context.cases_with_context} cases tagged; ${report.context.cases_without_context} without tags. Prior sessions cached: ${report.context.historical_sessions_cached}.`,
    report.context.interpretation);
  const recentContexts = report.context.cases.filter(row => row.market_context).slice(-10);
  if (recentContexts.length) {
    lines.push('', '| Case | Time of day | Completed 15m trend | VWAP position / 5m slope | Relative volume | Room to next obstacle |',
      '| --- | --- | --- | --- | --- | --- |');
    for (const row of recentContexts) {
      const tags = row.market_context;
      lines.push(`| ${String(row.case_id).slice(0, 10)} | ${tags.time_of_day?.bucket ?? (typeof tags.time_of_day === 'string' ? tags.time_of_day : 'unknown')} | ${tags.trend_15m?.status ?? 'unknown'} | ${tags.vwap?.position ?? 'unknown'} / ${finite(tags.vwap?.slope_5m) ? tags.vwap.slope_5m.toFixed(4) : 'unknown'} | ${finite(tags.relative_volume?.ratio) ? `${tags.relative_volume.ratio.toFixed(2)}x (${tags.relative_volume.sessions_used} days)` : 'unknown'} | ${finite(tags.room_to_obstacle) ? `$${tags.room_to_obstacle.toFixed(2)} in QQQ` : 'unknown'} |`);
    }
  }
  lines.push('', '## Evidence limits', '',
    `Journal tail: ${report.journal_coverage.records_read} records; ${report.journal_coverage.truncated ? 'earlier bytes omitted at the 8 MiB bound' : 'not truncated'}; ${report.journal_coverage.malformed_lines} malformed lines omitted.`,
    report.evidence_scope.interpretation, '', ...report.limitations.map(value => `- ${value}`));
  return lines.join('\n') + '\n';
}

function atomicReport(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, path);
}
export function writeEdgeResearchReport(folder, { now = Date.now() } = {}) {
  const report = summarizeEdgeReport(folder, { now });
  const jsonPath = join(folder, 'edge-research-latest.json'), markdownPath = join(folder, 'edge-research-report.md');
  atomicReport(jsonPath, JSON.stringify(report, null, 2) + '\n');
  atomicReport(markdownPath, renderEdgeResearchReport(report));
  return { version: 1, at: report.as_of, status: 'written', json_path: jsonPath, markdown_path: markdownPath,
    sample_units: report.sample_units, specification_status: report.specification.status };
}
