import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { v4 as uuid } from 'uuid';
import { db, AUDIO_DIR, EXPORTS_DIR, THUMBS_DIR } from './server/db';
import { getGeminiClient } from './server/geminiClient';
import { prepareFastMediaRecord, startBackgroundAnalysisJob } from './server/mediaProcessor';
import { buildSrtSubtitles } from './server/transcriber';
import { planEditFromPrompt } from './server/aiEditor';
import { applyEditPlan, createInitialProjectState, searchMediaIndex } from './src/shared/timelineEngine';

const execFileAsync = promisify(execFile);
const BENCH_TMP = path.resolve(process.cwd(), 'storage', '.bench_tmp');
const createdMediaIds: string[] = [];
const createdProjectIds: string[] = [];
const createdJobIds: string[] = [];
const createdExportIds: string[] = [];
const createdUrlImportIds: string[] = [];

function normalizeEvalTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function levenshtein<T>(a: T[], b: T[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function computeWer(refText: string, hypText: string): number {
  const r = normalizeEvalTokens(refText);
  const h = normalizeEvalTokens(hypText);
  if (r.length === 0) return 0;
  return Number((levenshtein(r, h) / r.length).toFixed(3));
}

function computeCer(refText: string, hypText: string): number {
  const r = Array.from(refText.toLowerCase().replace(/\s+/g, ''));
  const h = Array.from(hypText.toLowerCase().replace(/\s+/g, ''));
  if (r.length === 0) return 0;
  return Number((levenshtein(r, h) / r.length).toFixed(3));
}

function writePcm24kToWav(pcmBuffer: Buffer, outWav: string, sampleRate = 24000) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0);
  hdr.writeUInt32LE(36 + pcmBuffer.length, 4);
  hdr.write('WAVE', 8);
  hdr.write('fmt ', 12);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(sampleRate * 2, 28);
  hdr.writeUInt16LE(2, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36);
  hdr.writeUInt32LE(pcmBuffer.length, 40);
  fs.writeFileSync(outWav, Buffer.concat([hdr, pcmBuffer]));
}

async function synthesizeSpeechWav(
  ai: GoogleGenAI | null,
  text: string,
  voiceName: string,
  outWav: string,
): Promise<string> {
  if (ai) {
    try {
      const resp = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: `Speak clearly and naturally in the original language of this text, without adding or translating anything: ${text}`,
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        } as Record<string, unknown>,
      });
      const parts = resp.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        const inline = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
        if (inline?.data) {
          const buf = Buffer.from(inline.data, 'base64');
          const mime = (inline.mimeType || '').toLowerCase();
          if (mime.includes('wav') || buf.subarray(0, 4).toString('ascii') === 'RIFF') {
            fs.writeFileSync(outWav, buf);
            return 'gemini-tts';
          }
          const rateMatch = mime.match(/rate=(\d+)/);
          const sr = rateMatch ? Number(rateMatch[1]) : 24000;
          const rawWav = `${outWav}.24k.wav`;
          writePcm24kToWav(buf, rawWav, sr);
          await execFileAsync('ffmpeg', ['-y', '-i', rawWav, '-ar', '16000', '-ac', '1', outWav]);
          fs.rmSync(rawWav, { force: true });
          return 'gemini-tts';
        }
      }
    } catch (err) {
      console.warn('[bench] Gemini TTS fallback to libflite:', err instanceof Error ? err.message : err);
    }
  }
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `flite=text='${text.replace(/'/g, '')}'`,
    '-ar',
    '16000',
    '-ac',
    '1',
    outWav,
  ]);
  return 'libflite';
}

async function buildVideoFromWav(wavPath: string, outMp4: string, mixPinkNoiseAmp = 0) {
  let finalWav = wavPath;
  if (mixPinkNoiseAmp > 0) {
    finalWav = `${wavPath}.noisy.wav`;
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      wavPath,
      '-f',
      'lavfi',
      '-i',
      `anoisesrc=c=pink:r=16000:a=${mixPinkNoiseAmp}`,
      '-filter_complex',
      '[0:a][1:a]amix=inputs=2:duration=first:weights=1 0.45[a]',
      '-map',
      '[a]',
      '-ar',
      '16000',
      '-ac',
      '1',
      finalWav,
    ]);
  }
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    finalWav,
  ]);
  const dur = Math.max(2.5, (parseFloat(stdout.trim()) || 4) + 0.6);
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=#080e24:s=640x360:r=12:d=${dur.toFixed(2)}`,
    '-i',
    finalWav,
    '-af',
    `apad=whole_dur=${dur.toFixed(2)}`,
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
    '-shortest',
    outMp4,
  ]);
  if (mixPinkNoiseAmp > 0) fs.rmSync(finalWav, { force: true });
}

function registerBenchProject(mediaId: string, filename: string, filePath: string, prep: Awaited<ReturnType<typeof prepareFastMediaRecord>>, vocabulary: string[]) {
  const now = new Date().toISOString();
  const projectId = `prj-bench-${uuid().slice(0, 8)}`;
  createdMediaIds.push(mediaId);
  createdProjectIds.push(projectId);
  db.prepare(
    `INSERT INTO media_assets
     (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, vocabulary_json, created_at)
     VALUES (?, NULL, 'bench-suite', 'upload', ?, 'video/mp4', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mediaId,
    filename,
    filePath,
    prep.thumbnailUrl,
    prep.analysis.durationSec,
    prep.analysis.width,
    prep.analysis.height,
    prep.analysis.hasAudio ? 1 : 0,
    prep.analysis.analysisMode,
    JSON.stringify(prep.analysis),
    JSON.stringify(vocabulary),
    now,
  );
  const state = createInitialProjectState(prep.analysis);
  db.prepare(
    `INSERT INTO projects
     (id, user_id, guest_token, title, media_id, thumbnail_url, state_json, history_json, history_index, versions_json, vocabulary_json, created_at, updated_at)
     VALUES (?, NULL, 'bench-suite', ?, ?, ?, ?, '[]', 0, '[]', ?, ?, ?)`,
  ).run(projectId, `Bench ${filename}`, mediaId, prep.thumbnailUrl, JSON.stringify(state), JSON.stringify(vocabulary), now, now);
  return projectId;
}

async function main() {
  fs.mkdirSync(BENCH_TMP, { recursive: true });
  const ai = getGeminiClient();
  console.log(`\n=== EDITMIND AI ACCEPTANCE BENCHMARK (Gemini Key Present: ${Boolean(ai)}) ===\n`);

  const scenarios = [
    {
      name: '1. English Technical & Proper Names',
      text: 'Welcome to IncuBrix Engineering at IIT Madras where automated workflows optimize your morning commute.',
      expectedLangPrefix: 'en',
      voice: 'Kore',
      vocabulary: ['IncuBrix', 'IIT', 'Madras', 'commute'],
      properNames: ['incubrix', 'iit', 'madras', 'commute'],
      noiseAmp: 0,
      editPrompt: 'Remove the word commute',
    },
    {
      name: '2. Noisy Background Audio + Domain Terms',
      text: 'Every morning commute saves engineering hours at Thiruvalluvar Tech Park.',
      expectedLangPrefix: 'en',
      voice: 'Puck',
      vocabulary: ['Thiruvalluvar', 'commute'],
      properNames: ['thiruvalluvar', 'commute'],
      noiseAmp: 0.03,
      editPrompt: 'Remove the word commute',
    },
    {
      name: '3. Hindi + Code-Switched English (Devanagari)',
      text: 'नमस्ते दोस्तों, आज हम IncuBrix के साथ अपना काम और commute समय बचाते हैं।',
      expectedLangPrefix: 'hi',
      voice: 'Aoede',
      vocabulary: ['IncuBrix', 'commute'],
      properNames: ['incubrix', 'commute'],
      noiseAmp: 0,
      editPrompt: 'Remove the word commute',
    },
    {
      name: '4. Tamil + Proper Name (Tamil Script)',
      text: 'வணக்கம் நண்பர்களே, திருவள்ளுவர் பல்கலைக்கழகத்தில் IncuBrix பற்றிப் பேசுவோம்.',
      expectedLangPrefix: 'ta',
      voice: 'Charon',
      vocabulary: ['IncuBrix', 'திருவள்ளுவர்'],
      properNames: ['incubrix'],
      noiseAmp: 0,
      editPrompt: 'Remove the word வணக்கம்',
    },
  ];

  const results: Array<Record<string, unknown>> = [];

  try {
    for (let idx = 0; idx < scenarios.length; idx++) {
      const sc = scenarios[idx];
      const wavPath = path.join(BENCH_TMP, `sc_${idx}.wav`);
      const mp4Path = path.join(BENCH_TMP, `sc_${idx}.mp4`);
      const ttsSource = await synthesizeSpeechWav(ai, sc.text, sc.voice, wavPath);
      await buildVideoFromWav(wavPath, mp4Path, sc.noiseAmp);
      fs.rmSync(wavPath, { force: true });

      const mediaId = `med-bench-${idx}-${uuid().slice(0, 6)}`;
      const prep = await prepareFastMediaRecord({ mediaId, filePath: mp4Path, filename: `sc_${idx}.mp4` });
      const projectId = registerBenchProject(mediaId, `sc_${idx}.mp4`, mp4Path, prep, sc.vocabulary);

      const tStart = performance.now();
      const { job, promise } = startBackgroundAnalysisJob({
        mediaId,
        projectId,
        vocabulary: sc.vocabulary,
      });
      createdJobIds.push(job.id);
      const analysis = await promise;
      const sttElapsedMs = Math.round(performance.now() - tStart);

      const hyp = analysis.transcript.map((s) => s.text).join(' ');
      const wer = computeWer(sc.text, hyp);
      const cer = computeCer(sc.text, hyp);
      const hypLower = hyp.toLowerCase();
      const properMatched = sc.properNames.filter((n) => hypLower.includes(n.toLowerCase())).length;
      const properAcc = Number((properMatched / sc.properNames.length).toFixed(2));
      const detectedLang = (analysis.detectedLanguage || '').toLowerCase();
      const langCorrect = detectedLang.startsWith(sc.expectedLangPrefix);

      // Verify script preservation for Hindi / Tamil when Gemini STT is active
      if (ai && sc.expectedLangPrefix === 'hi') {
        assert.match(hyp, /[\u0900-\u097F]/, `Hindi speech must stay in Devanagari, got "${hyp}"`);
      }
      if (ai && sc.expectedLangPrefix === 'ta') {
        assert.match(hyp, /[\u0B80-\u0BFF]/, `Tamil speech must stay in Tamil script, got "${hyp}"`);
      }

      // Check word timestamps monotonic & within [0, durationSec]
      const allWords = analysis.transcript.flatMap((s) => s.words || []);
      let prevStart = -0.01;
      for (const w of allWords) {
        assert.ok(w.start >= 0 && w.end <= analysis.durationSec + 0.15, `Word ${w.word} bounds out of range`);
        assert.ok(w.start >= prevStart - 0.02, `Word ${w.word} timestamp non-monotonic`);
        prevStart = w.start;
      }

      const initState = createInitialProjectState(analysis);
      const tPrompt0 = performance.now();
      const plan = await planEditFromPrompt(sc.editPrompt, initState, analysis);
      const promptLatencyMs = Math.round(performance.now() - tPrompt0);
      const applied = applyEditPlan(initState, analysis, plan);

      results.push({
        scenario: sc.name,
        tts: ttsSource,
        detectedLang: analysis.detectedLanguage,
        langCorrect,
        wer,
        cer,
        properAcc,
        wordsCount: allWords.length,
        reviewFlagged: analysis.verificationSummary?.reviewNeededCount ?? 0,
        sttElapsedMs,
        promptLatencyMs,
        editOp: plan.operations[0]?.type || 'CLARIFY',
        editedDuration: applied.nextState.duration,
        transcript: hyp,
      });
    }

    // 5) Genuine 60-minute (3600s) streaming/chunking benchmark
    console.log('\n--- Running 60-Minute (3600s) Streaming/Chunked Media Pipeline Test ---');
    const wavStart = path.join(BENCH_TMP, '60m_start.wav');
    const wavMid = path.join(BENCH_TMP, '60m_mid.wav');
    const wavEnd = path.join(BENCH_TMP, '60m_end.wav');
    const wavFull = path.join(BENCH_TMP, '60m_full.wav');
    const mp4Full = path.join(BENCH_TMP, '60m_full.mp4');

    await synthesizeSpeechWav(null, 'Opening keynote on commute automation at IIT Madras.', 'Kore', wavStart);
    await synthesizeSpeechWav(null, 'Midpoint architecture review confirmed bottleneck resolved.', 'Kore', wavMid);
    await synthesizeSpeechWav(null, 'Closing benchmark summary for the sixty minute stream.', 'Kore', wavEnd);

    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-t', '2', '-i', 'anullsrc=r=16000:cl=mono',
      '-i', wavStart,
      '-f', 'lavfi', '-t', '1790', '-i', 'anullsrc=r=16000:cl=mono',
      '-i', wavMid,
      '-f', 'lavfi', '-t', '1790', '-i', 'anullsrc=r=16000:cl=mono',
      '-i', wavEnd,
      '-f', 'lavfi', '-t', '6', '-i', 'anullsrc=r=16000:cl=mono',
      '-filter_complex', '[0:a][1:a][2:a][3:a][4:a][5:a][6:a]concat=n=7:v=0:a=1[a]',
      '-map', '[a]', '-ar', '16000', '-ac', '1', wavFull,
    ]);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=#080e24:s=320x180:r=1:d=3600',
      '-i', wavFull,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '32k', '-shortest', mp4Full,
    ]);
    fs.rmSync(wavStart, { force: true });
    fs.rmSync(wavMid, { force: true });
    fs.rmSync(wavEnd, { force: true });
    fs.rmSync(wavFull, { force: true });

    const m60Id = `med-bench-60m-${uuid().slice(0, 6)}`;
    const prep60 = await prepareFastMediaRecord({ mediaId: m60Id, filePath: mp4Full, filename: '60m_full.mp4' });
    const p60Id = registerBenchProject(m60Id, '60m_full.mp4', mp4Full, prep60, ['IIT Madras', 'commute']);
    const t60 = performance.now();
    const job60 = startBackgroundAnalysisJob({ mediaId: m60Id, projectId: p60Id, vocabulary: ['IIT Madras', 'commute'] });
    createdJobIds.push(job60.job.id);
    const analysis60 = await job60.promise;
    const elapsed60Ms = Math.round(performance.now() - t60);

    const wav60Bytes = fs.statSync(path.join(AUDIO_DIR, m60Id, 'stream_0_16k.wav')).size;
    assert.ok(wav60Bytes > 105 * 1024 * 1024, `Expected 60m WAV > 105MB, got ${(wav60Bytes / 1e6).toFixed(1)}MB`);
    assert.ok((analysis60.chunkStats?.total || 0) >= 120, `Expected >= 120 chunks, got ${analysis60.chunkStats?.total}`);
    assert.equal(analysis60.chunkStats?.failed, 0);

    const st60 = createInitialProjectState(analysis60);
    const tSearch0 = performance.now();
    const hits60 = searchMediaIndex(analysis60, st60.segments, 'commute');
    const plan60 = await planEditFromPrompt('Remove the word commute', st60, analysis60);
    const prompt60Ms = Math.round(performance.now() - tSearch0);
    assert.ok(hits60.length >= 1, 'Expected "commute" search hit in 60-min video');
    assert.ok(prompt60Ms < 3000, `Expected < 3000ms prompt/search latency on 60-min video, got ${prompt60Ms}ms`);

    console.log('\n60-Minute Benchmark Result:', {
      durationSec: analysis60.durationSec,
      extractedWavMB: Number((wav60Bytes / (1024 * 1024)).toFixed(1)),
      chunksTotal: analysis60.chunkStats?.total,
      chunksFailed: analysis60.chunkStats?.failed,
      totalPipelineMs: elapsed60Ms,
      searchAndPromptLatencyMs: prompt60Ms,
      transcriptExcerpt: analysis60.transcript.map((s) => s.text).join(' | '),
    });

    // 6) Live HTTP /api/v1/* contract + Idempotency-Key + URL SSRF test against port 3000
    console.log('\n--- Running Live HTTP /api/v1/* & Error Envelope Verification ---');
    const langRes = await fetch('http://127.0.0.1:3000/api/languages');
    assert.equal(langRes.status, 200);
    const langJson = (await langRes.json()) as { languages: Array<{ code: string }> };
    assert.ok(langJson.languages.some((l) => l.code === 'hi') && langJson.languages.some((l) => l.code === 'ta'));

    const ssrfRes = await fetch('http://127.0.0.1:3000/api/v1/media/import-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:3000/video.mp4' }),
    });
    assert.equal(ssrfRes.status, 400);
    const ssrfJson = (await ssrfRes.json()) as { error: { code: string; message: string; retryable: boolean } };
    assert.ok(ssrfJson.error?.code && typeof ssrfJson.error.retryable === 'boolean');

    // Upload sc_0.mp4 to /api/v1/media/ingest with Idempotency-Key
    const sampleMp4 = path.join(BENCH_TMP, 'sc_0.mp4');
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(sampleMp4)], { type: 'video/mp4' }), 'v1_test.mp4');
    form.append('languageOverride', 'en');
    form.append('vocabulary', 'IncuBrix, IIT Madras');
    const idemKey = `idem-bench-${uuid().slice(0, 8)}`;

    const ingest1 = await fetch('http://127.0.0.1:3000/api/v1/media/ingest', {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      body: form,
    });
    assert.equal(ingest1.status, 202);
    const ing1Json = (await ingest1.json()) as { job_id: string; project: { id: string }; mediaId: string };
    assert.ok(ing1Json.job_id);
    createdProjectIds.push(ing1Json.project.id);
    createdMediaIds.push(ing1Json.mediaId);

    // Repeat with same Idempotency-Key returns same job_id cleanly
    const form2 = new FormData();
    form2.append('file', new Blob([fs.readFileSync(sampleMp4)], { type: 'video/mp4' }), 'v1_test.mp4');
    const ingest2 = await fetch('http://127.0.0.1:3000/api/v1/media/ingest', {
      method: 'POST',
      headers: { 'Idempotency-Key': idemKey },
      body: form2,
    });
    assert.equal(ingest2.status, 202);
    const ing2Json = (await ingest2.json()) as { job_id: string };
    assert.equal(ing2Json.job_id, ing1Json.job_id, 'Idempotency-Key must replay identical job_id');

    // Poll /api/v1/jobs/:job_id
    let jobStatus = 'queued';
    for (let k = 0; k < 40; k++) {
      await new Promise((r) => setTimeout(r, 500));
      const jr = await fetch(`http://127.0.0.1:3000/api/v1/jobs/${ing1Json.job_id}`);
      assert.equal(jr.status, 200);
      const jj = (await jr.json()) as { status: string };
      jobStatus = jj.status;
      if (jobStatus === 'completed' || jobStatus === 'partial' || jobStatus === 'failed') break;
    }
    assert.ok(jobStatus === 'completed' || jobStatus === 'partial', `Expected v1 ingest job to finish, got ${jobStatus}`);

    console.log('\n=== MULTILINGUAL BENCHMARK TABLE ===');
    console.table(results.map(({ transcript: _t, ...rest }) => rest));
    for (const r of results) {
      console.log(`\n[${r.scenario}] -> "${r.transcript}"`);
    }
    console.log('\nALL BENCHMARKS & LIVE /api/v1 CHECKS PASSED!');
  } finally {
    // Thorough DB & disk cleanup
    for (const id of createdExportIds) {
      db.prepare('DELETE FROM exports WHERE id = ?').run(id);
      fs.rmSync(path.join(EXPORTS_DIR, `${id}.mp4`), { force: true });
    }
    for (const id of createdJobIds) {
      db.prepare('DELETE FROM transcription_chunks WHERE job_id = ?').run(id);
      db.prepare('DELETE FROM analysis_jobs WHERE id = ?').run(id);
    }
    for (const id of createdUrlImportIds) {
      db.prepare('DELETE FROM url_imports WHERE id = ?').run(id);
    }
    db.prepare("DELETE FROM v1_jobs WHERE project_id LIKE 'prj-bench-%' OR media_id LIKE 'med-bench-%'").run();
    db.prepare("DELETE FROM idempotency_keys WHERE key LIKE 'idem-bench-%'").run();
    for (const id of createdProjectIds) {
      db.prepare('DELETE FROM v1_jobs WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    }
    for (const id of createdMediaIds) {
      db.prepare('DELETE FROM transcription_chunks WHERE media_id = ?').run(id);
      db.prepare('DELETE FROM analysis_jobs WHERE media_id = ?').run(id);
      db.prepare('DELETE FROM v1_jobs WHERE media_id = ?').run(id);
      db.prepare('DELETE FROM media_assets WHERE id = ?').run(id);
      fs.rmSync(path.join(AUDIO_DIR, id), { recursive: true, force: true });
      fs.rmSync(path.join(THUMBS_DIR, `${id}.jpg`), { force: true });
    }
    db.prepare("DELETE FROM projects WHERE guest_token = 'bench-suite'").run();
    db.prepare("DELETE FROM media_assets WHERE guest_token = 'bench-suite'").run();
    fs.rmSync(BENCH_TMP, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('BENCHMARK FAILED:', err);
  process.exit(1);
});
