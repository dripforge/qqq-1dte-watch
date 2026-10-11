import { runtimeDirectory } from './runtime-paths.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
const defaultPath=join(runtimeDirectory(),'broker.lock');
export async function withBrokerAccess(action,{lockPath=defaultPath,timeoutMs=12000}={}){
 const began=Date.now();let release;
 for(;;){
  try{release=acquireProcessLock(lockPath);break;}
  catch(e){
   const busy=e.code==='EEXIST'||String(e.message).includes('A live process owns');
   if(!busy||Date.now()-began>=timeoutMs)throw e;
   await new Promise(resolve=>setTimeout(resolve,50));
  }
 }
 try{return await action();}finally{release();}
}
