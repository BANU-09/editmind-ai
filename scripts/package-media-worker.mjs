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
cpSync('src/assets', path.join(payload, 'src/assets'), { recursive: true });
cpSync('scripts/start-media-worker.sh', path.join(payload, 'start.sh'));
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const packages = ['@google/genai', '@huggingface/transformers', '@vercel/blob', 'bcryptjs',
  'better-sqlite3', 'dotenv', 'express', 'multer', 'uuid'];
const dependencies = Object.fromEntries(packages.map(name => [
  name, JSON.parse(readFileSync(path.join('node_modules', name, 'package.json'), 'utf8')).version
]));
writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ private: true, type: manifest.type, dependencies }));
execFileSync('tar', ['-czf', path.join(output, 'runtime.tgz'), '-C', payload, '.']);
