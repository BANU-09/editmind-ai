import planner from '../.media-worker/planner.cjs';
import { generate } from '../server/privateModel.mjs';
const { planResponse } = planner;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  const { projectId, prompt, history = [], currentState } = req.body || {};
  if (
    !/^prj-[\w-]+$/.test(projectId || '') ||
    typeof prompt !== 'string' ||
    !prompt.trim() ||
    prompt.length > 8000 ||
    !Array.isArray(history)
  )
    return res
      .status(400)
      .json({ error: 'A project and a prompt of up to 8000 characters are required.' });
  try {
    const lookup = await fetch('https://editmind-ai-banu09.vercel.app/api/backend', {
      signal: AbortSignal.timeout(150000),
    });
    if (!lookup.ok) throw new Error('The media worker is unavailable.');
    const { origin } = await lookup.json();
    if (!/^https:\/\/[\w-]+\.vercel\.run$/.test(origin))
      throw new Error('The media worker address is invalid.');
    const headers = {};
    for (const k of ['authorization', 'x-guest-id', 'cookie'])
      if (req.headers[k]) headers[k] = req.headers[k];
    const info = await fetch(
      origin + '/api/projects/' + encodeURIComponent(projectId) + '/assistant-context',
      { headers, redirect: 'error' },
    );
    if (!info.ok)
      return res.status(info.status).json({ error: 'The project context could not be loaded.' });
    const { state, analysis } = await info.json();
    const result = await planResponse(
      prompt,
      { ...state, ...currentState },
      analysis,
      history,
      generate,
    );
    result.plan.aiMode = 'local-llm';
    result.plan.provider = 'Qwen3-4B-Instruct-2507';
    return res.json(result);
  } catch (err) {
    return res.status(503).json({ error: err.message || 'The AI provider is unavailable.' });
  }
}
