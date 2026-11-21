import { useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Captions,
  Eye,
  EyeOff,
  Lock,
  Magnet,
  Music,
  Pause,
  Play,
  Plus,
  Scissors,
  Shield,
  Sparkles,
  Trash2,
  Type,
  Unlock,
  Upload,
  Volume2,
  VolumeX,
  ZoomIn,
} from 'lucide-react';
import type {
  AudioSettings,
  MediaAnalysis,
  ProjectState,
  TextOverlay,
  TimelineSegment,
} from '../shared/types';
import { formatTimecode, projectCaptionsToTimeline } from '../shared/timelineEngine';
import { apiUrl } from '../lib/api';

interface TimelinePanelProps {
  projectId: string;
  state: ProjectState;
  analysis: MediaAnalysis;
  currentTime: number;
  selectedSegmentId: string | null;
  onSelectSegment: (id: string | null) => void;
  onSeek: (timelineTime: number) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSegment: (segmentId: string) => void;
  onMoveSegment: (fromIdx: number, toIdx: number) => void;
  onChangeSegmentSpeed: (segmentId: string, speed: number) => void;
  onTrimSegmentEdges: (segmentId: string, deltaStart: number, deltaEnd: number) => void;
  onUpdateAudioSegment: (segmentId: string, patch: { muted?: boolean; volume?: number }) => void;
  onUpdateAudioSettings: (patch: Partial<AudioSettings>, label: string) => void;
  onUploadMusicFile: (file: File) => Promise<void>;
  onToggleTrackVisibility: (track: keyof ProjectState['trackVisibility']) => void;
  onToggleTrackLock: (track: keyof ProjectState['trackLocks']) => void;
  onToggleAudioMute: () => void;
  onToggleMusic: () => void;
  onGenerateCaptions: () => void;
  onEditCaptionText: (captionId: string, nextText: string) => void;
  onAdjustCaptionTiming: (captionId: string, sourceStart: number, sourceEnd: number) => void;
  onDeleteCaption: (captionId: string) => void;
  onAddOverlay: (text: string) => void;
  onUpdateOverlay: (overlayId: string, patch: Partial<TextOverlay>) => void;
  onDeleteOverlay: (overlayId: string) => void;
}

export function TimelinePanel({
  state,
  analysis,
  currentTime,
  selectedSegmentId,
  onSelectSegment,
  onSeek,
  onSplitAtPlayhead,
  onDeleteSegment,
  onMoveSegment,
  onChangeSegmentSpeed,
  onTrimSegmentEdges,
  onUpdateAudioSegment,
  onUpdateAudioSettings,
  onUploadMusicFile,
  onToggleTrackVisibility,
  onToggleTrackLock,
  onToggleAudioMute,
  onToggleMusic,
  onGenerateCaptions,
  onEditCaptionText,
  onAdjustCaptionTiming,
  onDeleteCaption,
  onAddOverlay,
  onUpdateOverlay,
  onDeleteOverlay,
}: TimelinePanelProps) {
  const [zoom, setZoom] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(true);

  // Active sub-inspectors for interactive tracks
  const [showOverlayForm, setShowOverlayForm] = useState(false);
  const [overlayDraft, setOverlayDraft] = useState('');
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [selectedAudioSegId, setSelectedAudioSegId] = useState<string | null>(null);
  const [editingCaption, setEditingCaption] = useState<{
    id: string;
    text: string;
    sourceStart: number;
    sourceEnd: number;
  } | null>(null);
  const [showMusicPanel, setShowMusicPanel] = useState(false);
  const [musicUploading, setMusicUploading] = useState(false);
  const [musicUploadError, setMusicUploadError] = useState<string | null>(null);
  const [musicPreviewPlaying, setMusicPreviewPlaying] = useState(false);

  const musicFileInputRef = useRef<HTMLInputElement | null>(null);
  const musicPreviewRef = useRef<HTMLAudioElement | null>(null);
  const dragFromIdxRef = useRef<number | null>(null);

  const projectedCaptions = useMemo(() => projectCaptionsToTimeline(state), [state]);
  const totalDur = Math.max(1, state.duration);
  const selectedSegIndex = state.segments.findIndex((s) => s.id === selectedSegmentId);
  const selectedSeg: TimelineSegment | undefined =
    selectedSegIndex >= 0 ? state.segments[selectedSegIndex] : undefined;

  const selectedAudioSeg = state.segments.find((s) => s.id === selectedAudioSegId);
  const selectedOverlay = state.overlays.find((o) => o.id === selectedOverlayId);

  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / totalDur) * 100))}%`;
  const widthPct = (start: number, end: number) =>
    `${Math.max(2, Math.min(100, ((end - start) / totalDur) * 100))}%`;

  const handleRulerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    let target = ratio * totalDur;
    if (snapEnabled) {
      const snapPoints = state.segments.flatMap((s) => [s.timelineStart, s.timelineEnd]);
      for (const sp of snapPoints) {
        if (Math.abs(sp - target) < totalDur * 0.015) {
          target = sp;
          break;
        }
      }
    }
    onSeek(Math.round(target * 100) / 100);
  };

  const getWaveformSlice = (seg: TimelineSegment) => {
    const peaks = analysis.waveformPeaks;
    if (!peaks.length || analysis.durationSec <= 0) return [0.3, 0.5, 0.4, 0.6];
    const startIdx = Math.floor((seg.sourceStart / analysis.durationSec) * peaks.length);
    const endIdx = Math.max(
      startIdx + 1,
      Math.ceil((seg.sourceEnd / analysis.durationSec) * peaks.length),
    );
    const slice = peaks.slice(startIdx, endIdx);
    return slice.length > 0 ? slice.slice(0, 28) : [0.3, 0.4];
  };

  const handleMusicUpload = async (file: File) => {
    setMusicUploadError(null);
    setMusicUploading(true);
    try {
      await onUploadMusicFile(file);
    } catch (err) {
      setMusicUploadError(err instanceof Error ? err.message : 'Music upload failed.');
    } finally {
      setMusicUploading(false);
    }
  };

  const toggleMusicPreview = () => {
    const el = musicPreviewRef.current;
    if (!el || !state.audio.customMusicUrl) return;
    if (musicPreviewPlaying) {
      el.pause();
      setMusicPreviewPlaying(false);
    } else {
      el.currentTime = state.audio.musicStartOffsetSec || 0;
      el.volume = state.audio.musicVolume;
      void el.play().catch(() => {});
      setMusicPreviewPlaying(true);
    }
  };

  return (
    <section
      aria-label="Independent Timeline Workspace"
      data-testid="timeline-workspace"
      className="border-t-2 border-cyan-500/25 bg-[#070B18] select-none flex flex-col shrink-0"
    >
      {/* Timeline Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2 bg-[#090F22]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-cyan-300 mr-1">
            Timeline
          </span>

          <button
            type="button"
            onClick={onSplitAtPlayhead}
            disabled={state.trackLocks.video}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-2.5 py-1 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40 cursor-pointer"
          >
            <Scissors className="w-3.5 h-3.5" />
            Split
          </button>

          {selectedSeg && (
            <>
              <button
                type="button"
                aria-label="Move selected segment earlier"
                disabled={selectedSegIndex <= 0 || state.trackLocks.video}
                onClick={() => onMoveSegment(selectedSegIndex, selectedSegIndex - 1)}
                className="rounded-lg border border-white/10 bg-slate-900 p-1.5 text-slate-300 hover:text-white disabled:opacity-35 cursor-pointer"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                aria-label="Move selected segment later"
                disabled={selectedSegIndex >= state.segments.length - 1 || state.trackLocks.video}
                onClick={() => onMoveSegment(selectedSegIndex, selectedSegIndex + 1)}
                className="rounded-lg border border-white/10 bg-slate-900 p-1.5 text-slate-300 hover:text-white disabled:opacity-35 cursor-pointer"
              >
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={state.trackLocks.video}
                onClick={() => onTrimSegmentEdges(selectedSeg.id, 0.5, 0)}
                className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white disabled:opacity-35 cursor-pointer"
              >
                In +0.5s
              </button>
              <button
                type="button"
                disabled={state.trackLocks.video}
                onClick={() => onTrimSegmentEdges(selectedSeg.id, 0, -0.5)}
                className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-300 hover:text-white disabled:opacity-35 cursor-pointer"
              >
                Out -0.5s
              </button>
              <select
                aria-label="Selected segment speed"
                disabled={state.trackLocks.video}
                value={selectedSeg.speed}
                onChange={(e) => onChangeSegmentSpeed(selectedSeg.id, parseFloat(e.target.value))}
                className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] font-mono text-cyan-300 cursor-pointer"
              >
                <option value={0.5}>0.5x</option>
                <option value={1}>1.0x</option>
                <option value={1.15}>1.15x</option>
                <option value={1.25}>1.25x</option>
                <option value={1.5}>1.5x</option>
                <option value={2}>2.0x</option>
              </select>
              <button
                type="button"
                aria-label="Delete selected segment"
                disabled={state.segments.length <= 1 || state.trackLocks.video}
                onClick={() => onDeleteSegment(selectedSeg.id)}
                className="rounded-lg border border-rose-500/35 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20 disabled:opacity-35 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={state.trackLocks.overlays}
            onClick={() => setShowOverlayForm((v) => !v)}
            className="inline-flex items-center gap-1 rounded-lg border border-pink-400/40 bg-pink-500/10 px-2.5 py-1 text-xs font-medium text-pink-200 hover:bg-pink-500/20 disabled:opacity-40 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Text Overlay
          </button>

          <button
            type="button"
            onClick={() => setShowMusicPanel((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium cursor-pointer ${
              showMusicPanel || state.audio.musicEnabled
                ? 'border-orange-400/50 bg-orange-500/15 text-orange-200'
                : 'border-white/10 bg-slate-900 text-slate-300'
            }`}
          >
            <Music className="w-3.5 h-3.5" />
            Music Controls
          </button>

          <button
            type="button"
            onClick={() => setSnapEnabled((s) => !s)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs cursor-pointer ${
              snapEnabled
                ? 'border-cyan-400/40 bg-cyan-500/15 text-cyan-200'
                : 'border-white/10 bg-slate-900 text-slate-400'
            }`}
          >
            <Magnet className="w-3.5 h-3.5" />
            Snap
          </button>

          <div className="flex items-center gap-1.5">
            <ZoomIn className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="range"
              min={1}
              max={3}
              step={0.25}
              value={zoom}
              onChange={(e) => setZoom(parseFloat(e.target.value))}
              aria-label="Timeline zoom"
              className="studio-range w-20 cursor-pointer"
            />
            <span className="font-mono text-[11px] text-slate-400 w-8">{zoom}x</span>
          </div>
        </div>
      </div>

      {/* Interactive Inspectors Above Tracks */}
      {showOverlayForm && (
        <div className="flex items-center gap-2 px-4 py-2 bg-pink-950/25 border-b border-pink-500/20">
          <input
            type="text"
            value={overlayDraft}
            onChange={(e) => setOverlayDraft(e.target.value)}
            placeholder="Overlay text at playhead (e.g. Limited Launch Offer)"
            className="flex-1 rounded-lg border border-pink-400/40 bg-[#050711] px-3 py-1.5 text-xs text-white focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              if (overlayDraft.trim()) {
                onAddOverlay(overlayDraft.trim());
                setOverlayDraft('');
                setShowOverlayForm(false);
              }
            }}
            className="rounded-lg bg-pink-500 px-3 py-1.5 text-xs font-semibold text-white cursor-pointer"
          >
            Add at {formatTimecode(currentTime)}
          </button>
        </div>
      )}

      {selectedAudioSeg && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 bg-violet-950/30 border-b border-violet-500/25 text-xs">
          <div className="flex items-center gap-3">
            <span className="font-semibold text-violet-200">
              Audio Clip: {selectedAudioSeg.label}
            </span>
            <label className="inline-flex items-center gap-2 text-slate-300">
              <span>Vol {Math.round(selectedAudioSeg.volume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                disabled={state.trackLocks.audio}
                value={selectedAudioSeg.volume}
                onChange={(e) =>
                  onUpdateAudioSegment(selectedAudioSeg.id, {
                    volume: parseFloat(e.target.value),
                  })
                }
                aria-label="Selected audio clip volume"
                className="studio-range w-24 cursor-pointer"
              />
            </label>
            <button
              type="button"
              disabled={state.trackLocks.audio}
              onClick={() =>
                onUpdateAudioSegment(selectedAudioSeg.id, { muted: !selectedAudioSeg.muted })
              }
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium cursor-pointer ${
                selectedAudioSeg.muted
                  ? 'border-rose-400/50 bg-rose-500/20 text-rose-200'
                  : 'border-white/15 bg-slate-900 text-slate-200'
              }`}
            >
              {selectedAudioSeg.muted ? 'Clip Muted' : 'Mute Clip'}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSelectedAudioSegId(null)}
            className="text-slate-400 hover:text-white text-[11px] cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {selectedOverlay && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2 bg-pink-950/30 border-b border-pink-500/25 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-pink-200">Overlay:</span>
            <input
              type="text"
              disabled={state.trackLocks.overlays}
              value={selectedOverlay.text}
              onChange={(e) => onUpdateOverlay(selectedOverlay.id, { text: e.target.value })}
              aria-label="Selected overlay text"
              className="rounded-lg border border-pink-400/40 bg-[#050711] px-2.5 py-1 text-xs text-white w-44"
            />
            <label className="inline-flex items-center gap-1 text-slate-300">
              <span>Size</span>
              <input
                type="number"
                min={14}
                max={64}
                disabled={state.trackLocks.overlays}
                value={selectedOverlay.fontSize}
                onChange={(e) =>
                  onUpdateOverlay(selectedOverlay.id, {
                    fontSize: Math.max(14, Math.min(64, Number(e.target.value) || 24)),
                  })
                }
                className="w-14 rounded-lg border border-white/15 bg-[#050711] px-1.5 py-1 text-xs text-white"
              />
            </label>
            <label className="inline-flex items-center gap-1 text-slate-300">
              <span>X%</span>
              <input
                type="number"
                min={10}
                max={90}
                disabled={state.trackLocks.overlays}
                value={selectedOverlay.x}
                onChange={(e) =>
                  onUpdateOverlay(selectedOverlay.id, {
                    x: Math.max(10, Math.min(90, Number(e.target.value) || 50)),
                  })
                }
                className="w-12 rounded-lg border border-white/15 bg-[#050711] px-1.5 py-1 text-xs text-white"
              />
            </label>
            <label className="inline-flex items-center gap-1 text-slate-300">
              <span>Y%</span>
              <input
                type="number"
                min={10}
                max={90}
                disabled={state.trackLocks.overlays}
                value={selectedOverlay.y}
                onChange={(e) =>
                  onUpdateOverlay(selectedOverlay.id, {
                    y: Math.max(10, Math.min(90, Number(e.target.value) || 18)),
                  })
                }
                className="w-12 rounded-lg border border-white/15 bg-[#050711] px-1.5 py-1 text-xs text-white"
              />
            </label>
            {(['#FFFFFF', '#FACC15', '#22D3EE', '#F472B6'] as const).map((hex) => (
              <button
                key={hex}
                type="button"
                disabled={state.trackLocks.overlays}
                onClick={() => onUpdateOverlay(selectedOverlay.id, { color: hex })}
                style={{ backgroundColor: hex }}
                className={`w-4 h-4 rounded-full border cursor-pointer ${
                  selectedOverlay.color === hex ? 'border-white scale-110' : 'border-white/30'
                }`}
              />
            ))}
            <button
              type="button"
              disabled={state.trackLocks.overlays}
              onClick={() => {
                onDeleteOverlay(selectedOverlay.id);
                setSelectedOverlayId(null);
              }}
              className="rounded-lg bg-rose-500/20 border border-rose-500/40 px-2.5 py-1 text-[11px] text-rose-200 cursor-pointer"
            >
              Delete
            </button>
          </div>
          <button
            type="button"
            onClick={() => setSelectedOverlayId(null)}
            className="text-slate-400 hover:text-white text-[11px] cursor-pointer"
          >
            Done
          </button>
        </div>
      )}

      {editingCaption && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 bg-emerald-950/30 border-b border-emerald-500/25">
          <span className="text-[11px] font-semibold text-emerald-300 shrink-0">Edit Caption:</span>
          <input
            type="text"
            aria-label="Edit caption text"
            disabled={state.trackLocks.captions}
            value={editingCaption.text}
            onChange={(e) =>
              setEditingCaption((prev) => (prev ? { ...prev, text: e.target.value } : null))
            }
            className="flex-1 min-w-[200px] rounded-lg border border-emerald-400/40 bg-[#050711] px-3 py-1.5 text-xs text-white focus:outline-none"
          />
          <button
            type="button"
            disabled={state.trackLocks.captions}
            onClick={() => {
              const ns = Math.max(0, editingCaption.sourceStart - 0.2);
              onAdjustCaptionTiming(editingCaption.id, ns, editingCaption.sourceEnd);
              setEditingCaption((prev) => (prev ? { ...prev, sourceStart: ns } : null));
            }}
            className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-200 cursor-pointer"
          >
            In -0.2s
          </button>
          <button
            type="button"
            disabled={state.trackLocks.captions}
            onClick={() => {
              const ne = editingCaption.sourceEnd + 0.2;
              onAdjustCaptionTiming(editingCaption.id, editingCaption.sourceStart, ne);
              setEditingCaption((prev) => (prev ? { ...prev, sourceEnd: ne } : null));
            }}
            className="rounded-lg border border-white/15 bg-slate-900 px-2 py-1 text-[11px] font-mono text-slate-200 cursor-pointer"
          >
            Out +0.2s
          </button>
          <button
            type="button"
            disabled={state.trackLocks.captions}
            onClick={() => {
              if (editingCaption.text.trim()) {
                onEditCaptionText(editingCaption.id, editingCaption.text.trim());
              }
              setEditingCaption(null);
            }}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 cursor-pointer"
          >
            Save
          </button>
          <button
            type="button"
            disabled={state.trackLocks.captions}
            onClick={() => {
              onDeleteCaption(editingCaption.id);
              setEditingCaption(null);
            }}
            className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1.5 text-xs text-rose-200 cursor-pointer"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setEditingCaption(null)}
            className="rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}

      {showMusicPanel && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-orange-950/25 border-b border-orange-500/25 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <select
              aria-label="Background music preset"
              disabled={state.trackLocks.music}
              value={state.audio.musicPreset}
              onChange={(e) =>
                onUpdateAudioSettings(
                  {
                    musicEnabled: true,
                    musicPreset: e.target.value as AudioSettings['musicPreset'],
                  },
                  'Change Music Preset',
                )
              }
              className="rounded-lg border border-orange-400/40 bg-[#050711] px-2.5 py-1 text-xs text-white cursor-pointer"
            >
              <option value="ambient-pulse">Ambient Pulse</option>
              <option value="cinematic-pad">Cinematic Pad</option>
              <option value="upbeat-synth">Upbeat Synth</option>
              {state.audio.customMusicUrl && <option value="custom-upload">Custom Upload</option>}
            </select>

            <input
              ref={musicFileInputRef}
              type="file"
              accept="audio/mpeg,audio/wav,audio/aac,audio/ogg,.mp3,.wav,.aac,.m4a,.ogg"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleMusicUpload(f);
              }}
              className="hidden"
            />
            <button
              type="button"
              disabled={musicUploading || state.trackLocks.music}
              onClick={() => musicFileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-orange-400/40 bg-orange-500/15 px-3 py-1 text-xs font-medium text-orange-100 hover:bg-orange-500/25 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {musicUploading ? 'Uploading Audio...' : 'Upload Audio (MP3/WAV)'}
            </button>

            {state.audio.customMusicUrl && (
              <>
                <audio ref={musicPreviewRef} src={apiUrl(state.audio.customMusicUrl)} onEnded={() => setMusicPreviewPlaying(false)} />
                <button
                  type="button"
                  onClick={toggleMusicPreview}
                  className="inline-flex items-center gap-1 rounded-lg bg-orange-500 px-2.5 py-1 text-xs font-semibold text-slate-950 cursor-pointer"
                >
                  {musicPreviewPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {musicPreviewPlaying ? 'Pause' : 'Preview Track'}
                </button>
              </>
            )}

            <label className="inline-flex items-center gap-1.5 text-slate-300">
              <span>Vol {Math.round(state.audio.musicVolume * 100)}%</span>
              <input
                type="range"
                min={0.05}
                max={0.8}
                step={0.05}
                disabled={state.trackLocks.music}
                value={state.audio.musicVolume}
                onChange={(e) =>
                  onUpdateAudioSettings({ musicVolume: parseFloat(e.target.value) }, 'Adjust Music Volume')
                }
                aria-label="Music volume"
                className="studio-range w-20 cursor-pointer"
              />
            </label>

            <label className="inline-flex items-center gap-1 text-slate-300">
              <span>Fade In/Out (s)</span>
              <input
                type="number"
                min={0}
                max={6}
                step={0.5}
                disabled={state.trackLocks.music}
                value={state.audio.musicFadeInSec}
                onChange={(e) =>
                  onUpdateAudioSettings(
                    { musicFadeInSec: Math.max(0, Number(e.target.value) || 0) },
                    'Music Fade In',
                  )
                }
                className="w-12 rounded-lg border border-white/15 bg-[#050711] px-1.5 py-1 text-xs text-white"
              />
            </label>
          </div>

          <div className="flex items-center gap-2">
            {musicUploadError && <span className="text-rose-300">{musicUploadError}</span>}
            {state.audio.musicEnabled && (
              <button
                type="button"
                disabled={state.trackLocks.music}
                onClick={() =>
                  onUpdateAudioSettings(
                    { musicEnabled: false, customMusicUrl: undefined, customMusicName: undefined },
                    'Remove Background Music',
                  )
                }
                className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-[11px] text-rose-200 cursor-pointer"
              >
                Remove Music
              </button>
            )}
          </div>
        </div>
      )}

      {/* Scrollable Multitrack Grid */}
      <div className="overflow-x-auto overflow-y-auto max-h-[280px]">
        <div style={{ minWidth: `${Math.round(100 * zoom)}%` }} className="relative">
          {/* Playhead Vertical Line */}
          <div
            style={{ left: `calc(148px + (100% - 148px) * ${Math.min(1, currentTime / totalDur)})` }}
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-cyan-400"
          >
            <div className="w-2.5 h-2.5 -ml-[4px] bg-cyan-400 rotate-45" />
          </div>

          {/* Time Ruler + Protected Content Markers */}
          <div className="flex border-b border-white/10 bg-[#060915]">
            <div className="w-[148px] shrink-0 border-r border-white/10 px-3 py-1.5 text-[11px] font-mono text-cyan-300">
              {formatTimecode(currentTime)}
            </div>
            <div
              onClick={handleRulerClick}
              className="relative flex-1 h-7 cursor-pointer flex items-center justify-between px-2 text-[10px] font-mono text-slate-500"
            >
              {[0, 0.2, 0.4, 0.6, 0.8, 1].map((frac) => (
                <span key={frac}>{formatTimecode(totalDur * frac)}</span>
              ))}
              {analysis.importantMoments
                .filter((m) => state.protectedMomentIds.includes(m.id))
                .map((m) => (
                  <div
                    key={m.id}
                    title={`Protected (${m.category}): ${m.title}`}
                    style={{ left: pct(Math.min(totalDur, m.start)) }}
                    className="absolute bottom-0.5 -ml-1.5 text-amber-400"
                  >
                    <Shield className="w-3 h-3" />
                  </div>
                ))}
            </div>
          </div>

          {/* Track 1: Video (Cyan / Blue) with Thumbnails + Drag Reorder */}
          <div className="flex border-b border-white/5 h-13">
            <div className="w-[148px] shrink-0 border-r border-white/10 px-3 flex items-center justify-between bg-[#080D1D]">
              <span className="text-xs font-semibold text-cyan-300">Video</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Toggle video track visibility"
                  onClick={() => onToggleTrackVisibility('video')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackVisibility.video ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  aria-label="Toggle video track lock"
                  onClick={() => onToggleTrackLock('video')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackLocks.video ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="relative flex-1 bg-[#050814] p-1">
              {state.segments.map((seg, idx) => {
                const isSelected = seg.id === selectedSegmentId;
                return (
                  <button
                    key={seg.id}
                    type="button"
                    draggable={!state.trackLocks.video}
                    onDragStart={() => {
                      dragFromIdxRef.current = idx;
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (
                        dragFromIdxRef.current !== null &&
                        dragFromIdxRef.current !== idx &&
                        !state.trackLocks.video
                      ) {
                        onMoveSegment(dragFromIdxRef.current, idx);
                      }
                      dragFromIdxRef.current = null;
                    }}
                    onClick={() => {
                      onSelectSegment(seg.id);
                      onSeek(seg.timelineStart);
                    }}
                    style={{
                      left: pct(seg.timelineStart),
                      width: widthPct(seg.timelineStart, seg.timelineEnd),
                    }}
                    className={`absolute top-1 bottom-1 rounded-md px-1.5 text-left overflow-hidden border transition-colors flex items-center gap-1.5 cursor-pointer ${
                      isSelected
                        ? 'border-cyan-300 bg-cyan-500/30 text-white'
                        : 'border-cyan-500/45 bg-cyan-500/15 text-cyan-100 hover:bg-cyan-500/25'
                    }`}
                  >
                    {seg.thumbnailUrl && (
                      <img
                        src={apiUrl(seg.thumbnailUrl)}
                        alt=""
                        className="h-full aspect-video rounded-xs object-contain bg-black shrink-0"
                      />
                    )}
                    <div className="flex items-center justify-between gap-1 text-[11px] font-medium truncate flex-1">
                      <span className="truncate">{seg.label}</span>
                      {seg.speed !== 1 && (
                        <span className="font-mono text-[10px] text-cyan-200 shrink-0">
                          {seg.speed}x
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Track 2: Audio (Violet) — Click any clip to adjust volume / mute */}
          <div className="flex border-b border-white/5 h-11">
            <div className="w-[148px] shrink-0 border-r border-white/10 px-3 flex items-center justify-between bg-[#080D1D]">
              <span className="text-xs font-semibold text-violet-300">Audio</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Mute or unmute audio track"
                  onClick={onToggleAudioMute}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.audio.muted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  aria-label="Toggle audio track lock"
                  onClick={() => onToggleTrackLock('audio')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackLocks.audio ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="relative flex-1 bg-[#050814] p-1">
              {state.segments.map((seg) => {
                const bars = getWaveformSlice(seg);
                const isAudSelected = seg.id === selectedAudioSegId;
                return (
                  <button
                    key={`aud-${seg.id}`}
                    type="button"
                    title="Click to adjust audio clip volume or mute"
                    onClick={() => {
                      setSelectedAudioSegId(seg.id);
                      onSeek(seg.timelineStart);
                    }}
                    style={{
                      left: pct(seg.timelineStart),
                      width: widthPct(seg.timelineStart, seg.timelineEnd),
                    }}
                    className={`absolute top-1 bottom-1 rounded-md border px-1 flex items-center gap-0.5 overflow-hidden cursor-pointer ${
                      state.audio.muted || seg.muted
                        ? 'border-slate-700 bg-slate-900/50 opacity-40'
                        : isAudSelected
                          ? 'border-violet-300 bg-violet-500/30'
                          : 'border-violet-500/45 bg-violet-500/15 hover:bg-violet-500/25'
                    }`}
                  >
                    {bars.map((amp, bIdx) => (
                      <div
                        key={bIdx}
                        style={{ height: `${Math.max(15, Math.round(amp * 100))}%` }}
                        className="flex-1 bg-violet-400/80 rounded-xs"
                      />
                    ))}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Track 3: Captions (Emerald) */}
          <div className="flex border-b border-white/5 h-10">
            <div className="w-[148px] shrink-0 border-r border-white/10 px-3 flex items-center justify-between bg-[#080D1D]">
              <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1">
                <Captions className="w-3.5 h-3.5" />
                Captions
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Toggle captions track visibility"
                  onClick={() => onToggleTrackVisibility('captions')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackVisibility.captions ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  aria-label="Toggle captions track lock"
                  onClick={() => onToggleTrackLock('captions')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackLocks.captions ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="relative flex-1 bg-[#050814] p-1">
              {projectedCaptions.length > 0 ? (
                projectedCaptions.map((cap) => (
                  <button
                    key={cap.id}
                    type="button"
                    title="Click to jump or edit caption text & timing"
                    onClick={() => {
                      onSeek(cap.timelineStart);
                      const originalCap = state.captions.find(
                        (c) => cap.id === `${c.id}` || cap.id.startsWith(`${c.id}-`),
                      );
                      if (originalCap) {
                        setEditingCaption({
                          id: originalCap.id,
                          text: originalCap.text,
                          sourceStart: originalCap.sourceStart,
                          sourceEnd: originalCap.sourceEnd,
                        });
                      }
                    }}
                    style={{
                      left: pct(cap.timelineStart),
                      width: widthPct(cap.timelineStart, cap.timelineEnd),
                    }}
                    className="absolute top-1 bottom-1 rounded-md border border-emerald-500/45 bg-emerald-500/15 px-1.5 text-[10px] text-emerald-100 truncate text-left hover:bg-emerald-500/25 cursor-pointer"
                  >
                    {cap.text}
                  </button>
                ))
              ) : analysis.transcript.length > 0 ? (
                <div className="h-full flex items-center px-2">
                  <button
                    type="button"
                    onClick={onGenerateCaptions}
                    className="inline-flex items-center gap-1 rounded-md border border-emerald-400/50 bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 cursor-pointer"
                  >
                    <Sparkles className="w-3 h-3" />
                    Generate Captions ({analysis.transcript.length})
                  </button>
                </div>
              ) : (
                <div className="h-full flex items-center px-3 text-[10px] text-slate-500">
                  No captions generated yet (transcribe audio or add text overlays)
                </div>
              )}
            </div>
          </div>

          {/* Track 4: Text Overlays (Magenta) */}
          <div className="flex border-b border-white/5 h-9">
            <div className="w-[148px] shrink-0 border-r border-white/10 px-3 flex items-center justify-between bg-[#080D1D]">
              <span className="text-xs font-semibold text-pink-300 flex items-center gap-1">
                <Type className="w-3.5 h-3.5" />
                Overlays
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Toggle overlays visibility"
                  onClick={() => onToggleTrackVisibility('overlays')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackVisibility.overlays ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  aria-label="Toggle overlays track lock"
                  onClick={() => onToggleTrackLock('overlays')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackLocks.overlays ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="relative flex-1 bg-[#050814] p-1">
              {state.overlays.map((ov) => (
                <button
                  key={ov.id}
                  type="button"
                  onClick={() => {
                    setSelectedOverlayId(ov.id);
                    onSeek(ov.timelineStart);
                  }}
                  style={{
                    left: pct(ov.timelineStart),
                    width: widthPct(ov.timelineStart, ov.timelineEnd),
                  }}
                  className={`absolute top-1 bottom-1 rounded-md border px-2 flex items-center justify-between gap-1 text-[10px] cursor-pointer ${
                    selectedOverlayId === ov.id
                      ? 'border-pink-300 bg-pink-500/35 text-white'
                      : 'border-pink-500/50 bg-pink-500/20 text-pink-100 hover:bg-pink-500/30'
                  }`}
                >
                  <span className="truncate">{ov.text}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Track 5: Music (Orange) */}
          <div className="flex h-9">
            <div className="w-[148px] shrink-0 border-r border-white/10 px-3 flex items-center justify-between bg-[#080D1D]">
              <span className="text-xs font-semibold text-orange-300 flex items-center gap-1">
                <Music className="w-3.5 h-3.5" />
                Music
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label="Toggle background music"
                  onClick={onToggleMusic}
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded border cursor-pointer ${
                    state.audio.musicEnabled
                      ? 'border-orange-400/50 bg-orange-500/20 text-orange-200'
                      : 'border-white/10 bg-slate-900 text-slate-400'
                  }`}
                >
                  {state.audio.musicEnabled ? 'ON' : 'OFF'}
                </button>
                <button
                  type="button"
                  aria-label="Toggle music track lock"
                  onClick={() => onToggleTrackLock('music')}
                  className="text-slate-400 hover:text-white cursor-pointer"
                >
                  {state.trackLocks.music ? <Lock className="w-3.5 h-3.5 text-amber-400" /> : <Unlock className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
            <div className="relative flex-1 bg-[#050814] p-1">
              {state.audio.musicEnabled ? (
                <button
                  type="button"
                  onClick={() => setShowMusicPanel(true)}
                  className="h-full w-full rounded-md border border-orange-500/45 bg-orange-500/15 px-2.5 flex items-center justify-between text-[10px] text-orange-200 hover:bg-orange-500/25 cursor-pointer"
                >
                  <span>
                    {state.audio.customMusicName
                      ? `Uploaded: ${state.audio.customMusicName}`
                      : `Ambient Bed (${state.audio.musicPreset})`}
                  </span>
                  <span className="font-mono">
                    Fade {state.audio.musicFadeInSec}s / {state.audio.musicFadeOutSec}s · Vol {Math.round(state.audio.musicVolume * 100)}%
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowMusicPanel(true)}
                  className="h-full w-full flex items-center px-3 text-[10px] text-slate-400 hover:text-orange-200 cursor-pointer"
                >
                  Click to choose preset or upload custom MP3 / WAV background music
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
