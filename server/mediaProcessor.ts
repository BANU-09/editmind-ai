import { ThinkingLevel, Type } from '@google/genai';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { v4 as uuid } from 'uuid';
import {
  buildCaptionsFromAnalysis,
  createInitialProjectState,
  generateThreeVersions,
} from '../src/shared/timelineEngine';
import type {
  AnalysisJob,
  AudioStreamInfo,
  FillerHit,
  ImportantMoment,
  MediaAnalysis,
  ProjectState,
  SceneInfo,
  SilenceRange,
  SpeakerInfo,
  TranscriptSegment,
  TranscriptWord,
  TranscriptionStatus,
  VerificationSummary,
} from '../src/shared/types';
import { isVercelBlobConfigured, uploadFileToBlob } from './blobStorage';
import { getAppConfig } from './config';
import { db, THUMBS_DIR } from './db';
import { getGeminiClient, withTimeout } from './geminiClient';
import {
  buildSegmentsAndSummaryFromWords,
  type ChunkRecognitionOutput,
  type ChunkWorkerOptions,
  deduplicateChunkWords,
  type DetectedLanguageResult,
  extractStreamWavAndSilences,
  getAnalysisJob,
  inspectMediaStreams,
  isJobCancelled,
  planVoiceAwareChunks,
  processChunksForJob,
  sliceChunkAudioFiles,
  updateAnalysisJobRow,
} from './transcriber';

const execFileAsync = promisify(execFile);

export interface ProbeMetadata {
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

export async function probeVideoFile(filePath: string): Promise<ProbeMetadata> {
  return inspectMediaStreams(filePath);
}

async function extractThumbnailAt(
  filePath: string,
  timeSec: number,
  outPath: string,
): Promise<boolean> {
  try {
    // Preserve full aspect ratio of landscape, portrait, or square videos (no cropping/stretching)
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss',
      Math.max(0, timeSec).toFixed(2),
      '-i',
      filePath,
      '-vframes',
      '1',
      '-vf',
      "scale='if(gte(iw,ih),640,-2)':'if(gte(iw,ih),-2,640)'",
      '-q:v',
      '4',
      outPath,
    ]);
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
}

export async function extractAudioFeatures(
  filePath: string,
  durationSec: number,
  hasAudio: boolean,
): Promise<{
  waveformPeaks: number[];
  energyEnvelope40Hz: number[];
  silences: SilenceRange[];
}> {
  const sampleCount = 120;
  const totalEnvBins = Math.max(20, Math.ceil(durationSec * 40));
  if (!hasAudio) {
    return {
      waveformPeaks: new Array(sampleCount).fill(0.03),
      energyEnvelope40Hz: new Array(totalEnvBins).fill(0),
      silences: [],
    };
  }

  const silences: SilenceRange[] = [];
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-i',
      filePath,
      '-af',
      'silencedetect=noise=-32dB:d=0.45',
      '-f',
      'null',
      '-',
    ]);

    let currentStart: number | null = null;
    for (const line of stderr.split('\n')) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) {
        currentStart = parseFloat(startMatch[1]);
      }
      const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const end = Math.min(durationSec, parseFloat(endMatch[1]));
        const dur = parseFloat(endMatch[2]);
        if (dur >= 0.45 && end > currentStart) {
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
  } catch {
    // Ignore silence detection errors on unusual streams
  }

  const waveformPeaks: number[] = [];
  const energyEnvelope40Hz: number[] = [];
  try {
    // Extract 4000Hz mono 16-bit PCM (100 samples = 25ms frame at 40Hz)
    const { stdout } = await execFileAsync(
      'ffmpeg',
      ['-i', filePath, '-ac', '1', '-ar', '4000', '-f', 's16le', '-'],
      { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 },
    );
    const totalSamples = Math.floor(stdout.length / 2);

    // 40Hz RMS energy envelope for voice-activity word alignment
    const samplesPer25Ms = 100;
    const binCount = Math.max(1, Math.floor(totalSamples / samplesPer25Ms));
    for (let b = 0; b < binCount; b++) {
      let sumSq = 0;
      const startIdx = b * samplesPer25Ms;
      const endIdx = Math.min(totalSamples, startIdx + samplesPer25Ms);
      for (let j = startIdx; j < endIdx; j++) {
        const val = stdout.readInt16LE(j * 2) / 32768;
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, endIdx - startIdx));
      energyEnvelope40Hz.push(Math.min(1, rms * 2.5));
    }

    // 120 display waveform bars
    if (totalSamples > sampleCount) {
      const bucket = Math.floor(totalSamples / sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        let maxAbs = 0;
        const startIdx = i * bucket;
        const endIdx = Math.min(totalSamples, startIdx + bucket);
        for (let j = startIdx; j < endIdx; j += 4) {
          const val = Math.abs(stdout.readInt16LE(j * 2)) / 32768;
          if (val > maxAbs) maxAbs = val;
        }
        waveformPeaks.push(Math.round(Math.min(1, maxAbs * 1.45) * 100) / 100);
      }
    }
  } catch {
    // Fallback below if PCM pipe fails
  }

  if (energyEnvelope40Hz.length === 0) {
    for (let i = 0; i < totalEnvBins; i++) {
      const t = i / 40;
      const inSil = silences.some((s) => t >= s.start && t <= s.end);
      energyEnvelope40Hz.push(inSil ? 0.01 : 0.45);
    }
  }

  if (waveformPeaks.length === 0) {
    for (let i = 0; i < sampleCount; i++) {
      const t = (i / sampleCount) * durationSec;
      const inSilence = silences.some((s) => t >= s.start && t <= s.end);
      waveformPeaks.push(inSilence ? 0.04 : 0.35);
    }
  }

  return { waveformPeaks, energyEnvelope40Hz, silences };
}

/**
 * Acoustic voice-activity alignment:
 * Finds contiguous voiced regions within [start, end] using 40Hz PCM RMS energy,
 * then weights word durations by phonetic character count across voiced frames.
 */
export function alignWordsWithAudioEnergy(
  segId: string,
  text: string,
  speaker: string,
  start: number,
  end: number,
  energyEnvelope40Hz: number[],
): { words: TranscriptWord[]; fillers: FillerHit[] } {
  const raw = text.split(/\s+/).filter(Boolean);
  if (raw.length === 0) return { words: [], fillers: [] };

  const segStart = Math.max(0, start);
  const segEnd = Math.max(segStart + 0.15, end);

  // Locate active speech frames (threshold 0.06 RMS) within segment bounds
  const startBin = Math.max(0, Math.floor(segStart * 40));
  const endBin = Math.min(
    energyEnvelope40Hz.length - 1,
    Math.ceil(segEnd * 40),
  );

  const activeBins: number[] = [];
  for (let b = startBin; b <= endBin; b++) {
    if ((energyEnvelope40Hz[b] ?? 0) >= 0.05) {
      activeBins.push(b);
    }
  }

  // Determine voiced window boundaries
  let voiceStart = segStart;
  let voiceEnd = segEnd;
  if (activeBins.length >= Math.max(3, raw.length)) {
    voiceStart = Math.max(segStart, activeBins[0] / 40);
    voiceEnd = Math.min(segEnd, (activeBins[activeBins.length - 1] + 1) / 40);
    if (voiceEnd - voiceStart < 0.25) {
      voiceStart = segStart;
      voiceEnd = segEnd;
    }
  }

  // Group into speech sub-islands (splitting on internal pauses >= 200ms i.e. 8 zero bins)
  const islands: Array<{ start: number; end: number; bins: number }> = [];
  if (activeBins.length >= raw.length) {
    let curStart = activeBins[0];
    let curPrev = activeBins[0];
    for (let i = 1; i < activeBins.length; i++) {
      const b = activeBins[i];
      if (b - curPrev > 8) {
        islands.push({
          start: Math.max(segStart, curStart / 40),
          end: Math.min(segEnd, (curPrev + 1) / 40),
          bins: curPrev - curStart + 1,
        });
        curStart = b;
      }
      curPrev = b;
    }
    islands.push({
      start: Math.max(segStart, curStart / 40),
      end: Math.min(segEnd, (curPrev + 1) / 40),
      bins: curPrev - curStart + 1,
    });
  }

  // Build cumulative voiced timeline if multiple islands exist, otherwise single span
  const activeIslands =
    islands.length > 0 && islands.reduce((s, x) => s + (x.end - x.start), 0) >= Math.max(0.25, raw.length * 0.08)
      ? islands
      : [{ start: voiceStart, end: voiceEnd, bins: 1 }];

  const totalVoicedDur = activeIslands.reduce((s, isl) => s + Math.max(0.05, isl.end - isl.start), 0);

  // Map a fractional voiced offset [0..totalVoicedDur] back to actual source seconds
  const mapVoicedOffsetToSource = (offset: number): number => {
    let rem = Math.max(0, Math.min(totalVoicedDur, offset));
    for (const isl of activeIslands) {
      const d = Math.max(0.05, isl.end - isl.start);
      if (rem <= d + 1e-6) {
        return Math.round((isl.start + rem) * 1000) / 1000;
      }
      rem -= d;
    }
    return Math.round(activeIslands[activeIslands.length - 1].end * 1000) / 1000;
  };

  // Unicode-aware phonetic weight per word (supports Hindi, Tamil, Latin, numbers, etc.)
  const weights = raw.map((w) => {
    const cleanLen = Math.max(2, w.replace(/[^\p{L}\p{N}]/gu, '').length);
    const punctBoost = /[,.;:!?।]$/.test(w) ? 1.5 : 0;
    return cleanLen + punctBoost;
  });
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const words: TranscriptWord[] = [];
  const fillers: FillerHit[] = [];
  let cursorWeight = 0;

  raw.forEach((w, idx) => {
    const fracStart = cursorWeight / totalWeight;
    cursorWeight += weights[idx];
    const fracEnd = cursorWeight / totalWeight;

    const ws = mapVoicedOffsetToSource(fracStart * totalVoicedDur);
    let we = mapVoicedOffsetToSource(fracEnd * totalVoicedDur);
    if (we <= ws + 0.06) {
      we = Math.round(Math.min(segEnd, ws + 0.12) * 1000) / 1000;
    }

    const clean = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    const isFiller = ['um', 'uh', 'er', 'ah', 'hmm'].includes(clean);
    words.push({
      id: `${segId}-w${idx + 1}`,
      word: w,
      start: ws,
      end: we,
      speaker,
      isFiller,
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

async function runSceneSelectFilter(filePath: string, threshold: number, keyframesOnly:boolean): Promise<number[]> {
  const times: number[] = [];
  const { stderr } = await execFileAsync('ffmpeg', [
    ...(keyframesOnly?['-skip_frame','nokey']:[]),
    '-i',
    filePath,
    '-an', '-sn', '-vf',
     `fps=2,scale=160:-2,select='gt(scene,${threshold})',showinfo`,
    '-f',
    'null',
    '-',
  ]);
  for (const line of stderr.split('\n')) {
    const match = line.match(/pts_time:([0-9.]+)/);
    if (match) {
      const t = Math.round(parseFloat(match[1]) * 1000) / 1000;
      if (Number.isFinite(t)) times.push(t);
    }
  }
  return times;
}

async function detectSceneCutTimes(
  filePath: string,
  durationSec: number,
): Promise<{ cutTimes: number[]; detectedCutsCount: number }> {
  const times: number[] = [0];
  let detectedRawCount = 0;

  try {
    const rawCuts = await runSceneSelectFilter(filePath, 0.12, durationSec>300);
    detectedRawCount = rawCuts.length;
    rawCuts.sort((a, b) => a - b);

    for (const t of rawCuts) {
      if (t - times[times.length - 1] >= 1.5 && t < durationSec - 0.8) {
        times.push(Math.round(t * 100) / 100);
      }
    }
  } catch {
    // Ignore scene detection failure on unusual codecs
  }

  // If continuous single-shot video > 8s with zero visual cut deltas, segment evenly as visual chapters
  if (times.length === 1 && durationSec > 8) {
    const step = Math.max(4, durationSec / Math.min(5, Math.ceil(durationSec / 6)));
    for (let t = step; t < durationSec - 1.5; t += step) {
      times.push(Math.round(t * 100) / 100);
    }
  }

  const orderedUnique = Array.from(
    new Set(times.filter((t) => t >= 0 && t < durationSec - 0.1)),
  ).sort((a, b) => a - b);

  return {
    cutTimes: orderedUnique.slice(0, 14),
    detectedCutsCount: detectedRawCount,
  };
}

async function enrichScenesWithVision(
  scenes: SceneInfo[],
  filename: string,
): Promise<SceneInfo[]> {
  const ai = getGeminiClient();
  if (!ai || scenes.length === 0) return scenes;

  const targetScenes = scenes.slice(0, 8);
  const parts: Array<
    | { inlineData: { mimeType: string; data: string } }
    | { text: string }
  > = [];
  const validIndices: number[] = [];

  for (let i = 0; i < targetScenes.length; i++) {
    const thumbFile = path.basename(targetScenes[i].thumbnailUrl || '');
    const thumbFull = thumbFile ? path.join(THUMBS_DIR, thumbFile) : '';
    if (thumbFull && fs.existsSync(thumbFull)) {
      const bytes = fs.readFileSync(thumbFull);
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: bytes.toString('base64'),
        },
      });
      validIndices.push(i);
    }
  }

  if (validIndices.length === 0) return scenes;

  parts.push({
    text: `You are analyzing ${validIndices.length} chronological video keyframes from "${filename}". For each frame index 0..${validIndices.length - 1}, describe what is visually shown (concise 2-5 word title, accurate 1-sentence visual description, visible objects list, and actions/activities list).`,
  });

  try {
    const resp = await withTimeout(
      ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: { parts },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              frames: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    frameIndex: { type: Type.INTEGER },
                    title: { type: Type.STRING },
                    description: { type: Type.STRING },
                    objects: { type: Type.ARRAY, items: { type: Type.STRING } },
                    activities: { type: Type.ARRAY, items: { type: Type.STRING } },
                  },
                },
              },
            },
          },
        },
      }),
      22000,
      'Gemini visual scene analysis',
    );

    const parsed = JSON.parse((resp.text || '{}').trim()) as {
      frames?: Array<{
        frameIndex?: number;
        title?: string;
        description?: string;
        objects?: string[];
        activities?: string[];
      }>;
    };

    if (parsed.frames && parsed.frames.length > 0) {
      const next = [...scenes];
      parsed.frames.forEach((f, pos) => {
        const mappedIdx = validIndices[f.frameIndex ?? pos];
        if (mappedIdx !== undefined && next[mappedIdx]) {
          next[mappedIdx] = {
            ...next[mappedIdx],
            title: (f.title || '').trim() || next[mappedIdx].title,
            description: (f.description || '').trim() || next[mappedIdx].description,
            objects: f.objects && f.objects.length > 0 ? f.objects : next[mappedIdx].objects,
            activities:
              f.activities && f.activities.length > 0 ? f.activities : next[mappedIdx].activities,
          };
        }
      });
      return next;
    }
  } catch (err) {
    console.warn('Gemini visual scene analysis skipped:', err instanceof Error ? err.message : err);
  }

  return scenes;
}

export async function prepareFastMediaRecord(params: {
  mediaId: string;
  filePath: string;
  filename: string;
  audioStreamIndex?: number;
}): Promise<{ analysis: MediaAnalysis; thumbnailUrl: string }> {
  const { mediaId, filePath, filename, audioStreamIndex = 0 } = params;
  const meta = await inspectMediaStreams(filePath);
  const selectedStream =
    meta.audioStreams.length > 0
      ? Math.max(0, Math.min(meta.audioStreams.length - 1, audioStreamIndex))
      : 0;

  const mainThumbPath = path.join(THUMBS_DIR, `${mediaId}.jpg`);
  const gotMain = await extractThumbnailAt(
    filePath,
    Math.min(1.0, meta.durationSec * 0.15),
    mainThumbPath,
  );
  let mainThumbUrl = gotMain ? `/api/thumbs/${mediaId}.jpg` : '';
  if (gotMain && isVercelBlobConfigured()) {
    const uploadedThumb = await uploadFileToBlob({
      localPath: mainThumbPath,
      blobPathname: `thumbs/${mediaId}.jpg`,
      contentType: 'image/jpeg',
    }).catch(() => null);
    if (uploadedThumb?.url) {
      mainThumbUrl = uploadedThumb.url;
    }
  }

  const initialScenes: SceneInfo[] = [
    {
      id: `sc-${mediaId}-1`,
      start: 0,
      end: meta.durationSec,
      title: `Full Source (${meta.durationSec.toFixed(1)}s)`,
      description: `Uploaded footage from ${filename}.`,
      objects: ['video frame'],
      activities: ['visual shot'],
      thumbnailUrl: mainThumbUrl,
    },
  ];

  const hasAudio = meta.hasAudio;
  return {
    thumbnailUrl: mainThumbUrl,
    analysis: {
      mediaId,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      variableFrameRate: meta.variableFrameRate,
      hasAudio,
      detectedAudioStreams: meta.detectedAudioStreams,
      audioStreams: meta.audioStreams,
      selectedAudioStream: selectedStream,
      codec: meta.codec,
      analysisMode: 'local-ffmpeg',
      transcriptionStatus: hasAudio ? 'queued' : 'no-audio',
      analysisNote: hasAudio
        ? 'Queued for background audio extraction and chunked speech transcription...'
        : 'No audio stream detected in this video file.',
      waveformPeaks: new Array(120).fill(hasAudio ? 0.25 : 0.03),
      transcript: [],
      scenes: initialScenes,
      speakers: [],
      importantMoments: [],
      silences: [],
      fillers: [],
      topics: [],
      summary: `${filename} (${meta.durationSec.toFixed(1)}s, ${meta.width}×${meta.height})`,
    },
  };
}

function syncFinalizedAnalysisToDb(
  mediaId: string,
  projectId: string | null,
  analysis: MediaAnalysis,
  thumbnailUrl?: string,
) {
  db.prepare(
    `UPDATE media_assets
     SET duration_sec = ?, width = ?, height = ?, has_audio = ?, analysis_mode = ?, analysis_json = ?
     WHERE id = ?`,
  ).run(
    analysis.durationSec,
    analysis.width,
    analysis.height,
    analysis.hasAudio ? 1 : 0,
    analysis.analysisMode,
    JSON.stringify(analysis),
    mediaId,
  );

  const projectRows=db.prepare('SELECT * FROM projects WHERE media_id=?').all(mediaId) as Array<Record<string,unknown>>;
  const versions = generateThreeVersions(analysis);
  const now = new Date().toISOString();

  for (const proj of projectRows) {
    const curState = JSON.parse(proj.state_json as string) as ProjectState;
    const isUntouchedDefault =
      curState.segments.length === 1 &&
      curState.segments[0].sourceSegmentId === 'src-full' &&
      Math.abs(curState.duration - analysis.durationSec) < 0.5 &&
      curState.captions.length === 0;

    let nextState: ProjectState;
    if (isUntouchedDefault && analysis.transcript.length > 0) {
      const fresh = createInitialProjectState(analysis);
      nextState = {
        ...fresh,
        audio: curState.audio,
        overlays: curState.overlays,
        trackVisibility: curState.trackVisibility,
        trackLocks: curState.trackLocks,
      };
    } else {
      const freshCaps = buildCaptionsFromAnalysis(analysis);
      nextState = {
        ...curState,
        captions: curState.captions.length === 0 ? freshCaps : curState.captions,
        captionsEnabled:
          curState.captions.length === 0 && freshCaps.length > 0 ? true : curState.captionsEnabled,
        protectedMomentIds:
          curState.protectedMomentIds.length === 0
            ? analysis.importantMoments.filter((m) => m.protected).map((m) => m.id)
            : curState.protectedMomentIds,
      };
    }

    const history=JSON.parse(String(proj.history_json)) as Array<{stateSnapshot:ProjectState;durationAfter:number}>;
    if (isUntouchedDefault && history.length===1) history[0]={...history[0],stateSnapshot:nextState,durationAfter:nextState.duration};
    db.prepare(
      `UPDATE projects SET thumbnail_url = ?, state_json = ?, versions_json = ?, history_json = ?, updated_at = ? WHERE id = ?`,
    ).run(
      thumbnailUrl || (proj.thumbnail_url as string),
      JSON.stringify(nextState),
      JSON.stringify(versions),
      JSON.stringify(history),
      now,
      proj.id as string,
    );
  }
}

async function finalizeTranscriptionOutputs(params: {
  jobId: string;
  mediaId: string;
  projectId: string | null;
  filePath: string;
  filename: string;
  meta: ProbeMetadata;
  selectedStream: number;
  languageOverride?: string;
  vocabulary?: string[];
  thumbnailUrl: string;
  scenes: SceneInfo[];
  silences: SilenceRange[];
  waveformPeaks: number[];
  chunkStats: {
    completedCount: number;
    failedCount: number;
    retriedCount: number;
    providersUsed: string[];
    detectedLanguage?: DetectedLanguageResult;
    verificationSummary?: VerificationSummary;
    chunkOutputs: ChunkRecognitionOutput[];
  };
}): Promise<MediaAnalysis> {
  const {
    jobId,
    mediaId,
    projectId,
    filename,
    meta,
    selectedStream,
    languageOverride,
    vocabulary = [],
    thumbnailUrl,
    scenes,
    silences,
    waveformPeaks,
    chunkStats,
  } = params;

  updateAnalysisJobRow(jobId, {
    status: 'aligning',
    alignmentStatus: 'running',
    overallProgress: 86,
  });

  const totalChunks = chunkStats.completedCount + chunkStats.failedCount;
  const dedupedWords = deduplicateChunkWords(chunkStats.chunkOutputs);
  const detectedLang = chunkStats.detectedLanguage;
  const primaryLang =
    detectedLang?.primaryLanguage ||
    (languageOverride && languageOverride !== 'auto' ? languageOverride : undefined) ||
    chunkStats.chunkOutputs[0]?.language ||
    'en';

  const built = buildSegmentsAndSummaryFromWords({
    mediaId,
    rawWords: dedupedWords,
    silences,
    durationSec: meta.durationSec,
    language: primaryLang,
  });

  updateAnalysisJobRow(jobId, {
    status: 'generating-captions',
    alignmentStatus: 'completed',
    captionStatus: 'running',
    overallProgress: 94,
  });

  const usedGemini = chunkStats.providersUsed.some((p) => p.includes('gemini'));
  const providerSummary = chunkStats.providersUsed.join(' + ') || 'none';

  let finalStatus: TranscriptionStatus;
  let errorMsg: string | undefined;
  let note: string;

  if (chunkStats.completedCount === 0 && chunkStats.failedCount > 0) {
    finalStatus = 'failed';
    errorMsg = `${chunkStats.failedCount} of ${totalChunks} audio chunks failed speech transcription.`;
    note = errorMsg;
  } else if (chunkStats.failedCount > 0) {
    finalStatus = 'partial';
    errorMsg = `${chunkStats.completedCount}/${totalChunks} chunks transcribed; ${chunkStats.failedCount} chunk(s) failed and can be retried.`;
    note = errorMsg;
  } else if (usedGemini) {
    finalStatus = 'complete';
    note = `Verbatim multilingual transcription complete (${totalChunks} chunk(s), ${dedupedWords.length} words via ${providerSummary}).`;
  } else {
    finalStatus = 'local-fallback';
    note = `Transcribed via ${providerSummary} across ${totalChunks} voice-aware chunk(s) (${dedupedWords.length} words with timestamps).`;
  }

  const chunkLanguages=new Map(chunkStats.chunkOutputs.map(c=>[c.chunkId,c.language]));
  for (const segment of built.transcript) segment.language=chunkLanguages.get(segment.chunkId||'') || primaryLang;

  const analysis: MediaAnalysis = {
    mediaId,
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    variableFrameRate: meta.variableFrameRate,
    hasAudio: meta.hasAudio,
    detectedAudioStreams: meta.detectedAudioStreams,
    audioStreams: meta.audioStreams,
    selectedAudioStream: selectedStream,
    codec: meta.codec,
    analysisMode: usedGemini ? 'gemini-ai' : 'local-ffmpeg',
    transcriptionStatus: finalStatus,
    transcriptionError: errorMsg,
    providerUsed: providerSummary,
    chunkStats: {
      total: totalChunks,
      completed: chunkStats.completedCount,
      failed: chunkStats.failedCount,
      processing: 0,
      pending: 0,
      retried: chunkStats.retriedCount,
    },
    wordCount: dedupedWords.length,
    language: primaryLang,
    detectedLanguage: primaryLang,
    detectedLanguageLabel: detectedLang?.primaryLabel || primaryLang,
    languageConfidence: detectedLang?.confidence ?? 0.85,
    languagesDetected: detectedLang?.languagesDetected,
    isMultilingual: detectedLang?.isMultilingual ?? false,
    selectedLanguageOverride: languageOverride || 'auto',
    vocabulary,
    verificationSummary: chunkStats.verificationSummary,
    analysisNote: note,
    waveformPeaks,
    transcript: built.transcript,
    scenes,
    speakers: built.speakers,
    importantMoments: built.importantMoments,
    silences,
    fillers: built.fillers,
    topics: built.topics.length > 0 ? built.topics : scenes.map((s) => s.title),
    summary: built.summary || `Indexed ${filename} (${meta.durationSec.toFixed(1)}s).`,
  };

  syncFinalizedAnalysisToDb(mediaId, projectId, analysis, thumbnailUrl);

  updateAnalysisJobRow(jobId, {
    status: finalStatus,
    transcriptionStatus:
      finalStatus === 'failed' ? 'failed' : finalStatus === 'partial' ? 'partial' : 'completed',
    captionStatus: 'completed',
    providerUsed: providerSummary,
    detectedLanguage: primaryLang,
    languageOverride: languageOverride || 'auto',
    chunkTotal: totalChunks,
    chunkCompleted: chunkStats.completedCount,
    chunkFailed: chunkStats.failedCount,
    overallProgress: 100,
    error: errorMsg || undefined,
  });

  return analysis;
}

const activeJobPromises = new Map<string, Promise<MediaAnalysis>>();

let analysisQueue:Promise<void>=Promise.resolve();
function enqueueAnalysis(id:string, options:ChunkWorkerOptions & {audioStreamIndex?:number}={}) {
  const task=analysisQueue.then(()=>{
    if (isJobCancelled(id)) throw new Error('Analysis cancelled.');
    return executeAnalysisJob(id,options);
  });
  analysisQueue=task.then(()=>{},()=>{});
  return task;
}

export async function executeAnalysisJob(
  jobId: string,
  options: ChunkWorkerOptions & { audioStreamIndex?: number } = {},
): Promise<MediaAnalysis> {
  const started=performance.now();
  const metrics:Record<string,number>={};
  function measure(name:string,start:number) {
    metrics[name]=Math.round(performance.now()-start);
    metrics.processPeakRssKiB=process.resourceUsage().maxRSS;
    db.prepare('UPDATE analysis_jobs SET metrics_json=? WHERE id=?').run(JSON.stringify(metrics),jobId);
  }
  const cfg = getAppConfig();
  const job = getAnalysisJob(jobId);
  if (!job) throw new Error(`Analysis job ${jobId} not found`);

  const mediaRow = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(job.mediaId) as
    | Record<string, unknown>
    | undefined;
  if (!mediaRow) throw new Error(`Media ${job.mediaId} not found`);

  const projRow = job.projectId
    ? (db.prepare('SELECT vocabulary_json FROM projects WHERE id = ?').get(job.projectId) as
        | { vocabulary_json?: string }
        | undefined)
    : undefined;
  const dbVocab: string[] = projRow?.vocabulary_json
    ? (JSON.parse(projRow.vocabulary_json) as string[])
    : mediaRow.vocabulary_json
      ? (JSON.parse(mediaRow.vocabulary_json as string) as string[])
      : [];
  const mergedVocab = Array.from(new Set([...(options.vocabulary || []), ...dbVocab])).filter(Boolean);
  const effectiveLangOverride = options.languageOverride ?? job.languageOverride ?? 'auto';

  const filePath = mediaRow.file_path as string;
  const filename = mediaRow.filename as string;
  const meta = await inspectMediaStreams(filePath);
  const selectedStream =
    meta.audioStreams.length > 0
      ? Math.max(0, Math.min(meta.audioStreams.length - 1, options.audioStreamIndex ?? job.selectedAudioStream))
      : 0;

  const mainThumbPath = path.join(THUMBS_DIR, `${job.mediaId}.jpg`);
  if (!fs.existsSync(mainThumbPath)) {
    await extractThumbnailAt(filePath, Math.min(1.0, meta.durationSec * 0.15), mainThumbPath);
  }
  let mainThumbUrl = fs.existsSync(mainThumbPath) ? `/api/thumbs/${job.mediaId}.jpg` : '';
  if (fs.existsSync(mainThumbPath) && isVercelBlobConfigured()) {
    const uploaded = await uploadFileToBlob({
      localPath: mainThumbPath,
      blobPathname: `thumbs/${job.mediaId}.jpg`,
      contentType: 'image/jpeg',
    }).catch(() => null);
    if (uploaded?.url) {
      mainThumbUrl = uploaded.url;
    }
  }

  if (isJobCancelled(jobId)) {
    throw new Error('Analysis job was cancelled.');
  }

  updateAnalysisJobRow(jobId, {
    status: meta.hasAudio ? 'extracting-audio' : 'aligning',
    audioExtractionStatus: meta.hasAudio ? 'running' : 'skipped',
    overallProgress: 10,
  });

  const sceneStarted=performance.now();
  const buildScenesPromise = (async (): Promise<SceneInfo[]> => {
    const { cutTimes, detectedCutsCount } = await detectSceneCutTimes(filePath, meta.durationSec);
    const builtScenes: SceneInfo[] = [];
    for (let i = 0; i < cutTimes.length; i++) {
      const start = Math.round(cutTimes[i] * 1000) / 1000;
      const rawEnd = i + 1 < cutTimes.length ? cutTimes[i + 1] : meta.durationSec;
      const end = Math.min(meta.durationSec, Math.max(start + 0.1, Math.round(rawEnd * 1000) / 1000));
      if (end <= start) continue;
      const scThumbPath = path.join(THUMBS_DIR, `${job.mediaId}-sc-${i + 1}.jpg`);
      const sampleT = Math.min(meta.durationSec - 0.05, start + Math.min(0.4, (end - start) * 0.25));
      const ok = await extractThumbnailAt(filePath, Math.max(0, sampleT), scThumbPath);
      builtScenes.push({
        id: `sc-${job.mediaId}-${i + 1}`,
        start,
        end,
        title: `Scene ${i + 1} (${start.toFixed(1)}s–${end.toFixed(1)}s)`,
        description:
          detectedCutsCount > 0
            ? `Detected visual transition in ${filename} at ${start.toFixed(1)}s.`
            : `Continuous visual shot from ${filename} (${start.toFixed(1)}s–${end.toFixed(1)}s).`,
        objects: ['video frame'],
        activities: ['visual shot'],
        thumbnailUrl: ok ? `/api/thumbs/${job.mediaId}-sc-${i + 1}.jpg` : mainThumbUrl,
      });
    }
    return enrichScenesWithVision(builtScenes, filename);
  })().then(scenes=>{measure('sceneIndexMs',sceneStarted);return scenes;});

  if (!meta.hasAudio) {
    const scenes = await buildScenesPromise;
    const noAudioAnalysis: MediaAnalysis = {
      mediaId: job.mediaId,
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      variableFrameRate: meta.variableFrameRate,
      hasAudio: false,
      detectedAudioStreams: 0,
      audioStreams: [],
      selectedAudioStream: 0,
      codec: meta.codec,
      analysisMode: 'local-ffmpeg',
      transcriptionStatus: 'no-audio',
      vocabulary: mergedVocab,
      analysisNote:
        'No audio stream detected in this video file. Visual scenes and frame metadata were extracted cleanly.',
      waveformPeaks: new Array(120).fill(0.03),
      transcript: [],
      scenes,
      speakers: [],
      importantMoments: [],
      silences: [],
      fillers: [],
      topics: scenes.map((s) => s.title),
      summary: `Silent visual media (${filename}, ${meta.durationSec.toFixed(1)}s, ${meta.width}x${meta.height}).`,
    };
    syncFinalizedAnalysisToDb(job.mediaId, job.projectId, noAudioAnalysis, mainThumbUrl);
    updateAnalysisJobRow(jobId, {
      status: 'no-audio',
      audioExtractionStatus: 'skipped',
      transcriptionStatus: 'skipped',
      alignmentStatus: 'skipped',
      captionStatus: 'skipped',
      overallProgress: 100,
    });
    return noAudioAnalysis;
  }

  // Stage 1: Extract selected audio stream on disk + silences + waveform
  updateAnalysisJobRow(jobId, {
    status: 'extracting-audio',
    audioExtractionStatus: 'running',
    overallProgress: 14,
  });

  const extractionStarted=performance.now();
  const { masterWavPath, silences, waveformPeaks } = await extractStreamWavAndSilences({
    mediaId: job.mediaId,
    filePath,
    audioStreamIndex: selectedStream,
    durationSec: meta.durationSec,
  });

  measure('audioExtractionMs',extractionStarted);
  const prepStarted=performance.now();
  let existingChunks = db
    .prepare('SELECT * FROM transcription_chunks WHERE job_id = ? ORDER BY chunk_index ASC')
    .all(jobId) as Array<Record<string, unknown>>;

  if (existingChunks.length === 0) {
    const planned = planVoiceAwareChunks(meta.durationSec, silences, {
      targetSec: cfg.chunkTargetSec,
      minSec: cfg.chunkMinSec,
      maxSec: cfg.chunkMaxSec,
      overlapSec: cfg.chunkOverlapSec,
      preferPhraseBoundaries: effectiveLangOverride === 'auto',
    });
    const prepared = await sliceChunkAudioFiles({
      mediaId: job.mediaId,
      jobId,
      masterWavPath,
      chunks: planned,
    });
    const now = new Date().toISOString();
    const insertChunk = db.prepare(
      `INSERT INTO transcription_chunks
       (id, job_id, media_id, chunk_index, source_start, source_end, overlap_before, overlap_after, wav_path, compressed_path, status, attempt_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
    );
    for (const item of prepared) {
      insertChunk.run(
        item.chunkId,
        jobId,
        job.mediaId,
        item.chunk.index,
        item.chunk.sourceStart,
        item.chunk.sourceEnd,
        item.chunk.overlapBefore,
        item.chunk.overlapAfter,
        item.wavPath,
        item.compressedPath,
        now,
      );
    }
    existingChunks = db
      .prepare('SELECT * FROM transcription_chunks WHERE job_id = ? ORDER BY chunk_index ASC')
      .all(jobId) as Array<Record<string, unknown>>;
  }

  const missing=existingChunks.filter(r=>r.status!=='completed' && !fs.existsSync(String(r.wav_path)));
  if (missing.length) {
    const prepared=await sliceChunkAudioFiles({mediaId:job.mediaId,jobId,masterWavPath,chunks:missing.map(r=>({index:Number(r.chunk_index),sourceStart:Number(r.source_start),sourceEnd:Number(r.source_end),overlapBefore:Number(r.overlap_before),overlapAfter:Number(r.overlap_after)}))});
    const update=db.prepare('UPDATE transcription_chunks SET wav_path=?,compressed_path=? WHERE job_id=? AND chunk_index=?');
    for (const p of prepared) update.run(p.wavPath,p.compressedPath,jobId,p.chunk.index);
  }
  updateAnalysisJobRow(jobId, {
    status: 'transcribing',
    audioExtractionStatus: 'completed',
    transcriptionStatus: 'running',
    chunkTotal: existingChunks.length,
    overallProgress: 25,
  });

  measure('chunkPreparationMs',prepStarted);
  const sttStarted=performance.now();
  const [chunkStats, scenes] = await Promise.all([
    processChunksForJob(jobId, {
      ...options,
      vocabulary: mergedVocab,
      languageOverride: effectiveLangOverride,
    }).then(result=>{measure('transcriptionMs',sttStarted);return result;}),
    buildScenesPromise,
  ]);
  if (isJobCancelled(jobId)) {
    throw new Error('Analysis job cancelled by user.');
  }

  const captionStarted=performance.now();
  const finalized=await finalizeTranscriptionOutputs({
    jobId,
    mediaId: job.mediaId,
    projectId: job.projectId,
    filePath,
    filename,
    meta,
    selectedStream,
    languageOverride: effectiveLangOverride,
    vocabulary: mergedVocab,
    thumbnailUrl: mainThumbUrl,
    scenes,
    silences,
    waveformPeaks,
    chunkStats,
  });
  measure('captionAndFinalizeMs',captionStarted);
  measure('totalAnalysisMs',started);
  return finalized;
}

export function startBackgroundAnalysisJob(params: {
  mediaId: string;
  projectId: string | null;
  audioStreamIndex?: number;
  languageOverride?: string;
  vocabulary?: string[];
  options?: ChunkWorkerOptions;
}): { job: AnalysisJob; promise: Promise<MediaAnalysis> } {
  const jobId = `job-${uuid()}`;
  const now = new Date().toISOString();
  const streamIdx = params.audioStreamIndex ?? 0;
  const langOverride = params.languageOverride ?? params.options?.languageOverride ?? 'auto';

  db.prepare(
    `INSERT INTO analysis_jobs
     (id, media_id, project_id, selected_audio_stream, language_override, status, overall_progress, audio_extraction_status, transcription_status, chunk_total, chunk_completed, chunk_failed, alignment_status, caption_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 5, 'pending', 'pending', 0, 0, 0, 'pending', 'pending', ?, ?)`,
  ).run(jobId, params.mediaId, params.projectId, streamIdx, langOverride, now, now);

  const job = getAnalysisJob(jobId)!;
  const promise = enqueueAnalysis(jobId, {
    ...params.options,
    audioStreamIndex: streamIdx,
    languageOverride: langOverride,
    vocabulary: params.vocabulary ?? params.options?.vocabulary,
  })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isJobCancelled(jobId)) {
        updateAnalysisJobRow(jobId, {
          status: 'failed',
          transcriptionStatus: 'failed',
          error: msg.slice(0, 260),
        });
      }
      throw err;
    })
    .finally(() => {
      activeJobPromises.delete(jobId);
    });

  // Prevent Node UnhandledPromiseRejection termination when callers run jobs asynchronously
  promise.catch(() => {});
  activeJobPromises.set(jobId, promise);
  return { job, promise };
}

export async function retryFailedJobChunks(
  jobId: string,
  options: ChunkWorkerOptions = {},
): Promise<MediaAnalysis> {
  const job = getAnalysisJob(jobId);
  if (!job) throw new Error('Analysis job not found.');

  const mediaRow = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(job.mediaId) as
    | Record<string, unknown>
    | undefined;
  if (!mediaRow) throw new Error('Media asset not found.');

  const prevAnalysis = JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis;
  const filePath = mediaRow.file_path as string;
  const meta = await inspectMediaStreams(filePath);

  updateAnalysisJobRow(jobId, {
    status: 'transcribing',
    transcriptionStatus: 'running',
    error: undefined,
  });

  const chunkStats = await processChunksForJob(jobId, {
    ...options,
    languageOverride: options.languageOverride ?? job.languageOverride ?? prevAnalysis.selectedLanguageOverride,
    vocabulary: options.vocabulary ?? prevAnalysis.vocabulary,
  });
  return finalizeTranscriptionOutputs({
    jobId,
    mediaId: job.mediaId,
    projectId: job.projectId,
    filePath,
    filename: mediaRow.filename as string,
    meta,
    selectedStream: job.selectedAudioStream,
    languageOverride: options.languageOverride ?? job.languageOverride ?? prevAnalysis.selectedLanguageOverride,
    vocabulary: options.vocabulary ?? prevAnalysis.vocabulary,
    thumbnailUrl: (mediaRow.thumbnail_url as string) || '',
    scenes: prevAnalysis.scenes || [],
    silences: prevAnalysis.silences || [],
    waveformPeaks: prevAnalysis.waveformPeaks || [],
    chunkStats,
  });
}

export function resumeIncompleteAnalysisJobs() {
  const rows = db
    .prepare(
      `SELECT id FROM analysis_jobs
       WHERE status IN ('queued', 'extracting-audio', 'transcribing', 'aligning', 'generating-captions')`,
    )
    .all() as Array<{ id: string }>;

  for (const r of rows) {
    if (!activeJobPromises.has(r.id)) {
      const p = enqueueAnalysis(r.id)
        .catch((err) => {
          if (!isJobCancelled(r.id)) updateAnalysisJobRow(r.id,{status:'failed',transcriptionStatus:'failed',error:String(err).slice(0,260)});
          console.warn(`[transcriber] Resume job ${r.id} failed:`, err instanceof Error ? err.message : err);
          return null as unknown as MediaAnalysis;
        })
        .finally(() => {
          activeJobPromises.delete(r.id);
        });
      activeJobPromises.set(r.id, p);
    }
  }
}

/**
 * Awaited wrapper preserving clean direct analysis for reanalyze / synchronous tests.
 */
export async function analyzeUploadedOrRecordedMedia(params: {
  mediaId: string;
  filePath: string;
  filename: string;
  mimeType: string;
  projectId?: string | null;
  audioStreamIndex?: number;
  options?: ChunkWorkerOptions;
}): Promise<{ analysis: MediaAnalysis; thumbnailUrl: string; jobId: string }> {
  const { mediaId, filePath, filename, audioStreamIndex = 0, projectId = null, options } = params;
  const existingAsset = db.prepare('SELECT id FROM media_assets WHERE id = ?').get(mediaId);
  const { analysis: initialAnalysis, thumbnailUrl } = await prepareFastMediaRecord({
    mediaId,
    filePath,
    filename,
    audioStreamIndex,
  });

  if (!existingAsset) {
    // Callers using analyzeUploadedOrRecordedMedia standalone without pre-inserting media_assets can still wait;
    // when called via ingest/reanalyze, media_assets row is already present.
    throw new Error('media_assets row must exist before starting background analysis job.');
  }

  void initialAnalysis;
  const { job, promise } = startBackgroundAnalysisJob({
    mediaId,
    projectId,
    audioStreamIndex,
    options,
  });
  const finalAnalysis = await promise;
  return { analysis: finalAnalysis, thumbnailUrl, jobId: job.id };
}

