import {openAsBlob} from 'node:fs';
import {mkdir, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {parse} from 'yaml';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonFile = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const terminal = new Set(['applied','needs_clarification','rejected']);

export async function connect(baseUrl, guestId = 'runner-' + randomUUID()) {
  let base = new URL(baseUrl).origin;
  if (new URL(base).hostname.endsWith('.vercel.app')) {
    const discovery = await fetch(base + '/api/v1/endpoint', {signal:AbortSignal.timeout(180000)});
    if (!discovery.ok) throw new Error('The production media endpoint could not be discovered: ' + discovery.status);
    const worker = new URL((await discovery.json()).origin);
    if (worker.protocol !== 'https:' || !worker.hostname.endsWith('.vercel.run')) throw new Error('Unexpected production media origin');
    base = worker.origin;
  }
  const auth = {'x-guest-id':guestId};
  if (process.env.EDITMIND_ACCESS_TOKEN) auth.authorization='Bearer '+process.env.EDITMIND_ACCESS_TOKEN;
  async function request(route, body, key=randomUUID()) {
    const url=new URL(route,base);
    if (url.origin!==base) throw new Error('Unexpected API origin');
    const post=body!==undefined, multipart=body instanceof FormData;
    const headers={...auth, ...(post?{'Idempotency-Key':key}:{}), ...(post&&!multipart?{'Content-Type':'application/json'}:{})};
    for (let attempt=1;;attempt++) {
      let response;
      try {
        response=await fetch(url,{method:post?'POST':'GET',headers,body:post?(multipart?body:JSON.stringify(body)):undefined,
          redirect:'error',signal:AbortSignal.timeout(180000)});
      } catch(error) {
        if(attempt>=3) throw error;
        await sleep(500*attempt); continue;
      }
      if ([429,502,503,504].includes(response.status) && attempt<3) {
        await response.arrayBuffer();
        await sleep(1000*attempt); continue;
      }
      const result=await response.json();
      if (!response.ok) throw new Error((result.error?.code || response.status)+' '+(result.error?.message || 'API request failed'));
      return result;
    }
  }
  async function waitJob(id,timeoutMs) {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline) {
      const job=await request('/api/v1/jobs/'+encodeURIComponent(id));
      if(job.status==='succeeded') return job;
      if(job.status==='failed') throw new Error(job.error?.message || 'Job failed: '+id);
      await sleep(550);
    }
    throw new Error('Timed out waiting for job '+id);
  }
  async function download(route,file) {
    const url=new URL(route,base);
    if(!['http:','https:'].includes(url.protocol)) throw new Error('Invalid download URL');
    const res=await fetch(url,{headers:url.origin===base?auth:{},redirect:'manual',signal:AbortSignal.timeout(180000)});
    if([301,302,303,307,308].includes(res.status)) {
      const target=new URL(res.headers.get('location'),url);
      if(!['http:','https:'].includes(target.protocol)) throw new Error('Invalid download redirect');
      const signed=await fetch(target,{signal:AbortSignal.timeout(180000)});
      if(!signed.ok) throw new Error('Object download failed: '+signed.status);
      await pipeline(Readable.fromWeb(signed.body),createWriteStream(file));
      return;
    }
    if(!res.ok) throw new Error('Output download failed: '+res.status);
    await pipeline(Readable.fromWeb(res.body),createWriteStream(file));
  }
  return {request,waitJob,download,projects:new Map()};
}

export async function runSession(client, spec, sourceDir, destination, timeoutMs) {
  await mkdir(destination,{recursive:true});
  if((await readdir(destination)).length) throw new Error('Choose an empty output directory: '+destination);
  const log={steps:[],outcome:'running'};
  const save=()=>jsonFile(path.join(destination,'results.json'),log);
  try {
    if(!Array.isArray(spec.steps)||!spec.steps.length) throw new Error('A session requires a nonempty steps array');
    let projectId=spec.project;
    const sourceKey=typeof spec.video==='string' ? (/^https?:/i.test(spec.video) ? spec.video : path.resolve(sourceDir,spec.video)) : undefined;
    if(!projectId && sourceKey) projectId=client.projects.get(sourceKey);
    if(!projectId) {
      if(typeof spec.video!=='string'||!spec.video.trim()) throw new Error('Specify a video URL or local file');
      let job;
      if(/^https?:\/\//i.test(spec.video)) job=await client.request('/api/v1/media/import-url',{url:spec.video,title:spec.title,rights:spec.rights,ai_generated:spec.ai_generated});
      else {
        const form=new FormData();
        const src=path.resolve(sourceDir,spec.video);
        form.set('video',await openAsBlob(src),path.basename(src));
        if(spec.title) form.set('title',spec.title);
        if(spec.rights) form.set('rights',spec.rights);
        if(typeof spec.ai_generated==='boolean') form.set('ai_generated',String(spec.ai_generated));
        job=await client.request('/api/v1/media/ingest',form);
      }
      const ready=await client.waitJob(job.job_id,timeoutMs);
      projectId=ready.project_id || job.project_id || ready.result_links?.project?.split('/').pop();
      if(!projectId) throw new Error('The analysis job did not return a project');
      client.projects.set(sourceKey,projectId);
      log.ingest_job=job.job_id;
    }
    const created=await client.request('/api/v1/projects/'+encodeURIComponent(projectId)+'/sessions',{});
    log.session_id=created.session_id;
    const session='/api/v1/sessions/'+encodeURIComponent(created.session_id);
    let renderedHash;
    async function render() {
      const queued=await client.request(session+'/render',{resolution:spec.resolution||'480p',quality:spec.quality||'fast'});
      const done=await client.waitJob(queued.job_id,timeoutMs);
      if(!done.result_links?.download) throw new Error('The completed render did not return a download');
      await client.download(done.result_links.download,path.join(destination,'final.mp4'));
      if(done.result_links.manifest) await client.download(done.result_links.manifest,path.join(destination,'manifest.json'));
      log.render_job=queued.job_id;
    }
    for(const [i,step] of spec.steps.entries()) {
      if(typeof step.say!=='string'||!step.say.trim()) throw new Error('Missing say in step '+(i+1));
      async function say(text) {
        const t=performance.now();
        const response=await client.request(session+'/steps',{say:text});
        if(!terminal.has(response.status)||!Array.isArray(response.operations)||!Number.isFinite(response.duration_s)||!response.timeline_hash) throw new Error('Incomplete step response');
        const elapsed_ms=Math.round(performance.now()-t);
        return {...response,elapsed_ms};
      }
      const response=await say(step.say);
      const row={say:step.say,...response};
      log.steps.push(row);
      if(response.status==='needs_clarification' && typeof step.answer==='string') {
        row.answer=step.answer;
        row.resolution=await say(step.answer);
      }
      const final=row.resolution||row;
      await save();
      if(step.expect && response.status!==step.expect) throw new Error('Step '+(i+1)+' expected '+step.expect+' but received '+response.status);
      if(step.expect_answer && final.status!==step.expect_answer) throw new Error('Unexpected clarification result at step '+(i+1));
      if(/^render[.!]?$/i.test(step.say.trim()) && final.status==='applied') {await render();renderedHash=final.timeline_hash;}
    }
    const snapshot=await client.request(session);
    await jsonFile(path.join(destination,'timeline.json'),snapshot.timeline ?? snapshot.state);
    if(renderedHash!==snapshot.timeline_hash) await render();
    await client.download(session+'/timeline.otio',path.join(destination,'timeline.otio'));
    log.timeline_hash=snapshot.timeline_hash;
    log.outcome='completed'; await save();
    return log;
  } catch(error) {
    log.outcome='failed'; log.error=error.message; await save(); throw error;
  }
}

async function main() {
  const {values,positionals:args}=parseArgs({allowPositionals:true,options:{in:{type:'string'},out:{type:'string'},base:{type:'string'},'timeout-s':{type:'string'},help:{type:'boolean'}}});
  if(values.help) { console.log('npm run session -- --in sessions/ --out results/ --base http://localhost:3000 [--timeout-s 1800]');return; }
  const input=values.in||args[0], out=values.out||args[1];
  if(!input||!out) throw new Error('Set --in to a YAML/JSON session file or folder and --out to a new results folder.');
  const timeout=Number(values['timeout-s']||1800)*1000;
  if(!Number.isFinite(timeout)||timeout<=0) throw new Error('Provide a positive job timeout');
  const files=(await stat(input)).isDirectory()?(await readdir(input,{withFileTypes:true})).filter(d=>d.isFile()&&/\.(ya?ml|json)$/i.test(d.name)).map(d=>path.join(input,d.name)).sort():[input];
  if(!files.length) throw new Error('No sessions found');
  const client=await connect(values.base||process.env.EDITMIND_API_URL||'http://localhost:3000',process.env.EDITMIND_GUEST_ID);
  const index=[];
  await mkdir(out,{recursive:true});
  for(const file of files){
    const slug=path.basename(file).replace(/\.(ya?ml|json)$/i,'');
    try {
      const spec=parse(await readFile(file,'utf8'),{maxAliasCount:32});
      const log=await runSession(client,spec,path.dirname(file),path.join(out,slug),timeout);
      index.push({session:slug,outcome:log.outcome,results:slug+'/results.json'});
      console.log(slug,log.outcome,log.steps.length+' steps');
    } catch(error) {index.push({session:slug,outcome:'failed',error:error.message});console.error(slug,error.message);process.exitCode=1;}
    await jsonFile(path.join(out,'index.json'),index);
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(e=>{console.error(e.message);process.exitCode=1;});
