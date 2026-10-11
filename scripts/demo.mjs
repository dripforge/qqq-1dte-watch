import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSetups } from '../src/setup-scan.mjs';
import { AUDIT_STAGES } from '../src/audit-record.mjs';
import { writeDecisionAudit, renderAuditReport } from '../src/decision-audit.mjs';
import { syntheticSetup, syntheticResearch, DEMO_NOW } from '../examples/synthetic-session.mjs';

export function buildDemo(folder=resolve('artifacts/demo')) {
  mkdirSync(folder,{recursive:true});
  const scan=scanSetups(syntheticSetup());
  const qualified=scan.candidates.some(c=>c.qualified);
  const explanations=[
    ['no_setup','structure','Synthetic example: five-minute confirmation is still forming.'],
    ['entry_blocked','follow_through','Synthetic example: the latest completed minute has no directional follow-through.'],
    ['entry_blocked','risk','Synthetic example: planned stop risk exceeds the illustrative account budget.'],
    ['demo_candidate','entry',qualified?'Synthetic setup validated; demonstration ends without broker access.':'Synthetic setup did not qualify; inspect scan.json.'],
  ];
  const journal=explanations.map(([outcome,stage,reason],i)=>{
    const observed_at=new Date(DEMO_NOW-(3-i)*60000).toISOString();
    return {event:'watch_run',observed_at,recorded_at:observed_at,outcome,decision_stage:stage,reason,
      qqq_price:500.56,service_status:'offline_demo',service_fresh:null,
      audit:{facts:{},checks:Object.fromEntries(AUDIT_STAGES.map(name=>[name,{
        status:name===stage?'not_evaluated':'unavailable',reason:'Illustrative record; this stage was not measured by the demo.'
      }]))}};
  });
  writeFileSync(join(folder,'journal.jsonl'),journal.map(r=>JSON.stringify(r)).join('\n')+'\n');
  writeFileSync(join(folder,'research-state.json'),JSON.stringify(syntheticResearch(),null,2)+'\n');
  writeFileSync(join(folder,'scan.json'),JSON.stringify(scan,null,2)+'\n');
  const result=writeDecisionAudit(folder,{now:DEMO_NOW});
  const report=JSON.parse(readFileSync(join(folder,'decision-audit-latest.json'),'utf8'));
  report.synthetic=true;
  writeFileSync(join(folder,'decision-audit-latest.json'),JSON.stringify(report,null,2)+'\n');
  writeFileSync(join(folder,'decision-audit.html'),renderAuditReport(report));
  return {...result,synthetic:true,broker_calls:0,qualified_setup:qualified,folder};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=buildDemo();
  console.log('Synthetic offline demo · no credentials or network calls');
  console.log(`Setup qualified: ${result.qualified_setup} · decision minutes: ${result.decisions} · quote scenarios: ${result.replay_rows}`);
  console.log(`Report: ${join(result.folder,'decision-audit.html')}`);
  console.log('View it with npm run demo:serve → http://127.0.0.1:4173');
  if(!result.qualified_setup)process.exitCode=1;
}
