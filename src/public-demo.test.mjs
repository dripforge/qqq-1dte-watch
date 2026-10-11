import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDemo } from '../scripts/demo.mjs';
import { scanSetups } from './setup-scan.mjs';
import { syntheticSetup } from '../examples/synthetic-session.mjs';
import { parseHalts,haltContext } from './halt-context.mjs';
import { parseFed } from './event-context.mjs';

test('offline demo exercises setup discovery and all three replay outcomes',t=>{
  const folder=mkdtempSync(join(tmpdir(),'qqq-public-demo-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const result=buildDemo(folder);assert.equal(result.qualified_setup,true);assert.equal(result.decisions,4);
  const report=JSON.parse(readFileSync(join(folder,'decision-audit-latest.json'),'utf8'));
  assert.equal(report.synthetic,true);assert.equal(report.replay.rows.length,9);
  const statuses=new Set(report.replay.rows.map(r=>r.status));
  for(const status of ['quote_scenario','unavailable','not_marketable_at_sample'])assert.ok(statuses.has(status),status);
  assert.equal(existsSync(join(folder,'arm.json')),false);
  assert.match(readFileSync(join(folder,'decision-audit.html'),'utf8'),/SYNTHETIC DEMO/);
});
test('synthetic scanner preserves missing and stale input as unavailable',()=>{
  const input=syntheticSetup();
  assert.equal(scanSetups({...input,fiveMinuteBars:[]}).status,'data_unavailable');
  assert.equal(scanSetups({...input,now:new Date(input.now.getTime()+3600000)}).status,'data_unavailable');
  assert.ok(scanSetups(input).candidates.every(c=>c.requires_fresh_entry_gate));
});
test('synthetic halt feed rejects missing items and expires stale information',()=>{
  const xml='<rss version="2.0"><channel><title>NASDAQ Trade Halts</title><pubDate>Thu, 08 Oct 2026 16:00:00 GMT</pubDate><ndaq:numItems>1</ndaq:numItems><item><ndaq:IssueSymbol>QQQ</ndaq:IssueSymbol><ndaq:ReasonCode>T1</ndaq:ReasonCode></item></channel></rss>';
  const parsed=parseHalts(xml);assert.equal(parsed.rows.length,1);
  assert.throws(()=>parseHalts(xml.replace('numItems>1','numItems>2')),/incomplete/);
  assert.equal(haltContext({...parsed,status:'available',received_at:parsed.feed_at},Date.parse(parsed.feed_at)+120001).status,'stale_or_missing');
});
test('synthetic Fed markup retains date-only precision without inventing times',()=>{
  const html='2026 FOMC Meetings'+['January','March','June','September'].map(month=>`<div class="fomc-meeting__month">${month}</div><div class="fomc-meeting__date">1-2</div>`).join('');
  const events=parseFed(html);assert.equal(events.length,4);assert.ok(events.every(e=>e.at===null));
});
