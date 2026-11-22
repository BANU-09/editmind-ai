import narrationTimings from '../shared/demoNarration.json';
import type {
  FillerHit,
  ImportantMoment,
  MediaAnalysis,
  SceneInfo,
  SilenceRange,
  SpeakerInfo,
  TranscriptSegment,
  TranscriptWord,
} from '../shared/types';
import {
  createInitialProjectState,
  generateThreeVersions,
} from '../shared/timelineEngine';
import type { DemoCatalogItem, HydratedProject, LanguageOption } from './api';
import { getBundledThumbForDemo } from './demoAssets';

interface BeatSpec {
  speaker: string;
  topic: string;
  text: string;
  pauseAfterSec: number;
  sceneTitle: string;
  sceneDescription: string;
  objects: string[];
  activities: string[];
  important?: {
    category: ImportantMoment['category'];
    title: string;
    reason: string;
  };
}

interface FallbackDemoSpec {
  id: keyof typeof narrationTimings;
  title: string;
  category: string;
  description: string;
  examplePrompts: string[];
  beats: BeatSpec[];
}

const FALLBACK_DEMO_SPECS: FallbackDemoSpec[] = [
  {
    id: 'demo-keynote',
    title: 'NovaPulse AI Product Keynote',
    category: 'Product Keynote',
    description:
      'Launch keynote featuring repeated pricing mentions, product benefits, live editing demonstration, natural pauses, filler words, and closing call to action.',
    examplePrompts: [
      'Remove the second mention of pricing.',
      'Remove unnecessary pauses.',
      'Create a 60-second version.',
      'Keep only the product demonstration.',
      'Find every section where the speaker mentions AI.',
    ],
    beats: [
      {
        speaker: 'Elena Vance',
        topic: 'Introduction',
        text: 'Welcome everyone to the NovaPulse AI launch keynote. Today we are changing how teams edit video by meaning instead of scrubbing timelines.',
        pauseAfterSec: 1.6,
        sceneTitle: 'Keynote Stage Opening',
        sceneDescription:
          'Keynote speaker on main stage introducing NovaPulse AI under cyan and violet stage lighting.',
        objects: ['stage', 'lectern', 'projection screen', 'audience'],
        activities: ['keynote speech', 'audience presentation'],
      },
      {
        speaker: 'Elena Vance',
        topic: 'Core Benefits',
        text: 'With our semantic AI engine, creators cut post production time by eighty percent while keeping narrative clarity intact.',
        pauseAfterSec: 0.4,
        sceneTitle: 'Productivity Benefit Slide',
        sceneDescription: 'Stage presentation highlighting eighty percent faster editing workflow.',
        objects: ['keynote screen', 'lectern', 'microphone'],
        activities: ['explaining product benefits'],
        important: {
          category: 'benefit',
          title: '80% Time Savings Benefit',
          reason: 'Core value proposition proving workflow speedup.',
        },
      },
      {
        speaker: 'Elena Vance',
        topic: 'Pricing Overview',
        text: 'Um, let us talk about simple plans. Pricing starts at forty nine dollars per seat each month for unlimited AI indexing.',
        pauseAfterSec: 1.8,
        sceneTitle: 'Pricing Tier Reveal',
        sceneDescription: 'First pricing announcement detailing forty nine dollar per seat plan.',
        objects: ['pricing chart', 'stage lighting'],
        activities: ['presenting pricing'],
        important: {
          category: 'pricing',
          title: 'Primary Pricing Tier ($49/seat)',
          reason: 'Initial transparent pricing explanation.',
        },
      },
      {
        speaker: 'Elena Vance',
        topic: 'Live Demonstration',
        text: 'Now watch this live AI product demonstration. Type remove filler words or jump to any spoken topic and the cut renders automatically.',
        pauseAfterSec: 0.6,
        sceneTitle: 'Live AI Editing Demonstration',
        sceneDescription:
          'Live walkthrough demonstrating natural language prompt editing and instant timeline sync.',
        objects: ['demo interface', 'timeline', 'stage display'],
        activities: ['product demonstration', 'software walkthrough'],
        important: {
          category: 'demonstration',
          title: 'Live AI Prompt Demonstration',
          reason: 'Flagship live demonstration of prompt-based editing.',
        },
      },
      {
        speaker: 'Elena Vance',
        topic: 'Repeated Pricing',
        text: 'Uh, and just as a quick reminder, pricing starts at forty nine dollars per seat with zero hidden export fees.',
        pauseAfterSec: 1.5,
        sceneTitle: 'Pricing Recap Slide',
        sceneDescription: 'Second mention of pricing repeating the forty nine dollar rate.',
        objects: ['stage screen', 'lectern'],
        activities: ['repeating pricing details'],
      },
      {
        speaker: 'Elena Vance',
        topic: 'Customer Proof',
        text: 'Studios using AI semantic search find exact camera takes in seconds rather than hours of manual review.',
        pauseAfterSec: 0.5,
        sceneTitle: 'Enterprise Adoption Showcase',
        sceneDescription: 'Overview of production teams adopting semantic search.',
        objects: ['audience', 'display wall'],
        activities: ['customer case study'],
        important: {
          category: 'explanation',
          title: 'Semantic Search Workflow Explanation',
          reason: 'Explains how studios locate takes instantly.',
        },
      },
      {
        speaker: 'Elena Vance',
        topic: 'Conclusion CTA',
        text: 'Terms apply to annual enterprise billing. Start your free fourteen day trial today and publish faster with NovaPulse AI.',
        pauseAfterSec: 0.3,
        sceneTitle: 'Closing Call To Action',
        sceneDescription: 'Final keynote frame with disclaimer and free trial call to action.',
        objects: ['cta banner', 'stage spotlight'],
        activities: ['closing keynote', 'call to action'],
        important: {
          category: 'cta',
          title: 'Free Trial Call To Action & Terms',
          reason: 'Essential conversion CTA and billing disclaimer.',
        },
      },
    ],
  },
  {
    id: 'demo-podcast',
    title: 'Founders Unfiltered: Two-Speaker Podcast',
    category: 'Podcast / Interview',
    description:
      'Dual-host studio conversation exploring AI post-production, camera workflows, natural pauses, filler words, and speaker handoffs.',
    examplePrompts: [
      'Remove filler words.',
      'Remove unnecessary pauses.',
      'Find every section where the speaker mentions AI.',
      'Add captions to the entire video.',
    ],
    beats: [
      {
        speaker: 'Maya Chen',
        topic: 'Podcast Intro',
        text: 'Welcome back to Founders Unfiltered. Today Liam and I are breaking down how AI tools transform video editing.',
        pauseAfterSec: 1.2,
        sceneTitle: 'Studio Two-Shot Opening',
        sceneDescription: 'Maya and Liam seated across a walnut desk with studio broadcast microphones.',
        objects: ['microphones', 'headphones', 'audio mixer', 'walnut wall'],
        activities: ['podcast hosting', 'introductory conversation'],
      },
      {
        speaker: 'Liam Brooks',
        topic: 'Editing Bottleneck',
        text: 'Um, honestly, scrubbing ninety minutes of raw interview footage used to take my whole afternoon.',
        pauseAfterSec: 1.5,
        sceneTitle: 'Liam Guest Perspective',
        sceneDescription: 'Liam speaking into dynamic studio mic with notes in hand.',
        objects: ['microphone', 'notebook', 'mixer'],
        activities: ['interview response', 'storytelling'],
      },
      {
        speaker: 'Maya Chen',
        topic: 'Content Protection',
        text: 'Exactly. What changed everything for our studio was content protection so an editor never deletes a sponsor disclaimer by mistake.',
        pauseAfterSec: 0.5,
        sceneTitle: 'Maya Explaining Protection',
        sceneDescription: 'Maya gesturing warmly while discussing editorial safeguards.',
        objects: ['coffee mug', 'microphone', 'headphones'],
        activities: ['explaining safety guardrails'],
        important: {
          category: 'explanation',
          title: 'Sponsor & Disclaimer Protection Insight',
          reason: 'Key podcast takeaway on protecting critical segments.',
        },
      },
      {
        speaker: 'Liam Brooks',
        topic: 'Multi-Version Publishing',
        text: 'Uh, and generating a fast hook version for social alongside our full episode saved our team ten hours a week.',
        pauseAfterSec: 0.4,
        sceneTitle: 'Multi-Format Discussion',
        sceneDescription: 'Both hosts discussing social hooks versus deep-dive episodes.',
        objects: ['audio console', 'headphones'],
        activities: ['podcast dialogue'],
        important: {
          category: 'benefit',
          title: 'Ten Hours Saved Per Week',
          reason: 'Quantified time savings benefit from multi-version export.',
        },
      },
      {
        speaker: 'Maya Chen',
        topic: 'Episode Outro',
        text: 'Subscribe for next week when we test live camera workflows. Thanks for tuning in.',
        pauseAfterSec: 0.3,
        sceneTitle: 'Podcast Closing',
        sceneDescription: 'Hosts wrapping up the interview.',
        objects: ['microphones', 'studio desk'],
        activities: ['closing remarks'],
        important: {
          category: 'cta',
          title: 'Subscribe Call To Action',
          reason: 'Channel subscription CTA at close.',
        },
      },
    ],
  },
  {
    id: 'demo-tutorial',
    title: 'Color & Prompt Editing Masterclass',
    category: 'Educational Tutorial',
    description:
      'Step-by-step creator tutorial covering footage ingest, transcript navigation, semantic search, and clean MP4 rendering.',
    examplePrompts: [
      'Make the introduction twice as fast.',
      'Change captions to yellow.',
      'Remove unnecessary pauses.',
      'Move the conclusion to the beginning.',
    ],
    beats: [
      {
        speaker: 'Marcus Cole',
        topic: 'Tutorial Introduction',
        text: 'Hey creators, in this masterclass you will learn how to turn raw studio footage into a finished edit using plain English prompts.',
        pauseAfterSec: 1.4,
        sceneTitle: 'Workstation Overview',
        sceneDescription: 'Creator desk with ultrawide monitor showing color curves and cinema lens.',
        objects: ['ultrawide monitor', 'keyboard', 'cinema lens', 'headphones'],
        activities: ['tutorial introduction', 'desk showcase'],
      },
      {
        speaker: 'Marcus Cole',
        topic: 'Step 1 Ingest & Index',
        text: 'Step one is indexing your clip. The AI maps every spoken word, silence gap, and scene change onto a unified timeline.',
        pauseAfterSec: 0.5,
        sceneTitle: 'Timeline & Waveform View',
        sceneDescription: 'Close focus on monitor editing interface and audio scopes.',
        objects: ['monitor', 'waveform', 'color wheels'],
        activities: ['teaching indexing workflow'],
        important: {
          category: 'explanation',
          title: 'Step 1: Unified Semantic Indexing',
          reason: 'Core educational concept explaining how indexing works.',
        },
      },
      {
        speaker: 'Marcus Cole',
        topic: 'Step 2 Warning & Safety',
        text: 'Important warning before exporting: always verify your audio sample rate and protected disclaimer markers so nothing gets clipped.',
        pauseAfterSec: 1.3,
        sceneTitle: 'Export Pre-Flight Warning',
        sceneDescription: 'Desk shot highlighting audio hardware and SSD drive.',
        objects: ['ssd drive', 'notebook', 'pen'],
        activities: ['sharing technical warning'],
        important: {
          category: 'warning',
          title: 'Audio & Disclaimer Pre-Flight Warning',
          reason: 'Critical instructional warning to prevent export mistakes.',
        },
      },
      {
        speaker: 'Marcus Cole',
        topic: 'Tutorial Conclusion',
        text: 'Now try exporting in 1080p MP4 and drop your questions in the comments below.',
        pauseAfterSec: 0.3,
        sceneTitle: 'Final Render Summary',
        sceneDescription: 'Full studio workstation wrap-up.',
        objects: ['ultrawide monitor', 'camera lens'],
        activities: ['wrapping up tutorial'],
        important: {
          category: 'cta',
          title: 'Export & Community CTA',
          reason: 'Final call to action for students.',
        },
      },
    ],
  },
  {
    id: 'demo-travel',
    title: 'Big Sur Dawn Drive Travel Vlog',
    category: 'Travel Vlog',
    description:
      'Atmospheric coastal road trip vlog with golden-hour narration, scenic breathing pauses, and travel storytelling.',
    examplePrompts: [
      'Remove unnecessary pauses.',
      'Add background music.',
      'Make the introduction twice as fast.',
      'Add captions to the entire video.',
    ],
    beats: [
      {
        speaker: 'Aria Navarro',
        topic: 'Sunrise Departure',
        text: 'Five thirty in the morning on Highway One, and the coastal fog is finally breaking over the Pacific cliffs.',
        pauseAfterSec: 1.7,
        sceneTitle: 'Golden Hour Coastal Highway',
        sceneDescription: 'Sweeping aerial view of sunlit cliffside road and ocean surf.',
        objects: ['coastal highway', 'ocean waves', 'cliffs', 'cars'],
        activities: ['road trip driving', 'sunrise filming'],
      },
      {
        speaker: 'Aria Navarro',
        topic: 'Scenic Bridge Crossing',
        text: 'Every curve reveals another hidden cove. Travelling with lightweight gear lets us capture moments without slowing down.',
        pauseAfterSec: 1.4,
        sceneTitle: 'Cliffside Bridge Vista',
        sceneDescription: 'Warm sunlight illuminating bridge arching over rugged coast.',
        objects: ['bridge', 'headlands', 'sunlight'],
        activities: ['aerial sightseeing'],
        important: {
          category: 'benefit',
          title: 'Lightweight Filmmaking Insight',
          reason: 'Core creative vlog reflection.',
        },
      },
      {
        speaker: 'Aria Navarro',
        topic: 'Vlog Closing',
        text: 'Follow along for part two as we hike into the redwoods at dusk.',
        pauseAfterSec: 0.4,
        sceneTitle: 'Horizon Sunset Outro',
        sceneDescription: 'Wide coastal horizon fading into warm clouds.',
        objects: ['sun', 'clouds', 'pacific ocean'],
        activities: ['vlog outro'],
        important: {
          category: 'cta',
          title: 'Part Two Series CTA',
          reason: 'Viewer retention CTA for next episode.',
        },
      },
    ],
  },
  {
    id: 'demo-marketing',
    title: 'Aether SE-1 Smart Camera Launch Spot',
    category: 'Marketing Video',
    description:
      'High-contrast commercial launch spot with product hook, technical demo, pricing disclaimer, and conversion CTA.',
    examplePrompts: [
      'Keep only the product demonstration.',
      'Create a 15-second fast version.',
      'Remove background noise.',
      'Change captions to yellow.',
    ],
    beats: [
      {
        speaker: 'Jordan Vance',
        topic: 'Launch Hook',
        text: 'Meet Aether SE One. Cinema grade optics engineered into brushed titanium.',
        pauseAfterSec: 0.7,
        sceneTitle: 'Titanium Chassis Reveal',
        sceneDescription:
          'Sleek brushed titanium camera on dark slate plinth with cyan and magenta rim lighting.',
        objects: ['smart camera', 'titanium body', 'slate plinth'],
        activities: ['product reveal'],
        important: {
          category: 'benefit',
          title: 'Cinema Optics Hook',
          reason: 'Primary opening brand hook.',
        },
      },
      {
        speaker: 'Jordan Vance',
        topic: 'Product Demonstration',
        text: 'Watch the autofocus lock instantly at sixty frames per second with zero focus breathing in low light.',
        pauseAfterSec: 1.2,
        sceneTitle: 'Autofocus Lens Demo',
        sceneDescription: 'Close inspection of luminous cyan lens ring and precision dials.',
        objects: ['camera lens', 'control dial', 'cyan ring'],
        activities: ['product demonstration', 'autofocus test'],
        important: {
          category: 'demonstration',
          title: '60fps Low-Light Autofocus Demo',
          reason: 'Key product proof demonstration.',
        },
      },
      {
        speaker: 'Jordan Vance',
        topic: 'Pricing & Disclaimer',
        text: 'Pre order today at twelve ninety nine. Limited launch pricing valid through December thirty first, terms apply.',
        pauseAfterSec: 0.4,
        sceneTitle: 'Launch Offer & Terms',
        sceneDescription: 'Architectural gallery framing the flagship camera.',
        objects: ['gallery plinth', 'lighting strip'],
        activities: ['pricing announcement', 'legal disclaimer'],
        important: {
          category: 'disclaimer',
          title: 'Launch Pricing & Terms Disclaimer',
          reason: 'Legally required promotional expiration terms.',
        },
      },
    ],
  },
];

function buildWordsForText(
  segId: string,
  text: string,
  speaker: string,
  start: number,
  end: number,
): { words: TranscriptWord[]; fillers: FillerHit[] } {
  const rawWords = text.split(/\s+/).filter(Boolean);
  const dur = Math.max(0.2, end - start);
  const step = dur / Math.max(1, rawWords.length);
  const words: TranscriptWord[] = [];
  const fillers: FillerHit[] = [];

  rawWords.forEach((w, idx) => {
    const ws = Math.round((start + idx * step) * 1000) / 1000;
    const we = Math.round((start + (idx + 1) * step) * 1000) / 1000;
    const clean = w.toLowerCase().replace(/[^a-z]/g, '');
    const isFiller = ['um', 'uh', 'er', 'ah'].includes(clean);
    words.push({
      id: `${segId}-w${idx + 1}`,
      word: w,
      normalizedText: clean || w.toLowerCase(),
      start: ws,
      end: we,
      speaker,
      sourceSegmentId: segId,
      isFiller,
      confidence: 0.96,
      verificationStatus: 'verified',
      timingAccuracy: 'aligned',
    });
    if (isFiller) {
      fillers.push({
        id: `fil-${segId}-${idx + 1}`,
        word: w,
        start: ws,
        end: we,
        segmentId: segId,
      });
    }
  });

  return { words, fillers };
}

function buildFallbackAnalysis(spec: FallbackDemoSpec): MediaAnalysis {
  const thumb = getBundledThumbForDemo(spec.id);
  const transcript: TranscriptSegment[] = [];
  const scenes: SceneInfo[] = [];
  const importantMoments: ImportantMoment[] = [];
  const silences: SilenceRange[] = [];
  const fillers: FillerHit[] = [];
  const speakerMap = new Map<string, { time: number; count: number }>();

  let cursor = 0;

  spec.beats.forEach((beat, i) => {
    const speechDur = narrationTimings[spec.id][i];
    const beatStart = Math.round(cursor * 1000) / 1000;
    const beatEnd = Math.round((cursor + speechDur) * 1000) / 1000;
    const pauseDur = beat.pauseAfterSec || 0;

    if (pauseDur >= 0.8) {
      silences.push({
        id: `sil-${spec.id}-${i + 1}`,
        start: beatEnd,
        end: Math.round((beatEnd + pauseDur) * 1000) / 1000,
        duration: Math.round(pauseDur * 1000) / 1000,
      });
    }

    const totalClipDur = speechDur + pauseDur;
    const segId = `tr-${spec.id}-${i + 1}`;
    const builtWords = buildWordsForText(segId, beat.text, beat.speaker, beatStart, beatEnd);
    fillers.push(...builtWords.fillers);

    transcript.push({
      id: segId,
      start: beatStart,
      end: Math.round((beatStart + totalClipDur) * 1000) / 1000,
      speaker: beat.speaker,
      text: beat.text,
      topic: beat.topic,
      words: builtWords.words,
      isImportant: Boolean(beat.important),
      importantCategory: beat.important?.category,
    });

    if (beat.important) {
      importantMoments.push({
        id: `imp-${spec.id}-${i + 1}`,
        category: beat.important.category,
        title: beat.important.title,
        reason: beat.important.reason,
        start: beatStart,
        end: beatEnd,
        protected: true,
        segmentId: segId,
      });
    }

    const spk = speakerMap.get(beat.speaker) || { time: 0, count: 0 };
    spk.time += speechDur;
    spk.count += 1;
    speakerMap.set(beat.speaker, spk);

    scenes.push({
      id: `sc-${spec.id}-${i + 1}`,
      start: beatStart,
      end: Math.round((beatStart + totalClipDur) * 1000) / 1000,
      title: beat.sceneTitle,
      description: beat.sceneDescription,
      objects: beat.objects,
      activities: beat.activities,
      thumbnailUrl: thumb,
    });

    cursor += totalClipDur;
  });

  const palette = ['#22D3EE', '#A855F7', '#EC4899', '#F59E0B'];
  const speakers: SpeakerInfo[] = Array.from(speakerMap.entries()).map(([name, stats], idx) => ({
    id: `spk-${idx + 1}`,
    name,
    role: idx === 0 ? 'Primary Speaker' : 'Co-Host / Guest',
    color: palette[idx % palette.length],
    speakingTimeSec: Math.round(stats.time * 10) / 10,
    segmentCount: stats.count,
  }));

  const durationSec = Math.round(cursor * 1000) / 1000;
  const peaks: number[] = [];
  for (let i = 0; i < 140; i++) {
    const t = (i / 140) * durationSec;
    const inSilence = silences.some((s) => t >= s.start && t <= s.end);
    peaks.push(
      inSilence
        ? 0.04
        : Math.round((0.35 + 0.5 * Math.abs(Math.sin(i * 0.43 + spec.id.length))) * 100) / 100,
    );
  }

  return {
    mediaId: spec.id,
    durationSec,
    width: 1280,
    height: 720,
    fps: 24,
    hasAudio: true,
    detectedAudioStreams: 1,
    codec: 'h264',
    analysisMode: 'local-ffmpeg',
    transcriptionStatus: 'complete',
    language: 'en',
    detectedLanguage: 'en',
    detectedLanguageLabel: 'English',
    languageConfidence: 0.98,
    wordCount: transcript.reduce((sum, seg) => sum + seg.words.length, 0),
    analysisNote:
      'Interactive demo media with word-level timestamps, speaker markers, silences, and scene index.',
    waveformPeaks: peaks,
    transcript,
    scenes,
    speakers,
    importantMoments,
    silences,
    fillers,
    topics: Array.from(new Set(transcript.map((t) => t.topic))),
    summary: spec.description,
  };
}

// Earlier browser projects estimated speech duration from word count. Keep saved
// cuts and captions on their original clock while seeking the recorded narration.
export function getNarrationPosition(analysis: MediaAnalysis, sourceTime: number) {
  const spec = FALLBACK_DEMO_SPECS.find(d => d.id === analysis.mediaId);
  if (!spec) return { time: sourceTime, rate: 1 };
  let recordingStart = 0;
  for (const [i, beat] of spec.beats.entries()) {
    const speechSec = narrationTimings[spec.id][i];
    const segment = analysis.transcript[i];
    if (!segment) break;
    if (sourceTime <= segment.end + 0.001) {
      const offset = Math.max(0, sourceTime - segment.start);
      const speechLength = Math.max(0.001, segment.end - segment.start - beat.pauseAfterSec);
      const rate = speechSec / speechLength;
      return offset < speechLength
        ? { time: recordingStart + offset * rate, rate }
        : { time: recordingStart + speechSec + offset - speechLength, rate: 1 };
    }
    recordingStart += speechSec + beat.pauseAfterSec;
  }
  return { time: sourceTime, rate: 1 };
}

export const FALLBACK_DEMOS: DemoCatalogItem[] = FALLBACK_DEMO_SPECS.map((spec) => {
  const thumb = getBundledThumbForDemo(spec.id);
  const estimatedDuration =
    Math.round(
      spec.beats.reduce(
        (sum, b, i) => sum + narrationTimings[spec.id][i] + b.pauseAfterSec,
        0,
      ) * 10,
    ) / 10;

  return {
    id: spec.id,
    title: spec.title,
    category: spec.category,
    description: spec.description,
    examplePrompts: spec.examplePrompts,
    mediaUrl: '',
    thumbnailUrl: thumb,
    durationSec: estimatedDuration,
    topics: spec.beats.map((b) => b.topic),
    transcriptCount: spec.beats.length,
  };
});

export function buildFallbackDemoProject(demoId: string, customTitle?: string): HydratedProject {
  const spec =
    FALLBACK_DEMO_SPECS.find((d) => d.id === demoId) || FALLBACK_DEMO_SPECS[0];
  const thumb = getBundledThumbForDemo(spec.id);
  const analysis = buildFallbackAnalysis(spec);
  const initialState = createInitialProjectState(analysis);
  const versions = generateThreeVersions(analysis);
  const now = new Date().toISOString();
  const projectId = `proj-local-${spec.id}-${Date.now().toString(36)}`;

  return {
    id: projectId,
    title: customTitle?.trim() || `${spec.title} Edit`,
    mediaId: spec.id,
    thumbnailUrl: thumb,
    state: initialState,
    history: [
      {
        id: `hist-${Date.now().toString(36)}`,
        timestamp: now,
        label: 'Initial Timeline',
        durationAfter: initialState.duration,
        stateSnapshot: initialState,
      },
    ],
    historyIndex: 0,
    versions,
    createdAt: now,
    updatedAt: now,
    media: {
      id: spec.id,
      sourceType: 'demo',
      filename: `${spec.id}.mp4`,
      mimeType: 'video/mp4',
      url: '',
      thumbnailUrl: thumb,
      durationSec: analysis.durationSec,
      width: 1280,
      height: 720,
      hasAudio: true,
      analysisMode: 'local-ffmpeg',
      analysis,
      createdAt: now,
    },
  };
}

export const FALLBACK_KEYNOTE_PROJECT: HydratedProject = buildFallbackDemoProject('demo-keynote');

export const FALLBACK_LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Auto-Detect', nativeLabel: 'Auto' },
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
  { code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी' },
  { code: 'ta', label: 'Tamil', nativeLabel: 'தமிழ்' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文' },
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية' },
];
