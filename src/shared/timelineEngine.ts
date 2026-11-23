import type {
  CaptionEntry,
  CaptionStyle,
  EditImpactReport,
  EditOperation,
  EditPlan,
  EditVersion,
  ImportantMoment,
  MediaAnalysis,
  ProjectState,
  SearchHit,
  TimelineSegment,
} from './types';

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontFamily: 'Plus Jakarta Sans',
  fontSize: 22,
  color: '#FFFFFF',
  backgroundColor: 'rgba(5, 7, 17, 0.78)',
  backgroundOpacity: 0.78,
  position: 'bottom',
  mode: 'sentence',
  highlightActiveWord: true,
  highlightColor: '#22D3EE',
};

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

let segCounter = 1;
export function nextSegmentId(prefix = 'seg'): string {
  segCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${segCounter}`;
}

export function recalculateTimeline(segments: TimelineSegment[]): {
  segments: TimelineSegment[];
  duration: number;
} {
  let cursor = 0;
  const recalculated: TimelineSegment[] = [];
  for (const seg of segments) {
    const srcDuration = seg.sourceEnd - seg.sourceStart;
    if (srcDuration <= 0) continue;
    const speed = Math.min(4, Math.max(0.25, seg.speed || 1));
    const tlDuration = srcDuration / speed;
    const next: TimelineSegment = {
      ...seg,
      speed,
      sourceStart: round3(seg.sourceStart),
      sourceEnd: round3(seg.sourceEnd),
      timelineStart: round3(cursor),
      timelineEnd: round3(cursor + tlDuration),
    };
    recalculated.push(next);
    cursor += tlDuration;
  }
  return {
    segments: recalculated,
    duration: round3(cursor),
  };
}

export function buildCaptionsFromAnalysis(analysis: MediaAnalysis): CaptionEntry[] {
  const spkIdByName = new Map(analysis.speakers.map((s) => [s.name, s.id]));
  return analysis.transcript.map((t, idx) => ({
    id: `cap-${idx + 1}`,
    sourceSegmentId: t.id,
    speakerId: spkIdByName.get(t.speaker),
    sourceStart: t.start,
    sourceEnd: t.end,
    text: t.text,
    speaker: t.speaker,
    words: t.words,
    visible: true,
  }));
}

export function createInitialProjectState(analysis: MediaAnalysis): ProjectState {
  // Boundary words from adjacent ASR chunks can arrive out of order or at
  // the same timestamp. The unedited timeline must cover each second once.
  const transcript = analysis.transcript.filter(t => t.start >= 0 && t.start < analysis.durationSec)
    .slice().sort((a, b) => a.start - b.start);
  const scenes = analysis.scenes.filter(s => s.start >= 0 && s.start < analysis.durationSec)
    .slice().sort((a, b) => a.start - b.start);
  const initialSegments: TimelineSegment[] =
    transcript.length > 0
      ? transcript.map((t, idx) => {
          const matchedScene = analysis.scenes.find(
            (sc) => Math.min(sc.end, t.end) - Math.max(sc.start, t.start) > 0.15,
          );
          return {
            id: `seg-init-${idx + 1}`,
            sourceSegmentId: t.id,
            sourceStart: idx === 0 ? 0 : t.start,
            sourceEnd: transcript[idx + 1]?.start ?? analysis.durationSec,
            timelineStart: t.start,
            timelineEnd: t.end,
            speed: 1,
            volume: 1,
            muted: false,
            label: t.topic || `Segment ${idx + 1}`,
            topic: t.topic,
            speaker: t.speaker,
            thumbnailUrl: matchedScene?.thumbnailUrl || analysis.scenes[0]?.thumbnailUrl,
            transition: 'none',
            crop: null,
            locked: false,
          };
        })
      : scenes.length > 1
        ? scenes.map((sc, idx) => ({
            id: `seg-sc-${idx + 1}`,
            sourceSegmentId: sc.id,
            sourceStart: idx ? sc.start : 0,
            sourceEnd: scenes[idx+1]?.start ?? analysis.durationSec,
            timelineStart: sc.start,
            timelineEnd: sc.end,
            speed: 1,
            volume: 1,
            muted: false,
            label: sc.title || `Scene ${idx + 1}`,
            thumbnailUrl: sc.thumbnailUrl,
            transition: 'none',
            crop: null,
            locked: false,
          }))
        : [
            {
              id: 'seg-init-1',
              sourceSegmentId: 'src-full',
              sourceStart: 0,
              sourceEnd: analysis.durationSec,
              timelineStart: 0,
              timelineEnd: analysis.durationSec,
              speed: 1,
              volume: 1,
              muted: false,
              label: 'Full Source Clip',
              thumbnailUrl: analysis.scenes[0]?.thumbnailUrl,
              transition: 'none',
              crop: null,
              locked: false,
            },
          ];

  const { segments, duration } = recalculateTimeline(initialSegments);
  const captions = buildCaptionsFromAnalysis(analysis);

  return {
    mediaId: analysis.mediaId,
    segments,
    duration,
    captionsEnabled: captions.length > 0,
    captionStyle: { ...DEFAULT_CAPTION_STYLE },
    captions,
    overlays: [],
    bleeps: [],
    muteRanges: [],
    audio: {
      masterVolume: 1,
      muted: false,
      noiseReduction: false,
      fadeInSec: 0,
      fadeOutSec: 0,
      musicEnabled: false,
      musicPreset: 'ambient-pulse',
      musicVolume: 0.22,
      musicFadeInSec: 1.5,
      musicFadeOutSec: 2,
      musicStartOffsetSec: 0,
      audioTrackLocked: false,
    },
    trackVisibility: {
      video: true,
      audio: true,
      captions: true,
      overlays: true,
      music: true,
    },
    trackLocks: {
      video: false,
      audio: false,
      captions: false,
      overlays: false,
      music: false,
    },
    protectedMomentIds: analysis.importantMoments.filter((m) => m.protected).map((m) => m.id),
  };
}

export function mapSourceTimeToTimeline(
  segments: TimelineSegment[],
  sourceTime: number,
): number | null {
  for (const seg of segments) {
    if (sourceTime >= seg.sourceStart - 0.001 && sourceTime <= seg.sourceEnd + 0.001) {
      const clamped = Math.min(seg.sourceEnd, Math.max(seg.sourceStart, sourceTime));
      const offset = (clamped - seg.sourceStart) / (seg.speed || 1);
      return round3(seg.timelineStart + offset);
    }
  }
  return null;
}

export function mapSourceRangeToTimeline(
  segments: TimelineSegment[],
  sourceStart: number,
  sourceEnd: number,
): { timelineStart: number; timelineEnd: number } | null {
  for (const seg of segments) {
    const overlapStart = Math.max(seg.sourceStart, sourceStart);
    const overlapEnd = Math.min(seg.sourceEnd, sourceEnd);
    if (overlapEnd - overlapStart > 0.04) {
      const tlStart = seg.timelineStart + (overlapStart - seg.sourceStart) / (seg.speed || 1);
      const tlEnd = seg.timelineStart + (overlapEnd - seg.sourceStart) / (seg.speed || 1);
      return {
        timelineStart: round3(tlStart),
        timelineEnd: round3(tlEnd),
      };
    }
  }
  return null;
}

export function mapTimelineTimeToSource(
  segments: TimelineSegment[],
  timelineTime: number,
): { segment: TimelineSegment; sourceTime: number } | null {
  if (segments.length === 0) return null;
  for (const seg of segments) {
    if (timelineTime >= seg.timelineStart && timelineTime < seg.timelineEnd) {
      const clamped = Math.min(seg.timelineEnd, Math.max(seg.timelineStart, timelineTime));
      const sourceTime = seg.sourceStart + (clamped - seg.timelineStart) * (seg.speed || 1);
      return {
        segment: seg,
        sourceTime: round3(Math.min(seg.sourceEnd, Math.max(seg.sourceStart, sourceTime))),
      };
    }
  }
  const last = segments[segments.length - 1];
  if (timelineTime >= last.timelineEnd) {
    return { segment: last, sourceTime: last.sourceEnd };
  }
  return { segment: segments[0], sourceTime: segments[0].sourceStart };
}

export interface ProjectedCaption {
  styleOverride?: Partial<CaptionStyle>;
  id: string;
  text: string;
  speaker?: string;
  timelineStart: number;
  timelineEnd: number;
  sourceStart: number;
  sourceEnd: number;
  words: Array<{
    id: string;
    word: string;
    timelineStart: number;
    timelineEnd: number;
  }>;
}

export function projectCaptionsToTimeline(state: ProjectState): ProjectedCaption[] {
  if (!state.captionsEnabled || !state.trackVisibility.captions) return [];
  const projected: ProjectedCaption[] = [];
  const isWordMode = state.captionStyle.mode === 'word';

  for (const seg of state.segments) {
    for (const cap of state.captions) {
      if (!cap.visible) continue;
      const overlapStart = Math.max(seg.sourceStart, cap.sourceStart);
      const overlapEnd = Math.min(seg.sourceEnd, cap.sourceEnd);
      if (overlapEnd - overlapStart <= 0.04) continue;

      const wordsInSeg = cap.words
        .filter((w) => w.end > overlapStart + 0.01 && w.start < overlapEnd - 0.01)
        .map((w) => {
          const ws = Math.max(overlapStart, w.start);
          const we = Math.min(overlapEnd, w.end);
          return {
            id: w.id,
            word: w.word,
            timelineStart: round3(seg.timelineStart + (ws - seg.sourceStart) / (seg.speed || 1)),
            timelineEnd: round3(seg.timelineStart + (we - seg.sourceStart) / (seg.speed || 1)),
            sourceStart: round3(ws),
            sourceEnd: round3(we),
          };
        });

      if (cap.words.length && !wordsInSeg.length) continue;
      if (isWordMode && !cap.customText && wordsInSeg.length > 0) {
        // Group into punchy 1-3 word blocks for crisp TikTok/Reels style word-level caption display
        const chunkSize = 2;
        for (let i = 0; i < wordsInSeg.length; i += chunkSize) {
          const chunk = wordsInSeg.slice(i, i + chunkSize);
          projected.push({
            id: `${cap.id}-${seg.id}-wc${i}`,
            styleOverride: cap.styleOverride,
            text: chunk.map((w) => w.word).join(' '),
            speaker: cap.speaker,
            timelineStart: chunk[0].timelineStart,
            timelineEnd: chunk[chunk.length - 1].timelineEnd,
            sourceStart: chunk[0].sourceStart,
            sourceEnd: chunk[chunk.length - 1].sourceEnd,
            words: chunk.map(({ id, word, timelineStart, timelineEnd }) => ({
              id,
              word,
              timelineStart,
              timelineEnd,
            })),
          });
        }
        continue;
      }

      const tlStart = seg.timelineStart + (overlapStart - seg.sourceStart) / (seg.speed || 1);
      const tlEnd = seg.timelineStart + (overlapEnd - seg.sourceStart) / (seg.speed || 1);

      const text =
        !cap.customText && cap.words.length > 0 && wordsInSeg.length > 0 && wordsInSeg.length < cap.words.length
          ? wordsInSeg.map((w) => w.word).join(' ')
          : cap.text;

      if (!text.trim()) continue;

      projected.push({
        id: `${cap.id}-${seg.id}`,
        styleOverride: cap.styleOverride,
        text,
        speaker: cap.speaker,
        timelineStart: round3(tlStart),
        timelineEnd: round3(tlEnd),
        sourceStart: round3(overlapStart),
        sourceEnd: round3(overlapEnd),
        words: (cap.customText ? [] : wordsInSeg).map(({ id, word, timelineStart, timelineEnd }) => ({
          id,
          word,
          timelineStart,
          timelineEnd,
        })),
      });
    }
  }

  // Keep the start anchored. Use the available reading gap after accelerated
  // speech, ending before the next caption or the end of the film.
  if (state.segments.some(s => s.speed > 1)) {
    const ordered = projected.slice().sort((a,b) => a.timelineStart - b.timelineStart);
    for (let i = 0; i < ordered.length; i++) {
      const cap = ordered[i];
      const naturalDuration = cap.sourceEnd - cap.sourceStart;
      const shown = cap.timelineEnd - cap.timelineStart;
      if (shown + .002 >= naturalDuration || shown >= .7) continue;
      cap.timelineEnd = round3(Math.max(cap.timelineEnd, Math.min(cap.timelineStart + .7,
        ordered[i + 1]?.timelineStart ?? state.duration, state.duration)));
    }
  }
  return projected;
}

export function getActiveCaptionAtTime(
  projectedCaptions: ProjectedCaption[],
  timelineTime: number,
): ProjectedCaption | null {
  for (const cap of projectedCaptions) {
    if (timelineTime >= cap.timelineStart && timelineTime <= cap.timelineEnd) {
      return cap;
    }
  }
  return null;
}

export function removeSourceRangeFromSegments(
  segments: TimelineSegment[],
  cutStart: number,
  cutEnd: number,
  options: { minRemainderSec?: number } = {},
): TimelineSegment[] {
  if (cutEnd <= cutStart) return segments;
  const minRem = options.minRemainderSec ?? 0.04;
  const next: TimelineSegment[] = [];

  for (const seg of segments) {
    if (seg.locked) {
      next.push(seg);
      continue;
    }
    // No overlap
    if (cutEnd <= seg.sourceStart + 0.015 || cutStart >= seg.sourceEnd - 0.015) {
      next.push(seg);
      continue;
    }
    // Full cover -> drop segment
    if (cutStart <= seg.sourceStart + 0.015 && cutEnd >= seg.sourceEnd - 0.015) {
      continue;
    }
    // Left part remains
    if (cutStart > seg.sourceStart + minRem) {
      next.push({
        ...seg,
        id: nextSegmentId('seg'),
        sourceEnd: round3(cutStart),
      });
    }
    // Right part remains
    if (cutEnd < seg.sourceEnd - minRem) {
      next.push({
        ...seg,
        id: nextSegmentId('seg'),
        sourceStart: round3(cutEnd),
      });
    }
  }

  return next;
}

export function validateEditPlan(
  analysis: MediaAnalysis,
  plan: EditPlan,
): { valid: boolean; reason?: string } {
  const maxDur = Math.max(0.5, analysis.durationSec);
  for (const op of plan.operations) {
    if (op.sourceStart !== undefined && op.sourceEnd !== undefined) {
      if (op.sourceStart < -0.01 || op.sourceEnd > maxDur + 0.1 || op.sourceEnd <= op.sourceStart) {
        return {
          valid: false,
          reason: `Rejected out-of-bounds edit interval (${op.sourceStart.toFixed(2)}s–${op.sourceEnd.toFixed(2)}s vs duration ${maxDur.toFixed(2)}s).`,
        };
      }
      const span = op.sourceEnd - op.sourceStart;
      if ((op.type === 'REMOVE_WORD' || op.targetScope === 'word') && span > 2.5) {
        return {
          valid: false,
          reason: `Safety validation rejected broad cut (${span.toFixed(2)}s) for single-word edit "${op.targetText || op.label}". Word edits cannot delete whole segments.`,
        };
      }
    }
    if ((op.type === 'REMOVE_WORD' || op.targetScope === 'word') && op.removeRanges) {
      for (const r of op.removeRanges) {
        if (r.end - r.start > 2.5) {
          return {
            valid: false,
            reason: `Safety validation rejected broad range (${(r.end - r.start).toFixed(2)}s) for word-level operation.`,
          };
        }
      }
    }
  }
  return { valid: true };
}

function removeWordFromCaptionEntries(
  captions: CaptionEntry[],
  cutStart: number,
  cutEnd: number,
  targetWord?: string,
): CaptionEntry[] {
  const targetClean = (targetWord || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return captions
    .map((cap) => {
      if (cap.sourceEnd <= cutStart + 0.01 || cap.sourceStart >= cutEnd - 0.01) {
        return cap;
      }
      const remainingWords = cap.words.filter((w) => {
        const overlaps = Math.min(w.end, cutEnd) - Math.max(w.start, cutStart) > 0.02;
        if (!overlaps) return true;
        if (!targetClean) return false;
        const wClean = w.word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        return wClean !== targetClean;
      });
      if (cap.customText) {
        // Preserve the author's wording whenever any spoken anchor survives.
        // A time-only caption has no spoken words to trim.
        return { ...cap, words: remainingWords, text: !cap.words.length || remainingWords.length ? cap.text : '' };
      }
      const escapedTarget = targetWord
        ? targetWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        : '';
      const nextText =
        remainingWords.length > 0
          ? remainingWords.map((w) => w.word).join(' ')
          : escapedTarget
            ? cap.text
                .replace(new RegExp(`(?<!\\p{L})${escapedTarget}(?!\\p{L})`, 'giu'), '')
                .replace(/\s{2,}/g, ' ')
                .trim()
            : '';
      return {
        ...cap,
        words: remainingWords,
        text: nextText,
      };
    })
    .filter((cap) => cap.text.trim().length > 0);
}

export function keepOnlySourceRanges(
  segments: TimelineSegment[],
  keepRanges: Array<{ start: number; end: number; label: string }>,
): TimelineSegment[] {
  const next: TimelineSegment[] = [];
  for (const range of keepRanges) {
    for (const seg of segments) {
      const os = Math.max(seg.sourceStart, range.start);
      const oe = Math.min(seg.sourceEnd, range.end);
      if (oe - os > 0.1) {
        next.push({
          ...seg,
          id: nextSegmentId('seg'),
          sourceStart: round3(os),
          sourceEnd: round3(oe),
          label: range.label || seg.label,
        });
      }
    }
  }
  return next;
}

export function splitSegmentAtTimelineTime(
  segments: TimelineSegment[],
  timelineTime: number,
): TimelineSegment[] {
  const mapped = mapTimelineTimeToSource(segments, timelineTime);
  if (!mapped) return segments;
  const { segment, sourceTime } = mapped;
  if (segment.locked) return segments;
  if (sourceTime - segment.sourceStart < 0.15 || segment.sourceEnd - sourceTime < 0.15) {
    return segments;
  }

  const next: TimelineSegment[] = [];
  for (const seg of segments) {
    if (seg.id !== segment.id) {
      next.push(seg);
      continue;
    }
    next.push({
      ...seg,
      id: nextSegmentId('seg'),
      sourceEnd: round3(sourceTime),
      label: `${seg.label} (Part A)`,
    });
    next.push({
      ...seg,
      id: nextSegmentId('seg'),
      sourceStart: round3(sourceTime),
      label: `${seg.label} (Part B)`,
    });
  }
  return recalculateTimeline(next).segments;
}

export function trimSegment(
  segments: TimelineSegment[],
  segmentId: string,
  newSourceStart: number,
  newSourceEnd: number,
): TimelineSegment[] {
  const next = segments.map((seg) => {
    if (seg.id !== segmentId || seg.locked) return seg;
    const clampedStart = Math.max(0, Math.min(newSourceStart, newSourceEnd - 0.2));
    const clampedEnd = Math.max(clampedStart + 0.2, newSourceEnd);
    return {
      ...seg,
      sourceStart: round3(clampedStart),
      sourceEnd: round3(clampedEnd),
    };
  });
  return recalculateTimeline(next).segments;
}

export function reorderSegments(
  segments: TimelineSegment[],
  fromIndex: number,
  toIndex: number,
): TimelineSegment[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= segments.length ||
    toIndex >= segments.length ||
    fromIndex === toIndex
  ) {
    return segments;
  }
  const copy = [...segments];
  const [moved] = copy.splice(fromIndex, 1);
  copy.splice(toIndex, 0, moved);
  return recalculateTimeline(copy).segments;
}

function getRemovedRangesForOperations(
  state: ProjectState,
  operations: EditOperation[],
): Array<{ start: number; end: number }> {
  const removed: Array<{ start: number; end: number }> = [];
  for (const op of operations) {
    if (
      (op.type === 'REMOVE_RANGE' || op.type === 'REMOVE_WORD') &&
      op.sourceStart !== undefined &&
      op.sourceEnd !== undefined
    ) {
      removed.push({ start: op.sourceStart, end: op.sourceEnd });
    } else if (
      (op.type === 'REMOVE_SILENCES' || op.type === 'REMOVE_FILLERS' || op.type === 'REMOVE_WORD') &&
      op.removeRanges
    ) {
      for (const r of op.removeRanges) removed.push({ start: r.start, end: r.end });
    } else if ((op.type === 'KEEP_ONLY_RANGE' || op.type === 'CREATE_DURATION_CUT') && op.keepRanges) {
      const kept=[...op.keepRanges].sort((a,b)=>a.start-b.start);
      for(const seg of state.segments){
        let cursor=seg.sourceStart;
        for(const range of kept){
          const start=Math.max(seg.sourceStart,range.start),end=Math.min(seg.sourceEnd,range.end);
          if(end-start<=.1 || end<=cursor) continue;
          if(start>cursor) removed.push({start:cursor,end:start});
          cursor=Math.max(cursor,end);
        }
        if(cursor<seg.sourceEnd) removed.push({start:cursor,end:seg.sourceEnd});
      }
    }
  }
  return removed;
}

export function computeEditImpact(
  state: ProjectState,
  analysis: MediaAnalysis,
  plan: EditPlan,
): EditImpactReport {
  const simulated = applyEditPlan(state, analysis, plan, { ignoreProtection: true }).nextState;
  const removedRanges = getRemovedRangesForOperations(state, plan.operations);

  const affectedSegments: EditImpactReport['affectedSegments'] = [];
  for (const seg of state.segments) {
    const overlapsRemoved = removedRanges.some(
      (r) => Math.min(seg.sourceEnd, r.end) - Math.max(seg.sourceStart, r.start) > 0.05,
    );
    const matchesOpSeg = plan.operations.some((op) => op.segmentId === seg.id);
    if (overlapsRemoved || matchesOpSeg) {
      affectedSegments.push({
        segmentId: seg.id,
        label: seg.label,
        sourceStart: seg.sourceStart,
        sourceEnd: seg.sourceEnd,
        timelineStart: seg.timelineStart,
        timelineEnd: seg.timelineEnd,
      });
    }
  }

  let captionsAffectedCount = 0;
  for (const cap of state.captions) {
    const hitsRemoved = removedRanges.some(
      (r) => Math.min(cap.sourceEnd, r.end) - Math.max(cap.sourceStart, r.start) > 0.05,
    );
    if (hitsRemoved) captionsAffectedCount += 1;
  }

  const protectedMoments = analysis.importantMoments.filter((m) =>
    state.protectedMomentIds.includes(m.id),
  );
  const protectedWarnings: EditImpactReport['protectedWarnings'] = [];
  for (const moment of protectedMoments) {
    const overlapsRemoved = removedRanges.some(
      (r) => Math.min(moment.end, r.end) - Math.max(moment.start, r.start) > 0.15,
    );
    if (overlapsRemoved) {
      protectedWarnings.push({
        momentId: moment.id,
        title: moment.title,
        category: moment.category,
        reason: moment.reason,
        sourceStart: moment.start,
        sourceEnd: moment.end,
      });
    }
  }

  return {
    affectedSegments,
    durationBefore: state.duration,
    durationAfter: simulated.duration,
    durationDelta: round3(simulated.duration - state.duration),
    captionsAffectedCount,
    protectedWarnings,
    hasProtectedCollision: protectedWarnings.length > 0,
  };
}

export function applyEditPlan(
  state: ProjectState,
  analysis: MediaAnalysis,
  plan: EditPlan,
  options: { ignoreProtection?: boolean } = {},
): { nextState: ProjectState; appliedCount: number; message: string } {
  const validation = validateEditPlan(analysis, plan);
  if (!validation.valid) {
    return {
      nextState: state,
      appliedCount: 0,
      message: validation.reason || 'Edit rejected by validation.',
    };
  }

  let segments = [...state.segments];
  let captionsEnabled = state.captionsEnabled;
  let captionStyle = { ...state.captionStyle };
  let captions = state.captions.map((c) => ({ ...c, words: [...c.words] }));
  let overlays = [...state.overlays];
  let bleeps = [...state.bleeps];
  let muteRanges = [...(state.muteRanges || [])];
  let audio = { ...state.audio };
  let activeVersionId = state.activeVersionId;
  let appliedCount = 0;
  let protectedPauses = state.protectedPauses;

  for (const op of plan.operations) {
    switch (op.type) {
      case 'ADD_CAPTION': {
        if (op.caption && !state.trackLocks.captions && !captions.some(c => c.id === op.caption!.id)) {
          captions = [op.caption, ...captions];
          captionsEnabled = true;
          appliedCount++;
        }
        break;
      }
      case 'STYLE_CAPTION': {
        if (!state.trackLocks.captions && op.captionStylePatch && captions.some(c => c.id === op.captionId)) {
          captions = captions.map(c => c.id === op.captionId
            ? {...c, styleOverride: {...c.styleOverride, ...op.captionStylePatch}} : c);
          appliedCount++;
        }
        break;
      }
      case 'PROTECT_PAUSE': {
        if (op.sourceStart !== undefined && op.sourceEnd !== undefined) {
          protectedPauses = [...(protectedPauses || []), {start:op.sourceStart,end:op.sourceEnd}];
          appliedCount++;
        }
        break;
      }
      case 'MOVE_RANGE': {
        if (state.trackLocks.video || op.sourceStart === undefined || op.sourceEnd === undefined) break;
        const moving: TimelineSegment[] = [];
        const others: TimelineSegment[] = [];
        for (const seg of segments) {
          const lo = Math.max(seg.sourceStart, op.sourceStart), hi = Math.min(seg.sourceEnd, op.sourceEnd);
          if (hi <= lo || seg.locked) { others.push(seg); continue; }
          if (lo > seg.sourceStart) others.push({...seg,id:nextSegmentId(),sourceEnd:lo});
          moving.push({...seg,id:nextSegmentId(),sourceStart:lo,sourceEnd:hi});
          if (hi < seg.sourceEnd) others.push({...seg,id:nextSegmentId(),sourceStart:hi});
        }
        if (moving.length && others.length) {
          segments = op.moveTo === 'start' ? [...moving,...others] : [...others,...moving];
          appliedCount++;
        }
        break;
      }
      case 'REMOVE_WORD': {
        const targets = op.removeRanges
          ? op.removeRanges
          : op.sourceStart !== undefined && op.sourceEnd !== undefined
            ? [{ start: op.sourceStart, end: op.sourceEnd, label: op.label, targetText: op.targetText }]
            : [];
        for (const r of targets) {
          const nextSegs = removeSourceRangeFromSegments(segments, r.start, r.end, {
            minRemainderSec: 0.03,
          });
          if (nextSegs.length > 0) {
            segments = nextSegs;
            captions = removeWordFromCaptionEntries(
              captions,
              r.start,
              r.end,
              r.targetText || op.targetText,
            );
            appliedCount += 1;
          }
        }
        break;
      }
      case 'REMOVE_WORD_FROM_CAPTIONS': {
        if (!state.trackLocks.captions) {
          const targets = op.removeRanges
            ? op.removeRanges
            : op.sourceStart !== undefined && op.sourceEnd !== undefined
              ? [{ start: op.sourceStart, end: op.sourceEnd, label: op.label, targetText: op.targetText }]
              : [];
          for (const r of targets) {
            captions = removeWordFromCaptionEntries(
              captions,
              r.start,
              r.end,
              r.targetText || op.removeWordText || op.targetText,
            );
            appliedCount += 1;
          }
        }
        break;
      }
      case 'MUTE_RANGE': {
        if (!state.trackLocks.audio && op.sourceStart !== undefined && op.sourceEnd !== undefined) {
          muteRanges.push({
            id: nextSegmentId('mute'),
            sourceStart: op.sourceStart,
            sourceEnd: op.sourceEnd,
            label: op.label || 'Mute Word',
          });
          appliedCount += 1;
        }
        break;
      }
      case 'REMOVE_RANGE': {
        if (op.sourceStart !== undefined && op.sourceEnd !== undefined) {
          const nextSegs = removeSourceRangeFromSegments(segments, op.sourceStart, op.sourceEnd);
          if (nextSegs.length > 0) {
            segments = nextSegs;
            appliedCount += 1;
          }
        }
        break;
      }
      case 'REMOVE_SILENCES': {
        const ranges = op.removeRanges || analysis.silences;
        for (const r of ranges) {
          const nextSegs = removeSourceRangeFromSegments(segments, r.start, r.end);
          if (nextSegs.length > 0) segments = nextSegs;
        }
        appliedCount += 1;
        break;
      }
      case 'REMOVE_FILLERS': {
        const ranges = op.removeRanges || analysis.fillers;
        for (const r of ranges) {
          const nextSegs = removeSourceRangeFromSegments(segments, r.start, r.end, {
            minRemainderSec: 0.03,
          });
          if (nextSegs.length > 0) {
            segments = nextSegs;
            captions = removeWordFromCaptionEntries(captions, r.start, r.end);
          }
        }
        appliedCount += 1;
        break;
      }
      case 'KEEP_ONLY_RANGE':
      case 'CREATE_DURATION_CUT': {
        if (op.keepRanges && op.keepRanges.length > 0) {
          const kept = keepOnlySourceRanges(segments, op.keepRanges);
          if (kept.length > 0) {
            segments = kept;
            appliedCount += 1;
          }
        }
        break;
      }
      case 'REORDER_SEGMENT': {
        if (op.fromIndex !== undefined && op.toIndex !== undefined && !state.trackLocks.video) {
          segments = reorderSegments(segments, op.fromIndex, op.toIndex);
          appliedCount += 1;
        }
        break;
      }
      case 'SET_SPEED': {
        if (!state.trackLocks.video) {
          const speed = Math.min(4, Math.max(0.25, op.speed || 1));
          segments = segments.flatMap(seg => {
            if (op.segmentId && seg.id !== op.segmentId) return [seg];
            const start = Math.max(seg.sourceStart, op.sourceStart ?? seg.sourceStart);
            const end = Math.min(seg.sourceEnd, op.sourceEnd ?? seg.sourceEnd);
            if (end <= start) return [seg];
            const parts = [];
            if (start > seg.sourceStart) parts.push({...seg,id:nextSegmentId(),sourceEnd:start});
            parts.push({...seg,sourceStart:start,sourceEnd:end,speed});
            if (end < seg.sourceEnd) parts.push({...seg,id:nextSegmentId(),sourceStart:end});
            return parts;
          });
          appliedCount += 1;
        }
        break;
      }
      case 'SPLIT_AT': {
        if (op.timelineTime !== undefined && !state.trackLocks.video) {
          segments = splitSegmentAtTimelineTime(segments, op.timelineTime);
          appliedCount += 1;
        }
        break;
      }
      case 'TRIM_SEGMENT': {
        if (
          op.segmentId &&
          op.sourceStart !== undefined &&
          op.sourceEnd !== undefined &&
          !state.trackLocks.video
        ) {
          segments = trimSegment(segments, op.segmentId, op.sourceStart, op.sourceEnd);
          appliedCount += 1;
        }
        break;
      }
      case 'ENABLE_CAPTIONS': {
        captionsEnabled = op.captionEnabled !== undefined ? op.captionEnabled : true;
        if (captionsEnabled && captions.length === 0 && analysis.transcript.length > 0) {
          captions = buildCaptionsFromAnalysis(analysis);
        }
        appliedCount += 1;
        break;
      }
      case 'GENERATE_CAPTIONS': {
        if (analysis.transcript.length > 0) {
          captions = buildCaptionsFromAnalysis(analysis);
          captionsEnabled = true;
          appliedCount += 1;
        }
        break;
      }
      case 'STYLE_CAPTIONS': {
        if (op.captionStylePatch && !state.trackLocks.captions) {
          captionStyle = { ...captionStyle, ...op.captionStylePatch };
          captionsEnabled = true;
          if (captions.length === 0 && analysis.transcript.length > 0) {
            captions = buildCaptionsFromAnalysis(analysis);
          }
          appliedCount += 1;
        }
        break;
      }
      case 'UPDATE_CAPTION_TEXT': {
        if (op.captionId && op.captionText !== undefined && !state.trackLocks.captions) {
          captions = captions.map((c) =>
            c.id === op.captionId ? { ...c, text: op.captionText! } : c,
          );
          appliedCount += 1;
        }
        break;
      }
      case 'DELETE_CAPTION': {
        if (op.captionId && !state.trackLocks.captions) {
          captions = captions.filter((c) => c.id !== op.captionId);
          appliedCount += 1;
        }
        break;
      }
      case 'ADJUST_CAPTION_TIME': {
        if (
          op.captionId &&
          op.captionStart !== undefined &&
          op.captionEnd !== undefined &&
          !state.trackLocks.captions
        ) {
          const ns = Math.max(0, Math.min(op.captionStart, op.captionEnd - 0.1));
          const ne = Math.max(ns + 0.1, op.captionEnd);
          captions = captions.map((c) =>
            c.id === op.captionId ? { ...c, sourceStart: round3(ns), sourceEnd: round3(ne) } : c,
          );
          appliedCount += 1;
        }
        break;
      }
      case 'ADD_TEXT_OVERLAY': {
        if (op.overlay && !state.trackLocks.overlays) {
          const overlay = op.overlay;
          const sourceRanges = overlay.sourceRanges ?? recalculateTimeline(segments).segments.flatMap(seg => {
            const lo = Math.max(seg.timelineStart, overlay.timelineStart), hi = Math.min(seg.timelineEnd, overlay.timelineEnd);
            if (hi <= lo) return [];
            return [{start:round3(seg.sourceStart + (lo-seg.timelineStart)*seg.speed),
                     end:round3(seg.sourceStart + (hi-seg.timelineStart)*seg.speed)}];
          });
          overlays.push({
            id: nextSegmentId('ovl'),
            ...op.overlay,
            sourceRanges,
          });
          appliedCount += 1;
        }
        break;
      }
      case 'UPDATE_OVERLAY': {
        if (op.overlayId && op.overlayPatch && !state.trackLocks.overlays) {
          overlays = overlays.map((o) =>
            o.id === op.overlayId ? { ...o, ...op.overlayPatch } : o,
          );
          appliedCount += 1;
        }
        break;
      }
      case 'DELETE_OVERLAY': {
        if (op.overlayId && !state.trackLocks.overlays) {
          overlays = overlays.filter((o) => o.id !== op.overlayId);
          appliedCount += 1;
        }
        break;
      }
      case 'SET_AUDIO': {
        if (op.audioPatch && !state.trackLocks.audio) {
          audio = { ...audio, ...op.audioPatch };
          appliedCount += 1;
        }
        break;
      }
      case 'BLEEP_RANGE': {
        if (!state.trackLocks.audio && op.sourceStart !== undefined && op.sourceEnd !== undefined) {
          bleeps.push({
            id: nextSegmentId('bleep'),
            sourceStart: op.sourceStart,
            sourceEnd: op.sourceEnd,
            label: op.label || 'Bleep',
          });
          appliedCount += 1;
        }
        break;
      }
      case 'RESTORE_SEGMENT': {
        if (op.restoreTarget === 'all') {
          const fresh = createInitialProjectState(analysis);
          segments = fresh.segments;
          captions = fresh.captions;
          muteRanges = [];
          bleeps = [];
          appliedCount += 1;
        } else if (op.restoreTarget === 'intro' && analysis.transcript.length > 0) {
          const intro = analysis.transcript[0];
          const alreadyPresent = segments.some(
            (s) => Math.min(s.sourceEnd, intro.end) - Math.max(s.sourceStart, intro.start) > 0.3,
          );
          if (!alreadyPresent) {
            segments.unshift({
              id: nextSegmentId('seg-restored'),
              sourceSegmentId: intro.id,
              sourceStart: intro.start,
              sourceEnd: intro.end,
              timelineStart: 0,
              timelineEnd: intro.end - intro.start,
              speed: 1,
              volume: 1,
              muted: false,
              label: intro.topic || 'Restored Intro',
              topic: intro.topic,
              speaker: intro.speaker,
              thumbnailUrl: analysis.scenes[0]?.thumbnailUrl,
              transition: 'none',
              crop: null,
              locked: false,
            });
            appliedCount += 1;
          }
        } else if (op.sourceStart !== undefined && op.sourceEnd !== undefined) {
          const matching = analysis.transcript.find(
            (t) => Math.min(t.end, op.sourceEnd!) - Math.max(t.start, op.sourceStart!) > 0.2,
          );
          segments.push({
            id: nextSegmentId('seg-restored'),
            sourceSegmentId: matching?.id || 'restored',
            sourceStart: op.sourceStart,
            sourceEnd: op.sourceEnd,
            timelineStart: 0,
            timelineEnd: op.sourceEnd - op.sourceStart,
            speed: 1,
            volume: 1,
            muted: false,
            label: matching?.topic || op.label || 'Restored Segment',
            topic: matching?.topic,
            speaker: matching?.speaker,
            transition: 'none',
            crop: null,
            locked: false,
          });
          appliedCount += 1;
        }
        break;
      }
      case 'APPLY_VERSION': {
        if (op.versionSegments && op.versionSegments.length > 0) {
          segments = op.versionSegments.map((s) => ({ ...s, id: nextSegmentId('seg-ver') }));
          activeVersionId = op.versionId;
          appliedCount += 1;
        }
        break;
      }
    }
  }

  const recalc = recalculateTimeline(segments);
  const nextState: ProjectState = {
    ...state,
    segments: recalc.segments,
    duration: recalc.duration,
    captionsEnabled,
    captionStyle,
    captions,
    overlays,
    bleeps,
    muteRanges,
    audio,
    activeVersionId,
    ...(protectedPauses ? {protectedPauses} : {}),
  };

  if (!options.ignoreProtection && nextState.segments.length === 0) {
    return {
      nextState: state,
      appliedCount: 0,
      message: 'Operation cancelled because it would leave the timeline empty.',
    };
  }

  return {
    nextState,
    appliedCount,
    message: plan.intentSummary,
  };
}

function stemSearchToken(tok: string): string {
  const clean = tok.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  if (/^[a-z]{5,}$/.test(clean)) {
    if (clean.endsWith('ing') && clean.length > 6) return clean.slice(0, -3);
    if (clean.endsWith('ied') && clean.length > 5) return `${clean.slice(0, -3)}y`;
    if (clean.endsWith('ed') && clean.length > 5) return clean.slice(0, -2);
    if (clean.endsWith('es') && clean.length > 5) return clean.slice(0, -2);
    if (clean.endsWith('s') && !clean.endsWith('ss') && clean.length > 4) return clean.slice(0, -1);
  }
  return clean;
}

export function searchMediaIndex(
  analysis: MediaAnalysis,
  segments: TimelineSegment[],
  query: string,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rawTokens = q.split(/\s+/).filter((t) => t.length >= 1);
  const tokens = rawTokens.filter((t) => t.length > 1 || /[^\x00-\x7F]/.test(t));
  const stemmedTokens = tokens.map(stemSearchToken).filter((s) => s.length >= 3);
  const hits: SearchHit[] = [];

  for (const t of analysis.transcript) {
    const textLower = t.text.toLowerCase();
    const topicLower = (t.topic || '').toLowerCase();
    const speakerLower = (t.speaker || '').toLowerCase();
    let score = 0;
    const reasons: string[] = [];

    if (textLower.includes(q)) {
      score += 1.0;
      reasons.push(`Exact spoken phrase "${query}"`);
    } else {
      const matchedTokens = tokens.filter(
        (tok, idx) =>
          textLower.includes(tok) ||
          (stemmedTokens[idx] ? textLower.includes(stemmedTokens[idx]) : false),
      );
      if (matchedTokens.length > 0) {
        score += 0.45 * (matchedTokens.length / Math.max(1, tokens.length));
        reasons.push(`Spoken keywords: ${matchedTokens.join(', ')}`);
      }
    }
    if (topicLower.includes(q) || tokens.some((tok) => topicLower.includes(tok))) {
      score += 0.4;
      reasons.push(`Topic match: ${t.topic}`);
    }
    if (speakerLower.includes(q)) {
      score += 0.35;
      reasons.push(`Speaker: ${t.speaker}`);
    }

    if (score > 0.2) {
      const tlRange = mapSourceRangeToTimeline(segments, t.start, t.end);
      const scene = analysis.scenes.find(
        (s) => Math.min(s.end, t.end) - Math.max(s.start, t.start) > 0.2,
      );
      hits.push({
        id: `hit-tr-${t.id}`,
        matchType: speakerLower.includes(q)
          ? 'speaker'
          : topicLower.includes(q)
            ? 'topic'
            : 'transcript',
        score: round3(score),
        snippet: t.text,
        explanation: reasons.join(' · '),
        speaker: t.speaker,
        sourceStart: t.start,
        sourceEnd: t.end,
        timelineStart: tlRange ? tlRange.timelineStart : null,
        timelineEnd: tlRange ? tlRange.timelineEnd : null,
        thumbnailUrl: scene?.thumbnailUrl,
        inCurrentTimeline: Boolean(tlRange),
      });
    }
  }

  for (const scene of analysis.scenes) {
    const haystack = [
      scene.title,
      scene.description,
      ...scene.objects,
      ...scene.activities,
    ]
      .join(' ')
      .toLowerCase();
    if (haystack.includes(q) || tokens.some((tok) => haystack.includes(tok))) {
      const tlRange = mapSourceRangeToTimeline(segments, scene.start, scene.end);
      const matchedObj = scene.objects.find((o) => o.toLowerCase().includes(q) || tokens.some((t) => o.toLowerCase().includes(t)));
      const matchedAct = scene.activities.find((a) => a.toLowerCase().includes(q) || tokens.some((t) => a.toLowerCase().includes(t)));
      hits.push({
        id: `hit-sc-${scene.id}`,
        matchType: matchedObj ? 'object' : matchedAct ? 'activity' : 'scene',
        score: 0.72,
        snippet: `${scene.title}: ${scene.description}`,
        explanation: matchedObj
          ? `Visual object detected: ${matchedObj}`
          : matchedAct
            ? `Activity detected: ${matchedAct}`
            : `Scene description match`,
        sourceStart: scene.start,
        sourceEnd: scene.end,
        timelineStart: tlRange ? tlRange.timelineStart : null,
        timelineEnd: tlRange ? tlRange.timelineEnd : null,
        thumbnailUrl: scene.thumbnailUrl,
        inCurrentTimeline: Boolean(tlRange),
      });
    }
  }

  for (const imp of analysis.importantMoments) {
    const hay = `${imp.title} ${imp.reason} ${imp.category}`.toLowerCase();
    if (hay.includes(q) || tokens.some((tok) => hay.includes(tok))) {
      const tlRange = mapSourceRangeToTimeline(segments, imp.start, imp.end);
      hits.push({
        id: `hit-imp-${imp.id}`,
        matchType: 'important',
        score: 0.85,
        snippet: `${imp.title} — ${imp.reason}`,
        explanation: `Important ${imp.category} marker`,
        sourceStart: imp.start,
        sourceEnd: imp.end,
        timelineStart: tlRange ? tlRange.timelineStart : null,
        timelineEnd: tlRange ? tlRange.timelineEnd : null,
        inCurrentTimeline: Boolean(tlRange),
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score);
}

export function generateThreeVersions(analysis: MediaAnalysis): EditVersion[] {
  const transcript = analysis.transcript;
  const totalDur = Math.max(1, analysis.durationSec);

  if (transcript.length === 0) {
    const fullSeg: TimelineSegment = {
      id: 'ver-seg-1',
      sourceSegmentId: 'src-full',
      sourceStart: 0,
      sourceEnd: totalDur,
      timelineStart: 0,
      timelineEnd: totalDur,
      speed: 1,
      volume: 1,
      muted: false,
      label: 'Full Source',
    };
    const fastDur = round3(Math.min(totalDur, Math.max(4, totalDur * 0.45)));
    const balDur = round3(Math.min(totalDur, Math.max(6, totalDur * 0.7)));
    const fastSegs = recalculateTimeline([{ ...fullSeg, sourceEnd: fastDur, speed: 1.2, label: 'Hook Cut' }]);
    const balSegs = recalculateTimeline([{ ...fullSeg, sourceEnd: balDur, speed: 1.05, label: 'Balanced Cut' }]);
    const detSegs = recalculateTimeline([fullSeg]);

    return [
      {
        id: 'fast_hook',
        name: 'Fast Hook',
        tagline: 'High-retention social cut',
        description: 'Punchy opening at 1.2x pacing focused on immediate visual impact.',
        durationSec: fastSegs.duration,
        pacingLabel: '1.20x Energetic',
        coveragePercent: Math.round((fastDur / totalDur) * 100),
        segmentCount: fastSegs.segments.length,
        segments: fastSegs.segments,
        captionsEnabled: true,
        highlights: ['Opening visual hook', '1.2x pace', 'Tight end frame'],
      },
      {
        id: 'balanced_story',
        name: 'Balanced Story',
        tagline: 'Clean narrative arc',
        description: 'Keeps core storyline while trimming idle tail frames.',
        durationSec: balSegs.duration,
        pacingLabel: '1.05x Natural',
        coveragePercent: Math.round((balDur / totalDur) * 100),
        segmentCount: balSegs.segments.length,
        segments: balSegs.segments,
        captionsEnabled: true,
        highlights: ['Core storyline', 'Trimmed dead air', 'Subtle pacing lift'],
      },
      {
        id: 'detailed_explainer',
        name: 'Detailed Explainer',
        tagline: 'Complete unedited fidelity',
        description: 'Preserves 100% of source material with full captions.',
        durationSec: detSegs.duration,
        pacingLabel: '1.00x Deliberate',
        coveragePercent: 100,
        segmentCount: detSegs.segments.length,
        segments: detSegs.segments,
        captionsEnabled: true,
        highlights: ['Full source fidelity', 'Captions enabled', 'Zero skipped frames'],
      },
    ];
  }

  // Version 1: Fast Hook — lead with strongest demo/hook/CTA, 1.15x speed, drop pauses/redundant middle
  const hookCandidates = transcript.filter(
    (t) =>
      t.isImportant ||
      /demo|launch|intro|hook|cta|benefit|ai/i.test(`${t.topic} ${t.text}`),
  );
  const pickedFast = (hookCandidates.length >= 2 ? hookCandidates : transcript).slice(
    0,
    Math.max(2, Math.ceil(transcript.length * 0.45)),
  );
  // Put the strongest demo or hook first if not already first
  const demoIdx = pickedFast.findIndex((t) => t.importantCategory === 'demonstration');
  const orderedFast =
    demoIdx > 0
      ? [pickedFast[demoIdx], ...pickedFast.filter((_, i) => i !== demoIdx)]
      : pickedFast;

  const fastRecalc = recalculateTimeline(
    orderedFast.map((t, i) => ({
      id: `fh-${i + 1}`,
      sourceSegmentId: t.id,
      sourceStart: t.start,
      sourceEnd: t.end,
      timelineStart: 0,
      timelineEnd: 0,
      speed: 1.15,
      volume: 1,
      muted: false,
      label: t.topic || `Hook ${i + 1}`,
      topic: t.topic,
      speaker: t.speaker,
    })),
  );

  // Version 2: Balanced Story — keeps narrative order, removes silences & duplicate pricing/filler-heavy segments
  const seenPricing = { count: 0 };
  const pickedBalanced = transcript.filter((t) => {
    if (/pricing|\$\d+/i.test(t.text)) {
      seenPricing.count += 1;
      if (seenPricing.count > 1 && !t.isImportant) return false;
    }
    return true;
  });
  // Trim out silence overlaps from balanced segments
  let balSegments: TimelineSegment[] = pickedBalanced.map((t, i) => ({
    id: `bs-${i + 1}`,
    sourceSegmentId: t.id,
    sourceStart: t.start,
    sourceEnd: t.end,
    timelineStart: 0,
    timelineEnd: 0,
    speed: 1.0,
    volume: 1,
    muted: false,
    label: t.topic || `Beat ${i + 1}`,
    topic: t.topic,
    speaker: t.speaker,
  }));
  for (const sil of analysis.silences) {
    const trimmed = removeSourceRangeFromSegments(balSegments, sil.start, sil.end);
    if (trimmed.length > 0) balSegments = trimmed;
  }
  const balRecalc = recalculateTimeline(balSegments);

  // Version 3: Detailed Explainer — preserves every non-silence segment at 1.0x with full context
  const detRecalc = recalculateTimeline(
    transcript.map((t, i) => ({
      id: `de-${i + 1}`,
      sourceSegmentId: t.id,
      sourceStart: t.start,
      sourceEnd: t.end,
      timelineStart: 0,
      timelineEnd: 0,
      speed: 1.0,
      volume: 1,
      muted: false,
      label: t.topic || `Chapter ${i + 1}`,
      topic: t.topic,
      speaker: t.speaker,
    })),
  );

  const coverage = (segs: TimelineSegment[]) => {
    const covered = segs.reduce((acc, s) => acc + (s.sourceEnd - s.sourceStart), 0);
    return Math.min(100, Math.max(5, Math.round((covered / totalDur) * 100)));
  };

  return [
    {
      id: 'fast_hook',
      name: 'Fast Hook',
      tagline: 'Lead with impact · 1.15x pace',
      description: 'Leads with demonstration and key benefits, strips pauses and repeats for short-form retention.',
      durationSec: fastRecalc.duration,
      pacingLabel: '1.15x High-Tempo',
      coveragePercent: coverage(fastRecalc.segments),
      segmentCount: fastRecalc.segments.length,
      segments: fastRecalc.segments,
      captionsEnabled: true,
      highlights: ['Demonstration-first hook', 'Silences stripped', 'Tightened 1.15x cadence'],
    },
    {
      id: 'balanced_story',
      name: 'Balanced Story',
      tagline: 'Clear arc · Dead air removed',
      description: 'Maintains original narrative arc while removing silences and redundant pricing mentions.',
      durationSec: balRecalc.duration,
      pacingLabel: '1.00x Clean Arc',
      coveragePercent: coverage(balRecalc.segments),
      segmentCount: balRecalc.segments.length,
      segments: balRecalc.segments,
      captionsEnabled: true,
      highlights: ['Original narrative sequence', 'Duplicate mentions pruned', 'Protected CTA intact'],
    },
    {
      id: 'detailed_explainer',
      name: 'Detailed Explainer',
      tagline: 'Full depth · Every topic preserved',
      description: 'Retains all spoken explanations, disclaimers, and chapter context at 1.0x natural pacing.',
      durationSec: detRecalc.duration,
      pacingLabel: '1.00x Complete',
      coveragePercent: coverage(detRecalc.segments),
      segmentCount: detRecalc.segments.length,
      segments: detRecalc.segments,
      captionsEnabled: true,
      highlights: ['All explanations preserved', 'Full disclaimers & CTA', 'Chapter-aligned captions'],
    },
  ];
}

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, seconds);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const tenths = Math.floor((s % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}
