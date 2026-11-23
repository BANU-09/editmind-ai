import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createSession, stepSession, timelineHash, type SessionResponse } from './sessionEngine';
import { projectCaptionsToTimeline } from '../src/shared/timelineEngine';
import type { MediaAnalysis, TranscriptSegment } from '../src/shared/types';
import { toOtio } from './sessionOtio';

function line(id: number, start: number, speaker: string, text: string, topic: string): TranscriptSegment {
  const words = text
    .split(' ')
    .map((word, i) => ({
      id: 'w' + id + '-' + i,
      word,
      start: start + i * 0.5,
      end: start + (i + 1) * 0.5,
      speaker,
      confidence: 0.96,
      verificationStatus: 'verified' as const,
    }));
  return { id: 'line' + id, start, end: words.at(-1)!.end, speaker, text, topic, words };
}
const transcript = [
  line(0, 2, 'Ada', 'Hello to our audience', 'Opening'),
  line(1, 10, 'Ada', 'The cost is fair', 'Membership'),
  line(2, 20, 'Max', 'Um the price stays low', 'Member fees'),
  line(3, 42, 'Ada', 'Welcome to the channel', 'Greeting'),
  line(9, 47, 'Ada', 'The monthly fees vary', 'Membership'),
  line(4, 51, 'Max', 'Our pricing has changed', 'Subscription'),
  line(5, 57, 'Ada', 'How was your old job?', 'Interview'),
  line(6, 62, 'Max', 'My old job was testing cameras', 'Employment'),
  line(10, 70, 'Max', 'Our subscription is flexible', 'Billing'),
  line(7, 75, 'Ada', 'I like the new camera', 'Cameras'),
  line(8, 83, 'Max', 'Thanks thanks thanks thanks', 'Closing'),
];
export const sessionTestAnalysis: MediaAnalysis = {
  mediaId: 'qa-source',
  durationSec: 100,
  width: 640,
  height: 360,
  fps: 25,
  hasAudio: true,
  codec: 'h264',
  analysisMode: 'local-ffmpeg',
  analysisNote: 'Synthetic interview transcript for engine tests.',
  waveformPeaks: [],
  transcript,
  scenes: [],
  speakers: [
    { id: 'host', name: 'Ada', role: 'host', color: '#ddd', speakingTimeSec: 20, segmentCount: 5 },
    { id: 'guest', name: 'Max', role: 'guest', color: '#aaa', speakingTimeSec: 18, segmentCount: 4 },
  ],
  importantMoments: [],
  silences: [
    { id: 'g1', start: 23, end: 25, duration: 2 },
    { id: 'g2', start: 30, end: 31, duration: 1 },
    { id: 'g3', start: 66, end: 69, duration: 3 },
  ],
  fillers: [],
  topics: [],
  summary: 'An interview about membership and cameras.',
};
function script(prompts: string[], a = sessionTestAnalysis) {
  let session = createSession(a);
  const replies: SessionResponse[] = [];
  for (const input of prompts) {
    const next = stepSession(session, a, input);
    replies.push(next.response);
    session = JSON.parse(JSON.stringify(next.session));
  }
  return { session, replies, last: replies.at(-1)! };
}
const specs: Array<[string, string[], string, number?]> = [
  ['interior cut', ['Remove 30–40'], 'applied', 90],
  ['intro duration', ['Cut the first thirty seconds'], 'applied', 70],
  ['end duration', ['Remove the last 10 seconds'], 'applied', 90],
  ['minute and seconds', ['Cut the first a minute twenty'], 'applied', 20],
  ['numeric units', ['Remove after 80 seconds'], 'applied', 80],
  ['keep interval', ['Keep only 10 to 20 seconds'], 'applied', 10],
  ['range past source', ['Cut 90 to 110'], 'rejected', 100],
  ['repeated range', ['Remove 30-40', 'Remove 30-40'], 'applied', 90],
  ['entire range', ['Remove 0-100'], 'rejected', 100],
  ['entire words', ['Cut everything'], 'rejected', 100],
  ['lower speed boundary', ['Slow down 30-40 by 0.25x'], 'applied', 130],
  ['upper speed boundary', ['Speed up 30-40 by 4x'], 'applied', 92.5],
  ['invalid speed', ['Speed up 10x'], 'rejected', 100],
  ['overlapping speeds', ['Speed up 30-40 by 2x', 'Speed up 35-45 by 4x'], 'applied', 90],
  ['mute exact word', ['Mute the word welcome'], 'applied', 100],
  ['bleep exact word', ['Bleep the word welcome'], 'applied', 100],
  ['unavailable word', ['Bleep the word marshmallow'], 'rejected', 100],
  ['ambiguous word', ['Mute the word thanks'], 'needs_clarification', 100],
  ['ordinal word', ['Remove the second mention of thanks'], 'applied', 99.5],
  ['all duplicate words', ['Remove every mention of thanks'], 'applied', 98],
  ['cleanup fillers', ['Remove filler words'], 'applied', 99.5],
  ['cleanup measured silence', ['Remove silences longer than 2 seconds'], 'applied', 97.22],
  [
    'preserve deliberate pause',
    ['Protect the pause from 66 to 69', 'Remove silences longer than 2 seconds'],
    'applied',
    100,
  ],
  ['auto subtitles', ['Auto-caption the whole video'], 'applied', 100],
  ['word-anchored caption', ['Add a caption "On air" when I say Welcome to the channel'], 'applied', 100],
  ['source-time caption', ['Add caption "Two" at 0:20 for 3 seconds'], 'applied', 100],
  ['out-of-bounds caption', ['Add caption "Oops" at 5:00'], 'rejected', 100],
  ['overlay', ['Add text overlay "Chapter" at 0:40 for 3 seconds'], 'applied', 100],
  ['reorder by index', ['Move section 4 to the beginning'], 'applied', 100],
  ['reorder by range', ['Move 50 to 60 to the start'], 'applied', 100],
  ['music', ['Add background music'], 'applied', 100],
  ['undo cut', ['Cut 30-40', 'Undo'], 'applied', 100],
  ['redo cut', ['Cut 30-40', 'Undo', 'Redo'], 'applied', 90],
  ['redo branch invalidation', ['Cut 30-40', 'Undo', 'Cut 10-20', 'Redo'], 'rejected', 90],
  ['refuse first undo', ['Undo'], 'rejected', 100],
  ['recover first cut', ['Cut the first 30 seconds', 'Cut 70-72', 'Put the intro back'], 'applied', 98],
  ['choose ambiguous boundary', ['Remove everything after I say thanks', 'the second one'], 'applied', 84],
  ['cancel ambiguous boundary', ['Remove everything after I say thanks', 'Cancel'], 'applied', 100],
  ['subject matches expanded', ['Remove the part about pricing'], 'needs_clarification', 100],
  ['resolved topical match', ['Remove the part about pricing', 'the second one'], 'applied', 97.5],
  ['vague content selection', ['Remove the boring part'], 'needs_clarification', 100],
  ['shorten request', ['Make it shorter'], 'needs_clarification', 100],
  ['atomic error', ['Cut 30-40 and then speed up 10x'], 'rejected', 100],
  ['atomic undo', ['Cut 30-40 and then add background music', 'Undo'], 'applied', 100],
  ['new instruction at failed branch', ['Cut 30-40', 'Undo', 'Cut 90-101', 'Redo'], 'applied', 90],
  ['render request', ['Render'], 'applied', 100],
];
for (const [name, prompts, status, duration] of specs) {
  test('session: ' + name, () => {
    const first = script(prompts);
    assert.equal(first.last.status, status, JSON.stringify(first.last));
    if (duration !== undefined)
      assert.ok(Math.abs(first.session.state.duration - duration) < 0.002, JSON.stringify(first.last));
    assert.ok(
      first.replies.every(
        (r) => r.time_policy === 'original_source_seconds' && r.summary.includes('original source seconds'),
      ),
    );
    for (let i = 0; i < 2; i++)
      assert.deepEqual(
        script(prompts).replies.map((r) => r.timeline_hash),
        first.replies.map((r) => r.timeline_hash),
      );
  });
}
test('custom caption follows its words through cut, selective restore, undo and style', () => {
  const input = [
    'Add caption "On air" when I say Welcome to the channel',
    'Cut the first 30 seconds',
    'Remove the part about pricing',
    'the second one',
    'Speed up from 1:00 to 1:30 by 2x',
    'Actually put the intro back',
    'Undo',
    'Make that caption red',
    'Render',
  ];
  const stateAt = (n: number) => script(input.slice(0, n)).session.state;
  const captionAt = (n: number) => projectCaptionsToTimeline(stateAt(n)).find((c) => c.text === 'On air');
  assert.equal(captionAt(1)?.timelineStart, 42);
  assert.equal(captionAt(2)?.timelineStart, 12);
  assert.equal(captionAt(6)?.timelineStart, 42);
  assert.equal(captionAt(7)?.timelineStart, 12);
  assert.equal(captionAt(8)?.styleOverride?.color, '#FF0000');
  assert.equal(stateAt(5).duration, stateAt(7).duration);
  const { replies, last } = script(input);
  assert.deepEqual(
    replies.map((r) => r.status),
    [
      'applied',
      'applied',
      'needs_clarification',
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
      'applied',
    ],
  );
  assert.equal(stateAt(4).duration, 68);
  assert.equal(stateAt(5).duration, 53);
  assert.equal(stateAt(6).duration, 83);
  assert.equal(last.code, 'RENDER_REQUESTED');
});
test('source-anchored text disappears on full cut, follows surviving words after partial cut, returns on restore', () => {
  const text = 'Add caption "On air" when I say Welcome to the channel';
  const get = (steps: string[]) =>
    projectCaptionsToTimeline(script([text, ...steps]).session.state).filter((c) => c.text === 'On air');
  assert.equal(get(['Cut 42-44']).length, 0);
  assert.match(script([text, 'Cut 42-44']).last.warnings.join(' '), /Hidden captions/);
  assert.equal(get(['Cut 42-43'])[0].sourceStart, 43);
  assert.equal(get(['Cut 42-44', 'Restore the last cut'])[0].sourceStart, 42);
});
test('selective undo preserves music and later cuts', () => {
  const { session } = script([
    'Cut 30-40',
    'Add background music',
    'Cut 70-72',
    'Undo the second-to-last cut but keep the music',
  ]);
  assert.equal(session.state.duration, 98);
  assert.equal(session.state.audio.duckUnderSpeech, true);
});
test('removing one spoken anchor preserves the author’s custom caption wording', () => {
  const { session, replies } = script([
    'Add caption "My greeting" when I say Welcome to the channel',
    'Remove the word Welcome',
  ]);
  assert.ok(
    replies.every((r) => r.status === 'applied'),
    JSON.stringify(replies),
  );
  assert.equal(
    projectCaptionsToTimeline(session.state).find((c) => c.text === 'My greeting')?.sourceStart,
    42.5,
  );
});
test('phrase cuts allow a full multi-word phrase longer than a single word', () => {
  const { session, last } = script(['Remove the phrase "My old job was testing cameras"']);
  assert.equal(last.status, 'applied');
  assert.equal(session.state.duration, 97);
  assert.equal(last.operations[0].type, 'REMOVE_RANGE');
});
test('word mute and overlapping filler/bleep remain attached after moving a source section', () => {
  const { session, replies } = script([
    'Move section 3 to the start',
    'Mute the word price',
    'Bleep the word um',
    'Remove filler words',
  ]);
  assert.ok(
    replies.every((r) => r.status === 'applied'),
    JSON.stringify(replies),
  );
  const mute = session.state.muteRanges![0];
  assert.equal(mute.sourceStart, 21);
  const bleep = session.state.bleeps[0];
  assert.equal(bleep.sourceStart, 20);
  assert.ok(!session.state.segments.some((s) => s.sourceStart <= 20.2 && s.sourceEnd >= 20.2));
  assert.equal(session.state.segments[0].sourceStart, 20.5);
});
test('speaker choices preserve the host unless authorized', () => {
  const prompt = 'Remove everything the guest says about their old job';
  const ask = script([prompt]);
  assert.ok(
    ask.last.options.some((o) => /lead-in/.test(o)),
    JSON.stringify(ask.last),
  );
  const only = script([prompt, 'Keep the host question']);
  assert.equal(only.last.status, 'applied');
  assert.equal(only.session.state.duration, 97);
  const both = script([prompt, 'Also remove the host question']);
  assert.equal(both.last.status, 'applied');
  assert.equal(both.session.state.duration, 94.5);
});
test('uncertain bleep asks, confirms or cancels', () => {
  const a = structuredClone(sessionTestAnalysis);
  a.transcript[3].words[0].confidence = 0.32;
  const first = script(['Bleep welcome'], a);
  assert.equal(first.last.status, 'needs_clarification');
  assert.equal(first.session.state.bleeps.length, 0);
  const yes = script(['Bleep welcome', 'Confirm'], a);
  assert.equal(yes.session.state.bleeps.length, 1);
});
test('guest-only choice keeps both speakers intact in overlapping audio', () => {
  const a = structuredClone(sessionTestAnalysis);
  a.transcript.push(line(20, 63, 'Ada', 'Really?', 'Interruption'));
  a.transcript.sort((x, y) => x.start - y.start);
  const { session, last } = script(
    ['Remove everything the guest says about their old job', 'Keep the host question'],
    a,
  );
  assert.equal(last.status, 'applied');
  assert.ok(session.state.segments.some((s) => s.sourceStart <= 63 && s.sourceEnd >= 63.5));
  assert.ok(!session.state.segments.some((s) => s.sourceStart <= 64 && s.sourceEnd > 64));
});
test('no audio, overlap, label mismatch and variable-rate warnings survive serialization', () => {
  const a = structuredClone(sessionTestAnalysis);
  a.hasAudio = false;
  a.variableFrameRate = true;
  a.transcript[1].start = 1;
  a.transcript[1].speaker = 'Max';
  const out = script(['Render'], a);
  assert.ok(out.last.warnings.length >= 4, out.last.warnings.join(','));
});
test('OpenTimelineIO exports a source reference, original anchors, retimes and matching parent duration', () => {
  const { session } = script(['Cut 30-40', 'Speed up from 60 to 80 by 2x', 'Bleep welcome']);
  const out = toOtio(session.state, sessionTestAnalysis, 'file:///example.mov');
  assert.equal(out.metadata.editmind.timeline_hash, timelineHash(session.state));
  assert.equal(out.tracks.children.length, 2);
  const clips = out.tracks.children[0].children;
  assert.equal(
    clips.reduce((n, c) => n + c.source_range.duration.value / c.source_range.duration.rate, 0),
    80,
  );
  assert.ok(clips.some((c) => c.effects.some((e) => e.time_scalar === 2)));
  assert.ok(clips.every((c) => c.media_references.DEFAULT_MEDIA.target_url === 'file:///example.mov'));
});
