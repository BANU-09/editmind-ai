// node --import tsx scripts/check-session-replays.mjs http://localhost:3000 new-output-dir
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { projectCaptionsToTimeline } from '../src/shared/timelineEngine.ts';
import { connect, runSession } from './run-sessions.mjs';

const [base, out] = process.argv.slice(2);
if (!base || !out) throw Error('Provide the API base and a new output folder.');
const client = await connect(base);
const specs = 'testpack/sessions';
await fs.mkdir(out, { recursive: true });
const entries = [];
const save = () =>
  fs.writeFile(
    path.join(out, 'replay-summary.json'),
    JSON.stringify({ runsPerSession: 3, entries }, null, 2) + '\n',
  );

function stamp(response) {
  return [response.status, response.code, response.timeline_hash, response.duration_s];
}
function probe(file) {
  return JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type,duration,r_frame_rate',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  ).streams;
}
function captionFrames(file) {
  const width = 180,
    height = 100,
    bytes = width * height * 3;
  const raw = execFileSync(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'error',
      '-i',
      file,
      '-an',
      '-vf',
      'scale=180:100',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 90 * 1024 * 1024 },
  );
  const red = [];
  for (let i = 0; i < raw.length / bytes; i++) {
    let count = 0;
    for (let p = i * bytes; p < (i + 1) * bytes; p += 3)
      if (raw[p] > 95 && raw[p] > 1.6 * raw[p + 1] && raw[p] > 1.6 * raw[p + 2]) count++;
    if (count >= 4) red.push(i);
  }
  assert.ok(red.length, 'Missing red caption pixels');
  return { first: red[0], last: red.at(-1), frameCount: red.length };
}

for (const file of (await fs.readdir(specs)).filter((f) => f.endsWith('.yaml')).sort()) {
  const name = path.basename(file, '.yaml'),
    dest = path.join(out, name);
  const spec = parse(await fs.readFile(path.join(specs, file), 'utf8'));
  const first = await runSession(client, spec, specs, dest, 1800000);
  const manifest = JSON.parse(await fs.readFile(path.join(dest, 'manifest.json'), 'utf8'));
  const baseline = first.steps.flatMap((s) => (s.resolution ? [stamp(s), stamp(s.resolution)] : [stamp(s)]));
  const summary = {
    session: name,
    steps: spec.steps.length,
    messages: baseline.length,
    finalHash: first.timeline_hash,
    hashes: baseline.map((s) => s[2]),
    replays: [],
  };
  const filePath = path.join(dest, 'final.mp4'),
    streams = probe(filePath);
  const video = streams.find((s) => s.codec_type === 'video'),
    [numerator, denominator] = video.r_frame_rate.split('/').map(Number),
    fps = numerator / denominator;
  const finalSeconds = baseline.at(-1)[3];
  summary.output = {
    sha256: createHash('sha256')
      .update(await fs.readFile(filePath))
      .digest('hex'),
    codecs: streams.map((s) => s.codec_name),
    fps,
    duration: Number(video.duration),
    lengthErrorFrames: Math.abs(finalSeconds - Number(video.duration)) * fps,
  };
  assert.ok(
    summary.output.lengthErrorFrames <= 1.001,
    `${name} MP4 duration differs from final applied step`,
  );
  if (name === '01-editor-session') summary.captionByStep = [];
  for (let repetition = 2; repetition <= 3; repetition++) {
    const fresh = await client.request('/api/v1/projects/' + manifest.project_id + '/sessions', {});
    const route = '/api/v1/sessions/' + fresh.session_id,
      observed = [];
    for (const [i, step] of spec.steps.entries()) {
      const reply = await client.request(route + '/steps', { say: step.say });
      observed.push(stamp(reply));
      if (reply.status === 'needs_clarification' && step.answer)
        observed.push(stamp(await client.request(route + '/steps', { say: step.answer })));
      if (name === '01-editor-session' && repetition === 2) {
        const snapshot = await client.request(route),
          state = snapshot.timeline ?? snapshot.state;
        const cap = state.captions.find((cap) => cap.customText && cap.text === 'Welcome!');
        assert.ok(cap, 'Expected the added caption after step ' + (i + 1));
        const projected = projectCaptionsToTimeline(state).filter((c) => c.text === 'Welcome!');
        assert.equal(projected.length, 1);
        summary.captionByStep.push({
          step: i + 1,
          originalWords: cap.words.map((w) => w.word),
          source: [cap.sourceStart, cap.sourceEnd],
          output: [projected[0].timelineStart, projected[0].timelineEnd],
          color: cap.styleOverride?.color ?? state.captionStyle.color,
          duration: state.duration,
        });
      }
    }
    assert.deepEqual(observed, baseline, name + ' replay ' + repetition);
    assert.equal((await client.request(route)).timeline_hash, first.timeline_hash);
    summary.replays.push({ run: repetition, matchedMessages: observed.length, finalHashMatched: true });
  }
  if (summary.captionByStep) {
    const p = summary.captionByStep;
    assert.deepEqual(
      p[0].originalWords.map((w) => w.toLowerCase().replace(/[^a-z]/g, '')),
      ['welcome', 'to', 'the', 'channel'],
    );
    assert.ok(p[0].source[0] >= 42 && p[0].source[1] <= 44);
    assert.ok(Math.abs(p[0].duration - p[1].duration - 30) < 0.001);
    assert.ok(Math.abs(p[1].output[0] - (p[0].source[0] - 30)) < 0.001);
    assert.ok(Math.abs(p[4].output[0] - p[0].source[0]) < 0.001);
    assert.deepEqual(p[5].output, p[1].output);
    assert.match(p[6].color, /^#(?:ff0000|ef4444)$/i);
    const frames = captionFrames(filePath),
      expected = p.at(-1).output;
    summary.redCaption = {
      ...frames,
      firstSeconds: frames.first / fps,
      endExclusiveSeconds: (frames.last + 1) / fps,
    };
    assert.ok(Math.abs(frames.first / fps - expected[0]) * fps <= 1.001);
    assert.ok(Math.abs((frames.last + 1) / fps - expected[1]) * fps <= 1.001);
    assert.equal(frames.frameCount, frames.last - frames.first + 1, 'Red caption must be continuous');
  }
  entries.push(summary);
  await save();
  console.log(name, '3/3', baseline.length, 'messages; rendered', summary.output.duration, 's');
}
