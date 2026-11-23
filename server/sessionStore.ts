import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {S3Client, CreateBucketCommand, HeadBucketCommand, GetObjectCommand, PutObjectCommand} from '@aws-sdk/client-s3';

const bucket=process.env.S3_BUCKET?.trim();
const endpoint=process.env.S3_ENDPOINT?.trim();
const region=process.env.S3_REGION || 'us-east-1';
const client=bucket ? new S3Client({
  region, endpoint: endpoint || undefined, forcePathStyle: Boolean(endpoint),
  requestChecksumCalculation:'WHEN_REQUIRED',
}) : undefined;

let prepared:Promise<void>|undefined;
export function objectStore() { return client ? 's3' : 'filesystem'; }
export async function readyStore():Promise<void> {
  if (!client || !bucket) return;
  if (!prepared) prepared=(async()=>{
    try { await client.send(new HeadBucketCommand({Bucket:bucket})); }
    catch(err) {
      if (process.env.S3_CREATE_BUCKET!=='1' || (err as any)?.$metadata?.httpStatusCode!==404) throw err;
      try {await client.send(new CreateBucketCommand({Bucket:bucket,...(region==='us-east-1'?{}:{CreateBucketConfiguration:{LocationConstraint:region as any}})}));}
      catch(e) {if((e as Error).name!=='BucketAlreadyOwnedByYou') throw e;}
    }
  })().catch(e=>{prepared=undefined;throw e;});
  return prepared;
}
export async function probeStore() {
  await readyStore();
  if (client && bucket) await client.send(new HeadBucketCommand({Bucket:bucket}));
}
export async function saveFile(key:string, file:string, contentType:string) {
  if (!client || !bucket) return;
  await readyStore();
  const size=await stat(file);
  await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:createReadStream(file),ContentLength:size.size,ContentType:contentType}));
}
export async function saveJson(key:string, data:unknown) {
  if (!client || !bucket) return;
  await readyStore();
  await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:JSON.stringify(data),ContentType:'application/json'}));
}
export async function getObject(key:string) {
  if (!client || !bucket) throw new Error('Object storage is not configured');
  const obj=await client.send(new GetObjectCommand({Bucket:bucket,Key:key}));
  return {stream:obj.Body as Readable,size:obj.ContentLength};
}

