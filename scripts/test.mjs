import {spawn} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';

const socket=createServer();
await new Promise((resolve,reject)=>socket.listen(0,'127.0.0.1',resolve).on('error',reject));
const port=socket.address().port;
await new Promise(resolve=>socket.close(resolve));
const storage=await mkdtemp(path.join(tmpdir(),'editmind-suite-'));
const base='http://127.0.0.1:'+port;
const env={...process.env,PORT:String(port),STORAGE_DIR:storage,EDITMIND_TEST_BASE:base,
  NODE_ENV:'test',GEMINI_API_KEY:'',GOOGLE_API_KEY:'',WORKER_URL:'',S3_BUCKET:'',BLOB_READ_WRITE_TOKEN:'',
  STT_PROVIDER:'local-whisper',FORCE_LOCAL_STT:'1',WARM_DEMO_LIBRARY:'0'};
const service=spawn(process.execPath,['--import','tsx','server.ts'],{env,stdio:'inherit',windowsHide:true});
const serviceExit=new Promise(resolve=>service.once('exit',resolve));
try {
  let ready=false;
  for(let i=0;i<150;i++) {
    if(service.exitCode!==null) throw new Error('The test API exited during startup');
    try{ready=(await fetch(base+'/api/health')).ok;}catch{}
    if(ready) break;
    await wait(400);
  }
  if(!ready) throw new Error('The test API did not become healthy');
  const files=[];
  for(const dir of ['src/shared','server']) {
    for(const name of (await readdir(dir)).filter(n=>n.endsWith('.test.ts')).sort()) files.push(path.join(dir,name));
  }
  const child=spawn(process.execPath,['--import','tsx','--test','--test-concurrency=1',...files],
    {env,stdio:'inherit',windowsHide:true});
  process.exitCode=await new Promise(resolve=>child.once('exit',code=>resolve(code??1)));
} finally {
  if(service.exitCode===null) service.kill();
  await serviceExit;
  await rm(storage,{recursive:true,force:true,maxRetries:6,retryDelay:200});
}
