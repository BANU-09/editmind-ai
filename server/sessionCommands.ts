import type { CaptionStyle, EditOperation, MediaAnalysis, ProjectState } from '../src/shared/types';
import { mapSourceRangeToTimeline } from '../src/shared/timelineEngine';
import {
  activeEvents,
  fail,
  mediaWarnings,
  visible,
  overlaps,
  type Decision,
  type EditingSession,
  type EditChoice,
} from './sessionTypes';
import {
  asTime,
  checkBounds,
  clean,
  clock,
  ordinal,
  phraseHits,
  snapCut,
  span,
  topicHits,
  unquote,
  type Match,
  type Span,
} from './sessionLanguage';

const colors: Record<string, string> = {
  red: '#FF0000',
  yellow: '#FFFF00',
  white: '#FFFFFF',
  black: '#000000',
  blue: '#0000FF',
  green: '#008000',
  orange: '#FFA500',
  pink: '#FFC0CB',
  purple: '#800080',
  cyan: '#00FFFF',
};
const cutVerbs = /^(?:cut|remove|delete|trim|drop|shorten)\b/i;
const original = (r: Span) => asTime(r.start) + '–' + asTime(r.end);
const op = (
  type: EditOperation['type'],
  label: string,
  fields: Partial<EditOperation> = {},
): EditOperation => ({ type, label, ...fields });
const mkCut = (r: Span, a: MediaAnalysis, label: string, snap = true) => {
  const x = snap ? snapCut(r, a) : r;
  return op('REMOVE_RANGE', label, { sourceStart: x.start, sourceEnd: x.end });
};
function colorsOrSize(prompt: string, base: number): Partial<CaptionStyle> | undefined {
  const m = prompt.match(/#[a-f\d]{6}\b|\b(red|yellow|white|black|blue|green|orange|pink|purple|cyan)\b/i);
  if (m) return { color: colors[m[0].toLowerCase()] ?? m[0].toUpperCase() };
  if (/\bbigger|larger|increase\b/i.test(prompt)) return { fontSize: Math.min(160, base + 4) };
  if (/\bsmaller|decrease\b/i.test(prompt)) return { fontSize: Math.max(8, base - 4) };
  const size = /\b(?:size|at|to)\s+(\d+)\s*(?:pt|px|points?)?\b/i.exec(prompt);
  if (size && +size[1] >= 8 && +size[1] <= 160) return { fontSize: +size[1] };
}
function addText(
  a: MediaAnalysis,
  state: ProjectState,
  kind: 'caption' | 'overlay',
  text: string,
  r: Span,
  id: string,
  words: Match['words'] = [],
) {
  checkBounds(r, a.durationSec);
  if (!visible(state, r.start, r.end))
    fail('The selected content was removed. Restore it before adding text.', 'CONTENT_REMOVED', r);
  if (!text.trim()) fail('Caption text is empty.');
  if (kind === 'caption')
    return op('ADD_CAPTION', 'Add caption “' + text + '”', {
      caption: {
        id,
        text,
        visible: true,
        customText: true,
        sourceStart: r.start,
        sourceEnd: r.end,
        words,
        speaker: words[0]?.speaker,
      },
    });
  const mapped = mapSourceRangeToTimeline(state.segments, r.start, r.end);
  if (!mapped) fail('The source interval is no longer on the timeline.', 'CONTENT_REMOVED', r);
  return op('ADD_TEXT_OVERLAY', 'Add overlay “' + text + '”', {
    overlay: {
      text,
      sourceRanges: [r],
      ...mapped,
      x: 50,
      y: 50,
      fontSize: 32,
      color: '#FFFFFF',
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
  });
}
function alternatives(
  matches: Match[],
  build: (m: Match) => EditOperation[],
  q: string,
  selection: string,
  allowAll = true,
  alwaysAsk = false,
): Decision {
  if (!matches.length) fail('No matching words or passages exist in the original transcript.', 'NO_MATCH');
  const choices: EditChoice[] = matches.map((m, i) => ({
    label: i + 1 + '. ' + m.segment.speaker + ' at ' + original(m) + ' — ' + m.text.slice(0, 92),
    operations: build(m),
  }));
  const n = ordinal(selection, choices.length);
  if (n >= choices.length) fail('The requested occurrence does not exist.', 'OUT_OF_RANGE');
  const selected =
    n >= 0
      ? [matches[n]]
      : /\b(all|every)\b/i.test(selection)
        ? matches
        : matches.length === 1
          ? matches
          : [];
  if (selected.length && !alwaysAsk) {
    const ops = selected.flatMap(build);
    if (
      selected.some((m) =>
        m.words.some(
          (w) =>
            w.verificationStatus === 'review_needed' ||
            w.verificationStatus === 'unclear_audio' ||
            (w.confidence !== undefined && w.confidence < 0.55),
        ),
      )
    ) {
      return {
        question: 'The matching transcript includes uncertain words. Apply the selected operation?',
        choices: [
          { label: 'Confirm the selected words', operations: ops },
          { label: 'Cancel', operations: [] },
        ],
      };
    }
    return { ops };
  }
  if (allowAll && choices.length > 1)
    choices.push({ label: 'All matches', operations: choices.flatMap((c) => c.operations) });
  return { question: q, choices: [...choices, { label: 'Cancel', operations: [] }] };
}
function styleDecision(session: EditingSession, prompt: string): Decision {
  const state = session.state;
  const custom = state.captions.filter((c) => c.customText && visible(state, c.sourceStart, c.sourceEnd));
  const named = /\bcaption\s+["“'](.+?)["”']/i.exec(prompt);
  const global = /\b(?:all|every)\b|\b(?:captions|subtitles)\b/i.test(prompt);
  if (global) {
    const patch = colorsOrSize(prompt, state.captionStyle.fontSize);
    if (!patch) fail('Choose a supported caption color or font size.');
    return {
      ops: [
        op('STYLE_CAPTIONS', 'Style all captions', { captionStylePatch: patch }),
        ...custom
          .filter((c) => c.styleOverride)
          .map((c) =>
            op('STYLE_CAPTION', 'Style ' + c.text, { captionId: c.id, captionStylePatch: patch }),
          ),
      ],
    };
  }
  if (!state.captionsEnabled && !custom.length)
    return {
      question: 'Which caption would you like to style?',
      choices: [
        { label: 'Enable automatic captions', operations: [op('GENERATE_CAPTIONS', 'Generate captions')] },
        { label: 'Cancel', operations: [] },
      ],
    };
  const candidates = named
    ? custom.filter((c) => c.text.toLowerCase() === named[1].toLowerCase())
    : custom.length
      ? custom
      : state.captions.filter((c) => c.visible && visible(state, c.sourceStart, c.sourceEnd));
  const choices = candidates.map((c) => ({
    label: c.text + ' at ' + asTime(c.sourceStart),
    operations: [
      op('STYLE_CAPTION', 'Style caption “' + c.text + '”', {
        captionId: c.id,
        captionStylePatch: colorsOrSize(prompt, c.styleOverride?.fontSize ?? state.captionStyle.fontSize),
      }),
    ],
  }));
  if (!choices.length)
    return {
      question: 'Which on-screen text should change? Add a caption first or cancel.',
      choices: [{ label: 'Cancel', operations: [] }],
    };
  if (!choices[0].operations[0].captionStylePatch) fail('Specify a supported color or font size.');
  return choices.length === 1
    ? { ops: choices[0].operations }
    : {
        question: 'Which caption should change?',
        choices: [...choices, { label: 'Cancel', operations: [] }],
      };
}
function restoreDecision(session: EditingSession, prompt: string): Decision {
  const edits = activeEvents(session).filter((e) =>
    e.operations.some((o) => /^REMOVE_|^KEEP_ONLY|CREATE_DURATION_CUT/.test(o.type)),
  );
  let selected;
  if (/second[- ]to[- ]last|penultimate/i.test(prompt)) selected = edits.at(-2);
  else if (/\bintro(?:duction)?|opening\b/i.test(prompt))
    selected = edits
      .slice()
      .reverse()
      .find((e) =>
        e.operations.some((o) => o.sourceStart === 0 || o.removeRanges?.some((r) => r.start === 0)),
      );
  else if (/\b(last|previous|just|what I (?:removed|cut))\b/i.test(prompt)) selected = edits.at(-1);
  else {
    const desc = unquote(
      prompt
        .toLowerCase()
        .replace(/^(?:actually[, ]*)?(?:undo|restore|bring back|put back|put)\s+(?:the\s+)?/, '')
        .replace(/\s+(?:part|section|range|cut|edit|back)\b/g, '')
        .trim(),
    );
    selected = edits
      .slice()
      .reverse()
      .find(
        (e) =>
          e.prompt.toLowerCase().includes(desc) ||
          e.operations.some((o) => o.label.toLowerCase().includes(desc)),
      );
    if (!selected && edits.length === 1 && /that|the cut|earlier edit/i.test(prompt)) selected = edits[0];
  }
  if (!selected)
    fail('No applied cut matches that reference. Specify the original cut or its subject.', 'NO_MATCH');
  return { restore: selected.id };
}
function guestOnlyRanges(match: Match, a: MediaAnalysis): Span[] {
  // In a mixed-down interview a cut removes both voices. Preserve every
  // interval occupied by the other speaker, including any overlapping
  // target-speaker word in its entirety.
  const other = a.transcript
    .filter((s) => s.speaker !== match.segment.speaker)
    .flatMap((s) =>
      s.words.length
        ? s.words.map((w) => ({ start: w.start, end: w.end }))
        : [{ start: s.start, end: s.end }],
    )
    .filter((r) => overlaps(r.start, r.end, match.start, match.end) > 0);
  const guarded = [
    ...other,
    ...match.words.filter((w) => other.some((r) => overlaps(w.start, w.end, r.start, r.end) > 0)),
  ].sort((x, y) => x.start - y.start);
  const result: Span[] = [];
  let start = match.start;
  for (const guard of guarded) {
    if (guard.start > start + 0.04) result.push({ start, end: guard.start });
    start = Math.max(start, guard.end);
  }
  if (match.end > start + 0.04) result.push({ start, end: match.end });
  return result;
}
function fillerRanges(a: MediaAnalysis) {
  const words = a.transcript.flatMap((s) => s.words);
  return words
    .filter((w, i) => {
      const term = clean(w.word);
      if (/^(um+|uh+|erm+|er|ah)$/.test(term)) return true;
      if (term !== 'like') return false;
      // Lexical "I like / would like / looks like" is content. Require a
      // disfluency cue in addition to the recognizer's optional filler label.
      const before = clean(words[i - 1]?.word ?? '');
      if (
        /^(would|really|look|looks|feel|felt|sound|sounds|people|they|we|i|you)$/.test(before) &&
        !/[,;]$/.test(words[i - 1]?.word ?? '')
      )
        return false;
      return /[,;]$/.test(w.word) || (w.isFiller && /[,;]$/.test(words[i - 1]?.word ?? ''));
    })
    .map((w) => ({ start: w.start, end: w.end, label: 'Filler ' + w.word }));
}
export function decide(
  session: EditingSession,
  a: MediaAnalysis,
  raw: string,
  captionId: string,
): Decision {
  const state = session.state;
  const prompt = raw
    .trim()
    .replace(/^(?:(?:please|also|actually|now)[, ]+\s*)+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  const lower = prompt.toLowerCase(),
    dur = a.durationSec;
  if (
    /^(?:restore|bring back|put back|put .+ back|undo (?:the|my|that|second|last|previous))\b/i.test(prompt)
  )
    return restoreDecision(session, prompt);
  if (
    /^(?:make|change|set|color|colour|turn|increase|decrease|style)\b/i.test(prompt) &&
    (/\b(?:captions?|subtitles?)\b/i.test(prompt) ||
      /\b(?:it|that)\s+(?:bigger|larger|smaller)\b/i.test(prompt))
  )
    return styleDecision(session, prompt);
  if (
    /^(?:auto[- ]?caption|generate (?:the |all )?(?:captions|subtitles)|(?:add|enable|show|turn on) (?:captions|subtitles)|caption (?:the |this )?(?:whole |entire )?(?:video|clip))/i.test(
      prompt,
    )
  ) {
    if (!a.transcript.length)
      fail('The source has no transcribed speech for automatic captions.', 'NO_TRANSCRIPT');
    return { ops: [op('GENERATE_CAPTIONS', 'Generate timed captions')] };
  }
  const add =
    /^(?:add|insert|put|place|display)\s+(?:a[n]?\s+)?(?:text\s+)?(caption|overlay|subtitle|text)\s*[:=]?\s*(?:(?:saying|reading|with (?:the )?text)\s+)?["“‘'](.+?)["”’']\s+(.+)$/i.exec(
      prompt,
    );
  if (add) {
    const kind = /overlay|^text$/i.test(add[1]) ? 'overlay' : 'caption';
    const text = add[2],
      location = add[3];
    const speech =
      /^(?:when|where|as|on)\s+(?:(?:i|we|they|the speaker|he|she)\s+(?:say[s]?|said)|(?:the\s+)?(?:words?|phrase|line))\s+(.+)$/i.exec(
        location,
      );
    if (speech)
      return alternatives(
        phraseHits(a, speech[1]),
        (m) => [addText(a, state, kind, text, m, captionId, m.words)],
        'Which occurrence should carry this text?',
        '',
      );
    let range = span(location, dur);
    if (!range) {
      const at = /^at\s+(.+?)(?:\s+for\s+(.+))?$/.exec(location.toLowerCase());
      if (at) {
        const start = clock(at[1]),
          length = at[2] ? clock(at[2]) : 2;
        range = { start, end: Math.min(dur, start + length) };
      }
    }
    if (!range) fail('Supply an original timestamp, range, or a spoken phrase for the text.');
    return { ops: [addText(a, state, kind, text, range, captionId)] };
  }
  if (
    /\b(?:background music|music bed|music|soundtrack)\b/i.test(prompt) &&
    /^(add|enable|turn on|mix|remove|disable|mute|turn off)\b/i.test(prompt)
  ) {
    return {
      ops: [
        op('SET_AUDIO', 'Set background music and speech ducking', {
          audioPatch: {
            musicEnabled: !/^(remove|disable|mute|turn off)/i.test(prompt),
            duckUnderSpeech: true,
          },
        }),
      ],
    };
  }
  const speed = /\b(\d+(?:\.\d+)?)\s*[x×]/i;
  if (
    /^(speed(?: up)?|slow(?: down)?|set (?:the )?speed|change (?:the )?speed|play .+ speed)\b/i.test(prompt)
  ) {
    const rate = prompt.match(speed) ?? prompt.match(/\b(?:factor of|speed of)\s+(\d+(?:\.\d+)?)/i);
    let factor = rate ? +rate[1] : /\bdouble\b/i.test(prompt) ? 2 : /\bhalf\b/i.test(prompt) ? 0.5 : NaN;
    if (!Number.isFinite(factor) || factor < 0.25 || factor > 4)
      fail('Playback speed must be between 0.25× and 4×.', 'INVALID_SPEED');
    if (/^slow/i.test(prompt) && factor > 1) factor = 1 / factor;
    let rest = prompt.replace(/\s*(?:(?:by|to|at)\s+)?\d+(?:\.\d+)?\s*[x×](?:\s+speed)?/i, '').trim();
    rest = rest.replace(/^(?:set|change) (?:the )?speed(?: of)?\s*/i, '');
    const range =
      span(rest, dur) ??
      (/^(speed(?: up)?|slow(?: down)?)(?:\s+(?:the|this|whole|entire|video|clip))*$/i.test(rest)
        ? { start: 0, end: dur }
        : undefined);
    if (!range) fail('Specify an original source interval for the speed change.');
    checkBounds(range, dur);
    return {
      ops: [
        op('SET_SPEED', 'Set playback to ' + factor + '×', {
          sourceStart: range.start,
          sourceEnd: range.end,
          speed: factor,
        }),
      ],
      note: 'Latest speed replaces previous speed within the overlap.',
    };
  }
  if (
    /^(?:protect|preserve|keep|leave)\b/.test(lower) &&
    /\b(?:deliberate |intentional )?(?:pause|silence)\b/.test(lower)
  ) {
    const r = span(prompt, dur);
    if (!r) fail('Give the original interval of the pause to preserve.');
    checkBounds(r, dur);
    return {
      ops: [op('PROTECT_PAUSE', 'Keep deliberate pause', { sourceStart: r.start, sourceEnd: r.end })],
    };
  }
  if (cutVerbs.test(prompt) && /\b(?:filler(?:s| words?)?|ums? and uhs?)\b/.test(lower)) {
    const ranges = fillerRanges(a).filter((r) => visible(state, r.start, r.end));
    return {
      ops: ranges.length ? [op('REMOVE_FILLERS', 'Remove spoken fillers', { removeRanges: ranges })] : [],
      note: ranges.length ? 'Lexical uses of “like” are retained.' : 'No matching fillers remain.',
    };
  }
  if (cutVerbs.test(prompt) && /\b(?:pauses|silences|silent gaps|dead air)\b/.test(lower)) {
    const cutoff = /\b(?:longer than|over|above|at least|exceeding)\s+(.+)$/.exec(lower);
    const threshold = cutoff ? clock(cutoff[1]) : 0.45;
    if (!Number.isFinite(threshold) || threshold < 0)
      fail('Supply a nonnegative silence threshold in seconds.');
    const ranges = a.silences
      .filter(
        (g) =>
          g.duration > threshold &&
          visible(state, g.start, g.end) &&
          !(state.protectedPauses ?? []).some((p) => overlaps(p.start, p.end, g.start, g.end) > 0),
      )
      .map((g) => ({ start: g.start + 0.09, end: g.end - 0.13, label: 'Shorten measured silence' }))
      .filter((x) => x.end > x.start);
    return {
      ops: ranges.length
        ? [op('REMOVE_SILENCES', 'Shorten silences over ' + threshold + ' s', { removeRanges: ranges })]
        : [],
      note: 'Deliberate pauses are preserved.',
    };
  }
  if (
    cutVerbs.test(prompt) &&
    /\b(?:pause|silence|gap) (?:right )?after (?:that|it|this|the last edit)\b/i.test(prompt)
  ) {
    const edit = activeEvents(session).at(-1);
    const target = edit?.operations
      .flatMap((o) =>
        o.sourceEnd !== undefined ? [o.sourceEnd] : (o.removeRanges ?? []).map((r) => r.end),
      )
      .at(-1);
    const gap = a.silences.find(
      (s) =>
        target !== undefined &&
        s.start >= target - 0.04 &&
        s.duration > 0.45 &&
        visible(state, s.start + 0.09, s.end - 0.13),
    );
    if (!gap) fail('There is no remaining measured pause following the selected edit.', 'NO_MATCH');
    return {
      ops: [
        mkCut({ start: gap.start + 0.09, end: gap.end - 0.13 }, a, 'Shorten the following pause', false),
      ],
    };
  }
  if (/^(?:move|reorder|put)\b/i.test(prompt)) {
    const m =
      /^(?:move|reorder|put)\s+(.+?)\s+(?:to|at)\s+(?:the\s+)?(start|beginning|front|end|back)$/i.exec(
        prompt,
      );
    if (!m) fail('Specify a source section and whether it belongs at the start or end.');
    const dest = /start|beginning|front/i.test(m[2]) ? 'start' : 'end';
    const move = (r: Span) =>
      op('MOVE_RANGE', 'Move section to ' + dest, { sourceStart: r.start, sourceEnd: r.end, moveTo: dest });
    const section = /^(?:the\s+)?(?:section|segment|scene)\s+(\d+)$/i.exec(m[1]);
    let range = section ? a.transcript[Number(section[1]) - 1] : span(m[1], dur);
    if (!range && /\b(intro|opening|conclusion|outro|closing)\b/i.test(m[1]))
      range = /intro|opening/i.test(m[1]) ? a.transcript[0] : a.transcript.at(-1);
    if (range) {
      checkBounds(range, dur);
      return { ops: [move(range)] };
    }
    return alternatives(
      topicHits(a, m[1].replace(/^(?:the\s+)?(?:part|section|scene|segment)\s+(?:about\s+)?/i, '')),
      (m) => [move(m)],
      'Which section should move?',
      '',
      false,
    );
  }
  if (
    (cutVerbs.test(prompt) && /\b(?:boring|dull|uninteresting|unimportant)\b/.test(lower)) ||
    /^(?:make|cut)\s+(?:the |this |my )?(?:video |clip |it )?(?:shorter|down)\b/i.test(prompt)
  ) {
    const candidates = a.transcript
      .filter(
        (s) =>
          visible(state, s.start, s.end) &&
          !s.isImportant &&
          !a.importantMoments.some((m) => m.protected && overlaps(m.start, m.end, s.start, s.end) > 0),
      )
      .slice(0, 4);
    return {
      question: 'Which passage should be shortened? Choose a source passage or cancel.',
      choices: [
        ...candidates.map((s) => ({
          label: s.text + ' at ' + asTime(s.start),
          operations: [mkCut(s, a, 'Trim chosen passage')],
        })),
        { label: 'Cancel', operations: [] },
      ],
    };
  }
  const who =
    /^(?:remove|cut|delete)\s+(?:everything|all (?:the )?(?:lines?|passages?))\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:says|said|mentions|discusses)\s+about\s+(.+)$/i.exec(
      prompt,
    );
  if (who) {
    const speaker = a.speakers.find((s) =>
      [s.name, s.role, s.id].some((x) => x?.toLowerCase() === who[1].toLowerCase()),
    );
    if (!speaker)
      fail(
        'The transcript has no confirmed speaker called ' + who[1] + '. Review the speaker labels.',
        'SPEAKER_UNCERTAIN',
      );
    const matches = topicHits(a, who[2]).filter(
      (m) =>
        (m.segment.speaker === speaker.name || m.segment.speakerId === speaker.id) &&
        visible(state, m.start, m.end),
    );
    if (!matches.length) fail('No matching lines by the named speaker.', 'NO_MATCH');
    const ops = matches.flatMap((m) =>
      guestOnlyRanges(m, a).map((r) => mkCut(r, a, 'Remove ' + speaker.name + ' passage', false)),
    );
    const previous = new Set<MediaAnalysis['transcript'][number]>();
    for (const hit of matches) {
      const i = a.transcript.indexOf(hit.segment),
        lead = a.transcript[i - 1];
      if (
        lead &&
        lead.speaker !== speaker.name &&
        /\?|^(?:what|how|did|were|tell me|why|when|where|can|do you)\b/i.test(lead.text)
      )
        previous.add(lead);
    }
    const choices: EditChoice[] = ops.length
      ? [{ label: 'Remove only ' + speaker.name + ' lines; keep other speakers', operations: ops }]
      : [];
    if (previous.size)
      choices.push({
        label: 'Also remove the host lead-in question',
        operations: [
          ...matches.map((m) => mkCut(m, a, 'Remove ' + speaker.name + ' passage', false)),
          ...[...previous].map((s) => mkCut(s, a, 'Remove host lead-in', false)),
        ],
      });
    if (!ops.length && !previous.size)
      fail(
        'All matching words overlap another voice in the mixed track. An isolated cut is unavailable.',
        'OVERLAPPING_SPEECH',
      );
    choices.push({ label: 'Cancel', operations: [] });
    return {
      question: mediaWarnings(a).some((w) => /overlap|mismatch/i.test(w))
        ? 'Speaker labeling or overlap needs review. Which material may be removed?'
        : 'Keep the host’s lead-in question, or include it in the cut?',
      choices,
    };
  }
  if (/^(cut|remove|delete|trim|drop|keep|retain|mute|bleep|censor|silence)\b/i.test(prompt)) {
    const keep = /^(keep|retain)/i.test(prompt),
      mute = /^(?:mute|silence)\b/i.test(prompt),
      bleep = /^(bleep|censor)/i.test(prompt);
    const selectRange = (r: Span, label: string) =>
      keep
        ? op('KEEP_ONLY_RANGE', label, { keepRanges: [{ ...r, label }] })
        : mute || bleep
          ? op(bleep ? 'BLEEP_RANGE' : 'MUTE_RANGE', label, { sourceStart: r.start, sourceEnd: r.end })
          : mkCut(r, a, label);
    const r = span(prompt, dur);
    if (r) {
      checkBounds(r, dur);
      return { ops: [selectRange(r, prompt)] };
    }
    if (
      /\b(?:everything|entire (?:video|clip)|whole (?:video|clip)|all footage)\b/i.test(prompt) &&
      !/\b(?:after|before)\b/i.test(prompt)
    )
      fail('Removing the entire video is not permitted.', 'EMPTY_TIMELINE');
    const after =
      /^(?:cut|remove|trim|delete)\s+(?:everything|all(?: footage)?)\s+(after|before)\s+(?:(?:i|we|they|he|she|the speaker)\s+(?:say|says|said)\s+)?(.+)$/i.exec(
        prompt,
      );
    if (after) {
      const hits = phraseHits(a, after[2]);
      return alternatives(
        hits,
        (h) => [
          mkCut(
            after[1] === 'after' ? { start: h.end, end: dur } : { start: 0, end: h.start },
            a,
            prompt,
            false,
          ),
        ],
        'Which occurrence defines the cutoff?',
        '',
        false,
      );
    }
    if (
      /^(?:cut|remove|trim|delete|drop)\s+(?:the\s+)?(?:intro(?:duction)?|opening|outro|closing|conclusion)$/i.test(
        prompt,
      )
    ) {
      const edge = /intro|opening/i.test(prompt) ? a.transcript[0] : a.transcript.at(-1);
      if (!edge) fail('There is no identified spoken opening or closing.', 'NO_MATCH');
      return {
        ops: [
          mkCut(
            /intro|opening/i.test(prompt) ? { start: 0, end: edge.end } : { start: edge.start, end: dur },
            a,
            prompt,
            false,
          ),
        ],
      };
    }
    const topic =
      /\b(?:part|section|passage|segment|discussion|portion|bit)s?\s+(?:(?:that|where)\s+(?:mentions?|covers?)\s+|(?:about|on|regarding)\s+)(.+)$/i.exec(
        prompt,
      );
    if (topic) {
      const hits = topicHits(a, topic[1]).filter((m) => visible(state, m.start, m.end));
      return alternatives(
        hits,
        (m) => [selectRange(m, 'Edit passage about ' + topic[1])],
        'Choose a matching source passage.',
        '',
        true,
        true,
      );
    }
    const match =
      /^(?:mute|silence|bleep|censor|cut|remove|delete|drop)\s+(?:(?:the|all|every|first|second|third|fourth|fifth|last|[0-9]+(?:st|nd|rd|th)|spoken|occurrences?|mentions?|instances?|words?|phrase|of)\s+)*(.+)$/i.exec(
        prompt,
      );
    if (match) {
      const term = unquote(match[1]);
      const hits = phraseHits(a, term);
      if (!hits.length && !/[“"'”]|\b(?:word|mention|occurrence|phrase)\b/i.test(prompt))
        fail('This instruction needs the language planner.', 'UNSUPPORTED_INSTRUCTION');
      return alternatives(
        hits,
        (m) => [
          mute || bleep
            ? selectRange(m, prompt)
            : op(m.words.length > 1 ? 'REMOVE_RANGE' : 'REMOVE_WORD', 'Remove ' + m.text, {
                targetText: term,
                targetScope: m.words.length > 1 ? 'phrase' : 'word',
                sourceStart: m.start,
                sourceEnd: m.end,
              }),
        ],
        'Which occurrence of “' + term + '” should be edited?',
        prompt.slice(0, Math.max(0, prompt.toLowerCase().lastIndexOf(term.toLowerCase()))),
      );
    }
  }
  fail(
    'This instruction needs the language planner. Try a bounded edit or specify the source material.',
    'UNSUPPORTED_INSTRUCTION',
  );
}
