import test from 'node:test';
import assert from 'node:assert/strict';
import { createInitialProjectState } from '../src/shared/timelineEngine';
import type { MediaAnalysis } from '../src/shared/types';
import { planEditFromPrompt } from './aiEditor';

function makeAnalysis(): MediaAnalysis {
  return {
    mediaId: 'med-ai-test',
    durationSec: 65,
    width: 1280,
    height: 720,
    fps: 24,
    hasAudio: true,
    codec: 'h264',
    analysisMode: 'local-ffmpeg',
    analysisNote: 'test',
    waveformPeaks: [0.4, 0.7],
    topics: ['Introduction', 'Pricing Overview', 'Live Demonstration', 'Repeated Pricing', 'Conclusion CTA'],
    summary: 'Keynote test fixture',
    silences: [{ id: 's1', start: 9.0, end: 10.6, duration: 1.6 }],
    fillers: [{ id: 'f1', word: 'um', start: 12.0, end: 12.4, segmentId: 'tr-2' }],
    speakers: [{ id: 'spk1', name: 'Elena', role: 'Host', color: '#22D3EE', speakingTimeSec: 60, segmentCount: 5 }],
    scenes: [],
    importantMoments: [
      {
        id: 'imp1',
        category: 'demonstration',
        title: 'Live Demo',
        reason: 'Key product proof',
        start: 28,
        end: 42,
        protected: true,
      },
    ],
    transcript: [
      { id: 'tr-1', start: 0, end: 10, speaker: 'Elena', topic: 'Introduction', text: 'Welcome to NovaPulse AI.', words: [] },
      { id: 'tr-2', start: 10, end: 28, speaker: 'Elena', topic: 'Pricing Overview', text: 'Um, pricing starts at $49 per seat.', words: [] },
      { id: 'tr-3', start: 28, end: 42, speaker: 'Elena', topic: 'Live Demonstration', text: 'Watch the live product demonstration.', isImportant: true, importantCategory: 'demonstration', words: [] },
      { id: 'tr-4', start: 42, end: 54, speaker: 'Elena', topic: 'Repeated Pricing', text: 'Again, pricing starts at $49 per seat.', words: [] },
      { id: 'tr-5', start: 54, end: 65, speaker: 'Elena', topic: 'Conclusion CTA', text: 'Start your free trial today.', words: [] },
    ],
  };
}

test('aiEditor handles all 13 core prompt patterns deterministically', async () => {
  const analysis = makeAnalysis();
  const state = createInitialProjectState(analysis);

  const pSecondPricing = await planEditFromPrompt('Remove the second mention of pricing.', state, analysis);
  assert.equal(pSecondPricing.operations[0]?.type, 'REMOVE_RANGE');
  assert.equal(pSecondPricing.operations[0]?.sourceStart, 42);

  const pAmbiguous = await planEditFromPrompt('Remove pricing', state, analysis);
  assert.equal(pAmbiguous.requiresClarification, true);
  assert.equal(pAmbiguous.candidates?.length, 2);

  const pSilences = await planEditFromPrompt('Remove unnecessary pauses.', state, analysis);
  assert.equal(pSilences.operations[0]?.type, 'REMOVE_SILENCES');

  const pFillers = await planEditFromPrompt('Remove filler words.', state, analysis);
  assert.equal(pFillers.operations[0]?.type, 'REMOVE_FILLERS');

  const p60 = await planEditFromPrompt('Create a 60-second version.', state, analysis);
  assert.equal(p60.operations[0]?.type, 'CREATE_DURATION_CUT');

  const pDemo = await planEditFromPrompt('Keep only the product demonstration.', state, analysis);
  assert.equal(pDemo.operations[0]?.type, 'KEEP_ONLY_RANGE');

  const pFast = await planEditFromPrompt('Make the introduction twice as fast.', state, analysis);
  assert.equal(pFast.operations[0]?.type, 'SET_SPEED');
  assert.equal(pFast.operations[0]?.speed, 2);

  const pYellow = await planEditFromPrompt('Change captions to yellow.', state, analysis);
  assert.equal(pYellow.operations[0]?.type, 'STYLE_CAPTIONS');
  assert.equal(pYellow.operations[0]?.captionStylePatch?.color, '#FACC15');

  const pNoise = await planEditFromPrompt('Remove background noise.', state, analysis);
  assert.equal(pNoise.operations[0]?.audioPatch?.noiseReduction, true);

  const pMove = await planEditFromPrompt('Move the conclusion to the beginning.', state, analysis);
  assert.equal(pMove.operations[0]?.type, 'REORDER_SEGMENT');
  assert.equal(pMove.operations[0]?.toIndex, 0);

  const pFind = await planEditFromPrompt('Find every section where the speaker mentions AI.', state, analysis);
  assert.equal(pFind.searchQuery?.toLowerCase(), 'ai');
});

test('aiEditor resolves word-level, repeated-word, mute, bleep, caption-only, scene, timestamp, and shorter prompts accurately', async () => {
  const analysis = makeAnalysis();
  analysis.scenes = [
    {
      id: 'sc-1',
      start: 0,
      end: 10,
      title: 'Intro Scene',
      description: 'Opening',
      objects: [],
      activities: [],
      thumbnailUrl: '/t1.jpg',
    },
    {
      id: 'sc-2',
      start: 10,
      end: 28,
      title: 'Pricing Scene',
      description: 'Pricing',
      objects: [],
      activities: [],
      thumbnailUrl: '/t2.jpg',
    },
  ];
  analysis.transcript[0].words = [
    { id: 'w1', word: 'Welcome', start: 0.4, end: 1.1, speaker: 'Elena' },
    { id: 'w2', word: 'to', start: 1.1, end: 1.4, speaker: 'Elena' },
    { id: 'w3', word: 'NovaPulse', start: 1.4, end: 2.3, speaker: 'Elena' },
    { id: 'w4', word: 'important', start: 2.4, end: 3.1, speaker: 'Elena' },
  ];
  analysis.transcript[1].words = [
    { id: 'w5', word: 'pricing', start: 11.2, end: 12.0, speaker: 'Elena' },
    { id: 'w6', word: 'is', start: 12.0, end: 12.3, speaker: 'Elena' },
    { id: 'w7', word: 'important', start: 12.4, end: 13.1, speaker: 'Elena' },
  ];
  analysis.transcript[3].words = [
    { id: 'w8', word: 'Again', start: 42.3, end: 42.9, speaker: 'Elena' },
    { id: 'w9', word: 'pricing', start: 43.0, end: 43.8, speaker: 'Elena' },
  ];
  const state = createInitialProjectState(analysis);

  // Single occurrence exact word cut (< 1s, never full segment)
  const singleWord = await planEditFromPrompt('Remove the word NovaPulse', state, analysis);
  assert.equal(singleWord.operations[0]?.type, 'REMOVE_WORD');
  assert.equal(singleWord.operations[0]?.removeRanges?.length, 1);
  assert.equal(singleWord.operations[0]?.removeRanges?.[0].start, 1.4);
  assert.equal(singleWord.operations[0]?.removeRanges?.[0].end, 2.3);

  // Repeated word triggers clarification with exact word intervals
  const dupWord = await planEditFromPrompt('Remove the word important', state, analysis);
  assert.equal(dupWord.requiresClarification, true);
  assert.equal(dupWord.candidates?.length, 2);
  assert.equal(dupWord.candidates?.[0]?.targetScope, 'word');

  // Remove every occurrence of a word
  const allWord = await planEditFromPrompt('Remove every occurrence of the word important', state, analysis);
  assert.equal(allWord.operations[0]?.type, 'REMOVE_WORD');
  assert.equal(allWord.operations[0]?.removeRanges?.length, 2);

  // Mute / Bleep a word
  const muteWord = await planEditFromPrompt('Mute the word NovaPulse', state, analysis);
  assert.equal(muteWord.operations[0]?.type, 'MUTE_RANGE');
  assert.equal(muteWord.operations[0]?.sourceStart, 1.4);

  const bleepSecond = await planEditFromPrompt('Bleep the second occurrence of important', state, analysis);
  assert.equal(bleepSecond.operations[0]?.type, 'BLEEP_RANGE');
  assert.equal(bleepSecond.operations[0]?.sourceStart, 12.4);

  // Caption-only removal
  const capWord = await planEditFromPrompt('Remove NovaPulse from captions', state, analysis);
  assert.equal(capWord.operations[0]?.type, 'REMOVE_WORD_FROM_CAPTIONS');

  // Exact timestamp range
  const tsRange = await planEditFromPrompt('Remove 00:05 to 00:08', state, analysis);
  assert.equal(tsRange.operations[0]?.type, 'REMOVE_RANGE');
  assert.equal(tsRange.operations[0]?.sourceStart, 5);
  assert.equal(tsRange.operations[0]?.sourceEnd, 8);

  // Scene removal
  const sceneCut = await planEditFromPrompt('Remove scene 2', state, analysis);
  assert.equal(sceneCut.operations[0]?.type, 'REMOVE_RANGE');
  assert.equal(sceneCut.operations[0]?.sourceStart, 10);
  assert.equal(sceneCut.operations[0]?.sourceEnd, 28);

  // Shorter video prompt
  const shorter = await planEditFromPrompt('Make the video shorter', state, analysis);
  assert.ok(shorter.operations.length >= 1);
});

test('aiEditor supports sentence scope, discussion stemming, keep-audio/caption-only, multilingual words, uncertain warnings, and <3s latency on 60-min 10k-word transcripts', async () => {
  const analysis = makeAnalysis();
  analysis.transcript = [
    {
      id: 'tr-m1',
      start: 0,
      end: 12,
      speaker: 'Aarav',
      speakerId: 'spk1',
      topic: 'Morning Commute',
      language: 'en',
      text: 'Today our morning commute improved drastically. Everyone reached IIT Madras before nine.',
      words: [
        { id: 'mw1', word: 'Today', start: 0.4, end: 0.8, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.96 },
        { id: 'mw2', word: 'our', start: 0.8, end: 1.0, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.96 },
        { id: 'mw3', word: 'morning', start: 1.0, end: 1.5, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.96 },
        { id: 'mw4', word: 'commute', start: 1.5, end: 2.1, speaker: 'Aarav', verificationStatus: 'review_needed', confidence: 0.58, originalWord: 'compute', candidates: ['commute', 'compute'] },
        { id: 'mw5', word: 'improved', start: 2.1, end: 2.7, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw6', word: 'drastically.', start: 2.7, end: 3.4, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw7', word: 'Everyone', start: 4.0, end: 4.5, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw8', word: 'reached', start: 4.5, end: 5.0, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw9', word: 'IIT', start: 5.0, end: 5.4, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw10', word: 'Madras', start: 5.4, end: 5.9, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw11', word: 'before', start: 5.9, end: 6.3, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw12', word: 'nine.', start: 6.3, end: 6.8, speaker: 'Aarav', verificationStatus: 'verified', confidence: 0.95 },
      ],
    },
    {
      id: 'tr-m2',
      start: 12,
      end: 24,
      speaker: 'Priya',
      speakerId: 'spk2',
      topic: 'Multilingual Greeting',
      language: 'hi',
      text: 'नमस्ते दोस्तों IncuBrix में स्वागत है வணக்கம்',
      words: [
        { id: 'mw13', word: 'नमस्ते', start: 12.5, end: 13.2, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.93 },
        { id: 'mw14', word: 'दोस्तों', start: 13.2, end: 13.9, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.92 },
        { id: 'mw15', word: 'IncuBrix', start: 14.0, end: 14.8, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.94 },
        { id: 'mw16', word: 'में', start: 14.8, end: 15.1, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.95 },
        { id: 'mw17', word: 'स्वागत', start: 15.1, end: 15.8, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.91 },
        { id: 'mw18', word: 'है', start: 15.8, end: 16.1, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.96 },
        { id: 'mw19', word: 'வணக்கம்', start: 16.3, end: 17.1, speaker: 'Priya', verificationStatus: 'verified', confidence: 0.92 },
      ],
    },
  ];
  analysis.durationSec = 24;
  const state = createInitialProjectState(analysis);

  // 1) Uncertain word gating on destructive removal
  const uncertainCut = await planEditFromPrompt('Remove the word commute', state, analysis);
  assert.equal(uncertainCut.operations[0]?.type, 'REMOVE_WORD');
  assert.equal(uncertainCut.requiresUncertainConfirmation, true);
  assert.ok((uncertainCut.uncertainWordWarnings?.length || 0) >= 1);

  // 2) Keep audio, remove caption only
  const capOnly = await planEditFromPrompt('Keep the audio but remove the caption for commute', state, analysis);
  assert.equal(capOnly.operations[0]?.type, 'REMOVE_WORD_FROM_CAPTIONS');

  // 3) Sentence containing X
  const sentCut = await planEditFromPrompt('Remove the sentence containing commute', state, analysis);
  assert.equal(sentCut.operations[0]?.type, 'REMOVE_RANGE');
  assert.equal(sentCut.operations[0]?.targetScope, 'sentence');
  assert.ok((sentCut.operations[0]?.sourceEnd || 0) < 4.0, 'Sentence cut must not include second sentence');

  // 4) Discussion about X (with stemming commuting -> commute)
  const discCut = await planEditFromPrompt('Remove the discussion about commuting', state, analysis);
  assert.equal(discCut.operations[0]?.type, 'REMOVE_RANGE');
  assert.equal(discCut.operations[0]?.targetScope, 'segment');
  assert.equal(discCut.operations[0]?.sourceStart, 0);
  assert.equal(discCut.operations[0]?.sourceEnd, 12);

  // 5) Hindi & Tamil word removal
  const hiCut = await planEditFromPrompt('Remove the word नमस्ते', state, analysis);
  assert.equal(hiCut.operations[0]?.type, 'REMOVE_WORD');
  assert.equal(hiCut.operations[0]?.removeRanges?.[0]?.start, 12.5);

  const taCut = await planEditFromPrompt('Remove the word வணக்கம்', state, analysis);
  assert.equal(taCut.operations[0]?.type, 'REMOVE_WORD');
  assert.equal(taCut.operations[0]?.removeRanges?.[0]?.start, 16.3);

  // 6) Synthetic 60-minute (~10,000-word) benchmark: search + prompt planning < 3000ms
  const bigSegments = [];
  let wordCounter = 0;
  for (let i = 0; i < 625; i++) {
    const segStart = i * 5.76;
    const segEnd = (i + 1) * 5.76;
    const words = [];
    const tokens =
      i === 310
        ? ['Architectural', 'reviews', 'identified', 'a', 'critical', 'bottleneck', 'during', 'morning', 'commute', 'sync', 'today.', 'Next', 'topic', 'covers', 'caching', 'layers.']
        : ['Engineering', 'teams', 'collaborate', 'across', 'distributed', 'services', 'delivering', 'reliable', 'audio', 'processing', 'pipelines', 'at', 'global', 'scale', 'for', 'creators.'];
    for (let j = 0; j < tokens.length; j++) {
      const ws = Number((segStart + j * 0.34).toFixed(2));
      const we = Number((ws + 0.3).toFixed(2));
      words.push({
        id: `bw-${wordCounter++}`,
        word: tokens[j],
        start: ws,
        end: we,
        speaker: i % 2 === 0 ? 'Speaker 1' : 'Speaker 2',
        confidence: 0.95,
        verificationStatus: 'verified' as const,
      });
    }
    bigSegments.push({
      id: `bseg-${i}`,
      start: Number(segStart.toFixed(2)),
      end: Number(segEnd.toFixed(2)),
      speaker: i % 2 === 0 ? 'Speaker 1' : 'Speaker 2',
      topic: i === 310 ? 'Commute Bottleneck Review' : `Module ${i}`,
      text: tokens.join(' '),
      words,
    });
  }
  assert.equal(wordCounter, 10000);
  const bigAnalysis: MediaAnalysis = {
    ...analysis,
    durationSec: 3600,
    transcript: bigSegments,
    wordCount: wordCounter,
  };
  const bigState = createInitialProjectState(bigAnalysis);

  const t0 = performance.now();
  const bigWordPlan = await planEditFromPrompt('Remove the word bottleneck', bigState, bigAnalysis);
  const bigSentPlan = await planEditFromPrompt('Remove the sentence containing commute', bigState, bigAnalysis);
  const bigElapsedMs = performance.now() - t0;

  assert.equal(bigWordPlan.operations[0]?.type, 'REMOVE_WORD');
  assert.equal(bigSentPlan.operations[0]?.type, 'REMOVE_RANGE');
  assert.ok(bigElapsedMs < 3000, `Expected 60-min 10k-word prompt planning < 3000ms, got ${bigElapsedMs.toFixed(1)}ms`);
});


