import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectAnalysisCycle,ANALYSIS_READ_TOOLS} from './analysis-collector.mjs';
const now=Date.parse('2026-10-09T19:43:57Z');
function fixture(t){const folder=mkdtempSync(join(tmpdir(),'qqq-analysis-'));t.after(()=>rmSync(folder,{recursive:true,force:true}));writeFileSync(join(folder,'health.json'),JSON.stringify({at:new Date(now).toISOString(),live:true,status:'idle'}));return folder;}
function mock(before=()=>{}){const calls=[];return {calls,mcp:{connectReadOnly:async o=>{o.beforeConnect();return {};},call:async(c,name,args,o)=>{before();o.beforeSend();calls.push({name,args,o});if(name==='get_indexes')return {indexes:[{id:'11111111-1111-4111-8111-111111111111',symbol:'VIX'}]};return name==='get_index_quotes'?{quotes:[]}:{results:[]};}}};}
test('collector is bounded, read-only and keeps calendar metadata off the critical path',async t=>{
 const folder=fixture(t),m=mock();const x=await collectAnalysisCycle({folder,clock:()=>now,mcpLoader:async()=>m.mcp});assert.equal(x.broker_reads,4);assert.ok(m.calls.every(c=>ANALYSIS_READ_TOOLS.includes(c.name)&&c.o.lockTimeoutMs===0&&c.o.timeoutMs<=1000));assert.equal(m.calls.filter(c=>c.name==='get_equity_historicals').length,1);
 const second=await collectAnalysisCycle({folder,clock:()=>now+1000,mcpLoader:async()=>m.mcp});assert.equal(second.broker_reads,1);assert.equal(m.calls.at(-1).name,'get_earnings_calendar');
});
test('active trades, plans, locks or stale idle health prevent connection and data reads',async t=>{
 for(const name of ['arm.json','entry-intent.json','entry-watch-plan.json','entry.lock','stop-intent.json','broker.lock','health.json']){
  const folder=fixture(t);writeFileSync(join(folder,name),name==='health.json'?JSON.stringify({at:new Date(now-61000).toISOString(),live:true,status:'idle'}):'{}');let loaded=0;
  const x=await collectAnalysisCycle({folder,clock:()=>now,mcpLoader:async()=>{loaded++;throw Error('No connection');}});assert.equal(loaded,0);assert.equal(x.broker_reads,0);assert.equal(x.status,'skipped');
 }
});
test('dispatch rechecks trade state inside the broker lock',async t=>{
 const folder=fixture(t),m=mock(()=>writeFileSync(join(folder,'arm.json'),'{}'));
 const x=await collectAnalysisCycle({folder,clock:()=>now,mcpLoader:async()=>m.mcp});assert.equal(m.calls.length,0);assert.ok(x.errors.some(e=>e.reason==='live_trade_priority'));
});
test('failed optional reads cannot turn old observations fresh or leak credential details',async t=>{
 const folder=fixture(t);writeFileSync(join(folder,'analysis-context-latest.json'),JSON.stringify({version:1,analysis_version:'1.0.0',quotes_received_at:'2026-10-09T19:00:00Z',equity_quotes:[{symbol:'QQQ',quote_at:'2026-10-09T19:00:00Z',last:500,usable:true}]}));
 const x=await collectAnalysisCycle({folder,clock:()=>now,mcpLoader:async()=>{throw Error('private token text');}});assert.equal(JSON.stringify(x).includes('private'),false);
 const saved=JSON.parse(readFileSync(join(folder,'analysis-context-latest.json')));assert.equal(saved.equity_quotes[0].quote_at,'2026-10-09T19:00:00Z');
});
test('clock budget prevents later sends after a slow response',async t=>{
 const folder=fixture(t);let clock=now;const m=mock(()=>{clock+=2000;});await collectAnalysisCycle({folder,clock:()=>clock,mcpLoader:async()=>m.mcp,budgetMs:2500});assert.equal(m.calls.length,1);
});
