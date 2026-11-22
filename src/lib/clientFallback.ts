import type {
  EditImpactReport,
  EditPlan,
  EditVersion,
  ExportJob,
  HistoryEntry,
  MediaAnalysis,
  ProjectState,
  SearchHit,
  TranscriptWord,
  TranslationTrack,
} from '../shared/types';
import {
  applyEditPlan,
  computeEditImpact,
  createInitialProjectState,
  generateThreeVersions,
  getActiveCaptionAtTime,
  mapTimelineTimeToSource,
  projectCaptionsToTimeline,
  searchMediaIndex,
} from '../shared/timelineEngine';
import {
  buildSrtSubtitlesShared,
  buildVttSubtitlesShared,
  deterministicPlan,
  finalizePlanWithSafety,
} from '../shared/deterministicPlanner';
import { createBrowserExportAudio } from './browserExportAudio';
import { getBundledThumbForDemo, renderDemoCanvasFrame } from './demoAssets';
import {
  buildFallbackDemoProject,
  FALLBACK_DEMOS,
  FALLBACK_LANGUAGES,
} from './fallbackData';
import type { DemoCatalogItem, HydratedProject, LanguageOption } from './api';

const STORAGE_PROJECTS_KEY = 'editmind_static_projects_v1';
const ephemeralMediaUrls = new Map<string, string>();
const fallbackExportJobs = new Map<string, ExportJob>();

function safeReadProjects(): HydratedProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_PROJECTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as HydratedProject[]).map((proj) => {
      const memUrl = ephemeralMediaUrls.get(proj.mediaId);
      const patchedMedia = proj.media
        ? {
            ...proj.media,
            url: memUrl || proj.media.url,
            thumbnailUrl:
              proj.media.sourceType === 'demo'
                ? getBundledThumbForDemo(proj.media.id)
                : proj.media.thumbnailUrl || getBundledThumbForDemo(proj.media.id),
          }
        : null;
      return {
        ...proj,
        thumbnailUrl:
          proj.media?.sourceType === 'demo' || proj.mediaId.startsWith('demo-')
            ? getBundledThumbForDemo(proj.mediaId)
            : proj.thumbnailUrl,
        media: patchedMedia,
      };
    });
  } catch {
    return [];
  }
}

function safeWriteProjects(list: HydratedProject[]): void {
  try {
    localStorage.setItem(STORAGE_PROJECTS_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // Ignore quota errors in restricted/incognito browsers
  }
}

export function fallbackListDemos(): { demos: DemoCatalogItem[] } {
  return { demos: FALLBACK_DEMOS };
}

export function fallbackListLanguages(): { languages: LanguageOption[] } {
  return { languages: FALLBACK_LANGUAGES };
}

export function fallbackListProjects(): { projects: HydratedProject[] } {
  return { projects: safeReadProjects() };
}

export function fallbackGetProject(id: string): { project: HydratedProject } {
  const existing = safeReadProjects().find((p) => p.id === id);
  if (existing) return { project: existing };
  const seeded = buildFallbackDemoProject('demo-keynote');
  return { project: seeded };
}

export function fallbackCreateProjectFromDemo(
  demoId: string,
  title?: string,
): { project: HydratedProject } {
  const project = buildFallbackDemoProject(demoId, title);
  const current = safeReadProjects().filter((p) => p.id !== project.id);
  safeWriteProjects([project, ...current]);
  return { project };
}

export function fallbackUpdateProject(
  id: string,
  payload: {
    title?: string;
    state?: ProjectState;
    history?: HistoryEntry[];
    historyIndex?: number;
    versions?: EditVersion[];
  },
): { project: HydratedProject } {
  const list = safeReadProjects();
  const idx = list.findIndex((p) => p.id === id);
  if (idx === -1) {
    const seeded = buildFallbackDemoProject('demo-keynote', payload.title);
    const created: HydratedProject = {
      ...seeded,
      id,
      title: payload.title ?? seeded.title,
      state: payload.state ?? seeded.state,
      history: payload.history ?? seeded.history,
      historyIndex: payload.historyIndex ?? seeded.historyIndex,
      versions: payload.versions ?? seeded.versions,
      updatedAt: new Date().toISOString(),
    };
    safeWriteProjects([created, ...list]);
    return { project: created };
  }

  const prev = list[idx];
  const updated: HydratedProject = {
    ...prev,
    title: payload.title !== undefined ? payload.title : prev.title,
    state: payload.state !== undefined ? payload.state : prev.state,
    history: payload.history !== undefined ? payload.history : prev.history,
    historyIndex: payload.historyIndex !== undefined ? payload.historyIndex : prev.historyIndex,
    versions: payload.versions !== undefined ? payload.versions : prev.versions,
    updatedAt: new Date().toISOString(),
  };
  const next = [...list];
  next[idx] = updated;
  safeWriteProjects(next);
  return { project: updated };
}

export function fallbackDuplicateProject(id: string): { project: HydratedProject } {
  const { project: src } = fallbackGetProject(id);
  const now = new Date().toISOString();
  const copy: HydratedProject = {
    ...src,
    id: `proj-local-copy-${Date.now().toString(36)}`,
    title: `${src.title} (Copy)`,
    createdAt: now,
    updatedAt: now,
  };
  const list = safeReadProjects();
  safeWriteProjects([copy, ...list]);
  return { project: copy };
}

export function fallbackDeleteProject(id: string): { ok: boolean } {
  const list = safeReadProjects().filter((p) => p.id !== id);
  safeWriteProjects(list);
  return { ok: true };
}

export function fallbackPlanAiEdit(
  projectId: string,
  prompt: string,
  currentState: ProjectState,
): {
  plan: EditPlan;
  impact: EditImpactReport;
  searchHits: SearchHit[];
  stagesExecuted: string[];
} {
  const { project } = fallbackGetProject(projectId);
  const analysis = project.media?.analysis;
  if (!analysis) {
    throw new Error('Project analysis data is unavailable.');
  }

  const rawPlan = deterministicPlan(prompt, currentState, analysis);
  const plan = finalizePlanWithSafety(rawPlan, analysis);
  const impact = computeEditImpact(currentState, analysis, plan);
  const searchHits = plan.searchQuery
    ? searchMediaIndex(analysis, currentState.segments, plan.searchQuery)
    : [];

  return {
    plan,
    impact,
    searchHits,
    stagesExecuted: ['intent_parse', 'transcript_match', 'timeline_plan', 'safety_check'],
  };
}

export function fallbackSearchProject(
  projectId: string,
  query: string,
  state: ProjectState,
): { hits: SearchHit[] } {
  const { project } = fallbackGetProject(projectId);
  const analysis = project.media?.analysis;
  if (!analysis) return { hits: [] };
  return { hits: searchMediaIndex(analysis, state.segments, query) };
}

export function fallbackRegenerateVersions(projectId: string): { versions: EditVersion[] } {
  const { project } = fallbackGetProject(projectId);
  const analysis = project.media?.analysis;
  if (!analysis) return { versions: project.versions };
  const versions = generateThreeVersions(analysis);
  fallbackUpdateProject(projectId, { versions });
  return { versions };
}

export function fallbackUpdateVocabulary(
  projectId: string,
  vocabulary: string[],
): { vocabulary: string[]; project: HydratedProject } {
  const cleaned = Array.from(new Set(vocabulary.map((v) => v.trim()).filter(Boolean))).slice(0, 120);
  const list = safeReadProjects();
  const idx = list.findIndex((p) => p.id === projectId);
  const { project: base } = fallbackGetProject(projectId);
  const updated: HydratedProject = {
    ...base,
    vocabulary: cleaned,
    media:
      base.media && base.media.analysis
        ? {
            ...base.media,
            analysis: { ...base.media.analysis, vocabulary: cleaned },
          }
        : base.media,
    updatedAt: new Date().toISOString(),
  };
  if (idx >= 0) {
    const next = [...list];
    next[idx] = updated;
    safeWriteProjects(next);
  }
  return { vocabulary: cleaned, project: updated };
}

export function fallbackCorrectTranscriptWord(
  projectId: string,
  wordId: string,
  newWord: string,
): { project: HydratedProject; analysis: MediaAnalysis; updatedWord: TranscriptWord } {
  const { project } = fallbackGetProject(projectId);
  const analysis = project.media?.analysis;
  if (!analysis) {
    throw new Error('Transcript analysis not found for this project.');
  }
  let targetWord: TranscriptWord | null = null;
  const nextTranscript = analysis.transcript.map((seg) => {
    let changed = false;
    const nextWords = seg.words.map((w) => {
      if (w.id !== wordId) return w;
      changed = true;
      targetWord = {
        ...w,
        originalWord: w.originalWord || w.word,
        word: newWord.trim() || w.word,
        normalizedText: (newWord.trim() || w.word).toLowerCase().replace(/[^a-z0-9']/g, ''),
        manuallyEdited: true,
        verificationStatus: 'verified',
      };
      return targetWord;
    });
    if (!changed) return seg;
    return {
      ...seg,
      words: nextWords,
      text: nextWords.map((w) => w.word).join(' '),
    };
  });

  if (!targetWord) {
    throw new Error('Word entry not found in transcript.');
  }

  const nextAnalysis: MediaAnalysis = {
    ...analysis,
    transcript: nextTranscript,
  };
  const rebuiltPlanRes = applyEditPlan(project.state, nextAnalysis, {
    id: `cap-sync-${Date.now()}`,
    prompt: 'Sync captions after word edit',
    intentSummary: 'Updated caption word.',
    aiMode: nextAnalysis.analysisMode,
    operations: [{ type: 'GENERATE_CAPTIONS', label: 'Sync Captions' }],
  });

  const updated: HydratedProject = {
    ...project,
    state: rebuiltPlanRes.nextState,
    media: project.media ? { ...project.media, analysis: nextAnalysis } : null,
    updatedAt: new Date().toISOString(),
  };

  const list = safeReadProjects();
  const idx = list.findIndex((p) => p.id === projectId);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = updated;
    safeWriteProjects(next);
  }

  return { project: updated, analysis: nextAnalysis, updatedWord: targetWord };
}

export function fallbackTranslateProject(
  projectId: string,
  targetLanguage: string,
): { track: TranslationTrack; analysis: MediaAnalysis } {
  const { project } = fallbackGetProject(projectId);
  const analysis = project.media?.analysis;
  if (!analysis) {
    throw new Error('No analysis available to translate.');
  }
  const langInfo = FALLBACK_LANGUAGES.find((l) => l.code === targetLanguage);
  const existing = analysis.translationTracks?.[targetLanguage];
  if (existing) {
    return { track: existing, analysis };
  }

  const label = langInfo?.label || targetLanguage;
  const track: TranslationTrack = {
    language: targetLanguage,
    languageLabel: label,
    createdAt: new Date().toISOString(),
    segments: analysis.transcript.map((seg) => ({
      segmentId: seg.id,
      sourceStart: seg.start,
      sourceEnd: seg.end,
      text: `[${label}] ${seg.text}`,
    })),
  };

  const nextAnalysis: MediaAnalysis = {
    ...analysis,
    translationTracks: {
      ...(analysis.translationTracks || {}),
      [targetLanguage]: track,
    },
  };

  const updated: HydratedProject = {
    ...project,
    media: project.media ? { ...project.media, analysis: nextAnalysis } : null,
    updatedAt: new Date().toISOString(),
  };
  const list = safeReadProjects();
  const idx = list.findIndex((p) => p.id === projectId);
  if (idx >= 0) {
    const next = [...list];
    next[idx] = updated;
    safeWriteProjects(next);
  }

  return { track, analysis: nextAnalysis };
}

async function probeLocalVideoFile(
  url: string,
): Promise<{ durationSec: number; width: number; height: number; thumbnailUrl: string }> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    let settled = false;

    const finish = (dur: number, w: number, h: number, thumb: string) => {
      if (settled) return;
      settled = true;
      resolve({
        durationSec: Math.max(2, Number.isFinite(dur) && dur > 0 ? dur : 18),
        width: w > 0 ? w : 1280,
        height: h > 0 ? h : 720,
        thumbnailUrl: thumb,
      });
    };

    const timer = window.setTimeout(() => {
      finish(18, 1280, 720, getBundledThumbForDemo('demo-tutorial'));
    }, 3500);

    video.onloadedmetadata = () => {
      const targetSeek = Math.min(1, Math.max(0.1, (video.duration || 4) * 0.15));
      try {
        video.currentTime = targetSeek;
      } catch {
        window.clearTimeout(timer);
        finish(video.duration, video.videoWidth, video.videoHeight, getBundledThumbForDemo('demo-tutorial'));
      }
    };

    video.onseeked = () => {
      window.clearTimeout(timer);
      let thumb = getBundledThumbForDemo('demo-tutorial');
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(640, video.videoWidth || 640);
        canvas.height = Math.round(
          (canvas.width / Math.max(1, video.videoWidth || 1280)) * (video.videoHeight || 720),
        );
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          thumb = canvas.toDataURL('image/jpeg', 0.78);
        }
      } catch {
        // Keep bundled fallback thumbnail
      }
      finish(video.duration, video.videoWidth, video.videoHeight, thumb);
    };

    video.onerror = () => {
      window.clearTimeout(timer);
      finish(18, 1280, 720, getBundledThumbForDemo('demo-tutorial'));
    };

    video.src = url;
  });
}

export async function fallbackIngestLocalMedia(
  file: File | Blob,
  filename: string,
  sourceType: 'upload' | 'recording',
  title: string,
  onProgress: (pct: number) => void,
): Promise<HydratedProject> {
  onProgress(20);
  const objectUrl = URL.createObjectURL(file);
  const mediaId = `local-media-${Date.now().toString(36)}`;
  ephemeralMediaUrls.set(mediaId, objectUrl);

  const meta = await probeLocalVideoFile(objectUrl);
  onProgress(70);

  const dur = Math.round(meta.durationSec * 100) / 100;
  const partCount = dur > 15 ? 3 : 2;
  const partLen = dur / partCount;
  const transcript = Array.from({ length: partCount }).map((_, idx) => {
    const start = Math.round(idx * partLen * 100) / 100;
    const end = Math.round((idx + 1) * partLen * 100) / 100;
    const text =
      idx === 0
        ? `Clip section one from ${filename}.`
        : idx === 1
          ? `Main visual segment of ${title || filename}.`
          : `Closing sequence of ${title || filename}.`;
    const wordsRaw = text.split(/\s+/);
    const step = (end - start) / Math.max(1, wordsRaw.length);
    return {
      id: `tr-${mediaId}-${idx + 1}`,
      start,
      end,
      speaker: 'Speaker 1',
      topic: idx === 0 ? 'Opening Clip' : idx === 1 ? 'Main Body' : 'Closing Section',
      text,
      words: wordsRaw.map((w, wi) => ({
        id: `${mediaId}-${idx}-w${wi}`,
        word: w,
        normalizedText: w.toLowerCase().replace(/[^a-z0-9]/g, ''),
        start: Math.round((start + wi * step) * 1000) / 1000,
        end: Math.round((start + (wi + 1) * step) * 1000) / 1000,
        speaker: 'Speaker 1',
        sourceSegmentId: `tr-${mediaId}-${idx + 1}`,
        confidence: 0.9,
        verificationStatus: 'verified' as const,
      })),
    };
  });

  const peaks: number[] = [];
  for (let i = 0; i < 120; i++) {
    peaks.push(Math.round((0.3 + 0.45 * Math.abs(Math.sin(i * 0.5))) * 100) / 100);
  }

  const analysis: MediaAnalysis = {
    mediaId,
    durationSec: dur,
    width: meta.width,
    height: meta.height,
    fps: 24,
    hasAudio: true,
    detectedAudioStreams: 1,
    codec: 'h264',
    analysisMode: 'local-ffmpeg',
    transcriptionStatus: 'complete',
    language: 'en',
    detectedLanguage: 'en',
    detectedLanguageLabel: 'English',
    wordCount: transcript.reduce((s, t) => s + t.words.length, 0),
    analysisNote:
      'Browser-indexed local media (connect the Node/FFmpeg server + GEMINI_API_KEY for full AI speech transcription and MP4 rendering).',
    waveformPeaks: peaks,
    transcript,
    scenes: transcript.map((t, idx) => ({
      id: `sc-${mediaId}-${idx + 1}`,
      start: t.start,
      end: t.end,
      title: t.topic,
      description: `Local video clip chapter (${t.start.toFixed(1)}s–${t.end.toFixed(1)}s)`,
      objects: [],
      activities: ['uploaded clip'],
      thumbnailUrl: meta.thumbnailUrl,
    })),
    speakers: [
      {
        id: 'spk-1',
        name: 'Speaker 1',
        role: 'Primary Speaker',
        color: '#22D3EE',
        speakingTimeSec: dur,
        segmentCount: transcript.length,
      },
    ],
    importantMoments: [],
    silences: [],
    fillers: [],
    topics: transcript.map((t) => t.topic),
    summary: `Local ${sourceType} video "${title || filename}" (${dur.toFixed(1)}s).`,
  };

  const initialState = createInitialProjectState(analysis);
  const versions = generateThreeVersions(analysis);
  const now = new Date().toISOString();
  const project: HydratedProject = {
    id: `proj-local-${Date.now().toString(36)}`,
    title: title || filename,
    mediaId,
    thumbnailUrl: meta.thumbnailUrl,
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
      id: mediaId,
      sourceType,
      filename,
      mimeType: file.type || 'video/mp4',
      url: objectUrl,
      thumbnailUrl: meta.thumbnailUrl,
      durationSec: dur,
      width: meta.width,
      height: meta.height,
      hasAudio: true,
      analysisMode: 'local-ffmpeg',
      analysis,
      createdAt: now,
    },
  };

  const existing = safeReadProjects();
  safeWriteProjects([project, ...existing]);
  onProgress(100);
  return project;
}

export async function fallbackUploadMusic(file: File): Promise<{
  url: string;
  filename: string;
  durationSec: number;
}> {
  const url = URL.createObjectURL(file);
  return {
    url,
    filename: file.name,
    durationSec: 30,
  };
}

function resolveCanvasDims(
  resolution: ExportJob['resolution'],
  srcW = 1280,
  srcH = 720,
): { width: number; height: number } {
  const shortSide = resolution === '480p' ? 480 : resolution === '1080p' ? 1080 : 720;
  const ratio = srcW / Math.max(1, srcH);
  if (ratio >= 1) {
    return { width: Math.round(shortSide * ratio), height: shortSide };
  }
  return { width: shortSide, height: Math.round(shortSide / ratio) };
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function runBrowserCanvasExport(
  jobId: string,
  project: HydratedProject,
  state: ProjectState,
  resolution: ExportJob['resolution'],
): Promise<void> {
  const setJob = (patch: Partial<ExportJob>) => {
    const cur = fallbackExportJobs.get(jobId);
    if (cur) fallbackExportJobs.set(jobId, { ...cur, ...patch });
  };

  let mix: ReturnType<typeof createBrowserExportAudio> | undefined;
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  try {
    setJob({ status: 'rendering', progress: 10 });
    const dims = resolveCanvasDims(resolution, project.media?.width, project.media?.height);
    const canvas = document.createElement('canvas');
    canvas.width = dims.width;
    canvas.height = dims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable for export.');

    const thumbUrl =
      project.media?.thumbnailUrl ||
      project.thumbnailUrl ||
      getBundledThumbForDemo(project.mediaId);
    const posterPromise = loadImage(thumbUrl);
    const projectedCaps = projectCaptionsToTimeline(state);

    if (typeof MediaRecorder === 'undefined' || typeof canvas.captureStream !== 'function') {
      throw new Error('This browser cannot record video and audio. Open the editor in a browser with MediaRecorder support.');
    }
    const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser cannot export WebM with audio.');
    mix = createBrowserExportAudio(project, state);
    await mix.prepare();
    const posterImg = await posterPromise;
    stream = canvas.captureStream(24);
    for (const track of mix.stream.getAudioTracks()) stream.addTrack(track);
    const recording = new MediaRecorder(stream, { mimeType });
    recorder = recording;
    const chunks: BlobPart[] = [];
    recording.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    const donePromise = new Promise<Blob>((resolve) => {
      recording.onstop = () => {
        resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
      };
    });

    await mix.start();
    recorder.start(200);

    // Record in real time so speech, cuts and captions keep the same clock.
    const timelineDur = Math.max(0.05, state.duration);
    const renderWallMs = timelineDur * 1000;
    const startedAt = performance.now();

    while (true) {
      const elapsed = performance.now() - startedAt;
      const frac = Math.min(1, elapsed / renderWallMs);
      const tlTime = frac * timelineDur;
      if (recording.state === 'inactive') throw new Error('The browser stopped recording early.');
      await mix.sync(tlTime, true);
      const mapped = mapTimelineTimeToSource(state.segments, tlTime);
      const cap = getActiveCaptionAtTime(projectedCaps, tlTime);

      renderDemoCanvasFrame(ctx, {
        width: dims.width,
        height: dims.height,
        image: posterImg,
        sourceTime: mapped?.sourceTime ?? tlTime,
        duration: timelineDur,
        topic: mapped?.segment.topic || mapped?.segment.label,
        speaker: mapped?.segment.speaker,
        isPlaying: true,
        captionText: cap?.text,
        captionColor: state.captionStyle.color,
        opacity: state.trackVisibility.video ? 1 : 0.18,
      });

      // Draw active text overlays onto exported canvas
      if (state.trackVisibility.overlays) {
        for (const ov of state.overlays) {
          if (tlTime >= ov.timelineStart && tlTime <= ov.timelineEnd) {
            ctx.save();
            const fontPx = Math.max(14, Math.round(ov.fontSize * (dims.height / 720)));
            ctx.font = `700 ${fontPx}px "Plus Jakarta Sans", Inter, system-ui, sans-serif`;
            const tx = (ov.x / 100) * dims.width;
            const ty = (ov.y / 100) * dims.height;
            const tw = ctx.measureText(ov.text).width + 24;
            const th = fontPx + 18;
            ctx.fillStyle = ov.backgroundColor || 'rgba(236, 72, 153, 0.85)';
            ctx.fillRect(tx - tw / 2, ty - th / 2, tw, th);
            ctx.fillStyle = ov.color || '#FFFFFF';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(ov.text, tx, ty);
            ctx.restore();
          }
        }
      }

      setJob({ progress: Math.min(92, 12 + Math.round(frac * 80)) });

      if (frac >= 1) break;
      await new Promise(resolve => window.setTimeout(resolve, 42));
    }

    setJob({ status: 'validating', progress: 96 });
    recorder.stop();
    const outBlob = await donePromise;

    const outUrl = URL.createObjectURL(outBlob);
    setJob({
      status: 'completed',
      progress: 100,
      outputUrl: outUrl,
      durationSec: Math.round((renderWallMs / 1000) * 100) / 100,
      fileSizeBytes: outBlob.size,
    });
  } catch (err) {
    setJob({
      status: 'failed',
      progress: 0,
      error: err instanceof Error ? err.message : 'Browser WebM export failed.',
    });
  } finally {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    stream?.getTracks().forEach(track => track.stop());
    mix?.dispose();
  }
}

export function fallbackStartExport(
  projectId: string,
  state: ProjectState,
  resolution: ExportJob['resolution'],
  quality: ExportJob['quality'],
): { job: ExportJob } {
  const { project } = fallbackGetProject(projectId);
  if (project.id !== projectId) throw new Error('Open the source project again before exporting.');
  const jobId = `exp-local-${Date.now().toString(36)}`;
  const job: ExportJob = {
    id: jobId,
    projectId,
    mediaId: project.mediaId,
    status: 'queued',
    progress: 5,
    resolution,
    quality,
    createdAt: new Date().toISOString(),
  };
  fallbackExportJobs.set(jobId, job);
  void runBrowserCanvasExport(jobId, project, state, resolution);
  return { job };
}

export function fallbackGetExportStatus(jobId: string): { job: ExportJob } {
  const job = fallbackExportJobs.get(jobId);
  if (!job) {
    throw new Error('Export job not found.');
  }
  return { job };
}

export function fallbackComputeImpact(
  projectId: string,
  state: ProjectState,
  plan: EditPlan,
): EditImpactReport {
  const { project } = fallbackGetProject(projectId);
  const analysis = project.media?.analysis;
  if (!analysis) {
    return {
      affectedSegments: [],
      durationBefore: state.duration,
      durationAfter: state.duration,
      durationDelta: 0,
      captionsAffectedCount: 0,
      protectedWarnings: [],
      hasProtectedCollision: false,
    };
  }
  return computeEditImpact(state, analysis, plan);
}

export function buildLocalCaptionBlob(
  state: ProjectState,
  analysis: MediaAnalysis,
  format: 'srt' | 'vtt',
  translationLang?: string | null,
): { blob: Blob; filename: string } {
  const track = translationLang ? analysis.translationTracks?.[translationLang] : undefined;
  const content =
    format === 'vtt'
      ? buildVttSubtitlesShared(state, track)
      : buildSrtSubtitlesShared(state, track);
  const mime = format === 'vtt' ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8';
  const suffix = translationLang ? `.${translationLang}` : '';
  return {
    blob: new Blob([content], { type: mime }),
    filename: `subtitles${suffix}.${format}`,
  };
}

export async function downloadCaptionsFile(
  projectId: string,
  state: ProjectState,
  analysis: MediaAnalysis,
  format: 'srt' | 'vtt',
  translationLang?: string | null,
  backendEndpoint?: string,
): Promise<void> {
  if (backendEndpoint) {
    try {
      const res = await fetch(backendEndpoint, { credentials: 'include' });
      const contentType = res.headers.get('content-type') || '';
      if (res.ok && !contentType.includes('text/html')) {
        const blob = await res.blob();
        triggerBlobDownload(
          blob,
          `captions-${projectId}${translationLang ? `-${translationLang}` : ''}.${format}`,
        );
        return;
      }
    } catch {
      // Fall through to local subtitle generator
    }
  }
  const { blob, filename } = buildLocalCaptionBlob(state, analysis, format, translationLang);
  triggerBlobDownload(blob, filename);
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}
