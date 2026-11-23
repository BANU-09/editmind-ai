import { Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import { projectCaptionsToTimeline } from '../src/shared/timelineEngine';
import type {
  AnalysisJob,
  AudioStreamInfo,
  DetectedLanguageSegment,
  FillerHit,
  ImportantCategory,
  ImportantMoment,
  MediaAnalysis,
  ProjectState,
  SilenceRange,
  SpeakerInfo,
  TranscriptSegment,
  TranscriptWord,
  TranscriptionStatus,
  TranslationTrack,
  VerificationStatus,
  VerificationSummary,
} from '../src/shared/types';
import { getAppConfig, resolveLanguageMeta, type SttProviderMode } from './config';
import { AUDIO_DIR, db, TEMP_DIR } from './db';
import { getGeminiClient, withTimeout } from './geminiClient';

const execFileAsync = promisify(execFile);

export interface DetailedProbeMetadata {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  variableFrameRate: boolean;
  videoDurationSec?: number;
  hasAudio: boolean;
  detectedAudioStreams: number;
  audioStreams: AudioStreamInfo[];
  codec: string;
}

export interface PlannedChunk {
  index: number;
  sourceStart: number;
  sourceEnd: number;
  overlapBefore: number;
  overlapAfter: number;
}

export interface RawRecognizedWord {
  word: string;
  start: number; // source seconds
  end: number;   // source seconds
  confidence: number;
  timingAccuracy: 'model-word' | 'aligned' | 'approximate';
  chunkId?: string;
  speaker?: string;
  speakerId?: string;
  verificationStatus?: VerificationStatus;
  originalWord?: string;
  candidates?: string[];
  manuallyEdited?: boolean;
}

export interface ChunkRecognitionOutput {
  chunkId: string;
  chunkIndex: number;
  sourceStart: number;
  sourceEnd: number;
  overlapBefore: number;
  overlapAfter: number;
  text: string;
  language: string;
  provider: string;
  words: RawRecognizedWord[];
}

export interface DetectedLanguageResult {
  primaryLanguage: string;
  primaryLabel: string;
  confidence: number;
  languagesDetected: DetectedLanguageSegment[];
  isMultilingual: boolean;
  provider: string;
}

export function normalizeWordToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      }
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Inspects container duration, video geometry/rotation, and every audio stream via FFprobe.
 */
export async function inspectMediaStreams(filePath: string): Promise<DetailedProbeMetadata> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,start_time,duration,sample_rate,channels,channel_layout,bit_rate:stream_tags=rotate,language,title:stream_side_data=rotation',
    '-of',
    'json',
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      index?: number;
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      start_time?: string;
      duration?: string;
      side_data_list?: {rotation?:number}[];
      sample_rate?: string;
      channels?: number;
      channel_layout?: string;
      bit_rate?: string;
      tags?: { rotate?: string; language?: string; title?: string };
    }>;
  };

  const streams = parsed.streams || [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error('The file contains no video stream.');
  const audioStreamsRaw = streams.filter((s) => s.codec_type === 'audio');

  const audioStreams: AudioStreamInfo[] = audioStreamsRaw.map((s, audioIndex) => ({
    index: s.index ?? audioIndex,
    audioIndex,
    codec: s.codec_name || 'unknown',
    sampleRate: parseInt(s.sample_rate || '48000', 10) || 48000,
    channels: s.channels || 1,
    channelLayout: s.channel_layout || ((s.channels || 1) > 1 ? 'stereo' : 'mono'),
    language: s.tags?.language,
    title: s.tags?.title,
    bitrate: s.bit_rate ? parseInt(s.bit_rate, 10) : undefined,
    startTime: Number.isFinite(Number(s.start_time)) ? Number(s.start_time) : undefined,
    durationSec: Number.isFinite(Number(s.duration)) ? Number(s.duration) : undefined,
  }));

  const rate = (ratio?:string) => {
    const [n,d] = (ratio || '').split('/').map(Number);
    return n>0 && d>0 ? n/d : 0;
  };
  const nominal=rate(videoStream.r_frame_rate);
  const average=rate(videoStream.avg_frame_rate);
  const variableFrameRate=average>0 && nominal>0 && Math.abs(average-nominal)/nominal>0.015;
  const fps=nominal>0 && nominal<=120 ? nominal : average || 30;

  let durationSec = parseFloat(parsed.format?.duration || '0');
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    try {
      const { stderr } = await execFileAsync('ffmpeg', ['-i', filePath, '-f', 'null', '-']);
      const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)];
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        durationSec = Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
      }
    } catch { /* An unmeasurable recording must not be presented as a known duration. */ }
  }
  if (!Number.isFinite(durationSec) || durationSec<=0) throw new Error('Could not determine video duration.');

  let width = videoStream?.width || 1280;
  let height = videoStream?.height || 720;
  const rot = Math.abs(videoStream.side_data_list?.find(s=>s.rotation!==undefined)?.rotation ?? parseInt(videoStream.tags?.rotate || '0', 10));
  if (rot === 90 || rot === 270) {
    const tmp = width;
    width = height;
    height = tmp;
  }

  return {
    durationSec: Math.max(0.001, Math.round(durationSec * 1000) / 1000),
    width,
    height,
    fps: Math.min(120, Math.max(1, fps)),
    variableFrameRate,
    videoDurationSec: Number.isFinite(Number(videoStream.duration)) ? Number(videoStream.duration) : undefined,
    hasAudio: audioStreams.length > 0,
    detectedAudioStreams: audioStreams.length,
    audioStreams,
    codec: videoStream?.codec_name || 'unknown',
  };
}

/**
 * Parses any RIFF PCM WAV file into Float32Array samples by scanning for the 'data' subchunk.
 * Used exclusively per short 20-30s chunk (~960 KB) so RAM stays minimal regardless of video length.
 */
export function parseWavInt16MonoToFloat32(wavPath: string): { samples: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(wavPath);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`Invalid WAV file: ${wavPath}`);
  }
  const sampleRate = buf.readUInt32LE(24) || 16000;
  let offset = 12;
  let dataOffset = 44;
  let dataSize = buf.length - 44;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkLen = buf.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkLen, buf.length - dataOffset);
      break;
    }
    offset += 8 + chunkLen + (chunkLen % 2);
  }

  const count = Math.floor(dataSize / 2);
  const f32 = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    f32[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return { samples: f32, sampleRate };
}

// Strip long near-digital-silence tails from the recognizer input only. Whisper
// otherwise decodes a few seconds of speech in a mostly empty 30-second window.
function recognitionWindow(samples:Float32Array,sampleRate=16000) {
  let first=0,end=samples.length;
  while (first<end && Math.abs(samples[first])<0.0004) first++;
  while (end>first && Math.abs(samples[end-1])<0.0004) end--;
  if (first===samples.length) return {audio:samples.subarray(0,0),offset:0};
  const margin=Math.round(.35*sampleRate);
  const start=first>sampleRate?Math.max(0,first-margin):0;
  const stop=samples.length-end>sampleRate?Math.min(samples.length,end+margin):samples.length;
  return {audio:samples.subarray(start,stop),offset:start/sampleRate};
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Estimates speech-to-noise ratio metrics for a short chunk WAV so uncertain/noisy audio
 * receives honest calibrated confidence & review_needed / unclear_audio flags.
 */
export function computeChunkAcoustics(samples: Float32Array, sampleRate = 16000): {
  overallRms: number;
  noiseFloorRms: number;
  peakSpeechRms: number;
  snrDb: number;
} {
  if (samples.length === 0) {
    return { overallRms: 0, noiseFloorRms: 0, peakSpeechRms: 0, snrDb: 0 };
  }
  const frameLen = Math.max(160, Math.floor(sampleRate / 25)); // 40ms frames
  const frameRms: number[] = [];
  for (let i = 0; i < samples.length; i += frameLen) {
    let s = 0;
    const end = Math.min(samples.length, i + frameLen);
    for (let j = i; j < end; j++) s += samples[j] * samples[j];
    frameRms.push(Math.sqrt(s / Math.max(1, end - i)));
  }
  const sorted = [...frameRms].sort((a, b) => a - b);
  const noiseFloorRms = sorted[Math.floor(sorted.length * 0.18)] ?? 0;
  const speechRms = sorted[Math.floor(sorted.length * 0.85)] ?? 0;
  const overallRms = computeRms(samples);
  const snrDb = 20 * Math.log10(Math.max(1e-5, speechRms) / Math.max(1e-5, noiseFloorRms));
  return { overallRms, noiseFloorRms, peakSpeechRms: speechRms, snrDb };
}

/**
 * Produces an optional noise-filtered WAV copy when continuous background hum/music floor is elevated,
 * while preserving the untouched original WAV for snippet replay.
 */
async function prepareConditionedWavForStt(wavPath: string): Promise<{ sttWavPath: string; noisyAudio: boolean; snrDb: number }> {
  try {
    const { samples, sampleRate } = parseWavInt16MonoToFloat32(wavPath);
    const ac = computeChunkAcoustics(samples, sampleRate);
    const noisyAudio = ac.noiseFloorRms > 0.008 && ac.snrDb < 14;
    if (!noisyAudio) {
      return { sttWavPath: wavPath, noisyAudio: false, snrDb: ac.snrDb };
    }
    const cleanPath = wavPath.replace(/\.wav$/i, '_clean.wav');
    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      wavPath,
      '-af',
      'highpass=f=85,afftdn=nf=-22:tn=1',
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      cleanPath,
    ]).catch(async () => {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        wavPath,
        '-af',
        'highpass=f=90,lowpass=f=7600',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        cleanPath,
      ]);
    });
    if (fs.existsSync(cleanPath) && fs.statSync(cleanPath).size > 100) {
      return { sttWavPath: cleanPath, noisyAudio: true, snrDb: ac.snrDb };
    }
    return { sttWavPath: wavPath, noisyAudio: true, snrDb: ac.snrDb };
  } catch {
    return { sttWavPath: wavPath, noisyAudio: false, snrDb: 25 };
  }
}

/**
 * Pure voice-aware audio chunk planner.
 * Splits long audio tracks at detected low-energy silence boundaries into 20-30s chunks
 * with overlap windows so no boundary words are clipped or dropped.
 */
export function planVoiceAwareChunks(
  durationSec: number,
  silences: SilenceRange[],
  opts: { targetSec?: number; minSec?: number; maxSec?: number; overlapSec?: number; preferPhraseBoundaries?: boolean } = {},
): PlannedChunk[] {
  const cfg = getAppConfig();
  const total = Math.max(0.5, durationSec);
  const targetSec = opts.targetSec ?? cfg.chunkTargetSec;
  const minSec = opts.minSec ?? cfg.chunkMinSec;
  const maxSec = opts.maxSec ?? cfg.chunkMaxSec;
  const overlapSec = opts.overlapSec ?? cfg.chunkOverlapSec;

  if (total <= maxSec) {
    return [
      {
        index: 0,
        sourceStart: 0,
        sourceEnd: Math.round(total * 1000) / 1000,
        overlapBefore: 0,
        overlapAfter: 0,
      },
    ];
  }

  const splitPoints: number[] = [0];
  let cursor = 0;

  while (total - cursor > maxSec) {
    const ideal = cursor + targetSec;
    const winStart = cursor + minSec;
    const winEnd = Math.min(total - 4, cursor + maxSec);

    let bestSplit: number | null = null;
    let bestDist = Infinity;

    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid >= winStart && mid <= winEnd) {
        // A longer break is a stronger boundary between speakers or languages.
        const breakWeight = opts.preferPhraseBoundaries ? 2.5 * Math.min(1.5,s.end-s.start) : 0;
        const dist = Math.abs(mid - ideal) - breakWeight;
        if (dist < bestDist) {
          bestDist = dist;
          bestSplit = mid;
        }
      }
    }

    const split = bestSplit !== null ? bestSplit : Math.min(winEnd, ideal);
    splitPoints.push(Math.round(split * 1000) / 1000);
    cursor = split;
  }
  splitPoints.push(Math.round(total * 1000) / 1000);

  // If a strong quiet boundary separates languages, share the actual silence.
  // Overlapping voiced material from the preceding language can derail decoding.
  const overlapAt=(time:number)=>{
    if(!opts.preferPhraseBoundaries) return overlapSec;
    const pause=silences.find(s=>s.duration>=1 && s.start<time && s.end>time);
    return pause ? Math.min(overlapSec,Math.max(.1,Math.min(time-pause.start,pause.end-time)-.065)) : overlapSec;
  };
  const chunks: PlannedChunk[] = [];
  for (let i = 0; i < splitPoints.length - 1; i++) {
    const coreStart = splitPoints[i];
    const coreEnd = splitPoints[i + 1];
    const overlapBefore = i > 0 ? Math.min(overlapAt(coreStart), coreStart) : 0;
    const overlapAfter = i < splitPoints.length - 2 ? Math.min(overlapAt(coreEnd), total - coreEnd) : 0;
    chunks.push({
      index: i,
      sourceStart: Math.round(Math.max(0, coreStart - overlapBefore) * 1000) / 1000,
      sourceEnd: Math.round(Math.min(total, coreEnd + overlapAfter) * 1000) / 1000,
      overlapBefore: Math.round(overlapBefore * 1000) / 1000,
      overlapAfter: Math.round(overlapAfter * 1000) / 1000,
    });
  }

  return chunks;
}

/**
 * Pure overlap deduplication across chunk boundaries.
 * Unicode-aware: works identically on Latin, Devanagari (Hindi), Tamil, etc.
 */
export function deduplicateChunkWords(chunkOutputs: ChunkRecognitionOutput[]): RawRecognizedWord[] {
  const ordered = [...chunkOutputs].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const merged: RawRecognizedWord[] = [];

  for (const chunk of ordered) {
    const words = [...chunk.words]
      .filter((w) => w.word.trim().length > 0 && w.end > w.start)
      .sort((a, b) => a.start - b.start);

    if (merged.length === 0) {
      merged.push(...words);
      continue;
    }

    const lastAcceptedEnd = merged[merged.length - 1].end;
    const seamZoneEnd = Math.max(lastAcceptedEnd + 0.65, chunk.sourceStart + chunk.overlapBefore + 0.85);

    let startIdx = 0;
    while (startIdx < words.length && words[startIdx].end <= lastAcceptedEnd - 0.12) {
      startIdx += 1;
    }

    const tailWindow = merged.slice(-8);
    const candidateHead = words.slice(startIdx, startIdx + 6);
    let maxPrefixDrop = 0;

    for (let k = Math.min(4, tailWindow.length, candidateHead.length); k >= 1; k--) {
      const tailSlice = tailWindow.slice(-k);
      const headSlice = candidateHead.slice(0, k);
      let allMatch = true;
      for (let j = 0; j < k; j++) {
        const tNorm = normalizeWordToken(tailSlice[j].word);
        const hNorm = normalizeWordToken(headSlice[j].word);
        const timeDelta = Math.abs(headSlice[j].start - tailSlice[j].start);
        if (!tNorm || tNorm !== hNorm || timeDelta > 1.1) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        maxPrefixDrop = k;
        break;
      }
    }

    let idx = startIdx + maxPrefixDrop;
    while (idx < words.length && words[idx].start <= seamZoneEnd) {
      const wNorm = normalizeWordToken(words[idx].word);
      const dupInTail = tailWindow.some(
        (tw) =>
          normalizeWordToken(tw.word) === wNorm &&
          Math.abs(tw.start - words[idx].start) < 0.55,
      );
      if (dupInTail) {
        idx += 1;
      } else {
        break;
      }
    }

    for (let j = idx; j < words.length; j++) {
      const w = words[j];
      const prev = merged[merged.length - 1];
      if (prev && w.start < prev.end && Math.abs(w.start - prev.start) < 0.05) {
        w.start = Math.round((prev.end + 0.01) * 1000) / 1000;
        if (w.end <= w.start) w.end = Math.round((w.start + 0.08) * 1000) / 1000;
      }
      merged.push(w);
    }
  }

  return merged;
}

function detectImportantCategoryDeterministic(text: string): {
  category?: ImportantCategory;
  title?: string;
  reason?: string;
} {
  const lower = text.toLowerCase();
  if (/\$\d+|\bprice\b|\bpricing\b|\bcost\b|\bplan\b|\bbilling\b|\bdiscount\b/.test(lower)) {
    return {
      category: 'pricing',
      title: 'Pricing & Plan Details',
      reason: 'Mentions pricing figures or commercial terms.',
    };
  }
  if (/\bwarning\b|\bcaution\b|\bnever\b|\bdanger\b|\bavoid\b|\bimportant notice\b|\brisk\b/.test(lower)) {
    return {
      category: 'warning',
      title: 'Key Warning',
      reason: 'Contains safety, risk, or critical caveat language.',
    };
  }
  if (/\bdisclaimer\b|\blegal\b|\bterms\b|\bresults may vary\b/.test(lower)) {
    return {
      category: 'disclaimer',
      title: 'Disclaimer Statement',
      reason: 'Contains compliance or disclaimer language.',
    };
  }
  if (/\bsubscribe\b|\bsign up\b|\bget started\b|\bclick below\b|\bvisit\b|\bcall to action\b|\bdownload\b/.test(lower)) {
    return {
      category: 'cta',
      title: 'Call to Action',
      reason: 'Direct viewer action prompt.',
    };
  }
  if (/\bdemo\b|\bshowcase\b|\bwalkthrough\b|\bsee how\b|\bhere is how\b/.test(lower)) {
    return {
      category: 'demonstration',
      title: 'Product Demonstration',
      reason: 'Demonstrates workflow or capability.',
    };
  }
  return {};
}

export function alignTextWordsEvenlyInRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  confidence = 0.72,
): RawRecognizedWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const start = Math.max(0, rangeStart);
  const end = Math.max(start + 0.15, rangeEnd);
  // Unicode-aware character length weighting for English, Hindi, Tamil, etc.
  const weights = tokens.map(
    (w) => Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length) + (/[,.;:!?।]$/.test(w) ? 1.2 : 0),
  );
  const totalW = weights.reduce((a, b) => a + b, 0);
  const dur = end - start;
  let acc = 0;
  return tokens.map((w, i) => {
    const ws = start + (acc / totalW) * dur;
    acc += weights[i];
    let we = start + (acc / totalW) * dur;
    if (we <= ws + 0.05) we = Math.min(end + 0.1, ws + 0.1);
    return {
      word: w,
      start: Math.round(ws * 1000) / 1000,
      end: Math.round(we * 1000) / 1000,
      confidence,
      timingAccuracy: 'approximate',
    };
  });
}

/**
 * Aligns verbatim words in a chunk against 40Hz PCM RMS energy from that chunk's WAV file.
 */
export function alignWordsToChunkWav(
  chunkWavPath: string,
  chunkStartSec: number,
  chunkDurationSec: number,
  text: string,
): RawRecognizedWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  try {
    const { samples, sampleRate } = parseWavInt16MonoToFloat32(chunkWavPath);
    const step = Math.max(1, Math.floor(sampleRate / 40)); // 25ms bins
    const bins: number[] = [];
    for (let i = 0; i < samples.length; i += step) {
      let sum = 0;
      const end = Math.min(samples.length, i + step);
      for (let j = i; j < end; j++) sum += samples[j] * samples[j];
      bins.push(Math.sqrt(sum / Math.max(1, end - i)));
    }
    const activeBins: number[] = [];
    bins.forEach((v, idx) => {
      if (v >= 0.015) activeBins.push(idx);
    });

    if (activeBins.length < Math.max(2, tokens.length)) {
      return alignTextWordsEvenlyInRange(text, chunkStartSec, chunkStartSec + chunkDurationSec, 0.78);
    }

    const voiceStart = chunkStartSec + activeBins[0] / 40;
    const voiceEnd = Math.min(
      chunkStartSec + chunkDurationSec,
      chunkStartSec + (activeBins[activeBins.length - 1] + 1) / 40,
    );
    const aligned = alignTextWordsEvenlyInRange(
      text,
      voiceStart,
      Math.max(voiceStart + 0.25, voiceEnd),
      0.86,
    );
    return aligned.map((w) => ({ ...w, timingAccuracy: 'aligned' }));
  } catch {
    return alignTextWordsEvenlyInRange(text, chunkStartSec, chunkStartSec + chunkDurationSec, 0.7);
  }
}

/* ------------------------------------------------------------------ */
/* SPEECH RECOGNITION & LANGUAGE DETECTION ADAPTERS                   */
/* ------------------------------------------------------------------ */

type WhisperPipelineFn = ((
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{
  text?: string;
  chunks?: Array<{ text?: string; timestamp?: [number, number | null] }>;
}>) & {
  processor?: (audio: Float32Array, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  model?: { generate: (opts: Record<string, unknown>) => Promise<{ data?: BigInt64Array | number[] }> };
  tokenizer?: {
    convert_tokens_to_ids: (tokens: string[]) => number[];
    decode: (ids: number[], opts?: Record<string, unknown>) => string;
  };
};

let cachedWhisperPipelinePromise: Promise<WhisperPipelineFn> | null = null;
let cachedWhisperModelId = '';

async function getLocalWhisperPipeline(): Promise<WhisperPipelineFn> {
  const cfg = getAppConfig();
  if (!cachedWhisperPipelinePromise || cachedWhisperModelId !== cfg.sttWhisperModel) {
    cachedWhisperModelId = cfg.sttWhisperModel;
    cachedWhisperPipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.cacheDir = cfg.hfCacheDir;
      fs.mkdirSync(env.cacheDir, { recursive: true });
      return pipeline('automatic-speech-recognition', cfg.sttWhisperModel, {
        dtype: 'q8',
      }) as Promise<WhisperPipelineFn>;
    })();
  }
  return cachedWhisperPipelinePromise;
}

const WHISPER_NOISE_REGEX =
  /^(\[?(blank_audio|silence|music|applause|laughter|inaudible)\]?|\((music|silence|applause|laughter)\))$/i;

/**
 * Automatic Language Detection on audio sample chunk (without forcing English!).
 * Honors user's manual languageOverride if specified and !== 'auto'.
 */
export async function detectAudioLanguage(params: {
  sampleWavPath: string;
  sampleCompressedPath?: string;
  languageOverride?: string;
  sttProvider?: SttProviderMode;
}): Promise<DetectedLanguageResult> {
  const cfg = getAppConfig();
  const providerMode = params.sttProvider ?? cfg.sttProvider;

  if (params.languageOverride && params.languageOverride !== 'auto') {
    const meta = resolveLanguageMeta(params.languageOverride);
    return {
      primaryLanguage: meta.code,
      primaryLabel: meta.label,
      confidence: 1.0,
      languagesDetected: [{ language: meta.code, label: meta.label, confidence: 1.0 }],
      isMultilingual: false,
      provider: 'manual-override',
    };
  }

  if (providerMode === 'mock') {
    return {
      primaryLanguage: 'en',
      primaryLabel: 'English',
      confidence: 0.99,
      languagesDetected: [{ language: 'en', label: 'English', confidence: 0.99 }],
      isMultilingual: false,
      provider: 'mock-stt',
    };
  }

  // 1) Try Gemini Multimodal Audio Language Identification when enabled
  const ai = providerMode === 'whisper' ? null : getGeminiClient();
  const audioFile =
    params.sampleCompressedPath && fs.existsSync(params.sampleCompressedPath)
      ? params.sampleCompressedPath
      : params.sampleWavPath;

  if (ai && fs.existsSync(audioFile)) {
    try {
      const bytes = fs.readFileSync(audioFile);
      if (bytes.length > 0 && bytes.length <= 6 * 1024 * 1024) {
        const mimeType = audioFile.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav';
        const resp = await withTimeout(
          ai.models.generateContent({
            model: cfg.langDetectModel,
            contents: {
              parts: [
                { inlineData: { mimeType, data: bytes.toString('base64') } },
                {
                  text: `Listen carefully to this audio and identify the spoken language(s) without translating. Use standard BCP-47/ISO codes (e.g. "en" for English, "en-IN" for Indian English accent/terms, "hi" for Hindi, "ta" for Tamil, "te" for Telugu, "kn" for Kannada, "bn" for Bengali, "es" for Spanish). If code-switching occurs (e.g., Hinglish / Tamil+English), list all detected languages in languagesDetected and set isMultilingual=true.`,
                },
              ],
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  primaryLanguage: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  isMultilingual: { type: Type.BOOLEAN },
                  languagesDetected: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        language: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                      },
                    },
                  },
                },
              },
            },
          }),
          20000,
          'Gemini audio language detection',
        );

        const parsed = JSON.parse((resp.text || '{}').trim()) as {
          primaryLanguage?: string;
          confidence?: number;
          isMultilingual?: boolean;
          languagesDetected?: Array<{ language?: string; confidence?: number }>;
        };
        if (parsed.primaryLanguage) {
          const primaryMeta = resolveLanguageMeta(parsed.primaryLanguage);
          const langs: DetectedLanguageSegment[] = (
            parsed.languagesDetected && parsed.languagesDetected.length > 0
              ? parsed.languagesDetected
              : [{ language: primaryMeta.code, confidence: parsed.confidence ?? 0.9 }]
          ).map((l) => {
            const lm = resolveLanguageMeta(l.language);
            return {
              language: lm.code,
              label: lm.label,
              confidence: Math.max(0.1, Math.min(1, Number(l.confidence ?? 0.85))),
            };
          });
          return {
            primaryLanguage: primaryMeta.code,
            primaryLabel: primaryMeta.label,
            confidence: Math.max(0.1, Math.min(1, Number(parsed.confidence ?? 0.9))),
            languagesDetected: langs,
            isMultilingual: Boolean(parsed.isMultilingual) || langs.length > 1,
            provider: cfg.langDetectModel,
          };
        }
      }
    } catch (err) {
      console.warn('[transcriber] Gemini language detection skipped:', err instanceof Error ? err.message : err);
    }
  }

  // 2) Offline Multilingual Whisper Acoustic Language ID via decoder <|startoftranscript|> -> <|lang|>
  try {
    const p = await getLocalWhisperPipeline();
    const { samples } = parseWavInt16MonoToFloat32(params.sampleWavPath);
    if (computeRms(samples) >= 0.0025 && p.processor && p.model && p.tokenizer) {
      const speech=recognitionWindow(samples).audio;
      const inputs = await p.processor(speech.subarray(0,16000*25));
      const [startTok] = p.tokenizer.convert_tokens_to_ids(['<|startoftranscript|>']);
      const generated = await p.model.generate({
        ...inputs,
        max_new_tokens: 1,
        decoder_input_ids: [startTok],
        forced_decoder_ids: null,
        return_timestamps: false,
      });
      const seq: number[] = [];
      const rawSeq = (generated.data || []) as Iterable<number | bigint>;
      for (const v of rawSeq) {
        seq.push(Number(v));
      }
      const decoded = p.tokenizer.decode(seq, { skip_special_tokens: false });
      const langMatch = decoded.match(/<\|([a-z]{2,3})\|>/);
      if (langMatch && langMatch[1]) {
        const meta = resolveLanguageMeta(langMatch[1]);
        return {
          primaryLanguage: meta.code,
          primaryLabel: meta.label,
          confidence: 0.84,
          languagesDetected: [{ language: meta.code, label: meta.label, confidence: 0.84 }],
          isMultilingual: false,
          provider: cfg.sttWhisperModel,
        };
      }
    }
  } catch (err) {
    console.warn('[transcriber] Offline Whisper language detection fallback:', err instanceof Error ? err.message : err);
  }

  return {
    primaryLanguage: 'und',
    primaryLabel: 'Undetermined',
    confidence: 0,
    languagesDetected: [],
    isMultilingual: false,
    provider: 'default-fallback',
  };
}

export async function transcribeChunkWithMockStt(params: {
  wavPath: string;
  chunkId: string;
  sourceStart: number;
  sourceEnd: number;
  language?: string;
}): Promise<{ text: string; language: string; words: RawRecognizedWord[]; provider: string }> {
  const dur = Math.max(0.2, params.sourceEnd - params.sourceStart);
  const text =
    (process.env.MOCK_STT_TEXT || '').trim() ||
    'Today we are testing deterministic speech recognition across the commute pipeline at IIT Madras with ACME-API v2.';
  const words = alignWordsToChunkWav(params.wavPath, params.sourceStart, dur, text).map((w) => ({
    ...w,
    confidence: 0.94,
    chunkId: params.chunkId,
    verificationStatus: 'verified' as VerificationStatus,
  }));
  return {
    text,
    language: params.language && params.language !== 'auto' ? params.language : 'en',
    words,
    provider: 'mock-stt',
  };
}

export async function transcribeChunkWithLocalWhisper(params: {
  wavPath: string;
  chunkId: string;
  sourceStart: number;
  sourceEnd: number;
  languageHint?: string;
  vocabulary?: string[];
}): Promise<{ text: string; language: string; words: RawRecognizedWord[]; provider: string }> {
  const { wavPath, chunkId, sourceStart, sourceEnd, languageHint, vocabulary = [] } = params;
  const { samples, sampleRate } = parseWavInt16MonoToFloat32(wavPath);
  const ac=computeChunkAcoustics(samples,sampleRate);
  const conditioned={noisyAudio:ac.noiseFloorRms>0.008 && ac.snrDb<14,snrDb:ac.snrDb};
  const chunkDur = Math.max(0.2, sourceEnd - sourceStart);

  const rms = computeRms(samples);
  if (rms < 0.0022) {
    return {
      text: '',
      language: languageHint && languageHint !== 'auto' ? languageHint : 'en',
      words: [],
      provider: getAppConfig().sttWhisperModel,
    };
  }

  const transcriber = await getLocalWhisperPipeline();
  const isMultilingualModel = !getAppConfig().sttWhisperModel.endsWith('.en');
  let langMeta = resolveLanguageMeta(languageHint || 'auto');
  if (isMultilingualModel && langMeta.code==='auto') {
    const detected=await detectAudioLanguage({sampleWavPath:wavPath,sttProvider:'whisper'});
    if (detected.primaryLanguage==='und') throw new Error('Whisper could not identify the spoken language in this chunk. Select its language and retry.');
    langMeta=resolveLanguageMeta(detected.primaryLanguage);
  }

  const opts: Record<string, unknown> = { return_timestamps: 'word' };
  if (isMultilingualModel) {
    opts.task = 'transcribe';
    if (langMeta.code !== 'auto') {
      opts.language = langMeta.whisperLanguage;
    }
  }

  const window=recognitionWindow(samples,sampleRate);
  const out = await transcriber(window.audio, opts);
  const words: RawRecognizedWord[] = [];
  const rawChunks = Array.isArray(out.chunks) ? out.chunks : [];

  // Acoustic quality influences calibrated base confidence
  const acousticBaseConf = conditioned.noisyAudio
    ? Math.max(0.56, Math.min(0.79, 0.58 + (conditioned.snrDb / 40)))
    : Math.max(0.76, Math.min(0.92, 0.78 + Math.min(0.14, rms * 1.4)));

  const vocabLower = vocabulary.map((v) => v.trim()).filter(Boolean);

  for (let i = 0; i < rawChunks.length; i++) {
    const ch = rawChunks[i];
    const token = (ch.text || '').trim();
    if (!token || WHISPER_NOISE_REGEX.test(token)) continue;

    const relStart =
      Array.isArray(ch.timestamp) && typeof ch.timestamp[0] === 'number'
        ? ch.timestamp[0]
        : (i / Math.max(1, rawChunks.length)) * chunkDur;
    const rawRelEnd =
      Array.isArray(ch.timestamp) && typeof ch.timestamp[1] === 'number'
        ? ch.timestamp[1]
        : relStart + 0.28;
    const absStart = Math.max(sourceStart, Math.min(sourceEnd - 0.04, sourceStart + window.offset + Math.max(0, relStart)));
    const absEnd = Math.min(sourceEnd, Math.max(absStart + 0.06, sourceStart + window.offset + Math.max(relStart + 0.08, rawRelEnd)));

    let conf = acousticBaseConf;
    const norm = normalizeWordToken(token);
    const candidates: string[] = [];

    // Check near-miss against project custom vocabulary (flag for review rather than silently mutating speech)
    if (norm.length >= 3 && vocabLower.length > 0) {
      for (const term of vocabLower) {
        const termNorm = normalizeWordToken(term);
        if (termNorm && termNorm !== norm && Math.abs(termNorm.length - norm.length) <= 2) {
          const dist = levenshtein(norm, termNorm);
          if (dist > 0 && dist <= Math.max(1, Math.floor(termNorm.length / 4))) {
            candidates.push(term);
            conf = Math.min(conf, 0.68);
          }
        }
      }
    }

    const status: VerificationStatus = conditioned.noisyAudio && conf < 0.65
      ? 'unclear_audio'
      : conf < 0.74 || candidates.length > 0
        ? 'review_needed'
        : 'verified';

    words.push({
      word: token,
      start: Math.round(absStart * 1000) / 1000,
      end: Math.round(absEnd * 1000) / 1000,
      confidence: Math.round(conf * 100) / 100,
      timingAccuracy: Array.isArray(ch.timestamp) && typeof ch.timestamp[0]==='number' && typeof ch.timestamp[1]==='number' ? 'model-word':'approximate',
      chunkId,
      verificationStatus: status,
      candidates: candidates.length > 0 ? candidates.slice(0, 3) : undefined,
    });
  }

  let text = (out.text || '').trim();
  if (WHISPER_NOISE_REGEX.test(text)) text = '';
  if (words.length === 0 && text.length > 0) {
    const fallbackWords = alignWordsToChunkWav(wavPath, sourceStart, chunkDur, text).map((w) => ({
      ...w,
      confidence: Math.round(acousticBaseConf * 100) / 100,
      chunkId,
      verificationStatus: (conditioned.noisyAudio ? 'review_needed' : 'verified') as VerificationStatus,
    }));
    return {
      text,
      language: langMeta.code === 'auto' ? 'en' : langMeta.code,
      words: fallbackWords,
      provider: getAppConfig().sttWhisperModel,
    };
  }

  return {
    text: words.map((w) => w.word).join(' '),
    language: langMeta.code === 'auto' ? 'en' : langMeta.code,
    words,
    provider: getAppConfig().sttWhisperModel,
  };
}

export async function transcribeChunkWithGemini(params: {
  compressedPath: string;
  wavPath: string;
  chunkId: string;
  sourceStart: number;
  sourceEnd: number;
  languageHint?: string;
  isMultilingual?: boolean;
  vocabulary?: string[];
  previousContext?: string;
}): Promise<{ text: string; language: string; words: RawRecognizedWord[]; provider: string }> {
  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  const cfg = getAppConfig();

  const rawWavSamples = parseWavInt16MonoToFloat32(params.wavPath).samples;
  if (computeRms(rawWavSamples) < 0.002) {
    const langMeta = resolveLanguageMeta(params.languageHint || 'auto');
    return {
      text: '',
      language: langMeta.code === 'auto' ? 'en' : langMeta.code,
      words: [],
      provider: cfg.sttGeminiModel,
    };
  }

  const conditioned = await prepareConditionedWavForStt(params.wavPath);
  const audioFile =
    !conditioned.noisyAudio && fs.existsSync(params.compressedPath)
      ? params.compressedPath
      : fs.existsSync(conditioned.sttWavPath)
        ? conditioned.sttWavPath
        : params.wavPath;

  const mimeType = audioFile.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav';
  const bytes = fs.readFileSync(audioFile);

  if (bytes.length > 8 * 1024 * 1024) {
    throw new Error(`Chunk ${params.chunkId} compressed audio exceeds safe chunk limit (${bytes.length} bytes).`);
  }

  const chunkDur = Math.max(0.2, params.sourceEnd - params.sourceStart);
  const langMeta = resolveLanguageMeta(params.languageHint || 'auto');
  const vocabBlock =
    params.vocabulary && params.vocabulary.length > 0
      ? `\nProject domain vocabulary, proper names, colleges, companies & acronyms (preserve exact spelling when spoken): ${params.vocabulary.join(', ')}.`
      : '';
  const langDirective =
    langMeta.code !== 'auto'
      ? `Primary spoken language: ${langMeta.label} (${langMeta.code}).${params.isMultilingual ? ' Mixed-language / code-switching speech may also occur.' : ''}`
      : 'Detect the spoken language automatically.';
  const ctxHint = params.previousContext
    ? `\nPreceding context (for spelling continuity only, DO NOT repeat these words): "${params.previousContext.slice(-180)}"`
    : '';

  const resp = await withTimeout(
    ai.models.generateContent({
      model: cfg.sttGeminiModel,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: bytes.toString('base64'),
            },
          },
          {
            text: `Transcribe every spoken word verbatim from this ${chunkDur.toFixed(1)}s audio clip.
CRITICAL TRANSCRIPTION RULES:
1. ${langDirective} Transcribe strictly in the ORIGINAL spoken language and script (NEVER translate non-English speech into English; if Hindi/Tamil/etc., use its native script or exact spoken Hinglish code-switched words as actually uttered).
2. Preserve personal names, college/university names, company names, product names, technical terms, numbers, abbreviations, acronyms, and speaker grammar verbatim. NEVER rewrite spoken grammar or replace unfamiliar words with ordinary dictionary words.
3. Preserve repeated words and filler words (um, uh). Separate distinct speakers only if clearly different voices alternate.
4. Do NOT hallucinate words on music, noise, or silence. If there is no audible speech, output exactly NO_SPEECH.${vocabBlock}${ctxHint}`,
          },
        ],
      },
    }),
    cfg.sttTimeoutMs,
    `Gemini chunk ${params.chunkId}`,
  );

  const rawText = (resp.text || '').trim();
  if (!rawText || rawText === 'NO_SPEECH') {
    return {
      text: '',
      language: langMeta.code === 'auto' ? 'en' : langMeta.code,
      words: [],
      provider: cfg.sttGeminiModel,
    };
  }

  const baseConf = conditioned.noisyAudio ? 0.8 : 0.93;
  const words = alignWordsToChunkWav(params.wavPath, params.sourceStart, chunkDur, rawText).map((w) => ({
    ...w,
    confidence: Math.round(baseConf * 100) / 100,
    chunkId: params.chunkId,
    verificationStatus: (conditioned.noisyAudio ? 'review_needed' : 'verified') as VerificationStatus,
  }));

  return {
    text: rawText,
    language: langMeta.code === 'auto' ? 'en' : langMeta.code,
    words,
    provider: cfg.sttGeminiModel,
  };
}

/**
 * Stage 2: Audio-First Context-Aware Transcript Verification Pass.
 * Re-inspects audio chunks against project vocabulary & surrounding context using Gemini
 * (or acoustic+lexicon verification offline) to catch misrecognized names/terms and flag
 * truly uncertain audio with candidate alternatives instead of guessing blindly.
 */
export async function verifyTranscriptChunksWithAudio(params: {
  chunkRows: Array<Record<string, unknown>>;
  chunkOutputs: ChunkRecognitionOutput[];
  detectedLanguage: string;
  isMultilingual: boolean;
  vocabulary: string[];
  sttProvider?: SttProviderMode;
}): Promise<{
  chunkOutputs: ChunkRecognitionOutput[];
  summary: VerificationSummary;
}> {
  const cfg = getAppConfig();
  const providerMode = params.sttProvider ?? cfg.sttProvider;
  const ai =
    cfg.verifyPassEnabled && providerMode !== 'mock' && providerMode !== 'whisper'
      ? getGeminiClient()
      : null;

  const updatedOutputs = params.chunkOutputs.map((c) => ({
    ...c,
    words: c.words.map((w) => ({ ...w })),
  }));

  const rowByChunkId = new Map<string, Record<string, unknown>>();
  for (const r of params.chunkRows) {
    rowByChunkId.set(r.id as string, r);
  }

  let verifierProvider = 'acoustic-lexicon-verifier';

  // Run second-pass verification on each speech chunk that has words
  if (ai) {
    verifierProvider = cfg.verifyModel;
    const chunksToVerify = updatedOutputs.filter((c) => c.words.length > 0).slice(0, 16);
    const vocabList = params.vocabulary.filter(Boolean);

    for (let i = 0; i < chunksToVerify.length; i++) {
      const ch = chunksToVerify[i];
      const row = rowByChunkId.get(ch.chunkId);
      const audioFile =
        row && fs.existsSync((row.compressed_path as string) || '')
          ? (row.compressed_path as string)
          : row && fs.existsSync((row.wav_path as string) || '')
            ? (row.wav_path as string)
            : '';
      if (!audioFile) continue;

      try {
        const bytes = fs.readFileSync(audioFile);
        if (bytes.length > 6 * 1024 * 1024) continue;
        const mimeType = audioFile.endsWith('.mp3') ? 'audio/mp3' : 'audio/wav';
        const prevTxt = i > 0 ? chunksToVerify[i - 1].text.slice(-120) : '';
        const nextTxt = i + 1 < chunksToVerify.length ? chunksToVerify[i + 1].text.slice(0, 120) : '';

        const resp = await withTimeout(
          ai.models.generateContent({
            model: cfg.verifyModel,
            contents: {
              parts: [
                { inlineData: { mimeType, data: bytes.toString('base64') } },
                {
                  text: `You are performing Pass-2 Audio-First Transcript Verification.
Listen to the attached audio clip and inspect every token in the Pass-1 draft transcript.
Language: ${params.detectedLanguage}${params.isMultilingual ? ' (code-switching allowed)' : ''}.
Custom Vocabulary Dictionary (names/colleges/companies/terms): ${vocabList.length > 0 ? vocabList.join(', ') : '(none provided)'}.
Context before: "${prevTxt}"
Context after: "${nextTxt}"

Pass-1 tokens (0-indexed):
${JSON.stringify(ch.words.map((w, idx) => ({ idx, word: w.word })))}

STRICT RULES:
1. Check each word against the ACTUAL AUDIO + context + vocabulary.
2. NEVER rewrite natural speaker grammar or translate non-English speech to English.
3. Only emit an entry in "reviews" when a word needs correction, speaker label update, OR has uncertain/unclear audio.
4. For misheard proper names/terms clearly audible in audio matching context or vocabulary, provide "correctedWord" and status "verified" (confidence >= 0.85).
5. When audio is muffled, overlapped by noise/music, or genuinely ambiguous, keep best hypothesis, set status to "review_needed" or "unclear_audio", lower confidence (e.g. 0.45-0.72), and list 1-3 short plausible "candidates". Never fabricate confident missing words.
6. Also optionally return speakerTurns if multiple distinct voices speak in this clip.`,
                },
              ],
            },
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  reviews: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        idx: { type: Type.INTEGER },
                        correctedWord: { type: Type.STRING },
                        status: { type: Type.STRING },
                        confidence: { type: Type.NUMBER },
                        candidates: { type: Type.ARRAY, items: { type: Type.STRING } },
                        speaker: { type: Type.STRING },
                      },
                    },
                  },
                },
              },
            },
          }),
          22000,
          `Gemini Pass-2 verify chunk ${ch.chunkIndex}`,
        );

        const parsed = JSON.parse((resp.text || '{}').trim()) as {
          reviews?: Array<{
            idx?: number;
            correctedWord?: string;
            status?: string;
            confidence?: number;
            candidates?: string[];
            speaker?: string;
          }>;
        };

        for (const rev of parsed.reviews || []) {
          if (rev.idx === undefined || rev.idx < 0 || rev.idx >= ch.words.length) continue;
          const target = ch.words[rev.idx];
          if (rev.correctedWord && rev.correctedWord.trim() && rev.correctedWord.trim() !== target.word) {
            target.originalWord = target.word;
            target.word = rev.correctedWord.trim();
          }
          if (
            rev.status === 'verified' ||
            rev.status === 'review_needed' ||
            rev.status === 'unclear_audio'
          ) {
            target.verificationStatus = rev.status;
          }
          if (typeof rev.confidence === 'number' && Number.isFinite(rev.confidence)) {
            target.confidence = Math.round(Math.max(0.15, Math.min(1, rev.confidence)) * 100) / 100;
          }
          if (Array.isArray(rev.candidates) && rev.candidates.length > 0) {
            target.candidates = rev.candidates.slice(0, 3);
          }
          if (rev.speaker && rev.speaker.trim()) {
            target.speaker = rev.speaker.trim();
          }
        }
        ch.text = ch.words.map((w) => w.word).join(' ');
      } catch (err) {
        console.warn(`[transcriber] Pass-2 verification skipped for chunk ${ch.chunkIndex}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  let verifiedCount = 0;
  let reviewNeededCount = 0;
  let unclearAudioCount = 0;
  let manuallyEditedCount = 0;

  for (const ch of updatedOutputs) {
    for (const w of ch.words) {
      if (!w.verificationStatus) {
        const c = w.confidence ?? 0.85;
        w.verificationStatus = c >= 0.78 ? 'verified' : c >= 0.55 ? 'review_needed' : 'unclear_audio';
      }
      if (w.verificationStatus === 'verified') verifiedCount += 1;
      else if (w.verificationStatus === 'review_needed') reviewNeededCount += 1;
      else unclearAudioCount += 1;
      if (w.manuallyEdited) manuallyEditedCount += 1;
    }
  }

  return {
    chunkOutputs: updatedOutputs,
    summary: {
      verifiedCount,
      reviewNeededCount,
      unclearAudioCount,
      manuallyEditedCount,
      verifiedAt: new Date().toISOString(),
      verifierProvider,
    },
  };
}

/**
 * Groups deduplicated chronological words into natural caption & transcript segments in O(N + M) time
 * so even 60-minute (~10,000 word) transcripts complete in < 25ms.
 */
export function buildSegmentsAndSummaryFromWords(params: {
  mediaId: string;
  rawWords: RawRecognizedWord[];
  silences: SilenceRange[];
  durationSec: number;
  language?: string;
}): {
  transcript: TranscriptSegment[];
  speakers: SpeakerInfo[];
  importantMoments: ImportantMoment[];
  fillers: FillerHit[];
  topics: string[];
  summary: string;
} {
  const { mediaId, rawWords, silences, durationSec, language = 'en' } = params;
  if (rawWords.length === 0) {
    return {
      transcript: [],
      speakers: [],
      importantMoments: [],
      fillers: [],
      topics: [],
      summary: 'Audio stream inspected; no spoken words detected.',
    };
  }

  const orderedSilences = [...silences].sort((a, b) => a.start - b.start);
  let silCursor = 0;

  const groups: RawRecognizedWord[][] = [];
  let cur: RawRecognizedWord[] = [];

  for (let i = 0; i < rawWords.length; i++) {
    const w = rawWords[i];
    cur.push(w);
    const prevStart = cur[0].start;
    const nextW = rawWords[i + 1];
    const hasEndPunct = /[.!?।]["']?$/.test(w.word);
    const gapToNext = nextW ? nextW.start - w.end : 0;
    const speakerChanged = Boolean(nextW && nextW.speaker && w.speaker && nextW.speaker !== w.speaker);

    let spansLongPause = false;
    if (nextW) {
      while (silCursor < orderedSilences.length && orderedSilences[silCursor].end < w.end - 0.1) {
        silCursor += 1;
      }
      for (let sIdx = silCursor; sIdx < orderedSilences.length; sIdx++) {
        const s = orderedSilences[sIdx];
        if (s.start > nextW.start + 0.1) break;
        if (s.start >= w.end - 0.1 && s.end <= nextW.start + 0.1 && s.duration >= 0.6) {
          spansLongPause = true;
          break;
        }
      }
    }

    const shouldBreak =
      !nextW ||
      hasEndPunct ||
      speakerChanged ||
      gapToNext >= 0.75 ||
      spansLongPause ||
      cur.length >= 14 ||
      w.end - prevStart >= 8.5;

    if (shouldBreak) {
      groups.push(cur);
      cur = [];
    }
  }

  const fillers: FillerHit[] = [];
  const importantMoments: ImportantMoment[] = [];
  const transcript: TranscriptSegment[] = [];
  const speakerStats = new Map<string, { id: string; timeSec: number; segCount: number }>();

  const speakerPalette = ['#22D3EE', '#A78BFA', '#F472B6', '#34D399', '#FACC15'];

  groups.forEach((grp, idx) => {
    const segId = `tr-${mediaId}-${idx + 1}`;
    const speakerName = (grp[0]?.speaker || 'Speaker 1').trim() || 'Speaker 1';
    let spkStat = speakerStats.get(speakerName);
    if (!spkStat) {
      spkStat = {
        id: `spk-${speakerStats.size + 1}`,
        timeSec: 0,
        segCount: 0,
      };
      speakerStats.set(speakerName, spkStat);
    }

    const segStart = Math.max(0, Math.min(durationSec - 0.05, grp[0].start));
    const segEnd = Math.min(durationSec, Math.max(segStart + 0.12, grp[grp.length - 1].end));
    spkStat.timeSec += segEnd - segStart;
    spkStat.segCount += 1;

    const fullWords: TranscriptWord[] = grp.map((w, wIdx) => {
      const norm = normalizeWordToken(w.word);
      const isFiller = ['um', 'uh', 'er', 'ah', 'hmm'].includes(norm);
      const wordId = `${segId}-w${wIdx + 1}`;
      const ws = Math.max(0, Math.min(durationSec - 0.02, w.start));
      const we = Math.min(durationSec, Math.max(ws + 0.05, w.end));
      const conf = w.confidence ?? 0.88;
      const vStatus: VerificationStatus =
        w.verificationStatus || (conf >= 0.78 ? 'verified' : conf >= 0.55 ? 'review_needed' : 'unclear_audio');

      if (isFiller) {
        fillers.push({
          id: `fil-${wordId}`,
          word: w.word,
          start: ws,
          end: we,
          segmentId: segId,
        });
      }

      return {
        id: wordId,
        word: w.word,
        text: w.word,
        normalizedText: norm,
        start: ws,
        end: we,
        sourceStart: ws,
        sourceEnd: we,
        confidence: conf,
        speaker: speakerName,
        speakerId: spkStat!.id,
        sentenceId: segId,
        chunkId: w.chunkId,
        sourceSegmentId: segId,
        timingAccuracy: w.timingAccuracy,
        isFiller,
        verificationStatus: vStatus,
        originalWord: w.originalWord,
        candidates: w.candidates,
        manuallyEdited: w.manuallyEdited,
      };
    });

    const text = fullWords.map((w) => w.word).join(' ').trim();
    const imp = detectImportantCategoryDeterministic(text);
    const topic = imp.title || (idx === 0 ? 'Opening Statement' : `Spoken Segment ${idx + 1}`);

    transcript.push({
      id: segId,
      start: Math.round(segStart * 1000) / 1000,
      end: Math.round(segEnd * 1000) / 1000,
      speaker: speakerName,
      speakerId: spkStat.id,
      text,
      topic,
      language,
      chunkId: grp[0]?.chunkId,
      words: fullWords,
      isImportant: Boolean(imp.category),
      importantCategory: imp.category,
    });

    if (imp.category) {
      importantMoments.push({
        id: `imp-${mediaId}-${idx + 1}`,
        category: imp.category,
        title: imp.title || topic,
        reason: imp.reason || 'Detected key statement in spoken transcript.',
        start: Math.round(segStart * 1000) / 1000,
        end: Math.round(segEnd * 1000) / 1000,
        protected: true,
        segmentId: segId,
      });
    }
  });

  const speakers: SpeakerInfo[] = Array.from(speakerStats.entries()).map(([name, info], i) => ({
    id: info.id,
    name,
    role: i === 0 ? 'Primary Speaker' : `Speaker ${i + 1}`,
    color: speakerPalette[i % speakerPalette.length],
    speakingTimeSec: Math.round(info.timeSec * 10) / 10,
    segmentCount: info.segCount,
  }));

  const topics = Array.from(new Set(transcript.slice(0, 60).map((t) => t.topic)));
  const previewSnippet = transcript
    .slice(0, 2)
    .map((t) => t.text)
    .join(' ')
    .slice(0, 180);

  return {
    transcript,
    speakers,
    importantMoments,
    fillers,
    topics,
    summary: previewSnippet
      ? `Transcribed speech: "${previewSnippet}${previewSnippet.length >= 180 ? '...' : ''}"`
      : 'Speech transcript indexed.',
  };
}

/* ------------------------------------------------------------------ */
/* MANUAL WORD CORRECTION, SNIPPET PLAYBACK & TRANSLATION TRACK       */
/* ------------------------------------------------------------------ */

export async function extractAudioSnippetWav(params: {
  mediaId: string;
  filePath: string;
  audioStreamIndex: number;
  startSec: number;
  endSec: number;
}): Promise<string> {
  const s = Math.max(0, params.startSec - 0.35);
  const e = Math.max(s + 0.4, params.endSec + 0.35);
  const dur = Math.min(12, Math.max(0.4, e - s));

  const masterWav = path.join(AUDIO_DIR, params.mediaId, `stream_${params.audioStreamIndex}_16k.wav`);
  const inputFile = fs.existsSync(masterWav) ? masterWav : params.filePath;
  const isRawVideo = inputFile === params.filePath;

  fs.mkdirSync(TEMP_DIR, { recursive: true });
  const outPath = path.join(
    TEMP_DIR,
    `snip-${params.mediaId.slice(0, 10)}-${Math.round(s * 100)}-${Math.round(dur * 100)}.wav`,
  );

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 44) {
    return outPath;
  }

  const args = [
    '-y',
    '-ss',
    s.toFixed(3),
    '-t',
    dur.toFixed(3),
    '-i',
    inputFile,
    ...(isRawVideo ? ['-map', `0:a:${params.audioStreamIndex}`, '-vn'] : []),
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    outPath,
  ];
  await execFileAsync('ffmpeg', args);
  return outPath;
}

export function applyManualWordCorrection(params: {
  projectId: string;
  wordId: string;
  newWord: string;
}): {
  analysis: MediaAnalysis;
  projectState: ProjectState;
  updatedWord: TranscriptWord;
} {
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.projectId) as
    | Record<string, unknown>
    | undefined;
  if (!proj) throw new Error('Project not found.');

  const media = db
    .prepare('SELECT * FROM media_assets WHERE id = ?')
    .get(proj.media_id as string) as Record<string, unknown> | undefined;
  if (!media) throw new Error('Media asset not found.');

  const cleanNewWord = params.newWord.trim();
  if (!cleanNewWord) throw new Error('Corrected word cannot be empty.');

  const analysis = JSON.parse(media.analysis_json as string) as MediaAnalysis;
  const projectState = JSON.parse(proj.state_json as string) as ProjectState;

  let foundWord: TranscriptWord | null = null;
  let verifiedCount = 0;
  let reviewNeededCount = 0;
  let unclearAudioCount = 0;
  let manuallyEditedCount = 0;

  for (const seg of analysis.transcript) {
    let segModified = false;
    for (const w of seg.words || []) {
      if (w.id === params.wordId) {
        if (!w.originalWord && w.word !== cleanNewWord) {
          w.originalWord = w.word;
        }
        w.word = cleanNewWord;
        w.text = cleanNewWord;
        w.normalizedText = normalizeWordToken(cleanNewWord);
        w.confidence = 1.0;
        w.verificationStatus = 'verified';
        w.manuallyEdited = true;
        foundWord = { ...w };
        segModified = true;
      }

      const st = w.verificationStatus || 'verified';
      if (st === 'verified') verifiedCount += 1;
      else if (st === 'review_needed') reviewNeededCount += 1;
      else unclearAudioCount += 1;
      if (w.manuallyEdited) manuallyEditedCount += 1;
    }

    if (segModified) {
      seg.text = seg.words.map((w) => w.word).join(' ').trim();
    }
  }

  if (!foundWord) {
    throw new Error(`Transcript word ${params.wordId} not found.`);
  }

  analysis.verificationSummary = {
    verifiedCount,
    reviewNeededCount,
    unclearAudioCount,
    manuallyEditedCount,
    verifiedAt: new Date().toISOString(),
    verifierProvider: analysis.verificationSummary?.verifierProvider || 'manual-correction',
  };

  // Synchronize captions strictly for matching wordId/timing without touching unrelated segments
  for (const cap of projectState.captions) {
    let capChanged = false;
    for (const cw of cap.words || []) {
      if (cw.id === params.wordId) {
        if (!cw.originalWord && cw.word !== cleanNewWord) {
          cw.originalWord = cw.word;
        }
        cw.word = cleanNewWord;
        cw.text = cleanNewWord;
        cw.normalizedText = normalizeWordToken(cleanNewWord);
        cw.confidence = 1.0;
        cw.verificationStatus = 'verified';
        cw.manuallyEdited = true;
        capChanged = true;
      }
    }
    if (capChanged) {
      cap.text = cap.words.map((w) => w.word).join(' ').trim();
    }
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE media_assets SET analysis_json = ? WHERE id = ?').run(
    JSON.stringify(analysis),
    media.id as string,
  );
  db.prepare('UPDATE projects SET state_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(projectState),
    now,
    params.projectId,
  );

  return { analysis, projectState, updatedWord: foundWord };
}

export async function translateProjectTranscript(params: {
  projectId: string;
  targetLanguage: string;
}): Promise<{ track: TranslationTrack; analysis: MediaAnalysis }> {
  const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(params.projectId) as
    | Record<string, unknown>
    | undefined;
  if (!proj) throw new Error('Project not found.');
  const media = db
    .prepare('SELECT * FROM media_assets WHERE id = ?')
    .get(proj.media_id as string) as Record<string, unknown> | undefined;
  if (!media) throw new Error('Media asset not found.');

  const analysis = JSON.parse(media.analysis_json as string) as MediaAnalysis;
  if (analysis.transcript.length === 0) {
    throw new Error('Transcript has no segments to translate.');
  }

  const cfg = getAppConfig();
  const targetMeta = resolveLanguageMeta(params.targetLanguage);
  const ai = getGeminiClient();

  let translatedSegments: TranslationTrack['segments'] = [];

  if (ai) {
    try {
      const items = analysis.transcript.slice(0, 120).map((s) => ({
        segmentId: s.id,
        text: s.text,
      }));
      const resp = await withTimeout(
        ai.models.generateContent({
          model: cfg.translateModel,
          contents: `Translate these transcript segments into ${targetMeta.label} (${targetMeta.code}). Preserve technical terms, proper names, and meaning accurately. Return JSON array matching each segmentId.\n\n${JSON.stringify(items)}`,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                segments: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      segmentId: { type: Type.STRING },
                      text: { type: Type.STRING },
                    },
                  },
                },
              },
            },
          },
        }),
        25000,
        'Transcript translation',
      );
      const parsed = JSON.parse((resp.text || '{}').trim()) as {
        segments?: Array<{ segmentId?: string; text?: string }>;
      };
      const mapTxt = new Map((parsed.segments || []).map((x) => [x.segmentId || '', x.text || '']));
      translatedSegments = analysis.transcript.map((s) => ({
        segmentId: s.id,
        sourceStart: s.start,
        sourceEnd: s.end,
        text: mapTxt.get(s.id) || s.text,
      }));
    } catch (err) {
      console.warn('[transcriber] Translation fallback:', err instanceof Error ? err.message : err);
    }
  }

  if (translatedSegments.length === 0) {
    translatedSegments = analysis.transcript.map((s) => ({
      segmentId: s.id,
      sourceStart: s.start,
      sourceEnd: s.end,
      text: `[${targetMeta.code}] ${s.text}`,
    }));
  }

  const track: TranslationTrack = {
    language: targetMeta.code,
    languageLabel: targetMeta.label,
    segments: translatedSegments,
    createdAt: new Date().toISOString(),
  };

  analysis.translationTracks = {
    ...(analysis.translationTracks || {}),
    [targetMeta.code]: track,
  };

  db.prepare('UPDATE media_assets SET analysis_json = ? WHERE id = ?').run(
    JSON.stringify(analysis),
    media.id as string,
  );

  return { track, analysis };
}

/* ------------------------------------------------------------------ */
/* SUBTITLE EXPORTERS (.SRT AND .VTT MATCHING EDITED TIMELINE)        */
/* ------------------------------------------------------------------ */

function formatSrtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000) % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function formatVttTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = Math.floor(s % 60);
  const ms = Math.round((s % 1) * 1000) % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function buildSrtSubtitles(state: ProjectState, translationTrack?: TranslationTrack): string {
  const baseProjected = projectCaptionsToTimeline({ ...state, captionsEnabled: true });
  const transMap = translationTrack
    ? new Map(translationTrack.segments.map((s) => [s.segmentId, s.text]))
    : null;
  const projected = transMap
    ? baseProjected.map((cap, idx) => {
        const segCap = state.captions[idx];
        const trText = segCap?.sourceSegmentId ? transMap.get(segCap.sourceSegmentId) : undefined;
        return trText ? { ...cap, text: trText } : cap;
      })
    : baseProjected;

  return (
    projected
      .map(
        (cap, idx) =>
          `${idx + 1}\n${formatSrtTime(cap.timelineStart)} --> ${formatSrtTime(cap.timelineEnd)}\n${cap.text.trim()}`,
      )
      .join('\n\n') + (projected.length > 0 ? '\n' : '')
  );
}

export function buildVttSubtitles(state: ProjectState, translationTrack?: TranslationTrack): string {
  const baseProjected = projectCaptionsToTimeline({ ...state, captionsEnabled: true });
  const transMap = translationTrack
    ? new Map(translationTrack.segments.map((s) => [s.segmentId, s.text]))
    : null;
  const projected = transMap
    ? baseProjected.map((cap, idx) => {
        const segCap = state.captions[idx];
        const trText = segCap?.sourceSegmentId ? transMap.get(segCap.sourceSegmentId) : undefined;
        return trText ? { ...cap, text: trText } : cap;
      })
    : baseProjected;

  const cues = projected
    .map(
      (cap, idx) =>
        `${idx + 1}\n${formatVttTime(cap.timelineStart)} --> ${formatVttTime(cap.timelineEnd)}\n${cap.text.trim()}`,
    )
    .join('\n\n');
  return `WEBVTT\n\n${cues}${projected.length > 0 ? '\n' : ''}`;
}

/* ------------------------------------------------------------------ */
/* PERSISTENT CHUNK PREPARATION, AUDIO EXTRACTION & JOB RUNNER        */
/* ------------------------------------------------------------------ */

export async function extractStreamWavAndSilences(params: {
  mediaId: string;
  filePath: string;
  audioStreamIndex: number;
  durationSec: number;
}): Promise<{
  masterWavPath: string;
  silences: SilenceRange[];
  waveformPeaks: number[];
}> {
  const mediaAudioDir = path.join(AUDIO_DIR, params.mediaId);
  fs.mkdirSync(mediaAudioDir, { recursive: true });
  const masterWavPath = path.join(mediaAudioDir, `stream_${params.audioStreamIndex}_16k.wav`);

  const featuresPath=masterWavPath+'.json';
  if (fs.existsSync(masterWavPath) && fs.existsSync(featuresPath)) {
    const features=JSON.parse(await fs.promises.readFile(featuresPath,'utf8'));
    return {masterWavPath,...features};
  }
  const temp=masterWavPath+'.'+uuid()+'.wav';
  const {stderr}=await execFileAsync('ffmpeg',['-nostdin','-hide_banner','-nostats','-y','-i',params.filePath,'-map',`0:a:${params.audioStreamIndex}`,'-vn','-af','silencedetect=noise=-34dB:d=0.4','-ar','16000','-ac','1','-c:a','pcm_s16le',temp],{maxBuffer:16*1024*1024});
  await fs.promises.rename(temp,masterWavPath);
  const silences:SilenceRange[]=[];
  {
    let currentStart: number | null = null;
    for (const line of stderr.split('\n')) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) currentStart = parseFloat(startMatch[1]);
      const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const end = Math.min(params.durationSec, parseFloat(endMatch[1]));
        const dur = parseFloat(endMatch[2]);
        if (dur >= 0.4 && end > currentStart) {
          silences.push({
            id: `sil-${silences.length + 1}`,
            start: Math.round(Math.max(0, currentStart) * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
            duration: Math.round((end - Math.max(0, currentStart)) * 1000) / 1000,
          });
        }
        currentStart = null;
      }
    }
  }

  const waveformPeaks: number[] = [];
  const sampleCount = 120;
  try {
    const stat = fs.statSync(masterWavPath);
    const fd = fs.openSync(masterWavPath, 'r');
    try {
      const headerOffset = 44;
      const dataBytes = Math.max(0, stat.size - headerOffset);
      const bucketBytes = Math.max(2, Math.floor(dataBytes / sampleCount));
      const readSize = Math.min(bucketBytes, 4096);
      const tmpBuf = Buffer.alloc(readSize);

      for (let i = 0; i < sampleCount; i++) {
        const pos = headerOffset + i * bucketBytes;
        if (pos + 2 >= stat.size) {
          waveformPeaks.push(0.03);
          continue;
        }
        const bytesRead = fs.readSync(fd, tmpBuf, 0, Math.min(readSize, stat.size - pos), pos);
        let maxAbs = 0;
        for (let b = 0; b + 1 < bytesRead; b += 4) {
          const val = Math.abs(tmpBuf.readInt16LE(b)) / 32768;
          if (val > maxAbs) maxAbs = val;
        }
        waveformPeaks.push(Math.round(Math.min(1, maxAbs * 1.45) * 100) / 100);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    for (let i = 0; i < sampleCount; i++) waveformPeaks.push(0.35);
  }

  const tmpFeatures=featuresPath+uuid();
  await fs.promises.writeFile(tmpFeatures,JSON.stringify({silences,waveformPeaks}));
  await fs.promises.rename(tmpFeatures,featuresPath);
  return { masterWavPath, silences, waveformPeaks };
}

export async function sliceChunkAudioFiles(params: {
  mediaId: string;
  jobId: string;
  masterWavPath: string;
  chunks: PlannedChunk[];
}): Promise<Array<{ chunkId: string; chunk: PlannedChunk; wavPath: string; compressedPath: string }>> {
  const chunkDir = path.join(AUDIO_DIR, params.mediaId, params.jobId);
  fs.mkdirSync(chunkDir, { recursive: true });

  const prepared: Array<{ chunkId: string; chunk: PlannedChunk; wavPath: string; compressedPath: string }> = [];
  const source=await fs.promises.open(params.masterWavPath,'r');
  try {
    const header=Buffer.alloc(4096);
    const {bytesRead}=await source.read(header,0,header.length,0);
    let offset=12;
    while (offset+8<=bytesRead && header.toString('ascii',offset,offset+4)!=='data') {
      const size=header.readUInt32LE(offset+4);
      offset+=8+size+(size%2);
    }
    if (offset+8>bytesRead) throw new Error('PCM data header missing.');
    const available=header.readUInt32LE(offset+4);
    for (const chunk of params.chunks) {
      const start=Math.min(available,Math.round(chunk.sourceStart*16000)*2);
      const end=Math.min(available,Math.round(chunk.sourceEnd*16000)*2);
      if (end<=start) continue;
      const wav=Buffer.alloc(44+end-start);
      wav.write('RIFF'); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
      wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
      wav.writeUInt32LE(16000,24); wav.writeUInt32LE(32000,28); wav.writeUInt16LE(2,32);
      wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(end-start,40);
      let done=0;
      while (done<end-start) {
        const read=await source.read(wav,44+done,end-start-done,offset+8+start+done);
        if (!read.bytesRead) throw new Error('Truncated PCM track.');
        done+=read.bytesRead;
      }
      const wavPath=path.join(chunkDir,`chunk_${chunk.index}.wav`);
      await fs.promises.writeFile(wavPath,wav);
      prepared.push({chunkId:'chk-'+uuid(),chunk,wavPath,compressedPath:wavPath});
    }
  } finally { await source.close(); }
  return prepared;
}

export function hydrateAnalysisJobRow(row: Record<string, unknown>): AnalysisJob {
  return {
    id: row.id as string,
    mediaId: row.media_id as string,
    projectId: (row.project_id as string | null) ?? null,
    metrics: row.metrics_json ? JSON.parse(String(row.metrics_json)) : undefined,
    selectedAudioStream: Number(row.selected_audio_stream ?? 0),
    status: row.status as TranscriptionStatus,
    overallProgress: Number(row.overall_progress ?? 0),
    audioExtractionStatus: row.audio_extraction_status as AnalysisJob['audioExtractionStatus'],
    transcriptionStatus: row.transcription_status as AnalysisJob['transcriptionStatus'],
    chunkTotal: Number(row.chunk_total ?? 0),
    chunkCompleted: Number(row.chunk_completed ?? 0),
    chunkFailed: Number(row.chunk_failed ?? 0),
    alignmentStatus: row.alignment_status as AnalysisJob['alignmentStatus'],
    captionStatus: row.caption_status as AnalysisJob['captionStatus'],
    providerUsed: (row.provider_used as string | undefined) || undefined,
    detectedLanguage: (row.detected_language as string | undefined) || undefined,
    languageOverride: (row.language_override as string | undefined) || undefined,
    error: (row.error as string | undefined) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getAnalysisJob(jobId: string): AnalysisJob | null {
  const row = db.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
  return row ? hydrateAnalysisJobRow(row) : null;
}

export function getLatestAnalysisJobForMedia(mediaId: string): AnalysisJob | null {
  const row = db
    .prepare('SELECT * FROM analysis_jobs WHERE media_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(mediaId) as Record<string, unknown> | undefined;
  return row ? hydrateAnalysisJobRow(row) : null;
}

export function updateAnalysisJobRow(jobId: string, patch: Partial<AnalysisJob>) {
  const cur = db.prepare('SELECT * FROM analysis_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
  if (!cur) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE analysis_jobs SET
      status = ?,
      overall_progress = ?,
      audio_extraction_status = ?,
      transcription_status = ?,
      chunk_total = ?,
      chunk_completed = ?,
      chunk_failed = ?,
      alignment_status = ?,
      caption_status = ?,
      provider_used = ?,
      detected_language = ?,
      language_override = ?,
      error = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? cur.status,
    patch.overallProgress ?? cur.overall_progress,
    patch.audioExtractionStatus ?? cur.audio_extraction_status,
    patch.transcriptionStatus ?? cur.transcription_status,
    patch.chunkTotal ?? cur.chunk_total,
    patch.chunkCompleted ?? cur.chunk_completed,
    patch.chunkFailed ?? cur.chunk_failed,
    patch.alignmentStatus ?? cur.alignment_status,
    patch.captionStatus ?? cur.caption_status,
    patch.providerUsed !== undefined ? patch.providerUsed : cur.provider_used,
    patch.detectedLanguage !== undefined ? patch.detectedLanguage : cur.detected_language,
    patch.languageOverride !== undefined ? patch.languageOverride : cur.language_override,
    patch.error !== undefined ? patch.error : cur.error,
    now,
    jobId,
  );
}

const cancelledJobIds = new Set<string>();

export function requestCancelAnalysisJob(jobId: string) {
  cancelledJobIds.add(jobId);
  updateAnalysisJobRow(jobId, {
    status: 'cancelled',
    error: 'Cancelled by user.',
  });
}

export function isJobCancelled(jobId: string): boolean {
  if (cancelledJobIds.has(jobId)) return true;
  const row = db.prepare('SELECT status FROM analysis_jobs WHERE id = ?').get(jobId) as { status?: string } | undefined;
  return row?.status === 'cancelled';
}

export interface ChunkWorkerOptions {
  preferLocal?: boolean;
  sttProvider?: SttProviderMode;
  languageOverride?: string;
  vocabulary?: string[];
  concurrency?: number;
  simulateFailChunkIndices?: number[];
  disableFallbackForFailedSimulated?: boolean;
}

/**
 * Processes pending/failed chunks for an existing analysis job with bounded concurrency,
 * retries with exponential backoff, multilingual language awareness, and 2nd-pass verification.
 */
export async function processChunksForJob(
  jobId: string,
  options: ChunkWorkerOptions = {},
): Promise<{
  completedCount: number;
  failedCount: number;
  retriedCount: number;
  providersUsed: string[];
  detectedLanguage: DetectedLanguageResult;
  verificationSummary: VerificationSummary;
  chunkOutputs: ChunkRecognitionOutput[];
}> {
  const cfg = getAppConfig();
  const job = getAnalysisJob(jobId);
  const allRows = db
    .prepare('SELECT * FROM transcription_chunks WHERE job_id = ? ORDER BY chunk_index ASC')
    .all(jobId) as Array<Record<string, unknown>>;

  const vocabulary = options.vocabulary ?? [];
  const providerMode: SttProviderMode = options.preferLocal
    ? 'whisper'
    : options.sttProvider ?? cfg.sttProvider;

  // Step 2a: Detect spoken language from first non-silent representative chunk
  let detectedLanguage: DetectedLanguageResult = {
    primaryLanguage: 'en',
    primaryLabel: 'English',
    confidence: 0.75,
    languagesDetected: [{ language: 'en', label: 'English', confidence: 0.75 }],
    isMultilingual: false,
    provider: providerMode,
  };

  if (allRows.length > 0 && (providerMode!=='whisper' || (options.languageOverride && options.languageOverride!=='auto'))) {
    const sampleRow = allRows.find((r) => fs.existsSync((r.wav_path as string) || '')) || allRows[0];
    if (sampleRow && fs.existsSync((sampleRow.wav_path as string) || '')) {
      detectedLanguage = await detectAudioLanguage({
        sampleWavPath: sampleRow.wav_path as string,
        sampleCompressedPath: (sampleRow.compressed_path as string | undefined) || undefined,
        languageOverride: options.languageOverride ?? job?.languageOverride ?? 'auto',
        sttProvider: providerMode,
      });
      updateAnalysisJobRow(jobId, {
        detectedLanguage: detectedLanguage.primaryLanguage,
      });
    }
  }

  const targetRows = allRows.filter((r) => r.status !== 'completed');
  const concurrency = Math.max(1, Math.min(6, options.concurrency ?? cfg.sttConcurrency));
  let retriedCount = 0;
  let geminiDisabledForJob =
    providerMode === 'whisper' || providerMode === 'mock' || !getGeminiClient();

  let cursor = 0;
  const runNext = async (): Promise<void> => {
    while (cursor < targetRows.length) {
      if (isJobCancelled(jobId)) return;
      const idxPos = cursor++;
      const row = targetRows[idxPos];
      const chunkId = row.id as string;
      const chunkIndex = Number(row.chunk_index);
      const sourceStart = Number(row.source_start);
      const sourceEnd = Number(row.source_end);
      const wavPath = row.wav_path as string;
      const compressedPath = (row.compressed_path as string | null) || wavPath;
      let attempts = Number(row.attempt_count || 0);

      db.prepare("UPDATE transcription_chunks SET status = 'processing', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        chunkId,
      );

      let succeeded = false;
      let lastErr = '';
      const maxTries = Math.max(1, Math.min(4, cfg.sttRetryCount));

      for (let tryNum = 0; tryNum < maxTries; tryNum++) {
        if (isJobCancelled(jobId)) return;
        attempts += 1;
        if (attempts > 1) retriedCount += 1;

        try {
          if (options.simulateFailChunkIndices?.includes(chunkIndex)) {
            throw new Error(`Simulated transient failure on chunk ${chunkIndex}`);
          }

          let recognized: { text: string; language: string; words: RawRecognizedWord[]; provider: string };
          if (providerMode === 'mock') {
            recognized = await transcribeChunkWithMockStt({
              wavPath,
              chunkId,
              sourceStart,
              sourceEnd,
              language: detectedLanguage.primaryLanguage,
            });
          } else if (!geminiDisabledForJob) {
            try {
              const prevRow = chunkIndex > 0 ? allRows[chunkIndex - 1] : undefined;
              const prevCtx = (prevRow?.raw_text as string | undefined) || '';
              recognized = await transcribeChunkWithGemini({
                compressedPath,
                wavPath,
                chunkId,
                sourceStart,
                sourceEnd,
                languageHint: options.languageOverride || 'auto',
                isMultilingual: detectedLanguage.isMultilingual,
                vocabulary,
                previousContext: prevCtx,
              });
            } catch (gemErr) {
              const msg = gemErr instanceof Error ? gemErr.message : String(gemErr);
              console.warn(`[transcriber] Gemini STT failed on chunk ${chunkIndex} (${msg}); switching to Local Whisper fallback.`);
              if (
                msg.includes('429') ||
                msg.includes('QUOTA') ||
                msg.includes('RESOURCE_EXHAUSTED') ||
                msg.includes('not configured')
              ) {
                geminiDisabledForJob = true;
              }
              recognized = await transcribeChunkWithLocalWhisper({
                wavPath,
                chunkId,
                sourceStart,
                sourceEnd,
                languageHint: options.languageOverride || 'auto',
                vocabulary,
              });
            }
          } else {
            recognized = await transcribeChunkWithLocalWhisper({
              wavPath,
              chunkId,
              sourceStart,
              sourceEnd,
              languageHint: options.languageOverride || 'auto',
              vocabulary,
            });
          }

          db.prepare(
            `UPDATE transcription_chunks
             SET status = 'completed', provider = ?, attempt_count = ?, raw_text = ?, language = ?, words_json = ?, error = NULL, updated_at = ?
             WHERE id = ?`,
          ).run(
            recognized.provider,
            attempts,
            recognized.text,
            recognized.language,
            JSON.stringify(recognized.words),
            new Date().toISOString(),
            chunkId,
          );
          succeeded = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          await new Promise((r) => setTimeout(r, 300 * (tryNum + 1)));
        }
      }

      if (!succeeded) {
        db.prepare(
          `UPDATE transcription_chunks
           SET status = 'failed', attempt_count = ?, error = ?, updated_at = ?
           WHERE id = ?`,
        ).run(attempts, lastErr.slice(0, 240), new Date().toISOString(), chunkId);
      }

      const stats = db
        .prepare(
          `SELECT
             COUNT(*) as total,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
           FROM transcription_chunks WHERE job_id = ?`,
        )
        .get(jobId) as { total: number; completed: number; failed: number };

      const done = (stats.completed || 0) + (stats.failed || 0);
      const progress = 25 + Math.round((done / Math.max(1, stats.total || 1)) * 52);
      updateAnalysisJobRow(jobId, {
        status: 'transcribing',
        transcriptionStatus: 'running',
        chunkTotal: stats.total || 0,
        chunkCompleted: stats.completed || 0,
        chunkFailed: stats.failed || 0,
        overallProgress: Math.min(78, progress),
      });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runNext()));

  const finalRows = db
    .prepare('SELECT * FROM transcription_chunks WHERE job_id = ? ORDER BY chunk_index ASC')
    .all(jobId) as Array<Record<string, unknown>>;

  const rawChunkOutputs: ChunkRecognitionOutput[] = [];
  const providers = new Set<string>();
  let completedCount = 0;
  let failedCount = 0;

  for (const r of finalRows) {
    if (r.status === 'completed') {
      completedCount += 1;
      if (r.provider) providers.add(r.provider as string);
      rawChunkOutputs.push({
        chunkId: r.id as string,
        chunkIndex: Number(r.chunk_index),
        sourceStart: Number(r.source_start),
        sourceEnd: Number(r.source_end),
        overlapBefore: Number(r.overlap_before || 0),
        overlapAfter: Number(r.overlap_after || 0),
        text: (r.raw_text as string) || '',
        language: (r.language as string) || detectedLanguage.primaryLanguage,
        provider: (r.provider as string) || cfg.sttWhisperModel,
        words: r.words_json ? (JSON.parse(r.words_json as string) as RawRecognizedWord[]) : [],
      });
    } else if (r.status === 'failed') {
      failedCount += 1;
    }
  }

  if (rawChunkOutputs.length && providerMode!=='mock') {
    const spoken=rawChunkOutputs.filter(c=>c.words.length && c.language && c.language!=='auto');
    if (spoken.length) {
      const totals=new Map<string,number>();
      for (const c of spoken) totals.set(c.language,(totals.get(c.language)||0)+c.words.length);
      const primary=[...totals].sort((a,b)=>b[1]-a[1])[0][0];
      detectedLanguage={...detectedLanguage,primaryLanguage:primary,primaryLabel:resolveLanguageMeta(primary).label,
        isMultilingual:totals.size>1,languagesDetected:spoken.map(c=>({language:c.language,label:resolveLanguageMeta(c.language).label,confidence:detectedLanguage.confidence,start:c.sourceStart,end:c.sourceEnd}))};
    }
  }
  // Pass-2 Audio-First Context Verification
  updateAnalysisJobRow(jobId, {
    status: 'aligning',
    overallProgress: 81,
  });

  const verified = await verifyTranscriptChunksWithAudio({
    chunkRows: finalRows,
    chunkOutputs: rawChunkOutputs,
    detectedLanguage: detectedLanguage.primaryLanguage,
    isMultilingual: detectedLanguage.isMultilingual,
    vocabulary,
    sttProvider: providerMode,
  });

  return {
    completedCount,
    failedCount,
    retriedCount,
    providersUsed: Array.from(providers),
    detectedLanguage,
    verificationSummary: verified.summary,
    chunkOutputs: verified.chunkOutputs,
  };
}
