export type MusicPreset = 'ambient-pulse' | 'cinematic-pad' | 'upbeat-synth';

// Original four-bar arrangements voiced as soft electric piano and bass.
// The editor and MP4 worker use the same PCM, including the loop point.
const arrangements = {
  'ambient-pulse': {
    bpm: 84,
    chords: [
      [50, 57, 60, 65],
      [46, 53, 57, 62],
      [48, 55, 59, 64],
      [45, 52, 55, 60],
    ],
    steps: [0, 3, 5, 7],
    decay: 0.85,
  },
  'cinematic-pad': {
    bpm: 70,
    chords: [
      [48, 55, 58, 63],
      [44, 51, 55, 62],
      [46, 53, 58, 62],
      [43, 50, 55, 59],
    ],
    steps: [0, 4, 6],
    decay: 1.65,
  },
  'upbeat-synth': {
    bpm: 110,
    chords: [
      [53, 57, 60, 64],
      [55, 59, 62, 66],
      [52, 55, 59, 62],
      [50, 53, 57, 60],
    ],
    steps: [0, 2, 3, 5, 6, 7],
    decay: 0.56,
  },
} satisfies Record<MusicPreset, unknown>;

export const musicSampleRate = 24000;
const cache = new Map<MusicPreset, Float32Array>();

export function musicLoop(preset: MusicPreset): Float32Array {
  const cached = cache.get(preset);
  if (cached) return cached;
  const { bpm, chords, steps, decay } = arrangements[preset];
  const beat = 60 / bpm;
  const samples = new Float32Array(Math.round(chords.length * 4 * beat * musicSampleRate));

  function note(midi: number, start: number, amplitude: number, sustain: number, attack: number) {
    const first = Math.round(start * musicSampleRate);
    const length = Math.ceil(sustain * 6 * musicSampleRate);
    const angularStep = ((2 * Math.PI * 440) / musicSampleRate) * 2 ** ((midi - 69) / 12);
    const ring = Math.exp(-1 / (musicSampleRate * sustain));
    const onset = Math.exp(-1 / (musicSampleRate * attack));
    let decayGain = amplitude,
      attackGain = 1;
    for (let i = 0; i < length; i++) {
      const phase = i * angularStep;
      const timbre = Math.sin(phase) + 0.22 * Math.sin(2 * phase) + 0.07 * Math.sin(3 * phase);
      samples[(first + i) % samples.length] += timbre * decayGain * (1 - attackGain);
      decayGain *= ring;
      attackGain *= onset;
    }
  }

  chords.forEach((chord, bar) => {
    const start = bar * 4 * beat;
    note(chord[0] - 12, start, 0.14, 1.1 * beat, 0.035);
    // Small stagger and tails crossing the loop point keep chord changes smooth.
    chord.slice(1).forEach((pitch, i) => note(pitch, start + i * 0.019, 0.052, 1.6 * beat, 0.12));
    steps.forEach((step, i) => {
      const pitch = chord[[1, 3, 2, 1, 3, 2][i] % chord.length];
      const accent = i % 2 === 0 ? 0.145 : 0.1;
      note(pitch + 12, start + (step * beat) / 2 + 0.013, accent, decay * beat, 0.013);
    });
  });
  cache.set(preset, samples);
  return samples;
}
