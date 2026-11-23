// Run from any directory: node scripts/practice-edits.mjs BASE_URL NEW_OUTPUT_DIR
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './run-sessions.mjs';

const [base, output] = process.argv.slice(2);
if (!base || !output) throw new Error('Supply an API base URL and a new output directory.');
const fixture = fileURLToPath(new URL('../testpack/media/studio.mp4', import.meta.url));
const duration = 120;
const close = (a, b, tolerance = 0.001) =>
  assert.ok(Math.abs(a - b) <= tolerance, `Expected ${b}, observed ${a}`);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const applied = (say, seconds) => ({ say, status: 'applied', seconds });
const unchanged = (say, status, seconds) => ({ say, status, seconds, sameHash: true });

// Expectations are defined before the upload or any requests. Each case gets a fresh branch.
const cases = [
  {
    name: 'Caption inside a retimed excerpt',
    prediction: 'A source caption at 18–20 s plays at 3–4 s in a 13 s excerpt.',
    steps: [
      applied('Keep only 14 to 30 seconds', 16),
      applied('Add caption "Desk check" at 0:18 for 2 seconds', 16),
      applied('Make that caption red', 16),
      applied('Speed up 16 to 22 by 2x', 13),
    ],
    render: true,
    check(state) {
      const caption = state.captions.find((c) => c.customText && c.text === 'Desk check');
      assert.ok(caption);
      close(caption.sourceStart, 18);
      close(caption.sourceEnd, 20);
    },
  },
  {
    name: 'Ambiguous word followed by undo',
    prediction:
      'The two spoken occurrences of library need a choice. Bleeping the second targets only the later occurrence, and undo restores the initial hash.',
    steps: [
      unchanged('Bleep the word library', 'needs_clarification', 120),
      applied('the second one', 120),
      applied('Undo', 120),
    ],
    async after(index, reply, client, route, initial) {
      if (index === 0) assert.ok(reply.options.length >= 2);
      if (index === 1) {
        const { timeline } = await client.request(route);
        assert.equal(timeline.bleeps.length, 1);
        const bleep = timeline.bleeps[0];
        assert.ok(bleep.sourceStart >= 81 && bleep.sourceEnd < 92 && bleep.sourceEnd > bleep.sourceStart);
        return { chosenSourceSeconds: [bleep.sourceStart, bleep.sourceEnd] };
      }
      if (index === 2) assert.equal(reply.timeline_hash, initial);
    },
  },
  {
    name: 'A new edit after undo',
    prediction: 'Undo restores the intact source. A new overlay discards the old redo branch.',
    steps: [
      applied('Remove 112 to 116 seconds', 116),
      applied('Undo', 120),
      applied('Add text overlay "Archive" at 0:54 for 2 seconds', 120),
      unchanged('Redo', 'rejected', 120),
    ],
    check(state) {
      const overlay = state.overlays.find((o) => o.text === 'Archive');
      assert.ok(overlay);
      assert.equal(overlay.sourceRanges?.length, 1);
      close(overlay.sourceRanges[0].start, 54);
      close(overlay.sourceRanges[0].end, 56);
    },
  },
  {
    name: 'Overlapping rates on the source clock',
    prediction: 'The final rates are 2× over 60–64 s and 0.5× over 64–72 s. The 120 s source becomes 126 s.',
    steps: [applied('Speed up 60 to 68 by 2x', 116), applied('Slow down 64 to 72 by 0.5x', 126)],
    check(state) {
      for (const [source, rate] of [
        [59, 1],
        [62, 2],
        [66, 0.5],
        [70, 0.5],
        [74, 1],
      ]) {
        const seg = state.segments.find((s) => s.sourceStart <= source && s.sourceEnd > source);
        assert.ok(seg);
        close(seg.speed, rate);
      }
    },
  },
  {
    name: 'Atomic rejection and recovery',
    prediction:
      'An unsupported 9× rate rejects both clauses. Undo has no entry. A later valid slowdown adds four seconds.',
    steps: [
      unchanged('Cut 113 to 115 and then speed up 20 to 24 by 9x', 'rejected', 120),
      unchanged('Undo', 'rejected', 120),
      applied('Slow down 36 to 40 by 0.5x', 124),
    ],
  },
];

function checkRenderedFile(file, expectedSeconds) {
  const metadata = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name,duration,r_frame_rate',
        '-of',
        'json',
        file,
      ],
      { encoding: 'utf8' },
    ),
  );
  const video = metadata.streams.find((s) => s.codec_type === 'video'),
    audio = metadata.streams.find((s) => s.codec_type === 'audio');
  assert.equal(video?.codec_name, 'h264');
  assert.equal(audio?.codec_name, 'aac');
  const [n, d] = video.r_frame_rate.split('/').map(Number),
    fps = n / d;
  close(Number(video.duration), expectedSeconds, 1 / fps + 0.001);
  close(Number(audio.duration), expectedSeconds, 1 / fps + 0.001);
  const width = 160,
    height = 90,
    frameBytes = width * height * 3;
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
      `scale=${width}:${height}`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  const visible = [];
  for (let frame = 0; frame < raw.length / frameBytes; frame++) {
    let red = 0;
    for (let i = frame * frameBytes; i < (frame + 1) * frameBytes; i += 3)
      if (raw[i] > 95 && raw[i] > raw[i + 1] * 1.6 && raw[i] > raw[i + 2] * 1.6) red++;
    if (red >= 4) visible.push(frame);
  }
  assert.ok(visible.length, 'No red caption pixels');
  const start = visible[0] / fps,
    endExclusive = (visible.at(-1) + 1) / fps;
  close(start, 3, 1 / fps + 0.001);
  close(endExclusive, 4, 1 / fps + 0.001);
  assert.equal(
    visible.length,
    visible.at(-1) - visible[0] + 1,
    'Caption should remain visible throughout its range',
  );
  return {
    fps,
    videoSeconds: Number(video.duration),
    audioSeconds: Number(audio.duration),
    observedCaptionSeconds: [start, endExclusive],
  };
}

await mkdir(output, { recursive: false });
const report = {
  type: 'Candidate-authored practice scenarios',
  site: new URL(base).origin,
  startedUtc: new Date().toISOString(),
  source: { file: 'studio.mp4', seconds: duration, sha256: digest(await readFile(fixture)) },
  cases: [],
};
const save = () => writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
const client = await connect(base);
const form = new FormData();
form.set('video', await openAsBlob(fixture, { type: 'video/mp4' }), 'studio.mp4');
form.set('rights', 'Original studio fixture with synthetic CMU Flite narration.');
form.set('ai_generated', 'true');
const ingest = await client.request('/api/v1/media/ingest', form);
const analyzed = await client.waitJob(ingest.job_id, 600000);
assert.ok(analyzed.project_id);
for (const scenario of cases) {
  const result = { name: scenario.name, prediction: scenario.prediction, steps: [] };
  report.cases.push(result);
  try {
    const opened = await client.request('/api/v1/projects/' + analyzed.project_id + '/sessions', {});
    const route = '/api/v1/sessions/' + opened.session_id;
    let lastHash = opened.timeline_hash;
    close(opened.duration_s, duration);
    for (const [index, step] of scenario.steps.entries()) {
      const answer = await client.request(route + '/steps', { say: step.say, expected_hash: lastHash });
      const row = {
        instruction: step.say,
        expectedStatus: step.status,
        observedStatus: answer.status,
        expectedSeconds: step.seconds,
        observedSeconds: answer.duration_s,
        code: answer.code,
        hash: answer.timeline_hash,
      };
      result.steps.push(row);
      assert.equal(answer.status, step.status);
      close(answer.duration_s, step.seconds);
      assert.equal(answer.time_policy, 'original_source_seconds');
      if (step.sameHash) assert.equal(answer.timeline_hash, lastHash);
      const details = await scenario.after?.(index, answer, client, route, opened.timeline_hash);
      if (details) row.details = details;
      lastHash = answer.timeline_hash;
    }
    const snapshot = await client.request(route);
    assert.equal(snapshot.timeline_hash, lastHash);
    scenario.check?.(snapshot.timeline);
    if (scenario.render) {
      const job = await client.request(route + '/render', { resolution: '480p', quality: 'fast' });
      const done = await client.waitJob(job.job_id, 300000);
      const target = path.join(output, 'retimed-caption.mp4');
      await client.download(done.result_links.download, target);
      result.render = checkRenderedFile(target, 13);
    }
    result.passed = true;
  } catch (error) {
    result.passed = false;
    result.error = error.message;
    process.exitCode = 1;
  }
  console.log(result.name, result.passed ? 'passed' : result.error);
  await save();
}
