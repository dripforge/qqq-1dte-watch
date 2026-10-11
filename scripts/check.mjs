import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const folder of ['src','scripts','examples']) {
  for (const name of readdirSync(folder).filter(n=>n.endsWith('.mjs'))) {
    const result=spawnSync(process.execPath,['--check',`${folder}/${name}`],{stdio:'inherit'});
    if(result.status!==0)process.exit(result.status??1);
  }
}
console.log('All JavaScript modules parse.');
