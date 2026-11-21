export type SourceType = 'demo' | 'upload' | 'recording' | 'url';

export type AnalysisMode = 'gemini-ai' | 'local-ffmpeg';

export type VerificationStatus = 'verified' | 'review_needed' | 'unclear_audio';

export type ImportantCategory =
  | 'benefit'
  | 'explanation'
  | 'warning'
  | 'disclaimer'
  | 'demonstration'
  | 'cta'
  | 'pricing';

export interface TranscriptWord {
  id: string;
  word: string;
  text?: string;
  normalizedText?: string;
  start: number; // source seconds
  end: number;   // source seconds
  sourceStart?: number;
  sourceEnd?: number;
  confidence?: number;
  speaker: string;
  speakerId?: string;
  sentenceId?: string;
  chunkId?: string;
  sourceSegmentId?: string;
  timingAccuracy?: 'model-word' | 'aligned' | 'approximate';
  isFiller?: boolean;
  verificationStatus?: VerificationStatus;
  originalWord?: string;
  candidates?: string[];
  manuallyEdited?: boolean;
}

export interface DetectedLanguageSegment {
  language: string;
  label: string;
  confidence: number;
  start?: number;
  end?: number;
}

export interface TranslationTrack {
  language: string;
  languageLabel: string;
  segments: Array<{
    segmentId: string;
    sourceStart: number;
    sourceEnd: number;
    text: string;
  }>;
  createdAt: string;
}

export interface VerificationSummary {
  verifiedCount: number;
  reviewNeededCount: number;
  unclearAudioCount: number;
  manuallyEditedCount: number;
  verifiedAt?: string;
  verifierProvider?: string;
}

export interface TranscriptSegment {
  id: string;
  start: number; // source seconds
  end: number;   // source seconds
  speaker: string;
  speakerId?: string;
  text: string;
  topic: string;
  language?: string;
  chunkId?: string;
  words: TranscriptWord[];
  isImportant?: boolean;
  importantCategory?: ImportantCategory;
}

export interface SceneInfo {
  id: string;
  start: number;
  end: number;
  title: string;
  description: string;
  objects: string[];
  activities: string[];
  thumbnailUrl: string;
}

export interface SpeakerInfo {
  id: string;
  name: string;
  role: string;
  color: string;
  speakingTimeSec: number;
  segmentCount: number;
}

export interface ImportantMoment {
  id: string;
  category: ImportantCategory;
  title: string;
  reason: string;
  start: number; // source seconds
  end: number;   // source seconds
  protected: boolean;
  segmentId?: string;
}

export interface SilenceRange {
  id: string;
  start: number; // source seconds
  end: number;   // source seconds
  duration: number;
}

export interface FillerHit {
  id: string;
  word: string;
  start: number;
  end: number;
  segmentId: string;
}

export type TranscriptionStatus =
  | 'not-started'
  | 'queued'
  | 'extracting-audio'
  | 'transcribing'
  | 'aligning'
  | 'generating-captions'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'no-audio'
  | 'local-fallback';

export interface AudioStreamInfo {
  index: number;
  audioIndex: number;
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string;
  language?: string;
  title?: string;
  bitrate?: number;
}

export interface ChunkProgressStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
  pending: number;
  retried: number;
}

export interface AnalysisJob {
  id: string;
  mediaId: string;
  projectId: string | null;
  selectedAudioStream: number;
  status: TranscriptionStatus;
  overallProgress: number;
  audioExtractionStatus: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  transcriptionStatus: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'skipped';
  chunkTotal: number;
  chunkCompleted: number;
  chunkFailed: number;
  alignmentStatus: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  captionStatus: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  providerUsed?: string;
  detectedLanguage?: string;
  languageOverride?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UrlImportJob {
  id: string;
  url: string;
  status: 'queued' | 'validating' | 'downloading' | 'probing' | 'completed' | 'failed';
  progress: number;
  bytesDownloaded: number;
  totalBytes?: number | null;
  mediaId?: string;
  projectId?: string;
  analysisJobId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

export interface MediaAnalysis {
  mediaId: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  detectedAudioStreams?: number;
  audioStreams?: AudioStreamInfo[];
  selectedAudioStream?: number;
  codec: string;
  analysisMode: AnalysisMode;
  analysisNote: string;
  transcriptionStatus?: TranscriptionStatus;
  transcriptionError?: string;
  providerUsed?: string;
  chunkStats?: ChunkProgressStats;
  wordCount?: number;
  language?: string;
  detectedLanguage?: string;
  detectedLanguageLabel?: string;
  languageConfidence?: number;
  languagesDetected?: DetectedLanguageSegment[];
  isMultilingual?: boolean;
  selectedLanguageOverride?: string;
  vocabulary?: string[];
  verificationSummary?: VerificationSummary;
  translationTracks?: Record<string, TranslationTrack>;
  waveformPeaks: number[]; // normalized 0..1 array (~120-240 samples)
  transcript: TranscriptSegment[];
  scenes: SceneInfo[];
  speakers: SpeakerInfo[];
  importantMoments: ImportantMoment[];
  silences: SilenceRange[];
  fillers: FillerHit[];
  topics: string[];
  summary: string;
}

export interface MediaAsset {
  id: string;
  sourceType: SourceType;
  sourceUrl?: string;
  filename: string;
  mimeType: string;
  url: string;
  thumbnailUrl: string;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  analysisMode: AnalysisMode;
  analysis: MediaAnalysis;
  createdAt: string;
}

export interface TimelineSegment {
  id: string;
  sourceSegmentId: string; // stable reference back to original source slice
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
  speed: number; // 0.25 .. 4.0
  volume: number; // 0 .. 2.0
  muted: boolean;
  label: string;
  topic?: string;
  speaker?: string;
  thumbnailUrl?: string;
  transition?: 'none' | 'fade' | 'crossfade';
  crop?: { x: number; y: number; w: number; h: number } | null;
  locked?: boolean;
}

export interface CaptionStyle {
  fontFamily: string;
  fontSize: number;
  color: string; // hex e.g. #FFFFFF or #FACC15
  backgroundColor: string;
  backgroundOpacity?: number;
  position: 'bottom' | 'center' | 'top';
  mode?: 'sentence' | 'word';
  highlightActiveWord: boolean;
  highlightColor: string;
}

export interface CaptionEntry {
  id: string;
  sourceSegmentId?: string;
  speakerId?: string;
  sourceStart: number;
  sourceEnd: number;
  text: string;
  speaker?: string;
  words: TranscriptWord[];
  visible: boolean;
  styleOverride?: Partial<CaptionStyle>;
}

export interface TextOverlay {
  id: string;
  text: string;
  timelineStart: number;
  timelineEnd: number;
  x: number; // percentage 0..100
  y: number; // percentage 0..100
  fontSize: number;
  color: string;
  backgroundColor: string;
  locked?: boolean;
}

export interface BleepRange {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  label: string;
}

export interface MuteRange {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  label: string;
}

export interface AudioSettings {
  masterVolume: number; // 0..2
  muted: boolean;
  noiseReduction: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  musicEnabled: boolean;
  musicPreset: 'ambient-pulse' | 'cinematic-pad' | 'upbeat-synth' | 'custom-upload';
  musicVolume: number; // 0..1
  musicFadeInSec: number;
  musicFadeOutSec: number;
  musicStartOffsetSec?: number;
  musicDurationSec?: number;
  customMusicUrl?: string;
  customMusicName?: string;
  customMusicPath?: string;
  audioTrackLocked: boolean;
}

export interface TrackVisibility {
  video: boolean;
  audio: boolean;
  captions: boolean;
  overlays: boolean;
  music: boolean;
}

export interface TrackLocks {
  video: boolean;
  audio: boolean;
  captions: boolean;
  overlays: boolean;
  music: boolean;
}

export interface ProjectState {
  mediaId: string;
  segments: TimelineSegment[];
  duration: number;
  captionsEnabled: boolean;
  captionStyle: CaptionStyle;
  captions: CaptionEntry[];
  overlays: TextOverlay[];
  bleeps: BleepRange[];
  muteRanges?: MuteRange[];
  audio: AudioSettings;
  trackVisibility: TrackVisibility;
  trackLocks: TrackLocks;
  protectedMomentIds: string[];
  activeVersionId?: string;
}

export type EditOperationType =
  | 'REMOVE_RANGE'
  | 'REMOVE_WORD'
  | 'MUTE_RANGE'
  | 'REMOVE_WORD_FROM_CAPTIONS'
  | 'KEEP_ONLY_RANGE'
  | 'REORDER_SEGMENT'
  | 'SET_SPEED'
  | 'SPLIT_AT'
  | 'TRIM_SEGMENT'
  | 'REMOVE_SILENCES'
  | 'REMOVE_FILLERS'
  | 'ENABLE_CAPTIONS'
  | 'GENERATE_CAPTIONS'
  | 'STYLE_CAPTIONS'
  | 'UPDATE_CAPTION_TEXT'
  | 'DELETE_CAPTION'
  | 'ADJUST_CAPTION_TIME'
  | 'ADD_TEXT_OVERLAY'
  | 'UPDATE_OVERLAY'
  | 'DELETE_OVERLAY'
  | 'SET_AUDIO'
  | 'BLEEP_RANGE'
  | 'CREATE_DURATION_CUT'
  | 'RESTORE_SEGMENT'
  | 'APPLY_VERSION';

export type TargetScope =
  | 'word'
  | 'sentence'
  | 'phrase'
  | 'paragraph'
  | 'scene'
  | 'timestamp'
  | 'caption'
  | 'segment';

export interface EditOperation {
  type: EditOperationType;
  label: string;
  targetScope?: TargetScope;
  targetText?: string;
  targetSpeaker?: string;
  confidence?: number;
  reason?: string;
  // Optional parameters per operation type
  sourceStart?: number;
  sourceEnd?: number;
  timelineStart?: number;
  timelineEnd?: number;
  segmentId?: string;
  fromIndex?: number;
  toIndex?: number;
  timelineTime?: number;
  speed?: number;
  targetDurationSec?: number;
  keepRanges?: Array<{ start: number; end: number; label: string }>;
  removeRanges?: Array<{ start: number; end: number; label: string; targetText?: string }>;
  captionEnabled?: boolean;
  captionStylePatch?: Partial<CaptionStyle>;
  captionId?: string;
  captionText?: string;
  captionStart?: number;
  captionEnd?: number;
  wordId?: string;
  removeWordText?: string;
  overlayId?: string;
  overlay?: Omit<TextOverlay, 'id'>;
  overlayPatch?: Partial<TextOverlay>;
  audioPatch?: Partial<AudioSettings>;
  restoreTarget?: 'intro' | 'all' | 'range';
  versionSegments?: TimelineSegment[];
  versionId?: string;
}

export interface UncertainWordWarning {
  wordId?: string;
  word: string;
  sourceStart: number;
  sourceEnd: number;
  status: 'review_needed' | 'unclear_audio';
  confidence?: number;
  candidates?: string[];
}

export interface EditPlan {
  id: string;
  prompt: string;
  intentSummary: string;
  operations: EditOperation[];
  searchQuery?: string;
  requiresClarification?: boolean;
  clarificationQuestion?: string;
  requiresUncertainConfirmation?: boolean;
  uncertainWordWarnings?: UncertainWordWarning[];
  validationError?: string;
  candidates?: Array<{
    id: string;
    label: string;
    snippet: string;
    speaker?: string;
    wordText?: string;
    targetScope?: TargetScope;
    verificationStatus?: VerificationStatus;
    confidence?: number;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number | null;
    timelineEnd: number | null;
  }>;
  aiMode: AnalysisMode;
}

export interface EditImpactReport {
  affectedSegments: Array<{
    segmentId: string;
    label: string;
    sourceStart: number;
    sourceEnd: number;
    timelineStart: number;
    timelineEnd: number;
  }>;
  durationBefore: number;
  durationAfter: number;
  durationDelta: number;
  captionsAffectedCount: number;
  protectedWarnings: Array<{
    momentId: string;
    title: string;
    category: ImportantCategory;
    reason: string;
    sourceStart: number;
    sourceEnd: number;
  }>;
  hasProtectedCollision: boolean;
}

export interface HistoryEntry {
  id: string;
  timestamp: string;
  label: string;
  prompt?: string;
  durationAfter: number;
  stateSnapshot: ProjectState;
}

export interface EditVersion {
  id: 'fast_hook' | 'balanced_story' | 'detailed_explainer';
  name: string;
  tagline: string;
  description: string;
  durationSec: number;
  pacingLabel: string;
  coveragePercent: number;
  segmentCount: number;
  segments: TimelineSegment[];
  captionsEnabled: boolean;
  highlights: string[];
}

export interface SearchHit {
  id: string;
  matchType: 'transcript' | 'topic' | 'speaker' | 'scene' | 'object' | 'activity' | 'important';
  score: number;
  snippet: string;
  explanation: string;
  speaker?: string;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number | null;
  timelineEnd: number | null;
  thumbnailUrl?: string;
  inCurrentTimeline: boolean;
}

export interface ProjectRecord {
  id: string;
  title: string;
  mediaId: string;
  thumbnailUrl: string;
  vocabulary?: string[];
  state: ProjectState;
  history: HistoryEntry[];
  historyIndex: number;
  versions: EditVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface ExportJob {
  id: string;
  projectId: string;
  mediaId: string;
  status: 'queued' | 'rendering' | 'validating' | 'completed' | 'failed';
  progress: number;
  resolution: '480p' | '720p' | '1080p';
  quality: 'fast' | 'balanced' | 'high';
  outputUrl?: string;
  fileSizeBytes?: number;
  durationSec?: number;
  error?: string;
  createdAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  name: string;
}
