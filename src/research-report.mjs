import { runtimeDirectory } from './runtime-paths.mjs';
import { dirname, resolve, join } from 'node:path';
import { existsSync,readFileSync,statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readResearchState, dueResearchFollowups, RESEARCH_NOTICE } from './research-record.mjs';
import { summarizeEdgeReport, renderEdgeResearchReport, writeEdgeResearchReport } from './edge-report.mjs';

export { writeEdgeResearchReport };

export function summarizeResearch(folder, { now = Date.now() } = {}) {
  const state = readResearchState(folder);
  const cases = Object.values(state.cases);
  const comparisonCases = cases.filter(item => item.shadow_comparison);
  const collectorPath=join(folder,'research-collector-status.json');
  let collector=null;
  if(existsSync(collectorPath)&&statSync(collectorPath).size<=1024*1024){try{const value=JSON.parse(readFileSync(collectorPath,'utf8'));
    if(value.version===1)collector={at:value.at,status:value.status,reason:value.reason,totals:value.totals??null};}catch{}}
  const endpoints = [];
  for (const item of cases) for (const [basisId, basis] of Object.entries(item.bases)) {
    for (const endpoint of Object.values(basis.horizons)) {
      const movement = endpoint.quoted_movements[item.primary_instrument_id];
      endpoints.push({ case_id: item.case_id, basis_id: basisId, horizon_minutes: endpoint.intended_minutes,
        actual_elapsed_minutes: endpoint.actual_elapsed_minutes, delay_minutes: endpoint.delay_minutes,
        quoted_bid_minus_reference_ask: movement?.bid_minus_reference_ask_per_contract ?? null });
    }
  }
  return { version: 1, as_of: new Date(now).toISOString(), recorded_events: state.recorded_events,
    total_cases_created: state.created_cases, retained_case_details: cases.length,
    prospective_option_baselines:{priced_cases:cases.filter(item=>item.bases.case?.reference_observed_at).length,
      unpriced_cases:cases.filter(item=>!item.bases.case?.reference_observed_at).length,
      later_quote_baselines:cases.filter(item=>item.baseline_selection_context).length,
      post_stop_cases:cases.filter(item=>item.baseline_selection_context?.post_stop_context).length,
      post_stop_new_completed_setups:cases.filter(item=>item.baseline_selection_context?.post_stop_context?.new_completed_setup).length},
    collector,
    bearish_signal_comparisons: { recorded_cases: comparisonCases.length,
      hold_first_confirmed: comparisonCases.filter(item => item.bases.bearish_break_hold).length,
      retouch_first_confirmed: comparisonCases.filter(item => item.bases.bearish_failed_reclaim).length,
      hold_without_retouch_observed: comparisonCases.filter(item => item.bases.bearish_break_hold && !item.bases.bearish_failed_reclaim).length },
    trail_comparisons: { one_minute_level_seen: cases.filter(item => item.trails.one_minute).length,
      five_minute_level_seen: cases.filter(item => item.trails.five_minute).length,
      one_minute_cross_sampled: cases.filter(item => item.trails.one_minute?.cross_observed_at).length,
      five_minute_cross_sampled: cases.filter(item => item.trails.five_minute?.cross_observed_at).length },
    endpoints: endpoints.slice(-50),
    missing_or_expired_endpoints: dueResearchFollowups(folder, { now }).expired,
    edge_research: summarizeEdgeReport(folder, { now, researchState: state }),
    notice: RESEARCH_NOTICE,
    limits: 'Summary retains the 200 most recent case details; all recorded evidence remains in research-journal.jsonl. Samples can miss intervening prices. Trail levels compare structural swing timing; the live profit cushion and discretionary sell gate are not assumed to activate those levels. Signal counts and quote differences are not realized P&L or proof of an edge.' };
}

export function renderResearchReport(report) {
  const signals = report.bearish_signal_comparisons;
  const trails = report.trail_comparisons;
  const rows = report.endpoints.filter(value => value.quoted_bid_minus_reference_ask !== null);
  const lines = [`Research through ${report.as_of}: ${report.recorded_events} evidence records across ${report.total_cases_created} cases.`,
    `Bearish comparisons: hold confirmed in ${signals.hold_first_confirmed} cases; retouch confirmed in ${signals.retouch_first_confirmed}; hold-only seen in ${signals.hold_without_retouch_observed}.`,
    `Trail observations: 1m level ${trails.one_minute_level_seen}, 5m level ${trails.five_minute_level_seen}; sampled crossings ${trails.one_minute_cross_sampled} and ${trails.five_minute_cross_sampled}.`,
    `Actual quoted endpoints: ${rows.length}; missing/expired baseline records listed: ${report.missing_or_expired_endpoints.length}.`];
  if(report.prospective_option_baselines)lines.push(`Cases with actual option baselines: ${report.prospective_option_baselines.priced_cases}; unpriced cases: ${report.prospective_option_baselines.unpriced_cases}.`);
  if(report.collector){const total=report.collector.totals??{};lines.push(`Read-only collector as of ${report.collector.at}: ${report.collector.status}${report.collector.reason?` (${report.collector.reason})`:''}. Collector totals: ${total.priced_cases??0} new baselines, ${total.followups??0} actual followups, ${total.gaps??0} explicit sampling gaps, ${total.failures??0} failures.`);}
  if (rows.length) {
    lines.push('Recent quote-reference movements per contract (bid minus captured ask; no fills assumed):');
    for (const row of rows.slice(-10)) lines.push(`${row.basis_id} ${row.horizon_minutes}min target, actually ${row.actual_elapsed_minutes.toFixed(2)}min: $${row.quoted_bid_minus_reference_ask.toFixed(2)}.`);
  }
  lines.push(report.notice, report.limits);
  if (report.edge_research) lines.push('', renderEdgeResearchReport(report.edge_research).trim());
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const flag = args.indexOf('--folder');
    const folder = flag >= 0 && args[flag + 1] ? runtimeDirectory(resolve(args[flag + 1])) : runtimeDirectory();
    if (args.includes('--write')) writeEdgeResearchReport(folder);
    const report = summarizeResearch(folder);
    process.stdout.write((args.includes('--json') ? JSON.stringify(report) : renderResearchReport(report)) + '\n');
  } catch (error) {
    process.stderr.write(`Research report unavailable: ${String(error.message).slice(0, 500)}\n`);
    process.exitCode = 1;
  }
}
