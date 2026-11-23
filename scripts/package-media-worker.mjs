import {createHash} from 'node:crypto';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const output = path.resolve('.media-worker');
const payload = path.join(output, 'payload');
mkdirSync(payload, { recursive: true });
// Bundle the worker SDK's mixed ESM/CJS dependency graph before Vercel loads
// the function. Runtime tracing alone leaves an incompatible require(ESM).
await build({
  stdin: { contents: "export { Sandbox } from '@vercel/sandbox'; export { Drive } from '@vercel/drives';", resolveDir: process.cwd() },
  outfile: path.join(output, 'sdk.cjs'), platform: 'node', format: 'cjs', bundle: true, target: 'node24'
});
await build({ entryPoints: ['server.ts'], outfile: path.join(payload, 'server.mjs'),
  platform: 'node', format: 'esm', packages: 'external', bundle: true, target: 'node24' });
await build({entryPoints:['server/plannerResponse.ts'],outfile:path.join(output,'planner.cjs'),platform:'node',format:'cjs',bundle:true,target:'node24'});
cpSync('src/assets', path.join(payload, 'src/assets'), { recursive: true });
cpSync('openapi.yaml', path.join(payload, 'openapi.yaml'));
writeFileSync(path.join(payload,'start.sh'),readFileSync('scripts/start-media-worker.sh','utf8').replace(/\r\n/g,'\n'));
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const packages = ['@aws-sdk/client-s3', '@google/genai', '@huggingface/transformers', '@vercel/blob', 'bcryptjs',
  'better-sqlite3', 'dotenv', 'express', 'multer', 'uuid'];
const dependencies = Object.fromEntries(packages.map(name => [
  name, JSON.parse(readFileSync(path.join('node_modules', name, 'package.json'), 'utf8')).version
]));
writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ private: true, type: manifest.type, dependencies }));
const hash=createHash('sha256');
for (const file of ['server.mjs','start.sh','package.json','openapi.yaml']) hash.update(readFileSync(path.join(payload,file)));
const revision=hash.digest('hex').slice(0,16);
writeFileSync(path.join(payload,'revision'),revision);
writeFileSync(path.join(output,'revision.json'),JSON.stringify({revision}));
execFileSync('tar', ['-czf', path.join(output, 'runtime.tgz'), '-C', payload, '.']);
