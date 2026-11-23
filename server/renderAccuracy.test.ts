import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { applyEditPlan, createInitialProjectState, recalculateTimeline } from '../src/shared/timelineEngine';
import { musicLoop } from '../src/shared/musicBed';
import type { MediaAnalysis, ProjectState } from '../src/shared/types';

const rate = 24;
const audioRate = 24000;
const duration = 8;
const flashes = Array.from({ length: 8 }, (_, i) => i + 0.5);
const report: Record<string, unknown> = {
  fixture: 'Original procedural flash and synchronized audio markers',
  fps: rate,
  cases: [],
};
const cases = report.cases as Record<string, unknown>[];
function ff(args: string[]) {
  return execFileSync(
    'ffmpeg',
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '2', ...args],
    { maxBuffer: 64 * 1024 * 1024 },
  );
}
function realDuration(file: string) {
  return JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,start_time,duration,r_frame_rate:format=duration',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  );
}
function audio(file: string) {
  const b = ff(['-i', file, '-vn', '-ac', '1', '-ar', String(audioRate), '-f', 'f32le', '-']);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function strength(samples: Float32Array, start: number, length: number, hz: number) {
  const n = Math.round(length * audioRate),
    off = Math.round(start * audioRate);
  let re = 0,
    im = 0;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * hz * i) / audioRate,
      x = samples[off + i] || 0;
    re += x * Math.cos(angle);
    im += x * Math.sin(angle);
  }
  return (2 * Math.hypot(re, im)) / n;
}
function images(file: string) {
  const w = 192,
    h = 108,
    stride = w * h * 3;
  const raw = ff(['-i', file, '-an', '-vf', 'scale=192:108', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-']);
  const frames = [];
  for (let base = 0; base + stride <= raw.length; base += stride) {
    let red = 0,
      green = 0;
    for (let p = base; p < base + stride; p += 3) {
      const [r, g, b] = [raw[p], raw[p + 1], raw[p + 2]];
      if (r > 90 && r > 1.5 * g && r > 1.5 * b) red++;
      if (g > 80 && g > 1.4 * r && g > 1.4 * b) green++;
    }
    frames.push({ flash: raw[base + (14 * w + 14) * 3] > 150, red, green });
  }
  return frames;
}
function intervals(maps: number[][]) {
  let t = 0;
  return maps.map(([a, b, speed]) => {
    const start = t;
    t += (b - a) / speed;
    return { sourceStart: a, sourceEnd: b, speed, start, end: t };
  });
}
function rising(times: boolean[], perSecond: number) {
  return times.flatMap((on, i) => (on && (i === 0 || !times[i - 1]) ? [i / perSecond] : []));
}
function nearest(values: number[], t: number) {
  assert.ok(values.length, 'Expected a decoded marker but found none');
  return values.reduce((a, b) => (Math.abs(a - t) < Math.abs(b - t) ? a : b));
}

test(
  'MP4 content positions, durations, audio effects, and variable-frame-rate input',
  { timeout: 240000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editmind-frame-check-'));
    process.env.STORAGE_DIR = dir;
    process.env.BLOB_READ_WRITE_TOKEN = '';
    const { db, EXPORTS_DIR, MUSIC_DIR } = await import('./db');
    const { runExportJob } = await import('./exporter');
    const { probeVideoFile } = await import('./mediaProcessor');
    const source = path.join(dir, 'markers.mp4');
    const enabled = flashes.map((p) => `gte(t,${p})*lt(t,${p + 0.167})`).join('+');
    const audioSignal = `aevalsrc='0.17*sin(2*PI*320*t)*lt(t,4)+0.72*sin(2*PI*1800*t)*(${enabled})':s=${audioRate}:d=8`;
    ff([
      '-f',
      'lavfi',
      '-i',
      `color=black:s=320x180:r=${rate}:d=8,drawbox=x=12:y=12:w=30:h=30:color=white:t=fill:enable='${enabled}'`,
      '-f',
      'lavfi',
      '-i',
      audioSignal,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '144k',
      source,
    ]);
    const hash = () => createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const originalHash = hash();
    const analysis = {
      mediaId: 'markers',
      durationSec: duration,
      width: 320,
      height: 180,
      fps: rate,
      transcript: [],
      captions: [],
      scenes: [],
      speakers: [],
      importantMoments: [],
      fillers: [],
      silences: [],
      hasAudio: true,
      waveformPeaks: [],
      analysisMode: 'local-ffmpeg',
      topics: [],
      summary: '',
      analysisNote: '',
      codec: 'h264',
    } as unknown as MediaAnalysis;
    const state = createInitialProjectState(analysis);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO media_assets (id,source_type,filename,mime_type,file_path,thumbnail_url,duration_sec,width,height,has_audio,analysis_mode,analysis_json,created_at) VALUES ('markers','upload','markers.mp4','video/mp4',?,'',8,320,180,1,'local-ffmpeg',?,?)",
    ).run(source, JSON.stringify(analysis), now);
    db.prepare(
      "INSERT INTO projects (id,title,media_id,thumbnail_url,state_json,history_json,history_index,versions_json,created_at,updated_at) VALUES ('test','Fixture','markers','',?,'[]',0,'[]',?,?)",
    ).run(JSON.stringify(state), now, now);
    function scoped(maps: number[][]) {
      const edited = structuredClone(state);
      const timeline = recalculateTimeline(
        maps.map(([a, b, speed], i) => ({
          ...state.segments[0],
          id: 'part-' + i,
          sourceStart: a,
          sourceEnd: b,
          speed,
        })),
      );
      return { ...edited, ...timeline, captionsEnabled: false };
    }
    async function render(label: string, edited: ProjectState, src = source, hasAudio = true) {
      const id = 'exp-' + randomUUID();
      db.prepare(
        "INSERT INTO exports(id,project_id,media_id,status,progress,resolution,quality,created_at) VALUES (?,'test','markers','queued',0,'480p','fast',?)",
      ).run(id, now);
      await runExportJob({
        jobId: id,
        projectId: 'test',
        mediaId: 'markers',
        sourceFilePath: src,
        sourceHasAudio: hasAudio,
        state: edited,
        resolution: '480p',
        quality: 'fast',
      });
      const job = db.prepare('SELECT status,error FROM exports WHERE id=?').get(id) as {
        status: string;
        error: string;
      };
      assert.equal(job.status, 'completed', job.error || label);
      const file = path.join(EXPORTS_DIR, id + '.mp4');
      const meta = realDuration(file),
        video = meta.streams.find((s: any) => s.codec_type === 'video');
      const [fn, fd] = video.r_frame_rate.split('/').map(Number);
      const errorFrames = (Math.abs(Number(video.duration) - edited.duration) * fn) / fd;
      cases.push({
        case: label,
        timelineSeconds: edited.duration,
        videoSeconds: Number(video.duration),
        lengthErrorFrames: errorFrames,
      });
      assert.ok(errorFrames <= 1.001, `${label}: video length error ${errorFrames} frames`);
      return file;
    }
    function measureMarkers(file: string, maps: number[][]) {
      const decoded = images(file),
        pcm = audio(file);
      const vis = rising(
        decoded.map((f) => f.flash),
        rate,
      );
      const audible = rising(
        Array.from(
          { length: Math.floor(pcm.length / (audioRate * 0.005)) },
          (_, i) => strength(pcm, i * 0.005, 0.005, 1800) > 0.2,
        ),
        200,
      );
      const observations = [];
      for (const slice of intervals(maps))
        for (const p of flashes) {
          if (p < slice.sourceStart + 0.04 || p + 0.167 > slice.sourceEnd - 0.04) continue;
          const ideal = slice.start + (p - slice.sourceStart) / slice.speed;
          const v = nearest(vis, ideal),
            a = nearest(audible, ideal);
          observations.push({ source: p, expected: ideal, visual: v, audio: a });
        }
      assert.ok(observations.length >= 3);
      const maxAv = Math.max(...observations.map((p) => Math.abs(p.visual - p.audio) * rate));
      const maxVisual = Math.max(...observations.map((p) => Math.abs(p.visual - p.expected) * rate));
      Object.assign(cases.at(-1)!, {
        observations,
        maxAvOffsetFrames: maxAv,
        maxVisualOffsetFrames: maxVisual,
      });
      assert.ok(maxAv <= 1.001 && maxVisual <= 1.001, JSON.stringify({ maxAv, maxVisual, observations }));
      return decoded;
    }
    try {
      await t.test(
        'phrase boundaries follow measured silence when ASR timestamps spill into it',
        async () => {
          const { buildSegmentsAndSummaryFromWords } = await import('./transcriber');
          const indexed = buildSegmentsAndSummaryFromWords({
            mediaId: 'calibration',
            durationSec: 50,
            silences: [
              { id: 'gap', start: 28.076, end: 34.211, duration: 6.135 },
              { id: 'before-welcome', start: 38.645, end: 42.227, duration: 3.582 },
              { id: 'after-welcome', start: 43.441, end: 50, duration: 6.559 },
            ],
            rawWords: [
              { word: 'Evening.', start: 27.944, end: 31.584, confidence: 0.9, timingAccuracy: 'model-word' },
              { word: 'Welcome!', start: 42.524, end: 43.464, confidence: 0.9, timingAccuracy: 'model-word' },
            ],
          });
          const words = indexed.transcript.flatMap((t) => t.words);
          assert.equal(words[0].end, 28.091);
          assert.equal(words[1].start, 42.212);
          assert.equal(words[1].end, 43.456);
          assert.equal(words[1].timingAccuracy, 'aligned');
        },
      );
      await t.test(
        'mixed section order and speed preserve flash, sound, caption and overlay anchors',
        async () => {
          const maps = [
            [2.09, 4.23, 1],
            [0.13, 1.91, 1],
            [4.28, 7.96, 1.5],
            [1.93, 2.07, 0.75],
          ];
          const edited = scoped(maps);
          edited.captionsEnabled = true;
          edited.captions = [
            {
              id: 'card',
              sourceStart: 2.16,
              sourceEnd: 2.43,
              text: 'RED CAPTION',
              words: [],
              visible: true,
              customText: true,
              styleOverride: { color: '#ff0000', fontSize: 52, highlightActiveWord: false },
            },
          ];
          edited.overlays = [
            {
              id: 'note',
              sourceRanges: [{ start: 0.94, end: 1.4 }],
              text: 'GREEN OVERLAY',
              timelineStart: 0.94,
              timelineEnd: 1.4,
              x: 50,
              y: 35,
              color: '#00ff00',
              fontSize: 58,
              backgroundColor: '#222222',
            },
          ];
          const file = await render('Mixed reorder, trim, speed and titles', edited),
            frames = measureMarkers(file, maps);
          const redTime = 2.29 - 2.09;
          const greenTime = 4.23 - 2.09 + (1.14 - 0.13);
          assert.ok(
            frames[Math.round(rate * redTime)].red > 5 && frames[Math.round(rate * greenTime)].green > 5,
          );
          assert.ok(
            frames[Math.round(rate * greenTime)].red < 3 && frames[Math.round(rate * 1.14)].green < 3,
          );
        },
      );
      await t.test('tiny cuts are quantized on the global output clock', async () => {
        const maps: number[][] = [];
        for (let i = 0; i < 6; i++) maps.push([i, i + 0.241, 1], [i + 0.267, i + 0.991, 1]);
        const file = await render('Twelve non-frame-aligned slices', scoped(maps));
        measureMarkers(file, maps);
      });
      await t.test('mute and bleep follow every visible fragment after reordering', async () => {
        const maps = [
          [2, 4, 1],
          [0, 2, 1],
          [4, 8, 1],
        ];
        const edited = scoped(maps);
        edited.muteRanges = [{ id: 'quiet', label: 'Mute crossing cut', sourceStart: 1.8, sourceEnd: 2.2 }];
        edited.bleeps = [{ id: 'tone', label: 'Bleep crossing cut', sourceStart: 3.8, sourceEnd: 4.22 }];
        const pcm = audio(await render('Fragmented mutes and bleeps', edited));
        for (const start of [0.04, 3.84])
          assert.ok(strength(pcm, start, 0.08, 320) < 0.008, 'muted source persisted at ' + start);
        assert.ok(strength(pcm, 0.3, 0.08, 320) > 0.1);
        for (const start of [1.85, 4.06])
          assert.ok(strength(pcm, start, 0.08, 1000) > 0.15, 'missing bleep at ' + start);
        assert.ok(strength(pcm, 2.2, 0.08, 1000) < 0.01);
      });
      await t.test('music ducks under foreground audio and recovers in silence', async () => {
        const edited = scoped([[0, 8, 1]]);
        // A calibrated input separates actual gain changes from variations in the arrangement.
        ff([
          '-f',
          'lavfi',
          '-i',
          'aevalsrc=0.16*sin(2*PI*220*t):s=24000:d=2',
          path.join(MUSIC_DIR, 'music-check.wav'),
        ]);
        edited.audio = {
          ...edited.audio,
          musicEnabled: true,
          duckUnderSpeech: true,
          musicPreset: 'custom-upload',
          customMusicUrl: '/music/music-check.wav',
          musicVolume: 0.7,
          musicFadeInSec: 0.1,
          musicFadeOutSec: 0.1,
        };
        const pcm = audio(await render('Ducked background music (calibrated 220 Hz input)', edited));
        const during = strength(pcm, 2.0, 0.25, 220),
          quiet = strength(pcm, 6.0, 0.25, 220);
        Object.assign(cases.at(-1)!, { musicDuringForeground: during, musicDuringQuiet: quiet });
        assert.ok(quiet > 0.04 && during < quiet * 0.55, JSON.stringify({ during, quiet }));
      });
      await t.test('composed music is the same waveform in preview and MP4', async () => {
        const edited = scoped([[0, 8, 1]]);
        edited.audio = {
          ...edited.audio,
          musicEnabled: true,
          musicPreset: 'ambient-pulse',
          musicVolume: 0.7,
          musicFadeInSec: 0.1,
          musicFadeOutSec: 0.1,
        };
        edited.segments[0].muted = true;
        const pcm = audio(await render('Original electric-piano and bass arrangement', edited));
        const preview = musicLoop('ambient-pulse');
        let xx = 0,
          yy = 0,
          xy = 0;
        for (let i = audioRate; i < 7 * audioRate; i++) {
          xx += pcm[i] ** 2;
          yy += preview[i] ** 2;
          xy += pcm[i] * preview[i];
        }
        const correlation = xy / Math.sqrt(xx * yy);
        Object.assign(cases.at(-1)!, { previewMp4WaveformCorrelation: correlation });
        assert.ok(correlation > 0.98);
      });
      await t.test('short source audio is padded and the remaining timeline stays synchronized', async () => {
        const short = path.join(dir, 'short-audio.mp4');
        ff([
          '-i',
          source,
          '-map',
          '0:v',
          '-map',
          '0:a',
          '-c:v',
          'copy',
          '-af',
          'atrim=end=3',
          '-c:a',
          'aac',
          short,
        ]);
        const maps = [
          [4.2, 6.2, 1],
          [0, 2.7, 1],
        ];
        const out = await render('Short audio with silent tail moved before speech', scoped(maps), short);
        const a = audio(out);
        assert.ok(a.length / audioRate >= 4.68);
        assert.ok(strength(a, 2.08, 0.18, 320) > 0.1 && strength(a, 0.1, 0.18, 320) < 0.002);
      });
      await t.test(
        'VFR silent phone-style source is indexed and exported without synthetic audio',
        async () => {
          const vfr = path.join(dir, 'vfr.mp4');
          ff([
            '-i',
            source,
            '-vf',
            "select='if(lt(t,3),1,not(mod(n,3)))'",
            '-fps_mode',
            'vfr',
            '-an',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            vfr,
          ]);
          const check = await probeVideoFile(vfr);
          assert.ok(check.variableFrameRate && !check.hasAudio);
          const out = await render(
            'VFR, no audio, reordered',
            scoped([
              [1, 3, 1],
              [0.15, 1, 2],
              [4, 6, 1],
            ]),
            vfr,
            false,
          );
          assert.equal(realDuration(out).streams.length, 1);
        },
      );
      await t.test('twenty speech pause cuts preserve the PCM around both sides of each join', async () => {
        const speech = path.join(dir, 'speech.mp4');
        ff([
          '-f',
          'lavfi',
          '-i',
          'color=color=black:size=320x180:rate=24',
          '-i',
          'src/assets/audio/demo-keynote.mp3',
          '-c:v',
          'libx264',
          '-preset',
          'ultrafast',
          '-c:a',
          'aac',
          '-ar',
          String(audioRate),
          '-shortest',
          speech,
        ]);
        const silence = spawnSync(
          'ffmpeg',
          ['-hide_banner', '-i', speech, '-vn', '-af', 'silencedetect=n=-38dB:d=0.16', '-f', 'null', '-'],
          { encoding: 'utf8' },
        );
        assert.equal(silence.status, 0, silence.stderr);
        const cuts = Array.from(
          silence.stderr.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g),
        )
          .map((match) => {
            const end = Number(match[1]),
              duration = Number(match[2]);
            // Keep 50 ms at each edge for the consonant attack and decay.
            return {
              start: Math.ceil((end - duration + 0.05) * 1000) / 1000,
              end: Math.floor((end - 0.05) * 1000) / 1000,
              label: 'Detected quiet gap',
            };
          })
          .filter((c) => c.start > 1 && c.end - c.start >= 0.05)
          .slice(0, 20);
        assert.equal(cuts.length, 20);
        const speechAnalysis = { ...analysis, durationSec: Number(realDuration(speech).format.duration) };
        const initial = createInitialProjectState(speechAnalysis);
        const plan = applyEditPlan(initial, speechAnalysis, {
          id: 'shorten-pauses',
          prompt: 'Shorten the first twenty quiet gaps',
          intentSummary: 'Trim quiet pauses',
          aiMode: 'local-ffmpeg',
          operations: [{ type: 'REMOVE_SILENCES', label: 'Trim pauses', removeRanges: cuts }],
        });
        assert.equal(plan.appliedCount, 1);
        assert.equal(plan.nextState.segments.length, 21);
        const file = await render('20 pause cuts in bundled keynote narration', plan.nextState, speech);
        const original = audio(speech),
          output = audio(file);
        const evidence = plan.nextState.segments.slice(1).map((s, i) => {
          const cut = cuts[i],
            edge = Math.round(s.timelineStart * audioRate);
          const peak = original
            .subarray(Math.round(cut.start * audioRate), Math.round(cut.end * audioRate))
            .reduce((p, n) => Math.max(p, Math.abs(n)), 0);
          let xy = 0,
            xx = 0,
            yy = 0;
          for (let j = -Math.round(0.3 * audioRate); j < Math.round(0.3 * audioRate); j++) {
            const x = original[Math.round((j < 0 ? cut.start : cut.end) * audioRate) + j],
              y = output[edge + j];
            xx += x * x;
            yy += y * y;
            xy += x * y;
          }
          return {
            sourceCut: cut,
            timelineJoin: s.timelineStart,
            removedPeakDbfs: 20 * Math.log10(Math.max(peak, 1e-9)),
            correlation: xy / Math.sqrt(xx * yy),
          };
        });
        Object.assign(cases.at(-1)!, {
          joins: evidence,
          method: 'Decoded PCM compared across 600 ms around each seam. Human listening not recorded.',
        });
        const minCorrelation = Math.min(...evidence.map((c) => c.correlation));
        const maxRemovedDbfs = Math.max(...evidence.map((c) => c.removedPeakDbfs));
        assert.ok(
          minCorrelation > 0.93 && maxRemovedDbfs < -36,
          JSON.stringify({ minCorrelation, maxRemovedDbfs }),
        );
        if (process.env.EDITMIND_LISTENING_REEL) {
          const clips = evidence.map((join) => {
            const sample = Math.round(join.timelineJoin * audioRate),
              half = Math.round(0.52 * audioRate);
            const clip = new Float32Array(2 * half + Math.round(0.18 * audioRate));
            clip.set(output.subarray(sample - half, sample + half));
            return Buffer.from(clip.buffer);
          });
          const raw = path.join(dir, 'joins.f32');
          fs.writeFileSync(raw, Buffer.concat(clips));
          ff([
            '-y',
            '-f',
            'f32le',
            '-ar',
            String(audioRate),
            '-ac',
            '1',
            '-i',
            raw,
            '-c:a',
            'libmp3lame',
            '-b:a',
            '96k',
            process.env.EDITMIND_LISTENING_REEL,
          ]);
        }
      });
      assert.equal(hash(), originalHash);
    } finally {
      report.sourceHashBefore = originalHash;
      report.sourceHashAfter = hash();
      report.ffmpeg = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
      if (process.env.EDITMIND_RENDER_EVIDENCE)
        fs.writeFileSync(process.env.EDITMIND_RENDER_EVIDENCE, JSON.stringify(report, null, 2) + '\n');
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
