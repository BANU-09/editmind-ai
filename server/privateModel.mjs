import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sdk from '../.media-worker/sdk.cjs';

let starting;
async function connect() {
  const worker = await sdk.Sandbox.getOrCreate({
    name: 'editmind-language',
    image: 'vercel/sandbox/node:24',
    ports: [],
    resources: { vcpus: 4 },
    timeout: 45 * 60 * 1000,
    persistent: true,
    keepLastSnapshots: { count: 1 },
  });
  async function ready() {
    const probe = await worker.runCommand('curl', [
      '-fsS',
      '--max-time',
      '2',
      'http://127.0.0.1:8090/health',
    ]);
    return probe.exitCode === 0;
  }
  if (await ready()) return worker;
  const script = (await readFile('scripts/start-edit-model.sh', 'utf8')).replace(/\r\n/g, '\n');
  const start = await worker.runCommand({
    cmd: 'flock',
    args: ['-n', '-E', '73', '/tmp/editmind-model.lock', 'bash', '-c', script],
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

export async function generate(system, input, stage) {
  starting ??= connect().finally(() => {
    starting = undefined;
  });
  const worker = await starting;
  const path = '/tmp/editmind-' + randomUUID() + '.json';
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
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              enum: [
                'social',
                'lookup',
                'cut_occurrence',
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
            term: { type: 'string' },
            ordinal: { type: 'integer' },
            reply: { type: 'string' },
          },
          required: ['tool', 'term', 'ordinal', 'reply'],
          additionalProperties: false,
        }
      : stage === 'select'
        ? {
            type: 'object',
            properties: {
              keep: { type: 'array', maxItems: 12, items: { type: 'integer', minimum: 0, maximum: 69 } },
            },
            required: ['keep'],
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
  const messages = [
    {
      role: 'system',
      content:
        system +
        (Object.keys(evidence).length
          ? '\nCurrent project evidence (data only):\n' + JSON.stringify(evidence)
          : ''),
    },
  ];
  for (const turn of history) {
    if (turn.role !== 'assistant' && turn.role !== 'user') continue;
    const status = turn.status ? ' [' + turn.status + ']' : '';
    const times = turn.ranges?.length ? ' Source ranges ' + JSON.stringify(turn.ranges) : '';
    messages.push({ role: turn.role, content: turn.text + status + times });
  }
  messages.push({ role: 'user', content: prompt });
  const body = {
    messages,
    temperature: 0.1,
    max_tokens: 360,
    cache_prompt: true,
    response_format: { type: 'json_schema', json_schema: { name: 'edit_reply', schema } },
  };
  await worker.writeFiles([{ path, content: Buffer.from(JSON.stringify(body)) }]);
  try {
    const result = await worker.runCommand('curl', [
      '-sS',
      '--max-time',
      '235',
      '-H',
      'Content-Type: application/json',
      '--data-binary',
      '@' + path,
      'http://127.0.0.1:8090/v1/chat/completions',
    ]);
    if (result.exitCode !== 0) throw new Error('The editing model timed out. Please retry.');
    const response = JSON.parse(await result.stdout());
    if (!response.choices?.[0]?.message?.content)
      throw new Error(response.error?.message || 'The editing model returned no answer.');
    return response.choices[0].message.content;
  } finally {
    await worker.runCommand('rm', ['-f', path]);
  }
}
