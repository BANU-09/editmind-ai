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
  return `${API_BASE_URL}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;
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
const TOKEN_KEY = 'editmind_auth_token';

export function getGuestId(): string {
  let id = localStorage.getItem(GUEST_KEY);
  if (!id) {
    id = `guest-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    localStorage.setItem(GUEST_KEY, id);
  }
  return id;
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'x-guest-id': getGuestId(),
    ...extra,
  };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(apiUrl(url), {
    ...init,
    headers: buildHeaders({
      ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errObj = (data as { error?: string | { message?: string } }).error;
    const msg = typeof errObj === 'string' ? errObj : errObj?.message;
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  health: () =>
    requestJson<{
      ok: boolean;
      geminiConfigured: boolean;
      ffmpegReady: boolean;
      maxUploadBytes?: number;
      sttProvider?: string;
    }>('/api/health'),

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

  ingestMediaWithProgress: (
    file: File | Blob,
    filename: string,
    sourceType: 'upload' | 'recording',
    title: string,
    onProgress: (pct: number) => void,
    options?: { languageOverride?: string; vocabulary?: string[] },
  ): Promise<HydratedProject> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', apiUrl('/api/media/ingest'));
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
