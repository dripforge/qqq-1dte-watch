import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync,existsSync,statSync,symlinkSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runtimeDirectory,SOURCE_DIR,PROJECT_DIR,DEFAULT_RUNTIME_DIR } from './runtime-paths.mjs';
import { runtimeManifest,attachDecisionAudit } from './audit-record.mjs';
import { VERSION,PACKAGE_FILE } from './version.mjs';
import { withBrokerAccess } from './broker-access.mjs';

function temporary(t) {const p=mkdtempSync(join(tmpdir(),'qqq-runtime-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
const snapshot=()=>Object.fromEntries(readdirSync(SOURCE_DIR).filter(n=>/\.(mjs|json|swift)$/.test(n)).map(n=>[n,readFileSync(join(SOURCE_DIR,n),'utf8')]));
test('runtime selection is independent of cwd and rejects code paths including symlinks',t=>{
  assert.equal(runtimeDirectory(undefined,{env:{},create:false}),DEFAULT_RUNTIME_DIR);
  for(const path of [PROJECT_DIR,SOURCE_DIR,join(SOURCE_DIR,'new'),join(PROJECT_DIR,'.git','state')])assert.throws(()=>runtimeDirectory(path),/outside source/);
  assert.throws(()=>runtimeDirectory(undefined,{env:{QQQ_RUNTIME_DIR:'relative'}}),/absolute/);
  const base=temporary(t),link=join(base,'source-link');symlinkSync(SOURCE_DIR,link);
  assert.throws(()=>runtimeDirectory(join(link,'state')),/outside source/);
  const target=runtimeDirectory(join(base,'private-state'));
  assert.equal(target,join(realpathSync(base),'private-state'));
  assert.equal(statSync(target).mode&0o777,0o700);
});
test('disabled monitor writes versioned health only to the configured runtime',t=>{
  const base=temporary(t),folder=join(base,'state'),before=snapshot();
  const result=spawnSync(process.execPath,[join(SOURCE_DIR,'monitor.mjs'),'--once'],{cwd:base,encoding:'utf8',env:{...process.env,QQQ_RUNTIME_DIR:folder,QQQ_ENABLE_BROKER:'0',QQQ_ENABLE_LIVE_ORDERS:'0'},timeout:10000});
  assert.equal(result.status,1);assert.match(result.stderr,/Broker disabled/);
  assert.equal(JSON.parse(readFileSync(join(folder,'health.json'),'utf8')).version,VERSION);
  assert.equal(existsSync(join(folder,'monitor.lock')),false);
  assert.deepEqual(snapshot(),before);
});
test('runtime lock and manifests use state storage while fingerprints cover code and package',async t=>{
  const folder=temporary(t),lockPath=join(folder,'broker.lock'),before=snapshot();
  await withBrokerAccess(async()=>assert.equal(existsSync(lockPath),true),{lockPath});
  assert.equal(existsSync(lockPath),false);
  const first=runtimeManifest();assert.ok(first.files['package.json']);assert.equal(first.application_version,VERSION);
  writeFileSync(join(folder,'journal.jsonl'),'invented observation');
  assert.equal(runtimeManifest().runtime_hash,first.runtime_hash);
  const attached=attachDecisionAudit({observed_at:new Date().toISOString()},folder,Date.now());
  assert.equal(attached.runtime_manifest_at_record.runtime_hash,first.runtime_hash);
  assert.equal(existsSync(join(folder,attached.runtime_manifest_at_record.manifest_file)),true);
  assert.deepEqual(snapshot(),before);
});
test('version CLI reads the package source of truth from any working directory',t=>{
  const cwd=temporary(t),result=spawnSync(process.execPath,[join(SOURCE_DIR,'version.mjs')],{cwd,encoding:'utf8'});
  assert.equal(result.status,0);assert.equal(result.stdout.trim(),JSON.parse(readFileSync(PACKAGE_FILE)).version);
});
