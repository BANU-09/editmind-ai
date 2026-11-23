import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import build from '../.media-worker/revision.json' with { type: 'json' };
import sdk from '../.media-worker/sdk.cjs';
const { Drive, Sandbox } = sdk;

let pending;
let ready;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function workerEnvironment() {
  const names=['EDITMIND_PLANNER_URL','EDITMIND_PUBLIC_ORIGIN','STT_PROVIDER','STT_CONCURRENCY',
    'STT_WHISPER_MODEL','CORS_ORIGIN','API_WRITES_PER_MINUTE','COMPUTE_USD_PER_HOUR',
    'CALLBACK_ALLOWED_URLS','CALLBACK_HMAC_SECRET','S3_BUCKET','S3_REGION','S3_ENDPOINT'];
  const env=Object.fromEntries(names.filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  if (env.S3_BUCKET) {
    for (const [key,setting] of Object.entries({
      AWS_ACCESS_KEY_ID:'EDITMIND_S3_ACCESS_KEY_ID',AWS_SECRET_ACCESS_KEY:'EDITMIND_S3_SECRET_ACCESS_KEY',
      AWS_SESSION_TOKEN:'EDITMIND_S3_SESSION_TOKEN',
    })) if (process.env[setting]) env[key]=process.env[setting];
  }
  return env;
}

async function health(origin) {
  try {
    const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(3500) });
    return response.ok ? await response.json() : null;
  } catch { return null; }
}

async function startBackend() {
  const drive = await Drive.getOrCreate({ name: 'editmind-project-data' });
  const sandbox = await Sandbox.getOrCreate({
    name: 'editmind-media', ports: [3000], image: 'vercel/sandbox/node:24',
    resources: { vcpus: 2 }, timeout: 45 * 60 * 1000,
    persistent: true, keepLastSnapshots: { count: 1 },
    mounts: { '/mnt/editmind': drive }
  });
  // Renew only when the running session is being used near its time limit.
  if (sandbox.expiresAt && sandbox.expiresAt.getTime()-Date.now()<6*60_000) {
    await sandbox.extendTimeout(8*60_000).catch(()=>{});
  }
  const origin = sandbox.domain(3000);
  const old=await health(origin);
  if (old?.ok && old.mediaRevision!==build.revision) {
    // Preserve in-flight work when updating an already running media server.
    const upgrade=await sandbox.runCommand({cmd:'bash',args:['-c',String.raw`set -eu
for pid in $(pgrep -f '^node server[.]mjs$'); do
  dir=$(readlink /proc/$pid/cwd)
  case "$dir" in */editmind-*) ;; *) continue ;; esac
  cd "$dir"
  node --input-type=module -e "import DB from 'better-sqlite3';const db=new DB('/mnt/editmind/storage/editmind.db',{readonly:true});const active=db.prepare(\"SELECT COUNT(*) n FROM analysis_jobs WHERE status IN ('queued','extracting-audio','transcribing','aligning','generating-captions')\").get().n+db.prepare(\"SELECT COUNT(*) n FROM exports WHERE status IN ('queued','rendering','validating')\").get().n;process.exit(active?42:0)"
  kill -TERM "$pid"
done` ]});
    if (upgrade.exitCode===42) return origin;
    if (upgrade.exitCode) throw new Error('Worker upgrade: '+(await upgrade.stderr()).slice(-350));
    await sleep(700);
  }
  if (old?.mediaRevision!==build.revision) {
    const archive = await readFile('.media-worker/runtime.tgz');
    const release = createHash('sha256').update(archive).digest('hex').slice(0, 16);
    const cwd = (await (await sandbox.runCommand('pwd')).stdout()).trim();
    const dir = cwd + '/editmind-' + release;
    const mkdir = await sandbox.runCommand('mkdir', ['-p', dir]);
    if (mkdir.exitCode) throw new Error('Worker directory: ' + await mkdir.stderr());
    // Concurrent cold requests may target the same worker. Only one process
    // extracts and runs the trusted deployment bundle.
    const archivePath = dir + '/runtime-' + randomUUID() + '.tgz';
    await sandbox.writeFiles([{ path: archivePath, content: archive }]);
    const command = await sandbox.runCommand({
      cmd: 'flock', args: ['-n', '-E', '73', '/tmp/editmind-service.lock', 'bash', '-c',
        'set -e; cd "$1"; tar -xzf "$2"; rm -f "$2"; exec bash start.sh', 'editmind', dir, archivePath],
      env: workerEnvironment(), detached: true
    });
    for (let n = 0; n < 104; n++) {
      if ((await health(origin))?.mediaRevision===build.revision) return origin;
      if (n % 6 === 5) {
        const status = await sandbox.getCommand(command.cmdId);
        if (status.exitCode != null && status.exitCode !== 73) {
          console.error('Media startup:', (await status.stderr()).slice(-2500));
          throw new Error('Media worker startup failed');
        }
      }
      await sleep(1800);
    }
    throw new Error('Media worker is still starting');
  }
  return origin;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    if (req.query?.refresh === '1' || !ready || Date.now() >= ready.until) {
      pending ??= startBackend().finally(() => { pending = undefined; });
      const origin = await pending;
      ready = { origin, until: Date.now() + 15000 };
    }
    return res.json({ origin: ready.origin });
  } catch (error) {
    console.error('EditMind worker:', error.message);
    return res.status(503).json({ error: 'The media worker is starting or unavailable. Please retry.' });
  }
}
