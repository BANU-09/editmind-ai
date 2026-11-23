import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createSession, stepSession } from './sessionEngine';
import type { MediaAnalysis } from '../src/shared/types';
const analysis: MediaAnalysis = {
  mediaId: 'fixture',
  durationSec: 9,
  width: 640,
  height: 360,
  fps: 25,
  hasAudio: true,
  codec: 'h264',
  analysisMode: 'local-ffmpeg',
  analysisNote: 'fixture',
  waveformPeaks: [],
  transcript: [
    {
      id: 'line-1',
      start: 1,
      end: 2,
      text: 'Hello',
      topic: 'Intro',
      speaker: 'Speaker 1',
      words: [{ id: 'w', word: 'Hello', start: 1, end: 2, speaker: 'Speaker 1' }],
    },
  ],
  scenes: [],
  speakers: [
    { id: 'spk-1', name: 'Speaker 1', role: '', color: 'blue', speakingTimeSec: 1, segmentCount: 1 },
  ],
  importantMoments: [],
  silences: [],
  fillers: [],
  topics: [],
  summary: '',
};
test('an anonymous single track reports diagnostic limits of speaker attribution', () => {
  const result = stepSession(createSession(analysis), analysis, 'Render');
  assert.match(result.response.warnings.join(' '), /attribution is unverified/);
});
test('conflict identifies the specific earlier cut and keeps state', () => {
  const cut = stepSession(createSession(analysis), analysis, 'Cut 1-3');
  const rejected = stepSession(cut.session, analysis, 'Mute 1-2');
  assert.equal(rejected.response.status, 'rejected');
  assert.match(rejected.response.summary, /Earlier edit 1.*Cut 1-3/);
  assert.equal(rejected.response.timeline_hash, cut.response.timeline_hash);
});
test('an explicit edge in a measured silence is exact even if ASR stretched a word through it', () => {
  const a = structuredClone(analysis);
  a.transcript[0].words[0].end = 5.4;
  a.silences.push({ id: 'quiet', start: 2.3, end: 6, duration: 3.7 });
  const r = stepSession(createSession(a), a, 'Cut the first 4 seconds');
  assert.equal(r.response.status, 'applied');
  assert.equal(r.session.state.duration, 5);
});
test('out-of-order ASR chunk boundaries cannot introduce duplicate playback time, including old projects', () => {
  const a = structuredClone(analysis);
  a.transcript = [1, 5, 4].map((start, i) => ({
    ...a.transcript[0],
    id: 'chunk' + i,
    start,
    end: start + 0.5,
    words: [],
  }));
  const initial = createSession(a).state;
  assert.equal(initial.duration, 9);
  assert.deepEqual(
    initial.segments.map((s) => [s.sourceStart, s.sourceEnd]),
    [
      [0, 4],
      [4, 5],
      [5, 9],
    ],
  );
  const old = {
    ...initial,
    duration: 10.05,
    segments: a.transcript.map((t, i) => ({
      ...initial.segments[0],
      id: 'seg-init-' + (i + 1),
      sourceSegmentId: t.id,
      sourceStart: i ? t.start : 0,
      sourceEnd: a.transcript[i + 1]?.start ?? 9,
      volume: 0.7,
    })),
  };
  const recovered = createSession(a, old).state;
  assert.equal(recovered.duration, 9);
  assert.ok(recovered.segments.every((s) => s.volume === 0.7));
  assert.deepEqual(
    recovered.segments.map((s) => [s.sourceStart, s.sourceEnd]),
    [
      [0, 4],
      [4, 5],
      [5, 9],
    ],
  );
});
