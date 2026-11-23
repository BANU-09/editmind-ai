import planner from '../.media-worker/planner.cjs';
import hosting from '../config/hosted.json' with {type:'json'};
import { generate } from '../server/privateModel.mjs';
const { planResponse } = planner;

// Cache discovery only. Check ownership and load the current project on every turn.
let cachedOrigin;
let discovering;
async function mediaOrigin(refresh = false) {
  if (!refresh && cachedOrigin && cachedOrigin.until > Date.now()) return cachedOrigin.url;
  discovering ??= (async () => {
    const url = new URL('/api/backend' + (refresh ? '?refresh=1' : ''), process.env.EDITMIND_PUBLIC_ORIGIN || hosting.publicOrigin);
    const lookup = await fetch(url, { signal: AbortSignal.timeout(150000) });
    if (!lookup.ok) throw new Error('The media worker is unavailable.');
    const { origin } = await lookup.json();
    if (!/^https:\/\/[\w-]+\.vercel\.run$/.test(origin))
      throw new Error('The media worker address is invalid.');
    cachedOrigin = { url: origin, until: Date.now() + 30_000 };
    return origin;
  })().finally(() => {
    discovering = undefined;
  });
  return discovering;
}
async function readProject(id, headers) {
  const get = async (refresh) =>
    fetch(
      (await mediaOrigin(refresh)) + '/api/projects/' + encodeURIComponent(id) + '/assistant-context',
      { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) },
    );
  let response;
  try {
    response = await get(false);
  } catch {
    return get(true);
  }
  if ([502, 503, 504].includes(response.status)) return get(true);
  return response;
}

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
    const started = performance.now();
    const headers = {};
    for (const k of ['authorization', 'x-guest-id', 'cookie'])
      if (req.headers[k]) headers[k] = req.headers[k];
    const info = await readProject(projectId, headers);
    if (!info.ok)
      return res.status(info.status).json({ error: 'The project context could not be loaded.' });
    const { state, analysis } = await info.json();
    const timings = ['context;dur=' + Math.round(performance.now() - started)];
    const providers = new Set();
    const timedGenerate = async (system, input, stage) => {
      const t = performance.now();
      try {
        return await generate(system, input, stage, (model, perf) => {
          providers.add(model);
          if (Number.isFinite(perf?.prompt_ms))
            timings.push(stage + '-prefill;dur=' + Math.round(perf.prompt_ms));
          if (Number.isFinite(perf?.predicted_ms))
            timings.push(stage + '-decode;dur=' + Math.round(perf.predicted_ms));
        });
      } finally {
        timings.push((stage || 'model') + ';dur=' + Math.round(performance.now() - t));
      }
    };
    const result = await planResponse(
      prompt,
      { ...state, ...currentState },
      analysis,
      history,
      timedGenerate,
    );
    result.plan.aiMode = 'local-llm';
    result.plan.provider = [...providers].join(' + ');
    res.setHeader(
      'Server-Timing',
      [...timings, 'total;dur=' + Math.round(performance.now() - started)].join(', '),
    );
    return res.json(result);
  } catch (err) {
    return res.status(503).json({ error: err.message || 'The AI provider is unavailable.' });
  }
}
