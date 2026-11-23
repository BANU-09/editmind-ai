import narrationTimings from '../src/shared/demoNarration.json';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type {
  FillerHit,
  ImportantMoment,
  MediaAnalysis,
  SceneInfo,
  SilenceRange,
  SpeakerInfo,
  TranscriptSegment,
  TranscriptWord,
} from '../src/shared/types';
import { db, DEMOS_DIR, THUMBS_DIR } from './db';
import { alignWordsWithAudioEnergy, extractAudioFeatures } from './mediaProcessor';

const execFileAsync = promisify(execFile);

export interface DemoSpec {
  id: keyof typeof narrationTimings;
  title: string;
  category: string;
  description: string;
  imagePath: string;
  examplePrompts: string[];
  beats: Array<{
    speaker: string;
    topic: string;
    text: string;
    pauseAfterSec?: number;
    sceneTitle: string;
    sceneDescription: string;
    objects: string[];
    activities: string[];
    important?: {
      category: ImportantMoment['category'];
      title: string;
      reason: string;
    };
    zoomMode: 'wide' | 'pan-right' | 'zoom-in' | 'pan-left';
  }>;
}

const DEMO_SPECS: DemoSpec[] = [
  {
    id: 'demo-keynote',
    title: 'NovaPulse AI Product Keynote',
    category: 'Product Keynote',
    description:
      'Launch keynote featuring repeated pricing mentions, product benefits, live editing demonstration, natural pauses, filler words, and closing call to action.',
    imagePath: path.resolve(process.cwd(), 'src/assets/images/demo_keynote_bg_1795193518740.jpg'),
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
        sceneDescription: 'Keynote speaker on main stage introducing NovaPulse AI under cyan and violet stage lighting.',
        objects: ['stage', 'lectern', 'projection screen', 'audience'],
        activities: ['keynote speech', 'audience presentation'],
        zoomMode: 'wide',
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
        zoomMode: 'pan-right',
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
        zoomMode: 'zoom-in',
      },
      {
        speaker: 'Elena Vance',
        topic: 'Live Demonstration',
        text: 'Now watch this live AI product demonstration. Type remove filler words or jump to any spoken topic and the cut renders automatically.',
        pauseAfterSec: 0.6,
        sceneTitle: 'Live AI Editing Demonstration',
        sceneDescription: 'Live walkthrough demonstrating natural language prompt editing and instant timeline sync.',
        objects: ['demo interface', 'timeline', 'stage display'],
        activities: ['product demonstration', 'software walkthrough'],
        important: {
          category: 'demonstration',
          title: 'Live AI Prompt Demonstration',
          reason: 'Flagship live demonstration of prompt-based editing.',
        },
        zoomMode: 'pan-left',
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
        zoomMode: 'wide',
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
        zoomMode: 'pan-right',
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
        zoomMode: 'zoom-in',
      },
    ],
  },
  {
    id: 'demo-podcast',
    title: 'Founders Unfiltered: Two-Speaker Podcast',
    category: 'Podcast / Interview',
    description:
      'Dual-host studio conversation exploring AI post-production, camera workflows, natural pauses, filler words, and speaker handoffs.',
    imagePath: path.resolve(process.cwd(), 'src/assets/images/demo_podcast_bg_1795193519906.jpg'),
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
        zoomMode: 'wide',
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
        zoomMode: 'pan-right',
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
        zoomMode: 'pan-left',
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
        zoomMode: 'zoom-in',
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
        zoomMode: 'wide',
      },
    ],
  },
  {
    id: 'demo-tutorial',
    title: 'Color & Prompt Editing Masterclass',
    category: 'Educational Tutorial',
    description:
      'Step-by-step creator tutorial covering footage ingest, transcript navigation, semantic search, and clean MP4 rendering.',
    imagePath: path.resolve(process.cwd(), 'src/assets/images/demo_tutorial_bg_1795193519231.jpg'),
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
        zoomMode: 'wide',
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
        zoomMode: 'zoom-in',
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
        zoomMode: 'pan-right',
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
        zoomMode: 'pan-left',
      },
    ],
  },
  {
    id: 'demo-travel',
    title: 'Big Sur Dawn Drive Travel Vlog',
    category: 'Travel Vlog',
    description:
      'Atmospheric coastal road trip vlog with golden-hour narration, scenic breathing pauses, and travel storytelling.',
    imagePath: path.resolve(process.cwd(), 'src/assets/images/demo_travel_bg_1795193519336.jpg'),
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
        zoomMode: 'wide',
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
        zoomMode: 'pan-right',
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
        zoomMode: 'zoom-in',
      },
    ],
  },
  {
    id: 'demo-marketing',
    title: 'Aether SE-1 Smart Camera Launch Spot',
    category: 'Marketing Video',
    description:
      'High-contrast commercial launch spot with product hook, technical demo, pricing disclaimer, and conversion CTA.',
    imagePath: path.resolve(process.cwd(), 'src/assets/images/demo_marketing_bg_1795193520022.jpg'),
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
        sceneDescription: 'Sleek brushed titanium camera on dark slate plinth with cyan and magenta rim lighting.',
        objects: ['smart camera', 'titanium body', 'slate plinth'],
        activities: ['product reveal'],
        important: {
          category: 'benefit',
          title: 'Cinema Optics Hook',
          reason: 'Primary opening brand hook.',
        },
        zoomMode: 'wide',
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
        zoomMode: 'zoom-in',
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
        zoomMode: 'pan-left',
      },
    ],
  },
];

export function getDemoCatalogMeta() {
  return DEMO_SPECS.map((d) => ({
    id: d.id,
    title: d.title,
    category: d.category,
    description: d.description,
    examplePrompts: d.examplePrompts,
    mediaUrl: `/api/demos/${d.id}/video`,
    thumbnailUrl: `/api/demos/${d.id}/thumb`,
    estimatedTranscriptCount: d.beats.length,
    estimatedDurationSec: Math.round(
      d.beats.reduce((sum, b, i) => sum + narrationTimings[d.id][i] + (b.pauseAfterSec || 0), 0) * 10,
    ) / 10,
  }));
}

export function getDemoThumbnailFallbackPath(demoId: string): string | null {
  const spec = DEMO_SPECS.find((d) => d.id === demoId);
  if (!spec) return null;
  return fs.existsSync(spec.imagePath) ? spec.imagePath : null;
}

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
    const wordObj: TranscriptWord = {
      id: `${segId}-w${idx + 1}`,
      word: w,
      start: ws,
      end: we,
      speaker,
      isFiller,
    };
    words.push(wordObj);
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

function smoothMotionFilter(mode: DemoSpec['beats'][number]['zoomMode']): string {
  switch (mode) {
    case 'zoom-in':
      return `scale=1408:792:force_original_aspect_ratio=increase,crop=1280:720:'(iw-ow)/2+32*sin(t*0.7)':'(ih-oh)/2+18*cos(t*0.5)'`;
    case 'pan-right':
      return `scale=1440:810:force_original_aspect_ratio=increase,crop=1280:720:'min(iw-ow,t*14)':'(ih-oh)/2'`;
    case 'pan-left':
      return `scale=1440:810:force_original_aspect_ratio=increase,crop=1280:720:'max(0,(iw-ow)-t*14)':'(ih-oh)/2'`;
    case 'wide':
    default:
      return `scale=1360:765:force_original_aspect_ratio=increase,crop=1280:720:'(iw-ow)/2+24*cos(t*0.5)':'(ih-oh)/2+12*sin(t*0.4)'`;
  }
}

let demoInitPromise: Promise<void> | null = null;
const singleDemoPromises = new Map<string, Promise<void>>();

async function buildSingleDemo(spec: DemoSpec): Promise<void> {
  const videoOut = path.join(DEMOS_DIR, `${spec.id}-narrated.mp4`);
  const thumbOut = path.join(THUMBS_DIR, `${spec.id}.jpg`);
  const workDir = path.join(DEMOS_DIR, `_tmp_${spec.id}`);

  // Check if already built and registered in DB with acoustic alignment + transcriptionStatus
  const existingAsset = db
    .prepare('SELECT id, analysis_json FROM media_assets WHERE id = ?')
    .get(spec.id) as { id: string; analysis_json?: string } | undefined;

  if (existingAsset && fs.existsSync(videoOut) && fs.existsSync(thumbOut)) {
    try {
      const parsedExisting = JSON.parse(existingAsset.analysis_json || '{}') as MediaAnalysis;
      if (parsedExisting.transcriptionStatus === 'complete' && parsedExisting.detectedAudioStreams) {
        return;
      }
      // Refresh word alignment from real generated audio without rebuilding the MP4
      const { waveformPeaks, energyEnvelope40Hz } = await extractAudioFeatures(
        videoOut,
        parsedExisting.durationSec || 25,
        true,
      );
      const refreshedFillers: FillerHit[] = [];
      const refreshedTranscript = (parsedExisting.transcript || []).map((seg) => {
        const aligned = alignWordsWithAudioEnergy(
          seg.id,
          seg.text,
          seg.speaker,
          seg.start,
          seg.end,
          energyEnvelope40Hz,
        );
        refreshedFillers.push(...aligned.fillers);
        return { ...seg, words: aligned.words };
      });
      const updatedAnalysis: MediaAnalysis = {
        ...parsedExisting,
        detectedAudioStreams: 1,
        transcriptionStatus: 'complete',
        language: 'en',
        waveformPeaks,
        transcript: refreshedTranscript,
        fillers: refreshedFillers,
      };
      db.prepare('UPDATE media_assets SET analysis_json = ? WHERE id = ?').run(
        JSON.stringify(updatedAnalysis),
        spec.id,
      );
      return;
    } catch {
      // Rebuild cleanly if cached JSON was corrupt
    }
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  // Copy thumbnail from generated high-res studio image
  if (fs.existsSync(spec.imagePath)) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      spec.imagePath,
      '-vf',
      'scale=640:360:force_original_aspect_ratio=increase,crop=640:360',
      '-q:v',
      '3',
      thumbOut,
    ]);
  }

  const narrationPath = path.resolve('src/assets/audio', spec.id + '.mp3');
  const videoParts: string[] = [];
  const transcript: TranscriptSegment[] = [];
  const scenes: SceneInfo[] = [];
  const importantMoments: ImportantMoment[] = [];
  const silences: SilenceRange[] = [];
  const fillers: FillerHit[] = [];
  const speakerMap = new Map<string, { time: number; count: number }>();

  let cursor = 0;

  for (let i = 0; i < spec.beats.length; i++) {
    const beat = spec.beats[i];
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

    const sceneThumb = path.join(THUMBS_DIR, `${spec.id}-sc-${i + 1}.jpg`);
    const hueShift = i % 2 === 0 ? 'eq=brightness=0.02:saturation=1.08' : 'eq=brightness=-0.02:contrast=1.06:saturation=1.12';
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      spec.imagePath,
      '-vf',
      `scale=640:360:force_original_aspect_ratio=increase,crop=640:360,${hueShift}`,
      '-q:v',
      '4',
      sceneThumb,
    ]);

    scenes.push({
      id: `sc-${spec.id}-${i + 1}`,
      start: beatStart,
      end: Math.round((beatStart + totalClipDur) * 1000) / 1000,
      title: beat.sceneTitle,
      description: beat.sceneDescription,
      objects: beat.objects,
      activities: beat.activities,
      thumbnailUrl: `/api/thumbs/${spec.id}-sc-${i + 1}.jpg`,
    });

    // Render animated visual segment with subtle drawtext chapter indicator + fast smooth crop pan
    const clipMp4 = path.join(workDir, `clip_${i}.mp4`);
    const safeTopic = beat.topic.replace(/[':]/g, '');
    const safeSpeaker = beat.speaker.replace(/[':]/g, '');
    const defaultFont = process.platform === 'win32' ? path.join(process.env.WINDIR || 'C:/Windows', 'Fonts', 'arial.ttf') : '';
    const fontFile = process.env.DEMO_FONT_FILE || defaultFont;
    const fontOption = fontFile ? "fontfile='" + fontFile.replaceAll('\\', '/').replaceAll(':', '\\:') + "':" : '';
    await execFileAsync('ffmpeg', [
      '-y',
      '-loop',
      '1',
      '-framerate',
      '24',
      '-i',
      spec.imagePath,
      '-t',
      totalClipDur.toFixed(3),
      '-vf',
      `${smoothMotionFilter(beat.zoomMode)},${hueShift},drawbox=x=36:y=32:w=420:h=54:color=black@0.58:t=fill,drawtext=${fontOption}text='${safeTopic}  |  ${safeSpeaker}':fontcolor=white:fontsize=20:x=52:y=50`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '26',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '24',
      clipMp4,
    ]);
    videoParts.push(clipMp4);

    cursor += totalClipDur;
  }

  // Concat video clips cleanly
  const videoListPath = path.join(workDir, 'video_list.txt');
  fs.writeFileSync(
    videoListPath,
    videoParts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
  );
  const fullVideoOnly = path.join(workDir, 'full_video.mp4');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    videoListPath,
    '-c',
    'copy',
    fullVideoOnly,
  ]);

  // Mux video + spoken audio (with gentle pad/shortest so sync is exact)
  await execFileAsync('ffmpeg', [
    '-y',
    '-i',
    fullVideoOnly,
    '-i',
    narrationPath,
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    '-shortest',
    videoOut,
  ]);

  // Probe true duration
  const { stdout: durOut } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoOut,
  ]);
  const trueDuration = Math.round((parseFloat(durOut.trim()) || cursor) * 1000) / 1000;

  // Align words against authentic audio PCM energy envelope
  const { waveformPeaks, energyEnvelope40Hz } = await extractAudioFeatures(
    videoOut,
    trueDuration,
    true,
  );
  const alignedFillers: FillerHit[] = [];
  for (let i = 0; i < transcript.length; i++) {
    const seg = transcript[i];
    const aligned = alignWordsWithAudioEnergy(
      seg.id,
      seg.text,
      seg.speaker,
      seg.start,
      seg.end,
      energyEnvelope40Hz,
    );
    transcript[i] = { ...seg, words: aligned.words };
    alignedFillers.push(...aligned.fillers);
  }

  const palette = ['#22D3EE', '#A855F7', '#EC4899', '#F59E0B'];
  const speakers: SpeakerInfo[] = Array.from(speakerMap.entries()).map(([name, stats], idx) => ({
    id: `spk-${idx + 1}`,
    name,
    role: idx === 0 ? 'Primary Speaker' : 'Co-Host / Guest',
    color: palette[idx % palette.length],
    speakingTimeSec: Math.round(stats.time * 10) / 10,
    segmentCount: stats.count,
  }));

  const analysis: MediaAnalysis = {
    mediaId: spec.id,
    durationSec: trueDuration,
    width: 1280,
    height: 720,
    fps: 24,
    hasAudio: true,
    detectedAudioStreams: 1,
    codec: 'h264',
    analysisMode: 'local-ffmpeg',
    transcriptionStatus: 'complete',
    language: 'en',
    analysisNote: 'Bundled demo media indexed with exact acoustic word timestamps, scene cues, and silence markers.',
    waveformPeaks,
    transcript,
    scenes,
    speakers,
    importantMoments,
    silences,
    fillers: alignedFillers,
    topics: Array.from(new Set(transcript.map((t) => t.topic))),
    summary: spec.description,
  };

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO media_assets
     (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, created_at)
     VALUES (?, NULL, NULL, 'demo', ?, 'video/mp4', ?, ?, ?, 1280, 720, 1, 'local-ffmpeg', ?, ?)
     ON CONFLICT(id) DO UPDATE SET file_path=excluded.file_path, duration_sec=excluded.duration_sec, thumbnail_url=excluded.thumbnail_url, analysis_json=excluded.analysis_json`,
  ).run(
    spec.id,
    `${spec.id}.mp4`,
    videoOut,
    `/api/demos/${spec.id}/thumb`,
    trueDuration,
    JSON.stringify(analysis),
    now,
  );

  // Clean temp directory
  fs.rmSync(workDir, { recursive: true, force: true });
}

export function ensureSingleDemoReady(demoId: string): Promise<void> {
  const spec = DEMO_SPECS.find((d) => d.id === demoId);
  if (!spec) {
    return Promise.resolve();
  }
  const existing = singleDemoPromises.get(demoId);
  if (existing) {
    return existing;
  }
  const p = buildSingleDemo(spec).catch((err) => {
    singleDemoPromises.delete(demoId);
    throw err;
  });
  singleDemoPromises.set(demoId, p);
  return p;
}

export function ensureDemoLibraryReady(): Promise<void> {
  if (!demoInitPromise) {
    demoInitPromise = (async () => {
      for (const spec of DEMO_SPECS) {
        await ensureSingleDemoReady(spec.id);
      }
    })();
  }
  return demoInitPromise;
}
