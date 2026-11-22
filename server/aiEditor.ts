import {converse,type Turn} from './conversation';
import {
  deterministicPlan,
  finalizePlanWithSafety,
  normalizePromptSpacing,
} from '../src/shared/deterministicPlanner';
import type { EditPlan, MediaAnalysis, ProjectState } from '../src/shared/types';
import { getGeminiClient } from './geminiClient';

export { normalizePromptSpacing };

export async function planEditFromPrompt(
  prompt: string,
  state: ProjectState,
  analysis: MediaAnalysis,
  history: Turn[] = [],
): Promise<EditPlan> {
  const ai=getGeminiClient();
  if (!ai) {
    if (process.env.NODE_ENV==='test') return finalizePlanWithSafety(deterministicPlan(prompt,state,analysis),analysis);
    throw new Error('No editing model is configured for this server.');
  }
  return converse(prompt,state,analysis,history,async(system,input)=>{
    const response=await ai.models.generateContent({model:process.env.EDIT_PLANNER_MODEL||'gemini-2.5-flash',contents:input,
      config:{systemInstruction:system,responseMimeType:'application/json',temperature:0.15}});
    return response.text||'';
  });
}
