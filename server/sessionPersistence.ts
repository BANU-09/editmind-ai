import {deflateRawSync,inflateRawSync} from 'node:zlib';
import {db} from './db';
import type {EditingSession} from './sessionEngine';

type Stored = Buffer|string;
type Current = Omit<EditingSession,'original'>;
type Row = {project_id:string;session_json:Stored;seq:number};
type Loaded = {session:EditingSession;size:number;hasOriginal:boolean};

export function createSessionStorage() {
  db.exec('CREATE TABLE IF NOT EXISTS edit_session_originals (session_id TEXT PRIMARY KEY REFERENCES edit_sessions(id) ON DELETE CASCADE, original_json BLOB NOT NULL)');
}

// Large transcripts and timelines compress well. Keep small records readable. SQLite
// supports both BLOB and TEXT values in the existing column, including legacy JSON.
function pack(json:string):Stored {
  return json.length<65536?json:deflateRawSync(json,{level:1});
}
function unpack(value:Stored) {
  return Buffer.isBuffer(value)?inflateRawSync(value).toString('utf8'):value;
}
const cache=new Map<string,{seq:number;owner:string;data:Loaded}>();
let cacheBytes=0;
const maxCacheBytes=32*1024*1024;
function remember(id:string,owner:string,seq:number,data:Loaded) {
  const old=cache.get(id);
  if(old){cache.delete(id);cacheBytes-=old.data.size;}
  if(data.size>maxCacheBytes)return;
  while(cache.size>=4 || cacheBytes+data.size>maxCacheBytes) {
    const first=cache.keys().next().value;
    if(!first)break;
    cacheBytes-=cache.get(first)!.data.size;
    cache.delete(first);
  }
  cache.set(id,{seq,owner,data});cacheBytes+=data.size;
}

export function findSessionRow(id:string,owner:string) {
  return db.prepare('SELECT project_id,session_json,(SELECT COALESCE(MAX(seq),0) FROM edit_steps WHERE session_id=s.id) AS seq FROM edit_sessions s WHERE id=? AND owner=?').get(id,owner) as Row|undefined;
}
export function loadSession(id:string,owner:string,row:Row):Loaded {
  const entry=cache.get(id);
  if(entry && entry.owner===owner && entry.seq===row.seq)return entry.data;
  const json=unpack(row.session_json);
  const value=JSON.parse(json) as Current & {original?:EditingSession['original']};
  if(value.original){
    const data={session:value as EditingSession,size:Buffer.byteLength(json),hasOriginal:false};
    remember(id,owner,row.seq,data);
    return data;
  }
  const saved=db.prepare('SELECT original_json FROM edit_session_originals WHERE session_id=?').get(id) as {original_json:Stored};
  const originalJson=unpack(saved.original_json);
  const data={session:{...value,original:JSON.parse(originalJson)},size:Buffer.byteLength(json)+Buffer.byteLength(originalJson),hasOriginal:true};
  remember(id,owner,row.seq,data);return data;
}
function writeOriginal(id:string,session:EditingSession) {
  const json=JSON.stringify(session.original);
  db.prepare('INSERT INTO edit_session_originals(session_id,original_json) VALUES(?,?)').run(id,pack(json));
  return Buffer.byteLength(json);
}
export function insertSession(id:string,owner:string,projectId:string,session:EditingSession,created:string) {
  const {original,...current}=session;
  const json=JSON.stringify(current);
  db.prepare('INSERT INTO edit_sessions(id,owner,project_id,session_json,created_at) VALUES(?,?,?,?,?)').run(id,owner,projectId,pack(json),created);
  writeOriginal(id,session);
}
export function persistStep(id:string,owner:string,seq:number,before:Loaded,next:EditingSession) {
  // Historical full-session rows move their original exactly once under this same transaction.
  let data=before;
  if (!before.hasOriginal || next!==before.session) {
    if(!before.hasOriginal)writeOriginal(id,next);
    const {original,...current}=next;
    const json=JSON.stringify(current);
    db.prepare('UPDATE edit_sessions SET session_json=? WHERE id=?').run(pack(json),id);
    data={session:next,size:Math.max(before.size,Buffer.byteLength(json)*2),hasOriginal:true};
  }
  // Cache only after the caller commits the new response and its idempotency record.
  return ()=>remember(id,owner,seq,data);
}

