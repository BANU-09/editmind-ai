import { createHash } from 'node:crypto';
import type { EditOperation, MediaAnalysis, ProjectState } from '../src/shared/types';
import { createInitialProjectState } from '../src/shared/timelineEngine';

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
  ) {
    super(message);
  }
}
export type Decision =
  | { ops: EditOperation[]; note?: string }
  | { question: string; choices: EditChoice[] }
  | { restore: number }
  | { inspect: string };
export function fail(message: string, code = 'INVALID_INSTRUCTION'): never {
  throw new InstructionError(code, message);
}
export function createSession(analysis: MediaAnalysis, initialState?: ProjectState): EditingSession {
  const initial = initialState ?? createInitialProjectState(analysis);
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
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (value && typeof value === 'object') {
    const q = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(q)
        .sort()
        .filter((k) => !transient.has(k) && q[k] !== undefined)
        .map((k) => [k, semantic(q[k])]),
    );
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
