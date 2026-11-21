import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Copy,
  Edit3,
  Film,
  Link2,
  LogIn,
  LogOut,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Upload,
  User,
  Video,
  X,
} from 'lucide-react';
import type { UserProfile } from '../shared/types';
import { formatTimecode } from '../shared/timelineEngine';
import { api, apiUrl, type DemoCatalogItem, type HydratedProject } from '../lib/api';

interface DashboardProps {
  user: UserProfile | null;
  demos: DemoCatalogItem[];
  projects: HydratedProject[];
  onAuthChange: (user: UserProfile | null) => void;
  onRefreshProjects: () => Promise<void>;
  onOpenProject: (project: HydratedProject) => void;
  onBackHome: () => void;
}

export function Dashboard({
  user,
  demos,
  projects,
  onAuthChange,
  onRefreshProjects,
  onOpenProject,
  onBackHome,
}: DashboardProps) {
  const [activeTab, setActiveTab] = useState<'projects' | 'upload' | 'record' | 'demos'>('projects');
  const [authModalMode, setAuthModalMode] = useState<'login' | 'signup' | null>(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authName, setAuthName] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  // Project list management
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  // Real File Upload state
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'analyzing' | 'error'>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Direct URL Video Intake state
  const [videoUrl, setVideoUrl] = useState('');
  const [urlTitle, setUrlTitle] = useState('');
  const [urlImportProgress, setUrlImportProgress] = useState(0);
  const [urlImportStatus, setUrlImportStatus] = useState<'idle' | 'validating' | 'downloading' | 'probing' | 'error'>('idle');
  const [urlImportError, setUrlImportError] = useState<string | null>(null);

  // Real Camera/Mic Recording state
  const [recState, setRecState] = useState<'idle' | 'ready' | 'recording' | 'paused' | 'recorded'>('idle');
  const [recError, setRecError] = useState<string | null>(null);
  const [recDuration, setRecDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [recTitle, setRecTitle] = useState('Studio Camera Recording');
  const [recUploadPct, setRecUploadPct] = useState(0);
  const [recSaving, setRecSaving] = useState(false);

  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);

  const stopCameraStream = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      stopCameraStream();
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
  }, [recordedUrl]);

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setAuthBusy(true);
    try {
      const nextUser =
        authModalMode === 'signup'
          ? await api.signup(authEmail, authPassword, authName)
          : await api.login(authEmail, authPassword);
      onAuthChange(nextUser);
      setAuthModalMode(null);
      setAuthEmail('');
      setAuthPassword('');
      setAuthName('');
      await onRefreshProjects();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setAuthBusy(false);
    }
  };

  const handleLogout = async () => {
    await api.logout();
    onAuthChange(null);
    await onRefreshProjects();
  };

  const validateAndSelectFile = (file: File) => {
    setUploadError(null);
    const validMime =
      file.type.startsWith('video/') ||
      /\.(mp4|webm|mov|mkv|ogv)$/i.test(file.name);
    if (!validMime) {
      setUploadError('Unsupported file format. Choose MP4, WebM, MOV, or MKV video.');
      setSelectedFile(null);
      return;
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      setUploadError('File exceeds 2 GB maximum upload size.');
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setUploadTitle(file.name.replace(/\.[^.]+$/, ''));
    setUploadStatus('idle');
    setUploadProgress(0);
  };

  const handleStartUpload = async () => {
    if (!selectedFile) return;
    setUploadError(null);
    setUploadStatus('uploading');
    setUploadProgress(5);
    try {
      const project = await api.ingestMediaWithProgress(
        selectedFile,
        selectedFile.name,
        'upload',
        uploadTitle.trim() || selectedFile.name,
        (pct) => {
          setUploadProgress(pct);
          if (pct >= 75) setUploadStatus('analyzing');
        },
      );
      await onRefreshProjects();
      onOpenProject(project);
    } catch (err) {
      setUploadStatus('error');
      setUploadError(err instanceof Error ? err.message : 'Upload failed. Please retry.');
    }
  };

  const handleStartUrlImport = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleaned = videoUrl.trim();
    if (!cleaned) {
      setUrlImportStatus('error');
      setUrlImportError('Please paste a valid http:// or https:// video URL.');
      return;
    }
    setUrlImportError(null);
    setUrlImportStatus('validating');
    setUrlImportProgress(8);
    try {
      const started = await api.importMediaFromUrl({
        url: cleaned,
        title: urlTitle.trim() || undefined,
      });

      if (started.importJob.status === 'completed' && started.project) {
        await onRefreshProjects();
        onOpenProject(started.project);
        return;
      }

      const importId = started.importJob.id;
      for (let i = 0; i < 600; i++) {
        await new Promise((r) => setTimeout(r, 450));
        const res = await api.getUrlImportStatus(importId);
        const job = res.importJob;
        setUrlImportProgress(Math.max(10, job.progress || 0));
        if (job.status === 'downloading') setUrlImportStatus('downloading');
        else if (job.status === 'probing') setUrlImportStatus('probing');
        else if (job.status === 'failed') {
          throw new Error(job.error || 'Failed to download or process the video URL.');
        } else if (job.status === 'completed' && res.project) {
          await onRefreshProjects();
          onOpenProject(res.project);
          return;
        }
      }
      throw new Error('URL import timed out while waiting for server download.');
    } catch (err) {
      setUrlImportStatus('error');
      setUrlImportError(err instanceof Error ? err.message : 'URL import failed.');
    }
  };

  const handleInitCamera = async () => {
    setRecError(null);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Browser camera/microphone API is unavailable in this context.');
      }
      stopCameraStream();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
      streamRef.current = stream;
      setRecState('ready');
      setRecDuration(0);
      if (liveVideoRef.current) {
        liveVideoRef.current.srcObject = stream;
        await liveVideoRef.current.play().catch(() => {});
      }
    } catch (err) {
      setRecError(
        err instanceof Error
          ? `${err.message}. Grant camera & microphone access or upload a video file instead.`
          : 'Could not access camera or microphone.',
      );
      setRecState('idle');
    }
  };

  const handleStartRecording = () => {
    if (!streamRef.current) return;
    setRecError(null);
    chunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';

    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType || 'video/webm' });
      setRecordedBlob(blob);
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      const url = URL.createObjectURL(blob);
      setRecordedUrl(url);
      setRecState('recorded');
      stopCameraStream();
    };

    recorderRef.current = recorder;
    recorder.start(250);
    setRecState('recording');
    setRecDuration(0);
    timerRef.current = window.setInterval(() => {
      setRecDuration((d) => d + 1);
    }, 1000);
  };

  const handlePauseRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'recording') {
      recorderRef.current.pause();
      if (timerRef.current) window.clearInterval(timerRef.current);
      setRecState('paused');
    }
  };

  const handleResumeRecording = () => {
    if (recorderRef.current && recorderRef.current.state === 'paused') {
      recorderRef.current.resume();
      timerRef.current = window.setInterval(() => {
        setRecDuration((d) => d + 1);
      }, 1000);
      setRecState('recording');
    }
  };

  const handleStopRecording = () => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
  };

  const handleRetake = async () => {
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl(null);
    setRecDuration(0);
    await handleInitCamera();
  };

  const handleSaveRecording = async () => {
    if (!recordedBlob) return;
    setRecSaving(true);
    setRecError(null);
    try {
      const project = await api.ingestMediaWithProgress(
        recordedBlob,
        `recording-${Date.now()}.webm`,
        'recording',
        recTitle.trim() || 'Camera Recording',
        (pct) => setRecUploadPct(pct),
      );
      await onRefreshProjects();
      onOpenProject(project);
    } catch (err) {
      setRecError(err instanceof Error ? err.message : 'Failed to save recording.');
    } finally {
      setRecSaving(false);
    }
  };

  const handleOpenDemo = async (demoId: string) => {
    setBusyProjectId(demoId);
    try {
      const project = (await api.createProjectFromDemo(demoId)).project;
      await onRefreshProjects();
      onOpenProject(project);
    } finally {
      setBusyProjectId(null);
    }
  };

  const handleRenameSubmit = async (id: string) => {
    if (!renameText.trim()) {
      setRenamingId(null);
      return;
    }
    await api.updateProject(id, { title: renameText.trim() });
    setRenamingId(null);
    await onRefreshProjects();
  };

  const handleDuplicate = async (id: string) => {
    setBusyProjectId(id);
    try {
      await api.duplicateProject(id);
      await onRefreshProjects();
    } finally {
      setBusyProjectId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusyProjectId(id);
    try {
      await api.deleteProject(id);
      await onRefreshProjects();
    } finally {
      setBusyProjectId(null);
    }
  };

  return (
    <div className="min-h-screen bg-[#050711] text-slate-100">
      {/* Top Bar */}
      <header className="border-b border-white/10 bg-[#070B19]">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-4">
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onBackHome}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Home
            </button>
            <span className="text-lg font-bold tracking-tight text-white whitespace-nowrap">
              EDITMIND <span className="text-cyan-400">Studio</span>
            </span>
          </div>

          <div className="flex items-center gap-3">
            {user ? (
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-300 hidden sm:inline">
                  <User className="w-3.5 h-3.5 inline mr-1 text-cyan-400" />
                  {user.name} ({user.email})
                </span>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sign Out
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400 hidden sm:inline">Guest Workspace</span>
                <button
                  type="button"
                  onClick={() => setAuthModalMode('login')}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400/50 cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5 text-cyan-400" />
                  Sign In / Save Cloud
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8 space-y-8">
        {/* Primary Action Strip */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-white">Project Dashboard</h1>
            <p className="text-sm text-slate-400">
              Upload your own video, record live camera footage, or launch a bundled demo project.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('upload')}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-4 py-2.5 text-xs font-semibold text-white hover:brightness-110 cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              Upload Video
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveTab('record');
                if (recState === 'idle') void handleInitCamera();
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-violet-400/40 bg-violet-500/15 px-4 py-2.5 text-xs font-semibold text-violet-200 hover:bg-violet-500/25 cursor-pointer"
            >
              <Camera className="w-4 h-4" />
              Record Video
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('demos')}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-200 hover:border-cyan-400/40 cursor-pointer"
            >
              <Film className="w-4 h-4 text-cyan-400" />
              Demo Library
            </button>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 border-b border-white/10 pb-2 overflow-x-auto">
          {(
            [
              { id: 'projects', label: `Recent Projects (${projects.length})` },
              { id: 'upload', label: 'Upload Footage' },
              { id: 'record', label: 'Camera & Mic Studio' },
              { id: 'demos', label: `Demo Videos (${demos.length})` },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-lg px-4 py-2 text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                activeTab === tab.id
                  ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-400/35'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab 1: Recent Projects */}
        {activeTab === 'projects' && (
          <section className="space-y-4">
            {projects.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-white/15 bg-[#0B1022]/60 p-10 text-center space-y-4">
                <Video className="w-10 h-10 text-cyan-400 mx-auto" />
                <div className="space-y-1">
                  <h2 className="text-lg font-semibold text-white">No Projects Yet</h2>
                  <p className="text-sm text-slate-400 max-w-md mx-auto">
                    Upload your own MP4/WebM video, record directly from your webcam, or open one of our 5 real demo projects.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab('upload')}
                    className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    Upload Video
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleOpenDemo(demos[0]?.id || 'demo-keynote')}
                    className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-white hover:border-cyan-400/50 cursor-pointer"
                  >
                    <Play className="w-4 h-4 text-cyan-400" />
                    Open Keynote Demo
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projects.map((proj) => (
                  <div
                    key={proj.id}
                    className="rounded-2xl border border-white/10 bg-[#0B1022]/90 overflow-hidden flex flex-col justify-between"
                  >
                    <div>
                      <div className="relative aspect-video bg-slate-950">
                        <img
                          src={apiUrl(proj.thumbnailUrl || '/api/demos/demo-keynote/thumb')}
                          alt={proj.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                        <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-xs">
                          <span className="text-cyan-300 font-medium">
                            {proj.media?.sourceType === 'upload'
                              ? 'Uploaded Media'
                              : proj.media?.sourceType === 'url'
                                ? 'URL Import'
                                : proj.media?.sourceType === 'recording'
                                  ? 'Camera Recording'
                                  : 'Demo Media'}
                          </span>
                          <span className="font-mono tabular-nums text-white">
                            {formatTimecode(proj.state.duration)}
                          </span>
                        </div>
                      </div>
                      <div className="p-4 space-y-2">
                        {renamingId === proj.id ? (
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void handleRenameSubmit(proj.id);
                                if (e.key === 'Escape') setRenamingId(null);
                              }}
                              aria-label="New project title"
                              autoFocus
                              className="flex-1 rounded-lg border border-cyan-400/60 bg-slate-950 px-2.5 py-1 text-sm text-white focus:outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => void handleRenameSubmit(proj.id)}
                              className="rounded-lg bg-cyan-500 px-2.5 py-1 text-xs font-semibold text-slate-950 cursor-pointer"
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <h3 className="text-base font-bold text-white truncate">{proj.title}</h3>
                        )}
                        <div className="text-xs text-slate-400 truncate">
                          Source: {proj.media?.filename || proj.mediaId} · {proj.state.segments.length} clip(s)
                        </div>
                      </div>
                    </div>

                    <div className="px-4 pb-4 flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenProject(proj)}
                        className="flex-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-2 text-xs font-semibold text-white hover:brightness-110 cursor-pointer"
                      >
                        Continue Editing
                      </button>
                      <button
                        type="button"
                        aria-label={`Rename ${proj.title}`}
                        onClick={() => {
                          setRenamingId(proj.id);
                          setRenameText(proj.title);
                        }}
                        className="rounded-lg border border-white/10 bg-slate-900 p-2 text-slate-300 hover:text-white cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Duplicate ${proj.title}`}
                        disabled={busyProjectId === proj.id}
                        onClick={() => void handleDuplicate(proj.id)}
                        className="rounded-lg border border-white/10 bg-slate-900 p-2 text-slate-300 hover:text-white cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${proj.title}`}
                        disabled={busyProjectId === proj.id}
                        onClick={() => void handleDelete(proj.id)}
                        className="rounded-lg border border-white/10 bg-slate-900 p-2 text-rose-400 hover:bg-rose-500/15 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Tab 2: Real Video Upload + Side-by-Side Enter Video URL */}
        {activeTab === 'upload' && (
          <section className="max-w-5xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            {/* A. Upload Video File */}
            <div className="rounded-2xl border border-white/10 bg-[#0B1022]/90 p-6 sm:p-7 space-y-5">
              <div className="space-y-1">
                <h2 className="text-xl font-bold text-white">A. Upload Video File</h2>
                <p className="text-sm text-slate-400">
                  Supports MP4, WebM, MOV, and MKV up to 2 GB. Long videos are processed via disk-streamed audio extraction and voice-aware chunked speech transcription.
                </p>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) validateAndSelectFile(f);
                }}
                className={`rounded-2xl border-2 border-dashed p-8 text-center space-y-4 transition-colors ${
                  dragActive
                    ? 'border-cyan-400 bg-cyan-500/10'
                    : 'border-white/15 bg-[#060914] hover:border-cyan-400/50'
                }`}
              >
                <Upload className="w-9 h-9 text-cyan-400 mx-auto" />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-white">
                    {selectedFile ? selectedFile.name : 'Drag and drop your video file here'}
                  </div>
                  <div className="text-xs text-slate-400">
                    {selectedFile
                      ? `${(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · ${selectedFile.type || 'video'}`
                      : 'Or browse from your computer (max 2 GB)'}
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) validateAndSelectFile(f);
                  }}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-xl border border-white/15 bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:border-cyan-400 cursor-pointer"
                >
                  Browse Video File
                </button>
              </div>

              {selectedFile && (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="upload-title" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Project Title
                    </label>
                    <input
                      id="upload-title"
                      type="text"
                      value={uploadTitle}
                      onChange={(e) => setUploadTitle(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2.5 text-sm text-white focus:border-cyan-400 focus:outline-none"
                    />
                  </div>

                  {(uploadStatus === 'uploading' || uploadStatus === 'analyzing') && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-cyan-300">
                          {uploadStatus === 'uploading'
                            ? 'Uploading video stream...'
                            : 'Inspecting streams & preparing background transcription job...'}
                        </span>
                        <span className="font-mono tabular-nums text-white">{uploadProgress}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-400 to-violet-500 transition-all"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={uploadStatus === 'uploading' || uploadStatus === 'analyzing'}
                      onClick={() => void handleStartUpload()}
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-2.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50 cursor-pointer"
                    >
                      {uploadStatus === 'error' ? (
                        <>
                          <RefreshCw className="w-4 h-4" />
                          Retry Upload & Analysis
                        </>
                      ) : (
                        <>
                          <Upload className="w-4 h-4" />
                          Upload & Analyze Video
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}

              {uploadError && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200">
                  {uploadError}
                </div>
              )}
            </div>

            {/* B. Enter Video URL */}
            <form
              onSubmit={(e) => void handleStartUrlImport(e)}
              className="rounded-2xl border border-violet-500/25 bg-[#0B1022]/90 p-6 sm:p-7 space-y-5"
            >
              <div className="space-y-1">
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Link2 className="w-5 h-5 text-violet-400" />
                  B. Enter Video URL
                </h2>
                <p className="text-sm text-slate-400">
                  Import a public HTTP/HTTPS MP4, WebM, MOV, or MKV video directly up to 2 GB with SSRF protection and automatic speech transcription.
                </p>
              </div>

              <div className="space-y-3.5">
                <div>
                  <label htmlFor="video-url-input" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Video URL
                  </label>
                  <input
                    id="video-url-input"
                    type="url"
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="Paste your video URL here..."
                    className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="url-project-title" className="block text-xs font-medium text-slate-300 mb-1.5">
                    Project Title (optional)
                  </label>
                  <input
                    id="url-project-title"
                    type="text"
                    value={urlTitle}
                    onChange={(e) => setUrlTitle(e.target.value)}
                    placeholder="Auto-detected from URL filename"
                    className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-400 focus:outline-none"
                  />
                </div>
              </div>

              {(urlImportStatus === 'validating' ||
                urlImportStatus === 'downloading' ||
                urlImportStatus === 'probing') && (
                <div className="space-y-2">
                  <div className="flex justify-between text-xs">
                    <span className="text-violet-300">
                      {urlImportStatus === 'validating'
                        ? 'Validating remote URL & headers...'
                        : urlImportStatus === 'downloading'
                          ? 'Downloading remote video stream...'
                          : 'Inspecting streams & preparing workspace...'}
                    </span>
                    <span className="font-mono tabular-nums text-white">{urlImportProgress}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-violet-400 to-cyan-400 transition-all"
                      style={{ width: `${urlImportProgress}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  disabled={
                    urlImportStatus === 'validating' ||
                    urlImportStatus === 'downloading' ||
                    urlImportStatus === 'probing'
                  }
                  className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-cyan-500 px-5 py-2.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50 cursor-pointer"
                >
                  <Link2 className="w-4 h-4" />
                  Import Video
                </button>
              </div>

              {urlImportError && (
                <div
                  data-testid="url-import-error"
                  className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200"
                >
                  {urlImportError}
                </div>
              )}
            </form>
          </section>
        )}

        {/* Tab 3: Real Camera & Mic Recording */}
        {activeTab === 'record' && (
          <section className="max-w-3xl mx-auto rounded-2xl border border-white/10 bg-[#0B1022]/90 p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-white">Camera & Microphone Studio</h2>
                <p className="text-sm text-slate-400">
                  Capture live footage directly in your browser. Recorded media is saved as an independent source file—never replaced with demo footage.
                </p>
              </div>
              {(recState === 'recording' || recState === 'paused') && (
                <div className="font-mono tabular-nums text-sm font-bold text-rose-400">
                  REC {formatTimecode(recDuration)}
                </div>
              )}
            </div>

            <div className="relative aspect-video rounded-2xl border border-white/10 bg-black overflow-hidden flex items-center justify-center">
              {recState === 'recorded' && recordedUrl ? (
                <video
                  src={recordedUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              ) : (
                  <video
                    ref={liveVideoRef}
                    muted
                    playsInline
                    className={`w-full h-full object-contain ${recState === 'idle' ? 'hidden' : 'block'}`}
                  />
              )}

              {recState === 'idle' && (
                <div className="text-center space-y-3 p-6">
                  <Camera className="w-10 h-10 text-violet-400 mx-auto" />
                  <p className="text-sm text-slate-300">
                    Click below to grant camera and microphone permissions and start live preview.
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleInitCamera()}
                    className="rounded-xl bg-violet-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-violet-500 cursor-pointer"
                  >
                    Enable Camera & Mic
                  </button>
                </div>
              )}
            </div>

            {recError && (
              <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3.5 text-xs text-rose-200">
                {recError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              {recState === 'ready' && (
                <button
                  type="button"
                  onClick={handleStartRecording}
                  className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-rose-500 cursor-pointer"
                >
                  <Camera className="w-4 h-4" />
                  Start Recording
                </button>
              )}

              {recState === 'recording' && (
                <>
                  <button
                    type="button"
                    onClick={handlePauseRecording}
                    className="inline-flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-4 py-2.5 text-xs font-semibold text-amber-200 cursor-pointer"
                  >
                    <Pause className="w-4 h-4" />
                    Pause
                  </button>
                  <button
                    type="button"
                    onClick={handleStopRecording}
                    className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    <Square className="w-4 h-4" />
                    Stop Recording
                  </button>
                </>
              )}

              {recState === 'paused' && (
                <>
                  <button
                    type="button"
                    onClick={handleResumeRecording}
                    className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    <Play className="w-4 h-4" />
                    Resume
                  </button>
                  <button
                    type="button"
                    onClick={handleStopRecording}
                    className="inline-flex items-center gap-2 rounded-xl bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white cursor-pointer"
                  >
                    <Square className="w-4 h-4" />
                    Stop Recording
                  </button>
                </>
              )}

              {recState === 'recorded' && (
                <div className="w-full space-y-4">
                  <div>
                    <label htmlFor="rec-title" className="block text-xs font-medium text-slate-300 mb-1.5">
                      Recording Project Title
                    </label>
                    <input
                      id="rec-title"
                      type="text"
                      value={recTitle}
                      onChange={(e) => setRecTitle(e.target.value)}
                      className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2.5 text-sm text-white focus:border-cyan-400 focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={recSaving}
                      onClick={() => void handleSaveRecording()}
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 px-5 py-2.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50 cursor-pointer"
                    >
                      {recSaving ? `Saving & Analyzing (${recUploadPct}%)` : 'Save & Open in Editor'}
                    </button>
                    <button
                      type="button"
                      disabled={recSaving}
                      onClick={() => void handleRetake()}
                      className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-slate-900 px-4 py-2.5 text-xs font-semibold text-slate-200 cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Retake
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* Tab 4: Demo Library */}
        {activeTab === 'demos' && (
          <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {demos.map((demo) => (
              <div
                key={demo.id}
                className="rounded-2xl border border-white/10 bg-[#0B1022]/90 overflow-hidden flex flex-col justify-between"
              >
                <div>
                  <div className="relative aspect-video bg-slate-950">
                    <img
                      src={apiUrl(demo.thumbnailUrl)}
                      alt={demo.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-xs">
                      <span className="text-cyan-300 font-medium">{demo.category}</span>
                      <span className="font-mono tabular-nums text-white">
                        {demo.durationSec.toFixed(1)}s
                      </span>
                    </div>
                  </div>
                  <div className="p-4 space-y-2">
                    <h3 className="text-base font-bold text-white">{demo.title}</h3>
                    <p className="text-xs text-slate-400">{demo.description}</p>
                    <div className="text-[11px] text-cyan-300/90 font-mono">
                      Try: "{demo.examplePrompts[0]}"
                    </div>
                  </div>
                </div>
                <div className="px-4 pb-4">
                  <button
                    type="button"
                    disabled={busyProjectId === demo.id}
                    onClick={() => void handleOpenDemo(demo.id)}
                    className="w-full rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 py-2 text-xs font-semibold text-white hover:brightness-110 cursor-pointer"
                  >
                    {busyProjectId === demo.id ? 'Creating Project...' : 'Open Demo in Studio'}
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
      </main>

      {/* Optional Login / Signup Modal */}
      {authModalMode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0B1022] p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">
                {authModalMode === 'login' ? 'Sign In to EDITMIND AI' : 'Create Free Account'}
              </h2>
              <button
                type="button"
                aria-label="Close authentication modal"
                onClick={() => setAuthModalMode(null)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              {authModalMode === 'signup' && (
                <div>
                  <label htmlFor="auth-name" className="block text-xs font-medium text-slate-300 mb-1">
                    Full Name
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    required
                    value={authName}
                    onChange={(e) => setAuthName(e.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                  />
                </div>
              )}
              <div>
                <label htmlFor="auth-email" className="block text-xs font-medium text-slate-300 mb-1">
                  Email Address
                </label>
                <input
                  id="auth-email"
                  type="email"
                  required
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="auth-password" className="block text-xs font-medium text-slate-300 mb-1">
                  Password (min 6 characters)
                </label>
                <input
                  id="auth-password"
                  type="password"
                  required
                  minLength={6}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[#060914] px-3.5 py-2 text-sm text-white focus:border-cyan-400 focus:outline-none"
                />
              </div>

              {authError && (
                <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
                  {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={authBusy}
                className="w-full rounded-xl bg-gradient-to-r from-cyan-500 to-violet-600 py-2.5 text-sm font-semibold text-white hover:brightness-110 cursor-pointer"
              >
                {authBusy ? 'Please wait...' : authModalMode === 'login' ? 'Sign In' : 'Create Account'}
              </button>
            </form>

            <div className="text-center text-xs text-slate-400">
              {authModalMode === 'login' ? (
                <button
                  type="button"
                  onClick={() => {
                    setAuthError(null);
                    setAuthModalMode('signup');
                  }}
                  className="text-cyan-300 hover:underline cursor-pointer"
                >
                  Need an account? Sign up to sync projects
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setAuthError(null);
                    setAuthModalMode('login');
                  }}
                  className="text-cyan-300 hover:underline cursor-pointer"
                >
                  Already have an account? Sign in
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
