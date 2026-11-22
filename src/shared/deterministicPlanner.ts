import {
  formatTimecode,
  mapSourceRangeToTimeline,
  projectCaptionsToTimeline,
  searchMediaIndex,
} from './timelineEngine';
import type {
  EditOperation,
  EditPlan,
  MediaAnalysis,
  ProjectState,
  TranscriptWord,
  TranslationTrack,
  UncertainWordWarning,
} from './types';

function createPlanId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}\p{M}']+|[^\p{L}\p{N}\p{M}']+$/gu, '');
}

export function stemTopicWord(raw: string): string {
  const tok = normalizeToken(raw);
  if (/^[a-z]{5,}$/.test(tok)) {
    if (tok.endsWith('ing') && tok.length > 6) return tok.slice(0, -3);
    if (tok.endsWith('ied') && tok.length > 5) return `${tok.slice(0, -3)}y`;
    if (tok.endsWith('ed') && tok.length > 5) return tok.slice(0, -2);
    if (tok.endsWith('es') && tok.length > 5) return tok.slice(0, -2);
    if (tok.endsWith('s') && !tok.endsWith('ss') && tok.length > 4) return tok.slice(0, -1);
  }
  return tok;
}

export function normalizePromptSpacing(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;

  const mWord = trimmed.match(
    /^(remove|delete|cut|drop|omit|mute|silence|bleep|censor)(?:the)?words?([\p{L}\p{N}\p{M}'-]+)$/iu,
  );
  if (mWord) {
    return `${mWord[1].toLowerCase()} the word ${mWord[2].toLowerCase()}`;
  }

  const mAll = trimmed.match(
    /^(remove|delete|cut|drop|omit|mute|silence|bleep)(?:every|all)(?:occurrences?of)?(?:the)?(?:words?)?([\p{L}\p{N}\p{M}'-]+)$/iu,
  );
  if (mAll) {
    return `${mAll[1].toLowerCase()} every occurrence of the word ${mAll[2].toLowerCase()}`;
  }

  const mOrd = trimmed.match(
    /^(remove|delete|cut|drop|omit|mute|silence|bleep)(?:the)?(first|second|third|last)(?:occurrence?of)?(?:the)?(?:words?)?([\p{L}\p{N}\p{M}'-]+)$/iu,
  );
  if (mOrd) {
    return `${mOrd[1].toLowerCase()} the ${mOrd[2].toLowerCase()} occurrence of the word ${mOrd[3].toLowerCase()}`;
  }

  const mFind = trimmed.match(/^(find|search|locate)(?:every|all)?(?:words?)?([\p{L}\p{N}\p{M}'-]+)$/iu);
  if (mFind) {
    return `${mFind[1].toLowerCase()} ${mFind[2].toLowerCase()}`;
  }

  return trimmed;
}

function getSpeechAvailabilityMessage(analysis: MediaAnalysis): string | null {
  const status = analysis.transcriptionStatus;
  if (
    status === 'not-started' ||
    status === 'queued' ||
    status === 'extracting-audio' ||
    status === 'transcribing' ||
    status === 'aligning' ||
    status === 'generating-captions'
  ) {
    const progressSuffix = analysis.chunkStats?.total
      ? ` (${analysis.chunkStats.completed}/${analysis.chunkStats.total} chunks finished)`
      : '';
    return `Speech transcription is still in progress (${status}${progressSuffix}). Wait a moment for word timestamps to finish before running spoken-word edits.`;
  }
  if (status === 'no-audio' || !analysis.hasAudio) {
    return 'This video has no audio stream, so spoken words cannot be searched or removed.';
  }
  if (status === 'failed') {
    return `Speech transcription failed${analysis.transcriptionError ? `: ${analysis.transcriptionError}` : ''}. Click "Retry Analysis" or "Retry Failed Chunks" in the Transcript panel.`;
  }
  if (status === 'cancelled') {
    return 'Speech transcription was cancelled before completion. Click "Retry Analysis" in the Transcript panel to transcribe speech.';
  }
  return null;
}

export interface WordCandidate {
  id: string;
  label: string;
  snippet: string;
  speaker: string;
  wordText: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number | null;
  timelineEnd: number | null;
}

export function findWordOccurrences(
  analysis: MediaAnalysis,
  state: ProjectState,
  phrase: string,
): WordCandidate[] {
  const cleanTokens = phrase
    .split(/\s+/)
    .map(normalizeToken)
    .filter(Boolean);
  if (cleanTokens.length === 0) return [];

  const matches: WordCandidate[] = [];
  let count = 0;

  for (const seg of analysis.transcript) {
    const words = seg.words || [];
    if (words.length === 0) continue;

    for (let i = 0; i <= words.length - cleanTokens.length; i++) {
      let matched = true;
      for (let k = 0; k < cleanTokens.length; k++) {
        const wTok = words[i + k].normalizedText || normalizeToken(words[i + k].word);
        if (wTok !== cleanTokens[k]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const firstW: TranscriptWord = words[i];
      const lastW: TranscriptWord = words[i + cleanTokens.length - 1];
      const srcStart = Math.max(0, firstW.start);
      const srcEnd = Math.min(analysis.durationSec, Math.max(srcStart + 0.08, lastW.end));

      const tl = mapSourceRangeToTimeline(state.segments, srcStart, srcEnd);
      if (!tl) continue;

      count += 1;
      const ctxStart = Math.max(0, i - 3);
      const ctxEnd = Math.min(words.length, i + cleanTokens.length + 4);
      const snippet = words
        .slice(ctxStart, ctxEnd)
        .map((w) => w.word)
        .join(' ');

      matches.push({
        id: `${seg.id}-occ-${firstW.id}`,
        label: `Occurrence #${count} (${seg.speaker}) · ${formatTimecode(tl.timelineStart)}`,
        snippet: `"...${snippet}..." (in ${seg.topic})`,
        speaker: seg.speaker,
        wordText: words
          .slice(i, i + cleanTokens.length)
          .map((w) => w.word)
          .join(' '),
        sourceStart: srcStart,
        sourceEnd: srcEnd,
        timelineStart: tl.timelineStart,
        timelineEnd: tl.timelineEnd,
      });
    }
  }

  return matches;
}

function findPhraseOccurrences(
  analysis: MediaAnalysis,
  state: ProjectState,
  phrase: string,
) {
  const q = phrase.toLowerCase().trim();
  const matches: Array<{
    id: string;
    label: string;
    snippet: string;
    speaker?: string;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number | null;
    timelineEnd: number | null;
  }> = [];

  for (const seg of analysis.transcript) {
    const hay = `${seg.topic} ${seg.text}`.toLowerCase();
    if (hay.includes(q) || (q === 'pricing' && /\$\d+|dollars|price|pricing/i.test(hay))) {
      const tl = mapSourceRangeToTimeline(state.segments, seg.start, seg.end);
      matches.push({
        id: seg.id,
        label: seg.topic || 'Matched Segment',
        snippet: seg.text,
        speaker: seg.speaker,
        sourceStart: seg.start,
        sourceEnd: seg.end,
        timelineStart: tl ? tl.timelineStart : null,
        timelineEnd: tl ? tl.timelineEnd : null,
      });
    }
  }
  return matches;
}

function parseTimestampToken(tok: string): number | null {
  const clean = tok.trim();
  if (/^\d{1,2}:\d{2}(?:\.\d+)?$/.test(clean)) {
    const [m, s] = clean.split(':').map(Number);
    return m * 60 + s;
  }
  const secM = clean.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)?$/i);
  if (secM) return parseFloat(secM[1]);
  return null;
}

function extractTargetWordFromPrompt(prompt: string): string {
  const quoted = prompt.match(/["'`]([^"'`]+)["'`]/);
  if (quoted && quoted[1].trim()) {
    return quoted[1].trim();
  }

  const afterWord = prompt.match(/(?:\bthe\s+words?|\bwords?)\s+([\p{L}\p{N}\p{M}'-]+)/iu);
  if (afterWord && afterWord[1]) {
    return afterWord[1].trim();
  }

  const captionFor = prompt.match(/(?:captions?|subtitles?)\s+(?:for|of|containing|with)\s+(?:the\s+)?([\p{L}\p{N}\p{M}'-]+(?:\s+[\p{L}\p{N}\p{M}'-]+)?)/iu);
  if (captionFor && captionFor[1]) {
    return captionFor[1].replace(/[.?!]+$/, '').trim();
  }

  const afterKeyword = prompt.match(
    /(?:phrase|occurrences?\s+of)\s+(?:the\s+)?([\p{L}\p{N}\p{M}'-]+(?:\s+[\p{L}\p{N}\p{M}'-]+)?)/iu,
  );
  if (afterKeyword && afterKeyword[1]) {
    return afterKeyword[1]
      .replace(/\b(from|in|captions?|subtitle|subtitles|video|clip|timeline|please|now|only|while|keeping|audio)\b/gi, '')
      .trim();
  }

  return prompt
    .replace(
      /\b(keep|the|audio|but|remove|delete|cut|drop|omit|mute|silence|bleep|out|censor|only|just|first|second|third|1st|2nd|3rd|last|every|all|occurrence|occurrences|of|for|containing|word|words|phrase|from|in|captions?|subtitles?|video|timeline|please|intact)\b/gi,
      ' ',
    )
    .replace(/[.?!]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findSentenceOccurrences(
  analysis: MediaAnalysis,
  state: ProjectState,
  phrase: string,
): Array<{
  id: string;
  label: string;
  snippet: string;
  speaker: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number | null;
  timelineEnd: number | null;
}> {
  const cleanPhrase = phrase.toLowerCase().trim();
  const phraseTokens = cleanPhrase.split(/\s+/).map(normalizeToken).filter(Boolean);
  if (phraseTokens.length === 0) return [];
  const phraseStems = phraseTokens.map(stemTopicWord);
  const results: Array<{
    id: string;
    label: string;
    snippet: string;
    speaker: string;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number | null;
    timelineEnd: number | null;
  }> = [];

  for (const seg of analysis.transcript) {
    const words = seg.words || [];
    if (words.length > 0) {
      const sentenceSlices: TranscriptWord[][] = [];
      let current: TranscriptWord[] = [];
      for (const w of words) {
        current.push(w);
        if (/[.?!।॥]$/.test(w.word.trim())) {
          sentenceSlices.push(current);
          current = [];
        }
      }
      if (current.length > 0) sentenceSlices.push(current);

      for (let si = 0; si < sentenceSlices.length; si++) {
        const slice = sentenceSlices[si];
        const sentText = slice.map((w) => w.word).join(' ');
        const sentNorms = slice.map((w) => w.normalizedText || normalizeToken(w.word));
        const hasMatch =
          sentText.toLowerCase().includes(cleanPhrase) ||
          phraseTokens.every((tok, idx) =>
            sentNorms.some((wn) => wn === tok || (phraseStems[idx].length >= 4 && stemTopicWord(wn) === phraseStems[idx])),
          );
        if (!hasMatch) continue;
        const sStart = Math.max(0, slice[0].start);
        const sEnd = Math.min(analysis.durationSec, Math.max(sStart + 0.2, slice[slice.length - 1].end));
        const tl = mapSourceRangeToTimeline(state.segments, sStart, sEnd);
        if (!tl) continue;
        results.push({
          id: `${seg.id}-sent-${si}`,
          label: `Sentence (${seg.speaker}) · ${formatTimecode(tl.timelineStart)}`,
          snippet: sentText,
          speaker: seg.speaker,
          sourceStart: sStart,
          sourceEnd: sEnd,
          timelineStart: tl.timelineStart,
          timelineEnd: tl.timelineEnd,
        });
      }
    } else if (seg.text.toLowerCase().includes(cleanPhrase)) {
      const tl = mapSourceRangeToTimeline(state.segments, seg.start, seg.end);
      if (tl) {
        results.push({
          id: `${seg.id}-sent-0`,
          label: `Sentence (${seg.speaker}) · ${formatTimecode(tl.timelineStart)}`,
          snippet: seg.text,
          speaker: seg.speaker,
          sourceStart: seg.start,
          sourceEnd: seg.end,
          timelineStart: tl.timelineStart,
          timelineEnd: tl.timelineEnd,
        });
      }
    }
  }
  return results;
}

function findDiscussionOccurrences(
  analysis: MediaAnalysis,
  state: ProjectState,
  topicPhrase: string,
): Array<{
  id: string;
  label: string;
  snippet: string;
  speaker: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number | null;
  timelineEnd: number | null;
}> {
  const stopWords = new Set(['the', 'a', 'an', 'of', 'about', 'on', 'regarding', 'in', 'to', 'and', 'or']);
  const tokens = topicPhrase
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t && !stopWords.has(t));
  if (tokens.length === 0) return [];
  const stems = tokens.map(stemTopicWord).filter((s) => s.length >= 3);

  const matchingSegs = analysis.transcript.filter((seg) => {
    const hay = `${seg.topic || ''} ${seg.text}`.toLowerCase();
    if (hay.includes(topicPhrase.toLowerCase())) return true;
    const segWords = (seg.words || []).map((w) => w.normalizedText || normalizeToken(w.word));
    const segStems = segWords.map(stemTopicWord);
    return tokens.some((tok, idx) => {
      const st = stems[idx];
      return (
        hay.includes(tok) ||
        segWords.includes(tok) ||
        (st ? hay.includes(st) || segStems.some((ws) => ws === st || (ws.startsWith(st) && st.length >= 4)) : false)
      );
    });
  });

  const merged: Array<{
    id: string;
    label: string;
    snippet: string;
    speaker: string;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number | null;
    timelineEnd: number | null;
  }> = [];

  for (const seg of matchingSegs) {
    const tl = mapSourceRangeToTimeline(state.segments, seg.start, seg.end);
    if (!tl) continue;
    const prev = merged[merged.length - 1];
    if (prev && seg.start - prev.sourceEnd <= 1.2) {
      prev.sourceEnd = seg.end;
      prev.timelineEnd = tl.timelineEnd;
      prev.snippet = `${prev.snippet} ${seg.text}`.slice(0, 180);
    } else {
      merged.push({
        id: `disc-${seg.id}`,
        label: seg.topic || `Discussion (${topicPhrase})`,
        snippet: seg.text,
        speaker: seg.speaker,
        sourceStart: seg.start,
        sourceEnd: seg.end,
        timelineStart: tl.timelineStart,
        timelineEnd: tl.timelineEnd,
      });
    }
  }
  return merged;
}

export function deterministicPlan(
  rawPrompt: string,
  state: ProjectState,
  analysis: MediaAnalysis,
): EditPlan {
  const p = normalizePromptSpacing(rawPrompt);
  const lower = p.toLowerCase();
  const totalWords =
    analysis.wordCount ??
    analysis.transcript.reduce((sum, seg) => sum + (seg.words?.length || 0), 0);

  if (/\bundo\b/.test(lower)) {
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: 'Undo the most recent timeline edit.',
      operations: [],
      aiMode: analysis.analysisMode,
    };
  }

  if (/\brestore\b/.test(lower)) {
    if (/intro|beginning|opening/i.test(lower)) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: 'Restore the introduction segment from the original source media.',
        operations: [
          {
            type: 'RESTORE_SEGMENT',
            label: 'Restore Introduction',
            restoreTarget: 'intro',
            targetScope: 'segment',
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: 'Restore all removed segments back to original timeline.',
      operations: [
        {
          type: 'RESTORE_SEGMENT',
          label: 'Restore Full Source',
          restoreTarget: 'all',
          targetScope: 'segment',
        },
      ],
      aiMode: analysis.analysisMode,
    };
  }

  const findMatch = lower.match(
    /^(?:find|search|locate|show)\b.*?(?:about|mentions?|saying|where.*?(?:says?|mentions?))\s+["']?([a-z0-9\s-]+)["']?\.?$/i,
  );
  if (findMatch || lower.startsWith('find ') || lower.startsWith('search ')) {
    const speechStatusMsg = getSpeechAvailabilityMessage(analysis);
    if (speechStatusMsg && analysis.transcript.length === 0) {
      return {
        id: createPlanId(),
        prompt: rawPrompt.trim(),
        intentSummary: speechStatusMsg,
        operations: [],
        aiMode: analysis.analysisMode,
      };
    }
    const query = (
      findMatch?.[1] ||
      p.replace(
        /^(find|search|locate|show)\s+(every\s+section\s+where\s+the\s+speaker\s+mentions\s+|all\s+mentions\s+of\s+|sections?\s+about\s+)?/i,
        '',
      )
    )
      .replace(/[.?!]+$/, '')
      .trim();
    return {
      id: createPlanId(),
      prompt: rawPrompt.trim(),
      intentSummary: `Searching video index for "${query}" across spoken transcript, topics, and visual scenes.`,
      operations: [],
      searchQuery: query || 'AI',
      aiMode: analysis.analysisMode,
    };
  }

  if (/pause|silence|dead air|gaps?/i.test(lower) && /remove|cut|strip|trim|clean/i.test(lower)) {
    if (analysis.silences.length === 0) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: 'No long silent pauses (>0.45s) were detected in this footage.',
        operations: [],
        aiMode: analysis.analysisMode,
      };
    }
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: `Remove ${analysis.silences.length} silent pause(s) totaling ${analysis.silences
        .reduce((a, b) => a + b.duration, 0)
        .toFixed(1)}s.`,
      operations: [
        {
          type: 'REMOVE_SILENCES',
          label: `Remove ${analysis.silences.length} Silent Pauses`,
          targetScope: 'segment',
          removeRanges: analysis.silences.map((s, idx) => ({
            start: s.start,
            end: s.end,
            label: `Pause ${idx + 1}`,
          })),
        },
      ],
      aiMode: analysis.analysisMode,
    };
  }

  if (/filler|um\b|uh\b|hesitation/i.test(lower) && /remove|cut|clean|delete/i.test(lower)) {
    if (analysis.fillers.length === 0) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: 'No filler words ("um", "uh") were detected in this transcript.',
        operations: [],
        aiMode: analysis.analysisMode,
      };
    }
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: `Remove ${analysis.fillers.length} filler word(s) (${analysis.fillers.map((f) => f.word).join(', ')}).`,
      operations: [
        {
          type: 'REMOVE_FILLERS',
          label: `Remove ${analysis.fillers.length} Filler Words`,
          targetScope: 'word',
          removeRanges: analysis.fillers.map((f) => ({
            start: f.start,
            end: f.end,
            label: f.word,
            targetText: f.word,
          })),
        },
      ],
      aiMode: analysis.analysisMode,
    };
  }

  if (
    (/from captions?|in captions?|from subtitles?|captions? only|subtitles? only/i.test(lower) ||
      (/keep\s+(?:the\s+)?audio/i.test(lower) && /captions?|subtitles?/i.test(lower))) &&
    /remove|delete|hide|strip/i.test(lower)
  ) {
    const wordTarget = extractTargetWordFromPrompt(p);
    if (wordTarget) {
      const occurrences = findWordOccurrences(analysis, state, wordTarget);
      if (occurrences.length > 0) {
        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `Remove "${wordTarget}" from captions across ${occurrences.length} occurrence(s) while keeping video and audio intact.`,
          operations: [
            {
              type: 'REMOVE_WORD_FROM_CAPTIONS',
              label: `Hide "${wordTarget}" in Captions`,
              targetScope: 'caption',
              targetText: wordTarget,
              removeWordText: wordTarget,
              removeRanges: occurrences.map((o) => ({
                start: o.sourceStart,
                end: o.sourceEnd,
                label: o.wordText,
                targetText: o.wordText,
              })),
            },
          ],
          aiMode: analysis.analysisMode,
        };
      }
    }
    if (/keep\s+(?:the\s+)?audio/i.test(lower) && /captions?|subtitles?/i.test(lower)) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: 'Hide captions while keeping the audio track untouched.',
        operations: [
          {
            type: 'ENABLE_CAPTIONS',
            label: 'Remove Captions (Keep Audio)',
            targetScope: 'caption',
            captionEnabled: false,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  const sentenceMatch = p.match(
    /(?:remove|delete|cut|drop)\s+(?:the\s+|every\s+|all\s+)?sentences?\s+(?:containing|with|including|that\s+(?:has|have|contains?|mentions?|says?))\s+(?:the\s+word\s+)?["'`]?([^"'`?.!]+)["'`]?/iu,
  );
  if (sentenceMatch && sentenceMatch[1]) {
    const target = sentenceMatch[1].trim();
    const sentOccs = findSentenceOccurrences(analysis, state, target);
    if (sentOccs.length > 0) {
      const isAll = /\b(every|all)\b/i.test(lower);
      const isSecond = /\b(second|2nd)\b/i.test(lower);
      const isLast = /\b(last)\b/i.test(lower);
      if (sentOccs.length > 1 && !isAll && !isSecond && !isLast) {
        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `Found ${sentOccs.length} sentences containing "${target}". Select which to remove.`,
          operations: [],
          requiresClarification: true,
          clarificationQuestion: `Found ${sentOccs.length} sentences containing "${target}". Choose one to remove:`,
          candidates: sentOccs.map((s) => ({ ...s, targetScope: 'sentence' as const })),
          aiMode: analysis.analysisMode,
        };
      }
      const chosenList = isAll
        ? [...sentOccs].sort((a, b) => b.sourceStart - a.sourceStart)
        : [isSecond && sentOccs.length >= 2 ? sentOccs[1] : isLast ? sentOccs[sentOccs.length - 1] : sentOccs[0]];
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Remove sentence(s) containing "${target}" (${chosenList
          .map((c) => `${formatTimecode(c.sourceStart)}–${formatTimecode(c.sourceEnd)}`)
          .join(', ')}).`,
        operations: chosenList.map((c) => ({
          type: 'REMOVE_RANGE' as const,
          label: `Remove Sentence ("${target}")`,
          targetScope: 'sentence' as const,
          targetText: c.snippet,
          sourceStart: c.sourceStart,
          sourceEnd: c.sourceEnd,
        })),
        aiMode: analysis.analysisMode,
      };
    }
  }

  const discussionMatch = p.match(
    /(?:remove|delete|cut|drop)\s+(?:the\s+)?(?:discussion|conversation|talk|portion|part|section|segment)\s+(?:about|on|regarding|covering)\s+["'`]?([^"'`?.!]+)["'`]?/iu,
  );
  if (discussionMatch && discussionMatch[1]) {
    const topicPhrase = discussionMatch[1].trim();
    const discussions = findDiscussionOccurrences(analysis, state, topicPhrase);
    if (discussions.length > 0) {
      const isAll = /\b(every|all)\b/i.test(lower);
      const isSecond = /\b(second|2nd)\b/i.test(lower);
      const isLast = /\b(last)\b/i.test(lower);
      const chosenList =
        discussions.length === 1 || isAll
          ? [...discussions].sort((a, b) => b.sourceStart - a.sourceStart)
          : [
              isSecond && discussions.length >= 2
                ? discussions[1]
                : isLast
                  ? discussions[discussions.length - 1]
                  : discussions[0],
            ];
      if (discussions.length > 1 && !isAll && !isSecond && !isLast) {
        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `Found ${discussions.length} segments discussing "${topicPhrase}".`,
          operations: [],
          requiresClarification: true,
          clarificationQuestion: `Found ${discussions.length} discussion segments about "${topicPhrase}". Select which to remove:`,
          candidates: discussions.map((d) => ({ ...d, targetScope: 'segment' as const })),
          aiMode: analysis.analysisMode,
        };
      }
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Remove discussion about "${topicPhrase}" (${chosenList
          .map((d) => `${formatTimecode(d.sourceStart)}–${formatTimecode(d.sourceEnd)}`)
          .join(', ')}).`,
        operations: chosenList.map((d) => ({
          type: 'REMOVE_RANGE' as const,
          label: `Remove Discussion: ${topicPhrase}`,
          targetScope: 'segment' as const,
          targetText: topicPhrase,
          sourceStart: d.sourceStart,
          sourceEnd: d.sourceEnd,
        })),
        aiMode: analysis.analysisMode,
      };
    }
  }

  if (/^\s*(?:bleep|censor)\b|\bbleep out\b|\bmute\s+(?:the\s+)?(?:word|phrase|second|first|third|last|every|all)\b/i.test(lower)) {
    const isBleep = /bleep|censor/i.test(lower);
    const wordTarget = extractTargetWordFromPrompt(p);
    if (wordTarget) {
      const occs = findWordOccurrences(analysis, state, wordTarget);
      if (occs.length > 0) {
        const isAll = /\b(every|all)\b/i.test(lower);
        const isFirst = /\b(first|1st)\b/i.test(lower);
        const isSecond = /\b(second|2nd)\b/i.test(lower);
        const isThird = /\b(third|3rd)\b/i.test(lower);
        const isLast = /\b(last)\b/i.test(lower);

        if (occs.length > 1 && !isAll && !isFirst && !isSecond && !isThird && !isLast) {
          return {
            id: createPlanId(),
            prompt: p,
            intentSummary: `Found ${occs.length} spoken occurrences of "${wordTarget}". Choose which one to ${isBleep ? 'bleep' : 'mute'}.`,
            operations: [],
            requiresClarification: true,
            clarificationQuestion: `Found ${occs.length} occurrences of "${wordTarget}". Select which exact occurrence to ${isBleep ? 'bleep' : 'mute'}:`,
            candidates: occs.map((c) => ({ ...c, targetScope: 'word' as const })),
            aiMode: analysis.analysisMode,
          };
        }

        const targets = isAll
          ? occs
          : [
              isSecond && occs.length >= 2
                ? occs[1]
                : isThird && occs.length >= 3
                  ? occs[2]
                  : isLast
                    ? occs[occs.length - 1]
                    : occs[0],
            ];

        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `${isBleep ? 'Bleep' : 'Mute'} "${wordTarget}" at ${targets
            .map((t) => `${formatTimecode(t.timelineStart ?? t.sourceStart)}–${formatTimecode(t.timelineEnd ?? t.sourceEnd)}`)
            .join(', ')} while keeping video uninterrupted.`,
          operations: targets.map((t) => ({
            type: isBleep ? ('BLEEP_RANGE' as const) : ('MUTE_RANGE' as const),
            label: `${isBleep ? 'Bleep' : 'Mute'} "${t.wordText}"`,
            targetScope: 'word' as const,
            targetText: t.wordText,
            targetSpeaker: t.speaker,
            sourceStart: t.sourceStart,
            sourceEnd: t.sourceEnd,
          })),
          aiMode: analysis.analysisMode,
        };
      }
    }
  }

  const hasExplicitWordScope =
    /\bthe\s+words?\b|\bwords?\b|\boccurrences?\b|\bevery\b|\ball\b/i.test(lower) &&
    !/\b(filler words|pauses|silences|captions?|subtitles?|scene|scenes|section|sections|mention|mentions)\b/i.test(
      lower,
    );

  if (/remove|delete|cut|drop|omit/i.test(lower) && hasExplicitWordScope) {
    const speechStatusMsg = getSpeechAvailabilityMessage(analysis);
    if (speechStatusMsg && analysis.transcript.length === 0) {
      return {
        id: createPlanId(),
        prompt: rawPrompt.trim(),
        intentSummary: speechStatusMsg,
        operations: [],
        aiMode: analysis.analysisMode,
      };
    }
    const targetWord = extractTargetWordFromPrompt(p);
    if (targetWord) {
      const occs = findWordOccurrences(analysis, state, targetWord);
      if (occs.length === 0) {
        const partialNote =
          analysis.transcriptionStatus === 'partial'
            ? ` (Note: transcription is partial — ${analysis.chunkStats?.completed ?? 0}/${analysis.chunkStats?.total ?? 0} chunks completed; retry failed chunks to index remaining audio.)`
            : '';
        return {
          id: createPlanId(),
          prompt: rawPrompt.trim(),
          intentSummary:
            analysis.transcript.length === 0
              ? `No spoken words were detected in the completed transcript (${totalWords} words).`
              : `No active spoken occurrence of the word "${targetWord}" was found across ${totalWords} transcribed words in the current timeline.${partialNote}`,
          operations: [],
          aiMode: analysis.analysisMode,
        };
      }

      const isAll = /\b(every|all)\b/i.test(lower);
      const isFirst = /\b(first|1st)\b/i.test(lower);
      const isSecond = /\b(second|2nd)\b/i.test(lower);
      const isThird = /\b(third|3rd)\b/i.test(lower);
      const isLast = /\b(last)\b/i.test(lower);

      if (occs.length > 1 && !isAll && !isFirst && !isSecond && !isThird && !isLast) {
        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `Found ${occs.length} spoken occurrences of "${targetWord}". Choose an occurrence or remove all.`,
          operations: [],
          requiresClarification: true,
          clarificationQuestion: `The word "${targetWord}" appears ${occs.length} times. Select the exact occurrence to remove (only the spoken word interval will be cut):`,
          candidates: occs.map((c) => ({ ...c, targetScope: 'word' as const })),
          aiMode: analysis.analysisMode,
        };
      }

      const chosenList = isAll
        ? [...occs].sort((a, b) => b.sourceStart - a.sourceStart)
        : [
            isSecond && occs.length >= 2
              ? occs[1]
              : isThird && occs.length >= 3
                ? occs[2]
                : isLast
                  ? occs[occs.length - 1]
                  : occs[0],
          ];

      const summaryIntervals = [...chosenList]
        .reverse()
        .map((c) => `${formatTimecode(c.sourceStart)}–${formatTimecode(c.sourceEnd)}`)
        .join(', ');

      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Remove the word "${targetWord}" at ${summaryIntervals}. All surrounding speech preserved.`,
        operations: [
          {
            type: 'REMOVE_WORD',
            label:
              chosenList.length > 1
                ? `Remove All "${targetWord}" (${chosenList.length})`
                : `Remove Word "${targetWord}"`,
            targetScope: 'word',
            targetText: targetWord,
            targetSpeaker: chosenList[0].speaker,
            removeRanges: chosenList.map((c) => ({
              start: c.sourceStart,
              end: c.sourceEnd,
              label: `Word "${c.wordText}"`,
              targetText: c.wordText,
            })),
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  const timeRangeMatch = lower.match(
    /(?:remove|delete|cut|trim)\s+(?:from\s+)?(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?)?)\s+(?:to|until|through|-)\s+(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:s|sec|secs|seconds?)?)/i,
  );
  if (timeRangeMatch) {
    const t1 = parseTimestampToken(timeRangeMatch[1]);
    const t2 = parseTimestampToken(timeRangeMatch[2]);
    if (t1 !== null && t2 !== null && t2 > t1) {
      const s = Math.max(0, Math.min(t1, analysis.durationSec - 0.1));
      const e = Math.min(analysis.durationSec, Math.max(s + 0.1, t2));
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Remove exact timestamp range ${formatTimecode(s)}–${formatTimecode(e)}.`,
        operations: [
          {
            type: 'REMOVE_RANGE',
            label: `Remove ${formatTimecode(s)}–${formatTimecode(e)}`,
            targetScope: 'timestamp',
            sourceStart: s,
            sourceEnd: e,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  const sceneNumMatch = lower.match(/(?:remove|delete|cut)\s+(?:the\s+)?scene\s+#?(\d+)/i);
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    const sc = analysis.scenes[idx];
    if (sc) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Remove Scene ${idx + 1}: "${sc.title}" (${formatTimecode(sc.start)}–${formatTimecode(sc.end)}).`,
        operations: [
          {
            type: 'REMOVE_RANGE',
            label: `Remove Scene ${idx + 1}`,
            targetScope: 'scene',
            sourceStart: sc.start,
            sourceEnd: sc.end,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  if (/caption|subtitle/i.test(lower)) {
    const ops: EditOperation[] = [];
    if (/hide|off|disable|remove/i.test(lower)) {
      ops.push({ type: 'ENABLE_CAPTIONS', label: 'Hide Captions', captionEnabled: false });
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: 'Turn off captions across the timeline.',
        operations: ops,
        aiMode: analysis.analysisMode,
      };
    }

    const colorMap: Record<string, string> = {
      yellow: '#FACC15',
      cyan: '#22D3EE',
      white: '#FFFFFF',
      green: '#34D399',
      pink: '#F472B6',
      orange: '#FB923C',
    };
    const matchedColor = Object.keys(colorMap).find((c) => lower.includes(c));
    const position = lower.includes('top')
      ? 'top'
      : lower.includes('center') || lower.includes('middle')
        ? 'center'
        : undefined;
    const mode = /word[\s-]*(?:by[\s-]*word|level|mode)/i.test(lower)
      ? 'word'
      : /sentence/i.test(lower)
        ? 'sentence'
        : undefined;

    if (matchedColor || position || mode || /large|bigger/i.test(lower) || /small/i.test(lower)) {
      ops.push({
        type: 'STYLE_CAPTIONS',
        label: 'Update Caption Style',
        captionStylePatch: {
          ...(matchedColor ? { color: colorMap[matchedColor] } : {}),
          ...(position ? { position } : {}),
          ...(mode ? { mode } : {}),
          ...(/large|bigger/i.test(lower) ? { fontSize: 28 } : {}),
          ...(/small/i.test(lower) ? { fontSize: 18 } : {}),
        },
      });
    } else if (state.captions.length === 0 && analysis.transcript.length > 0) {
      ops.push({
        type: 'GENERATE_CAPTIONS',
        label: 'Generate Synced Captions',
      });
    } else {
      ops.push({
        type: 'ENABLE_CAPTIONS',
        label: 'Enable Captions Across Video',
        captionEnabled: true,
      });
    }
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: matchedColor
        ? `Update caption text color to ${matchedColor} and enable captions.`
        : mode
          ? `Switch captions to ${mode}-level display and enable captions.`
          : 'Enable word-synced captions across the entire timeline.',
      operations: ops,
      aiMode: analysis.analysisMode,
    };
  }

  if (/noise|denoise|clean audio|hum|static/i.test(lower)) {
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: 'Enable FFmpeg audio noise reduction and spectral voice clarity.',
      operations: [
        {
          type: 'SET_AUDIO',
          label: 'Remove Background Noise',
          audioPatch: { noiseReduction: true },
        },
      ],
      aiMode: analysis.analysisMode,
    };
  }

  if (/music|soundtrack|bgm/i.test(lower)) {
    const off = /remove|disable|mute|off|stop/i.test(lower);
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: off
        ? 'Remove background music track.'
        : 'Add ambient background music bed with smooth fade in/out.',
      operations: [
        {
          type: 'SET_AUDIO',
          label: off ? 'Remove Background Music' : 'Add Background Music',
          audioPatch: { musicEnabled: !off },
        },
      ],
      aiMode: analysis.analysisMode,
    };
  }

  if (/mute audio|remove audio|silence video/i.test(lower)) {
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: 'Mute master project audio track.',
      operations: [{ type: 'SET_AUDIO', label: 'Mute Audio', audioPatch: { muted: true } }],
      aiMode: analysis.analysisMode,
    };
  }

  const overlayMatch = p.match(/(?:add|show|put)\s+(?:a\s+)?text\s+overlay\s+["']([^"']+)["']/i);
  if (overlayMatch) {
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: `Add text overlay "${overlayMatch[1]}" at current timeline start.`,
      operations: [
        {
          type: 'ADD_TEXT_OVERLAY',
          label: `Overlay "${overlayMatch[1]}"`,
          overlay: {
            text: overlayMatch[1],
            timelineStart: 0,
            timelineEnd: Math.min(5, state.duration),
            x: 50,
            y: 18,
            fontSize: 28,
            color: '#FFFFFF',
            backgroundColor: 'rgba(139, 92, 246, 0.78)',
          },
        },
      ],
      aiMode: analysis.analysisMode,
    };
  }

  if (/twice as fast|2x|speed|faster|slow motion|half speed|0\.5x/i.test(lower)) {
    const numMatch = lower.match(/([0-9]+(?:\.[0-9]+)?)\s*x/);
    const speed = /twice as fast/i.test(lower)
      ? 2.0
      : /slow motion|half speed/i.test(lower)
        ? 0.5
        : numMatch
          ? Math.min(4, Math.max(0.25, parseFloat(numMatch[1])))
          : 1.5;

    let targetSeg = state.segments[0];
    if (/intro|beginning|opening/i.test(lower)) {
      targetSeg = state.segments[0];
    } else if (/conclusion|ending|outro|closing/i.test(lower)) {
      targetSeg = state.segments[state.segments.length - 1];
    } else if (/demo|demonstration/i.test(lower)) {
      targetSeg =
        state.segments.find((s) => /demo/i.test(`${s.label} ${s.topic}`)) || state.segments[0];
    }

    if (targetSeg) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Set playback speed of "${targetSeg.label}" to ${speed}x.`,
        operations: [
          {
            type: 'SET_SPEED',
            label: `${speed}x Speed on ${targetSeg.label}`,
            targetScope: 'segment',
            segmentId: targetSeg.id,
            speed,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  if (/move|put|reorder/i.test(lower) && /beginning|start|front|first|end/i.test(lower)) {
    const moveEnd = /to the end/i.test(lower);
    let fromIdx = -1;
    if (/conclusion|outro|closing|cta|end/i.test(lower)) {
      fromIdx = state.segments.length - 1;
    } else if (/demo|demonstration/i.test(lower)) {
      fromIdx = state.segments.findIndex((s) => /demo/i.test(`${s.label} ${s.topic}`));
    } else if (/intro|opening/i.test(lower)) {
      fromIdx = 0;
    }

    if (fromIdx >= 0 && state.segments.length > 1) {
      const toIdx = moveEnd ? state.segments.length - 1 : 0;
      const seg = state.segments[fromIdx];
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Move "${seg.label}" to the ${moveEnd ? 'end' : 'beginning'} of the timeline.`,
        operations: [
          {
            type: 'REORDER_SEGMENT',
            label: `Move ${seg.label}`,
            targetScope: 'segment',
            fromIndex: fromIdx,
            toIndex: toIdx,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  const durMatch = lower.match(/(\d+)\s*[-\s]?seconds?/i);
  const makeShorter = /\b(make|cut|trim|shorten)\b.*\b(shorter|concise|tighter|highlights)\b/i.test(lower);
  if ((durMatch && /version|cut|edit|short|trim/i.test(lower)) || makeShorter) {
    const targetSec = durMatch
      ? Math.max(4, parseInt(durMatch[1], 10))
      : Math.max(4, Math.round(state.duration * 0.55));
    const sorted = [...analysis.transcript].sort((a, b) => {
      const scoreA = a.isImportant ? 2 : 1;
      const scoreB = b.isImportant ? 2 : 1;
      return scoreB - scoreA || a.start - b.start;
    });
    const picked: typeof analysis.transcript = [];
    let acc = 0;
    for (const seg of sorted) {
      const d = seg.end - seg.start;
      if (acc + d <= targetSec + 1.5 || picked.length === 0) {
        picked.push(seg);
        acc += d;
      }
    }
    picked.sort((a, b) => a.start - b.start);

    const keepRanges = picked.map((seg, i) => {
      if (picked.length === 1 && seg.end - seg.start > targetSec) {
        return { start: seg.start, end: seg.start + targetSec, label: seg.topic || 'Cut' };
      }
      if (i === picked.length - 1 && acc > targetSec) {
        const trimBy = Math.min(seg.end - seg.start - 1, acc - targetSec);
        return {
          start: seg.start,
          end: Math.max(seg.start + 1, seg.end - trimBy),
          label: seg.topic || `Segment ${i + 1}`,
        };
      }
      return { start: seg.start, end: seg.end, label: seg.topic || `Segment ${i + 1}` };
    });

    if (keepRanges.length > 0) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Create a ~${targetSec}-second edited version preserving high-priority content.`,
        operations: [
          {
            type: 'CREATE_DURATION_CUT',
            label: `${targetSec}s Version`,
            targetScope: 'segment',
            targetDurationSec: targetSec,
            keepRanges,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  if (/keep only|only keep|isolate/i.test(lower)) {
    const topicQuery = p
      .replace(/^(keep only|only keep|isolate)\s+(the\s+)?/i, '')
      .replace(/[.?!]+$/, '')
      .trim();
    const hits = searchMediaIndex(analysis, state.segments, topicQuery);
    const matchingTranscripts = analysis.transcript.filter((t) =>
      `${t.topic} ${t.text}`.toLowerCase().includes(topicQuery.toLowerCase()),
    );
    const keepList =
      matchingTranscripts.length > 0
        ? matchingTranscripts.map((t) => ({ start: t.start, end: t.end, label: t.topic }))
        : hits.slice(0, 2).map((h) => ({ start: h.sourceStart, end: h.sourceEnd, label: topicQuery }));

    if (keepList.length > 0) {
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Keep only sections matching "${topicQuery}" (${keepList.length} segment(s)).`,
        operations: [
          {
            type: 'KEEP_ONLY_RANGE',
            label: `Keep Only ${topicQuery}`,
            targetScope: 'segment',
            keepRanges: keepList,
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  if (/remove|delete|cut|drop/i.test(lower)) {
    const isAll = /\b(every|all)\b/i.test(lower);
    const isFirst = /\b(first|1st)\b/i.test(lower);
    const isSecond = /\b(second|2nd)\b/i.test(lower);
    const isThird = /\b(third|3rd)\b/i.test(lower);
    const isLast = /\b(last)\b/i.test(lower);

    const targetKeyword = lower
      .replace(
        /\b(remove|delete|cut|drop|only|the|first|second|third|1st|2nd|3rd|last|every|all|mention|mentions|of|section|part|segment|sentence|paragraph)\b/gi,
        ' ',
      )
      .replace(/[.?!]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (targetKeyword) {
      const candidates = findPhraseOccurrences(analysis, state, targetKeyword).filter(
        (c) => c.timelineStart !== null,
      );

      const hasExplicitSectionWord =
        /\b(mention|mentions|section|part|segment|scene|paragraph|sentence|intro|introduction|outro|conclusion)\b/i.test(
          lower,
        );
      if (!hasExplicitSectionWord && !targetKeyword.includes(' ')) {
        const wordOccs = findWordOccurrences(analysis, state, targetKeyword);
        if (wordOccs.length > 0) {
          if (wordOccs.length > 1 && !isAll && !isFirst && !isSecond && !isThird && !isLast) {
            return {
              id: createPlanId(),
              prompt: p,
              intentSummary: `Found ${wordOccs.length} occurrences of "${targetKeyword}". Choose which to remove.`,
              operations: [],
              requiresClarification: true,
              clarificationQuestion: `Multiple occurrences of "${targetKeyword}" found. Which one should be removed?`,
              candidates: wordOccs.map((w) => ({ ...w, targetScope: 'word' as const })),
              aiMode: analysis.analysisMode,
            };
          }
          const idx =
            isSecond && wordOccs.length >= 2
              ? 1
              : isThird && wordOccs.length >= 3
                ? 2
                : isLast
                  ? wordOccs.length - 1
                  : 0;
          const chosen = isAll ? wordOccs : [wordOccs[idx]];
          return {
            id: createPlanId(),
            prompt: p,
            intentSummary: `Remove "${targetKeyword}" at ${chosen.map((c) => formatTimecode(c.sourceStart)).join(', ')}.`,
            operations: [
              {
                type: 'REMOVE_WORD',
                label: `Remove "${targetKeyword}"`,
                targetScope: 'word',
                targetText: targetKeyword,
                removeRanges: [...chosen]
                  .sort((a, b) => b.sourceStart - a.sourceStart)
                  .map((c) => ({
                    start: c.sourceStart,
                    end: c.sourceEnd,
                    label: c.wordText,
                    targetText: c.wordText,
                  })),
              },
            ],
            aiMode: analysis.analysisMode,
          };
        }
      }

      if (candidates.length > 1 && !isFirst && !isSecond && !isThird && !isLast) {
        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `Found ${candidates.length} sections matching "${targetKeyword}". Please choose which occurrence to remove.`,
          operations: [],
          requiresClarification: true,
          clarificationQuestion: `Multiple sections mention "${targetKeyword}". Which timestamp should be removed?`,
          candidates,
          aiMode: analysis.analysisMode,
        };
      }

      if (candidates.length >= 1) {
        let idx = 0;
        if (isSecond && candidates.length >= 2) idx = 1;
        else if (isThird && candidates.length >= 3) idx = 2;
        else if (isLast) idx = candidates.length - 1;

        const chosen = candidates[idx];
        return {
          id: createPlanId(),
          prompt: p,
          intentSummary: `Remove "${chosen.label}" (${formatTimecode(chosen.sourceStart)}–${formatTimecode(chosen.sourceEnd)} source).`,
          operations: [
            {
              type: 'REMOVE_RANGE',
              label: `Remove ${chosen.label}`,
              targetScope: 'segment',
              sourceStart: chosen.sourceStart,
              sourceEnd: chosen.sourceEnd,
            },
          ],
          aiMode: analysis.analysisMode,
        };
      }
    }

    const secMatch = lower.match(/first\s+(\d+(?:\.\d+)?)\s+seconds?/i);
    if (secMatch) {
      const s = parseFloat(secMatch[1]);
      return {
        id: createPlanId(),
        prompt: p,
        intentSummary: `Trim the first ${s} seconds from the timeline.`,
        operations: [
          {
            type: 'REMOVE_RANGE',
            label: `Remove First ${s}s`,
            targetScope: 'timestamp',
            sourceStart: 0,
            sourceEnd: Math.min(s, analysis.durationSec - 0.5),
          },
        ],
        aiMode: analysis.analysisMode,
      };
    }
  }

  const searchHits = searchMediaIndex(analysis, state.segments, p);
  if (searchHits.length > 0) {
    return {
      id: createPlanId(),
      prompt: p,
      intentSummary: `Found ${searchHits.length} relevant section(s) matching your query. Choose one or refine your editing instruction.`,
      operations: [],
      searchQuery: p,
      requiresClarification: true,
      clarificationQuestion: `Did you want to remove, keep, or jump to one of these matching sections?`,
      candidates: searchHits.slice(0, 4).map((h) => ({
        id: h.id,
        label: h.matchType.toUpperCase(),
        snippet: h.snippet,
        speaker: h.speaker,
        sourceStart: h.sourceStart,
        sourceEnd: h.sourceEnd,
        timelineStart: h.timelineStart,
        timelineEnd: h.timelineEnd,
      })),
      aiMode: analysis.analysisMode,
    };
  }

  return {
    id: createPlanId(),
    prompt: p,
    intentSummary:
      'Could not map that instruction to a safe timeline edit. Try: "Remove the word important", "Remove unnecessary pauses", "Remove the second mention of pricing", "Make the introduction twice as fast", or "Change captions to yellow".',
    operations: [],
    aiMode: analysis.analysisMode,
  };
}

export function collectUncertainWordWarnings(
  plan: EditPlan,
  analysis: MediaAnalysis,
): UncertainWordWarning[] {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const op of plan.operations) {
    if (
      op.type === 'REMOVE_WORD' ||
      op.type === 'REMOVE_RANGE' ||
      op.type === 'MUTE_RANGE' ||
      op.type === 'BLEEP_RANGE'
    ) {
      if (op.sourceStart !== undefined && op.sourceEnd !== undefined) {
        ranges.push({ start: op.sourceStart, end: op.sourceEnd });
      }
      if (op.removeRanges) {
        for (const r of op.removeRanges) {
          ranges.push({ start: r.start, end: r.end });
        }
      }
    }
  }
  if (ranges.length === 0) return [];

  const warnings: UncertainWordWarning[] = [];
  const seenIds = new Set<string>();
  for (const seg of analysis.transcript) {
    const segHitsRange = ranges.some(
      (r) => Math.min(seg.end, r.end) - Math.max(seg.start, r.start) > 0.01,
    );
    if (!segHitsRange) continue;

    for (const w of seg.words || []) {
      if (w.verificationStatus !== 'review_needed' && w.verificationStatus !== 'unclear_audio') {
        continue;
      }
      if (seenIds.has(w.id)) continue;
      const overlaps = ranges.some(
        (r) => Math.min(w.end, r.end) - Math.max(w.start, r.start) > 0.015,
      );
      if (overlaps) {
        seenIds.add(w.id);
        warnings.push({
          wordId: w.id,
          word: w.word,
          sourceStart: w.start,
          sourceEnd: w.end,
          status: w.verificationStatus,
          confidence: w.confidence,
          candidates: w.candidates,
        });
        if (warnings.length >= 12) return warnings;
      }
    }
  }
  return warnings;
}

export function finalizePlanWithSafety(plan: EditPlan, analysis: MediaAnalysis): EditPlan {
  const warnings = collectUncertainWordWarnings(plan, analysis);
  if (warnings.length === 0) return plan;
  return {
    ...plan,
    requiresUncertainConfirmation: true,
    uncertainWordWarnings: warnings,
  };
}

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

export function buildSrtSubtitlesShared(
  state: ProjectState,
  translationTrack?: TranslationTrack | null,
): string {
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

export function buildVttSubtitlesShared(
  state: ProjectState,
  translationTrack?: TranslationTrack | null,
): string {
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
