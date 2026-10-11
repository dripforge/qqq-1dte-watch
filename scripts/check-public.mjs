import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';

// A narrow publication guard, not a substitute for reviewing a diff or rotating secrets.
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!files.length)throw new Error('No Git-tracked files to inspect; stage the intended files first.');
const rootFiles=new Set(['README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','THIRD_PARTY_NOTICES.md','CHANGELOG.md','package.json','package-lock.json','.gitignore','.env.example','.editorconfig']);
const allowed=name=>rootFiles.has(name)||/^src\/[\w-]+(?:\.test)?\.(?:mjs|swift)$/.test(name)||name==='src/session-calendar.json'||
  /^scripts\/[\w-]+\.mjs$/.test(name)||/^examples\/(?:synthetic-session\.mjs|policy\.example\.json)$/.test(name)||
  /^docs\/[\w-]+\.md$/.test(name)||name==='docs/assets/demo.png'||
  /^\.github\/(?:workflows\/ci\.yml|dependabot\.yml|PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/[\w-]+\.yml)$/.test(name);
const patterns=[
  ['private home path',new RegExp('/(?:Users|home)/'+'[A-Za-z0-9]')],
  ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['GitHub token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS key',/\bAKIA[A-Z0-9]{16}\b/],
  ['numeric account literal',/account_number\s*[:=]\s*['"]\d{6,}['"]/],
  ['assigned credential',/(?:access_token|refresh_token|client_secret)['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{24,}['"]/],
];
const issues=[];
for(const name of files) {
  if(!allowed(name))issues.push(`${name}: not in publication allowlist`);
  if(lstatSync(name).isSymbolicLink()){issues.push(`${name}: symlink prohibited`);continue;}
  if(name.endsWith('.png'))continue;
  const text=readFileSync(name,'utf8');
  for(const [label,pattern] of patterns)if(pattern.test(text))issues.push(`${name}: ${label}`);
}
const example=JSON.parse(readFileSync('examples/policy.example.json','utf8'));
if(example.approved!==false)issues.push('Example policy must remain unapproved');
if(issues.length){console.error(issues.join('\n'));process.exitCode=1;}
else console.log(`Publication guard passed for ${files.length} tracked files.`);
