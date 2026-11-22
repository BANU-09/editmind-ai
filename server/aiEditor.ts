import { ThinkingLevel, Type } from '@google/genai';
import { v4 as uuid } from 'uuid';
import {
  deterministicPlan,
  finalizePlanWithSafety,
  normalizePromptSpacing,
  stemTopicWord,
} from '../src/shared/deterministicPlanner';
import { validateEditPlan } from '../src/shared/timelineEngine';
import type { EditOperation, EditPlan, MediaAnalysis, ProjectState } from '../src/shared/types';
import { getAppConfig } from './config';
import { getGeminiClient, withTimeout } from './geminiClient';

export { normalizePromptSpacing };

export async function planEditFromPrompt(
  prompt: string,
  state: ProjectState,
  analysis: MediaAnalysis,
): Promise<EditPlan> {
  const localPlan = deterministicPlan(prompt, state, analysis);

  // Enforce strict bounds & single-word guard on deterministic plans
  const localCheck = validateEditPlan(analysis, localPlan);
  if (!localCheck.valid) {
    return {
      ...localPlan,
      operations: [],
      validationError: localCheck.reason,
      intentSummary: localCheck.reason || 'Edit rejected by validation.',
    };
  }

  const ai = getGeminiClient();
  if (!ai) {
    return finalizePlanWithSafety(localPlan, analysis);
  }

  if (
    localPlan.operations.length > 0 ||
    localPlan.searchQuery ||
    localPlan.requiresClarification ||
    /\bundo\b/i.test(prompt)
  ) {
    return finalizePlanWithSafety({ ...localPlan, aiMode: 'gemini-ai' }, analysis);
  }

  try {
    const cfg = getAppConfig();
    const promptTokens = prompt
      .toLowerCase()
      .split(/\s+/)
      .map(stemTopicWord)
      .filter((t) => t.length >= 3);

    // Optimize context for 60-min (~10k words) transcripts so LLM planning finishes in <3s
    const scoredSegments = analysis.transcript.map((t, idx) => {
      const hay = `${t.topic || ''} ${t.text}`.toLowerCase();
      let score = 0;
      for (const tok of promptTokens) {
        if (hay.includes(tok)) score += 1;
      }
      return { t, idx, score };
    });

    const topMatchedIds = new Set(
      scoredSegments
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12)
        .map((s) => s.t.id),
    );

    const compactTranscript =
      analysis.transcript.length > 80
        ? scoredSegments
            .filter((s, _, arr) => s.score > 0 || s.idx < 15 || s.idx >= arr.length - 10)
            .slice(0, 80)
            .map(({ t }) => ({
              id: t.id,
              start: t.start,
              end: t.end,
              topic: t.topic,
              speaker: t.speaker,
              text: t.text,
              ...(topMatchedIds.has(t.id)
                ? {
                    words: (t.words || []).map((w) => ({
                      word: w.word,
                      start: w.start,
                      end: w.end,
                    })),
                  }
                : {}),
            }))
        : analysis.transcript.map((t) => ({
            id: t.id,
            start: t.start,
            end: t.end,
            topic: t.topic,
            speaker: t.speaker,
            text: t.text,
            words:
              analysis.transcript.length <= 40 || topMatchedIds.has(t.id)
                ? (t.words || []).map((w) => ({ word: w.word, start: w.start, end: w.end }))
                : undefined,
          }));

    const resp = await withTimeout(
      ai.models.generateContent({
        model: cfg.editPlannerModel,
        contents: `You are EDITMIND AI's precision prompt-to-edit planner.
CRITICAL RULES:
- For single-word deletions/removals ("remove the word X"), emit type "REMOVE_WORD" with targetScope "word", targetText "X", and exact [sourceStart, sourceEnd] from the matching token in words[] (NEVER delete an entire multi-second sentence when only one word was requested!).
- Never invent timestamps outside [0, ${analysis.durationSec}].
- Never emit cuts > 2.5s when targetScope is "word".

User instruction: "${prompt}"

Transcript & word timestamps:
${JSON.stringify(compactTranscript)}

Silences:
${JSON.stringify(analysis.silences.slice(0, 30))}

Current timeline segments:
${JSON.stringify(state.segments.slice(0, 120).map((s) => ({ id: s.id, label: s.label, sourceStart: s.sourceStart, sourceEnd: s.sourceEnd })))}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              intentSummary: { type: Type.STRING },
              requiresClarification: { type: Type.BOOLEAN },
              clarificationQuestion: { type: Type.STRING },
              searchQuery: { type: Type.STRING },
              operations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: { type: Type.STRING },
                    label: { type: Type.STRING },
                    targetScope: { type: Type.STRING },
                    targetText: { type: Type.STRING },
                    sourceStart: { type: Type.NUMBER },
                    sourceEnd: { type: Type.NUMBER },
                    segmentId: { type: Type.STRING },
                    fromIndex: { type: Type.INTEGER },
                    toIndex: { type: Type.INTEGER },
                    speed: { type: Type.NUMBER },
                    captionEnabled: { type: Type.BOOLEAN },
                  },
                },
              },
            },
          },
        },
      }),
      Math.min(cfg.sttTimeoutMs, 12000),
      'Gemini edit planner',
    );

    const parsed = JSON.parse((resp.text || '{}').trim()) as {
      intentSummary?: string;
      requiresClarification?: boolean;
      clarificationQuestion?: string;
      searchQuery?: string;
      operations?: EditOperation[];
    };

    if (parsed.operations && parsed.operations.length > 0) {
      const candidatePlan: EditPlan = {
        id: uuid(),
        prompt,
        intentSummary: parsed.intentSummary || localPlan.intentSummary,
        operations: parsed.operations,
        requiresClarification: Boolean(parsed.requiresClarification),
        clarificationQuestion: parsed.clarificationQuestion,
        searchQuery: parsed.searchQuery,
        aiMode: 'gemini-ai',
      };

      const check = validateEditPlan(analysis, candidatePlan);
      if (!check.valid) {
        return {
          ...candidatePlan,
          operations: [],
          validationError: check.reason,
          intentSummary: check.reason || 'AI plan rejected by word-level safety validation.',
        };
      }
      return finalizePlanWithSafety(candidatePlan, analysis);
    }
  } catch (err) {
    console.warn('Gemini edit planner fallback triggered:', err);
  }

  return finalizePlanWithSafety(localPlan, analysis);
}
