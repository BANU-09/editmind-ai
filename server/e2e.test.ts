import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const BASE_URL = 'http://localhost:3000';
const GUEST_ID = `test-guest-${Date.now()}`;

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE_URL}/api/health`);
      if (r.ok) return;
    } catch {
      // wait
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('Server did not become healthy in time');
}

test('full backend E2E: demos, real video upload (unique mediaId), AI prompt plan, ambiguity, protection, 3 versions, and FFmpeg MP4 export', async () => {
  await waitForServer();

  // 1. Verify 5 real demo videos exist and stream properly
  const demosRes = await fetch(`${BASE_URL}/api/demos`);
  assert.equal(demosRes.status, 200);
  const { demos } = (await demosRes.json()) as { demos: Array<{ id: string; title: string; durationSec: number }> };
  assert.equal(demos.length, 5);
  for (const d of demos) {
    const vidHead = await fetch(`${BASE_URL}/api/demos/${d.id}/video`, {
      headers: { Range: 'bytes=0-1023' },
    });
    assert.equal(vidHead.status, 206);
  }

  // 2. Create project from demo-keynote and test prompt editing + ambiguity + protection + versions
  const demoProjRes = await fetch(`${BASE_URL}/api/projects/from-demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-guest-id': GUEST_ID },
    body: JSON.stringify({ demoId: 'demo-keynote' }),
  });
  assert.equal(demoProjRes.status, 200);
  const { project: keynoteProj } = await demoProjRes.json();
  assert.equal(keynoteProj.mediaId, 'demo-keynote');

  // Ambiguous prompt ("Remove pricing") should ask clarification, not guess silently
  const ambRes = await fetch(`${BASE_URL}/api/ai/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-guest-id': GUEST_ID },
    body: JSON.stringify({
      projectId: keynoteProj.id,
      prompt: 'Remove pricing',
      currentState: keynoteProj.state,
    }),
  });
  const ambData = await ambRes.json();
  assert.equal(ambData.plan.requiresClarification, true);
  assert.ok(ambData.plan.candidates.length >= 2);

  // Specific prompt ("Remove the second mention of pricing.") should target single segment cleanly
  const secRes = await fetch(`${BASE_URL}/api/ai/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-guest-id': GUEST_ID },
    body: JSON.stringify({
      projectId: keynoteProj.id,
      prompt: 'Remove the second mention of pricing.',
      currentState: keynoteProj.state,
    }),
  });
  const secData = await secRes.json();
  assert.equal(secData.plan.requiresClarification, undefined);
  assert.equal(secData.plan.operations.length, 1);
  assert.equal(secData.plan.operations[0].type, 'REMOVE_RANGE');

  // Protected content collision ("Remove the product demonstration")
  const protRes = await fetch(`${BASE_URL}/api/ai/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-guest-id': GUEST_ID },
    body: JSON.stringify({
      projectId: keynoteProj.id,
      prompt: 'Remove the live demonstration',
      currentState: keynoteProj.state,
    }),
  });
  const protData = await protRes.json();
  assert.equal(protData.impact.hasProtectedCollision, true);

  // 3 distinct versions
  assert.equal(keynoteProj.versions.length, 3);
  assert.notEqual(keynoteProj.versions[0].durationSec, keynoteProj.versions[2].durationSec);

  // 3. Generate a distinct synthetic user video (6s, unique resolution 640x360) & upload it
  const tmpUpload = path.resolve(process.cwd(), 'storage', 'test_user_upload.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=6:size=640x360:rate=24',
    '-f',
    'lavfi',
    '-i',
    "flite=text='User custom upload test clip':voice=kal16",
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    tmpUpload,
  ]);

  const fileBuf = fs.readFileSync(tmpUpload);
  const form = new FormData();
  form.append('video', new Blob([fileBuf], { type: 'video/mp4' }), 'user-custom-clip.mp4');
  form.append('sourceType', 'upload');
  form.append('title', 'Custom User Clip');

  const uploadRes = await fetch(`${BASE_URL}/api/media/ingest`, {
    method: 'POST',
    headers: { 'x-guest-id': GUEST_ID },
    body: form,
  });
  assert.equal(uploadRes.status, 200);
  const { project: uploadedProj } = await uploadRes.json();
  fs.rmSync(tmpUpload, { force: true });

  // CRITICAL CHECK: uploaded video MUST keep its own unique mediaId and NEVER substitute demo media
  assert.ok(uploadedProj.mediaId.startsWith('med-'));
  assert.notEqual(uploadedProj.mediaId, 'demo-keynote');
  assert.equal(uploadedProj.media.sourceType, 'upload');
  assert.equal(uploadedProj.media.filename, 'user-custom-clip.mp4');
  assert.equal(uploadedProj.media.width, 640);
  assert.equal(uploadedProj.media.height, 360);

  // 4. Real FFmpeg MP4 Export on the edited project (keep first 3.5s at 1.5x speed with yellow captions)
  const editedState = {
    ...uploadedProj.state,
    captionsEnabled: true,
    captionStyle: { ...uploadedProj.state.captionStyle, color: '#FACC15' },
    segments: [
      {
        ...uploadedProj.state.segments[0],
        sourceStart: 0,
        sourceEnd: 3.5,
        speed: 1.5,
        timelineStart: 0,
        timelineEnd: 2.333,
      },
    ],
    duration: 2.333,
  };

  const expStartRes = await fetch(`${BASE_URL}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-guest-id': GUEST_ID },
    body: JSON.stringify({
      projectId: uploadedProj.id,
      state: editedState,
      resolution: '480p',
      quality: 'fast',
    }),
  });
  assert.equal(expStartRes.status, 200);
  const { job: initialJob } = await expStartRes.json();

  let finalJob = initialJob;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const pollRes = await fetch(`${BASE_URL}/api/exports/${initialJob.id}`);
    const pollData = await pollRes.json();
    finalJob = pollData.job;
    if (finalJob.status === 'completed' || finalJob.status === 'failed') break;
  }

  assert.equal(finalJob.status, 'completed', `Export failed: ${finalJob.error}`);
  assert.ok(finalJob.fileSizeBytes > 1024);
  assert.ok(finalJob.durationSec > 1.5 && finalJob.durationSec < 3.0);

  const dlRes = await fetch(`${BASE_URL}${finalJob.outputUrl}`);
  assert.equal(dlRes.status, 200);
  const dlBytes = await dlRes.arrayBuffer();
  assert.ok(dlBytes.byteLength > 1024);

  // 5. CRITICAL HONESTY CHECK: No-audio uploaded video must report 'no-audio' and empty transcript (ZERO fake text!)
  const tmpSilent = path.resolve(process.cwd(), 'storage', 'test_silent_upload.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=4:size=480x480:rate=24',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    tmpSilent,
  ]);
  const silentForm = new FormData();
  silentForm.append('video', new Blob([fs.readFileSync(tmpSilent)], { type: 'video/mp4' }), 'silent-square.mp4');
  silentForm.append('sourceType', 'upload');
  silentForm.append('title', 'Silent Square Clip');

  const silentRes = await fetch(`${BASE_URL}/api/media/ingest`, {
    method: 'POST',
    headers: { 'x-guest-id': GUEST_ID },
    body: silentForm,
  });
  fs.rmSync(tmpSilent, { force: true });
  assert.equal(silentRes.status, 200);
  const { project: silentProj } = await silentRes.json();
  assert.equal(silentProj.media.hasAudio, false);
  assert.equal(silentProj.media.width, 480);
  assert.equal(silentProj.media.height, 480);
  assert.equal(silentProj.media.analysis.transcriptionStatus, 'no-audio');
  assert.equal(silentProj.media.analysis.transcript.length, 0);

  // Re-analyze endpoint works cleanly
  const reanalyzeRes = await fetch(`${BASE_URL}/api/media/${silentProj.mediaId}/reanalyze`, {
    method: 'POST',
    headers: { 'x-guest-id': GUEST_ID },
  });
  assert.equal(reanalyzeRes.status, 200);
  const reanalyzeData = await reanalyzeRes.json();
  assert.equal(reanalyzeData.analysis.transcriptionStatus, 'no-audio');

  // 6. CRITICAL ORIENTATION CHECK: Portrait 9:16 (720x1280) video + Custom WAV Music Upload + Word-mode Export
  const tmpPortrait = path.resolve(process.cwd(), 'storage', 'test_portrait_upload.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=5:size=720x1280:rate=24',
    '-f',
    'lavfi',
    '-i',
    "flite=text='Important announcement for creators today':voice=kal16",
    '-shortest',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    tmpPortrait,
  ]);
  const portraitForm = new FormData();
  portraitForm.append('video', new Blob([fs.readFileSync(tmpPortrait)], { type: 'video/mp4' }), 'portrait-reel.mp4');
  portraitForm.append('sourceType', 'upload');
  portraitForm.append('title', 'Portrait Reel');

  const portraitRes = await fetch(`${BASE_URL}/api/media/ingest`, {
    method: 'POST',
    headers: { 'x-guest-id': GUEST_ID },
    body: portraitForm,
  });
  fs.rmSync(tmpPortrait, { force: true });
  assert.equal(portraitRes.status, 200);
  const { project: portraitProj } = await portraitRes.json();
  assert.equal(portraitProj.media.width, 720);
  assert.equal(portraitProj.media.height, 1280);

  // Upload real custom WAV music track
  const tmpMusic = path.resolve(process.cwd(), 'storage', 'test_bgm.wav');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=4',
    tmpMusic,
  ]);
  const musicForm = new FormData();
  musicForm.append('audio', new Blob([fs.readFileSync(tmpMusic)], { type: 'audio/wav' }), 'custom-bed.wav');
  const musicUploadRes = await fetch(`${BASE_URL}/api/projects/${portraitProj.id}/music`, {
    method: 'POST',
    headers: { 'x-guest-id': GUEST_ID },
    body: musicForm,
  });
  fs.rmSync(tmpMusic, { force: true });
  assert.equal(musicUploadRes.status, 200);
  const musicMeta = await musicUploadRes.json();
  assert.ok(musicMeta.url.startsWith('/api/music/'));

  // Export portrait video with word-mode captions, mute range, bleep, and custom music -> verify output stays PORTRAIT!
  const portraitExportState = {
    ...portraitProj.state,
    captionsEnabled: true,
    captionStyle: { ...portraitProj.state.captionStyle, mode: 'word', color: '#FACC15' },
    muteRanges: [{ id: 'm1', sourceStart: 0.4, sourceEnd: 1.0, label: 'Mute test' }],
    bleeps: [{ id: 'b1', sourceStart: 1.2, sourceEnd: 1.6, label: 'Bleep test' }],
    audio: {
      ...portraitProj.state.audio,
      musicEnabled: true,
      musicPreset: 'custom-upload',
      customMusicUrl: musicMeta.url,
      customMusicName: musicMeta.filename,
      musicVolume: 0.25,
    },
  };

  const pExpStart = await fetch(`${BASE_URL}/api/exports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-guest-id': GUEST_ID },
    body: JSON.stringify({
      projectId: portraitProj.id,
      state: portraitExportState,
      resolution: '720p',
      quality: 'fast',
    }),
  });
  assert.equal(pExpStart.status, 200);
  const { job: pJobInit } = await pExpStart.json();

  let pJobFinal = pJobInit;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 400));
    const pollRes = await fetch(`${BASE_URL}/api/exports/${pJobInit.id}`);
    const pollData = await pollRes.json();
    pJobFinal = pollData.job;
    if (pJobFinal.status === 'completed' || pJobFinal.status === 'failed') break;
  }
  assert.equal(pJobFinal.status, 'completed', `Portrait export failed: ${pJobFinal.error}`);

  // Verify portrait exported MP4 dimensions with ffprobe!
  const dlPortraitRes = await fetch(`${BASE_URL}${pJobFinal.outputUrl}`);
  assert.equal(dlPortraitRes.status, 200);
  const tmpExportCheck = path.resolve(process.cwd(), 'storage', 'test_portrait_out.mp4');
  fs.writeFileSync(tmpExportCheck, Buffer.from(await dlPortraitRes.arrayBuffer()));
  const { stdout: probeOut } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0:s=x',
    tmpExportCheck,
  ]);
  fs.rmSync(tmpExportCheck, { force: true });
  const [expW, expH] = probeOut.trim().split('x').map(Number);
  assert.ok(expH > expW, `Expected portrait output height > width, got ${expW}x${expH}`);
});

