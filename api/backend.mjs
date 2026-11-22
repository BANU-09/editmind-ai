import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import sdk from '../.media-worker/sdk.cjs';
const { Drive, Sandbox } = sdk;

let pending;
let ready;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function healthy(origin) {
  try {
    const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(3500) });
    return response.ok && (await response.json()).ok === true;
  } catch { return false; }
}

async function startBackend() {
  const drive = await Drive.getOrCreate({ name: 'editmind-project-data' });
  const sandbox = await Sandbox.getOrCreate({
    name: 'editmind-media', ports: [3000], image: 'vercel/sandbox/node:24',
    resources: { vcpus: 2 }, timeout: 45 * 60 * 1000,
    persistent: true, keepLastSnapshots: { count: 1 },
    mounts: { '/mnt/editmind': drive }
  });
  const origin = sandbox.domain(3000);
  if (!await healthy(origin)) {
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
      detached: true
    });
    for (let n = 0; n < 104; n++) {
      if (await healthy(origin)) return origin;
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
    if (!ready || Date.now() >= ready.until) {
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
