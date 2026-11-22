import demoKeynoteAudio from '../assets/audio/demo-keynote.mp3';
import demoMarketingAudio from '../assets/audio/demo-marketing.mp3';
import demoPodcastAudio from '../assets/audio/demo-podcast.mp3';
import demoTravelAudio from '../assets/audio/demo-travel.mp3';
import demoTutorialAudio from '../assets/audio/demo-tutorial.mp3';

export type SynthMusicPreset = 'ambient-pulse' | 'cinematic-pad' | 'upbeat-synth';

export const DEMO_BUNDLED_AUDIO: Record<string, string> = {
  'demo-keynote': demoKeynoteAudio,
  'demo-podcast': demoPodcastAudio,
  'demo-tutorial': demoTutorialAudio,
  'demo-travel': demoTravelAudio,
  'demo-marketing': demoMarketingAudio,
};

export function extractDemoId(input?: string | null): string | undefined {
  if (!input) return undefined;
  const match = input.match(/\b(demo-(?:keynote|podcast|tutorial|travel|marketing))\b/);
  return match?.[1];
}

export function getBundledAudioForDemo(demoIdOrUrl?: string | null): string | undefined {
  const id = extractDemoId(demoIdOrUrl);
  if (!id) return undefined;
  return DEMO_BUNDLED_AUDIO[id];
}

let sharedCtx: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedCtx) {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    try {
      sharedCtx = new AudioCtx();
    } catch {
      return null;
    }
  }
  return sharedCtx;
}

export function unlockAudioEngine(): AudioContext | null {
  const ctx = getSharedAudioContext();
  if (!ctx) return null;
  if (ctx.state === 'suspended') {
    void ctx.resume().catch(() => {});
  }
  return ctx;
}

const PRESET_CHORDS: Record<SynthMusicPreset, { bpm: number; filterHz: number; chords: number[][] }> = {
  'ambient-pulse': {
    bpm: 92,
    filterHz: 780,
    chords: [
      [146.83, 220.0, 261.63, 349.23], // Dm7
      [116.54, 174.61, 220.0, 293.66], // Bbmaj7
      [130.81, 196.0, 261.63, 329.63], // Cmaj
      [110.0, 164.81, 220.0, 261.63],  // Am7
    ],
  },
  'cinematic-pad': {
    bpm: 72,
    filterHz: 620,
    chords: [
      [130.81, 196.0, 233.08, 311.13], // Cm7
      [103.83, 155.56, 207.65, 293.66], // Abmaj7
      [116.54, 174.61, 233.08, 293.66], // Bb6
      [98.0, 146.83, 196.0, 246.94],   // Gsus/maj
    ],
  },
  'upbeat-synth': {
    bpm: 118,
    filterHz: 1450,
    chords: [
      [174.61, 220.0, 261.63, 329.63], // Fmaj7
      [196.0, 246.94, 293.66, 369.99], // G6
      [164.81, 196.0, 246.94, 293.66], // Em7
      [146.83, 174.61, 220.0, 261.63], // Dm7
    ],
  },
};

export class ProceduralMusicBed {
  constructor(private readonly output?: AudioNode) {}

  private masterGain: GainNode | null = null;
  private filter: BiquadFilterNode | null = null;
  private stepTimer: number | null = null;
  private stepIdx = 0;
  private running = false;
  private preset: SynthMusicPreset = 'ambient-pulse';
  private targetVolume = 0.25;

  private ensureNodes(ctx: AudioContext): boolean {
    if (!this.masterGain || this.masterGain.context !== ctx) {
      try {
        this.filter = ctx.createBiquadFilter();
        this.filter.type = 'lowpass';
        this.filter.frequency.value = PRESET_CHORDS[this.preset].filterHz;
        this.filter.Q.value = 1.1;

        this.masterGain = ctx.createGain();
        this.masterGain.gain.value = 0;

        this.filter.connect(this.masterGain);
        this.masterGain.connect(this.output ?? ctx.destination);
      } catch {
        return false;
      }
    }
    return true;
  }

  private triggerStep() {
    const ctx = getSharedAudioContext();
    if (!ctx || !this.filter || !this.masterGain || !this.running) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const cfg = PRESET_CHORDS[this.preset];
    this.filter.frequency.setTargetAtTime(cfg.filterHz, ctx.currentTime, 0.08);
    const stepDurSec = 60 / cfg.bpm / 2; // eighth-note pulse
    const chordIdx = Math.floor(this.stepIdx / 8) % cfg.chords.length;
    const notes = cfg.chords[chordIdx];
    const now = ctx.currentTime;

    // On every measure change, trigger warm sustained pad voices
    if (this.stepIdx % 8 === 0) {
      notes.slice(0, 3).forEach((freq, i) => {
        try {
          const osc = ctx.createOscillator();
          const vGain = ctx.createGain();
          osc.type = i === 0 ? 'triangle' : 'sine';
          osc.frequency.setValueAtTime(freq, now);
          const padDur = stepDurSec * 7.8;
          vGain.gain.setValueAtTime(0.0001, now);
          vGain.gain.linearRampToValueAtTime(i === 0 ? 0.28 : 0.16, now + 0.22);
          vGain.gain.exponentialRampToValueAtTime(0.001, now + padDur);
          osc.connect(vGain);
          vGain.connect(this.filter!);
          osc.start(now);
          osc.stop(now + padDur + 0.05);
        } catch {
          // Ignore individual voice errors
        }
      });
    }

    // Subtle rhythmic pulse or arpeggio pluck
    const arpFreq = notes[this.stepIdx % notes.length] * (this.preset === 'upbeat-synth' ? 2 : 1);
    const shouldPluck =
      this.preset === 'upbeat-synth'
        ? true
        : this.preset === 'ambient-pulse'
          ? this.stepIdx % 2 === 0
          : this.stepIdx % 4 === 0;

    if (shouldPluck) {
      try {
        const osc = ctx.createOscillator();
        const pGain = ctx.createGain();
        osc.type = this.preset === 'upbeat-synth' ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(arpFreq, now);
        const pluckDur = this.preset === 'upbeat-synth' ? stepDurSec * 0.85 : stepDurSec * 1.4;
        pGain.gain.setValueAtTime(0.0001, now);
        pGain.gain.linearRampToValueAtTime(this.preset === 'upbeat-synth' ? 0.22 : 0.14, now + 0.02);
        pGain.gain.exponentialRampToValueAtTime(0.001, now + pluckDur);
        osc.connect(pGain);
        pGain.connect(this.filter);
        osc.start(now);
        osc.stop(now + pluckDur + 0.04);
      } catch {
        // Ignore
      }
    }

    this.stepIdx = (this.stepIdx + 1) % 32;
  }

  public update(opts: {
    active: boolean;
    preset: SynthMusicPreset;
    volume: number; // 0..1
  }) {
    const presetChanged = this.preset !== opts.preset;
    this.preset = opts.preset;
    this.targetVolume = Math.max(0, Math.min(1, opts.volume));

    const ctx = getSharedAudioContext();
    if (!ctx || !this.ensureNodes(ctx) || !this.masterGain) return;

    if (!opts.active || this.targetVolume <= 0.005) {
      this.stop();
      return;
    }

    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    // Scale pleasant background mix level (0..0.55 linear gain)
    const gainLevel = Math.min(0.55, this.targetVolume * 0.55);
    this.masterGain.gain.setTargetAtTime(gainLevel, ctx.currentTime, 0.08);

    if (!this.running || presetChanged) {
      if (this.stepTimer !== null) {
        window.clearInterval(this.stepTimer);
        this.stepTimer = null;
      }
      this.running = true;
      this.stepIdx = 0;
      this.triggerStep();
      const stepMs = Math.max(140, Math.round((60 / PRESET_CHORDS[this.preset].bpm / 2) * 1000));
      this.stepTimer = window.setInterval(() => this.triggerStep(), stepMs);
    }
  }

  public stop() {
    this.running = false;
    if (this.stepTimer !== null) {
      window.clearInterval(this.stepTimer);
      this.stepTimer = null;
    }
    const ctx = getSharedAudioContext();
    if (ctx && this.masterGain) {
      try {
        this.masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      } catch {
        // Ignore
      }
    }
  }

  public dispose() {
    this.stop();
    this.filter?.disconnect();
    this.masterGain?.disconnect();
    this.filter = this.masterGain = null;
  }
}
