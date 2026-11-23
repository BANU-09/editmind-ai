// node scripts/check-caption-audio.mjs results/
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const directory = process.argv[2];
const example = JSON.parse(fs.readFileSync(path.join(directory, 'replay-summary.json'))).entries.find(
  (e) => e.session === '01-editor-session',
);
function pcm(file, start) {
  const b = execFileSync('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-ss',
    String(start),
    '-i',
    file,
    '-t',
    '4',
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'f32le',
    '-',
  ]);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
const source = pcm('testpack/media/studio.mp4', 41),
  rendered = pcm(path.join(directory, example.session, 'final.mp4'), 11);
let xx = 0,
  yy = 0,
  xy = 0,
  first = Infinity,
  last = -Infinity,
  block = 0;
for (let i = 0; i < Math.min(source.length, rendered.length); i++) {
  const x = source[i],
    y = rendered[i];
  xx += x * x;
  yy += y * y;
  xy += x * y;
  block += y * y;
  if ((i + 1) % 160 === 0) {
    if (Math.sqrt(block / 160) > 0.01) {
      first = Math.min(first, i - 159);
      last = i + 1;
    }
    block = 0;
  }
}
const firstVoice = 11 + first / 16000,
  lastVoice = 11 + last / 16000;
const result = {
  method:
    '4 s source/output PCM correlation at zero lag after the 30 s cut; voice activity measured in 10 ms windows above -40 dBFS RMS.',
  window: { sourceStart: 41, renderedStart: 11, duration: 4 },
  firstVoice,
  lastVoice,
  captionVisible: [example.redCaption.firstSeconds, example.redCaption.endExclusiveSeconds],
  startDifferenceMs: 1000 * (example.redCaption.firstSeconds - firstVoice),
  endDifferenceMs: 1000 * (example.redCaption.endExclusiveSeconds - lastVoice),
  sourceOutputPcmCorrelation: xy / Math.sqrt(xx * yy),
};
assert.ok(result.sourceOutputPcmCorrelation > 0.99, 'Spoken source and output diverged at the declared edit');
assert.ok(
  Math.max(Math.abs(result.startDifferenceMs), Math.abs(result.endDifferenceMs)) <= 1000 / example.output.fps,
  'Caption differs from acoustic phrase by over one output frame',
);
fs.writeFileSync(path.join(directory, 'caption-audio.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
