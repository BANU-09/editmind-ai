import type { EditOperation, EditPlan, MediaAnalysis, ProjectState } from '../src/shared/types';
import { applyEditPlan, validateEditPlan } from '../src/shared/timelineEngine';
import { decide } from './sessionCommands';
import { asTime, ordinal } from './sessionLanguage';
import {
  activeEvents,
  fail,
  InstructionError,
  mediaWarnings,
  overlaps,
  timelineHash,
  timePolicy,
  visible,
  type EditingSession,
  type SessionResponse,
  type SessionEvent,
  type ReportOperation,
} from './sessionTypes';
export { createSession, timelineHash, timePolicy } from './sessionTypes';
export type { EditingSession, SessionResponse } from './sessionTypes';

const unchanged = (s: ProjectState, start: number, end: number) =>
  !s.segments.some((seg) => overlaps(seg.sourceStart, seg.sourceEnd, start, end) > 0.001);
function apply(
  original: ProjectState,
  analysis: MediaAnalysis,
  ops: EditOperation[],
  id: number,
): ProjectState {
  let state = original;
  for (const operation of ops) {
    const op = operation;
    const plan: EditPlan = {
      id: 'session-' + id,
      prompt: op.label,
      intentSummary: op.label,
      operations: [op],
      aiMode: 'local-ffmpeg',
    };
    const validation = validateEditPlan(analysis, plan);
    if (!validation.valid) fail(validation.reason ?? 'Invalid operation.', 'OUT_OF_RANGE');
    if (
      op.type === 'REMOVE_RANGE' ||
      op.type === 'REMOVE_WORD' ||
      op.type === 'REMOVE_FILLERS' ||
      op.type === 'REMOVE_SILENCES'
    ) {
      const ranges = op.removeRanges ?? [{ start: op.sourceStart!, end: op.sourceEnd! }];
      const deletingWhole = state.segments.every((s) => {
        let cursor = s.sourceStart;
        for (const range of ranges.slice().sort((a, b) => a.start - b.start)) {
          if (range.start > cursor + 0.001) break;
          cursor = Math.max(cursor, range.end);
        }
        return cursor >= s.sourceEnd - 0.001;
      });
      if (deletingWhole) fail('The cut would delete the entire remaining timeline.', 'EMPTY_TIMELINE');
      if (ranges.every((r) => unchanged(state, r.start, r.end))) continue;
    }
    if (op.type === 'SET_SPEED' || op.type === 'MUTE_RANGE' || op.type === 'BLEEP_RANGE') {
      const lo = op.sourceStart!,
        hi = op.sourceEnd!;
      if (unchanged(state, lo, hi))
        fail('The selected material is no longer on the timeline.', 'CONTENT_REMOVED', {
          start: lo,
          end: hi,
        });
      if (
        op.type === 'SET_SPEED' &&
        state.segments.every(
          (s) => overlaps(s.sourceStart, s.sourceEnd, lo, hi) < 0.001 || s.speed === op.speed,
        )
      )
        continue;
      const current =
        op.type === 'MUTE_RANGE' ? state.muteRanges : op.type === 'BLEEP_RANGE' ? state.bleeps : [];
      if (current?.some((r) => r.sourceStart === lo && r.sourceEnd === hi)) continue;
    }
    if (op.type === 'KEEP_ONLY_RANGE' && !op.keepRanges?.some((r) => visible(state, r.start, r.end)))
      fail('The selection contains no remaining footage.', 'CONTENT_REMOVED');
    if (
      op.type === 'ADD_CAPTION' &&
      state.captions.some(
        (c) =>
          c.customText &&
          c.text === op.caption?.text &&
          c.sourceStart === op.caption?.sourceStart &&
          c.sourceEnd === op.caption?.sourceEnd,
      )
    )
      continue;
    if (
      op.type === 'ADD_TEXT_OVERLAY' &&
      state.overlays.some(
        (o) =>
          o.text === op.overlay?.text &&
          JSON.stringify(o.sourceRanges) === JSON.stringify(op.overlay?.sourceRanges),
      )
    )
      continue;
    if (
      op.type === 'PROTECT_PAUSE' &&
      state.protectedPauses?.some((p) => p.start === op.sourceStart && p.end === op.sourceEnd)
    )
      continue;
    if (op.type === 'MOVE_RANGE' && !visible(state, op.sourceStart!, op.sourceEnd!))
      fail('The requested source section was removed.', 'CONTENT_REMOVED', {
        start: op.sourceStart!,
        end: op.sourceEnd!,
      });
    const result = applyEditPlan(state, analysis, plan, { ignoreProtection: true });
    if (!result.appliedCount)
      fail(result.message || 'A track is locked or the operation has no target.', 'OPERATION_UNAVAILABLE');
    const next = result.nextState;
    if (!next.segments.length || next.duration <= 0)
      fail('An edit must leave some footage.', 'EMPTY_TIMELINE');
    // Legacy engine creates UI-local IDs using the clock. Give newly created
    // objects reproducible identities without changing existing user handles.
    const existing = new Set(state.segments.map((s) => s.id));
    next.segments = next.segments.map((s, i) =>
      existing.has(s.id) ? s : { ...s, id: 'e' + id + '-s' + i + '-' + s.sourceStart + '-' + s.sourceEnd },
    );
    for (const key of ['bleeps', 'muteRanges', 'overlays'] as const) {
      const oldIds = new Set(state[key]?.map((o) => o.id));
      for (const [i, o] of (next[key] ?? []).entries())
        if (!oldIds.has(o.id)) o.id = 'e' + id + '-' + key + '-' + i;
    }
    state = next;
  }
  return state;
}
function replay(session: EditingSession, analysis: MediaAnalysis): ProjectState {
  return activeEvents(session).reduce(
    (state, e) => apply(state, analysis, e.operations, e.id),
    session.original,
  );
}
function captionChanges(before: ProjectState, after: ProjectState) {
  if (!before.captionsEnabled || !after.captionsEnabled) return [];
  // Test the actual surviving words, including captions whose nominal interval
  // still contains silence but all of whose spoken anchors have been removed.
  const shown = (s: ProjectState, c: ProjectState['captions'][number]) =>
    s.segments.some(
      (seg) =>
        overlaps(seg.sourceStart, seg.sourceEnd, c.sourceStart, c.sourceEnd) > 0.01 &&
        (!c.words.length ||
          c.words.some((w) => overlaps(w.start, w.end, seg.sourceStart, seg.sourceEnd) > 0.01)),
    );
  const existing = new Map(after.captions.map((c) => [c.id, c]));
  const lost = before.captions.filter(
    (c) => shown(before, c) && (!existing.has(c.id) || !shown(after, existing.get(c.id)!)),
  );
  return lost.length
    ? [
        'Hidden captions whose source words were removed: ' +
          lost.length +
          '. ' +
          lost
            .slice(0, 3)
            .map((c) => '“' + c.text.slice(0, 55) + '”')
            .join(', '),
      ]
    : [];
}
function answerChoice(session: EditingSession, input: string): EditOperation[] | undefined {
  const choices = session.pending!.choices;
  const raw = input
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .trim();
  if (/^cancel|never ?mind|neither/.test(raw)) return [];
  if (
    choices.length === 2 &&
    /^(yes|apply|confirm|proceed)$/.test(raw) &&
    choices[0].label.startsWith('Confirm')
  )
    return choices[0].operations;
  if (/^all(?: of them| matches| occurrences)?$/.test(raw))
    return choices.find((c) => /^All matches$/.test(c.label))?.operations;
  // The ordinal counts real matches only, excluding the collective and cancel choices.
  const indexed = choices.filter((c) => c.label !== 'Cancel' && c.label !== 'All matches');
  const n = ordinal(raw, indexed.length);
  if (
    n >= 0 &&
    /^(?:(?:use|choose|option|the|pick)\s+)*(?:\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|last)(?:\s+(?:one|option|match|occurrence|mention))?$/.test(
      raw,
    )
  )
    return indexed[n]?.operations;
  const exact = choices.find((c) => c.label.toLowerCase() === raw);
  if (exact) return exact.operations;
  if (
    /\b(?:keep|exclude|without)\b.*\b(?:host|question|lead.?in)\b|\bguest only\b|\bonly (?:the )?guest\b/.test(
      raw,
    )
  )
    return choices.find((c) => c.label.includes('keep other speakers'))?.operations;
  if (/\b(?:include|also remove|cut|remove)\b.*\b(?:host|question|lead.?in)\b/.test(raw))
    return choices.find((c) => c.label.includes('lead-in question'))?.operations;
  return undefined;
}
function clauses(prompt: string) {
  // Quoted user-authored text is literal, even when it contains verbs.
  const quotes: string[] = [];
  const masked = prompt.replace(/"[^"]*"|“[^”]*”|'[^']+'(?=\s|[.,;!?]|$)/g, (s) => {
    const k = quotes.push(s) - 1;
    return '\u0000' + k + '\u0000';
  });
  return masked
    .split(
      /\s*(?:;\s*|\b(?:and then|then|and)\s+(?=(?:please\s+)?(?:cut|remove|delete|keep|mute|bleep|add|set|style|change|speed|slow|make|move|reorder|restore|protect|preserve|generate|auto-caption|undo|redo)\b))/i,
    )
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => quotes[+i]).trim())
    .filter(Boolean);
}
export function stepSession(
  session: EditingSession,
  analysis: MediaAnalysis,
  say: string,
): { session: EditingSession; response: SessionResponse } {
  const before = session.state;
  const warnings = mediaWarnings(analysis);
  const finish = (
    next: EditingSession,
    status: SessionResponse['status'],
    code: string,
    summary: string,
    operations: ReportOperation[] = [],
  ): { session: EditingSession; response: SessionResponse } => ({
    session: next,
    response: {
      status,
      code,
      operations,
      summary: summary + ' Time policy: original source seconds.',
      time_policy: timePolicy,
      before_duration_s: before.duration,
      duration_s: next.state.duration,
      timeline_hash: timelineHash(next.state),
      question: status === 'needs_clarification' ? next.pending!.question : null,
      options: status === 'needs_clarification' ? next.pending!.choices.map((c) => c.label) : [],
      warnings,
    },
  });
  const input = String(say ?? '').trim();
  const plain = input
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .trim();
  try {
    if (!input || input.length > 8000) fail('Enter an instruction between 1 and 8000 characters.');
    if (/^(?:undo|undo (?:that|it|last edit)|redo|redo (?:that|it|last edit))$/.test(plain)) {
      const undo = plain.startsWith('undo'),
        cursor = session.cursor + (undo ? -1 : 1);
      if (cursor < 0 || cursor > session.events.length)
        fail(
          'There is no ' + (undo ? 'earlier' : 'later') + ' edit to ' + (undo ? 'undo.' : 'redo.'),
          'HISTORY_BOUNDARY',
        );
      const next = { ...session, cursor, pending: undefined };
      next.state = replay(next, analysis);
      return finish(
        next,
        'applied',
        undo ? 'UNDO' : 'REDO',
        (undo ? 'Undid' : 'Redid') +
          ' one instruction. Duration ' +
          before.duration +
          ' → ' +
          next.state.duration +
          ' s.',
        [{ type: undo ? 'UNDO' : 'REDO', label: input }],
      );
    }
    if (/^(?:render|export)(?: (?:the|my|this|final|edited|video|timeline|mp4|film))*$/.test(plain))
      return finish(
        { ...session, pending: undefined },
        'applied',
        'RENDER_REQUESTED',
        'Render current timeline of ' + before.duration + ' s.',
        [{ type: 'RENDER', label: input }],
      );
    const past = session.events.slice(0, session.cursor);
    const id = past.length + 1;
    let ops: EditOperation[] = [];
    let note = '';
    let restore: number | undefined;
    let prompt = input;
    let scratch = before;
    const answers = session.pending ? answerChoice(session, input) : undefined;
    if (answers) {
      if (!answers.length)
        return finish(
          { ...session, pending: undefined },
          'applied',
          'CANCELLED',
          'Cancelled the proposed instruction.',
        );
      ops = answers;
      prompt = session.pending!.prompt;
      scratch = apply(before, analysis, ops, id);
    } else {
      if (session.pending && /^(the |option |yes$|confirm$|\d)/i.test(input))
        return finish(
          session,
          'needs_clarification',
          'CHOOSE_OPTION',
          'Select one of the displayed options.',
        );
      const parts = clauses(input);
      if (parts.length > 12) fail('Split the instruction into at most 12 actions.');
      for (const [i, part] of parts.entries()) {
        const d = decide({ ...session, state: scratch }, analysis, part, 'caption-e' + id + '-' + i);
        if ('question' in d) {
          if (parts.length > 1)
            fail(
              'No part was applied. Resolve this part separately: ' + d.question,
              'COMPOUND_CLARIFICATION',
            );
          return finish(
            { ...session, pending: { prompt: input, question: d.question, choices: d.choices } },
            'needs_clarification',
            'CHOOSE_OPTION',
            'Review the available options.',
          );
        }
        if ('inspect' in d)
          return finish(session, 'applied', 'INSPECTED', d.inspect, [{ type: 'INSPECT', label: part }]);
        if ('restore' in d) {
          if (parts.length > 1) fail('No part was applied. Restore a prior edit as its own instruction.');
          restore = d.restore;
        } else {
          scratch = apply(scratch, analysis, d.ops, id);
          ops.push(...d.ops);
          if (d.note) note += ' ' + d.note;
        }
      }
    }
    const event: SessionEvent = {
      id,
      prompt,
      operations: ops,
      ...(restore !== undefined ? { suppress: restore } : {}),
    };
    const next: EditingSession = {
      ...session,
      pending: undefined,
      events: [...past, event],
      cursor: id,
      state: scratch,
    };
    if (restore !== undefined) next.state = replay(next, analysis);
    if (timelineHash(next.state) === timelineHash(before))
      return finish(
        { ...session, pending: undefined },
        'applied',
        'UNCHANGED',
        'The requested state is already in effect.' + note,
      );
    if (ops.some((o) => /^REMOVE_|^KEEP_|^CREATE_DURATION/.test(o.type)))
      warnings.push(...captionChanges(before, next.state));
    const operations: ReportOperation[] =
      restore !== undefined
        ? [{ type: 'RESTORE_EDIT', target: restore, label: 'Restore edit ' + restore }]
        : ops;
    const summary = operations
      .map(
        (o) =>
          o.label +
          ('sourceStart' in o && o.sourceStart !== undefined && o.sourceEnd !== undefined
            ? ' (' + asTime(o.sourceStart) + '–' + asTime(o.sourceEnd) + ')'
            : ''),
      )
      .join('. ');
    return finish(
      next,
      'applied',
      'EDIT_APPLIED',
      summary + '. Duration ' + before.duration + ' → ' + next.state.duration + ' s.' + note,
      operations,
    );
  } catch (error) {
    if (!(error instanceof InstructionError)) throw error;
    let reason = error.message;
    if (error.sourceRange) {
      const { start, end } = error.sourceRange;
      const prior = activeEvents(session)
        .reverse()
        .find((event) =>
          event.operations.some((op) => {
            if (op.type === 'KEEP_ONLY_RANGE')
              return !op.keepRanges?.some((r) => overlaps(r.start, r.end, start, end) > 0);
            if (!/^(REMOVE_RANGE|REMOVE_WORD|REMOVE_SILENCES|REMOVE_FILLERS)$/.test(op.type)) return false;
            return (op.removeRanges ?? [{ start: op.sourceStart!, end: op.sourceEnd! }]).some(
              (r) => overlaps(r.start, r.end, start, end) > 0,
            );
          }),
        );
      if (prior)
        reason +=
          ' Earlier edit ' + prior.id + ' (“' + prior.prompt + '”) removed material in this interval.';
    }
    return finish(session, 'rejected', error.code, 'No changes applied. ' + reason);
  }
}
