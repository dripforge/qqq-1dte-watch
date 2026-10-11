import { runtimeDirectory } from './runtime-paths.mjs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {enqueueResearchCase} from './research-collector-policy.mjs';
const root=runtimeDirectory();
export function enqueueResearchFile(inputPath,{folder=root,now=Date.now()}={}){
  const actualRoot=realpathSync(folder),candidate=realpathSync(resolve(actualRoot,inputPath)),within=relative(actualRoot,candidate);
  if(!within||isAbsolute(within)||within==='..'||within.startsWith('../'))throw Error('Research queue input must be inside its configured folder');
  const stat=statSync(candidate);if(!stat.isFile()||stat.size>16384)throw Error('Research queue input exceeds its bound');
  return enqueueResearchCase(JSON.parse(readFileSync(candidate,'utf8')),{folder:actualRoot,now});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),flag=args.indexOf('--folder');
  const folder=flag>=0&&args[flag+1]?runtimeDirectory(resolve(args[flag+1])):root;
  try{if(!args[0]||args[0].startsWith('--'))throw Error('Usage: research-enqueue.mjs INPUT_JSON [--folder FOLDER]');
    process.stdout.write(JSON.stringify(enqueueResearchFile(args[0],{folder}))+'\n');
  }catch{process.stdout.write(JSON.stringify({status:'research_queue_skipped',reason:'Research queue input unavailable or invalid.',execution_unaffected:true})+'\n');process.exitCode=1;}
}
