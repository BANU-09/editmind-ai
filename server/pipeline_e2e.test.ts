import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { promisify } from 'node:util';
import { v4 as uuid } from 'uuid';
import {
  applyEditPlan,
  createInitialProjectState,
  searchMediaIndex,
} from '../src/shared/timelineEngine';
import type { MediaAnalysis } from '../src/shared/types';
import { normalizePromptSpacing, planEditFromPrompt } from './aiEditor';
import { AUDIO_DIR, db, EXPORTS_DIR, THUMBS_DIR, UPLOADS_DIR } from './db';
import { runExportJob } from './exporter';
import {
  executeAnalysisJob,
  prepareFastMediaRecord,
  retryFailedJobChunks,
  startBackgroundAnalysisJob,
} from './mediaProcessor';
import {
  buildSrtSubtitles,
  buildVttSubtitles,
  deduplicateChunkWords,
  normalizeWordToken,
  planVoiceAwareChunks,
  updateAnalysisJobRow,
  applyManualWordCorrection,
  extractAudioSnippetWav,
  translateProjectTranscript,
} from './transcriber';
import { assertTrustedVercelBlobUrl } from './blobStorage';
import { getAppConfig, STRICT_MAX_UPLOAD_BYTES } from './config';
import { validateSafePublicHttpUrl } from './urlImporter';
import { isAuthorizedWorkerRequest } from './workerBridge';

const execFileAsync = promisify(execFile);
const TMP_DIR = path.resolve(process.cwd(), 'storage', '.test_media_tmp');
const createdMediaIds: string[] = [];
const createdProjectIds: string[] = [];
const createdJobIds: string[] = [];
const createdExportIds: string[] = [];

async function generateSpokenVideo(params: {
  outPath: string;
  text: string;
  sampleRate?: number;
  channels?: number;
  codecArgs?: string[];
  silentTailSec?: number;
  fps?: number;
}): Promise<void> {
  const sr = params.sampleRate ?? 16000;
  const ch = params.channels ?? 1;
  const fps = params.fps ?? 15;
  const wavTmp = `${params.outPath}.speech.wav`;

  // Synthesize real human-like English speech via FFmpeg's libflite filter
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `flite=text='${params.text.replace(/'/g, '')}'`,
    '-ar',
    String(sr),
    '-ac',
    String(ch),
    wavTmp,
  ]);

  const { stdout: durOut } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    wavTmp,
  ]);
  const speechDur = Math.max(2, parseFloat(durOut.trim()) || 4);
  const totalDur = speechDur + (params.silentTailSec ?? 0.5);

  const codecArgs = params.codecArgs ?? [
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
  ];

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=#0b1024:s=640x360:r=${fps}:d=${totalDur.toFixed(2)}`,
    '-i',
    wavTmp,
    '-af',
    `apad=whole_dur=${totalDur.toFixed(2)}`,
    ...codecArgs,
    '-shortest',
    params.outPath,
  ]);

  fs.rmSync(wavTmp, { force: true });
}

function registerTestMediaInDb(params: {
  mediaId: string;
  filename: string;
  mimeType: string;
  filePath: string;
  analysis: MediaAnalysis;
  thumbnailUrl: string;
}): string {
  const now = new Date().toISOString();
  const projectId = `prj-test-${uuid().slice(0, 8)}`;
  createdMediaIds.push(params.mediaId);
  createdProjectIds.push(projectId);

  db.prepare(
    `INSERT INTO media_assets
     (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, created_at)
     VALUES (?, NULL, 'test-suite', 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.mediaId,
    params.filename,
    params.mimeType,
    params.filePath,
    params.thumbnailUrl,
    params.analysis.durationSec,
    params.analysis.width,
    params.analysis.height,
    params.analysis.hasAudio ? 1 : 0,
    params.analysis.analysisMode,
    JSON.stringify(params.analysis),
    now,
  );

  const initialState = createInitialProjectState(params.analysis);
  db.prepare(
    `INSERT INTO projects
     (id, user_id, guest_token, title, media_id, thumbnail_url, state_json, history_json, history_index, versions_json, created_at, updated_at)
     VALUES (?, NULL, 'test-suite', ?, ?, ?, ?, '[]', 0, '[]', ?, ?)`,
  ).run(
    projectId,
    `Test ${params.filename}`,
    params.mediaId,
    params.thumbnailUrl,
    JSON.stringify(initialState),
    now,
    now,
  );

  return projectId;
}

describe('EDITMIND AI — Chunked Transcription, Recovery, Word Editing & Multi-Format Pipeline', () => {
  before(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    process.env.FORCE_LOCAL_STT = '1';
  });

  after(() => {
    delete process.env.FORCE_LOCAL_STT;
    for (const id of createdExportIds) {
      db.prepare('DELETE FROM exports WHERE id = ?').run(id);
      fs.rmSync(path.join(EXPORTS_DIR, `${id}.mp4`), { force: true });
    }
    for (const id of createdJobIds) {
      db.prepare('DELETE FROM transcription_chunks WHERE job_id = ?').run(id);
      db.prepare('DELETE FROM analysis_jobs WHERE id = ?').run(id);
    }
    for (const id of createdProjectIds) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }
    for (const id of createdMediaIds) {
      db.prepare('DELETE FROM transcription_chunks WHERE media_id = ?').run(id);
      db.prepare('DELETE FROM analysis_jobs WHERE media_id = ?').run(id);
      db.prepare('DELETE FROM media_assets WHERE id = ?').run(id);
      fs.rmSync(path.join(AUDIO_DIR, id), { recursive: true, force: true });
      fs.rmSync(path.join(THUMBS_DIR, `${id}.jpg`), { force: true });
    }
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('normalizes word tokens and concatenated prompts (REMOVETHEWORDCOMMUTE)', async () => {
    assert.equal(normalizeWordToken('COMMUTE,'), 'commute');
    assert.equal(normalizeWordToken('“Commute.”'), 'commute');
    assert.equal(normalizePromptSpacing('REMOVETHEWORDCOMMUTE'), 'remove the word commute');
    assert.equal(normalizePromptSpacing('Remove the word COMMUTE'), 'Remove the word COMMUTE');

    const baseAnalysis: MediaAnalysis = {
      mediaId: 'med-norm',
      durationSec: 12,
      width: 1280,
      height: 720,
      fps: 24,
      hasAudio: true,
      codec: 'h264',
      analysisMode: 'local-ffmpeg',
      analysisNote: '',
      transcriptionStatus: 'transcribing',
      chunkStats: { total: 4, completed: 1, failed: 0, processing: 2, pending: 1, retried: 0 },
      waveformPeaks: [],
      transcript: [],
      scenes: [],
      speakers: [],
      importantMoments: [],
      silences: [],
      fillers: [],
      topics: [],
      summary: '',
    };
    const emptyState = createInitialProjectState(baseAnalysis);

    // Transcribing state must be honestly reported, never "word not found"
    const inProgress = await planEditFromPrompt('Remove the word COMMUTE', emptyState, baseAnalysis);
    assert.match(inProgress.intentSummary, /still in progress/i);

    // Failed state must explain failure and mention retry
    const failedPlan = await planEditFromPrompt('Remove the word COMMUTE', emptyState, {
      ...baseAnalysis,
      transcriptionStatus: 'failed',
      transcriptionError: 'Worker crashed',
    });
    assert.match(failedPlan.intentSummary, /failed/i);
    assert.match(failedPlan.intentSummary, /retry/i);

    // No-audio state must clearly state no audio stream
    const noAudioPlan = await planEditFromPrompt('Remove the word COMMUTE', emptyState, {
      ...baseAnalysis,
      hasAudio: false,
      transcriptionStatus: 'no-audio',
    });
    assert.match(noAudioPlan.intentSummary, /no audio stream/i);
  });

  it('plans voice-aware chunks at silences and deduplicates seam overlaps without dropping duplicates elsewhere', () => {
    const silences = [
      { id: 's1', start: 23.0, end: 24.4, duration: 1.4 },
      { id: 's2', start: 47.0, end: 48.2, duration: 1.2 },
    ];
    const chunks = planVoiceAwareChunks(70, silences, {
      targetSec: 24,
      minSec: 12,
      maxSec: 30,
      overlapSec: 1.25,
    });
    assert.equal(chunks.length, 3);
    // Split near 23.7 midpoint +/- 1.25 overlap
    assert.ok(chunks[0].sourceEnd >= 24.0 && chunks[0].sourceEnd <= 25.5);
    assert.ok(chunks[1].sourceStart < chunks[0].sourceEnd);

    const deduped = deduplicateChunkWords([
      {
        chunkId: 'c0',
        chunkIndex: 0,
        sourceStart: 0,
        sourceEnd: 24.95,
        overlapBefore: 0,
        overlapAfter: 1.25,
        text: 'daily commute saves commute',
        language: 'en',
        provider: 'local-whisper',
        words: [
          { word: 'daily', start: 2.0, end: 2.4, confidence: 0.9, timingAccuracy: 'model-word' },
          { word: 'commute', start: 2.5, end: 2.9, confidence: 0.9, timingAccuracy: 'model-word' },
          { word: 'saves', start: 23.8, end: 24.2, confidence: 0.9, timingAccuracy: 'model-word' },
          { word: 'time', start: 24.3, end: 24.7, confidence: 0.9, timingAccuracy: 'model-word' },
        ],
      },
      {
        chunkId: 'c1',
        chunkIndex: 1,
        sourceStart: 22.45,
        sourceEnd: 48.8,
        overlapBefore: 1.25,
        overlapAfter: 1.25,
        text: 'saves time every commute',
        language: 'en',
        provider: 'local-whisper',
        words: [
          { word: 'saves', start: 23.82, end: 24.22, confidence: 0.9, timingAccuracy: 'model-word' },
          { word: 'time', start: 24.31, end: 24.72, confidence: 0.9, timingAccuracy: 'model-word' },
          { word: 'every', start: 26.0, end: 26.3, confidence: 0.9, timingAccuracy: 'model-word' },
          { word: 'commute', start: 26.4, end: 26.9, confidence: 0.9, timingAccuracy: 'model-word' },
        ],
      },
    ]);

    assert.deepEqual(
      deduped.map((w) => w.word),
      ['daily', 'commute', 'saves', 'time', 'every', 'commute'],
    );
  });

  it('transcribes real spoken MP4 containing "commute", supports search, word-level removal, SRT/VTT & real MP4 export', async () => {
    const vidPath = path.join(TMP_DIR, 'commute_short.mp4');
    await generateSpokenVideo({
      outPath: vidPath,
      text: 'Every morning commute saves time with automated workflows.',
      sampleRate: 16000,
      channels: 1,
    });

    const mediaId = `med-test-short-${uuid().slice(0, 6)}`;
    const prep = await prepareFastMediaRecord({
      mediaId,
      filePath: vidPath,
      filename: 'commute_short.mp4',
    });
    const projectId = registerTestMediaInDb({
      mediaId,
      filename: 'commute_short.mp4',
      mimeType: 'video/mp4',
      filePath: vidPath,
      analysis: prep.analysis,
      thumbnailUrl: prep.thumbnailUrl,
    });

    const { job, promise } = startBackgroundAnalysisJob({
      mediaId,
      projectId,
      options: { preferLocal: true },
    });
    createdJobIds.push(job.id);
    const analysis = await promise;

    assert.ok(analysis.transcript.length >= 1, 'Expected at least 1 transcript segment');
    assert.ok((analysis.wordCount || 0) >= 5, `Expected transcribed words, got ${analysis.wordCount}`);
    const fullText = analysis.transcript.map((t) => t.text).join(' ').toLowerCase();
    assert.match(fullText, /commute/, `Expected "commute" in transcript: "${fullText}"`);

    const state0 = createInitialProjectState(analysis);
    assert.ok(state0.captions.length >= 1, 'Captions must auto-generate');

    // Search "COMMUTE" case-insensitively
    const hitsUpper = searchMediaIndex(analysis, state0.segments, 'COMMUTE');
    assert.ok(hitsUpper.length >= 1, 'Search for "COMMUTE" must match spoken word');

    // Subtitles SRT & VTT
    const srt = buildSrtSubtitles(state0);
    const vtt = buildVttSubtitles(state0);
    assert.match(srt, /\d{2}:\d{2}:\d{2},\d{3} -->/);
    assert.match(vtt, /^WEBVTT/);
    assert.match(srt.toLowerCase(), /commute/);

    // Both spaced and space-stripped word-removal prompts resolve to single-word REMOVE_WORD
    const planConcat = await planEditFromPrompt('REMOVETHEWORDCOMMUTE', state0, analysis);
    assert.equal(planConcat.operations[0]?.type, 'REMOVE_WORD');

    const planSpaced = await planEditFromPrompt('Remove the word COMMUTE', state0, analysis);
    assert.equal(planSpaced.operations[0]?.type, 'REMOVE_WORD');

    const applied = applyEditPlan(state0, analysis, planSpaced);
    assert.ok(applied.appliedCount >= 1);
    assert.ok(
      applied.nextState.duration < state0.duration,
      `Expected edited timeline (${applied.nextState.duration}s) shorter than initial (${state0.duration}s)`,
    );
    const editedSrt = buildSrtSubtitles(applied.nextState);
    assert.ok(!editedSrt.toLowerCase().includes('commute'), 'Edited SRT captions must omit removed word');
    assert.ok(editedSrt.toLowerCase().includes('morning'), 'Surrounding words must remain in edited SRT');

    // Render real exported MP4 and confirm duration matches edited timeline
    const expId = `exp-test-${uuid().slice(0, 6)}`;
    createdExportIds.push(expId);
    db.prepare(
      `INSERT INTO exports (id, project_id, media_id, status, progress, resolution, quality, created_at)
       VALUES (?, ?, ?, 'queued', 0, '480p', 'fast', ?)`,
    ).run(expId, projectId, mediaId, new Date().toISOString());

    await runExportJob({
      jobId: expId,
      projectId,
      mediaId,
      sourceFilePath: vidPath,
      sourceHasAudio: true,
      selectedAudioStream: 0,
      state: applied.nextState,
      resolution: '480p',
      quality: 'fast',
    });

    const expRow = db.prepare('SELECT * FROM exports WHERE id = ?').get(expId) as Record<string, unknown>;
    assert.equal(expRow.status, 'completed');
    assert.ok(
      Math.abs(Number(expRow.duration_sec) - applied.nextState.duration) < 0.45,
      `Exported duration (${expRow.duration_sec}) should match edited timeline (${applied.nextState.duration})`,
    );
  });

  it('handles 10m30s video whose 16kHz PCM exceeds 18MB without failing inline limit', async () => {
    const startSpeechWav = path.join(TMP_DIR, 'start_10m.wav');
    const endSpeechWav = path.join(TMP_DIR, 'end_10m.wav');
    const fullAudioWav = path.join(TMP_DIR, 'full_630s.wav');
    const longVidPath = path.join(TMP_DIR, 'long_10m30s_commute.mp4');

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      "flite=text='Morning commute metrics confirm zero failures.'",
      '-ar',
      '16000',
      '-ac',
      '1',
      startSpeechWav,
    ]);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      "flite=text='Evening commute summary complete.'",
      '-ar',
      '16000',
      '-ac',
      '1',
      endSpeechWav,
    ]);

    // Assemble a genuine 630s (10m30s) audio track: speech at ~3s + ~600s digital silence + speech at ~608s
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-t',
      '2',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-i',
      startSpeechWav,
      '-f',
      'lavfi',
      '-t',
      '603',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-i',
      endSpeechWav,
      '-f',
      'lavfi',
      '-t',
      '15',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-filter_complex',
      '[0:a][1:a][2:a][3:a][4:a]concat=n=5:v=0:a=1[a]',
      '-map',
      '[a]',
      '-ar',
      '16000',
      '-ac',
      '1',
      fullAudioWav,
    ]);

    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=#080e24:s=320x180:r=5:d=630',
      '-i',
      fullAudioWav,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      '-shortest',
      longVidPath,
    ]);
    fs.rmSync(startSpeechWav, { force: true });
    fs.rmSync(endSpeechWav, { force: true });
    fs.rmSync(fullAudioWav, { force: true });

    const mediaId = `med-test-10m-${uuid().slice(0, 6)}`;
    const prep = await prepareFastMediaRecord({
      mediaId,
      filePath: longVidPath,
      filename: 'long_10m30s_commute.mp4',
    });
    const projectId = registerTestMediaInDb({
      mediaId,
      filename: 'long_10m30s_commute.mp4',
      mimeType: 'video/mp4',
      filePath: longVidPath,
      analysis: prep.analysis,
      thumbnailUrl: prep.thumbnailUrl,
    });

    const { job, promise } = startBackgroundAnalysisJob({
      mediaId,
      projectId,
      options: { preferLocal: true, concurrency: 2 },
    });
    createdJobIds.push(job.id);
    const analysis = await promise;

    // Verify extracted 16kHz PCM on disk genuinely exceeds 18 MB (proving old 18MB inline failure is bypassed)
    const masterWav = path.join(AUDIO_DIR, mediaId, 'stream_0_16k.wav');
    assert.ok(fs.existsSync(masterWav), 'Expected persistent 16kHz WAV on disk');
    const wavBytes = fs.statSync(masterWav).size;
    assert.ok(wavBytes > 19 * 1024 * 1024, `Expected 16kHz WAV > 19 MB, got ${(wavBytes / (1024 * 1024)).toFixed(2)} MB`);

    assert.ok(analysis.chunkStats && analysis.chunkStats.total >= 20, `Expected >=20 chunks, got ${analysis.chunkStats?.total}`);
    assert.equal(analysis.chunkStats.failed, 0);
    assert.ok(analysis.transcriptionStatus === 'complete' || analysis.transcriptionStatus === 'local-fallback');

    const combinedText = analysis.transcript.map((s) => s.text).join(' ').toLowerCase();
    assert.match(combinedText, /commute/, 'Long 10m30s transcript must include "commute"');
  });

  it('handles 44.1kHz stereo MOV, 48kHz WebM, multi-audio-stream selection, silent no-audio MP4, and retryFailedJobChunks recovery', async () => {
    // 1) 44.1kHz stereo MOV
    const movPath = path.join(TMP_DIR, 'stereo_44k.mov');
    await generateSpokenVideo({
      outPath: movPath,
      text: 'Every morning commute saves time.',
      sampleRate: 44100,
      channels: 2,
      codecArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'],
    });
    const movId = `med-test-mov-${uuid().slice(0, 6)}`;
    const movPrep = await prepareFastMediaRecord({ mediaId: movId, filePath: movPath, filename: 'stereo_44k.mov' });
    const movPrj = registerTestMediaInDb({ mediaId: movId, filename: 'stereo_44k.mov', mimeType: 'video/quicktime', filePath: movPath, analysis: movPrep.analysis, thumbnailUrl: movPrep.thumbnailUrl });
    const movJob = startBackgroundAnalysisJob({ mediaId: movId, projectId: movPrj, options: { preferLocal: true } });
    createdJobIds.push(movJob.job.id);
    const movRes = await movJob.promise;
    assert.match(movRes.transcript.map((s) => s.text).join(' ').toLowerCase(), /commute/);

    // 2) 48kHz WebM (VP8 + Opus)
    const webmPath = path.join(TMP_DIR, 'opus_48k.webm');
    await generateSpokenVideo({
      outPath: webmPath,
      text: 'Every morning commute saves time with automated workflows.',
      sampleRate: 48000,
      channels: 1,
      codecArgs: ['-c:v', 'libvpx', '-deadline', 'realtime', '-c:a', 'libopus'],
    });
    const webmId = `med-test-webm-${uuid().slice(0, 6)}`;
    const webmPrep = await prepareFastMediaRecord({ mediaId: webmId, filePath: webmPath, filename: 'opus_48k.webm' });
    const webmPrj = registerTestMediaInDb({ mediaId: webmId, filename: 'opus_48k.webm', mimeType: 'video/webm', filePath: webmPath, analysis: webmPrep.analysis, thumbnailUrl: webmPrep.thumbnailUrl });
    const webmJob = startBackgroundAnalysisJob({ mediaId: webmId, projectId: webmPrj, options: { preferLocal: true } });
    createdJobIds.push(webmJob.job.id);
    const webmRes = await webmJob.promise;
    assert.match(webmRes.transcript.map((s) => s.text).join(' ').toLowerCase(), /commute/);

    // 3) Multi-audio-stream MP4 (Track 0 = "Alpha beta", Track 1 = "Commute priority")
    const wav0 = path.join(TMP_DIR, 'track0.wav');
    const wav1 = path.join(TMP_DIR, 'track1.wav');
    const dualPath = path.join(TMP_DIR, 'dual_audio.mp4');
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', "flite=text='Track zero alpha channel.'", '-ar', '16000', '-ac', '1', wav0]);
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', "flite=text='Every morning commute saves time.'", '-ar', '16000', '-ac', '1', wav1]);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=#111827:s=640x360:r=15:d=4',
      '-i',
      wav0,
      '-i',
      wav1,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      dualPath,
    ]);
    fs.rmSync(wav0, { force: true });
    fs.rmSync(wav1, { force: true });

    const dualId = `med-test-dual-${uuid().slice(0, 6)}`;
    const dualPrep = await prepareFastMediaRecord({ mediaId: dualId, filePath: dualPath, filename: 'dual_audio.mp4', audioStreamIndex: 1 });
    assert.equal(dualPrep.analysis.detectedAudioStreams, 2);
    const dualPrj = registerTestMediaInDb({ mediaId: dualId, filename: 'dual_audio.mp4', mimeType: 'video/mp4', filePath: dualPath, analysis: dualPrep.analysis, thumbnailUrl: dualPrep.thumbnailUrl });
    const dualJob = startBackgroundAnalysisJob({ mediaId: dualId, projectId: dualPrj, audioStreamIndex: 1, options: { preferLocal: true } });
    createdJobIds.push(dualJob.job.id);
    const dualRes = await dualJob.promise;
    assert.match(dualRes.transcript.map((s) => s.text).join(' ').toLowerCase(), /commute/);

    // 4) Silent / No-audio MP4
    const silentPath = path.join(TMP_DIR, 'silent.mp4');
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=#0f172a:s=640x360:r=15:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', silentPath]);
    const silId = `med-test-sil-${uuid().slice(0, 6)}`;
    const silPrep = await prepareFastMediaRecord({ mediaId: silId, filePath: silentPath, filename: 'silent.mp4' });
    assert.equal(silPrep.analysis.hasAudio, false);
    assert.equal(silPrep.analysis.transcriptionStatus, 'no-audio');
    const silPrj = registerTestMediaInDb({ mediaId: silId, filename: 'silent.mp4', mimeType: 'video/mp4', filePath: silentPath, analysis: silPrep.analysis, thumbnailUrl: silPrep.thumbnailUrl });
    const silJob = startBackgroundAnalysisJob({ mediaId: silId, projectId: silPrj });
    createdJobIds.push(silJob.job.id);
    const silRes = await silJob.promise;
    assert.equal(silRes.transcriptionStatus, 'no-audio');

    // 5) Chunk Failure Simulation -> Partial Status -> Retry Failed Chunks Only
    const twoChunkWav = path.join(TMP_DIR, 'two_chunk.wav');
    const twoChunkVid = path.join(TMP_DIR, 'two_chunk.mp4');
    const partA = path.join(TMP_DIR, 'partA.wav');
    const partB = path.join(TMP_DIR, 'partB.wav');
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', "flite=text='Opening section ready.'", '-ar', '16000', '-ac', '1', partA]);
    await execFileAsync('ffmpeg', ['-y', '-f', 'lavfi', '-i', "flite=text='Every morning commute saves time.'", '-ar', '16000', '-ac', '1', partB]);
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      partA,
      '-f',
      'lavfi',
      '-t',
      '26',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-i',
      partB,
      '-f',
      'lavfi',
      '-t',
      '4',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-filter_complex',
      '[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1[a]',
      '-map',
      '[a]',
      twoChunkWav,
    ]);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=#050711:s=320x180:r=5:d=36',
      '-i',
      twoChunkWav,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      twoChunkVid,
    ]);
    fs.rmSync(partA, { force: true });
    fs.rmSync(partB, { force: true });
    fs.rmSync(twoChunkWav, { force: true });

    const recId = `med-test-recov-${uuid().slice(0, 6)}`;
    const recPrep = await prepareFastMediaRecord({ mediaId: recId, filePath: twoChunkVid, filename: 'two_chunk.mp4' });
    const recPrj = registerTestMediaInDb({ mediaId: recId, filename: 'two_chunk.mp4', mimeType: 'video/mp4', filePath: twoChunkVid, analysis: recPrep.analysis, thumbnailUrl: recPrep.thumbnailUrl });

    const recJobId = `job-test-recov-${uuid().slice(0, 6)}`;
    createdJobIds.push(recJobId);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO analysis_jobs
       (id, media_id, project_id, selected_audio_stream, status, overall_progress, audio_extraction_status, transcription_status, chunk_total, chunk_completed, chunk_failed, alignment_status, caption_status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'queued', 5, 'pending', 'pending', 0, 0, 0, 'pending', 'pending', ?, ?)`,
    ).run(recJobId, recId, recPrj, now, now);

    const partialAnalysis = await executeAnalysisJob(recJobId, {
      preferLocal: true,
      simulateFailChunkIndices: [1],
    });
    assert.equal(partialAnalysis.transcriptionStatus, 'partial');
    assert.equal(partialAnalysis.chunkStats?.failed, 1);
    assert.equal(partialAnalysis.chunkStats?.completed, 1);

    const c0Before = db
      .prepare('SELECT attempt_count FROM transcription_chunks WHERE job_id = ? AND chunk_index = 0')
      .get(recJobId) as { attempt_count: number };

    // Retry only failed chunks cleanly
    updateAnalysisJobRow(recJobId, { status: 'transcribing' });
    const recovered = await retryFailedJobChunks(recJobId, { preferLocal: true });
    assert.equal(recovered.chunkStats?.failed, 0);
    assert.equal(recovered.chunkStats?.completed, 2);

    const c0After = db
      .prepare('SELECT attempt_count FROM transcription_chunks WHERE job_id = ? AND chunk_index = 0')
      .get(recJobId) as { attempt_count: number };
    assert.equal(c0After.attempt_count, c0Before.attempt_count, 'Completed chunk 0 must NOT be re-processed when retrying failed chunk 1');

    const recoveredText = recovered.transcript.map((t) => t.text).join(' ').toLowerCase();
    assert.match(recoveredText, /commute/, 'Recovered chunk 1 must restore "commute" in full transcript');
  });

  it('enforces strict 2 GB upload cap and SSRF URL guards', async () => {
    const prevMax = process.env.MAX_UPLOAD_BYTES;
    try {
      process.env.MAX_UPLOAD_BYTES = String(10 * 1024 * 1024 * 1024); // Try setting 10 GB
      const cfg = getAppConfig();
      assert.equal(cfg.maxUploadBytes, STRICT_MAX_UPLOAD_BYTES, '2 GB cap must never be exceeded');
      assert.equal(cfg.maxUploadBytes, 2 * 1024 * 1024 * 1024);
    } finally {
      if (prevMax === undefined) delete process.env.MAX_UPLOAD_BYTES;
      else process.env.MAX_UPLOAD_BYTES = prevMax;
    }

    const prevPrivate = process.env.ALLOW_LOCALHOST_URL_IMPORT_FOR_TEST;
    delete process.env.ALLOW_LOCALHOST_URL_IMPORT_FOR_TEST;
    try {
      await assert.rejects(() => validateSafePublicHttpUrl('http://127.0.0.1:3000/video.mp4'), /private|loopback|local|blocked/i);
      await assert.rejects(() => validateSafePublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /private|loopback|local|blocked|link-local/i);
      await assert.rejects(() => validateSafePublicHttpUrl('http://192.168.1.50/clip.mp4'), /private|loopback|local|blocked/i);
      await assert.rejects(() => validateSafePublicHttpUrl('file:///etc/passwd'), /http/i);
    } finally {
      if (prevPrivate !== undefined) process.env.ALLOW_LOCALHOST_URL_IMPORT_FOR_TEST = prevPrivate;
    }

    // Verify Vercel Blob HTTPS + domain trust check
    assert.ok(assertTrustedVercelBlobUrl('https://abc123.public.blob.vercel-storage.com/video.mp4'));
    assert.throws(() => assertTrustedVercelBlobUrl('http://abc123.public.blob.vercel-storage.com/video.mp4'), /HTTPS/i);
    assert.throws(() => assertTrustedVercelBlobUrl('https://evil.example.com/video.mp4'), /untrusted/i);

    // Verify Worker shared-secret timing-safe check
    const prevSecret = process.env.WORKER_SHARED_SECRET;
    process.env.WORKER_SHARED_SECRET = 'super-secret-worker-key-123';
    try {
      assert.equal(isAuthorizedWorkerRequest('Bearer super-secret-worker-key-123', undefined), true);
      assert.equal(isAuthorizedWorkerRequest(undefined, 'super-secret-worker-key-123'), true);
      assert.equal(isAuthorizedWorkerRequest('Bearer wrong-key', undefined), false);
      assert.equal(isAuthorizedWorkerRequest(undefined, undefined), false);
    } finally {
      if (prevSecret === undefined) delete process.env.WORKER_SHARED_SECRET;
      else process.env.WORKER_SHARED_SECRET = prevSecret;
    }
  });

  it('supports manual word correction synced to captions/search, audio snippet WAV replay, and separate translation track', async () => {
    const vidPath = path.join(TMP_DIR, 'correction_test.mp4');
    await generateSpokenVideo({
      outPath: vidPath,
      text: 'Today our automated commute saves valuable time.',
      sampleRate: 16000,
      channels: 1,
    });

    const mediaId = `med-test-corr-${uuid().slice(0, 6)}`;
    const prep = await prepareFastMediaRecord({
      mediaId,
      filePath: vidPath,
      filename: 'correction_test.mp4',
    });
    const projectId = registerTestMediaInDb({
      mediaId,
      filename: 'correction_test.mp4',
      mimeType: 'video/mp4',
      filePath: vidPath,
      analysis: prep.analysis,
      thumbnailUrl: prep.thumbnailUrl,
    });

    const { job, promise } = startBackgroundAnalysisJob({
      mediaId,
      projectId,
      options: { preferLocal: true },
    });
    createdJobIds.push(job.id);
    const analysis = await promise;
    const firstWord = analysis.transcript[0]?.words?.[0];
    assert.ok(firstWord, 'Expected at least one word in transcript');

    // Verify snippet WAV extraction works cleanly for clicked word
    const snipWav = await extractAudioSnippetWav({
      mediaId,
      filePath: vidPath,
      audioStreamIndex: 0,
      startSec: firstWord.start,
      endSec: firstWord.end,
    });
    assert.ok(fs.existsSync(snipWav));
    assert.ok(fs.statSync(snipWav).size > 44);
    fs.rmSync(snipWav, { force: true });

    // Apply manual word correction & confirm audit trail + captions + search stay in sync
    const corrected = applyManualWordCorrection({
      projectId,
      wordId: firstWord.id,
      newWord: 'IncuBrix',
    });
    assert.equal(corrected.updatedWord.word, 'IncuBrix');
    assert.equal(corrected.updatedWord.verificationStatus, 'verified');
    assert.equal(corrected.updatedWord.manuallyEdited, true);
    assert.ok(corrected.projectState.captions[0]?.text.includes('IncuBrix'));
    const hits = searchMediaIndex(corrected.analysis, corrected.projectState.segments, 'IncuBrix');
    assert.ok(hits.length >= 1, 'Corrected word must be immediately searchable');

    // Create optional separate translation track without overwriting original transcript
    const tr = await translateProjectTranscript({
      projectId,
      targetLanguage: 'es',
    });
    assert.equal(tr.track.language, 'es');
    assert.ok(tr.track.segments.length >= 1);
    assert.ok(tr.analysis.transcript[0]?.text.includes('IncuBrix'), 'Original transcript must remain preserved');
    const esSrt = buildSrtSubtitles(corrected.projectState, tr.track);
    assert.match(esSrt, /\d{2}:\d{2}:\d{2},\d{3} -->/);
  });
});

