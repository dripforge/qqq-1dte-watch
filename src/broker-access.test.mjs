import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrokerAccess } from './broker-access.mjs';
test('concurrent broker calls serialize and release even after a failure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'qqq-access-'));const lockPath=join(dir,'broker.lock');
 let active=0,max=0;
 const action=async()=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,15));active--;return 'ok';};
 try{
  assert.deepEqual(await Promise.all([withBrokerAccess(action,{lockPath}),withBrokerAccess(action,{lockPath})]),['ok','ok']);
  assert.equal(max,1);
  await assert.rejects(withBrokerAccess(async()=>{throw Error('network');},{lockPath}));
  assert.equal(await withBrokerAccess(action,{lockPath}),'ok');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
