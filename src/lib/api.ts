import { upload as uploadToVercelBlob } from '@vercel/blob/client';
import type {
  AnalysisJob,
  EditImpactReport,
  EditPlan,
  EditVersion,
  ExportJob,
  HistoryEntry,
  MediaAnalysis,
  MediaAsset,
  ProjectRecord,
  ProjectState,
  SearchHit,
  TranscriptWord,
  TranslationTrack,
  UrlImportJob,
  UserProfile,
} from '../shared/types';

export interface LanguageOption {
  code: string;
  label: string;
  nativeLabel: string;
}

export let API_BASE_URL = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || ''
).replace(/\/$/, '');
const discoverWorker = !API_BASE_URL && import.meta.env.VITE_MEDIA_WORKER === '1';
let workerValidUntil = 0;
let workerLookup: Promise<void> | undefined;

export async function connectWorker(refresh = false) {
  if (!discoverWorker || (!refresh && Date.now() < workerValidUntil)) return;
  workerLookup ??= (async () => {
    const response = await fetch(refresh ? '/api/backend?refresh=1' : '/api/backend', { cache: 'no-store' });
    if (!response.ok) throw new Error('The media backend is starting or unavailable. Please try again.');
    const { origin } = await response.json();
    const url = new URL(origin);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.run')) {
      throw new Error('Unexpected media backend address.');
    }
    API_BASE_URL = url.origin;
    workerValidUntil = Date.now() + 30000;
  })().finally(() => { workerLookup = undefined; });
  return workerLookup;
}

export function apiUrl(urlPath: string): string {
  if (!urlPath) return urlPath;
  if (/^(https?:|blob:|data:)/i.test(urlPath)) return urlPath;
  const normalizedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  if (discoverWorker && normalizedPath==='/api/ai/plan' && (getAuthToken() || confirmedGuest)) return '/api/assistant';
  if (!API_BASE_URL || !normalizedPath.startsWith('/api/')) return normalizedPath;
  if (API_BASE_URL === '/api' && (normalizedPath === '/api' || normalizedPath.startsWith('/api/'))) {
    return normalizedPath;
  }
  if (API_BASE_URL.endsWith('/api') && (normalizedPath === '/api' || normalizedPath.startsWith('/api/'))) {
    return `${API_BASE_URL}${normalizedPath.slice(4)}`;
  }
  return `${API_BASE_URL}${normalizedPath}`;
}

export interface HydratedProject extends ProjectRecord {
  media: MediaAsset | null;
}

export interface DemoCatalogItem {
  id: string;
  title: string;
  category: string;
  description: string;
  examplePrompts: string[];
  mediaUrl: string;
  thumbnailUrl: string;
  durationSec: number;
  topics: string[];
  transcriptCount: number;
}

const GUEST_KEY = 'editmind_guest_id';
let inMemoryAuthToken: string | null = null;
let confirmedGuest=false;

export function getGuestId(): string {
  let id = localStorage.getItem(GUEST_KEY);
  if (!id) {
    id = `guest-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    localStorage.setItem(GUEST_KEY, id);
  }
  return id;
}

export function getAuthToken(): string | null {
  return inMemoryAuthToken;
}

export function setAuthToken(token: string | null) {
  inMemoryAuthToken = token;
  confirmedGuest = !token;
}

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'x-guest-id': getGuestId(),
    'x-requested-with': 'XMLHttpRequest',
    ...extra,
  };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

import {
  fallbackCorrectTranscriptWord,
  fallbackCreateProjectFromDemo,
  fallbackDeleteProject,
  fallbackDuplicateProject,
  fallbackGetExportStatus,
  fallbackGetProject,
  fallbackIngestLocalMedia,
  fallbackListDemos,
  fallbackListLanguages,
  fallbackListProjects,
  fallbackRegenerateVersions,
  fallbackSearchProject,
  fallbackStartExport,
  fallbackTranslateProject,
  fallbackUpdateProject,
  fallbackUpdateVocabulary,
  fallbackUploadMusic,
} from './clientFallback';

class ApiError extends Error {
  status: number;
  isJsonError: boolean;
  isNonJson: boolean;

  constructor(message: string, opts: { status: number; isJsonError?: boolean; isNonJson?: boolean }) {
    super(message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.isJsonError = Boolean(opts.isJsonError);
    this.isNonJson = Boolean(opts.isNonJson);
  }
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  if (apiUrl(url)!=='/api/assistant') await connectWorker();
  const send = (target=apiUrl(url)) => fetch(target, {
    ...init,
    credentials: 'include',
    headers: buildHeaders({
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }),
  });
  const retryable=discoverWorker && ['GET','HEAD','PATCH','PUT'].includes((init.method||'GET').toUpperCase());
  let res:Response;
  try { res=await send(); }
  catch(error) {
    if(!retryable || init.signal?.aborted) throw error;
    await connectWorker(true);
    res=await send();
  }
  if(retryable && [502,503,504].includes(res.status)){
    await connectWorker(true);
    res=await send();
  }
  // An account may sign in in another tab after this tab checked its identity.
  // A worker-cookie session can still authorize the project on its original host.
  if (res.status===404 && discoverWorker && confirmedGuest && !getAuthToken() && url==='/api/ai/plan') {
    await connectWorker();
    res=await send(API_BASE_URL+url);
    if (res.ok) confirmedGuest=false;
  }
  const rawText = await res.text();
  let data: unknown = {};
  let parsedOk = Boolean(rawText.trim());
  if (rawText.trim()) {
    try {
      data = JSON.parse(rawText);
      parsedOk = true;
    } catch {
      parsedOk = false;
    }
  }
  if (!res.ok) {
    const errObj = parsedOk && data && typeof data === 'object' ? (data as { error?: string | { message?: string } }).error : undefined;
    const msg = typeof errObj === 'string' ? errObj : errObj?.message;
    throw new ApiError(msg || `Request failed (${res.status})`, {
      status: res.status,
      isJsonError: Boolean(parsedOk && msg),
      isNonJson: !parsedOk,
    });
  }
  if (!parsedOk) {
    throw new ApiError(`Unexpected non-JSON response from ${url}`, {
      status: res.status,
      isNonJson: true,
    });
  }
  return data as T;
}

export interface HealthCapabilities {
  ok: boolean;
  geminiConfigured: boolean;
  ffmpegReady: boolean;
  maxUploadBytes?: number;
  sttProvider?: string;
  blobStorageConfigured?: boolean;
  directMultipartSupported?: boolean;
  chunkSizeBytes?: number;
  remoteWorkerConfigured?: boolean;
  workerMode?: boolean;
}

let cachedHealth: { ts: number; data: HealthCapabilities | null } | null = null;

async function getHealthCapabilities(): Promise<HealthCapabilities | null> {
  if (cachedHealth && Date.now() - cachedHealth.ts < 20_000) {
    return cachedHealth.data;
  }
  try {
    const data = await requestJson<HealthCapabilities>('/api/health');
    const valid = Boolean(data && typeof data === 'object' && data.ok === true);
    cachedHealth = { ts: Date.now(), data: valid ? data : null };
    return valid ? data : null;
  } catch {
    cachedHealth = { ts: Date.now(), data: null };
    return null;
  }
}

async function isBackendOnline(): Promise<boolean> {
  const health = await getHealthCapabilities();
  return Boolean(health?.ok);
}

async function withStaticFallback<T>(
  remoteCall: () => Promise<T>,
  fallbackCall: () => Promise<T> | T,
  forceFallback = false,
): Promise<T> {
  if (forceFallback) {
    return await fallbackCall();
  }
  try {
    return await remoteCall();
  } catch (err) {
    if (err instanceof ApiError && err.isJsonError) {
      throw err;
    }
    const online = await isBackendOnline();
    if (!online) {
      return await fallbackCall();
    }
    throw err;
  }
}

function isLocalFallbackId(id?: string | null): boolean {
  return Boolean(id && (id.startsWith('proj-local-') || id.startsWith('exp-local-')));
}

export const api = {
  health: () =>
    withStaticFallback(
      () => requestJson<HealthCapabilities>('/api/health'),
      () => ({ ok: true, geminiConfigured: false, ffmpegReady: false }),
    ),

  listLanguages: () =>
    withStaticFallback(
      () => requestJson<{ languages: LanguageOption[] }>('/api/languages'),
      () => fallbackListLanguages(),
    ),

  me: () =>
    withStaticFallback(
      async () => { const identity=await requestJson<{user:UserProfile|null}>('/api/auth/me'); confirmedGuest=!identity.user; return identity; },
      () => ({ user: null }),
    ),

  signup: async (email: string, password: string, name: string) => {
    const res = await requestJson<{ token: string; user: UserProfile }>('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
    setAuthToken(res.token);
    return res.user;
  },

  login: async (email: string, password: string) => {
    const res = await requestJson<{ token: string; user: UserProfile }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setAuthToken(res.token);
    return res.user;
  },

  logout: async () => {
    await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setAuthToken(null);
  },

  listDemos: () =>
    withStaticFallback(
      async () => {
        const res = await requestJson<{ demos: DemoCatalogItem[] }>('/api/demos');
        if (!Array.isArray(res?.demos) || res.demos.length === 0) {
          return fallbackListDemos();
        }
        return res;
      },
      () => fallbackListDemos(),
    ),

  listProjects: () =>
    withStaticFallback(
      async () => {
        const remote = await requestJson<{ projects: HydratedProject[] }>('/api/projects');
        const local = fallbackListProjects().projects;
        if (local.length === 0) return remote;
        const remoteIds = new Set(remote.projects.map((p) => p.id));
        return {
          projects: [...local.filter((p) => !remoteIds.has(p.id)), ...remote.projects],
        };
      },
      () => fallbackListProjects(),
    ),

  getProject: (id: string) =>
    withStaticFallback(
      () => requestJson<{ project: HydratedProject }>(`/api/projects/${id}`),
      () => fallbackGetProject(id),
      isLocalFallbackId(id),
    ),

  createProjectFromDemo: (demoId: string, title?: string) =>
    withStaticFallback(
      () =>
        requestJson<{ project: HydratedProject }>('/api/projects/from-demo', {
          method: 'POST',
          body: JSON.stringify({ demoId, title }),
        }),
      () => fallbackCreateProjectFromDemo(demoId, title),
    ),

  updateProject: (
    id: string,
    payload: {
      title?: string;
      state?: ProjectState;
      history?: HistoryEntry[];
      historyIndex?: number;
      versions?: EditVersion[];
    },
  ) =>
    withStaticFallback(
      () =>
        requestJson<{ project: HydratedProject }>(`/api/projects/${id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        }),
      () => fallbackUpdateProject(id, payload),
      isLocalFallbackId(id),
    ),

  duplicateProject: (id: string) =>
    withStaticFallback(
      () =>
        requestJson<{ project: HydratedProject }>(`/api/projects/${id}/duplicate`, {
          method: 'POST',
        }),
      () => fallbackDuplicateProject(id),
      isLocalFallbackId(id),
    ),

  deleteProject: (id: string) =>
    withStaticFallback(
      () => requestJson<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),
      () => fallbackDeleteProject(id),
      isLocalFallbackId(id),
    ),

  ingestMediaWithProgress: async (
    file: File | Blob,
    filename: string,
    sourceType: 'upload' | 'recording',
    title: string,
    onProgress: (pct: number) => void,
    options?: { languageOverride?: string; vocabulary?: string[] },
  ): Promise<HydratedProject> => {
    const caps = await getHealthCapabilities();
    if (!caps?.ok) {
      if (discoverWorker) throw new Error('The transcription backend is unavailable. Please retry the upload.');
      return fallbackIngestLocalMedia(file, filename, sourceType, title, onProgress);
    }

    const blocks:Uint8Array[]=[];
    const blockSize=4*1024*1024;
    for (let start=0;start<file.size;start+=blockSize) {
      const bytes=await file.slice(start,start+blockSize).arrayBuffer();
      blocks.push(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)));
    }
    const hashes=new Uint8Array(blocks.length*32);
    blocks.forEach((b,i)=>hashes.set(b,i*32));
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',hashes));
    const fingerprint=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
    const reused=await requestJson<{project:HydratedProject|null}>('/api/media/reuse',{method:'POST',body:JSON.stringify({fingerprint,title,...options})});
    if (reused.project) {onProgress(100);return reused.project;}

    // Strategy 1: Direct client-to-Vercel-Blob multipart upload (supports up to 2 GB cleanly on Vercel)
    if (caps?.blobStorageConfigured) {
      try {
        const cleanName = filename.replace(/[^a-zA-Z0-9._-]/g, '_') || 'video.mp4';
        const blob = await uploadToVercelBlob(`uploads/${Date.now()}-${cleanName}`, file, {
          access: 'public',
          handleUploadUrl: apiUrl('/api/blob/upload-token'),
          multipart: true,
          headers: buildHeaders(),
          onUploadProgress: (evt) => {
            onProgress(Math.round(evt.percentage));
          },
        });
        onProgress(100);
        const res = await requestJson<{ project: HydratedProject }>('/api/media/ingest-blob', {
          method: 'POST',
          body: JSON.stringify({
            blobUrl: blob.url,
            blobPathname: blob.pathname,
            filename,
            mimeType: file.type || 'video/mp4',
            sourceType,
            title,
            languageOverride:
              options?.languageOverride && options.languageOverride !== 'auto'
                ? options.languageOverride
                : undefined,
            vocabulary: options?.vocabulary,
          }),
        });
        onProgress(100);
        return res.project;
      } catch (blobErr) {
        throw blobErr;
      }
    }

    // Strategy 2: Streamed 8 MB chunked multipart upload for large files (> 16 MB) with 3x retry per chunk
    if (caps?.directMultipartSupported && file.size > 16 * 1024 * 1024) {
      const init = await requestJson<{
        uploadId: string;
        chunkSizeBytes: number;
        totalParts: number;
      }>('/api/uploads/multipart/init', {
        method: 'POST',
        body: JSON.stringify({
          filename,
          mimeType: file.type || 'video/mp4',
          sizeBytes: file.size,
          sourceType,
          title,
          languageOverride:
            options?.languageOverride && options.languageOverride !== 'auto'
              ? options.languageOverride
              : undefined,
          vocabulary: options?.vocabulary,
        }),
      });

      try {
        const bytes=Array(init.totalParts).fill(0) as number[];
        let cursor=0;
        const uploadParts=async()=>{
          while(cursor<init.totalParts) {
            const index=cursor++;
            const part=file.slice(index*init.chunkSizeBytes,(index+1)*init.chunkSizeBytes);
            const progress=(loaded:number)=>{
              bytes[index]=loaded;
              onProgress(Math.floor(bytes.reduce((a,b)=>a+b,0)*100/file.size));
            };
            for (let attempt=1;;attempt++) {
              try {
                await new Promise<void>((resolve,reject)=>{
                  const xhr=new XMLHttpRequest();
                  xhr.open('PUT',apiUrl(`/api/uploads/multipart/${init.uploadId}/part/${index}`));
                  xhr.withCredentials=true;
                  Object.entries(buildHeaders({'Content-Type':'application/octet-stream'})).forEach(([k,v])=>xhr.setRequestHeader(k,v));
                  xhr.upload.onprogress=e=>progress(e.loaded);
                  xhr.onerror=()=>reject(new Error('Network error sending video part '+(index+1)));
                  xhr.onload=()=>xhr.status>=200 && xhr.status<300 ? resolve():reject(new Error('Upload part '+(index+1)+' failed ('+xhr.status+').'));
                  xhr.send(part);
                });
                progress(part.size);
                break;
              } catch(e) {
                progress(0);
                if (attempt>=3) throw e;
                await new Promise(r=>setTimeout(r,400*attempt));
              }
            }
          }
        };
        const parts=await Promise.allSettled(Array.from({length:Math.min(3,init.totalParts)},uploadParts));
        for (const result of parts) if(result.status==='rejected') throw result.reason;
        const completed = await requestJson<{ project: HydratedProject }>(
          `/api/uploads/multipart/${init.uploadId}/complete`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        onProgress(100);
        return completed.project;
      } catch (err) {
        await fetch(apiUrl(`/api/uploads/multipart/${init.uploadId}`), {
          method: 'DELETE',
          credentials: 'include',
          headers: buildHeaders(),
        }).catch(() => {});
        throw err;
      }
    }

    // Strategy 3: Direct single-POST multipart upload with XHR upload progress
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl('/api/media/ingest'));
      xhr.withCredentials = true;
      const headers = buildHeaders();
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.floor((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.project) {
            onProgress(100);
            resolve(data.project as HydratedProject);
          } else {
            reject(new Error(data.error || `Upload failed (${xhr.status})`));
          }
        } catch {
          reject(new Error('Invalid server response during media analysis.'));
        }
      };

      xhr.onerror = () => reject(new Error('Network error while uploading video.'));

      const form = new FormData();
      form.append('video', file, filename);
      form.append('sourceType', sourceType);
      form.append('title', title);
      if (options?.languageOverride && options.languageOverride !== 'auto') {
        form.append('languageOverride', options.languageOverride);
      }
      if (options?.vocabulary && options.vocabulary.length > 0) {
        form.append('vocabulary', JSON.stringify(options.vocabulary));
      }
      xhr.send(form);
    });
  },

  importMediaFromUrl: async (payload: {
    url: string;
    title?: string;
    languageOverride?: string;
    vocabulary?: string[];
  }) => {
    try {
      return await requestJson<{ importJob: UrlImportJob; project: HydratedProject | null }>(
        '/api/media/import-url',
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      if (err instanceof ApiError && err.isJsonError) throw err;
      const online = await isBackendOnline();
      if (!online) {
        throw new Error(
          'Remote URL download requires the Node/FFmpeg backend server (set VITE_API_BASE_URL or upload a local video file instead).',
        );
      }
      throw err;
    }
  },

  getUrlImportStatus: (importId: string) =>
    requestJson<{ importJob: UrlImportJob; project: HydratedProject | null }>(
      `/api/url-imports/${importId}`,
    ),

  getAudioSnippetUrl: (mediaId: string, start: number, end: number, stream?: number) => {
    const params = new URLSearchParams({
      start: String(Math.max(0, Number(start.toFixed(3)))),
      end: String(Math.max(start + 0.2, Number(end.toFixed(3)))),
    });
    if (stream !== undefined) params.set('stream', String(stream));
    return apiUrl(`/api/media/${mediaId}/audio-snippet?${params.toString()}`);
  },

  updateVocabulary: (projectId: string, vocabulary: string[]) =>
    withStaticFallback(
      () =>
        requestJson<{ vocabulary: string[]; project: HydratedProject }>(
          `/api/projects/${projectId}/vocabulary`,
          {
            method: 'PUT',
            body: JSON.stringify({ vocabulary }),
          },
        ),
      () => fallbackUpdateVocabulary(projectId, vocabulary),
      isLocalFallbackId(projectId),
    ),

  correctTranscriptWord: (projectId: string, wordId: string, newWord: string) =>
    withStaticFallback(
      () =>
        requestJson<{ project: HydratedProject; analysis: MediaAnalysis; updatedWord: TranscriptWord }>(
          `/api/projects/${projectId}/transcript/word`,
          {
            method: 'PATCH',
            body: JSON.stringify({ wordId, newWord }),
          },
        ),
      () => fallbackCorrectTranscriptWord(projectId, wordId, newWord),
      isLocalFallbackId(projectId),
    ),

  retranscribeProject: (
    projectId: string,
    payload: { languageOverride?: string; vocabulary?: string[]; audioStreamIndex?: number },
  ) =>
    withStaticFallback(
      () =>
        requestJson<{ job: AnalysisJob; analysis: MediaAnalysis; project: HydratedProject }>(
          `/api/projects/${projectId}/retranscribe`,
          {
            method: 'POST',
            body: JSON.stringify(payload),
          },
        ),
      () => {
        const { project } = fallbackGetProject(projectId);
        const analysis = project.media?.analysis;
        if (!analysis) {
          throw new Error('Server speech engine unavailable for re-transcription.');
        }
        const now = new Date().toISOString();
        const job: AnalysisJob = {
          id: `job-local-${Date.now()}`,
          mediaId: project.mediaId,
          projectId,
          selectedAudioStream: analysis.selectedAudioStream ?? 0,
          status: 'complete',
          overallProgress: 100,
          audioExtractionStatus: 'completed',
          transcriptionStatus: 'completed',
          chunkTotal: 1,
          chunkCompleted: 1,
          chunkFailed: 0,
          alignmentStatus: 'completed',
          captionStatus: 'completed',
          detectedLanguage: analysis.detectedLanguage || 'en',
          createdAt: now,
          updatedAt: now,
        };
        return {
          job,
          analysis,
          project,
        };
      },
      isLocalFallbackId(projectId),
    ),

  translateProject: (projectId: string, targetLanguage: string) =>
    withStaticFallback(
      () =>
        requestJson<{ track: TranslationTrack; analysis: MediaAnalysis }>(
          `/api/projects/${projectId}/translate`,
          {
            method: 'POST',
            body: JSON.stringify({ targetLanguage }),
          },
        ),
      () => fallbackTranslateProject(projectId, targetLanguage),
      isLocalFallbackId(projectId),
    ),

  createEditingSession: (projectId: string, key: string) =>
    requestJson<{session_id:string;timeline_hash:string}>(`/api/v1/projects/${encodeURIComponent(projectId)}/sessions`, {
      method:'POST', headers:{'Idempotency-Key':key}, body:'{}',
    }),
  sessionStep: (id: string, say: string, expectedHash: string, key: string) =>
    requestJson<{status:'applied'|'needs_clarification'|'rejected';summary:string;question:string|null;options:string[];timeline_hash:string;warnings?:string[]}>(`/api/v1/sessions/${encodeURIComponent(id)}/steps`, {
      method:'POST', headers:{'Idempotency-Key':key}, body:JSON.stringify({say,expected_hash:expectedHash}),
    }),
  editingSession: (id: string) =>
    requestJson<{timeline:ProjectState;timeline_hash:string}>(`/api/v1/sessions/${encodeURIComponent(id)}`),
  planAiEdit: (projectId: string, prompt: string, currentState: ProjectState, history: Array<{role:string;text:string;status?:string;ranges?:number[][]}> = []) =>
    isLocalFallbackId(projectId)
      ? Promise.reject(new Error('Open a server-backed project to use the editing assistant.'))
      : requestJson<{
          plan: EditPlan;
          impact: EditImpactReport;
          searchHits: SearchHit[];
          stagesExecuted?: string[];
        }>('/api/ai/plan', {
          method: 'POST',
          body: JSON.stringify({ projectId, prompt, currentState: {...currentState,captions:undefined}, history }),
        }),

  reanalyzeMedia: (mediaId: string, projectId?: string) =>
    requestJson<{ job: AnalysisJob; analysis: MediaAnalysis; project: HydratedProject | null }>(
      `/api/media/${mediaId}/reanalyze`,
      {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      },
    ),

  selectAudioStream: (mediaId: string, audioStreamIndex: number, projectId?: string) =>
    requestJson<{ job: AnalysisJob; analysis: MediaAnalysis; project: HydratedProject | null }>(
      `/api/media/${mediaId}/select-audio-stream`,
      {
        method: 'POST',
        body: JSON.stringify({ audioStreamIndex, projectId }),
      },
    ),

  getProjectAnalysisStatus: (projectId: string) =>
    withStaticFallback(
      () =>
        requestJson<{ job: AnalysisJob | null; analysis: MediaAnalysis | null; project: HydratedProject }>(
          `/api/projects/${projectId}/analysis-status`,
        ),
      () => {
        const { project } = fallbackGetProject(projectId);
        return { job: null, analysis: project.media?.analysis ?? null, project };
      },
      isLocalFallbackId(projectId),
    ),

  retryFailedAnalysisChunks: (jobId: string) =>
    requestJson<{ job: AnalysisJob }>(`/api/analysis-jobs/${jobId}/retry-failed`, {
      method: 'POST',
    }),

  retryAnalysisJob: (jobId: string) =>
    requestJson<{ job: AnalysisJob }>(`/api/analysis-jobs/${jobId}/retry`, {
      method: 'POST',
    }),

  cancelAnalysisJob: (jobId: string) =>
    requestJson<{ ok: boolean; job: AnalysisJob }>(`/api/analysis-jobs/${jobId}/cancel`, {
      method: 'POST',
    }),

  uploadProjectMusic: async (
    projectId: string,
    file: File,
  ): Promise<{ url: string; filename: string; durationSec: number }> =>
    withStaticFallback(
      async () => {
        const form = new FormData();
        form.append('audio', file, file.name);
        return requestJson<{ url: string; filename: string; durationSec: number }>(
          `/api/projects/${projectId}/music`,
          {
            method: 'POST',
            body: form,
          },
        );
      },
      () => fallbackUploadMusic(file),
      isLocalFallbackId(projectId),
    ),

  searchProject: (projectId: string, query: string, state: ProjectState) =>
    withStaticFallback(
      () =>
        requestJson<{ hits: SearchHit[] }>(`/api/projects/${projectId}/search`, {
          method: 'POST',
          body: JSON.stringify({ query, state }),
        }),
      () => fallbackSearchProject(projectId, query, state),
      isLocalFallbackId(projectId),
    ),

  regenerateVersions: (projectId: string) =>
    withStaticFallback(
      () =>
        requestJson<{ versions: EditVersion[] }>(`/api/projects/${projectId}/versions`, {
          method: 'POST',
        }),
      () => fallbackRegenerateVersions(projectId),
      isLocalFallbackId(projectId),
    ),

  startExport: (
    projectId: string,
    state: ProjectState,
    resolution: ExportJob['resolution'],
    quality: ExportJob['quality'],
  ) =>
    withStaticFallback(
      () =>
        requestJson<{ job: ExportJob }>('/api/exports', {
          method: 'POST',
          body: JSON.stringify({ projectId, state, resolution, quality }),
        }),
      () => fallbackStartExport(projectId, state, resolution, quality),
      isLocalFallbackId(projectId),
    ),

  getExportStatus: (jobId: string) =>
    withStaticFallback(
      () => requestJson<{ job: ExportJob }>(`/api/exports/${jobId}`),
      () => fallbackGetExportStatus(jobId),
      isLocalFallbackId(jobId),
    ),
};
