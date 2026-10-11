import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots = new Set(['README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md','CHANGELOG.md','package.json','package-lock.json','.gitignore','.env.example','.editorconfig']);
export const isPublishablePath = name => roots.has(name) ||
  /^src\/[\w-]+(?:\.test)?\.(?:mjs|swift)$/.test(name) || name==='src/session-calendar.json' ||
  /^scripts\/[\w-]+\.mjs$/.test(name) || /^examples\/(?:synthetic-session\.mjs|policy\.example\.json)$/.test(name) ||
  /^docs\/[\w-]+\.md$/.test(name) || /^docs\/assets\/demo\.(png|jpg)$/.test(name) ||
  /^\.github\/(?:workflows\/ci\.yml|dependabot\.yml|PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/[\w-]+\.yml)$/.test(name);

// Match credential families, not entire secret values in diagnostic output.
const patterns = [
  ['private home path', new RegExp('/(?:Users|home)/'+'[A-Za-z0-9]')],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS key', /\bAKIA[A-Z0-9]{16}\b/],
  ['numeric account literal', /account_number\s*[:=]\s*['"]\d{6,}['"]/],
  ['assigned credential', /(?:access_token|refresh_token|client_secret|api_key|password)['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{24,}['"]/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/],
];
export function inspectContent(name, data) {
  const issues=[];
  if (!isPublishablePath(name)) issues.push('not in publication allowlist');
  if (/^docs\/assets\/demo\.(png|jpg)$/.test(name)) {
    const jpeg=data[0]===0xff&&data[1]===0xd8;
    const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    if (!jpeg&&!png) issues.push('unrecognized preview image');
    // Preview contents require visual review; old commits used a PNG suffix for JPEG bytes.
    return issues;
  }
  if (data.includes(0)) issues.push('unexpected binary content');
  const text=data.toString('utf8');
  for (const [label,pattern] of patterns) if (pattern.test(text)) issues.push(label);
  if (name==='examples/policy.example.json') {
    try { if (JSON.parse(text).approved!==false) issues.push('example policy must remain unapproved'); }
    catch { issues.push('invalid policy example'); }
  }
  return issues;
}

/** Scan current tracked files, staged blobs and every tree reachable from local refs. */
export function checkPublication(cwd=process.cwd()) {
  const git=(...args)=>execFileSync('git',args,{cwd,maxBuffer:64*1024*1024});
  if (git('rev-parse','--is-shallow-repository').toString().trim()==='true') throw new Error('Full Git history is required; fetch with depth 0 or unshallow first.');
  const problems=new Set(), scanned=new Set();
  const inspect=(name,data,where)=>{
    for (const issue of inspectContent(name,data)) problems.add(`${where}: ${name}: ${issue}`);
  };
  const inspectEntry=(name,oid,mode,where)=>{
    if (!isPublishablePath(name)) problems.add(`${where}: ${name}: not in publication allowlist`);
    if (!['100644','100755'].includes(mode)) { problems.add(`${where}: ${name}: symlink or submodule prohibited`); return; }
    const key=`${name}:${oid}`;
    if(scanned.has(key))return;
    scanned.add(key);inspect(name,git('cat-file','blob',oid),`${where} blob ${oid.slice(0,12)}`);
  };
  const entries=git('ls-files','--stage','-z').toString().split('\0').filter(Boolean);
  if (!entries.length) throw new Error('No Git-tracked files; stage the intended files first.');
  for(const entry of entries) {
    const [meta,name]=entry.split('\t'),[mode,oid,stage]=meta.split(' ');
    if(stage!=='0')problems.add(`index: ${name}: unresolved merge`);
    inspectEntry(name,oid,mode,'index');
    const path=resolve(cwd,name);
    if (!existsSync(path)) continue;
    if(lstatSync(path).isSymbolicLink()) { problems.add(`worktree: ${name}: symlink prohibited`);continue; }
    inspect(name,readFileSync(path),'worktree');
  }
  const commits=git('rev-list','--all').toString().trim().split('\n').filter(Boolean);
  for(const commit of commits) {
    for(const entry of git('ls-tree','-r','-z',commit).toString().split('\0').filter(Boolean)) {
      const tab=entry.indexOf('\t'),[mode,,oid]=entry.slice(0,tab).split(' '),name=entry.slice(tab+1);
      inspectEntry(name,oid,mode,`history ${commit.slice(0,12)}`);
    }
  }
  return {files:entries.length,commits:commits.length,unique_blobs:scanned.size,issues:[...problems]};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const result=checkPublication();
    if(result.issues.length){console.error(result.issues.join('\n'));process.exitCode=1;}
    else console.log(`Publication guard passed: ${result.files} tracked files, ${result.commits} commits, ${result.unique_blobs} file blobs. Images require visual review.`);
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
