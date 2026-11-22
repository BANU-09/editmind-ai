import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Captions,
  Check,
  Download,
  Film,
  Globe,
  History,
  Languages,
  Layers,
  Loader2,
  Play,
  Redo2,
  RefreshCw,
  Search,
  Send,
  Shield,
  Sparkles,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react';
import type {
  AnalysisJob,
  EditImpactReport,
  EditPlan,
  EditVersion,
  HistoryEntry,
  MediaAnalysis,
  ProjectState,
  SearchHit,
  TranscriptWord,
} from '../shared/types';
import {
  applyEditPlan,
  formatTimecode,
  mapSourceTimeToTimeline,
  recalculateTimeline,
  reorderSegments,
  splitSegmentAtTimelineTime,
  trimSegment,
} from '../shared/timelineEngine';
import { api, apiUrl, type HydratedProject, type LanguageOption } from '../lib/api';
import { downloadCaptionsFile } from '../lib/clientFallback';
import { getBundledAudioForDemo } from '../lib/audioEngine';
import { getNarrationPosition } from '../lib/fallbackData';
import { VirtualVideoPlayer } from './VirtualVideoPlayer';
import { TimelinePanel } from './TimelinePanel';
import {
  ExportModal,
  HistoryModal,
  ProtectionModal,
  SearchModal,
  VersionsModal,
  VocabularyModal,
} from './WorkspaceModals';

interface WorkspaceProps {
  project: HydratedProject;
  onProjectUpdated: (proj: HydratedProject) => void;
  onBackDashboard: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  plan?: EditPlan;
  impact?: EditImpactReport;
  searchHits?: SearchHit[];
  stages?: string[];
  status?: 'pending' | 'applied' | 'cancelled' | 'clarification' | 'error';
}

const SUGGESTED_PROMPTS = [
  'Remove unnecessary pauses.',
  'Remove filler words.',
  'Remove the second mention of pricing.',
  'Make the video shorter.',
  'Change captions to yellow.',
  'Make the introduction twice as fast.',
  'Move the conclusion to the beginning.',
  'Find every section where the speaker mentions AI.',
];

function HighlightedText({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark
            key={i}
            className="bg-cyan-400/35 text-cyan-100 rounded-xs px-0.5 font-semibold"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export function Workspace(props: WorkspaceProps) {
  if (!props.project?.media) {
    return (
      <div className="min-h-screen bg-[#050711] text-slate-100 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-2xl border border-white/10 bg-[#0B1022] p-6 text-center space-y-4">
          <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
          <h2 className="text-lg font-semibold text-white">Source Media Unavailable</h2>
          <p className="text-xs text-slate-400">
            The source video for "{props.project?.title || 'this project'}" could not be loaded.
          </p>
          <button
            type="button"
            onClick={props.onBackDashboard}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }
  return <WorkspaceInner {...props} />;
}

function WorkspaceInner({
  project,
  onProjectUpdated,
  onBackDashboard,
}: WorkspaceProps) {
  const media = project.media!;
  const [analysis, setAnalysis] = useState<MediaAnalysis>(media.analysis);

  useEffect(() => {
    if (project.media?.analysis) {
      setAnalysis(project.media.analysis);
    }
  }, [project.media]);

  const [title, setTitle] = useState(project.title);
  const [state, setState] = useState<ProjectState>(project.state);
  const [history, setHistory] = useState<HistoryEntry[]>(project.history);
  const [historyIndex, setHistoryIndex] = useState<number>(project.historyIndex);
  const [versions, setVersions] = useState<EditVersion[]>(project.versions);

  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved');
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(
    project.state.segments[0]?.id || null,
  );

  // Left panel tabs, filter, word inspector & reanalysis retry
  const [leftTab, setLeftTab] = useState<'transcript' | 'scenes' | 'speakers'>('transcript');
  const [transcriptFilter, setTranscriptFilter] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState<string | null>(null);
  const [selectedWord, setSelectedWord] = useState<{
    word: TranscriptWord;
    topic: string;
  } | null>(null);
  const [wordEditValue, setWordEditValue] = useState('');
  const [wordEditSaving, setWordEditSaving] = useState(false);
  const [wordEditError, setWordEditError] = useState<string | null>(null);
  const snippetAudioRef = useRef<HTMLAudioElement | null>(null);

  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [languageOverride, setLanguageOverride] = useState<string>(
    media.analysis.selectedLanguageOverride || 'auto',
  );
  const [vocabulary, setVocabulary] = useState<string[]>(
    project.vocabulary || media.analysis.vocabulary || [],
  );
  const [activeTranslationLang, setActiveTranslationLang] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listLanguages()
      .then((res) => setLanguages(res.languages))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setWordEditValue(selectedWord?.word.word || '');
    setWordEditError(null);
  }, [selectedWord?.word.id, selectedWord?.word.word]);

  const isJobActiveStatus = (s?: string) =>
    ['queued', 'extracting-audio', 'transcribing', 'aligning', 'generating-captions'].includes(
      s || '',
    );

  const onProjectUpdatedRef = useRef(onProjectUpdated);
  useEffect(() => {
    onProjectUpdatedRef.current = onProjectUpdated;
  }, [onProjectUpdated]);

  // Sync latest background analysis job & auto-poll until transcription finishes
  useEffect(() => {
    let cancelled = false;
    let polling = false;
    const syncOnce = async () => {
      if (polling) return;
      polling=true;
      try {
        const res = await api.getProjectAnalysisStatus(project.id);
        if (cancelled) return;
        if (res.job) setAnalysisJob(res.job);
        if (res.analysis) {
          setAnalysis(res.analysis);
          if (!isJobActiveStatus(res.analysis.transcriptionStatus)) {
            onProjectUpdatedRef.current(res.project);
            setVersions(res.project.versions);
            if (res.project.history.length===1) setHistory(prev=>prev.length===1?res.project.history:prev);
            // If user hasn't customized timeline yet, seamlessly populate newly transcribed segments & captions
            setState((prev) => {
              const wasUntouchedSingle =
                prev.segments.length === 1 &&
                prev.segments[0].sourceSegmentId === 'src-full' &&
                res.project.state.segments.length > 0;
              if (wasUntouchedSingle && res.analysis!.transcript.length > 0) {
                return {
                  ...res.project.state,
                  audio: prev.audio,
                  overlays: prev.overlays,
                  trackVisibility: prev.trackVisibility,
                  trackLocks: prev.trackLocks,
                };
              }
              if (prev.captions.length === 0 && res.project.state.captions.length > 0) {
                return {
                  ...prev,
                  captions: res.project.state.captions,
                  captionsEnabled: true,
                  protectedMomentIds:
                    prev.protectedMomentIds.length === 0
                      ? res.project.state.protectedMomentIds
                      : prev.protectedMomentIds,
                };
              }
              return prev;
            });
          }
        }
      } catch {
        // Retry on the next poll.
      } finally { polling=false; }
    };

    void syncOnce();
    if (!isJobActiveStatus(analysis.transcriptionStatus) && !isJobActiveStatus(analysisJob?.status)) {
      return () => {
        cancelled = true;
      };
    }
    const timer = window.setInterval(() => {
      void syncOnce();
    }, 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [project.id, analysis.transcriptionStatus, analysisJob?.status]);

  // Right AI Assistant
  const [promptInput, setPromptInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const formatWelcomeText = (a: MediaAnalysis) => {
    const wordTotal =
      a.wordCount ?? a.transcript.reduce((acc, s) => acc + s.words.length, 0);
    const statusLabel =
      a.transcriptionStatus === 'no-audio'
        ? 'No Audio Stream'
        : a.transcriptionStatus === 'failed'
          ? 'Transcription Failed — Retry Available'
          : a.transcriptionStatus === 'partial'
            ? `Partial Transcript (${wordTotal} words)`
            : isJobActiveStatus(a.transcriptionStatus)
              ? 'Transcribing Speech in Background...'
              : `${wordTotal} words transcribed · Captions ready`;
    return `Loaded "${media.filename}" (${formatTimecode(a.durationSec)} · ${media.width}×${media.height} · ${statusLabel}). Describe word-level, scene, caption, or timing edits below.`;
  };

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: formatWelcomeText(media.analysis),
    },
  ]);

  useEffect(() => {
    setMessages((prev) =>
      prev.map((m) => (m.id === 'welcome' ? { ...m, text: formatWelcomeText(analysis) } : m)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.transcriptionStatus, analysis.wordCount, analysis.transcript.length]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, aiBusy]);

  // Animated stage progression while planning AI edit
  // Modals
  const [activeModal, setActiveModal] = useState<
    null | 'search' | 'protection' | 'versions' | 'history' | 'export' | 'vocabulary'
  >(null);
  const [searchInitialQuery, setSearchInitialQuery] = useState('');

  // Autosave debounce
  const saveTimerRef = useRef<number | null>(null);
  const persistNow = useCallback(
    async (
      nextTitle: string,
      nextState: ProjectState,
      nextHistory: HistoryEntry[],
      nextIndex: number,
      nextVersions: EditVersion[],
    ) => {
      setSaveStatus('saving');
      try {
        const res = await api.updateProject(project.id, {
          title: nextTitle,
          state: nextState,
          history: nextHistory,
          historyIndex: nextIndex,
          versions: nextVersions,
        });
        onProjectUpdated(res.project);
      } finally {
        setSaveStatus('saved');
      }
    },
    [project.id, onProjectUpdated],
  );

  const scheduleAutosave = useCallback(
    (
      nextTitle: string,
      nextState: ProjectState,
      nextHistory: HistoryEntry[],
      nextIndex: number,
      nextVersions: EditVersion[],
    ) => {
      setSaveStatus('saving');
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        void persistNow(nextTitle, nextState, nextHistory, nextIndex, nextVersions);
      }, 350);
    },
    [persistNow],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  const commitStateChange = useCallback(
    (nextState: ProjectState, label: string, prompt?: string) => {
      const sliced = history.slice(0, historyIndex + 1);
      const entry: HistoryEntry = {
        id: `hist-${Date.now().toString(36)}`,
        timestamp: new Date().toISOString(),
        label,
        prompt,
        durationAfter: nextState.duration,
        stateSnapshot: nextState,
      };
      const nextHistory = [...sliced, entry];
      const nextIndex = nextHistory.length - 1;
      setState(nextState);
      setHistory(nextHistory);
      setHistoryIndex(nextIndex);
      if (nextState.segments.length > 0 && !nextState.segments.some((s) => s.id === selectedSegmentId)) {
        setSelectedSegmentId(nextState.segments[0].id);
      }
      if (currentTime > nextState.duration) {
        setCurrentTime(Math.max(0, nextState.duration - 0.1));
      }
      scheduleAutosave(title, nextState, nextHistory, nextIndex, versions);
    },
    [history, historyIndex, selectedSegmentId, currentTime, scheduleAutosave, title, versions],
  );

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return;
    const targetIdx = historyIndex - 1;
    const snap = history[targetIdx].stateSnapshot;
    setState(snap);
    setHistoryIndex(targetIdx);
    setCurrentTime(0);
    scheduleAutosave(title, snap, history, targetIdx, versions);
  }, [historyIndex, history, scheduleAutosave, title, versions]);

  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const targetIdx = historyIndex + 1;
    const snap = history[targetIdx].stateSnapshot;
    setState(snap);
    setHistoryIndex(targetIdx);
    setCurrentTime(0);
    scheduleAutosave(title, snap, history, targetIdx, versions);
  }, [historyIndex, history, scheduleAutosave, title, versions]);

  const handleJumpToSourceTime = useCallback((sourceTime: number) => {
    const tl = mapSourceTimeToTimeline(state.segments, sourceTime);
    if (tl !== null) {
      setCurrentTime(tl);
      const seg = state.segments.find(
        (s) => tl >= s.timelineStart - 0.01 && tl <= s.timelineEnd + 0.01,
      );
      if (seg) setSelectedSegmentId(seg.id);
    }
  }, [state.segments]);

  const handleRetryAnalysis = async () => {
    if (reanalyzing) return;
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      const res = await api.reanalyzeMedia(media.id, project.id);
      setAnalysisJob(res.job);
      setAnalysis((prev) => ({
        ...prev,
        transcriptionStatus: res.job.status,
        transcriptionError: undefined,
      }));
    } catch (err) {
      setReanalyzeError(err instanceof Error ? err.message : 'Retry analysis failed.');
    } finally {
      setReanalyzing(false);
    }
  };

  const handleRetryFailedChunks = async () => {
    if (!analysisJob || reanalyzing) return;
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      const res = await api.retryFailedAnalysisChunks(analysisJob.id);
      setAnalysisJob(res.job);
      setAnalysis((prev) => ({ ...prev, transcriptionStatus: 'transcribing' }));
    } catch (err) {
      setReanalyzeError(err instanceof Error ? err.message : 'Retry failed chunks error.');
    } finally {
      setReanalyzing(false);
    }
  };

  const handleCancelAnalysis = async () => {
    if (!analysisJob) return;
    try {
      const res = await api.cancelAnalysisJob(analysisJob.id);
      setAnalysisJob(res.job);
      setAnalysis((prev) => ({ ...prev, transcriptionStatus: 'cancelled' }));
    } catch {
      // Ignore
    }
  };

  const handleSelectAudioStream = async (streamIndex: number) => {
    if (reanalyzing) return;
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      const res = await api.selectAudioStream(media.id, streamIndex, project.id);
      setAnalysisJob(res.job);
      setAnalysis((prev) => ({
        ...prev,
        selectedAudioStream: streamIndex,
        transcriptionStatus: res.job.status,
        transcript: [],
      }));
    } catch (err) {
      setReanalyzeError(err instanceof Error ? err.message : 'Failed to switch audio track.');
    } finally {
      setReanalyzing(false);
    }
  };

  const handleChangeLanguageOverride = async (nextLang: string) => {
    setLanguageOverride(nextLang);
    if (reanalyzing) return;
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      const res = await api.retranscribeProject(project.id, {
        languageOverride: nextLang,
        vocabulary,
      });
      setAnalysisJob(res.job);
      setAnalysis((prev) => ({
        ...prev,
        selectedLanguageOverride: nextLang,
        transcriptionStatus: res.job.status,
      }));
    } catch (err) {
      setReanalyzeError(err instanceof Error ? err.message : 'Language switch failed.');
    } finally {
      setReanalyzing(false);
    }
  };

  const handleSaveVocabulary = async (nextTerms: string[], retranscribeNow: boolean) => {
    const saved = await api.updateVocabulary(project.id, nextTerms);
    setVocabulary(saved.vocabulary);
    setAnalysis(saved.project.media?.analysis || { ...analysis, vocabulary: saved.vocabulary });
    onProjectUpdated(saved.project);
    if (retranscribeNow) {
      setReanalyzing(true);
      setReanalyzeError(null);
      try {
        const res = await api.retranscribeProject(project.id, {
          languageOverride,
          vocabulary: saved.vocabulary,
        });
        setAnalysisJob(res.job);
        setAnalysis((prev) => ({
          ...prev,
          vocabulary: saved.vocabulary,
          transcriptionStatus: res.job.status,
        }));
      } catch (err) {
        setReanalyzeError(err instanceof Error ? err.message : 'Re-transcribe failed.');
      } finally {
        setReanalyzing(false);
      }
    }
  };

  const handleCorrectSelectedWord = async (overrideWord?: string) => {
    if (!selectedWord || wordEditSaving) return;
    const candidate = (overrideWord ?? wordEditValue).trim();
    if (!candidate) return;
    setWordEditSaving(true);
    setWordEditError(null);
    try {
      const res = await api.correctTranscriptWord(project.id, selectedWord.word.id, candidate);
      setAnalysis(res.analysis);
      setState((prev) => ({
        ...prev,
        captions: res.project.state.captions,
      }));
      onProjectUpdated(res.project);
      setSelectedWord({ word: res.updatedWord, topic: selectedWord.topic });
      setWordEditValue(res.updatedWord.word);
    } catch (err) {
      setWordEditError(err instanceof Error ? err.message : 'Failed to save word correction.');
    } finally {
      setWordEditSaving(false);
    }
  };

  const localProject = project.id.startsWith('proj-local-');
  const localDemoAudio = localProject && media.sourceType === 'demo'
    ? getBundledAudioForDemo(media.id) : undefined;
  const snippetMedia = localDemoAudio || (localProject ? media.url : undefined);
  const snippetTime = (time: number) => localDemoAudio ? getNarrationPosition(analysis, time).time : time;
  const snippetStart = selectedWord && snippetMedia ? snippetTime(selectedWord.word.start) : 0;
  const snippetEnd = selectedWord && snippetMedia ? snippetTime(selectedWord.word.end) : undefined;

  const handleReplaySnippet = () => {
    const el = snippetAudioRef.current;
    if (!el) return;
    el.currentTime = snippetStart;
    void el.play().catch(() => setWordEditError('The browser could not play this audio snippet.'));
  };

  const handleTranslateCaptions = async (langCode: string) => {
    if (!langCode || langCode === 'original') {
      setActiveTranslationLang(null);
      return;
    }
    if (analysis.translationTracks?.[langCode]) {
      setActiveTranslationLang(langCode);
      return;
    }
    setTranslating(true);
    setReanalyzeError(null);
    try {
      const res = await api.translateProject(project.id, langCode);
      setAnalysis(res.analysis);
      setActiveTranslationLang(langCode);
    } catch (err) {
      setReanalyzeError(err instanceof Error ? err.message : 'Translation failed.');
    } finally {
      setTranslating(false);
    }
  };

  // Word-level quick actions directly from Transcript Panel
  const handleQuickWordAction = (
    wordObj: TranscriptWord,
    action: 'remove' | 'mute' | 'bleep' | 'captionOnly',
  ) => {
    const opType =
      action === 'mute'
        ? 'MUTE_RANGE'
        : action === 'bleep'
          ? 'BLEEP_RANGE'
          : action === 'captionOnly'
            ? 'REMOVE_WORD_FROM_CAPTIONS'
            : 'REMOVE_WORD';
    const cleanWord = wordObj.word.replace(/^[^\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]+$/giu, '');
    const plan: EditPlan = {
      id: `quick-${Date.now()}`,
      prompt: `${action} word "${cleanWord}"`,
      intentSummary: `${action === 'remove' ? 'Removed' : action === 'mute' ? 'Muted' : action === 'bleep' ? 'Bleeped' : 'Removed from captions'} "${wordObj.word}" at ${formatTimecode(wordObj.start)}–${formatTimecode(wordObj.end)}. All surrounding speech preserved.`,
      aiMode: analysis.analysisMode,
      operations: [
        {
          type: opType,
          label: `${action} "${cleanWord}"`,
          targetScope: 'word',
          targetText: cleanWord,
          sourceStart: wordObj.start,
          sourceEnd: wordObj.end,
        },
      ],
    };
    const res = applyEditPlan(state, analysis, plan);
    if (res.appliedCount > 0) {
      commitStateChange(res.nextState, `${action} word "${cleanWord}"`, plan.prompt);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-qw-${Date.now()}`,
          role: 'assistant',
          text: plan.intentSummary,
          status: 'applied',
        },
      ]);
      setSelectedWord(null);
    }
  };

  // AI Prompt Submission
  const handleSubmitPrompt = async (overridePrompt?: string) => {
    const text = (overridePrompt ?? promptInput).trim();
    if (!text || aiBusy) return;

    if (!overridePrompt) setPromptInput('');
    const userMsgId = `msg-u-${Date.now()}`;
    setMessages((prev) => [...prev, { id: userMsgId, role: 'user', text }]);
    setAiBusy(true);

    try {
      const { plan, impact, searchHits, stagesExecuted } = await api.planAiEdit(
        project.id,
        text,
        state,
        messages.filter(m=>m.id!=='welcome').slice(-24).map(m=>({role:m.role,text:m.text,status:m.status,
          ranges:m.plan?.operations.flatMap(op=>op.sourceStart!==undefined && op.sourceEnd!==undefined?[[op.sourceStart,op.sourceEnd]]:(op.removeRanges||op.keepRanges||[]).map(r=>[r.start,r.end]))})),
      );

      // Handle Undo prompt
      if (plan.historyAction==='redo') {
        if (historyIndex < history.length-1) handleRedo();
        setMessages(prev=>[...prev,{id:'redo-'+Date.now(),role:'assistant',text:historyIndex<history.length-1?'Redid the next timeline edit.':'There is no edit to redo.'}]);
        return;
      }
      if (plan.historyAction==='undo' || (/^undo[.!]?$/i.test(text) && plan.operations.length === 0)) {
        if (historyIndex > 0) {
          handleUndo();
          setMessages((prev) => [
            ...prev,
            {
              id: `msg-a-${Date.now()}`,
              role: 'assistant',
              text: `Undid "${history[historyIndex].label}" and restored timeline to ${formatTimecode(history[historyIndex - 1].durationAfter)}.`,
              stages: stagesExecuted,
              status: 'applied',
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: `msg-a-${Date.now()}`,
              role: 'assistant',
              text: 'Already at the earliest timeline state.',
            },
          ]);
        }
        return;
      }

      // Handle Validation Rejection (e.g. overly broad single-word cut)
      if (plan.validationError) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-a-${Date.now()}`,
            role: 'assistant',
            text: plan.validationError || 'Edit rejected by validation safety guard.',
            stages: stagesExecuted,
            status: 'error',
          },
        ]);
        return;
      }

      // Handle Search intent
      if (plan.searchQuery && plan.operations.length === 0 && !plan.requiresClarification) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-a-${Date.now()}`,
            role: 'assistant',
            text: plan.intentSummary,
            searchHits,
            stages: stagesExecuted,
          },
        ]);
        return;
      }

      // Handle Multi-Occurrence Ambiguity Clarification
      if (plan.requiresClarification && plan.candidates && plan.candidates.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-a-${Date.now()}`,
            role: 'assistant',
            text: plan.clarificationQuestion || plan.intentSummary,
            plan,
            stages: stagesExecuted,
            status: 'clarification',
          },
        ]);
        return;
      }

      if (plan.operations.length === 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-a-${Date.now()}`,
            role: 'assistant',
            text: plan.intentSummary,
            stages: stagesExecuted,
          },
        ]);
        return;
      }

      const isDestructive =
        impact.hasProtectedCollision ||
        Boolean(plan.requiresUncertainConfirmation);

      if (isDestructive) {
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-a-${Date.now()}`,
            role: 'assistant',
            text: plan.intentSummary,
            plan,
            impact,
            stages: stagesExecuted,
            status: 'pending',
          },
        ]);
      } else {
        const res = applyEditPlan(state, analysis, plan);
        if (!res.appliedCount || JSON.stringify(res.nextState)===JSON.stringify(state)) throw new Error('This change is already applied or has no effect on the remaining timeline.');
        commitStateChange(res.nextState, plan.operations[0]?.label || 'AI Edit', text);
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-a-${Date.now()}`,
            role: 'assistant',
            text: `Applied: ${plan.intentSummary}`,
            plan,
            impact,
            stages: stagesExecuted,
            status: 'applied',
          },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-err-${Date.now()}`,
          role: 'assistant',
          text: err instanceof Error ? err.message : 'Failed to process prompt.',
          status: 'error',
        },
      ]);
    } finally {
      setAiBusy(false);
    }
  };

  const handleConfirmPendingPlan = (msgId: string, plan: EditPlan, overrideProtection = false) => {
    const res = applyEditPlan(state, analysis, plan, { ignoreProtection: overrideProtection });
    if (res.appliedCount === 0) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msgId ? { ...m, status: 'error', text: res.message } : m,
        ),
      );
      return;
    }
    commitStateChange(res.nextState, plan.operations[0]?.label || 'AI Edit', plan.prompt);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              status: 'applied',
              text: `Edit applied: ${plan.intentSummary} (New duration: ${formatTimecode(res.nextState.duration)})`,
            }
          : m,
      ),
    );
  };

  const handleCancelPendingPlan = (msgId: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId ? { ...m, status: 'cancelled' } : m)),
    );
  };

  const handleResolveCandidate = (
    msgId: string,
    candidate: NonNullable<EditPlan['candidates']>[number],
    action: 'remove' | 'jump',
  ) => {
    if (action === 'jump') {
      if (candidate.timelineStart !== null) setCurrentTime(candidate.timelineStart);
      return;
    }
    const isWord = candidate.targetScope === 'word';
    const plan: EditPlan = {
      id: `clar-${Date.now()}`,
      prompt: `Remove ${candidate.label}`,
      intentSummary: isWord
        ? `Removed "${candidate.wordText || candidate.label}" at ${formatTimecode(candidate.sourceStart)}–${formatTimecode(candidate.sourceEnd)}. All surrounding speech preserved.`
        : `Removed "${candidate.label}" (${formatTimecode(candidate.sourceStart)}–${formatTimecode(candidate.sourceEnd)}).`,
      aiMode: analysis.analysisMode,
      operations: [
        {
          type: isWord ? 'REMOVE_WORD' : 'REMOVE_RANGE',
          label: `Remove ${candidate.wordText || candidate.label}`,
          targetScope: candidate.targetScope || 'segment',
          targetText: candidate.wordText,
          sourceStart: candidate.sourceStart,
          sourceEnd: candidate.sourceEnd,
        },
      ],
    };
    const res = applyEditPlan(state, analysis, plan);
    commitStateChange(res.nextState, `Remove ${candidate.label}`, plan.prompt);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              status: 'applied',
              text: plan.intentSummary,
            }
          : m,
      ),
    );
  };

  const handleResolveAllCandidates = (
    msgId: string,
    candidates: NonNullable<EditPlan['candidates']>,
  ) => {
    const wordCands = candidates.filter((c) => c.targetScope === 'word');
    const sortedDesc = [...candidates].sort((a, b) => b.sourceStart - a.sourceStart);
    const plan: EditPlan = {
      id: `clar-all-${Date.now()}`,
      prompt: 'Remove all matching occurrences',
      intentSummary: `Removed all ${candidates.length} occurrences (${candidates.map((c) => formatTimecode(c.sourceStart)).join(', ')}).`,
      aiMode: analysis.analysisMode,
      operations:
        wordCands.length === candidates.length
          ? [
              {
                type: 'REMOVE_WORD',
                label: `Remove All (${candidates.length})`,
                targetScope: 'word',
                targetText: wordCands[0]?.wordText,
                removeRanges: sortedDesc.map((c) => ({
                  start: c.sourceStart,
                  end: c.sourceEnd,
                  label: c.wordText || c.label,
                  targetText: c.wordText,
                })),
              },
            ]
          : sortedDesc.map((c) => ({
              type: 'REMOVE_RANGE',
              label: `Remove ${c.label}`,
              sourceStart: c.sourceStart,
              sourceEnd: c.sourceEnd,
            })),
    };
    const res = applyEditPlan(state, analysis, plan);
    commitStateChange(res.nextState, `Remove All (${candidates.length})`, plan.prompt);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId
          ? {
              ...m,
              status: 'applied',
              text: plan.intentSummary,
            }
          : m,
      ),
    );
  };

  const filteredTranscript = useMemo(() => {
    return analysis.transcript.filter((t) => {
      if (selectedSpeaker && t.speaker !== selectedSpeaker) return false;
      if (transcriptFilter.trim()) {
        const q = transcriptFilter.toLowerCase().trim();
        return `${t.text} ${t.topic} ${t.speaker}`.toLowerCase().includes(q);
      }
      return true;
    });
  }, [analysis.transcript, selectedSpeaker, transcriptFilter]);

  // Thousands of word buttons retain the same mapping as the playhead moves.
  const transcriptRows = useMemo(() => filteredTranscript.map((tr) => {
                    const tlTime = mapSourceTimeToTimeline(state.segments, tr.start + 0.05);
                    const isCut = tlTime === null;
                    const translatedSeg =
                      activeTranslationLang &&
                      analysis.translationTracks?.[activeTranslationLang]?.segments.find(
                        (s) => s.segmentId === tr.id,
                      );
                    return (
                      <div
                        key={tr.id}
                        className={`rounded-xl border p-3 text-xs space-y-1.5 transition-colors ${
                          isCut
                            ? 'border-white/5 bg-slate-950/40 opacity-50'
                            : 'border-white/10 bg-[#0B1024] hover:border-cyan-400/40'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-cyan-300">{tr.speaker}</span>
                          <button
                            type="button"
                            disabled={isCut}
                            onClick={() => {
                              if (tlTime !== null) handleJumpToSourceTime(tr.start + 0.05);
                            }}
                            className="font-mono text-[11px] text-violet-300 hover:underline disabled:no-underline cursor-pointer"
                          >
                            {isCut ? `Removed (${formatTimecode(tr.start)})` : formatTimecode(tlTime)}
                          </button>
                        </div>
                        <div className="text-[11px] font-medium text-slate-400">
                          <HighlightedText text={tr.topic} query={transcriptFilter} />
                          {tr.isImportant && (
                            <span className="text-amber-300"> · Protected ({tr.importantCategory})</span>
                          )}
                        </div>
                        {tr.words && tr.words.length > 0 && !transcriptFilter.trim() ? (
                          <div className="flex flex-wrap gap-x-1 gap-y-0.5 leading-relaxed text-slate-200">
                            {tr.words.map((w) => {
                              const wordInTimeline =
                                mapSourceTimeToTimeline(state.segments, (w.start + w.end) / 2) !==
                                null;
                              const isSelectedWord = selectedWord?.word.id === w.id;
                              const isUnclear = w.verificationStatus === 'unclear_audio';
                              const isReview = w.verificationStatus === 'review_needed';
                              return (
                                <button
                                  key={w.id}
                                  type="button"
                                  onClick={() =>
                                    setSelectedWord({ word: w, topic: tr.topic })
                                  }
                                  title={`${formatTimecode(w.start)}–${formatTimecode(w.end)} · ${
                                    isUnclear
                                      ? 'Unclear audio — click to replay & verify'
                                      : isReview
                                        ? 'Needs review — click to replay & verify'
                                        : 'Verified — click to inspect or edit'
                                  }`}
                                  className={`rounded-xs px-0.5 transition-colors cursor-pointer ${
                                    !wordInTimeline
                                      ? 'line-through text-slate-500'
                                      : isSelectedWord
                                        ? 'bg-cyan-400/35 text-white ring-1 ring-cyan-400'
                                        : isUnclear
                                          ? 'underline decoration-dotted decoration-rose-400 text-rose-100 hover:bg-rose-500/20'
                                          : isReview
                                            ? 'underline decoration-dotted decoration-amber-400 text-amber-100 hover:bg-amber-500/20'
                                            : w.manuallyEdited
                                              ? 'text-emerald-200 underline decoration-emerald-400/60 hover:bg-emerald-500/20'
                                              : w.isFiller
                                                ? 'text-amber-300 hover:bg-amber-500/20'
                                                : 'hover:bg-cyan-500/20 hover:text-cyan-100'
                                  }`}
                                >
                                  {w.word}
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <p className="text-slate-200 leading-relaxed select-text">
                            <HighlightedText text={tr.text} query={transcriptFilter} />
                          </p>
                        )}
                        {translatedSeg && (
                          <p className="text-[11px] text-emerald-300/90 border-t border-white/10 pt-1">
                            {translatedSeg.text}
                          </p>
                        )}
                      </div>
                    );
                  }), [filteredTranscript, state.segments, activeTranslationLang, analysis.translationTracks, transcriptFilter, selectedWord, handleJumpToSourceTime]);

  const handleGenerateCaptions = () => {
    const res = applyEditPlan(state, analysis, {
      id: `gen-cap-${Date.now()}`,
      prompt: 'Generate synced captions',
      intentSummary: 'Generated captions from transcript.',
      aiMode: analysis.analysisMode,
      operations: [{ type: 'GENERATE_CAPTIONS', label: 'Generate Captions' }],
    });
    if (res.appliedCount > 0) {
      commitStateChange(res.nextState, 'Generate Captions');
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#050711] text-slate-100">
      {/* 1. COMPACT TOP NAVIGATION */}
      <header className="border-b border-white/10 bg-[#070B19] px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBackDashboard}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white shrink-0 cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Projects
          </button>

          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() =>
              void persistNow(title.trim() || project.title, state, history, historyIndex, versions)
            }
            aria-label="Project name"
            className="bg-transparent text-sm font-bold text-white border border-transparent hover:border-white/15 focus:border-cyan-400 rounded-lg px-2 py-1 focus:outline-none max-w-[200px] truncate"
          />

          <span className="hidden xl:inline text-xs text-slate-400 truncate max-w-[260px]">
            Source: <span className="text-cyan-300">{media.filename}</span> ·{' '}
            {media.width}×{media.height}
          </span>

          <span className="text-[11px] font-mono text-emerald-300/90 shrink-0">
            {saveStatus === 'saving' ? 'Saving...' : 'Autosaved'}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            aria-label="Undo last edit"
            disabled={historyIndex <= 0}
            onClick={handleUndo}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 hover:border-cyan-400/50 disabled:opacity-35 cursor-pointer"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Undo
          </button>
          <button
            type="button"
            aria-label="Redo edit"
            disabled={historyIndex >= history.length - 1}
            onClick={handleRedo}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 hover:border-cyan-400/50 disabled:opacity-35 cursor-pointer"
          >
            <Redo2 className="w-3.5 h-3.5" />
            Redo
          </button>

          <button
            type="button"
            onClick={() => {
              setSearchInitialQuery('');
              setActiveModal('search');
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/35 bg-cyan-500/10 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 cursor-pointer"
          >
            <Search className="w-3.5 h-3.5" />
            Search
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('protection')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/35 bg-amber-500/10 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/20 cursor-pointer"
          >
            <Shield className="w-3.5 h-3.5" />
            Protection ({state.protectedMomentIds.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('versions')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-pink-400/35 bg-pink-500/10 px-2.5 py-1.5 text-xs font-medium text-pink-200 hover:bg-pink-500/20 cursor-pointer"
          >
            <Layers className="w-3.5 h-3.5" />
            Versions ({versions.length})
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('history')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400/40 cursor-pointer"
          >
            <History className="w-3.5 h-3.5" />
            History
          </button>

          <button
            type="button"
            onClick={() => setActiveModal('export')}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500 via-blue-600 to-violet-600 px-3.5 py-1.5 text-xs font-bold text-white hover:brightness-110 cursor-pointer"
          >
            <Film className="w-3.5 h-3.5" />
            Export {localProject ? 'WebM' : 'MP4'}
          </button>
        </div>
      </header>

      {/* MAIN 3-COLUMN WORKSPACE (Left Content | Center 50%+ Preview | Right Violet/Cyan Assistant) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 border-b border-white/10">
        {/* 2. LEFT COLUMN: TRANSCRIPT, SCENES & SPEAKERS (Independent Scroll) */}
        <aside
          aria-label="Transcript and Video Content"
          className="lg:col-span-3 border-b lg:border-b-0 lg:border-r border-white/10 bg-[#080C1B] flex flex-col lg:h-[640px]"
        >
          <div className="flex items-center gap-1 p-2 border-b border-white/10 bg-[#070A17] shrink-0">
            {(['transcript', 'scenes', 'speakers'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setLeftTab(tab)}
                className={`flex-1 rounded-lg py-1.5 text-xs font-semibold capitalize transition-colors cursor-pointer ${
                  leftTab === tab
                    ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {leftTab === 'transcript' && (
            <div className="flex-1 min-h-0 flex flex-col">
              {/* Multi-Audio Stream Selector (when video contains >1 audio track) */}
              {analysis.audioStreams && analysis.audioStreams.length > 1 && (
                <div className="m-2.5 mb-0 rounded-xl border border-white/10 bg-[#050711] px-2.5 py-2 flex items-center justify-between gap-2 text-[11px] shrink-0">
                  <span className="text-slate-400 shrink-0">Audio Track:</span>
                  <select
                    aria-label="Select audio stream"
                    value={analysis.selectedAudioStream ?? 0}
                    disabled={reanalyzing || isJobActiveStatus(analysisJob?.status)}
                    onChange={(e) => void handleSelectAudioStream(Number(e.target.value))}
                    className="flex-1 min-w-0 rounded-lg border border-white/15 bg-slate-900 px-2 py-1 text-[11px] text-cyan-200 focus:outline-none cursor-pointer"
                  >
                    {analysis.audioStreams.map((st) => (
                      <option key={st.index} value={st.audioIndex}>
                        Track {st.audioIndex + 1} ({st.language || st.codec} · {Math.round(st.sampleRate / 1000)}kHz · {st.channelLayout})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Live Background Transcription Progress / Honest Status Banner */}
              {(isJobActiveStatus(analysis.transcriptionStatus) ||
                isJobActiveStatus(analysisJob?.status) ||
                analysis.transcriptionStatus === 'failed' ||
                analysis.transcriptionStatus === 'no-audio' ||
                analysis.transcriptionStatus === 'cancelled' ||
                analysis.transcriptionStatus === 'partial') && (
                <div
                  data-testid="transcription-status-banner"
                  className={`m-2.5 mb-0 rounded-xl border p-3 text-xs space-y-2 overflow-hidden shrink-0 ${
                    isJobActiveStatus(analysis.transcriptionStatus) || isJobActiveStatus(analysisJob?.status)
                      ? 'border-cyan-400/45 bg-cyan-500/10 text-cyan-100'
                      : analysis.transcriptionStatus === 'failed'
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                        : analysis.transcriptionStatus === 'no-audio'
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-100'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold flex items-center gap-1.5">
                      {(isJobActiveStatus(analysis.transcriptionStatus) || isJobActiveStatus(analysisJob?.status)) && (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-300 shrink-0" />
                      )}
                      {isJobActiveStatus(analysis.transcriptionStatus) || isJobActiveStatus(analysisJob?.status)
                        ? `Transcribing: ${
                            (analysisJob?.status || analysis.transcriptionStatus) === 'extracting-audio'
                              ? 'Extracting 16kHz Audio'
                              : (analysisJob?.status || analysis.transcriptionStatus) === 'transcribing'
                                ? `Chunk ${analysisJob?.chunkCompleted ?? 0}/${analysisJob?.chunkTotal || '?'}`
                                : (analysisJob?.status || analysis.transcriptionStatus) === 'aligning'
                                  ? 'Aligning Word Timestamps'
                                  : (analysisJob?.status || analysis.transcriptionStatus) === 'generating-captions'
                                    ? 'Building Captions'
                                    : 'Queued'
                          }`
                        : analysis.transcriptionStatus === 'no-audio'
                          ? 'No Audio Stream Detected'
                          : analysis.transcriptionStatus === 'failed'
                            ? 'Speech Transcription Failed'
                            : analysis.transcriptionStatus === 'cancelled'
                              ? 'Transcription Cancelled'
                              : 'Partial Transcription'}
                    </span>
                    {(isJobActiveStatus(analysis.transcriptionStatus) || isJobActiveStatus(analysisJob?.status)) && (
                      <span className="font-mono text-[11px] text-cyan-300">
                        {analysisJob?.overallProgress ?? 10}%
                      </span>
                    )}
                  </div>

                  {(isJobActiveStatus(analysis.transcriptionStatus) || isJobActiveStatus(analysisJob?.status)) && (
                    <div className="h-1.5 rounded-full bg-slate-900 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-all"
                        style={{ width: `${Math.max(8, analysisJob?.overallProgress ?? 12)}%` }}
                      />
                    </div>
                  )}

                  <p className="text-[11px] opacity-90 leading-relaxed break-words [overflow-wrap:anywhere] max-h-20 overflow-y-auto">
                    {analysis.transcriptionError || analysis.analysisNote}
                  </p>
                  {reanalyzeError && (
                    <p className="text-[11px] text-rose-300 font-medium">{reanalyzeError}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-1.5">
                    {(isJobActiveStatus(analysis.transcriptionStatus) || isJobActiveStatus(analysisJob?.status)) &&
                      analysisJob && (
                        <button
                          type="button"
                          onClick={() => void handleCancelAnalysis()}
                          className="rounded-lg border border-white/20 bg-slate-900/80 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800 cursor-pointer"
                        >
                          Cancel
                        </button>
                      )}
                    {analysisJob && analysisJob.chunkFailed > 0 && !isJobActiveStatus(analysisJob.status) && (
                      <button
                        type="button"
                        disabled={reanalyzing}
                        onClick={() => void handleRetryFailedChunks()}
                        className="inline-flex items-center gap-1 rounded-lg bg-cyan-500 px-2.5 py-1 text-[11px] font-bold text-slate-950 hover:bg-cyan-400 cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Retry Failed Chunks ({analysisJob.chunkFailed})
                      </button>
                    )}
                    {analysis.hasAudio && !isJobActiveStatus(analysis.transcriptionStatus) && !isJobActiveStatus(analysisJob?.status) && (
                      <button
                        type="button"
                        disabled={reanalyzing}
                        onClick={() => void handleRetryAnalysis()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 border border-white/20 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-white/20 cursor-pointer"
                      >
                        <RefreshCw className={`w-3 h-3 ${reanalyzing ? 'animate-spin' : ''}`} />
                        {reanalyzing ? 'Starting...' : 'Retry Analysis'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Language Detection, Override, Dictionary & Translation Strip */}
              <div className="mx-2.5 mt-2 rounded-xl border border-white/10 bg-[#050711] p-2 text-[11px] space-y-1.5 shrink-0">
                <div className="flex items-center justify-between gap-2">
                  <div
                    data-testid="detected-language-badge"
                    className="flex items-center gap-1.5 min-w-0 text-cyan-200 font-medium truncate"
                  >
                    <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    <span className="truncate">
                      {analysis.detectedLanguageLabel || analysis.detectedLanguage || analysis.language || 'Auto'}
                      {analysis.languageConfidence !== undefined
                        ? ` (${Math.round(analysis.languageConfidence * 100)}%)`
                        : ''}
                      {analysis.isMultilingual ? ' · Multilingual' : ''}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setActiveModal('vocabulary')}
                    className="inline-flex items-center gap-1 rounded-md border border-violet-400/35 bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold text-violet-200 hover:bg-violet-500/25 shrink-0 cursor-pointer"
                  >
                    <BookOpen className="w-3 h-3" />
                    Dict ({vocabulary.length})
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    aria-label="Language override"
                    value={languageOverride}
                    disabled={reanalyzing || isJobActiveStatus(analysisJob?.status)}
                    onChange={(e) => void handleChangeLanguageOverride(e.target.value)}
                    className="rounded-lg border border-white/10 bg-slate-900 px-1.5 py-1 text-[10px] text-slate-200 focus:outline-none cursor-pointer"
                  >
                    <option value="auto">Lang: Auto-Detect</option>
                    {languages.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label} ({l.nativeLabel})
                      </option>
                    ))}
                  </select>

                  <div className="relative flex items-center">
                    <Languages className="w-3 h-3 text-emerald-400 absolute left-1.5 pointer-events-none" />
                    <select
                      aria-label="Translate captions track"
                      value={activeTranslationLang || 'original'}
                      disabled={translating || analysis.transcript.length === 0}
                      onChange={(e) => void handleTranslateCaptions(e.target.value)}
                      className="w-full rounded-lg border border-white/10 bg-slate-900 pl-6 pr-1.5 py-1 text-[10px] text-emerald-200 focus:outline-none cursor-pointer"
                    >
                      <option value="original">Captions: Original</option>
                      {languages
                        .filter((l) => l.code !== 'auto')
                        .slice(0, 10)
                        .map((l) => (
                          <option key={l.code} value={l.code}>
                            Translate → {l.label}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Search & Filter Box */}
              <div className="p-2.5 border-b border-white/10 space-y-1.5 shrink-0">
                <div className="relative flex items-center">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={transcriptFilter}
                    onChange={(e) => setTranscriptFilter(e.target.value)}
                    aria-label="Filter transcript"
                    placeholder="Search words, speakers, topics..."
                    className="w-full rounded-lg border border-white/10 bg-[#050711] pl-8 pr-8 py-1.5 text-xs text-white focus:border-cyan-400 focus:outline-none"
                  />
                  {transcriptFilter && (
                    <button
                      type="button"
                      aria-label="Clear transcript filter"
                      onClick={() => setTranscriptFilter('')}
                      className="absolute right-2 text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400 px-0.5">
                  <span className="truncate">
                    {transcriptFilter.trim()
                      ? `${filteredTranscript.length} segment match(es)`
                      : `${analysis.transcript.length} seg · ${
                          analysis.wordCount ??
                          analysis.transcript.reduce((s, t) => s + (t.words?.length || 0), 0)
                        } words`}
                    {analysis.verificationSummary &&
                      analysis.verificationSummary.reviewNeededCount +
                        analysis.verificationSummary.unclearAudioCount >
                        0 && (
                        <span className="text-amber-300">
                          {' '}
                          ·{' '}
                          {analysis.verificationSummary.reviewNeededCount +
                            analysis.verificationSummary.unclearAudioCount}{' '}
                          review
                        </span>
                      )}
                  </span>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {state.captions.length > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadCaptionsFile(
                              project.id,
                              state,
                              analysis,
                              'srt',
                              activeTranslationLang,
                              apiUrl(
                                `/api/projects/${project.id}/captions/export?format=srt${
                                  activeTranslationLang
                                    ? `&lang=${encodeURIComponent(activeTranslationLang)}`
                                    : ''
                                }`,
                              ),
                            )
                          }
                          title="Download synchronized .SRT subtitles"
                          className="inline-flex items-center gap-0.5 rounded border border-white/15 bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-300 hover:border-cyan-400 cursor-pointer"
                        >
                          <Download className="w-2.5 h-2.5" />
                          SRT
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadCaptionsFile(
                              project.id,
                              state,
                              analysis,
                              'vtt',
                              activeTranslationLang,
                              apiUrl(
                                `/api/projects/${project.id}/captions/export?format=vtt${
                                  activeTranslationLang
                                    ? `&lang=${encodeURIComponent(activeTranslationLang)}`
                                    : ''
                                }`,
                              ),
                            )
                          }
                          title="Download synchronized .VTT subtitles"
                          className="inline-flex items-center gap-0.5 rounded border border-white/15 bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300 hover:border-violet-400 cursor-pointer"
                        >
                          <Download className="w-2.5 h-2.5" />
                          VTT
                        </button>
                      </>
                    )}
                    {selectedSpeaker && (
                      <button
                        type="button"
                        onClick={() => setSelectedSpeaker(null)}
                        className="text-cyan-300 hover:underline cursor-pointer"
                      >
                        {selectedSpeaker} ×
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Word-Level Inspector + Audio Replay + Inline Manual Correction Drawer */}
              {selectedWord && (
                <div
                  data-testid="word-inspector"
                  className="mx-2.5 mt-2.5 rounded-xl border border-cyan-400/40 bg-cyan-500/10 p-2.5 text-xs space-y-2 shrink-0"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="font-bold text-white truncate">
                        "{selectedWord.word.word}"
                      </span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          selectedWord.word.verificationStatus === 'unclear_audio'
                            ? 'bg-rose-500/25 text-rose-200'
                            : selectedWord.word.verificationStatus === 'review_needed'
                              ? 'bg-amber-500/25 text-amber-200'
                              : 'bg-emerald-500/20 text-emerald-200'
                        }`}
                      >
                        {selectedWord.word.verificationStatus === 'unclear_audio'
                          ? 'Unclear'
                          : selectedWord.word.verificationStatus === 'review_needed'
                            ? 'Review'
                            : 'Verified'}
                        {selectedWord.word.confidence !== undefined
                          ? ` ${Math.round(selectedWord.word.confidence * 100)}%`
                          : ''}
                      </span>
                    </div>
                    <button
                      type="button"
                      aria-label="Close word inspector"
                      onClick={() => setSelectedWord(null)}
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex items-center justify-between font-mono text-[11px] text-cyan-200">
                    <span>
                      Src {formatTimecode(selectedWord.word.start)}–{formatTimecode(selectedWord.word.end)} ·{' '}
                      {(selectedWord.word.end - selectedWord.word.start).toFixed(2)}s
                    </span>
                    {analysis.hasAudio && (
                      <button
                        type="button"
                        onClick={handleReplaySnippet}
                        className="inline-flex items-center gap-1 rounded border border-cyan-400/40 bg-cyan-500/20 px-2 py-0.5 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-500/30 cursor-pointer"
                      >
                        <Volume2 className="w-3 h-3" />
                        Replay Snippet
                      </button>
                    )}
                  </div>

                  {selectedWord.word.manuallyEdited && selectedWord.word.originalWord && (
                    <div className="text-[10px] text-emerald-200">
                      Edited from "{selectedWord.word.originalWord}"
                    </div>
                  )}

                  {analysis.hasAudio && (
                    <audio
                      ref={snippetAudioRef}
                      controls
                      preload="none"
                      key={selectedWord.word.id}
                      onTimeUpdate={e => {
                        if (snippetEnd !== undefined && e.currentTarget.currentTime >= snippetEnd) e.currentTarget.pause();
                      }}
                      src={snippetMedia ? `${snippetMedia}#t=${snippetStart},${snippetEnd}` : api.getAudioSnippetUrl(
                        media.id,
                        selectedWord.word.start,
                        selectedWord.word.end,
                        analysis.selectedAudioStream,
                      )}
                      className="w-full h-7"
                    />
                  )}

                  {selectedWord.word.candidates && selectedWord.word.candidates.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-slate-300">Suggestions:</span>
                      {selectedWord.word.candidates.map((cand) => (
                        <button
                          key={cand}
                          type="button"
                          onClick={() => void handleCorrectSelectedWord(cand)}
                          className="rounded border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-100 hover:bg-amber-500/30 cursor-pointer"
                        >
                          {cand}
                        </button>
                      ))}
                    </div>
                  )}

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void handleCorrectSelectedWord();
                    }}
                    className="flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={wordEditValue}
                      onChange={(e) => setWordEditValue(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      aria-label="Correct word"
                      placeholder="Correct spelling..."
                      className="flex-1 min-w-0 rounded-md border border-white/15 bg-[#050711] px-2 py-1 text-[11px] text-white focus:border-cyan-400 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={wordEditSaving || !wordEditValue.trim()}
                      className="rounded-md bg-cyan-500 px-2 py-1 text-[11px] font-bold text-slate-950 hover:bg-cyan-400 disabled:opacity-45 cursor-pointer"
                    >
                      {wordEditSaving ? 'Saving...' : 'Correct Word'}
                    </button>
                  </form>
                  {wordEditError && (
                    <div className="text-[10px] text-rose-300">{wordEditError}</div>
                  )}

                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleJumpToSourceTime(selectedWord.word.start)}
                      className="rounded-md border border-white/15 bg-slate-900 px-2 py-1 text-[11px] text-white cursor-pointer"
                    >
                      Jump
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQuickWordAction(selectedWord.word, 'remove')}
                      className="inline-flex items-center gap-1 rounded-md bg-rose-500 px-2 py-1 text-[11px] font-semibold text-white cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      Remove Word
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQuickWordAction(selectedWord.word, 'mute')}
                      className="inline-flex items-center gap-1 rounded-md border border-violet-400/40 bg-violet-500/20 px-2 py-1 text-[11px] text-violet-100 cursor-pointer"
                    >
                      <VolumeX className="w-3 h-3" />
                      Mute
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQuickWordAction(selectedWord.word, 'bleep')}
                      className="rounded-md border border-amber-400/40 bg-amber-500/20 px-2 py-1 text-[11px] text-amber-100 cursor-pointer"
                    >
                      Bleep
                    </button>
                    <button
                      type="button"
                      onClick={() => handleQuickWordAction(selectedWord.word, 'captionOnly')}
                      className="rounded-md border border-emerald-400/40 bg-emerald-500/20 px-2 py-1 text-[11px] text-emerald-100 cursor-pointer"
                    >
                      Hide in Captions
                    </button>
                  </div>
                </div>
              )}

              {/* Scrollable Transcript List */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
                {analysis.transcript.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400 space-y-2">
                    <p>
                      {analysis.transcriptionStatus === 'no-audio'
                        ? 'Silent video: switch to the Scenes tab to inspect detected visual cuts.'
                        : 'No spoken transcript available yet.'}
                    </p>
                  </div>
                ) : filteredTranscript.length === 0 ? (
                  <div className="py-8 text-center text-xs text-slate-400 space-y-2">
                    <p>No matches found for "{transcriptFilter}".</p>
                    <button
                      type="button"
                      onClick={() => setTranscriptFilter('')}
                      className="rounded-lg border border-white/15 bg-slate-900 px-3 py-1 text-[11px] text-cyan-300 cursor-pointer"
                    >
                      Clear filter
                    </button>
                  </div>
                ) : (
                  transcriptRows
                )}
              </div>
            </div>
          )}

          {leftTab === 'scenes' && (
            <div className="flex-1 overflow-y-auto p-3 space-y-3">
              {analysis.scenes.map((sc) => {
                const tlTime = mapSourceTimeToTimeline(state.segments, sc.start + 0.1);
                return (
                  <button
                    key={sc.id}
                    type="button"
                    disabled={tlTime === null}
                    onClick={() => {
                      if (tlTime !== null) handleJumpToSourceTime(sc.start + 0.1);
                    }}
                    className="w-full text-left rounded-xl border border-white/10 bg-[#0B1024] hover:border-cyan-400/50 overflow-hidden disabled:opacity-50 cursor-pointer"
                  >
                    {sc.thumbnailUrl && (
                      <div className="w-full h-24 bg-[#02040A] flex items-center justify-center">
                        <img
                          src={apiUrl(sc.thumbnailUrl)}
                          alt={sc.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-contain"
                        />
                      </div>
                    )}
                    <div className="p-3 space-y-1 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-white truncate">{sc.title}</span>
                        <span className="font-mono text-cyan-300 shrink-0">
                          {formatTimecode(sc.start)}–{formatTimecode(sc.end)}
                        </span>
                      </div>
                      <p className="text-slate-400 line-clamp-2">{sc.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {leftTab === 'speakers' && (
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setSelectedSpeaker(null);
                  setLeftTab('transcript');
                }}
                className="w-full rounded-lg border border-white/10 bg-slate-900 py-2 text-xs text-slate-300 hover:text-white cursor-pointer"
              >
                Show All Speakers in Transcript
              </button>
              {analysis.speakers.length === 0 ? (
                <div className="py-8 text-center text-xs text-slate-400">
                  No speakers identified in this media asset.
                </div>
              ) : (
                analysis.speakers.map((spk) => (
                  <div
                    key={spk.id}
                    className="rounded-xl border border-white/10 bg-[#0B1024] p-3.5 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-white">{spk.name}</span>
                      <span className="font-mono text-cyan-300">{spk.speakingTimeSec}s</span>
                    </div>
                    <div className="text-slate-400">
                      {spk.role} · {spk.segmentCount} segments
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSpeaker(spk.name);
                        setLeftTab('transcript');
                      }}
                      className="rounded-lg bg-cyan-500/15 border border-cyan-400/40 px-3 py-1 text-[11px] font-medium text-cyan-200 cursor-pointer"
                    >
                      Filter Transcript by {spk.name}
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </aside>

        {/* 3. CENTER COLUMN (>= 50% width): LARGE VIDEO PREVIEW + SETTINGS STRIP BELOW */}
        <main className="lg:col-span-6 p-4 flex flex-col justify-between gap-3 bg-[#050711]">
          <VirtualVideoPlayer
            mediaUrl={localDemoAudio ? '' : apiUrl(media.url)}
            demoAudioUrl={media.sourceType === 'demo' ? getBundledAudioForDemo(media.id) : undefined}
            demoAnalysis={localDemoAudio ? analysis : undefined}
            posterUrl={apiUrl(media.thumbnailUrl)}
            mediaFilename={media.filename}
            mediaWidth={media.width}
            mediaHeight={media.height}
            state={state}
            translatedTrack={
              activeTranslationLang ? analysis.translationTracks?.[activeTranslationLang] : null
            }
            currentTime={currentTime}
            isPlaying={isPlaying}
            onTimeChange={setCurrentTime}
            onPlayingChange={setIsPlaying}
            onToggleCaptions={() => {
              if (state.captions.length === 0 && analysis.transcript.length > 0) {
                handleGenerateCaptions();
              } else {
                commitStateChange(
                  { ...state, captionsEnabled: !state.captionsEnabled },
                  state.captionsEnabled ? 'Disable Captions' : 'Enable Captions',
                );
              }
            }}
          />

          {/* Caption Styling & Audio Settings Bar Below Video Controls */}
          <div className="rounded-xl border border-white/10 bg-[#080C1B] px-3.5 py-2.5 text-xs flex flex-wrap items-center justify-between gap-3">
            {state.captions.length === 0 ? (
              <div className="flex items-center gap-3">
                <Captions className="w-4 h-4 text-emerald-400" />
                {analysis.transcript.length > 0 ? (
                  <button
                    type="button"
                    onClick={handleGenerateCaptions}
                    className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                  >
                    Generate Captions
                  </button>
                ) : (
                  <span className="text-slate-400">
                    No transcript captions available yet — transcribe speech or add a Text Overlay on the timeline.
                  </span>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2.5">
                {/* Mode: Sentence vs Word */}
                <select
                  aria-label="Caption display mode"
                  value={state.captionStyle.mode || 'sentence'}
                  onChange={(e) =>
                    commitStateChange(
                      {
                        ...state,
                        captionsEnabled: true,
                        captionStyle: {
                          ...state.captionStyle,
                          mode: e.target.value as 'sentence' | 'word',
                        },
                      },
                      'Caption Display Mode',
                    )
                  }
                  className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] text-emerald-200 cursor-pointer"
                >
                  <option value="sentence">Mode: Sentence</option>
                  <option value="word">Mode: Word-by-Word</option>
                </select>

                {/* Font Family */}
                <select
                  aria-label="Caption font family"
                  value={state.captionStyle.fontFamily}
                  onChange={(e) =>
                    commitStateChange(
                      {
                        ...state,
                        captionsEnabled: true,
                        captionStyle: { ...state.captionStyle, fontFamily: e.target.value },
                      },
                      'Caption Font Family',
                    )
                  }
                  className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 cursor-pointer"
                >
                  <option value="Plus Jakarta Sans">Sans</option>
                  <option value="Inter">Inter</option>
                  <option value="Georgia">Serif</option>
                  <option value="JetBrains Mono">Mono</option>
                </select>

                {/* Size */}
                <select
                  aria-label="Caption font size"
                  value={state.captionStyle.fontSize}
                  onChange={(e) =>
                    commitStateChange(
                      {
                        ...state,
                        captionsEnabled: true,
                        captionStyle: {
                          ...state.captionStyle,
                          fontSize: Number(e.target.value),
                        },
                      },
                      'Caption Size',
                    )
                  }
                  className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 cursor-pointer"
                >
                  <option value={18}>18px</option>
                  <option value={22}>22px</option>
                  <option value={26}>26px</option>
                  <option value={32}>32px</option>
                </select>

                {/* Text Color Swatches */}
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400 text-[11px]">Color:</span>
                  {(['#FFFFFF', '#FACC15', '#22D3EE', '#34D399'] as const).map((hex) => (
                    <button
                      key={hex}
                      type="button"
                      aria-label={`Set caption color ${hex}`}
                      onClick={() =>
                        commitStateChange(
                          {
                            ...state,
                            captionsEnabled: true,
                            captionStyle: { ...state.captionStyle, color: hex },
                          },
                          `Caption Color ${hex}`,
                        )
                      }
                      style={{ backgroundColor: hex }}
                      className={`w-4 h-4 rounded-full border cursor-pointer ${
                        state.captionStyle.color === hex
                          ? 'border-white scale-110'
                          : 'border-white/30'
                      }`}
                    />
                  ))}
                </div>

                {/* Position */}
                <select
                  aria-label="Caption position"
                  value={state.captionStyle.position}
                  onChange={(e) =>
                    commitStateChange(
                      {
                        ...state,
                        captionStyle: {
                          ...state.captionStyle,
                          position: e.target.value as 'bottom' | 'center' | 'top',
                        },
                      },
                      'Move Caption Position',
                    )
                  }
                  className="rounded-lg border border-white/10 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 cursor-pointer"
                >
                  <option value="bottom">Bottom</option>
                  <option value="center">Center</option>
                  <option value="top">Top</option>
                </select>

                {/* Active Word Highlight Toggle */}
                <button
                  type="button"
                  onClick={() =>
                    commitStateChange(
                      {
                        ...state,
                        captionStyle: {
                          ...state.captionStyle,
                          highlightActiveWord: !state.captionStyle.highlightActiveWord,
                        },
                      },
                      'Toggle Word Highlight',
                    )
                  }
                  className={`rounded-lg border px-2 py-1 text-[11px] cursor-pointer ${
                    state.captionStyle.highlightActiveWord
                      ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-200'
                      : 'border-white/10 bg-slate-900 text-slate-400'
                  }`}
                >
                  Word Highlight
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() =>
                commitStateChange(
                  {
                    ...state,
                    audio: { ...state.audio, noiseReduction: !state.audio.noiseReduction },
                  },
                  state.audio.noiseReduction ? 'Disable Noise Reduction' : 'Enable Noise Reduction',
                )
              }
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-medium cursor-pointer shrink-0 ${
                state.audio.noiseReduction
                  ? 'border-violet-400/50 bg-violet-500/20 text-violet-200'
                  : 'border-white/10 bg-slate-900 text-slate-400'
              }`}
            >
              Denoise: {state.audio.noiseReduction ? 'ON' : 'OFF'}
            </button>
          </div>
        </main>

        {/* 4. RIGHT COLUMN: DISTINCT VIOLET/CYAN-ACCENTED AI EDITING ASSISTANT */}
        <aside
          aria-label="AI Editing Assistant"
          data-testid="ai-assistant-panel"
          className="lg:col-span-3 border-t lg:border-t-0 lg:border-l border-violet-500/35 bg-gradient-to-b from-[#0E122B] via-[#090D20] to-[#080B19] flex flex-col lg:h-[640px]"
        >
          <div className="border-b border-violet-500/30 px-4 py-3 flex items-center justify-between bg-gradient-to-r from-violet-950/60 via-[#0E1430] to-cyan-950/40 shrink-0">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500 flex items-center justify-center">
                <Wand2 className="w-3.5 h-3.5 text-slate-950" />
              </div>
              <h2 className="text-xs font-extrabold tracking-wider uppercase text-white">
                AI Editing Assistant
              </h2>
            </div>
            <span className="text-[10px] font-mono text-cyan-300">
              {analysis.analysisMode === 'gemini-ai' ? 'Gemini AI' : 'Precision Engine'}
            </span>
          </div>

          {/* Independent Scrollable Conversation & Edit Impact Cards */}
          <div className="flex-1 min-h-0 overflow-y-auto p-3.5 space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`rounded-xl p-3 text-xs space-y-2.5 ${
                  msg.role === 'user'
                    ? 'bg-cyan-500/15 border border-cyan-400/35 text-cyan-50 ml-4'
                    : msg.status === 'error'
                      ? 'bg-rose-500/10 border border-rose-500/40 text-rose-100 mr-1'
                      : 'bg-[#0C1228] border border-violet-400/20 text-slate-200 mr-1'
                }`}
              >
                <p className="leading-relaxed">{msg.text}</p>

                {/* Live Stage Trace */}
                {msg.stages && msg.stages.length > 0 && msg.status === 'applied' && (
                  <div className="text-[10px] font-mono text-emerald-300/90">
                    ✓ {msg.stages.join(' → ')} → Edit applied
                  </div>
                )}

                {/* Search Results Inline */}
                {msg.searchHits && msg.searchHits.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {msg.searchHits.slice(0, 5).map((hit) => (
                      <button
                        key={hit.id}
                        type="button"
                        onClick={() => {
                          if (hit.timelineStart !== null) {
                            handleJumpToSourceTime(hit.sourceStart);
                          }
                        }}
                        className="w-full text-left rounded-lg border border-white/10 bg-[#060914] p-2 hover:border-cyan-400/50 cursor-pointer"
                      >
                        <div className="flex justify-between text-[11px] text-cyan-300 font-mono">
                          <span>{hit.matchType.toUpperCase()}</span>
                          <span>
                            {hit.timelineStart !== null
                              ? formatTimecode(hit.timelineStart)
                              : 'Removed'}
                          </span>
                        </div>
                        <div className="text-slate-300 line-clamp-2 mt-0.5">{hit.snippet}</div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Multi-Occurrence / Ambiguity Clarification Card */}
                {msg.status === 'clarification' && msg.plan?.candidates && (
                  <div className="space-y-2 pt-1">
                    {msg.plan.candidates.map((cand) => (
                      <div
                        key={cand.id}
                        className="rounded-lg border border-violet-400/35 bg-[#060914] p-2.5 space-y-1.5"
                      >
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-semibold text-violet-300">{cand.label}</span>
                          <span className="font-mono text-slate-400">
                            {formatTimecode(cand.sourceStart)}–{formatTimecode(cand.sourceEnd)}
                          </span>
                        </div>
                        <div className="text-slate-300">{cand.snippet}</div>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={() => handleResolveCandidate(msg.id, cand, 'remove')}
                            className="rounded-md bg-rose-500 px-2.5 py-1 text-[11px] font-semibold text-white cursor-pointer"
                          >
                            Remove This
                          </button>
                          <button
                            type="button"
                            onClick={() => handleResolveCandidate(msg.id, cand, 'jump')}
                            className="rounded-md border border-white/15 bg-slate-900 px-2.5 py-1 text-[11px] text-slate-200 cursor-pointer"
                          >
                            Preview
                          </button>
                        </div>
                      </div>
                    ))}

                    {msg.plan.candidates.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          handleResolveAllCandidates(msg.id, msg.plan!.candidates!)
                        }
                        className="w-full rounded-lg border border-rose-400/40 bg-rose-500/15 py-1.5 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                      >
                        Remove All {msg.plan.candidates.length} Occurrences
                      </button>
                    )}
                  </div>
                )}

                {/* Destructive Edit Impact & Protection Warning */}
                {msg.status === 'pending' && msg.plan && msg.impact && (
                  <div className="rounded-xl border border-cyan-400/25 bg-[#060914] p-3 space-y-2.5">
                    <div className="text-[11px] font-semibold text-cyan-300">
                      Edit Plan & Impact Preview
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                      <div>
                        Duration:{' '}
                        <span className="text-white">
                          {formatTimecode(msg.impact.durationBefore)} →{' '}
                          {formatTimecode(msg.impact.durationAfter)}
                        </span>
                      </div>
                      <div>
                        Delta:{' '}
                        <span className="text-amber-300">
                          {msg.impact.durationDelta >= 0 ? '+' : ''}
                          {msg.impact.durationDelta.toFixed(2)}s
                        </span>
                      </div>
                    </div>

                    {msg.impact.hasProtectedCollision && (
                      <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-2.5 space-y-1">
                        <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-300">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          Important Content Warning
                        </div>
                        {msg.impact.protectedWarnings.map((w) => (
                          <div key={w.momentId} className="text-[11px] text-amber-100">
                            <span className="font-semibold uppercase">{w.category}:</span> {w.title} (
                            {formatTimecode(w.sourceStart)}–{formatTimecode(w.sourceEnd)}) — {w.reason}
                          </div>
                        ))}
                      </div>
                    )}

                    {msg.plan.requiresUncertainConfirmation &&
                      msg.plan.uncertainWordWarnings &&
                      msg.plan.uncertainWordWarnings.length > 0 && (
                        <div
                          data-testid="uncertain-word-warning"
                          className="rounded-lg border border-amber-400/50 bg-amber-500/10 p-2.5 space-y-1"
                        >
                          <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-200">
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                            Uncertain Transcript Words in Edit Range
                          </div>
                          {msg.plan.uncertainWordWarnings.slice(0, 4).map((uw, idx) => (
                            <div key={`${uw.wordId || idx}`} className="text-[11px] text-amber-100/90">
                              <span className="font-semibold">"{uw.word}"</span> ({uw.status}
                              {uw.confidence !== undefined
                                ? ` · ${Math.round(uw.confidence * 100)}%`
                                : ''}
                              ) at {formatTimecode(uw.sourceStart)}
                              {uw.candidates && uw.candidates.length > 0
                                ? ` · Candidates: ${uw.candidates.join(', ')}`
                                : ''}
                            </div>
                          ))}
                        </div>
                      )}

                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() =>
                          handleConfirmPendingPlan(
                            msg.id,
                            msg.plan!,
                            msg.impact!.hasProtectedCollision,
                          )
                        }
                        className="inline-flex items-center gap-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-1.5 text-[11px] font-bold text-white cursor-pointer"
                      >
                        <Check className="w-3 h-3" />
                        {msg.impact.hasProtectedCollision ? 'Override & Apply' : 'Apply Edit'}
                      </button>

                      {msg.impact.affectedSegments[0] && (
                        <button
                          type="button"
                          onClick={() =>
                            setCurrentTime(msg.impact!.affectedSegments[0].timelineStart)
                          }
                          className="rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-200 cursor-pointer"
                        >
                          Preview
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => handleCancelPendingPlan(msg.id)}
                        className="rounded-lg border border-white/15 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-400 hover:text-white cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {msg.status === 'cancelled' && (
                  <div className="text-[11px] text-slate-400 italic">
                    Edit cancelled — timeline unchanged.
                  </div>
                )}
              </div>
            ))}

            {/* Genuine Step-by-Step Progress Indicator While AI Runs */}
            {aiBusy && (
              <div
                data-testid="ai-processing-status"
                className="rounded-xl border border-violet-400/40 bg-violet-500/10 p-3 space-y-2 text-xs"
              >
                <div className="flex items-center gap-2 font-semibold text-cyan-200">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-cyan-400" />
                  <span>Waiting for the editing assistant…</span>
                </div>

              </div>
            )}

            <div ref={chatBottomRef} />
          </div>

          {/* Prominent DESCRIBE YOUR EDIT Panel & Suggested Prompts */}
          <div className="border-t border-violet-500/30 p-3.5 space-y-2.5 bg-[#070B1A] shrink-0">
            <div className="flex items-center justify-between">
              <label
                htmlFor="ai-prompt-textarea"
                className="text-[10px] font-bold tracking-widest uppercase text-cyan-300 flex items-center gap-1.5"
              >
                <Sparkles className="w-3 h-3 text-violet-400" />
                Describe Your Edit
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {SUGGESTED_PROMPTS.slice(0, 5).map((sp) => (
                <button
                  key={sp}
                  type="button"
                  onClick={() => void handleSubmitPrompt(sp)}
                  className="rounded-lg border border-violet-400/25 bg-slate-900/90 px-2 py-1 text-[10px] text-slate-300 hover:border-cyan-400/60 hover:text-cyan-200 cursor-pointer text-left"
                >
                  {sp}
                </button>
              ))}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSubmitPrompt();
              }}
              className="space-y-2"
            >
              <textarea
                id="ai-prompt-textarea"
                rows={3}
                value={promptInput}
                onChange={(e) => setPromptInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSubmitPrompt();
                    return;
                  }
                  e.stopPropagation();
                }}
                aria-label="Describe your edit"
                placeholder="Tell EDITMIND AI exactly what to change in your video..."
                className="w-full resize-none rounded-xl border border-violet-400/45 bg-[#050711] px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="submit"
                disabled={aiBusy || !promptInput.trim()}
                aria-label="Send editing prompt"
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 via-blue-600 to-violet-600 px-4 py-2 text-xs font-bold text-white hover:brightness-110 disabled:opacity-45 cursor-pointer"
              >
                {aiBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                {aiBusy ? 'Processing Instruction...' : 'Apply AI Prompt'}
              </button>
            </form>
          </div>
        </aside>
      </div>

      {/* 5. BOTTOM: INDEPENDENT MULTITRACK TIMELINE WORKSPACE */}
      <TimelinePanel
        projectId={project.id}
        state={state}
        analysis={analysis}
        currentTime={currentTime}
        selectedSegmentId={selectedSegmentId}
        onSelectSegment={setSelectedSegmentId}
        onSeek={setCurrentTime}
        onSplitAtPlayhead={() => {
          const split = splitSegmentAtTimelineTime(state.segments, currentTime);
          if (split.length !== state.segments.length) {
            const rec = recalculateTimeline(split);
            commitStateChange({ ...state, segments: rec.segments, duration: rec.duration }, 'Split Clip');
          }
        }}
        onDeleteSegment={(segId) => {
          if (state.segments.length <= 1 || state.trackLocks.video) return;
          const seg = state.segments.find((s) => s.id === segId);
          const filtered = state.segments.filter((s) => s.id !== segId);
          const rec = recalculateTimeline(filtered);
          commitStateChange(
            { ...state, segments: rec.segments, duration: rec.duration },
            `Delete ${seg?.label || 'Segment'}`,
          );
        }}
        onMoveSegment={(fromIdx, toIdx) => {
          if (state.trackLocks.video) return;
          const reordered = reorderSegments(state.segments, fromIdx, toIdx);
          const rec = recalculateTimeline(reordered);
          commitStateChange(
            { ...state, segments: rec.segments, duration: rec.duration },
            'Reorder Segment',
          );
        }}
        onChangeSegmentSpeed={(segId, speed) => {
          if (state.trackLocks.video) return;
          const updated = state.segments.map((s) => (s.id === segId ? { ...s, speed } : s));
          const rec = recalculateTimeline(updated);
          commitStateChange(
            { ...state, segments: rec.segments, duration: rec.duration },
            `Set Speed ${speed}x`,
          );
        }}
        onTrimSegmentEdges={(segId, deltaStart, deltaEnd) => {
          if (state.trackLocks.video) return;
          const target = state.segments.find((s) => s.id === segId);
          if (!target) return;
          const trimmed = trimSegment(
            state.segments,
            segId,
            target.sourceStart + deltaStart,
            target.sourceEnd + deltaEnd,
          );
          const rec = recalculateTimeline(trimmed);
          commitStateChange(
            { ...state, segments: rec.segments, duration: rec.duration },
            'Trim Segment',
          );
        }}
        onUpdateAudioSegment={(segId, patch) => {
          if (state.trackLocks.audio) return;
          const updated = state.segments.map((s) =>
            s.id === segId ? { ...s, ...patch } : s,
          );
          commitStateChange(
            { ...state, segments: updated },
            patch.muted !== undefined ? (patch.muted ? 'Mute Audio Clip' : 'Unmute Audio Clip') : 'Clip Volume',
          );
        }}
        onUpdateAudioSettings={(patch, label) => {
          if (state.trackLocks.music && patch.musicEnabled !== undefined) return;
          commitStateChange(
            { ...state, audio: { ...state.audio, ...patch } },
            label,
          );
        }}
        onUploadMusicFile={async (file) => {
          const uploaded = await api.uploadProjectMusic(project.id, file);
          commitStateChange(
            {
              ...state,
              audio: {
                ...state.audio,
                musicEnabled: true,
                musicPreset: 'custom-upload',
                customMusicUrl: uploaded.url,
                customMusicName: uploaded.filename,
                musicDurationSec: uploaded.durationSec,
              },
            },
            `Upload Music: ${uploaded.filename}`,
          );
        }}
        onToggleTrackVisibility={(track) => {
          commitStateChange(
            {
              ...state,
              trackVisibility: { ...state.trackVisibility, [track]: !state.trackVisibility[track] },
            },
            `Toggle ${track} visibility`,
          );
        }}
        onToggleTrackLock={(track) => {
          commitStateChange(
            {
              ...state,
              trackLocks: { ...state.trackLocks, [track]: !state.trackLocks[track] },
            },
            `Toggle ${track} lock`,
          );
        }}
        onToggleAudioMute={() => {
          commitStateChange(
            { ...state, audio: { ...state.audio, muted: !state.audio.muted } },
            state.audio.muted ? 'Unmute Audio' : 'Mute Audio',
          );
        }}
        onToggleMusic={() => {
          commitStateChange(
            { ...state, audio: { ...state.audio, musicEnabled: !state.audio.musicEnabled } },
            state.audio.musicEnabled ? 'Disable Background Music' : 'Enable Background Music',
          );
        }}
        onGenerateCaptions={handleGenerateCaptions}
        onEditCaptionText={(captionId, nextText) => {
          const res = applyEditPlan(state, analysis, {
            id: `cap-edit-${Date.now()}`,
            prompt: 'Edit caption text',
            intentSummary: 'Updated caption text',
            aiMode: analysis.analysisMode,
            operations: [
              {
                type: 'UPDATE_CAPTION_TEXT',
                label: 'Edit Caption Text',
                captionId,
                captionText: nextText,
              },
            ],
          });
          commitStateChange(res.nextState, 'Edit Caption Text');
        }}
        onAdjustCaptionTiming={(captionId, sourceStart, sourceEnd) => {
          const res = applyEditPlan(state, analysis, {
            id: `cap-time-${Date.now()}`,
            prompt: 'Adjust caption timing',
            intentSummary: 'Adjusted caption timing',
            aiMode: analysis.analysisMode,
            operations: [
              {
                type: 'ADJUST_CAPTION_TIME',
                label: 'Adjust Caption Timing',
                captionId,
                captionStart: sourceStart,
                captionEnd: sourceEnd,
              },
            ],
          });
          commitStateChange(res.nextState, 'Adjust Caption Timing');
        }}
        onDeleteCaption={(captionId) => {
          const res = applyEditPlan(state, analysis, {
            id: `cap-del-${Date.now()}`,
            prompt: 'Delete caption',
            intentSummary: 'Deleted caption block',
            aiMode: analysis.analysisMode,
            operations: [
              {
                type: 'DELETE_CAPTION',
                label: 'Delete Caption',
                captionId,
              },
            ],
          });
          commitStateChange(res.nextState, 'Delete Caption');
        }}
        onAddOverlay={(overlayText) => {
          if (state.trackLocks.overlays) return;
          commitStateChange(
            {
              ...state,
              overlays: [
                ...state.overlays,
                {
                  id: `ovl-${Date.now().toString(36)}`,
                  text: overlayText,
                  timelineStart: Math.round(currentTime * 100) / 100,
                  timelineEnd: Math.min(state.duration, Math.round((currentTime + 4) * 100) / 100),
                  x: 50,
                  y: 18,
                  fontSize: 28,
                  color: '#FFFFFF',
                  backgroundColor: 'rgba(236, 72, 153, 0.78)',
                },
              ],
            },
            `Add Overlay "${overlayText}"`,
          );
        }}
        onUpdateOverlay={(ovId, patch) => {
          const res = applyEditPlan(state, analysis, {
            id: `ov-upd-${Date.now()}`,
            prompt: 'Update text overlay',
            intentSummary: 'Updated overlay properties',
            aiMode: analysis.analysisMode,
            operations: [
              {
                type: 'UPDATE_OVERLAY',
                label: 'Update Overlay',
                overlayId: ovId,
                overlayPatch: patch,
              },
            ],
          });
          commitStateChange(res.nextState, 'Update Text Overlay');
        }}
        onDeleteOverlay={(ovId) => {
          if (state.trackLocks.overlays) return;
          commitStateChange(
            { ...state, overlays: state.overlays.filter((o) => o.id !== ovId) },
            'Remove Text Overlay',
          );
        }}
      />

      {/* MODALS */}
      {activeModal === 'search' && (
        <SearchModal
          projectId={project.id}
          state={state}
          analysis={analysis}
          initialQuery={searchInitialQuery}
          onJumpToTime={(tlTime, srcStart) => {
            if (tlTime !== null) setCurrentTime(tlTime);
            else handleJumpToSourceTime(srcStart);
          }}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === 'protection' && (
        <ProtectionModal
          analysis={analysis}
          protectedIds={state.protectedMomentIds}
          onToggleProtect={(momentId) => {
            const exists = state.protectedMomentIds.includes(momentId);
            const nextIds = exists
              ? state.protectedMomentIds.filter((id) => id !== momentId)
              : [...state.protectedMomentIds, momentId];
            commitStateChange(
              { ...state, protectedMomentIds: nextIds },
              exists ? 'Unprotect Moment' : 'Protect Moment',
            );
          }}
          onJumpToSource={handleJumpToSourceTime}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === 'versions' && (
        <VersionsModal
          versions={versions}
          activeVersionId={state.activeVersionId}
          onApplyVersion={(ver) => {
            const res = applyEditPlan(state, analysis, {
              id: `ver-${ver.id}`,
              prompt: `Apply ${ver.name} version`,
              intentSummary: `Applied ${ver.name}`,
              aiMode: analysis.analysisMode,
              operations: [
                {
                  type: 'APPLY_VERSION',
                  label: `Apply ${ver.name}`,
                  versionId: ver.id,
                  versionSegments: ver.segments,
                },
              ],
            });
            commitStateChange(res.nextState, `Version: ${ver.name}`);
          }}
          onRegenerate={async () => {
            const res = await api.regenerateVersions(project.id);
            setVersions(res.versions);
          }}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === 'history' && (
        <HistoryModal
          history={history}
          historyIndex={historyIndex}
          analysis={analysis}
          state={state}
          onRestoreSnapshot={(idx) => {
            const snap = history[idx].stateSnapshot;
            setState(snap);
            setHistoryIndex(idx);
            setCurrentTime(0);
            scheduleAutosave(title, snap, history, idx, versions);
            setActiveModal(null);
          }}
          onRestoreRemovedSourceSegment={(start, end, label) => {
            const res = applyEditPlan(state, analysis, {
              id: `rest-${Date.now()}`,
              prompt: `Restore ${label}`,
              intentSummary: `Restored ${label}`,
              aiMode: analysis.analysisMode,
              operations: [
                {
                  type: 'RESTORE_SEGMENT',
                  label: `Restore ${label}`,
                  restoreTarget: 'range',
                  sourceStart: start,
                  sourceEnd: end,
                },
              ],
            });
            commitStateChange(res.nextState, `Restore ${label}`);
          }}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === 'export' && (
        <ExportModal
          projectId={project.id}
          projectTitle={title}
          state={state}
          analysis={analysis}
          sourceWidth={analysis.width}
          sourceHeight={analysis.height}
          activeTranslationLang={activeTranslationLang}
          onClose={() => setActiveModal(null)}
        />
      )}

      {activeModal === 'vocabulary' && (
        <VocabularyModal
          initialVocabulary={vocabulary}
          onSave={handleSaveVocabulary}
          onClose={() => setActiveModal(null)}
        />
      )}
    </div>
  );
}
