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

export const API_BASE_URL = (
  (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL || ''
).replace(/\/$/, '');

export function apiUrl(urlPath: string): string {
  if (!urlPath) return urlPath;
  if (/^(https?:|blob:|data:)/i.test(urlPath)) return urlPath;
  const normalizedPath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  if (!API_BASE_URL) return normalizedPath;
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

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...init,
    credentials: 'include',
    headers: buildHeaders({
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }),
  });
  const rawText = await res.text();
  let data: unknown = {};
  let parsedOk = true;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      parsedOk = false;
    }
  }
  if (!res.ok) {
    const errObj = parsedOk && data && typeof data === 'object' ? (data as { error?: string | { message?: string } }).error : undefined;
    const msg = typeof errObj === 'string' ? errObj : errObj?.message;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  if (!parsedOk) {
    throw new Error(`Unexpected non-JSON response from ${url}`);
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

let cachedHealth: { ts: number; data: HealthCapabilities } | null = null;

async function getHealthCapabilities(): Promise<HealthCapabilities | null> {
  if (cachedHealth && Date.now() - cachedHealth.ts < 30_000) {
    return cachedHealth.data;
  }
  try {
    const data = await requestJson<HealthCapabilities>('/api/health');
    cachedHealth = { ts: Date.now(), data };
    return data;
  } catch {
    return null;
  }
}

export const api = {
  health: () => requestJson<HealthCapabilities>('/api/health'),

  listLanguages: () => requestJson<{ languages: LanguageOption[] }>('/api/languages'),

  me: () => requestJson<{ user: UserProfile | null }>('/api/auth/me'),

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

  listDemos: () => requestJson<{ demos: DemoCatalogItem[] }>('/api/demos'),

  listProjects: () => requestJson<{ projects: HydratedProject[] }>('/api/projects'),

  getProject: (id: string) => requestJson<{ project: HydratedProject }>(`/api/projects/${id}`),

  createProjectFromDemo: (demoId: string, title?: string) =>
    requestJson<{ project: HydratedProject }>('/api/projects/from-demo', {
      method: 'POST',
      body: JSON.stringify({ demoId, title }),
    }),

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
    requestJson<{ project: HydratedProject }>(`/api/projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  duplicateProject: (id: string) =>
    requestJson<{ project: HydratedProject }>(`/api/projects/${id}/duplicate`, {
      method: 'POST',
    }),

  deleteProject: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  ingestMediaWithProgress: async (
    file: File | Blob,
    filename: string,
    sourceType: 'upload' | 'recording',
    title: string,
    onProgress: (pct: number) => void,
    options?: { languageOverride?: string; vocabulary?: string[] },
  ): Promise<HydratedProject> => {
    const caps = await getHealthCapabilities();

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
            onProgress(Math.min(78, Math.max(2, Math.round(evt.percentage * 0.78))));
          },
        });
        onProgress(82);
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
        console.warn('Direct Blob multipart fallback to chunked/server ingest:', blobErr);
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
        let uploadedBytes = 0;
        for (let partIndex = 0; partIndex < init.totalParts; partIndex++) {
          const start = partIndex * init.chunkSizeBytes;
          const end = Math.min(file.size, start + init.chunkSizeBytes);
          const slice = file.slice(start, end);

          let attempt = 0;
          let sent = false;
          let lastErr: unknown;
          while (attempt < 3 && !sent) {
            attempt++;
            try {
              const partRes = await fetch(
                apiUrl(`/api/uploads/multipart/${init.uploadId}/part/${partIndex}`),
                {
                  method: 'PUT',
                  credentials: 'include',
                  headers: buildHeaders({ 'Content-Type': 'application/octet-stream' }),
                  body: slice,
                },
              );
              if (!partRes.ok) {
                const errJson = await partRes.json().catch(() => ({}));
                throw new Error(
                  (errJson as { error?: string }).error || `Chunk ${partIndex + 1} failed (${partRes.status})`,
                );
              }
              sent = true;
            } catch (err) {
              lastErr = err;
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 400 * attempt));
              }
            }
          }
          if (!sent) {
            throw lastErr instanceof Error ? lastErr : new Error('Multipart chunk upload failed.');
          }
          uploadedBytes += end - start;
          onProgress(Math.min(80, Math.max(2, Math.round((uploadedBytes / file.size) * 80))));
        }

        onProgress(86);
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
          onProgress(Math.min(75, Math.round((e.loaded / e.total) * 75)));
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

  importMediaFromUrl: (payload: {
    url: string;
    title?: string;
    languageOverride?: string;
    vocabulary?: string[];
  }) =>
    requestJson<{ importJob: UrlImportJob; project: HydratedProject | null }>('/api/media/import-url', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

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
    requestJson<{ vocabulary: string[]; project: HydratedProject }>(
      `/api/projects/${projectId}/vocabulary`,
      {
        method: 'PUT',
        body: JSON.stringify({ vocabulary }),
      },
    ),

  correctTranscriptWord: (projectId: string, wordId: string, newWord: string) =>
    requestJson<{ project: HydratedProject; analysis: MediaAnalysis; updatedWord: TranscriptWord }>(
      `/api/projects/${projectId}/transcript/word`,
      {
        method: 'PATCH',
        body: JSON.stringify({ wordId, newWord }),
      },
    ),

  retranscribeProject: (
    projectId: string,
    payload: { languageOverride?: string; vocabulary?: string[]; audioStreamIndex?: number },
  ) =>
    requestJson<{ job: AnalysisJob; analysis: MediaAnalysis; project: HydratedProject }>(
      `/api/projects/${projectId}/retranscribe`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),

  translateProject: (projectId: string, targetLanguage: string) =>
    requestJson<{ track: TranslationTrack; analysis: MediaAnalysis }>(
      `/api/projects/${projectId}/translate`,
      {
        method: 'POST',
        body: JSON.stringify({ targetLanguage }),
      },
    ),

  planAiEdit: (projectId: string, prompt: string, currentState: ProjectState) =>
    requestJson<{
      plan: EditPlan;
      impact: EditImpactReport;
      searchHits: SearchHit[];
      stagesExecuted?: string[];
    }>(
      '/api/ai/plan',
      {
        method: 'POST',
        body: JSON.stringify({ projectId, prompt, currentState }),
      },
    ),

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
    requestJson<{ job: AnalysisJob | null; analysis: MediaAnalysis | null; project: HydratedProject }>(
      `/api/projects/${projectId}/analysis-status`,
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
  ): Promise<{ url: string; filename: string; durationSec: number }> => {
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

  searchProject: (projectId: string, query: string, state: ProjectState) =>
    requestJson<{ hits: SearchHit[] }>(`/api/projects/${projectId}/search`, {
      method: 'POST',
      body: JSON.stringify({ query, state }),
    }),

  regenerateVersions: (projectId: string) =>
    requestJson<{ versions: EditVersion[] }>(`/api/projects/${projectId}/versions`, {
      method: 'POST',
    }),

  startExport: (
    projectId: string,
    state: ProjectState,
    resolution: ExportJob['resolution'],
    quality: ExportJob['quality'],
  ) =>
    requestJson<{ job: ExportJob }>('/api/exports', {
      method: 'POST',
      body: JSON.stringify({ projectId, state, resolution, quality }),
    }),

  getExportStatus: (jobId: string) => requestJson<{ job: ExportJob }>(`/api/exports/${jobId}`),
};
