import { createHash } from 'node:crypto';
import type { EditOperation, MediaAnalysis, ProjectState } from '../src/shared/types';
import { createInitialProjectState, recalculateTimeline } from '../src/shared/timelineEngine';

export const timePolicy = 'original_source_seconds';
export interface EditChoice {
  label: string;
  operations: EditOperation[];
}
export interface SessionEvent {
  id: number;
  prompt: string;
  operations: EditOperation[];
  suppress?: number;
}
export interface EditingSession {
  version: 1;
  original: ProjectState;
  state: ProjectState;
  events: SessionEvent[];
  cursor: number;
  pending?: { prompt: string; question: string; choices: EditChoice[] };
}
export type ReportOperation =
  | EditOperation
  | {
      type: 'UNDO' | 'REDO' | 'RENDER' | 'RESTORE_EDIT' | 'INSPECT';
      label: string;
      target?: number;
    };
export interface SessionResponse {
  status: 'applied' | 'needs_clarification' | 'rejected';
  code: string;
  operations: ReportOperation[];
  summary: string;
  question: string | null;
  options: string[];
  duration_s: number;
  before_duration_s: number;
  timeline_hash: string;
  time_policy: typeof timePolicy;
  warnings: string[];
}
export class InstructionError extends Error {
  constructor(
    public code: string,
    message: string,
    public sourceRange?: { start: number; end: number },
  ) {
    super(message);
  }
}
export type Decision =
  | { ops: EditOperation[]; note?: string }
  | { question: string; choices: EditChoice[] }
  | { restore: number }
  | { inspect: string };
export function fail(
  message: string,
  code = 'INVALID_INSTRUCTION',
  sourceRange?: { start: number; end: number },
): never {
  throw new InstructionError(code, message, sourceRange);
}
export function createSession(analysis: MediaAnalysis, initialState?: ProjectState): EditingSession {
  let initial = initialState ?? createInitialProjectState(analysis);
  if (initialState) {
    let segments = initialState.segments;
    // Repair the unedited partition produced by older imports of out-of-order
    // ASR chunks. Recognize only the exact original ordering and boundaries.
    const legacyPartition =
      segments.some((s) => s.sourceEnd <= s.sourceStart) &&
      segments.length === analysis.transcript.length &&
      segments.every(
        (s, i) =>
          s.id === 'seg-init-' + (i + 1) &&
          s.sourceSegmentId === analysis.transcript[i].id &&
          Math.abs(s.sourceStart - (i ? analysis.transcript[i].start : 0)) <= 0.001 &&
          Math.abs(s.sourceEnd - (analysis.transcript[i + 1]?.start ?? analysis.durationSec)) <= 0.001,
      );
    if (legacyPartition) {
      const bySource = new Map(segments.map((s) => [s.sourceSegmentId, s]));
      segments = createInitialProjectState(analysis).segments.map((s) => ({
        ...bySource.get(s.sourceSegmentId)!,
        sourceStart: s.sourceStart,
        sourceEnd: s.sourceEnd,
      }));
    }
    initial = { ...initialState, ...recalculateTimeline(segments) };
  }
  return { version: 1, original: initial, state: initial, events: [], cursor: 0 };
}
const hashCache = new WeakMap<ProjectState, string>();
// These database / view identifiers do not describe an edit. Preserve the
// ordered media intervals, exact spoken anchors, style, effects and track state.
const transient = new Set([
  'id',
  'mediaId',
  'thumbnailUrl',
  'speakerId',
  'chunkId',
  'sentenceId',
  'sourceSegmentId',
  'sourceWordId',
  'wordId',
  'protectedMomentIds',
  'sourceUrl',
  'customMusicPath',
]);
// A transcript typically contains thousands of words with one of a handful
// of property layouts. Cache their canonical field order across sessions.
const sortedFields = new Map<string, string[]>();
const wordViews = new WeakMap<object, Record<string, unknown>>();
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') {
    const q = value as Record<string, unknown>;
    const word = typeof q.word === 'string' && typeof q.start === 'number' && typeof q.end === 'number';
    const previous = word && wordViews.get(q);
    if (previous) return previous;
    const fields = Object.keys(q);
    // JSON quoting distinguishes property names even when they contain separators.
    const layout = JSON.stringify(fields);
    let keys = sortedFields.get(layout);
    if (!keys) {
      keys = fields.filter((key) => !transient.has(key)).sort();
      if (sortedFields.size < 512) sortedFields.set(layout, keys);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const item = q[key];
      if (item !== undefined) result[key] = item && typeof item === 'object' ? semantic(item) : item;
    }
    if (word) wordViews.set(q, result);
    return result;
  }
  return value;
}
export function timelineHash(state: ProjectState): string {
  const cached = hashCache.get(state);
  if (cached) return cached;
  const result = createHash('sha256')
    .update(JSON.stringify(semantic(state)))
    .digest('hex');
  hashCache.set(state, result);
  return result;
}
export const overlaps = (a: number, b: number, c: number, d: number) =>
  Math.max(0, Math.min(b, d) - Math.max(a, c));
export function visible(state: ProjectState, start: number, end: number) {
  return state.segments.some((s) => overlaps(s.sourceStart, s.sourceEnd, start, end) > 0.001);
}
export function activeEvents(session: EditingSession) {
  const past = session.events.slice(0, session.cursor);
  const suppressed = new Set(past.map((e) => e.suppress).filter((i) => i !== undefined));
  return past.filter((e) => e.suppress === undefined && !suppressed.has(e.id));
}
export function mediaWarnings(analysis: MediaAnalysis) {
  const warnings = [];
  if (!analysis.hasAudio) warnings.push('No source audio. Speech-based instructions require a transcript.');
  if (analysis.variableFrameRate)
    warnings.push('Variable frame rate. Positions use original media timestamps.');
  if (
    analysis.transcript.length &&
    analysis.speakers.length === 1 &&
    /^(?:speaker|spk)(?:[-_ ]?\d+)?$/i.test(analysis.speakers[0].name)
  ) {
    warnings.push(
      'Speaker attribution is unverified. A single anonymous label may include multiple or overlapping voices.',
    );
  }
  if (
    analysis.transcript.some(
      (t, i, a) => i && a[i - 1].speaker !== t.speaker && a[i - 1].end > t.start + 0.04,
    )
  ) {
    warnings.push('Overlapping speakers detected. A cut may affect both voices.');
  }
  if (
    analysis.transcript.some((t) => t.words.some((w) => w.speaker && t.speaker && w.speaker !== t.speaker))
  ) {
    warnings.push(
      'Possible speaker-label mismatch between words and their segment. Review speaker-specific edits.',
    );
  }
  return warnings;
}
