import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const files = readdirSync('src').filter(n=>n.endsWith('.test.mjs')).sort().map(n=>`src/${n}`);
const result = spawnSync(process.execPath, ['--test', ...files], {stdio:'inherit'});
process.exit(result.status ?? 1);
