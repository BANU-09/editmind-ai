import test from 'node:test';
import assert from 'node:assert/strict';
import type { EditPlan, MediaAnalysis } from './types';
import {
  applyEditPlan,
  computeEditImpact,
  createInitialProjectState,
  generateThreeVersions,
  mapSourceTimeToTimeline,
  mapTimelineTimeToSource,
  projectCaptionsToTimeline,
  reorderSegments,
  searchMediaIndex,
  splitSegmentAtTimelineTime,
  validateEditPlan,
} from './timelineEngine';

function createSampleAnalysis(): MediaAnalysis {
  return {
    mediaId: 'media-test-1',
    durationSec: 40,
    width: 1280,
    height: 720,
    fps: 30,
    hasAudio: true,
    codec: 'h264',
    analysisMode: 'local-ffmpeg',
    analysisNote: 'Test fixture',
    waveformPeaks: [0.3, 0.7, 0.1, 0.8],
    topics: ['Introduction', 'Pricing', 'Product Demo', 'Conclusion CTA'],
    summary: 'Sample keynote video for unit testing.',
    silences: [{ id: 'sil-1', start: 9.5, end: 11.0, duration: 1.5 }],
    fillers: [{ id: 'fil-1', word: 'um', start: 12.0, end: 12.5, segmentId: 'tr-2' }],
    speakers: [
      {
        id: 'spk-1',
        name: 'Elena Vance',
        role: 'Host',
        color: '#22D3EE',
        speakingTimeSec: 38,
        segmentCount: 4,
      },
    ],
    scenes: [
      {
        id: 'sc-1',
        start: 0,
        end: 10,
        title: 'Keynote Stage Opening',
        description: 'Speaker walks onto stage introducing AI editor.',
        objects: ['lectern', 'screen'],
        activities: ['presenting'],
        thumbnailUrl: '/thumb1.jpg',
      },
      {
        id: 'sc-2',
        start: 10,
        end: 20,
        title: 'Pricing Overview',
        description: 'Pricing starts at $49 per seat.',
        objects: ['slide'],
        activities: ['explaining'],
        thumbnailUrl: '/thumb2.jpg',
      },
      {
        id: 'sc-3',
        start: 20,
        end: 30,
        title: 'Live Product Demonstration',
        description: 'Demonstrating AI prompt timeline editing.',
        objects: ['laptop', 'timeline'],
        activities: ['demonstrating'],
        thumbnailUrl: '/thumb3.jpg',
      },
      {
        id: 'sc-4',
        start: 30,
        end: 40,
        title: 'Closing CTA & Pricing Reminder',
        description: 'Second pricing mention and free trial CTA.',
        objects: ['cta-card'],
        activities: ['closing'],
        thumbnailUrl: '/thumb4.jpg',
      },
    ],
    importantMoments: [
      {
        id: 'imp-demo',
        category: 'demonstration',
        title: 'Live Product Demonstration',
        reason: 'Shows core prompt editing workflow',
        start: 20,
        end: 30,
        protected: true,
        segmentId: 'tr-3',
      },
      {
        id: 'imp-cta',
        category: 'cta',
        title: 'Free Trial Call To Action',
        reason: 'Primary conversion CTA at end of video',
        start: 34,
        end: 40,
        protected: true,
        segmentId: 'tr-4',
      },
    ],
    transcript: [
      {
        id: 'tr-1',
        start: 0,
        end: 10,
        speaker: 'Elena Vance',
        topic: 'Introduction',
        text: 'Welcome to NovaPulse AI. Edit video by meaning.',
        words: [
          { id: 'w1', word: 'Welcome', start: 0.2, end: 1.0, speaker: 'Elena Vance' },
          { id: 'w2', word: 'to', start: 1.0, end: 1.5, speaker: 'Elena Vance' },
          { id: 'w3', word: 'NovaPulse', start: 1.5, end: 3.0, speaker: 'Elena Vance' },
          { id: 'w4', word: 'AI.', start: 3.0, end: 4.5, speaker: 'Elena Vance' },
        ],
      },
      {
        id: 'tr-2',
        start: 10,
        end: 20,
        speaker: 'Elena Vance',
        topic: 'Pricing',
        text: 'Um, pricing starts at $49 per seat with no hidden fees.',
        words: [
          { id: 'w5', word: 'Um,', start: 12.0, end: 12.5, speaker: 'Elena Vance', isFiller: true },
          { id: 'w6', word: 'pricing', start: 12.6, end: 13.5, speaker: 'Elena Vance' },
          { id: 'w7', word: 'starts', start: 13.5, end: 14.2, speaker: 'Elena Vance' },
          { id: 'w8', word: 'at $49', start: 14.2, end: 15.5, speaker: 'Elena Vance' },
        ],
      },
      {
        id: 'tr-3',
        start: 20,
        end: 30,
        speaker: 'Elena Vance',
        topic: 'Product Demo',
        text: 'Watch the live product demonstration right now.',
        isImportant: true,
        importantCategory: 'demonstration',
        words: [
          { id: 'w9', word: 'Watch', start: 20.5, end: 21.5, speaker: 'Elena Vance' },
          { id: 'w10', word: 'the', start: 21.5, end: 22.0, speaker: 'Elena Vance' },
          { id: 'w11', word: 'demonstration', start: 22.0, end: 24.0, speaker: 'Elena Vance' },
        ],
      },
      {
        id: 'tr-4',
        start: 30,
        end: 40,
        speaker: 'Elena Vance',
        topic: 'Conclusion CTA',
        text: 'Again pricing is $49. Start your free trial today.',
        isImportant: true,
        importantCategory: 'cta',
        words: [
          { id: 'w12', word: 'Again', start: 30.2, end: 31.0, speaker: 'Elena Vance' },
          { id: 'w13', word: 'pricing', start: 31.0, end: 32.0, speaker: 'Elena Vance' },
          { id: 'w14', word: 'Start', start: 34.5, end: 35.5, speaker: 'Elena Vance' },
          { id: 'w15', word: 'trial', start: 35.5, end: 37.0, speaker: 'Elena Vance' },
        ],
      },
    ],
  };
}

test('timeline recalculation and source/timeline bidirectional mapping after cut and 2x speed', () => {
  const analysis = createSampleAnalysis();
  const initial = createInitialProjectState(analysis);
  assert.equal(initial.duration, 40);
  assert.equal(initial.segments.length, 4);

  // Make intro 2x speed and remove pricing segment (10..20)
  const plan: EditPlan = {
    id: 'p1',
    prompt: 'Speed up intro 2x and remove pricing',
    intentSummary: '2x intro and remove 10..20',
    aiMode: 'local-ffmpeg',
    operations: [
      { type: 'SET_SPEED', label: '2x intro', segmentId: initial.segments[0].id, speed: 2 },
      { type: 'REMOVE_RANGE', label: 'Remove pricing', sourceStart: 10, sourceEnd: 20 },
    ],
  };

  const { nextState } = applyEditPlan(initial, analysis, plan);
  // Intro (0..10 at 2x = 5s) + Demo (20..30 at 1x = 10s) + CTA (30..40 at 1x = 10s) = 25s
  assert.equal(nextState.duration, 25);
  assert.equal(nextState.segments.length, 3);
  assert.equal(nextState.segments[0].timelineEnd, 5);
  assert.equal(nextState.segments[1].timelineStart, 5);
  assert.equal(nextState.segments[1].timelineEnd, 15);

  // Source time 25 (middle of Demo) must map to timeline time 10
  assert.equal(mapSourceTimeToTimeline(nextState.segments, 25), 10);
  // Timeline time 2.5 (middle of 2x Intro) must map back to source time 5
  const mappedBack = mapTimelineTimeToSource(nextState.segments, 2.5);
  assert.equal(mappedBack?.sourceTime, 5);
});

test('captions stay attached to exact spoken words after reordering conclusion to beginning', () => {
  const analysis = createSampleAnalysis();
  const initial = createInitialProjectState(analysis);
  const reordered = reorderSegments(initial.segments, 3, 0);
  const state = { ...initial, segments: reordered };

  const projected = projectCaptionsToTimeline(state);
  assert.equal(projected[0].text, 'Again pricing is $49. Start your free trial today.');
  assert.equal(projected[0].timelineStart, 0);
  assert.equal(projected[0].timelineEnd, 10);
  // Words inside moved conclusion start near 0.2s on timeline
  assert.equal(projected[0].words[0].word, 'Again');
  assert.equal(projected[0].words[0].timelineStart, 0.2);
});

test('important content protection detects destructive cut on CTA or demonstration', () => {
  const analysis = createSampleAnalysis();
  const initial = createInitialProjectState(analysis);

  const riskyPlan: EditPlan = {
    id: 'p-risky',
    prompt: 'Remove the product demo and closing',
    intentSummary: 'Remove 20..40',
    aiMode: 'local-ffmpeg',
    operations: [{ type: 'REMOVE_RANGE', label: 'Cut demo and CTA', sourceStart: 20, sourceEnd: 40 }],
  };

  const impact = computeEditImpact(initial, analysis, riskyPlan);
  assert.equal(impact.hasProtectedCollision, true);
  assert.equal(impact.protectedWarnings.length, 2);
  assert.equal(impact.durationDelta, -20);
});

test('split segment preserves immutable source bounds and contiguous timeline', () => {
  const analysis = createSampleAnalysis();
  const initial = createInitialProjectState(analysis);
  const split = splitSegmentAtTimelineTime(initial.segments, 5);
  assert.equal(split.length, 5);
  assert.equal(split[0].sourceStart, 0);
  assert.equal(split[0].sourceEnd, 5);
  assert.equal(split[1].sourceStart, 5);
  assert.equal(split[1].sourceEnd, 10);
  assert.equal(split[4].timelineEnd, 40);
});

test('searchMediaIndex returns timestamped hits reflecting current edited timeline', () => {
  const analysis = createSampleAnalysis();
  const initial = createInitialProjectState(analysis);
  const hits = searchMediaIndex(analysis, initial.segments, 'AI');
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].inCurrentTimeline, true);
  assert.equal(hits[0].sourceStart, 0);
});

test('generateThreeVersions creates three genuinely distinct edit versions', () => {
  const analysis = createSampleAnalysis();
  const versions = generateThreeVersions(analysis);
  assert.equal(versions.length, 3);
  assert.notEqual(versions[0].durationSec, versions[2].durationSec);
  assert.ok(versions[0].segments.length > 0);
  assert.ok(versions[1].segments.length > 0);
  assert.ok(versions[2].segments.length > 0);
  assert.equal(versions[0].id, 'fast_hook');
  assert.equal(versions[1].id, 'balanced_story');
  assert.equal(versions[2].id, 'detailed_explainer');
});

test('REMOVE_WORD cuts only the exact word interval and updates caption text safely', () => {
  const analysis = createSampleAnalysis();
  const initial = createInitialProjectState(analysis);

  const plan: EditPlan = {
    id: 'p-word',
    prompt: 'Remove the word pricing',
    intentSummary: 'Remove pricing at 12.6..13.5',
    aiMode: 'local-ffmpeg',
    operations: [
      {
        type: 'REMOVE_WORD',
        label: 'Remove Word "pricing"',
        targetScope: 'word',
        targetText: 'pricing',
        removeRanges: [{ start: 12.6, end: 13.5, label: 'Word "pricing"', targetText: 'pricing' }],
      },
    ],
  };

  const { nextState, appliedCount } = applyEditPlan(initial, analysis, plan);
  assert.equal(appliedCount, 1);
  // 0.9s removed -> duration becomes 39.1s instead of cutting the full 10s segment!
  assert.equal(nextState.duration, 39.1);
  assert.equal(nextState.segments.length, 5);
  // Adjacent words in tr-2 caption ("Um,", "starts", "at $49") must remain intact
  const cap2 = nextState.captions.find((c) => c.id === 'cap-2');
  assert.ok(cap2);
  assert.equal(cap2.words.some((w) => w.word === 'pricing'), false);
  assert.equal(cap2.words.some((w) => w.word === 'starts'), true);
});

test('validateEditPlan rejects broad segment cuts disguised as word edits and out-of-bounds intervals', () => {
  const analysis = createSampleAnalysis();
  const badWordPlan: EditPlan = {
    id: 'p-bad-word',
    prompt: 'Remove word',
    intentSummary: 'Bad cut',
    aiMode: 'local-ffmpeg',
    operations: [
      {
        type: 'REMOVE_WORD',
        label: 'Broad cut',
        targetScope: 'word',
        targetText: 'pricing',
        sourceStart: 10,
        sourceEnd: 20, // 10 seconds > 2.5s cap!
      },
    ],
  };
  const v1 = validateEditPlan(analysis, badWordPlan);
  assert.equal(v1.valid, false);
  assert.ok(v1.reason?.toLowerCase().includes('broad cut'));

  const oobPlan: EditPlan = {
    id: 'p-oob',
    prompt: 'Remove future range',
    intentSummary: 'OOB',
    aiMode: 'local-ffmpeg',
    operations: [{ type: 'REMOVE_RANGE', label: 'OOB', sourceStart: 35, sourceEnd: 55 }],
  };
  const v2 = validateEditPlan(analysis, oobPlan);
  assert.equal(v2.valid, false);
});

test('REMOVE_WORD_FROM_CAPTIONS, MUTE_RANGE, word-mode projection, and caption/overlay track edits work accurately', () => {
  const analysis = createSampleAnalysis();
  let state = createInitialProjectState(analysis);

  // 1. Caption-only word removal preserves duration
  const capWordRes = applyEditPlan(state, analysis, {
    id: 'p-capword',
    prompt: 'Remove pricing from captions',
    intentSummary: 'Caption only',
    aiMode: 'local-ffmpeg',
    operations: [
      {
        type: 'REMOVE_WORD_FROM_CAPTIONS',
        label: 'Hide pricing',
        targetScope: 'caption',
        targetText: 'pricing',
        removeWordText: 'pricing',
        removeRanges: [{ start: 12.6, end: 13.5, label: 'Word "pricing"', targetText: 'pricing' }],
      },
    ],
  });
  state = capWordRes.nextState;
  assert.equal(state.duration, 40);
  assert.equal(state.captions.find((c) => c.id === 'cap-2')?.text.includes('pricing'), false);

  // 2. Mute range keeps duration intact and records muteRange
  const muteRes = applyEditPlan(state, analysis, {
    id: 'p-mute',
    prompt: 'Mute the word NovaPulse',
    intentSummary: 'Mute word',
    aiMode: 'local-ffmpeg',
    operations: [
      {
        type: 'MUTE_RANGE',
        label: 'Mute NovaPulse',
        targetScope: 'word',
        sourceStart: 1.5,
        sourceEnd: 3.0,
      },
    ],
  });
  state = muteRes.nextState;
  assert.equal(state.duration, 40);
  assert.equal(state.muteRanges?.length, 1);

  // 3. Word-by-word caption mode projects shorter 1-2 word chunks
  const wordModeState = {
    ...state,
    captionStyle: { ...state.captionStyle, mode: 'word' as const },
  };
  const wordChunks = projectCaptionsToTimeline(wordModeState);
  assert.ok(wordChunks.length > state.captions.length);

  // 4. Overlay add -> update -> delete, and caption timing/delete
  state = applyEditPlan(state, analysis, {
    id: 'p-ovl-add',
    prompt: 'Add overlay',
    intentSummary: 'Add overlay',
    aiMode: 'local-ffmpeg',
    operations: [
      {
        type: 'ADD_TEXT_OVERLAY',
        label: 'Add overlay',
        overlay: {
          text: 'Key Takeaway',
          timelineStart: 1,
          timelineEnd: 5,
          x: 50,
          y: 20,
          fontSize: 28,
          color: '#FFFFFF',
          backgroundColor: 'rgba(5,7,17,0.8)',
        },
      },
    ],
  }).nextState;
  assert.equal(state.overlays.length, 1);
  const ovlId = state.overlays[0].id;

  state = applyEditPlan(state, analysis, {
    id: 'p-ovl-upd',
    prompt: 'Update overlay',
    intentSummary: 'Update overlay',
    aiMode: 'local-ffmpeg',
    operations: [
      {
        type: 'UPDATE_OVERLAY',
        label: 'Update overlay',
        overlayId: ovlId,
        overlayPatch: { text: 'Updated Hook', fontSize: 34 },
      },
      {
        type: 'ADJUST_CAPTION_TIME',
        label: 'Adjust cap-1 timing',
        captionId: 'cap-1',
        captionStart: 0.5,
        captionEnd: 9.5,
      },
    ],
  }).nextState;
  assert.equal(state.overlays[0].text, 'Updated Hook');
  assert.equal(state.overlays[0].fontSize, 34);
  assert.equal(state.captions.find((c) => c.id === 'cap-1')?.sourceStart, 0.5);

  state = applyEditPlan(state, analysis, {
    id: 'p-del',
    prompt: 'Delete overlay and cap-1',
    intentSummary: 'Delete items',
    aiMode: 'local-ffmpeg',
    operations: [
      { type: 'DELETE_OVERLAY', label: 'Delete overlay', overlayId: ovlId },
      { type: 'DELETE_CAPTION', label: 'Delete cap-1', captionId: 'cap-1' },
    ],
  }).nextState;
  assert.equal(state.overlays.length, 0);
  assert.equal(state.captions.some((c) => c.id === 'cap-1'), false);
});

