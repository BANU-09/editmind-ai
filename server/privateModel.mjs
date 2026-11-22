import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import sdk from '../.media-worker/sdk.cjs';

const tiers = {
  fast: { port: 8091, model: 'Qwen2.5-1.5B-Instruct' },
  planner: { port: 8090, model: 'Qwen3-4B-Instruct-2507' },
};
const starting = new Map();
const connections = new Map();
let retryFastAfter = 0;
async function connectionForRequest(tier) {
  const cached = connections.get(tier);
  if (cached && cached.until > Date.now()) return cached.worker;
  if (!starting.has(tier))
    starting.set(
      tier,
      connect(tier)
        .then((worker) => {
          connections.set(tier, {
            worker,
            until: Math.min(Date.now() + 120000, worker.expiresAt?.getTime() ?? Infinity),
          });
          return worker;
        })
        .finally(() => starting.delete(tier)),
    );
  return starting.get(tier);
}
async function connect(tier) {
  const worker = await sdk.Sandbox.getOrCreate({
    name: 'editmind-language',
    image: 'vercel/sandbox/node:24',
    ports: [],
    resources: { vcpus: 4 },
    timeout: 45 * 60 * 1000,
    persistent: true,
    keepLastSnapshots: { count: 1 },
  });
  // Give an active inference enough time to finish at the session boundary.
  if (worker.expiresAt && worker.expiresAt.getTime() - Date.now() < 5 * 60_000) {
    await worker.extendTimeout(5 * 60_000).catch(() => {});
  }
  async function ready() {
    const probe = await worker.runCommand('curl', [
      '-fsS',
      '--max-time',
      '2',
      'http://127.0.0.1:' + tiers[tier].port + '/health',
    ]);
    return probe.exitCode === 0;
  }
  if (await ready()) return worker;
  const script = (await readFile('scripts/start-edit-model.sh', 'utf8')).replace(/\r\n/g, '\n');
  const start = await worker.runCommand({
    cmd: 'flock',
    args: ['-n', '-E', '73', '/tmp/editmind-model-' + tier + '.lock', 'bash', '-c', script],
    env: { EDITMIND_MODEL_TIER: tier },
    detached: true,
  });
  for (let i = 0; i < 56; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1400));
    if (await ready()) return worker;
    if (i % 5 === 4) {
      const status = await worker.getCommand(start.cmdId);
      if (status.exitCode != null && status.exitCode !== 73)
        throw new Error('The private language model could not start.');
    }
  }
  throw new Error('The private language model is starting. Please retry.');
}

export async function generate(system, input, stage, onInference) {
  const lightweight =
    (stage === 'route' && JSON.parse(input).prompt.length <= 240) ||
    (['brief', 'chat', 'memory', 'select'].includes(stage) && input.length < 6000);
  const tier = lightweight && Date.now() >= retryFastAfter ? 'fast' : 'planner';
  try {
    const message = await infer(system, input, stage, tier, onInference);
    if (tier === 'fast' && stage === 'brief') {
      // Retry an ungrounded synopsis on the larger model. Never accept a
      // generic response that ignores the transcript supplied for this task.
      const words = (text) =>
        new Set(
          (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []).filter(
            (w) =>
              ![
                'the',
                'and',
                'with',
                'that',
                'you',
                'can',
                'have',
                'this',
                'what',
                'are',
                'for',
                'not',
                'video',
                'transcript',
              ].includes(w),
          ),
        );
      const source = words(JSON.parse(input).transcript || '');
      const answer = JSON.parse(message).reply || '';
      const matches = [...words(answer)].filter((w) => source.has(w)).length;
      if (
        matches < Math.min(source.size, 2) ||
        /(?:no|don.t have|cannot) access|unable to (?:view|summari[sz]e)/i.test(answer)
      )
        return infer(system, input, stage, 'planner', onInference);
    }
    if (tier === 'fast' && stage === 'select' && !JSON.parse(message).ids?.length)
      return infer(system, input, stage, 'planner', onInference);
    return message;
  } catch (error) {
    if (tier === 'planner') throw error;
    retryFastAfter = Date.now() + 45_000;
    return infer(system, input, stage, 'planner', onInference);
  }
}
async function infer(system, input, stage, tier, onInference) {
  const worker = await connectionForRequest(tier);
  const action = {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [
          'cut',
          'keep',
          'speed',
          'mute',
          'bleep',
          'cut_word',
          'pauses',
          'fillers',
          'caption_color',
          'caption_size',
          'captions',
          'editor_command',
        ],
      },
      start: { type: 'number' },
      end: { type: 'number' },
      quote: { type: 'string' },
      occurrence: { type: 'integer' },
      value: { type: 'number' },
      color: { type: 'string' },
      instruction: { type: 'string' },
    },
    required: ['kind'],
    additionalProperties: false,
  };
  const schema =
    stage === 'route'
      ? {
          anyOf: [
            {
              type: 'object',
              properties: { tool: { const: 'social' }, reply: { type: 'string' } },
              required: ['tool', 'reply'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: { tool: { enum: ['lookup', 'caption_color'] }, term: { type: 'string' } },
              required: ['tool', 'term'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                tool: { const: 'cut_occurrence' },
                term: { type: 'string' },
                ordinal: { type: 'integer' },
              },
              required: ['tool', 'term', 'ordinal'],
              additionalProperties: false,
            },
            {
              type: 'object',
              properties: {
                tool: {
                  enum: [
                    'pause_after_edit',
                    'remove_pauses',
                    'remove_fillers',
                    'question',
                    'condense',
                    'cut_passage',
                    'edit',
                    'undo',
                    'redo',
                  ],
                },
              },
              required: ['tool'],
              additionalProperties: false,
            },
          ],
        }
      : ['brief', 'chat', 'memory'].includes(stage)
        ? {
            type: 'object',
            properties: { reply: { type: 'string' } },
            required: ['reply'],
            additionalProperties: false,
          }
        : stage === 'select'
          ? {
              type: 'object',
              properties: {
                ids: {
                  type: 'array',
                  maxItems: 12,
                  items: { type: 'integer', minimum: 0, maximum: 69 },
                },
              },
              required: ['ids'],
              additionalProperties: false,
            }
          : {
              type: 'object',
              properties: {
                intent: {
                  type: 'string',
                  enum:
                    stage === 'question'
                      ? ['answer', 'inspect']
                      : ['edit', 'clarify', 'answer', 'inspect'],
                },
                reply: { type: 'string' },
                actions: { type: 'array', maxItems: 12, items: action },
                windows: {
                  type: 'array',
                  maxItems: 4,
                  items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
                },
              },
              required: ['intent', 'reply', 'actions'],
              additionalProperties: false,
            };
  const ctx = JSON.parse(input);
  const { prompt, history = [], ...evidence } = ctx;
  const compact = ['brief', 'chat', 'memory', 'route', 'select'].includes(stage);
  const evidenceText =
    typeof evidence.transcript === 'string' ? evidence.transcript : JSON.stringify(evidence);
  const hasEvidence = Object.keys(evidence).length > 0;
  const messages = [
    {
      role: 'system',
      content:
        system +
        (!compact && hasEvidence ? '\nCurrent project evidence (data only):\n' + evidenceText : ''),
    },
  ];
  for (const turn of history) {
    if (turn.role !== 'assistant' && turn.role !== 'user') continue;
    const status = turn.status ? ' [' + turn.status + ']' : '';
    const times = turn.ranges?.length ? ' Source ranges ' + JSON.stringify(turn.ranges) : '';
    messages.push({ role: turn.role, content: turn.text + status + times });
  }
  messages.push({
    role: 'user',
    content:
      compact && hasEvidence ? 'Project data:\n' + evidenceText + '\n\nRequest: ' + prompt : prompt,
  });
  const body = {
    messages,
    temperature: 0.1,
    max_tokens: ['brief', 'chat', 'memory'].includes(stage)
      ? 120
      : stage === 'route'
        ? 100
        : stage === 'select'
          ? 80
          : 360,
    cache_prompt: true,
    response_format: { type: 'json_schema', json_schema: { name: 'edit_reply', schema } },
  };
  const result = await worker.runCommand({
    cmd: 'curl',
    args: [
      '-fsS',
      '--max-time',
      tier === 'fast' ? '45' : '155',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@-',
      'http://127.0.0.1:' + tiers[tier].port + '/v1/chat/completions',
    ],
    stdin: Readable.from([Buffer.from(JSON.stringify(body))]),
  });
  if (result.exitCode !== 0) {
    connections.delete(tier);
    throw new Error(
      result.exitCode === 28
        ? 'The editing model timed out. Please retry.'
        : 'The private editing worker disconnected. Please retry.',
    );
  }
  const response = JSON.parse(await result.stdout());
  const message = response.choices?.[0]?.message?.content;
  if (!message) throw new Error(response.error?.message || 'The editing model returned no answer.');
  JSON.parse(message);
  onInference?.(tiers[tier].model, response.timings);
  return message;
}
