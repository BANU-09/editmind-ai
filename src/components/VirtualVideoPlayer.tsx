import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Captions,
  Maximize2,
  Music,
  Pause,
  Play,
  SkipBack,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { ProjectState, TranslationTrack } from '../shared/types';
import {
  formatTimecode,
  getActiveCaptionAtTime,
  mapTimelineTimeToSource,
  projectCaptionsToTimeline,
} from '../shared/timelineEngine';
import { apiUrl } from '../lib/api';
import { getBundledThumbForDemo, renderDemoCanvasFrame } from '../lib/demoAssets';

interface VirtualVideoPlayerProps {
  mediaUrl: string;
  posterUrl?: string;
  mediaFilename: string;
  mediaWidth: number;
  mediaHeight: number;
  state: ProjectState;
  translatedTrack?: TranslationTrack | null;
  currentTime: number;
  isPlaying: boolean;
  onTimeChange: (timelineTime: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onToggleCaptions: () => void;
}

export function VirtualVideoPlayer({
  mediaUrl,
  posterUrl,
  mediaFilename,
  mediaWidth,
  mediaHeight,
  state,
  translatedTrack,
  currentTime,
  isPlaying,
  onTimeChange,
  onPlayingChange,
  onToggleCaptions,
}: VirtualVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const posterImgRef = useRef<HTMLImageElement | null>(null);
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  const bleepCtxRef = useRef<AudioContext | null>(null);
  const bleepOscRef = useRef<OscillatorNode | null>(null);
  const bleepGainRef = useRef<GainNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number>(0);

  const [globalSpeedMult, setGlobalSpeedMult] = useState(1);
  const [volume, setVolume] = useState(1);
  const [videoFailed, setVideoFailed] = useState(false);
  const [posterVersion, setPosterVersion] = useState(0);
  const [naturalDims, setNaturalDims] = useState<{ w: number; h: number }>({
    w: Math.max(1, mediaWidth || 1280),
    h: Math.max(1, mediaHeight || 720),
  });

  useEffect(() => {
    setNaturalDims({
      w: Math.max(1, mediaWidth || 1280),
      h: Math.max(1, mediaHeight || 720),
    });
  }, [mediaWidth, mediaHeight, mediaUrl]);

  useEffect(() => {
    setVideoFailed(!mediaUrl);
    const resolvedPoster =
      posterUrl ||
      getBundledThumbForDemo(
        mediaUrl?.split('/').find((seg) => seg.startsWith('demo-')),
      );
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      posterImgRef.current = img;
      setPosterVersion((v) => v + 1);
    };
    img.src = resolvedPoster;
  }, [mediaUrl, posterUrl]);

  const projectedCaptions = useMemo(() => projectCaptionsToTimeline(state), [state]);
  const activeCaption = useMemo(
    () => getActiveCaptionAtTime(projectedCaptions, currentTime),
    [projectedCaptions, currentTime],
  );
  const activeTranslatedText = useMemo(() => {
    if (!activeCaption || !translatedTrack) return null;
    const match = translatedTrack.segments.find(
      (seg) =>
        Math.min(seg.sourceEnd, activeCaption.sourceEnd) -
          Math.max(seg.sourceStart, activeCaption.sourceStart) >
        0.04,
    );
    return match?.text || null;
  }, [activeCaption, translatedTrack]);

  const activeOverlays = useMemo(() => {
    if (!state.trackVisibility.overlays) return [];
    return state.overlays.filter(
      (o) => currentTime >= o.timelineStart && currentTime <= o.timelineEnd,
    );
  }, [state.overlays, state.trackVisibility.overlays, currentTime]);

  const mapped = useMemo(
    () => mapTimelineTimeToSource(state.segments, currentTime),
    [state.segments, currentTime],
  );

  const inBleepNow = useMemo(() => {
    if (!mapped) return false;
    return state.bleeps.some(
      (b) => mapped.sourceTime >= b.sourceStart && mapped.sourceTime <= b.sourceEnd,
    );
  }, [mapped, state.bleeps]);

  const inMuteRangeNow = useMemo(() => {
    if (!mapped) return false;
    return (state.muteRanges || []).some(
      (m) => mapped.sourceTime >= m.sourceStart && mapped.sourceTime <= m.sourceEnd,
    );
  }, [mapped, state.muteRanges]);

  // WebAudio 1000Hz bleep tone synchronized to bleep ranges while playing
  useEffect(() => {
    if (!isPlaying || !inBleepNow || state.audio.muted || volume === 0) {
      if (bleepGainRef.current && bleepCtxRef.current) {
        bleepGainRef.current.gain.setTargetAtTime(0, bleepCtxRef.current.currentTime, 0.01);
      }
      return;
    }

    try {
      if (!bleepCtxRef.current) {
        const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 1000;
        gain.gain.value = 0;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        bleepCtxRef.current = ctx;
        bleepOscRef.current = osc;
        bleepGainRef.current = gain;
      }
      if (bleepCtxRef.current.state === 'suspended') {
        void bleepCtxRef.current.resume().catch(() => {});
      }
      if (bleepGainRef.current) {
        bleepGainRef.current.gain.setTargetAtTime(0.18 * volume, bleepCtxRef.current.currentTime, 0.01);
      }
    } catch {
      // Ignore WebAudio restriction if blocked before interaction
    }
  }, [isPlaying, inBleepNow, state.audio.muted, volume]);

  useEffect(() => {
    return () => {
      try {
        bleepOscRef.current?.stop();
        void bleepCtxRef.current?.close();
      } catch {
        // Ignore cleanup errors
      }
    };
  }, []);

  // Sync underlying HTML5 <video> element position, playbackRate, and audio state
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid || !mapped) return;

    const { segment, sourceTime } = mapped;
    const effectiveSpeed = Math.min(4, Math.max(0.25, (segment.speed || 1) * globalSpeedMult));
    if (Math.abs(vid.playbackRate - effectiveSpeed) > 0.02) {
      vid.playbackRate = effectiveSpeed;
    }

    const shouldMute =
      state.audio.muted ||
      segment.muted ||
      !state.trackVisibility.audio ||
      inBleepNow ||
      inMuteRangeNow;

    vid.muted = shouldMute;
    vid.volume = Math.min(1, Math.max(0, volume * segment.volume * state.audio.masterVolume));

    if (Math.abs(vid.currentTime - sourceTime) > 0.25) {
      try {
        vid.currentTime = sourceTime;
      } catch {
        // Ignore seek before metadata loaded
      }
    }
  }, [
    mapped,
    state.audio,
    state.trackVisibility.audio,
    globalSpeedMult,
    volume,
    inBleepNow,
    inMuteRangeNow,
  ]);

  // Play / Pause control on <video> and synced custom music audio track
  useEffect(() => {
    const vid = videoRef.current;
    const musicEl = musicAudioRef.current;

    if (vid) {
      if (isPlaying) {
        void vid.play().catch(() => {});
      } else {
        vid.pause();
      }
    }

    if (musicEl && state.audio.customMusicUrl) {
      musicEl.volume = Math.min(1, Math.max(0, state.audio.musicVolume * volume));
      musicEl.muted = !state.audio.musicEnabled || !state.trackVisibility.music || state.audio.muted;
      if (isPlaying && state.audio.musicEnabled && state.trackVisibility.music) {
        const targetOffset = (state.audio.musicStartOffsetSec || 0) + currentTime;
        if (Math.abs(musicEl.currentTime - targetOffset) > 0.4 && Number.isFinite(musicEl.duration)) {
          musicEl.currentTime = targetOffset % Math.max(1, musicEl.duration);
        }
        void musicEl.play().catch(() => {});
      } else {
        musicEl.pause();
      }
    }
  }, [
    isPlaying,
    mediaUrl,
    state.audio.customMusicUrl,
    state.audio.musicEnabled,
    state.audio.musicVolume,
    state.audio.musicStartOffsetSec,
    state.audio.muted,
    state.trackVisibility.music,
    volume,
    currentTime,
  ]);

  // Virtual timeline driver advancing currentTime across cuts, reorders, and speed changes
  const stateRef = useRef(state);
  stateRef.current = state;
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;

  // Render animated Ken Burns frame whenever fallback canvas is active
  useEffect(() => {
    if (!videoFailed) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    renderDemoCanvasFrame(ctx, {
      width: canvas.width,
      height: canvas.height,
      image: posterImgRef.current,
      sourceTime: mapped?.sourceTime ?? currentTime,
      duration: Math.max(1, state.duration),
      topic: mapped?.segment.topic || mapped?.segment.label,
      speaker: mapped?.segment.speaker,
      isPlaying,
      opacity: state.trackVisibility.video ? 1 : 0.15,
    });
  }, [videoFailed, posterVersion, currentTime, mapped, isPlaying, state.duration, state.trackVisibility.video]);

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      lastFrameTsRef.current = 0;
      return;
    }

    const step = (now: number) => {
      if (!lastFrameTsRef.current) {
        lastFrameTsRef.current = now;
      }
      const dtSec = Math.min(0.1, (now - lastFrameTsRef.current) / 1000);
      lastFrameTsRef.current = now;

      const totalDur = stateRef.current.duration;
      const nextTime = timeRef.current + dtSec * globalSpeedMult;

      if (nextTime >= totalDur) {
        onTimeChange(0);
        onPlayingChange(false);
        return;
      }

      onTimeChange(nextTime);
      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying, globalSpeedMult, onTimeChange, onPlayingChange]);

  const handleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen?.().catch(() => {});
    }
  };

  const orientationLabel =
    naturalDims.h > naturalDims.w
      ? 'Portrait'
      : Math.abs(naturalDims.w - naturalDims.h) <= 16
        ? 'Square'
        : 'Landscape';

  const captionPosClass =
    state.captionStyle.position === 'top'
      ? 'top-4'
      : state.captionStyle.position === 'center'
        ? 'top-1/2 -translate-y-1/2'
        : 'bottom-4';

  const captionOpacity = state.captionStyle.backgroundOpacity ?? 0.78;
  const captionBg = `rgba(5, 7, 17, ${Math.max(0, Math.min(0.96, captionOpacity))})`;

  return (
    <div
      ref={containerRef}
      data-testid="video-preview-shell"
      className="flex flex-col rounded-2xl border border-white/15 bg-[#050711] overflow-hidden shadow-2xl shadow-black/60"
    >
      {/* Separate Metadata Header ABOVE the Video Frame (never covers footage) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-[#080C1C] px-4 py-2 text-[11px]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-white truncate max-w-[200px]">{mediaFilename}</span>
          <span className="font-mono text-slate-400">
            {naturalDims.w}×{naturalDims.h} ({orientationLabel})
          </span>
          {state.audio.musicEnabled && (
            <span className="inline-flex items-center gap-1 font-mono text-orange-300">
              <Music className="w-3 h-3" />
              {state.audio.customMusicName || state.audio.musicPreset}
            </span>
          )}
        </div>

        {mapped && (
          <div className="flex items-center gap-2 font-mono text-cyan-300">
            <span className="truncate max-w-[160px] text-slate-200">{mapped.segment.label}</span>
            <span>· {mapped.segment.speed}x</span>
            <span>· Src {formatTimecode(mapped.sourceTime)}</span>
            {inBleepNow && <span className="text-amber-300 font-bold">· BLEEP</span>}
            {inMuteRangeNow && <span className="text-rose-300 font-bold">· MUTED WORD</span>}
          </div>
        )}
      </div>

      {/* Complete Uncropped Video Frame Viewport (Dark Neutral Surround, Zero Cropping) */}
      <div
        data-testid="video-viewport"
        className="relative w-full min-h-[420px] h-[50vh] max-h-[580px] bg-[#02040A] flex items-center justify-center p-2 overflow-hidden"
      >
        <div
          style={{ aspectRatio: `${naturalDims.w} / ${naturalDims.h}` }}
          className="relative max-w-full max-h-full h-full flex items-center justify-center overflow-hidden"
        >
          {!videoFailed ? (
            <video
              ref={videoRef}
              src={mediaUrl}
              poster={posterUrl}
              playsInline
              preload="auto"
              onError={() => setVideoFailed(true)}
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  setNaturalDims({ w: v.videoWidth, h: v.videoHeight });
                }
              }}
              data-testid="editor-video-element"
              className={`w-full h-full object-contain transition-opacity ${
                state.trackVisibility.video ? 'opacity-100' : 'opacity-15'
              }`}
            />
          ) : (
            <div className="relative w-full h-full flex items-center justify-center bg-[#060914]">
              <img
                src={
                  posterUrl ||
                  getBundledThumbForDemo(
                    mediaUrl?.split('/').find((seg) => seg.startsWith('demo-')),
                  )
                }
                alt={mediaFilename}
                className={`absolute inset-0 w-full h-full object-contain ${
                  state.trackVisibility.video ? 'opacity-90' : 'opacity-15'
                }`}
              />
              <canvas
                ref={canvasRef}
                width={Math.min(960, Math.max(480, naturalDims.w))}
                height={Math.min(960, Math.max(270, Math.round((Math.min(960, Math.max(480, naturalDims.w)) / Math.max(1, naturalDims.w)) * naturalDims.h)))}
                data-testid="editor-canvas-fallback"
                className="relative z-10 w-full h-full object-contain"
              />
            </div>
          )}

          {/* Active Text Overlays Positioned Within True Video Frame */}
          {activeOverlays.map((ov) => (
            <div
              key={ov.id}
              style={{
                left: `${ov.x}%`,
                top: `${ov.y}%`,
                transform: 'translate(-50%, -50%)',
                fontSize: `${Math.max(13, Math.round(ov.fontSize * 0.72))}px`,
                color: ov.color,
                backgroundColor: ov.backgroundColor,
              }}
              className="pointer-events-none absolute rounded-lg px-3 py-1.5 font-bold shadow-lg border border-pink-400/40"
            >
              {ov.text}
            </div>
          ))}

          {/* Active Synced Captions Inside True Video Frame */}
          {activeCaption && (
            <div
              className={`pointer-events-none absolute left-3 right-3 flex justify-center ${captionPosClass}`}
            >
              <div
                data-testid="live-caption-preview"
                style={{
                  backgroundColor: captionBg,
                  fontFamily: state.captionStyle.fontFamily,
                  fontSize: `${Math.max(12, Math.round(state.captionStyle.fontSize * 0.72))}px`,
                  color: state.captionStyle.color,
                }}
                className="max-w-[92%] rounded-xl px-3.5 py-2 text-center font-semibold leading-snug border border-white/10"
              >
                {activeTranslatedText ? (
                  <span>{activeTranslatedText}</span>
                ) : activeCaption.words.length > 0 ? (
                  <span className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5">
                    {activeCaption.words.map((w) => {
                      const isWordActive =
                        state.captionStyle.highlightActiveWord &&
                        currentTime >= w.timelineStart &&
                        currentTime <= w.timelineEnd;
                      return (
                        <span
                          key={w.id}
                          style={
                            isWordActive
                              ? { color: state.captionStyle.highlightColor }
                              : undefined
                          }
                          className={isWordActive ? 'underline decoration-2' : undefined}
                        >
                          {w.word}
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  activeCaption.text
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Hidden synced audio element for custom uploaded music bed */}
      {state.audio.customMusicUrl && (
        <audio ref={musicAudioRef} src={apiUrl(state.audio.customMusicUrl)} loop preload="auto" />
      )}

      {/* Playback Controls Strictly BELOW Video Frame */}
      <div className="border-t border-white/10 bg-[#080C1B] px-4 py-2.5 space-y-2">
        <div className="flex items-center gap-3">
          <span className="font-mono tabular-nums text-xs text-cyan-300 w-16">
            {formatTimecode(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={Math.max(0.1, state.duration)}
            step={0.05}
            value={Math.min(currentTime, state.duration)}
            onChange={(e) => onTimeChange(parseFloat(e.target.value))}
            aria-label="Seek edited timeline"
            className="studio-range flex-1 cursor-pointer"
          />
          <span className="font-mono tabular-nums text-xs text-slate-400 w-16 text-right">
            {formatTimecode(state.duration)}
          </span>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Jump to start"
              onClick={() => {
                onTimeChange(0);
                onPlayingChange(false);
              }}
              className="rounded-lg border border-white/10 bg-slate-900 p-1.5 text-slate-300 hover:text-white cursor-pointer"
            >
              <SkipBack className="w-4 h-4" />
            </button>

            <button
              type="button"
              aria-label={isPlaying ? 'Pause video' : 'Play video'}
              onClick={() => onPlayingChange(!isPlaying)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-1.5 text-xs font-bold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              {isPlaying ? 'Pause' : 'Play'}
            </button>

            <button
              type="button"
              aria-label={state.audio.muted ? 'Unmute audio' : 'Mute audio'}
              onClick={() => setVolume((v) => (v === 0 ? 1 : 0))}
              className="rounded-lg border border-white/10 bg-slate-900 p-1.5 text-slate-300 hover:text-white cursor-pointer"
            >
              {volume === 0 || state.audio.muted ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-violet-300" />
              )}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => setVolume(parseFloat(e.target.value))}
              aria-label="Preview volume"
              className="studio-range w-20 cursor-pointer hidden sm:block"
            />
          </div>

          <div className="flex items-center gap-2">
            <select
              aria-label="Preview playback speed"
              value={globalSpeedMult}
              onChange={(e) => setGlobalSpeedMult(parseFloat(e.target.value))}
              className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-xs font-mono text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value={0.5}>0.5x</option>
              <option value={1}>1.0x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2.0x</option>
            </select>

            <button
              type="button"
              onClick={onToggleCaptions}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium cursor-pointer ${
                state.captionsEnabled
                  ? 'border-emerald-400/50 bg-emerald-500/15 text-emerald-300'
                  : 'border-white/10 bg-slate-900 text-slate-400'
              }`}
            >
              <Captions className="w-3.5 h-3.5" />
              CC
            </button>

            <button
              type="button"
              aria-label="Toggle fullscreen preview"
              onClick={handleFullscreen}
              className="rounded-lg border border-white/10 bg-slate-900 p-1.5 text-slate-300 hover:text-white cursor-pointer"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
