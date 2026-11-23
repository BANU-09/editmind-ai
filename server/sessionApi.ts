import express,{type Express,type Request,type Response,type NextFunction,type RequestHandler} from 'express';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {db} from './db';
import {createSession,stepSession,timelineHash} from './sessionEngine';
import {createSessionStorage,findSessionRow,insertSession,loadSession,persistStep} from './sessionPersistence';
import {toOtio} from './sessionOtio';
import {probeStore,getObject,objectStore} from './sessionStore';
import {callbackAllowed,enqueue,exportPath,findJob,jobResponse,jobTables,logEvent,shaFile,startJobLoop,type Ingest,type Principal,type Task} from './sessionJobs';
import type {MediaAnalysis,ProjectState} from '../src/shared/types';

export const serviceErrors={
  AUTH_REQUIRED:'Provide a guest identity or a valid account session.', NOT_FOUND:'The requested resource is unavailable.',
  INVALID_REQUEST:'The request contains invalid or missing data.', IDEMPOTENCY_CONFLICT:'The key already identifies different input.',
  TIMELINE_CONFLICT:'The current timeline differs from the expected revision.', TOO_MANY_REQUESTS:'The client has exceeded its write budget.',
  JOB_PENDING:'The result is not available yet.', JOB_FAILED:'The processing operation failed.', CALLBACK_NOT_ALLOWED:'The callback is not a configured destination.',
  PAYLOAD_TOO_LARGE:'The upload exceeds the configured size limit.', UNAVAILABLE:'The service is not ready.', INTERNAL_ERROR:'The service could not complete this operation.'
} as const;
type Code=keyof typeof serviceErrors;
class ApiError extends Error {
  constructor(readonly status:number,readonly code:Code,message=serviceErrors[code] as string,readonly details:unknown={}){super(message);}
}
function fail(status:number,code:Code,message?:string):never {throw new ApiError(status,code,message);}
function sendError(res:Response,err:ApiError) {
  return res.status(err.status).json({error:{code:err.code,message:err.message,retryable:[429,500,503].includes(err.status),details:err.details}});
}
export function apiErrorHandler(err:any,req:Request,res:Response,next:NextFunction) {
  if(!req.originalUrl.startsWith('/api/v1/'))return next(err);
  if(res.headersSent)return next(err);
  if(err instanceof ApiError)return sendError(res,err);
  if(err?.code==='LIMIT_FILE_SIZE'||err?.type==='entity.too.large')return sendError(res,new ApiError(413,'PAYLOAD_TOO_LARGE'));
  if(err?.type==='entity.parse.failed'||err?.name==='MulterError'||err?.message?.startsWith('Unsupported video format'))return sendError(res,new ApiError(400,'INVALID_REQUEST'));
  logEvent('http.exception','error',String(res.locals.correlation_id||'unknown'),null,{type:err?.name||'Error'});
  return sendError(res,new ApiError(500,'INTERNAL_ERROR'));
}
const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value && typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
type Reply={code:number;value:any};
function write(req:Request,res:Response,input:unknown,operation:()=>Reply) {
  const start=performance.now();
  const key=req.get('Idempotency-Key');
  if(key && (key.length>180 || !key.trim()))fail(400,'INVALID_REQUEST','Invalid Idempotency-Key.');
  const owner=res.locals.owner as string;
  const route=req.baseUrl+req.path;
  const fingerprint=key?digest(input):'';
  const result=db.transaction(()=>{
    if(key){
      const previous=db.prepare('SELECT digest,code,reply FROM edit_requests WHERE owner=? AND route=? AND request_key=?').get(owner,route,key) as any;
      if(previous){
        if(previous.digest!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT');
        return {code:previous.code,value:JSON.parse(previous.reply),replay:true};
      }
    }
    const r=operation();
    if(key)db.prepare('INSERT INTO edit_requests(owner,route,request_key,digest,code,reply) VALUES(?,?,?,?,?,?)').run(owner,route,key,fingerprint,r.code,JSON.stringify(r.value));
    return {...r,replay:false};
  }).immediate();
  if(req.route?.path==='/sessions/:sid/steps')res.set('Server-Timing','session;dur='+(performance.now()-start).toFixed(2));
  res.set('Idempotency-Replayed',String(result.replay)).status(result.code).json(result.value);
  return result.replay as boolean;
}
const text=(v:unknown,max=512)=>typeof v==='string'?v.trim().slice(0,max):'';
function taskMeta(body:any) {
  const callback=text(body?.callback_url,2048)||undefined;
  if(callback&&!callbackAllowed(callback))fail(400,'CALLBACK_NOT_ALLOWED');
  return {callback,rights:text(body?.rights,500)||undefined,generated:body?.ai_generated===true||body?.ai_generated==='true'?true:body?.ai_generated===false||body?.ai_generated==='false'?false:undefined};
}
function transcription(body:any) {
  let vocabulary=body?.vocabulary;
  if(typeof vocabulary==='string'){try{vocabulary=JSON.parse(vocabulary);}catch{vocabulary=vocabulary.split(',');}}
  if(vocabulary!=null&&(!Array.isArray(vocabulary)||vocabulary.length>200||vocabulary.some((x:unknown)=>typeof x!=='string')))fail(400,'INVALID_REQUEST','vocabulary must be a list of at most 200 strings.');
  const stream=Number(body?.audioStreamIndex??0);
  if(!Number.isInteger(stream)||stream<0)fail(400,'INVALID_REQUEST','audioStreamIndex must be a nonnegative integer.');
  return {language:text(body?.languageOverride,64)||undefined,vocabulary:vocabulary?.map((s:string)=>s.trim().slice(0,128))??[],stream};
}
function renderOptions(body:any){
  const resolution=body?.resolution||'720p';
  const quality=body?.quality||'balanced';
  if(!['480p','720p','1080p'].includes(resolution)||!['fast','balanced','high'].includes(quality))fail(400,'INVALID_REQUEST','Unsupported render settings.');
  return {resolution,quality};
}
function project(id:string,ctx:Principal) {
  const row=db.prepare('SELECT p.id,p.user_id,p.guest_token,p.title,p.media_id,p.state_json,m.analysis_json,m.filename,m.mime_type,m.file_path FROM projects p JOIN media_assets m ON m.id=p.media_id WHERE p.id=?').get(id) as any;
  if(!row || !(ctx.userId && row.user_id===ctx.userId || !row.user_id && ctx.guestToken && row.guest_token===ctx.guestToken))fail(404,'NOT_FOUND');
  return row;
}
function sessionRow(id:string,owner:string) {
  const r=findSessionRow(id,owner);
  if(!r)fail(404,'NOT_FOUND');return r;
}
function ownedJob(id:string,owner:string) {
  const j=findJob(id);
  if(!j||j.owner!==owner)fail(404,'NOT_FOUND');return j;
}
export function installSessionApi(app:Express, deps:{auth:(req:Request)=>Principal;upload:RequestHandler;ingest:Ingest}){
  jobTables();
  createSessionStorage();
  startJobLoop(deps.ingest);
  const router=express.Router();
  const counts=new Map<string,{reset:number;count:number}>();
  const writeLimit=Math.max(1,Number(process.env.API_WRITES_PER_MINUTE)||180);
  const rateTimer=setInterval(()=>{for(const [k,v] of counts)if(v.reset<Date.now())counts.delete(k);},60000);
  rateTimer.unref();
  const health=(_req:Request,res:Response)=>{res.json({status:'ok'});};
  const ready=async(_req:Request,res:Response)=>{
    try{db.prepare('SELECT 1').get();await probeStore();res.json({status:'ready',storage:objectStore()});}
    catch{sendError(res,new ApiError(503,'UNAVAILABLE'));}
  };
  app.get('/health',health);app.get('/ready',ready);
  const spec=(_req:Request,res:Response)=>{res.type('application/yaml').sendFile(path.resolve('openapi.yaml'));};
  app.get('/openapi.yaml',spec);
  router.get('/openapi.yaml',spec);
  router.get('/health',health);router.get('/ready',ready);
  router.use((req,res,next)=>{
    const corr=req.get('X-Correlation-Id')||'';
    res.locals.correlation_id=/^[a-zA-Z0-9._:-]{1,128}$/.test(corr)?corr:randomUUID();
    res.set('X-Correlation-Id',res.locals.correlation_id).set('Cache-Control','no-store');
    res.on('finish',()=>logEvent('http.request',res.statusCode>=500?'error':'info',res.locals.correlation_id,res.locals.job_id||null,{method:req.method,route:req.route?.path||'unmatched',status:res.statusCode}));
    const ctx=deps.auth(req); const guest=ctx.guestToken;
    if(!ctx.userId && (!guest||guest.length>256||guest.length<8))return sendError(res,new ApiError(401,'AUTH_REQUIRED'));
    res.locals.ctx=ctx;
    res.locals.owner=ctx.userId?'user:'+ctx.userId:'guest:'+guest;
    if(req.method==='POST'){
      const now=Date.now();
      // Bound traffic from the same network even when a client rotates guest IDs.
      for(const [k,max] of [[res.locals.owner,writeLimit],['ip:'+(req.ip||''),writeLimit*4]] as [string,number][]){
        let v=counts.get(k);if(!v || v.reset<=now){v={reset:now+60000,count:0};counts.set(k,v);}
        if(++v.count>max){res.set('Retry-After','60');return sendError(res,new ApiError(429,'TOO_MANY_REQUESTS'));}
      }
    }
    next();
  });
  function queue(task:Task,res:Response):Reply{
    const result=enqueue(res.locals.owner,task,res.locals.correlation_id);
    res.locals.job_id=result.job_id;
    logEvent('job.queued','info',res.locals.correlation_id,result.job_id,{kind:task.kind});
    return {code:202,value:result};
  }
  router.post('/media/ingest',deps.upload,async(req,res,next)=>{
    const file=req.file;
    if(!file){next(new ApiError(400,'INVALID_REQUEST','Provide a video multipart field.'));return;}
    let keep=false;
    try {
      const params={...transcription(req.body),...taskMeta(req.body),title:text(req.body.title)||file.originalname};
      const fingerprint=req.get('Idempotency-Key')?((file as typeof file & {sha256?:string}).sha256 || await shaFile(file.path)):undefined;
      const replay=write(req,res,{params,name:file.originalname,size:file.size,fingerprint},()=>queue({kind:'ingest',ctx:res.locals.ctx,file:file.path,name:file.originalname,mime:file.mimetype,...params},res));
      keep=!replay;
    }catch(e){next(e);}finally{if(!keep)await fs.promises.unlink(file.path).catch(()=>{});}
  });
  router.post('/media/import-url',(req,res)=>{
    const url=text(req.body?.url,4097);if(!url || url.length>4096)fail(400,'INVALID_REQUEST','A video URL of up to 4096 characters is required.');
    let parsed:URL;try{parsed=new URL(url);}catch{fail(400,'INVALID_REQUEST','Invalid HTTP(S) URL.');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)fail(400,'INVALID_REQUEST','Select an HTTP(S) media URL without embedded credentials.');
    write(req,res,req.body,()=>queue({kind:'import_url',url,ctx:res.locals.ctx,title:text(req.body.title),...transcription(req.body),...taskMeta(req.body)},res));
  });
  router.get('/projects/:id',(req,res)=>{
    const p=project(req.params.id,res.locals.ctx);
    res.json({project:{id:p.id,title:p.title,media_id:p.media_id,duration_s:JSON.parse(p.state_json).duration,analysis:JSON.parse(p.analysis_json)}});
  });
  router.get('/projects/:id/source',(req,res)=>{
    const p=project(req.params.id,res.locals.ctx);
    res.type(p.mime_type).sendFile(p.file_path);
  });
  router.post('/projects/:id/retranscribe',(req,res)=>{
    const p=project(req.params.id,res.locals.ctx);
    write(req,res,req.body??{},()=>queue({kind:'retranscribe',projectId:p.id,mediaId:p.media_id,ctx:res.locals.ctx,...transcription(req.body),...taskMeta(req.body)},res));
  });
  router.post('/projects/:id/exports',(req,res)=>{
    const p=project(req.params.id,res.locals.ctx);
    if(req.body?.state && digest(req.body.state)!==digest(JSON.parse(p.state_json)))fail(409,'TIMELINE_CONFLICT','Save the project or session before exporting its changed timeline.');
    write(req,res,req.body??{},()=>queue({kind:'export',projectId:p.id,mediaId:p.media_id,ctx:res.locals.ctx,state:JSON.parse(p.state_json),...renderOptions(req.body),...taskMeta(req.body)},res));
  });
  router.post('/projects/:id/sessions',(req,res)=>{
    const p=project(req.params.id,res.locals.ctx);
    write(req,res,req.body??{},()=>{
      const id='ses-'+randomUUID();
      const s=createSession(JSON.parse(p.analysis_json) as MediaAnalysis,JSON.parse(p.state_json) as ProjectState);
      insertSession(id,res.locals.owner,p.id,s,new Date().toISOString());
      return {code:201,value:{session_id:id,project_id:p.id,timeline_hash:timelineHash(s.state),duration_s:s.state.duration}};
    });
  });
  router.get('/sessions/:sid',(req,res)=>{
    const sr=sessionRow(req.params.sid,res.locals.owner); const s=loadSession(req.params.sid,res.locals.owner,sr).session;
    const history=db.prepare('SELECT response FROM edit_steps WHERE session_id=? ORDER BY seq').all(req.params.sid) as {response:string}[];
    res.json({session_id:req.params.sid,project_id:sr.project_id,timeline:s.state,timeline_hash:timelineHash(s.state),duration_s:s.state.duration,history:history.map(v=>JSON.parse(v.response))});
  });
  router.post('/sessions/:sid/steps',(req,res)=>{
    if(typeof req.body?.say!=='string'||!req.body.say.trim()||req.body.say.length>8000)fail(400,'INVALID_REQUEST','say must be between 1 and 8000 characters.');
    let afterCommit:(()=>void)|undefined;
    write(req,res,req.body,()=>{
      const r=sessionRow(req.params.sid,res.locals.owner);
      const p=project(r.project_id,res.locals.ctx);
      const loaded=loadSession(req.params.sid,res.locals.owner,r);
      const session=loaded.session;
      if(req.body.expected_hash && req.body.expected_hash!==timelineHash(session.state))fail(409,'TIMELINE_CONFLICT');
      const {session:updated,response}=stepSession(session,JSON.parse(p.analysis_json),req.body.say);
      afterCommit=persistStep(req.params.sid,res.locals.owner,r.seq+1,loaded,updated);
      db.prepare('INSERT INTO edit_steps(session_id,seq,response) SELECT ?,coalesce(max(seq),0)+1,? FROM edit_steps WHERE session_id=?').run(req.params.sid,JSON.stringify(response),req.params.sid);
      return {code:200,value:response};
    });
    afterCommit?.();
  });
  router.post('/sessions/:sid/render',(req,res)=>{
    const sr=sessionRow(req.params.sid,res.locals.owner);
    const p=project(sr.project_id,res.locals.ctx);
    write(req,res,req.body??{},()=>queue({kind:'export',ctx:res.locals.ctx,sessionId:req.params.sid,projectId:p.id,mediaId:p.media_id,state:loadSession(req.params.sid,res.locals.owner,sr).session.state,...renderOptions(req.body),...taskMeta(req.body)},res));
  });
  router.get('/sessions/:sid/timeline.otio',(req,res)=>{
    const sr=sessionRow(req.params.sid,res.locals.owner),p=project(sr.project_id,res.locals.ctx);
    const sourceName=path.posix.basename(path.win32.basename(p.filename));
    res.attachment('timeline.otio').json(toOtio(loadSession(req.params.sid,res.locals.owner,sr).session.state,JSON.parse(p.analysis_json),encodeURIComponent(sourceName)));
  });
  router.get('/jobs/:id',(req,res)=>{const j=ownedJob(req.params.id,res.locals.owner);res.locals.job_id=j.id;res.json(jobResponse(j));});
  router.get('/jobs/:id/manifest',(req,res)=>{
    const j=ownedJob(req.params.id,res.locals.owner);if(!j.manifest_json)fail(409,'JOB_PENDING');res.type('json').send(j.manifest_json);
  });
  router.get('/jobs/:id/download',async(req,res,next)=>{ try{
    const j=ownedJob(req.params.id,res.locals.owner);if(j.status!=='succeeded'||j.kind!=='export')fail(409,'JOB_PENDING');
    res.attachment('edited.mp4');res.type('video/mp4');
    if(objectStore()==='s3' && j.manifest_json && JSON.parse(j.manifest_json).settings.storage==='s3'){
      const obj=await getObject('results/'+j.id+'/edited.mp4');
      if(obj.size!=null)res.set('Content-Length',String(obj.size));
      await pipeline(obj.stream,res);
    }else{const file=exportPath(j);if(!file)fail(404,'NOT_FOUND');res.sendFile(file);}
    }catch(err){next(err);}
  });
  router.use((_req,res)=>sendError(res,new ApiError(404,'NOT_FOUND')));
  router.use(apiErrorHandler);
  app.use('/api/v1',router);
}

