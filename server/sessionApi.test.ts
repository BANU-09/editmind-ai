import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import Database from 'better-sqlite3';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';

test('versioned HTTP intake, scoped retries, session edit, render, evidence and signed callback', {timeout:150000},async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'editmind-http-'));
  let callback: {body:string;signature:string}|undefined;
  const receiver=createServer((request,response)=>{
    let body='';request.setEncoding('utf8').on('data',chunk=>body+=chunk).on('end',()=>{
      callback={body,signature:String(request.headers['x-incubrix-signature'])};response.writeHead(204).end();
    });
  });
  await new Promise<void>(r=>receiver.listen(0,'127.0.0.1',r));
  const listen=createServer();await new Promise<void>(r=>listen.listen(0,'127.0.0.1',r));
  const port=(listen.address() as {port:number}).port;await new Promise<void>(r=>listen.close(()=>r()));
  const url='http://127.0.0.1:'+port;
  const callbackUrl='http://127.0.0.1:'+(receiver.address() as {port:number}).port+'/done';
  const secret='only-for-isolated-loopback-verification';
  const root=path.resolve(import.meta.dirname,'..');
  const child=spawn(process.execPath,['--import','tsx','server.ts'],{cwd:root,windowsHide:true,
    env:{...process.env,NODE_ENV:'production',PORT:String(port),STORAGE_DIR:temporary,STT_PROVIDER:'mock',FORCE_LOCAL_STT:'0',GEMINI_API_KEY:'',
      JOB_POLL_MS:'110',WARM_DEMO_LIBRARY:'0',S3_BUCKET:'',BLOB_READ_WRITE_TOKEN:'',WORKER_URL:'',MOCK_STT_TEXT:'The first chapter starts with a welcome.',
      CALLBACK_ALLOW_HTTP:'1',CALLBACK_ALLOWED_URLS:callbackUrl,CALLBACK_HMAC_SECRET:secret},stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',b=>{logs=(logs+b).slice(-30000);});child.stderr.on('data',b=>{logs=(logs+b).slice(-30000);});
  const guest='http-repro-guest';
  const headers=(key?:string)=>({'x-guest-id':guest,'X-Correlation-Id':'http-check-01',...(key?{'Idempotency-Key':key}:{})});
  const call=async(method:string,p:string,body?:unknown,key?:string)=>{
    const res=await fetch(url+'/api/v1'+p,{method,headers:{...headers(key),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {res,data:await res.json() as any};
  };
  async function status(id:string) {
    for(let i=0;i<200;i++){
      const j=(await call('GET','/jobs/'+id)).data;
      if(j.status==='succeeded')return j;
      if(j.status==='failed')throw new Error(JSON.stringify(j.error));
      await wait(250);
    }
    const snapshot=new Database(path.join(temporary,'editmind.db'),{readonly:true});
    const jobs=snapshot.prepare('SELECT kind,status,progress,target_id,error FROM edit_jobs').all();
    const analyses=snapshot.prepare('SELECT status,overall_progress,error FROM analysis_jobs').all();
    snapshot.close();
    throw new Error('Job did not terminate '+JSON.stringify({jobs,analyses})+' '+logs.split('\n').filter(l=>!l.includes('http.request')).slice(-14).join('\n'));
  }
  try{
    let ready=false;
    for(let i=0;i<320;i++){
      if(child.exitCode!==null)throw new Error('Service exited during startup: '+logs);
      try{if((await fetch(url+'/ready')).ok){ready=true;break;}}catch{}
      await wait(200);
    }
    assert.ok(ready,logs);
    assert.equal((await fetch(url+'/api/v1/jobs/missing')).status,401);
    const input=path.join(temporary,'fixture.mp4');
    execFileSync('ffmpeg',['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=160x120:r=15','-f','lavfi','-i','sine=frequency=330:sample_rate=16000','-t','3','-c:v','libx264','-c:a','aac',input]);
    const bytes=await readFile(input);
    const submit=async()=>{
      const form=new FormData();form.append('video',new Blob([new Uint8Array(bytes)],{type:'video/mp4'}),'fixture.mp4');form.append('ai_generated','true');
      form.append('rights','Synthetic test signal published for this verification.');
      const res=await fetch(url+'/api/v1/media/ingest',{method:'POST',headers:headers('retry-ingest'),body:form});
      assert.equal(res.status,202);assert.equal(res.headers.get('x-correlation-id'),'http-check-01');
      return (await res.json() as any).job_id;
    };
    const ids=await Promise.all([submit(),submit()]);
    assert.equal(ids[0],ids[1]);
    const ingestion=await status(ids[0]);
    const p=ingestion.project_id;assert.ok(p);
    const outsider=await fetch(url+'/api/v1/jobs/'+ids[0],{headers:{'x-guest-id':'another-guest'}});
    assert.equal(outsider.status,404);
    const session=await call('POST','/projects/'+p+'/sessions',{},'new-session');
    assert.equal(session.res.status,201);
    const sid=session.data.session_id;
    const output=await call('POST','/sessions/'+sid+'/steps',{say:'Cut the first 1 second'},'cut-1');
    assert.equal(output.res.status,200);assert.equal(output.data.status,'applied',JSON.stringify(output.data));
    assert.match(output.res.headers.get('Server-Timing')||'',/^session;dur=\d/);
    const same=await call('POST','/sessions/'+sid+'/steps',{say:'Cut the first 1 second'},'cut-1');
    assert.deepEqual(same.data,output.data);assert.equal(same.res.headers.get('Idempotency-Replayed'),'true');
    const conflict=await call('POST','/sessions/'+sid+'/steps',{say:'Undo'},'cut-1');assert.equal(conflict.res.status,409);
    assert.equal(conflict.data.error.code,'IDEMPOTENCY_CONFLICT');
    const current=await call('GET','/sessions/'+sid);assert.equal(current.data.history.length,1);
    assert.equal((await call('POST','/sessions/'+sid+'/steps',{say:'Undo',expected_hash:'wrong'})).data.error.code,'TIMELINE_CONFLICT');
    assert.ok((await call('GET','/sessions/'+sid+'/timeline.otio')).data.OTIO_SCHEMA);
    assert.equal((await call('POST','/sessions/'+sid+'/render',{callback_url:'https://invalid.example'})).res.status,400);
    const render=await call('POST','/sessions/'+sid+'/render',{resolution:'480p',quality:'fast',callback_url:callbackUrl},'render-once');
    assert.equal(render.res.status,202);
    const job=await status(render.data.job_id);
    const download=await fetch(url+job.result_links.download,{headers:headers()});
    assert.equal(download.status,200);
    assert.match(Buffer.from(await download.arrayBuffer()).subarray(0,48).toString('latin1'),/ftyp/);
    const evidence=await (await fetch(url+job.result_links.manifest,{headers:headers()})).json() as any;
    assert.equal(evidence.rights.ai_generated,true);assert.ok(evidence.timings.wall_ms>=0);
    assert.equal(evidence.rights.source,'Synthetic test signal published for this verification.');
    for(let i=0;i<30&&!callback;i++)await wait(50);
    assert.ok(callback);assert.equal(callback.signature,'sha256='+createHmac('sha256',secret).update(callback.body).digest('hex'));
    assert.match(logs,/"correlation_id":"http-check-01"/);
    const original=await fetch(url+'/api/v1/projects/'+p+'/source',{headers:headers()});
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
    // A previous release embedded the original timeline in each session row.
    // Seed that actual representation and verify its first write migrates both
    // snapshots, preserves undo, and stores the large JSON as compressed blobs.
    const legacyDb=new Database(path.join(temporary,'editmind.db'));
    try {
      const saved=legacyDb.prepare('SELECT state_json FROM projects WHERE id=?').get(p) as {state_json:string};
      const baseline=JSON.parse(saved.state_json);
      baseline.segments[0].label='long transcript metadata '.repeat(5000);
      const legacyState={version:1,original:baseline,state:baseline,events:[],cursor:0};
      const legacy='session-before-upgrade';
      legacyDb.prepare('INSERT INTO edit_sessions(id,owner,project_id,session_json,created_at) VALUES(?,?,?,?,?)').run(legacy,'guest:'+guest,p,JSON.stringify(legacyState),new Date().toISOString());
      const untouched=await call('GET','/sessions/'+legacy);
      const edited=await call('POST','/sessions/'+legacy+'/steps',{say:'Cut the first 1 second'});
      assert.equal(edited.data.status,'applied');
      const undone=await call('POST','/sessions/'+legacy+'/steps',{say:'Undo'});
      assert.equal(undone.data.timeline_hash,untouched.data.timeline_hash);
      const storage=legacyDb.prepare('SELECT typeof(s.session_json) AS current_type,typeof(o.original_json) AS original_type,length(s.session_json)+length(o.original_json) AS bytes FROM edit_sessions s JOIN edit_session_originals o ON o.session_id=s.id WHERE s.id=?').get(legacy) as any;
      assert.equal(storage.current_type,'blob');assert.equal(storage.original_type,'blob');
      assert.ok(storage.bytes<JSON.stringify(legacyState).length/2);
    }finally{legacyDb.close();}
  }finally{
    child.kill();if(child.exitCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),wait(4000)]);
    await new Promise<void>(r=>receiver.close(()=>r()));await rm(temporary,{recursive:true,force:true,maxRetries:3});
  }
});

