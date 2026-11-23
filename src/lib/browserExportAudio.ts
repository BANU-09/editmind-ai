import type { HydratedProject } from './api';
import type { ProjectState } from '../shared/types';
import { mapTimelineTimeToSource } from '../shared/timelineEngine';
import { getBundledAudioForDemo, ProceduralMusicBed, unlockAudioEngine } from './audioEngine';
import { getNarrationPosition } from './fallbackData';

// Route export audio exclusively to the recorder. The editor and system speakers
// can keep their own playback state while this timeline is rendering.
export function createBrowserExportAudio(project: HydratedProject, state: ProjectState) {
  const ctx = unlockAudioEngine();
  if (!ctx) throw new Error('This browser cannot record an audio mix.');
  const output = ctx.createMediaStreamDestination();
  const inputs: HTMLAudioElement[] = [];
  const sources: MediaElementAudioSourceNode[] = [];
  const tone = ctx.createOscillator();
  const toneGain = ctx.createGain();
  tone.frequency.value = 1000;
  toneGain.gain.value = 0;
  tone.connect(toneGain).connect(output);
  tone.start();
  const bed = new ProceduralMusicBed(output);
  const media = project.media;
  const isDemo = media?.sourceType === 'demo';
  const hasMusic = state.audio.musicEnabled && state.trackVisibility.music && !state.audio.muted;

  function input(url: string, loop = false) {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    el.loop = loop;
    el.volume = 0;
    const source = ctx!.createMediaElementSource(el);
    source.connect(output);
    sources.push(source);
    inputs.push(el);
    return el;
  }

  const sourceUrl = isDemo ? getBundledAudioForDemo(media.id) : media?.url;
  const voice = sourceUrl && media?.hasAudio && state.trackVisibility.audio && !state.audio.muted
    ? input(sourceUrl) : undefined;
  const music = hasMusic && state.audio.musicPreset === 'custom-upload' && state.audio.customMusicUrl
    ? input(state.audio.customMusicUrl, true) : undefined;
  let previousSegment: string | undefined;

  async function sync(time: number, playing = false) {
    const mapped = mapTimelineTimeToSource(state.segments, time);
    if (!mapped) return;
    const { sourceTime, segment } = mapped;
    const bleep = state.bleeps.some(b => sourceTime >= b.sourceStart && sourceTime < b.sourceEnd);
    const mute = state.muteRanges?.some(m => sourceTime >= m.sourceStart && sourceTime < m.sourceEnd);
    const audible = state.trackVisibility.audio && !state.audio.muted && !segment.muted;
    const level = audible ? Math.max(0, Math.min(1, state.audio.masterVolume * segment.volume)) : 0;
    toneGain.gain.value = bleep ? level * 0.18 : 0;
    if (voice && media) {
      const pos = isDemo ? getNarrationPosition(media.analysis, sourceTime) : { time: sourceTime, rate: 1 };
      voice.volume = mute || bleep ? 0 : level;
      voice.playbackRate = Math.max(0.0625, Math.min(16, pos.rate * segment.speed));
      const drift = Math.abs(voice.currentTime - pos.time);
      if (drift > (previousSegment !== segment.id ? 0.035 : 0.18)) {
        voice.currentTime = pos.time;
      }
      if (playing && voice.paused && pos.time < voice.duration - 0.03) await voice.play();
      previousSegment = segment.id;
    }
    const dialogue = audible && !mute && !bleep && state.captions.some(caption =>
      !caption.customText && caption.sourceStart <= sourceTime && sourceTime < caption.sourceEnd);
    const mixGain = state.audio.duckUnderSpeech !== false && dialogue ? 0.25 : 1;
    const musicGain = Math.min(1, Math.max(0, state.audio.musicVolume * mixGain));
    if (music) music.volume = musicGain;
    if (playing && hasMusic && state.audio.musicPreset !== 'custom-upload') {
      bed.update({ active: true, preset: state.audio.musicPreset, volume: musicGain, offset: time + (state.audio.musicStartOffsetSec || 0) });
    }
  }

  return {
    stream: output.stream,
    async prepare() {
      // Prime the media elements and context during the export click. Loading or
      // permission failures must fail the job instead of producing a silent file.
      if (!sourceUrl && media?.hasAudio && state.trackVisibility.audio && !state.audio.muted) {
        throw new Error('The original audio is unavailable. Reopen the source media before exporting.');
      }
      await Promise.all([ctx.resume(), ...inputs.map(el => el.play())]);
      inputs.forEach(el => el.pause());
    },
    async start() {
      await sync(0);
      if (music && music.duration > 0) music.currentTime = (state.audio.musicStartOffsetSec || 0) % music.duration;
      if (hasMusic && state.audio.musicPreset !== 'custom-upload') {
        bed.update({ active: true, preset: state.audio.musicPreset, volume: state.audio.musicVolume, offset: state.audio.musicStartOffsetSec });
      }
      await Promise.all(inputs.map(el => el.play()));
    },
    sync,
    dispose() {
      for (const el of inputs) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      sources.forEach(source => source.disconnect());
      tone.stop();
      tone.disconnect();
      toneGain.disconnect();
      bed.dispose();
      output.stream.getTracks().forEach(track => track.stop());
    },
  };
}
