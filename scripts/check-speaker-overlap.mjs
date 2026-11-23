// node --import tsx scripts/check-speaker-overlap.mjs http://localhost:3000 new-output-dir
import assert from 'node:assert/strict';
import fs, { openAsBlob } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { musicLoop, musicSampleRate } from '../src/shared/musicBed.ts';
import { mediaWarnings } from '../server/sessionTypes.ts';
import { connect } from './run-sessions.mjs';

const [base, dest] = process.argv.slice(2);
if (!base || !dest) throw Error('Provide an API origin and output directory.');
fs.mkdirSync(dest, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editmind-overlap-'));
const ff = (args) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { cwd: tmp });
try {
  const voices = [
    { label: 'Host', voice: 'slt', text: 'Hello', start: 0.8 },
    { label: 'Guest', voice: 'rms', text: 'Welcome', start: 0.9 },
  ];
  for (const v of voices) {
    ff([
      '-f',
      'lavfi',
      '-i',
      `flite=text=${v.text}:voice=${v.voice}`,
      '-af',
      'silenceremove=start_periods=1:start_threshold=-42dB,areverse,silenceremove=start_periods=1:start_threshold=-42dB,areverse',
      '-ar',
      '24000',
      v.voice + '.wav',
    ]);
    const length = Number(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', v.voice + '.wav'],
        { cwd: tmp, encoding: 'utf8' },
      ),
    );
    v.end = v.start + length;
  }
  const overlap = Math.min(...voices.map((v) => v.end)) - Math.max(...voices.map((v) => v.start));
  assert.ok(overlap > 0.08);
  const music = musicLoop('cinematic-pad');
  fs.writeFileSync(path.join(tmp, 'music.f32'), Buffer.from(music.buffer));
  const output = path.resolve(dest, 'overlap-vfr.mp4');
  ff([
    '-f',
    'lavfi',
    '-i',
    'color=c=0x34475c:size=320x180:rate=24:duration=8',
    '-i',
    'slt.wav',
    '-i',
    'rms.wav',
    '-f',
    'f32le',
    '-ar',
    String(musicSampleRate),
    '-ac',
    '1',
    '-i',
    'music.f32',
    '-f',
    'lavfi',
    '-i',
    'flite=text=The camera is recording the new show in our studio:voice=slt',
    '-filter_complex',
    "[0:v]select='if(lt(t,4),1,not(mod(n,3)))'[v];[1:a]adelay=800[h];[2:a]adelay=900[g];[3:a]volume=0.13[m];[4:a]adelay=3100[tail];[h][g][m][tail]amix=4:duration=longest:normalize=0[a]",
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-t',
    '8',
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    output,
  ]);
  const client = await connect(base),
    form = new FormData();
  form.set('video', await openAsBlob(output, { type: 'video/mp4' }), 'overlap-vfr.mp4');
  form.set('rights', 'Original CMU Flite voices, procedural music and FFmpeg video');
  form.set('ai_generated', 'true');
  const queued = await client.request('/api/v1/media/ingest', form);
  const ready = await client.waitJob(queued.job_id, 300000);
  const project = await client.request('/api/projects/' + (ready.project_id || queued.project_id));
  const analysis = project.project.media.analysis;
  const session = await client.request('/api/v1/projects/' + project.project.id + '/sessions', {});
  const step = await client.request('/api/v1/sessions/' + session.session_id + '/steps', { say: 'Render' });
  const render = await client.request('/api/v1/sessions/' + session.session_id + '/render', {
    resolution: '480p',
    quality: 'fast',
  });
  const result = await client.waitJob(render.job_id, 300000);
  await client.download(result.result_links.download, path.join(dest, 'overlap-export.mp4'));
  const observed = analysis.transcript.map((t) => ({
    speaker: t.speaker,
    text: t.text,
    start: t.start,
    end: t.end,
  }));
  assert.ok(analysis.wordCount > 0 && analysis.variableFrameRate);
  assert.ok(step.warnings.some((w) => /variable frame rate/i.test(w)));
  // The isolated single-word stems provide reference time spans and speaker IDs.
  // Deliberately give the guest's segment the wrong word-level label.
  const faulty = {
    ...analysis,
    transcript: voices.map((v) => ({
      speaker: v.label,
      text: v.text,
      start: v.start,
      end: v.end,
      words: [{ word: v.text, start: v.start, end: v.end, speaker: 'Host' }],
    })),
  };
  const reviewed = mediaWarnings(faulty);
  assert.ok(reviewed.some((w) => /overlapping speakers/i.test(w)));
  assert.ok(reviewed.some((w) => /speaker-label mismatch/i.test(w)));
  const written = {
    source:
      'Two separately rendered original CMU Flite stems physically overlap over a piano bed. Frame rate changes after 4 s.',
    overlapSeconds: overlap,
    voices,
    asr: {
      provider: analysis.providerUsed,
      observedTurns: observed,
      words: analysis.wordCount,
      warnings: step.warnings,
    },
    knownFault: {
      description:
        'Measured stems used as reference. Guest segment was deliberately assigned the Host word-level label.',
      warnings: reviewed,
    },
    output: 'overlap-export.mp4',
  };
  fs.writeFileSync(path.join(dest, 'overlap.json'), JSON.stringify(written, null, 2) + '\n');
  console.log('Verified two voices, overlap, music, VFR, actual ASR and export');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
