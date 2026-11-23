import type { MediaAnalysis, ProjectState, TranscriptSegment, TranscriptWord } from '../src/shared/types';
import { fail, overlaps } from './sessionTypes';

const units: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  zero: 0,
};
function number(raw: string): number {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const words = raw
    .toLowerCase()
    .trim()
    .split(/[\s-]+/);
  if (words.some((w) => !(w in units))) return NaN;
  return words.reduce((n, w) => n + units[w], 0);
}
export function clock(raw: string): number {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^(?:at|from|to|for)\s+/, '')
    .replace(/\s+mark$/, '');
  if (/^\d+:\d{1,2}(?::\d{1,2})?(?:\.\d+)?$/.test(value)) {
    const parts = value.split(':').map(Number);
    if (parts.slice(1).some((n) => n >= 60)) return NaN;
    return parts.reduce((acc, s) => acc * 60 + s, 0);
  }
  const m = /^(.*?)\s*(?:minutes?|mins?|m)\b(?:\s*(?:and\s+)?(.*?)(?:\s*(?:seconds?|secs?|s))?)?$/.exec(
    value,
  );
  if (m) return 60 * number(m[1] || 'one') + (m[2] ? number(m[2]) : 0);
  return number(value.replace(/\s*(?:seconds?|secs?|s)$/, ''));
}
export interface Span {
  start: number;
  end: number;
}
export function span(raw: string, duration: number): Span | undefined {
  const val = raw
    .toLowerCase()
    .trim()
    .replace(/[.!?]$/, '');
  const edge =
    /\b(first|last|opening|final)\s+(.+?)(?:\s+of\s+(?:the|my|this)\s+(?:video|clip|recording))?$/.exec(
      val,
    );
  if (edge) {
    const d = clock(edge[2]);
    if (Number.isFinite(d))
      return /last|final/.test(edge[1]) ? { start: duration - d, end: duration } : { start: 0, end: d };
  }
  // Separate the edit verb from the time expression before interpreting words.
  const expr = val
    .replace(
      /^(?:(?:please|now)\s+)?(?:cut|remove|delete|trim|keep|retain|mute|bleep|protect|preserve|speed up|slow down|speed|move|reorder|put)\s+/,
      '',
    )
    .replace(
      /^(?:(?:only|the|range|section|segment|interval|between|from|at|part|pause|silence|video|clip)\s+)*/,
      '',
    );
  const range = /^(.+?)\s*(?:\s+to\s+|\s+through\s+|\s+and\s+|[-–—])\s*(.+)$/.exec(expr);
  if (range) {
    const start = clock(range[1]),
      end = clock(range[2]);
    if (Number.isFinite(start) && Number.isFinite(end)) return { start, end };
  }
  const one = /\b(before|after)\s+(.+)$/.exec(val);
  if (one) {
    const n = clock(one[2]);
    if (Number.isFinite(n)) return one[1] === 'before' ? { start: 0, end: n } : { start: n, end: duration };
  }
  return undefined;
}
export function checkBounds(range: Span, duration: number) {
  if (
    !Number.isFinite(range.start + range.end) ||
    range.start < 0 ||
    range.end > duration + 0.001 ||
    range.end - range.start < 0.001
  )
    fail('The requested original interval is outside the video or has zero length.', 'OUT_OF_RANGE');
}
export const clean = (s: string) =>
  s
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{M}\p{N}']/gu, '');
export const unquote = (s: string) =>
  s
    .trim()
    .replace(/^[“”‘’"']+|[“”‘’"'.!?]+$/g, '')
    .trim();
export const asTime = (n: number) => Math.floor(n / 60) + ':' + (n % 60).toFixed(2).padStart(5, '0');
export const ordinal = (s: string, n: number): number => {
  const m = /\b(first|second|third|fourth|fifth|sixth|last|\d+(?:st|nd|rd|th)?)\b/i.exec(s);
  if (!m) return -1;
  const a = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
  return m[1].toLowerCase() === 'last'
    ? n - 1
    : a.includes(m[1].toLowerCase())
      ? a.indexOf(m[1].toLowerCase())
      : parseInt(m[1], 10) - 1;
};
export interface Match extends Span {
  text: string;
  words: TranscriptWord[];
  segment: TranscriptSegment;
}
export function phraseHits(a: MediaAnalysis, phrase: string): Match[] {
  const tokens = unquote(phrase).split(/\s+/).map(clean).filter(Boolean);
  if (!tokens.length) return [];
  const words = a.transcript.flatMap((seg) => seg.words.map((w) => ({ w, seg, tok: clean(w.word) })));
  const out: Match[] = [];
  for (let i = 0; i <= words.length - tokens.length; i++) {
    if (
      !tokens.every(
        (t, j) =>
          words[i + j].tok === t &&
          (j === 0 ||
            (words[i + j].w.speaker === words[i].w.speaker &&
              words[i + j].w.start - words[i + j - 1].w.end < 1.8)),
      )
    )
      continue;
    const items = words.slice(i, i + tokens.length).map((w) => w.w);
    out.push({
      start: items[0].start,
      end: items.at(-1)!.end,
      text: items.map((w) => w.word).join(' '),
      words: items,
      segment: words[i].seg,
    });
  }
  return out;
}
const concepts: Record<string, string[]> = {
  pricing: [
    'price',
    'pricing',
    'prices',
    'cost',
    'costs',
    'fee',
    'fees',
    'billing',
    'subscription',
    'subscriptions',
    'plans',
  ],
  employment: [
    'job',
    'jobs',
    'employer',
    'workplace',
    'company',
    'career',
    'employment',
    'role',
    'working',
  ],
  shipping: ['shipping', 'ship', 'delivery', 'deliver'],
  launch: ['launch', 'release', 'debut'],
};
function wordFamily(word: string): string {
  const normalized = clean(word);
  for (const [name, items] of Object.entries(concepts)) if (items.includes(normalized)) return name;
  return normalized.replace(/(?:ing|ed|s)$/, '');
}
export function topicHits(a: MediaAnalysis, topic: string): Match[] {
  const stop = new Set([
    'the',
    'about',
    'their',
    'our',
    'old',
    'my',
    'her',
    'his',
    'part',
    'section',
    'a',
    'an',
    'of',
  ]);
  const tokens = unquote(topic)
    .split(/\s+/)
    .filter((t) => !stop.has(clean(t)))
    .map(wordFamily)
    .filter(Boolean);
  if (!tokens.length) return [];
  return a.transcript
    .filter((s) => {
      const words = new Set((s.text + ' ' + s.topic).split(/\s+/).map(wordFamily));
      return tokens.every((t) => words.has(t));
    })
    .map((s) => ({ start: s.start, end: s.end, text: s.text, words: s.words, segment: s }));
}
export function snapCut(range: Span, analysis: MediaAnalysis): Span {
  let { start, end } = range;
  // Never cut a word in half. Expand a destructive selection to full word
  // boundaries; use an adjacent silence edge only within 80 ms and with no
  // intervening timed speech. A full-source guard runs after snapping.
  const words = analysis.transcript.flatMap((s) => s.words);
  for (const w of words) {
    if (w.start + 0.002 < start && w.end - 0.002 > start) start = Math.min(start, w.start);
    if (w.start + 0.002 < end && w.end - 0.002 > end) end = Math.max(end, w.end);
  }
  const edges = analysis.silences.flatMap((s) => [s.start, s.end]);
  const closest = (t: number, side: number) => {
    const edge = edges
      .filter(
        (v) =>
          Math.abs(v - t) < 0.08 &&
          (v - t) * side >= 0 &&
          !words.some((w) => overlaps(w.start, w.end, Math.min(v, t), Math.max(v, t)) > 0.001),
      )
      .sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
    return edge ?? t;
  };
  return { start: Math.max(0, closest(start, -1)), end: Math.min(analysis.durationSec, closest(end, 1)) };
}
export function availableRanges(state: ProjectState) {
  return state.segments.map((s) => ({ start: s.sourceStart, end: s.sourceEnd }));
}
