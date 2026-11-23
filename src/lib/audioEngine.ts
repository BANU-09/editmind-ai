import { musicLoop, musicSampleRate, type MusicPreset } from '../shared/musicBed';
import demoKeynoteAudio from '../assets/audio/demo-keynote.mp3';
import demoMarketingAudio from '../assets/audio/demo-marketing.mp3';
import demoPodcastAudio from '../assets/audio/demo-podcast.mp3';
import demoTravelAudio from '../assets/audio/demo-travel.mp3';
import demoTutorialAudio from '../assets/audio/demo-tutorial.mp3';

export type SynthMusicPreset = MusicPreset;

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

const buffers = new WeakMap<AudioContext, Map<MusicPreset, AudioBuffer>>();

export class ProceduralMusicBed {
  constructor(private readonly output?: AudioNode) {}
  private gain?: GainNode;
  private source?: AudioBufferSourceNode;
  private preset?: MusicPreset;

  public update(opts: { active: boolean; preset: MusicPreset; volume: number; offset?: number }) {
    const ctx = getSharedAudioContext();
    if (!ctx || !opts.active) { this.stop(); return; }
    const level = Math.max(0, Math.min(1, opts.volume));
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    if (!this.source || this.preset !== opts.preset) {
      this.stop();
      const bank = buffers.get(ctx) ?? new Map<MusicPreset, AudioBuffer>();
      buffers.set(ctx, bank);
      let buffer = bank.get(opts.preset);
      if (!buffer) {
        const pcm = musicLoop(opts.preset);
        buffer = ctx.createBuffer(1, pcm.length, musicSampleRate);
        buffer.getChannelData(0).set(pcm);
        bank.set(opts.preset, buffer);
      }
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      this.source = ctx.createBufferSource();
      this.source.buffer = buffer;
      this.source.loop = true;
      this.source.connect(this.gain).connect(this.output ?? ctx.destination);
      this.source.start(0, Math.max(0, opts.offset || 0) % buffer.duration);
      this.preset = opts.preset;
    }
    this.gain!.gain.setTargetAtTime(level, ctx.currentTime, 0.035);
  }

  public stop() {
    if (!this.source || !this.gain) return;
    const source = this.source, gain = this.gain;
    gain.gain.setTargetAtTime(0, gain.context.currentTime, 0.012);
    source.stop(gain.context.currentTime + 0.06);
    source.onended = () => { source.disconnect(); gain.disconnect(); };
    this.source = undefined;
    this.gain = undefined;
  }

  public dispose() { this.stop(); }
}
