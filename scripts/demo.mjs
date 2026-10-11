import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSetups } from '../src/setup-scan.mjs';
import { VERSION } from '../src/version.mjs';
import { evaluateOfflineCheck } from '../src/offline-check.mjs';
import { writeDecisionAudit, renderAuditReport } from '../src/decision-audit.mjs';
import { syntheticSetup, syntheticResearch, syntheticChecks, DEMO_NOW } from '../examples/synthetic-session.mjs';

export function buildDemo(folder=resolve('artifacts/demo')) {
  mkdirSync(folder,{recursive:true});
  const scan=scanSetups(syntheticSetup());
  const qualified=scan.candidates.some(c=>c.qualified);
  const journal=syntheticChecks(VERSION).map(input=>evaluateOfflineCheck(input,{folder}));
  writeFileSync(join(folder,'journal.jsonl'),journal.map(r=>JSON.stringify(r)).join('\n')+'\n');
  writeFileSync(join(folder,'research-state.json'),JSON.stringify(syntheticResearch(),null,2)+'\n');
  writeFileSync(join(folder,'scan.json'),JSON.stringify(scan,null,2)+'\n');
  const result=writeDecisionAudit(folder,{now:DEMO_NOW,synthetic:true});
  const report=JSON.parse(readFileSync(join(folder,'decision-audit-latest.json'),'utf8'));
  report.synthetic=true;
  writeFileSync(join(folder,'decision-audit-latest.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(folder,'decision-audit.html'),renderAuditReport(report));
  return {...result,synthetic:true,broker_calls:0,application_version:VERSION,qualified_setup:qualified,folder};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=buildDemo();
  console.log(`QQQ 1DTE Watch v${VERSION} · synthetic offline demo · no credentials or network calls`);
  console.log(`Setup qualified: ${result.qualified_setup} · decision minutes: ${result.decisions} · quote scenarios: ${result.replay_rows}`);
  console.log(`Report: ${join(result.folder,'decision-audit.html')}`);
  console.log('View it with npm run demo:serve → http://127.0.0.1:4173');
  if(!result.qualified_setup)process.exitCode=1;
}
