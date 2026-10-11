import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDemo } from './demo.mjs';
const {folder}=buildDemo();
const server=createServer((req,res)=>{
  if(req.method!=='GET'||!['/','/decision-audit.html'].includes(req.url)) {res.writeHead(404).end('Not found');return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(readFileSync(join(folder,'decision-audit.html')));
});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
server.listen(4173,'127.0.0.1',()=>console.log('Synthetic demo: http://127.0.0.1:4173 · Ctrl+C to stop'));
