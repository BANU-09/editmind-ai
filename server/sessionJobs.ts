import {createHash, createHmac, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {db} from './db';
import {getAppConfig} from './config';
import {getAnalysisJob} from './transcriber';
import {getUrlImportJob, startUrlImportJob} from './urlImporter';
import {runExportJob} from './exporter';
import {readyStore, saveFile, saveJson, objectStore} from './sessionStore';
import type {MediaAnalysis, ProjectState, ExportJob} from '../src/shared/types';

export type Principal={userId:string|null;guestToken:string|null};
export type Ingest=(args:{filePath:string;originalFilename:string;mimeType:string;sourceType:'upload';title:string;audioStreamIndex:number;languageOverride?:string;vocabulary:string[];ctx:Principal})=>Promise<{mediaId:string;projectId:string;job:{id:string}}>;
export type Task={
  kind:'ingest'|'import_url'|'retranscribe'|'export'; ctx:Principal; file?:string; name?:string; mime?:string; url?:string;
  title?:string; language?:string; vocabulary?:string[]; stream?:number; projectId?:string; mediaId?:string; state?:ProjectState;
  sessionId?:string; resolution?:ExportJob['resolution'];quality?:ExportJob['quality']; callback?:string; rights?:string; generated?:boolean;
};
export type JobRow={id:string;owner:string;kind:Task['kind'];status:string;progress:number;task_json:string;target_id:string|null;project_id:string|null;media_id:string|null;created_at:string;ended_at:string|null;error:string|null;manifest_json:string|null;correlation_id:string;callback_status:string|null};
export function jobTables() {
  db.exec(`CREATE TABLE IF NOT EXISTS edit_jobs (
    id TEXT PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,
    task_json TEXT NOT NULL,target_id TEXT,project_id TEXT,media_id TEXT,created_at TEXT NOT NULL,ended_at TEXT,error TEXT,
    manifest_json TEXT,correlation_id TEXT NOT NULL,callback_status TEXT);
    CREATE INDEX IF NOT EXISTS edit_jobs_queue ON edit_jobs(status,created_at);
    CREATE INDEX IF NOT EXISTS edit_jobs_media ON edit_jobs(owner,media_id,kind,created_at);
    CREATE TABLE IF NOT EXISTS edit_requests(owner TEXT NOT NULL,route TEXT NOT NULL,request_key TEXT NOT NULL,
      digest TEXT NOT NULL,code INTEGER NOT NULL,reply TEXT NOT NULL,PRIMARY KEY(owner,route,request_key));
    CREATE TABLE IF NOT EXISTS edit_sessions(id TEXT PRIMARY KEY,owner TEXT NOT NULL,project_id TEXT NOT NULL,
      session_json TEXT NOT NULL, created_at TEXT NOT NULL,FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS edit_steps(session_id TEXT NOT NULL,seq INTEGER NOT NULL,response TEXT NOT NULL,
      PRIMARY KEY(session_id,seq),FOREIGN KEY(session_id) REFERENCES edit_sessions(id) ON DELETE CASCADE);`);
}
export function logEvent(event:string,level:string, correlation_id:string,job_id:string|null,details:Record<string,unknown>={}) {
  console.log(JSON.stringify({timestamp:new Date().toISOString(),level,correlation_id,job_id,event,...details}));
}
export function callbackAllowed(url:string) {
  if(!process.env.CALLBACK_HMAC_SECRET || !(process.env.CALLBACK_ALLOWED_URLS||'').split(',').map(x=>x.trim()).includes(url))return false;
  try {const u=new URL(url);return !u.username&&!u.password&&(u.protocol==='https:' || (u.protocol==='http:'&&process.env.CALLBACK_ALLOW_HTTP==='1'));} catch {return false;}
}
export function enqueue(owner:string, task:Task, correlation:string) {
  const id='job-'+randomUUID();
  db.prepare('INSERT INTO edit_jobs(id,owner,kind,status,task_json,created_at,correlation_id,project_id,media_id) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id,owner,task.kind,'queued',JSON.stringify(task),new Date().toISOString(),correlation,task.projectId??null,task.mediaId??null);
  return {job_id:id,status:'queued',links:{job:'/api/v1/jobs/'+id}};
}
export function jobResponse(j:JobRow) {
  const base='/api/v1/jobs/'+j.id;
  const result_links:Record<string,string>={};
  if (j.manifest_json)result_links.manifest=base+'/manifest';
  if (j.status==='succeeded' && j.project_id)result_links.project='/api/v1/projects/'+j.project_id;
  if (j.status==='succeeded' && j.kind==='export')result_links.download=base+'/download';
  return {job_id:j.id,kind:j.kind,status:j.status,progress:j.progress,project_id:j.project_id,result_links,
    error:j.error?{code:'JOB_FAILED',message:j.error,retryable:false,details:{}}:null,callback_status:j.callback_status};
}
export function findJob(id:string):JobRow|undefined {return db.prepare('SELECT * FROM edit_jobs WHERE id=?').get(id) as JobRow|undefined;}
export async function shaFile(file:string) {const h=createHash('sha256'); for await(const chunk of fs.createReadStream(file))h.update(chunk); return h.digest('hex');}
export function exportPath(row:JobRow) {
  return (db.prepare('SELECT output_path FROM exports WHERE id=?').get(row.target_id) as {output_path:string}|undefined)?.output_path;
}
const failureText=(err:unknown)=> (err instanceof Error?err.message:String(err)).replace(/https?:\/\/[^\s]+/g,'[endpoint]').replace(/[A-Za-z]:\\[^\n]+/g,'[local path]').slice(0,400);
const rate=Number(process.env.COMPUTE_USD_PER_HOUR||0);
function sourceRights(j:JobRow,t:Task) {
  let rights=t.rights,generated=t.generated;
  if(j.media_id && (t.kind==='export'||t.kind==='retranscribe') && (rights===undefined||generated===undefined)){
    // The durable intake record contains the actual user declarations, including
    // uploads made before this inheritance existed. Prefer the original project
    // when an owner reuses one underlying media asset for multiple projects.
    const origin=db.prepare("SELECT task_json FROM edit_jobs WHERE owner=? AND media_id=? AND kind IN ('ingest','import_url') AND status='succeeded' ORDER BY (project_id=?) DESC, created_at DESC LIMIT 1").get(j.owner,j.media_id,j.project_id) as {task_json:string}|undefined;
    if(origin){
      const input:Task=JSON.parse(origin.task_json);
      rights??=input.rights;
      generated??=input.generated;
    }
  }
  return {source:rights||'User-supplied content. Rights are the uploader’s responsibility.',ai_generated:generated??null};
}
function buildManifest(j:JobRow,t:Task,ended:string,warnings:string[]) {
  const media=j.media_id?db.prepare('SELECT analysis_json,source_type FROM media_assets WHERE id=?').get(j.media_id) as {analysis_json:string;source_type:string}|undefined:undefined;
  const analysis:MediaAnalysis|undefined=media?JSON.parse(media.analysis_json):undefined;
  const elapsed=Math.max(0,Date.parse(ended)-Date.parse(j.created_at));
  if(!rate)warnings.push('Infrastructure cost per hour has not been configured.');
  if(analysis?.transcriptionStatus==='partial')warnings.push('The transcript is partial.');
  if(analysis?.transcriptionStatus==='no-audio')warnings.push('The source contains no audio.');
  return {job_id:j.id,kind:j.kind,project_id:j.project_id,session_id:t.sessionId??null,models:{stt:analysis?.providerUsed??(analysis?.hasAudio?'unknown':'none'),configured_stt:getAppConfig().sttProvider,whisper_model:getAppConfig().sttWhisperModel,editor:'editmind-deterministic-v1'},
    versions:{service:process.env.EDITMIND_MEDIA_RELEASE||process.env.EDITMIND_RELEASE||'1.0.0',node:process.version},
    settings:{resolution:t.resolution??null,quality:t.quality??null,language:t.language??analysis?.selectedLanguageOverride??'auto',storage:objectStore()},
    seed:null,deterministic_editor:true,timings:{submitted_at:j.created_at,finished_at:ended,wall_ms:elapsed,media_duration_s:analysis?.durationSec??null},
    cost:{currency:'USD',compute_hourly_rate:rate||null,estimated_compute_usd:rate?Number((rate*elapsed/3600000).toFixed(6)):null,includes_queue_wait:true},
    rights:sourceRights(j,t),warnings};
}
async function deliverCallback(j:JobRow,t:Task) {
  if (!t.callback) return;
  let status='failed';
  if (callbackAllowed(t.callback)) {
    const body=JSON.stringify(jobResponse(j));
    const signature=createHmac('sha256',process.env.CALLBACK_HMAC_SECRET!).update(body).digest('hex');
    for(let i=0;i<3;i++) {
      try {
        const res=await fetch(t.callback,{method:'POST',headers:{'Content-Type':'application/json','X-IncuBrix-Signature':'sha256='+signature,'X-Correlation-Id':j.correlation_id},body,redirect:'error',signal:AbortSignal.timeout(5000)});
        if(res.ok){status='delivered';break;}
      }catch{}
      if(i<2)await wait(250*2**i);
    }
  }
  db.prepare('UPDATE edit_jobs SET callback_status=? WHERE id=?').run(status,j.id);
  logEvent('job.callback',status==='delivered'?'info':'warn',j.correlation_id,j.id,{status});
}
export function startJobLoop(ingest:Ingest) {
  let processing=false;
  const setTarget=(j:JobRow,target:string,project:string|null,media:string|null)=>{
    db.prepare('UPDATE edit_jobs SET target_id=?,project_id=?,media_id=? WHERE id=?').run(target,project,media,j.id);
    j.target_id=target;j.project_id=project;j.media_id=media;
  };
  // Each persisted ticket is assigned to one downstream job. After a restart, monitor
  // that job, rather than starting a second transcription or render.
  const run=async(j:JobRow)=>{
    const t:Task=JSON.parse(j.task_json);
    try {
      db.prepare("UPDATE edit_jobs SET status='running' WHERE id=?").run(j.id);
      if(!j.target_id) {
        if(j.status==='running')throw new Error('Service stopped before the media operation was acknowledged. Inspect the input before starting a new job.');
        if(t.kind==='ingest'){
          const source=await ingest({filePath:t.file!,originalFilename:t.name!,mimeType:t.mime!,sourceType:'upload',title:t.title||t.name!,audioStreamIndex:t.stream||0,languageOverride:t.language,vocabulary:t.vocabulary||[],ctx:t.ctx});
          setTarget(j,source.job.id,source.projectId,source.mediaId);
        } else if(t.kind==='import_url'){
          const {importJob,promise}=startUrlImportJob({url:t.url!,title:t.title,languageOverride:t.language,vocabulary:t.vocabulary,...t.ctx});
          setTarget(j,importJob.id,null,null);void promise.catch(()=>{});
        } else if(t.kind==='retranscribe'){
          const {startBackgroundAnalysisJob}=await import('./mediaProcessor');
          const {job,promise}=startBackgroundAnalysisJob({mediaId:t.mediaId!,projectId:t.projectId!,languageOverride:t.language,audioStreamIndex:t.stream,vocabulary:t.vocabulary});
          setTarget(j,job.id,t.projectId!,t.mediaId!);void promise.catch(()=>{});
        } else {
          const media=db.prepare('SELECT file_path,has_audio,analysis_json FROM media_assets WHERE id=?').get(t.mediaId) as {file_path:string;has_audio:number;analysis_json:string};
          const expId='exp-'+j.id.slice(4);
          db.transaction(()=>{
            db.prepare("INSERT INTO exports(id,project_id,media_id,status,progress,resolution,quality,created_at) VALUES(?,?,?,'queued',0,?,?,?)").run(expId,t.projectId,t.mediaId,t.resolution,t.quality,j.created_at);
            setTarget(j,expId,t.projectId!,t.mediaId!);
            void runExportJob({jobId:expId,projectId:t.projectId!,mediaId:t.mediaId!,sourceFilePath:media.file_path,sourceHasAudio:!!media.has_audio,selectedAudioStream:JSON.parse(media.analysis_json).selectedAudioStream||0,state:t.state!,resolution:t.resolution!,quality:t.quality!}).catch(()=>{});
          })();
        }
      }
      let done=false,progress=1;
      if(t.kind==='export'){
        const exp=db.prepare('SELECT status,progress,error,output_path FROM exports WHERE id=?').get(j.target_id) as any;
        if(!exp||exp.status==='failed')throw new Error(exp?.error||'Export was interrupted.');
        progress=exp.progress;done=exp.status==='completed';
        if(done)await saveFile('results/'+j.id+'/edited.mp4',exp.output_path,'video/mp4');
      } else {
        let analysisId=j.target_id;
        if(t.kind==='import_url'){
          const imp=getUrlImportJob(j.target_id!);
          if(!imp||imp.status==='failed')throw new Error(imp?.error||'Import failed.');
          progress=Math.round((imp.progress||0)*0.2);
          if(imp.status==='completed' && imp.projectId && imp.mediaId){
            setTarget(j,j.target_id!,imp.projectId,imp.mediaId);
            analysisId=imp.analysisJobId??null;
          }else analysisId=null;
        }
        if(analysisId) {
          const job=getAnalysisJob(analysisId);
          if(!job||job.status==='failed'||job.status==='cancelled')throw new Error(job?.error||'Transcription failed.');
          done=['complete','partial','no-audio','local-fallback'].includes(job.status);
          progress=t.kind==='import_url'?20+Math.round(job.overallProgress*.8):job.overallProgress;
        }
      }
      if(!done){db.prepare('UPDATE edit_jobs SET progress=? WHERE id=?').run(Math.min(99,progress),j.id);return;}
      const ended=new Date().toISOString();
      const manifest=buildManifest(j,t,ended,[]);
      await saveJson('results/'+j.id+'/manifest.json',manifest);
      db.prepare("UPDATE edit_jobs SET status='succeeded',progress=100,ended_at=?,manifest_json=? WHERE id=?").run(ended,JSON.stringify(manifest),j.id);
      logEvent('job.succeeded','info',j.correlation_id,j.id);
    }catch(err){
      const ended=new Date().toISOString();
      const message=failureText(err);
      const m=buildManifest(j,t,ended,[message]);
      db.prepare("UPDATE edit_jobs SET status='failed',ended_at=?,error=?,manifest_json=? WHERE id=?").run(ended,message,JSON.stringify(m),j.id);
      logEvent('job.failed','error',j.correlation_id,j.id,{message});
    }
    void deliverCallback(findJob(j.id)!,t).catch(()=>{});
  };
  async function tick(){
    if(processing)return;processing=true;
    try{
      const jobs=db.prepare("SELECT * FROM edit_jobs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 32").all() as JobRow[];
      for(const job of jobs)await run(job);
    }catch(e){logEvent('queue.error','error','background',null,{message:failureText(e)});}
    finally{processing=false;}
  }
  const timer=setInterval(()=>void tick(),Math.max(100,Number(process.env.JOB_POLL_MS)||400));timer.unref();
  void readyStore().catch(()=>{});return timer;
}

