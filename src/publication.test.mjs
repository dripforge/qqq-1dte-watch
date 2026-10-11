import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,writeFileSync,rmSync,mkdirSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPublication,inspectContent } from '../scripts/check-public.mjs';

function repository(t) {
  const cwd=mkdtempSync(join(tmpdir(),'qqq-publication-'));t.after(()=>rmSync(cwd,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd,stdio:'pipe'});
  git('init','-b','main');git('config','user.name','Synthetic Test');git('config','user.email','test@example.invalid');
  writeFileSync(join(cwd,'README.md'),'Synthetic fixture\n');git('add','.');git('-c','commit.gpgsign=false','commit','-m','Fixture');
  return {cwd,git};
}
const fakeToken=()=>['gh','p_','x'.repeat(36)].join('');
test('publication scan rejects a secret removed from the current tree but retained in history',t=>{
  const {cwd,git}=repository(t);
  writeFileSync(join(cwd,'README.md'),fakeToken());git('add','.');git('-c','commit.gpgsign=false','commit','-m','Dummy secret');
  writeFileSync(join(cwd,'README.md'),'Clean again');git('add','.');git('-c','commit.gpgsign=false','commit','-m','Remove dummy');
  const result=checkPublication(cwd);
  assert.ok(result.issues.some(s=>s.startsWith('history')&&s.includes('GitHub token')));
  assert.ok(result.issues.every(s=>!s.includes(fakeToken())));
});
test('publication scan checks staged bytes even when the working copy is clean',t=>{
  const {cwd,git}=repository(t);
  writeFileSync(join(cwd,'README.md'),fakeToken());git('add','.');writeFileSync(join(cwd,'README.md'),'Clean working copy');
  assert.ok(checkPublication(cwd).issues.some(s=>s.startsWith('index')&&s.includes('GitHub token')));
});
test('publication scan checks unstaged tracked changes and private paths',t=>{
  const {cwd}=repository(t);assert.deepEqual(checkPublication(cwd).issues,[]);
  writeFileSync(join(cwd,'README.md'),'/'+['Users','synthetic','private'].join('/'));
  assert.ok(checkPublication(cwd).issues.some(s=>s.startsWith('worktree')&&s.includes('private home path')));
});
test('publication scan rejects forced runtime files and source symlinks',t=>{
  const {cwd,git}=repository(t);mkdirSync(join(cwd,'runtime'));writeFileSync(join(cwd,'runtime','journal.jsonl'),'{}');
  mkdirSync(join(cwd,'src'));symlinkSync('../README.md',join(cwd,'src','link.mjs'));git('add','.');
  const result=checkPublication(cwd);
  assert.ok(result.issues.some(s=>s.includes('runtime/journal.jsonl')&&s.includes('allowlist')));
  assert.ok(result.issues.some(s=>s.includes('symlink')));
});
test('publication scan rejects approved examples and planted credential families',()=>{
  const bytes=s=>Buffer.from(s);
  assert.ok(inspectContent('examples/policy.example.json',bytes('{"approved":true}')).some(s=>s.includes('unapproved')));
  const fixtures=[['account','_number: "123456789"'].join(''),['access','_token: "','a'.repeat(30),'"'].join(''),['AK','IA','X'.repeat(16)].join('')];
  for(const value of fixtures)assert.ok(inspectContent('README.md',bytes(value)).length);
});
test('publication scan refuses shallow history instead of claiming complete coverage',t=>{
  const {cwd,git}=repository(t);writeFileSync(join(cwd,'.git','shallow'),git('rev-parse','HEAD'));
  assert.throws(()=>checkPublication(cwd),/Full Git history/);
});
