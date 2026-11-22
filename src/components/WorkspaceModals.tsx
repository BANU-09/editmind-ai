import { useEffect, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Download,
  Film,
  History,
  Layers,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type {
  EditVersion,
  ExportJob,
  HistoryEntry,
  MediaAnalysis,
  ProjectState,
  SearchHit,
} from '../shared/types';
import { formatTimecode } from '../shared/timelineEngine';
import { api, apiUrl } from '../lib/api';
import { downloadCaptionsFile } from '../lib/clientFallback';

/* ------------------------------------------------------------------ */
/* 1. FAST VIDEO CONTENT SEARCH MODAL                                 */
/* ------------------------------------------------------------------ */
interface SearchModalProps {
  projectId: string;
  state: ProjectState;
  analysis: MediaAnalysis;
  initialQuery?: string;
  onJumpToTime: (timelineTime: number | null, sourceStart: number) => void;
  onClose: () => void;
}

export function SearchModal({
  projectId,
  state,
  analysis,
  initialQuery = '',
  onJumpToTime,
  onClose,
}: SearchModalProps) {
  const [query, setQuery] = useState(initialQuery || 'AI');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  const runSearch = async (q: string) => {
    setLoading(true);
    try {
      const res = await api.searchProject(projectId, q, state);
      setHits(res.hits);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void runSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl border border-white/15 bg-[#0B1022] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Fast Video Content Search</h2>
          </div>
          <button
            type="button"
            aria-label="Close search modal"
            onClick={onClose}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-white/10 space-y-3 bg-[#070B19]">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(query);
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search footage by meaning"
              placeholder="Search spoken phrases, topics, speakers, objects, or scenes..."
              className="flex-1 rounded-xl border border-white/15 bg-[#050711] px-3.5 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl bg-cyan-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              Search
            </button>
          </form>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400">Indexed topics:</span>
            {analysis.topics.slice(0, 6).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => {
                  setQuery(t);
                  void runSearch(t);
                }}
                className="rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1 text-slate-300 hover:border-cyan-400/50 cursor-pointer"
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="py-10 text-center text-sm text-slate-400">Searching reusable index...</div>
          ) : hits.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-400">
              No matches found for "{query}". Try searching a spoken phrase, speaker name, or scene object.
            </div>
          ) : (
            hits.map((hit) => (
              <div
                key={hit.id}
                className="rounded-xl border border-white/10 bg-[#070B19] p-3.5 flex flex-col sm:flex-row gap-3 items-start justify-between"
              >
                <div className="flex gap-3 items-start">
                  {hit.thumbnailUrl && (
                    <img
                      src={apiUrl(hit.thumbnailUrl)}
                      alt={hit.snippet}
                      referrerPolicy="no-referrer"
                      className="w-24 h-14 rounded-lg object-cover border border-white/10 shrink-0"
                    />
                  )}
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-cyan-300 uppercase">{hit.matchType}</span>
                      {hit.speaker && <span className="text-violet-300">· {hit.speaker}</span>}
                      <span className="font-mono text-slate-400">
                        · Src {formatTimecode(hit.sourceStart)}–{formatTimecode(hit.sourceEnd)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-200 leading-relaxed">{hit.snippet}</p>
                    <p className="text-[11px] text-slate-400">{hit.explanation}</p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!hit.inCurrentTimeline}
                  onClick={() => {
                    onJumpToTime(hit.timelineStart, hit.sourceStart);
                    onClose();
                  }}
                  className="shrink-0 rounded-lg bg-cyan-500/20 border border-cyan-400/50 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-40 cursor-pointer"
                >
                  {hit.inCurrentTimeline && hit.timelineStart !== null
                    ? `Jump ${formatTimecode(hit.timelineStart)}`
                    : 'Cut from Timeline'}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. IMPORTANT CONTENT PROTECTION MODAL                              */
/* ------------------------------------------------------------------ */
interface ProtectionModalProps {
  analysis: MediaAnalysis;
  protectedIds: string[];
  onToggleProtect: (momentId: string) => void;
  onJumpToSource: (sourceStart: number) => void;
  onClose: () => void;
}

export function ProtectionModal({
  analysis,
  protectedIds,
  onToggleProtect,
  onJumpToSource,
  onClose,
}: ProtectionModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-white/15 bg-[#0B1022] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-amber-400" />
            <h2 className="text-base font-bold text-white">Important Content Protection</h2>
          </div>
          <button
            type="button"
            aria-label="Close protection modal"
            onClick={onClose}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-white/10 bg-[#070B19] text-xs text-slate-300">
          Protected moments trigger an explicit impact warning before any AI prompt or manual edit removes them.
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {analysis.importantMoments.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">
              No key benefits, warnings, or CTAs were flagged in this clip.
            </div>
          ) : (
            analysis.importantMoments.map((m) => {
              const isProtected = protectedIds.includes(m.id);
              return (
                <div
                  key={m.id}
                  className={`rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                    isProtected
                      ? 'border-amber-400/40 bg-amber-500/10'
                      : 'border-white/10 bg-[#070B19]'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-bold uppercase text-amber-300">{m.category}</span>
                      <span className="font-mono text-slate-400">
                        · {formatTimecode(m.start)} – {formatTimecode(m.end)}
                      </span>
                    </div>
                    <div className="text-sm font-semibold text-white">{m.title}</div>
                    <div className="text-xs text-slate-400">{m.reason}</div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        onJumpToSource(m.start);
                        onClose();
                      }}
                      className="rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 cursor-pointer"
                    >
                      Inspect
                    </button>
                    <button
                      type="button"
                      onClick={() => onToggleProtect(m.id)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold cursor-pointer ${
                        isProtected
                          ? 'bg-amber-400 text-slate-950'
                          : 'border border-white/15 bg-slate-900 text-slate-300'
                      }`}
                    >
                      {isProtected ? 'Protected' : 'Unprotected'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. MULTIPLE EDIT VERSION GENERATOR MODAL                           */
/* ------------------------------------------------------------------ */
interface VersionsModalProps {
  versions: EditVersion[];
  activeVersionId?: string;
  onApplyVersion: (version: EditVersion) => void;
  onRegenerate: () => Promise<void>;
  onClose: () => void;
}

export function VersionsModal({
  versions,
  activeVersionId,
  onApplyVersion,
  onRegenerate,
  onClose,
}: VersionsModalProps) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-4xl max-h-[88vh] flex flex-col rounded-2xl border border-white/15 bg-[#0B1022] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-pink-400" />
            <h2 className="text-base font-bold text-white">Multiple Edit Version Generator</h2>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onRegenerate();
                } finally {
                  setBusy(false);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:border-cyan-400 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
              Recompute Versions
            </button>
            <button
              type="button"
              aria-label="Close versions modal"
              onClick={onClose}
              className="text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-4 border-b border-white/10 bg-[#070B19] text-xs text-slate-300">
          Applying a version creates a new timeline snapshot in History and never overwrites your original source media.
        </div>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-1 md:grid-cols-3 gap-4">
          {versions.map((ver) => {
            const isActive = ver.id === activeVersionId;
            return (
              <div
                key={ver.id}
                className={`rounded-2xl border p-5 flex flex-col justify-between gap-4 ${
                  isActive
                    ? 'border-cyan-400 bg-cyan-500/10'
                    : 'border-white/10 bg-[#070B19]'
                }`}
              >
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-medium text-pink-300">{ver.tagline}</div>
                    <h3 className="text-lg font-bold text-white mt-0.5">{ver.name}</h3>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">{ver.description}</p>

                  <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                    <div className="rounded-lg bg-slate-900/90 p-2 border border-white/5">
                      <div className="text-slate-400 text-[11px]">Duration</div>
                      <div className="font-mono font-bold text-cyan-300">
                        {formatTimecode(ver.durationSec)}
                      </div>
                    </div>
                    <div className="rounded-lg bg-slate-900/90 p-2 border border-white/5">
                      <div className="text-slate-400 text-[11px]">Coverage</div>
                      <div className="font-mono font-bold text-violet-300">
                        {ver.coveragePercent}%
                      </div>
                    </div>
                  </div>

                  <div className="text-[11px] font-mono text-slate-400">
                    {ver.pacingLabel} · {ver.segmentCount} segments
                  </div>

                  <ul className="space-y-1 text-xs text-slate-300">
                    {ver.highlights.map((h) => (
                      <li key={h} className="flex items-center gap-1.5">
                        <Sparkles className="w-3 h-3 text-cyan-400 shrink-0" />
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    onApplyVersion(ver);
                    onClose();
                  }}
                  className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 py-2.5 text-xs font-bold text-white hover:brightness-110 cursor-pointer"
                >
                  {isActive ? 'Re-Apply Version' : `Use ${ver.name}`}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. HISTORY & SEGMENT RECOVERY DRAWER                               */
/* ------------------------------------------------------------------ */
interface HistoryModalProps {
  history: HistoryEntry[];
  historyIndex: number;
  analysis: MediaAnalysis;
  state: ProjectState;
  onRestoreSnapshot: (index: number) => void;
  onRestoreRemovedSourceSegment: (start: number, end: number, label: string) => void;
  onClose: () => void;
}

export function HistoryModal({
  history,
  historyIndex,
  analysis,
  state,
  onRestoreSnapshot,
  onRestoreRemovedSourceSegment,
  onClose,
}: HistoryModalProps) {
  // Find original transcript segments currently missing from timeline for individual restoration
  const missingTranscriptSegments = analysis.transcript.filter(
    (tr) =>
      !state.segments.some(
        (seg) => Math.min(seg.sourceEnd, tr.end) - Math.max(seg.sourceStart, tr.start) > 0.25,
      ),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl border border-white/15 bg-[#0B1022] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Operation History & Recovery</h2>
          </div>
          <button
            type="button"
            aria-label="Close history modal"
            onClick={onClose}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-6">
          {missingTranscriptSegments.length > 0 && (
            <div className="space-y-2.5">
              <h3 className="text-xs font-semibold text-amber-300">
                Removed Segments Available for Individual Restoration
              </h3>
              <div className="space-y-2">
                {missingTranscriptSegments.map((tr) => (
                  <div
                    key={tr.id}
                    className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 flex items-center justify-between gap-3"
                  >
                    <div className="text-xs space-y-0.5">
                      <div className="font-semibold text-white">
                        {tr.topic} ·{' '}
                        <span className="font-mono text-amber-300">
                          {formatTimecode(tr.start)}–{formatTimecode(tr.end)}
                        </span>
                      </div>
                      <div className="text-slate-400 line-clamp-1">{tr.text}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRestoreRemovedSourceSegment(tr.start, tr.end, tr.topic)}
                      className="inline-flex items-center gap-1 rounded-lg bg-amber-400 px-3 py-1.5 text-xs font-semibold text-slate-950 shrink-0 cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-2.5">
            <h3 className="text-xs font-semibold text-slate-300">
              Timeline Operation Snapshots ({history.length})
            </h3>
            <div className="space-y-2">
              {history
                .slice()
                .reverse()
                .map((entry, revIdx) => {
                  const actualIdx = history.length - 1 - revIdx;
                  const isCurrent = actualIdx === historyIndex;
                  return (
                    <div
                      key={entry.id}
                      className={`rounded-xl border p-3 flex items-center justify-between gap-3 ${
                        isCurrent
                          ? 'border-cyan-400/60 bg-cyan-500/10'
                          : 'border-white/10 bg-[#070B19]'
                      }`}
                    >
                      <div className="text-xs space-y-0.5">
                        <div className="font-semibold text-white">
                          {entry.label} {isCurrent && <span className="text-cyan-300">(Current)</span>}
                        </div>
                        {entry.prompt && (
                          <div className="text-slate-400 italic">"{entry.prompt}"</div>
                        )}
                        <div className="font-mono text-[11px] text-slate-400">
                          Duration: {formatTimecode(entry.durationAfter)} ·{' '}
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => onRestoreSnapshot(actualIdx)}
                          className="rounded-lg border border-white/15 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400 cursor-pointer"
                        >
                          Restore
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. REAL FFmpeg MP4 EXPORT MODAL                                    */
/* ------------------------------------------------------------------ */
interface ExportModalProps {
  projectId: string;
  projectTitle: string;
  state: ProjectState;
  analysis?: MediaAnalysis;
  sourceWidth?: number;
  sourceHeight?: number;
  activeTranslationLang?: string | null;
  onClose: () => void;
}

function getExportResLabel(res: ExportJob['resolution'], w?: number, h?: number): string {
  const shortSide = res === '480p' ? 480 : res === '1080p' ? 1080 : 720;
  const longSide = res === '480p' ? 854 : res === '1080p' ? 1920 : 1280;
  if (w && h) {
    if (h > w) return `${res} (${shortSide}×${longSide} Portrait)`;
    if (Math.abs(w - h) <= Math.max(w, h) * 0.08) return `${res} (${shortSide}×${shortSide} Square)`;
  }
  return `${res} (${longSide}×${shortSide} Landscape)`;
}

export function ExportModal({
  projectId,
  projectTitle,
  state,
  analysis,
  sourceWidth,
  sourceHeight,
  activeTranslationLang,
  onClose,
}: ExportModalProps) {
  const [resolution, setResolution] = useState<ExportJob['resolution']>('720p');
  const [quality, setQuality] = useState<ExportJob['quality']>('balanced');
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!job || job.status === 'completed' || job.status === 'failed') return;
    const timer = window.setInterval(async () => {
      try {
        const res = await api.getExportStatus(job.id);
        setJob(res.job);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Status check failed');
      }
    }, 650);
    return () => window.clearInterval(timer);
  }, [job]);

  const handleStartExport = async () => {
    setError(null);
    try {
      const res = await api.startExport(projectId, state, resolution, quality);
      setJob(res.job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start FFmpeg export.');
    }
  };

  const browserExport = projectId.startsWith('proj-local-');
  const format = browserExport ? 'WebM' : 'MP4';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-2xl rounded-2xl border border-white/15 bg-[#0B1022] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2">
            <Film className="w-4 h-4 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Export Edited {format} ({projectTitle})</h2>
          </div>
          <button
            type="button"
            aria-label="Close export modal"
            onClick={onClose}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-3 gap-3 text-xs">
            <div className="rounded-xl border border-white/10 bg-[#070B19] p-3">
              <div className="text-slate-400">Edited Duration</div>
              <div className="font-mono text-base font-bold text-cyan-300 mt-0.5">
                {formatTimecode(state.duration)}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#070B19] p-3">
              <div className="text-slate-400">Active Clips</div>
              <div className="font-mono text-base font-bold text-violet-300 mt-0.5">
                {state.segments.length}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-[#070B19] p-3">
              <div className="text-slate-400">Captions & FX</div>
              <div className="font-mono text-base font-bold text-emerald-300 mt-0.5">
                {state.captionsEnabled ? 'Burned In' : 'Off'}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="export-res" className="block text-xs font-medium text-slate-300 mb-1.5">
                Resolution
              </label>
              <select
                id="export-res"
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ExportJob['resolution'])}
                disabled={Boolean(job && (job.status === 'queued' || job.status === 'rendering'))}
                className="w-full rounded-xl border border-white/15 bg-[#060914] px-3 py-2 text-sm text-white focus:outline-none"
              >
                <option value="480p">{getExportResLabel('480p', sourceWidth, sourceHeight)}</option>
                <option value="720p">{getExportResLabel('720p', sourceWidth, sourceHeight)}</option>
                <option value="1080p">{getExportResLabel('1080p', sourceWidth, sourceHeight)}</option>
              </select>
            </div>
            <div>
              <label htmlFor="export-qual" className="block text-xs font-medium text-slate-300 mb-1.5">
                Encoding Quality
              </label>
              <select
                id="export-qual"
                value={quality}
                onChange={(e) => setQuality(e.target.value as ExportJob['quality'])}
                disabled={Boolean(job && (job.status === 'queued' || job.status === 'rendering'))}
                className="w-full rounded-xl border border-white/15 bg-[#060914] px-3 py-2 text-sm text-white focus:outline-none"
              >
                <option value="fast">Fast Draft (H.264 Ultrafast)</option>
                <option value="balanced">Balanced (CRF 22)</option>
                <option value="high">Master High Quality (CRF 18)</option>
              </select>
            </div>
          </div>

          {job && (job.status === 'queued' || job.status === 'rendering' || job.status === 'validating') && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-cyan-300 capitalize">
                  {browserExport ? 'Recording the edited timeline with audio…' : job.status === 'validating'
                    ? 'Validating output MP4 with FFprobe...'
                    : 'Rendering timeline cuts, speed, audio & captions via FFmpeg...'}
                </span>
                <span className="font-mono tabular-nums text-white">{job.progress}%</span>
              </div>
              <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-400 via-violet-500 to-pink-500 transition-all"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
            </div>
          )}

          {(error || job?.status === 'failed') && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
                <span>{error || job?.error || 'Export failed.'}</span>
              </div>
              <button
                type="button"
                onClick={() => void handleStartExport()}
                className="rounded-lg bg-rose-500 px-3 py-1 text-xs font-semibold text-white shrink-0 cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {job?.status === 'completed' && job.outputUrl && (() => {
            const isBlobOut = job.outputUrl.startsWith('blob:');
            const resolvedOut = isBlobOut ? job.outputUrl : apiUrl(job.outputUrl);
            const downloadHref = isBlobOut ? job.outputUrl : apiUrl(`${job.outputUrl}?dl=1`);
            const safeSlug = projectTitle.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'editmind-export';
            const fallbackAnalysis = analysis || ({ transcript: [], translationTracks: {} } as unknown as MediaAnalysis);
            return (
              <div className="space-y-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-1.5 font-semibold text-emerald-300">
                    <CheckCircle2 className="w-4 h-4" />
                    {isBlobOut ? 'WebM Export Ready' : 'Validated MP4 Export Ready'}
                  </span>
                  <span className="font-mono text-slate-200">
                    Duration: {job.durationSec?.toFixed(2)}s ·{' '}
                    {((job.fileSizeBytes || 0) / 1024).toFixed(0)} KB
                  </span>
                </div>

                <div className="w-full max-h-[340px] bg-black rounded-lg border border-white/10 flex items-center justify-center overflow-hidden">
                  <video
                    src={resolvedOut}
                    controls
                    playsInline
                    className="max-w-full max-h-[340px] object-contain"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2.5">
                  {state.captions.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void downloadCaptionsFile(
                            projectId,
                            state,
                            fallbackAnalysis,
                            'srt',
                            activeTranslationLang,
                            apiUrl(
                              `/api/projects/${projectId}/captions/export?format=srt${
                                activeTranslationLang
                                  ? `&lang=${encodeURIComponent(activeTranslationLang)}`
                                  : ''
                              }`,
                            ),
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/40 bg-cyan-500/15 px-4 py-2.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/25 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download .SRT
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void downloadCaptionsFile(
                            projectId,
                            state,
                            fallbackAnalysis,
                            'vtt',
                            activeTranslationLang,
                            apiUrl(
                              `/api/projects/${projectId}/captions/export?format=vtt${
                                activeTranslationLang
                                  ? `&lang=${encodeURIComponent(activeTranslationLang)}`
                                  : ''
                              }`,
                            ),
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 cursor-pointer"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download .VTT
                      </button>
                    </>
                  )}
                  <a
                    href={downloadHref}
                    download={isBlobOut ? `${safeSlug}.webm` : true}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-xs font-bold text-slate-950 hover:bg-emerald-400"
                  >
                    <Download className="w-4 h-4" />
                    {isBlobOut ? 'Download Rendered WebM' : 'Download Rendered MP4'}
                  </a>
                </div>
              </div>
            );
          })()}

          {(!job || job.status === 'failed') && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {state.captions.length > 0 ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void downloadCaptionsFile(
                        projectId,
                        state,
                        analysis || ({ transcript: [], translationTracks: {} } as unknown as MediaAnalysis),
                        'srt',
                        activeTranslationLang,
                        apiUrl(
                          `/api/projects/${projectId}/captions/export?format=srt${
                            activeTranslationLang
                              ? `&lang=${encodeURIComponent(activeTranslationLang)}`
                              : ''
                          }`,
                        ),
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-cyan-200 hover:border-cyan-400/50 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export .SRT
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadCaptionsFile(
                        projectId,
                        state,
                        analysis || ({ transcript: [], translationTracks: {} } as unknown as MediaAnalysis),
                        'vtt',
                        activeTranslationLang,
                        apiUrl(
                          `/api/projects/${projectId}/captions/export?format=vtt${
                            activeTranslationLang
                              ? `&lang=${encodeURIComponent(activeTranslationLang)}`
                              : ''
                          }`,
                        ),
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-violet-200 hover:border-violet-400/50 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export .VTT
                  </button>
                </div>
              ) : (
                <div />
              )}
              <button
                type="button"
                onClick={() => void handleStartExport()}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 via-blue-600 to-violet-600 px-6 py-2.5 text-sm font-semibold text-white hover:brightness-110 cursor-pointer"
              >
                <Play className="w-4 h-4" />
                Render Final {format}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 6. PROJECT-SPECIFIC VOCABULARY DICTIONARY MODAL                    */
/* ------------------------------------------------------------------ */
interface VocabularyModalProps {
  initialVocabulary: string[];
  onSave: (vocabulary: string[], retranscribeNow: boolean) => Promise<void>;
  onClose: () => void;
}

export function VocabularyModal({
  initialVocabulary,
  onSave,
  onClose,
}: VocabularyModalProps) {
  const [terms, setTerms] = useState<string[]>(initialVocabulary);
  const [newTermInput, setNewTermInput] = useState('');
  const [busy, setBusy] = useState(false);

  const handleAddTerms = () => {
    const parsed = newTermInput
      .split(/[\n,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parsed.length === 0) return;
    setTerms((prev) => Array.from(new Set([...prev, ...parsed])));
    setNewTermInput('');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-2xl border border-white/15 bg-[#0B1022] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-cyan-400" />
            <h2 className="text-base font-bold text-white">Project Custom Vocabulary Dictionary</h2>
          </div>
          <button
            type="button"
            aria-label="Close vocabulary modal"
            onClick={onClose}
            className="text-slate-400 hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-white/10 bg-[#070B19] text-xs text-slate-300 leading-relaxed">
          Add personal names, college or company names, technical terms, acronyms, and domain vocabulary. These terms guide speech recognition and Pass-2 audio verification.
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newTermInput}
              onChange={(e) => setNewTermInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTerms();
                }
              }}
              aria-label="Add vocabulary terms"
              placeholder="e.g. IncuBrix, IIT Madras, Kubernetes, Thiruvalluvar (comma-separated)"
              className="flex-1 rounded-xl border border-white/15 bg-[#050711] px-3.5 py-2 text-xs text-white focus:border-cyan-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleAddTerms}
              className="inline-flex items-center gap-1 rounded-xl bg-cyan-500 px-3.5 py-2 text-xs font-bold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>

          {terms.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/15 p-6 text-center text-xs text-slate-400">
              No custom vocabulary terms added yet.
            </div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {terms.map((term) => (
                <div
                  key={term}
                  className="flex items-center justify-between rounded-lg border border-white/10 bg-[#070B19] px-3 py-1.5 text-xs"
                >
                  <span className="text-slate-100 font-medium">{term}</span>
                  <button
                    type="button"
                    aria-label={`Remove vocabulary term ${term}`}
                    onClick={() => setTerms((prev) => prev.filter((t) => t !== term))}
                    className="text-slate-400 hover:text-rose-400 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-t border-white/10 px-5 py-4 bg-[#070B19] flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(terms, false);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-xl border border-white/15 bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:border-cyan-400 cursor-pointer"
          >
            Save Dictionary
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(terms, true);
                onClose();
              } finally {
                setBusy(false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-4 py-2 text-xs font-bold text-white hover:brightness-110 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
            Save & Re-transcribe
          </button>
        </div>
      </div>
    </div>
  );
}
