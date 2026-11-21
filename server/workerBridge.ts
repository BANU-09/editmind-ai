import crypto from 'crypto';
import type { MediaAnalysis, ProjectState } from '../src/shared/types';
import { getAppConfig } from './config';

function timingSafeMatch(expected: string, actual: string): boolean {
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(actual).digest();
  return crypto.timingSafeEqual(a, b);
}

export function isRemoteWorkerConfigured(): boolean {
  const cfg = getAppConfig();
  return Boolean(cfg.workerUrl && !cfg.workerMode);
}

export function getWorkerAuthHeaders(): Record<string, string> {
  const cfg = getAppConfig();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.workerSharedSecret) {
    headers.Authorization = `Bearer ${cfg.workerSharedSecret}`;
    headers['x-worker-secret'] = cfg.workerSharedSecret;
  }
  return headers;
}

export function isAuthorizedWorkerRequest(
  authHeader: string | undefined,
  secretHeader: string | undefined,
): boolean {
  const expected = getAppConfig().workerSharedSecret;
  if (!expected) {
    return false;
  }
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const candidate = (secretHeader || bearer || '').trim();
  if (!candidate) return false;
  return timingSafeMatch(expected, candidate);
}

export interface RemoteAnalyzeDispatchPayload {
  jobId: string;
  mediaId: string;
  projectId: string | null;
  sourceBlobUrl: string;
  filename: string;
  audioStreamIndex: number;
  languageOverride?: string;
  vocabulary?: string[];
  callbackUrl?: string;
}

export interface RemoteUrlImportDispatchPayload {
  importId: string;
  url: string;
  title?: string;
  userId: string | null;
  guestToken: string | null;
  languageOverride?: string;
  vocabulary?: string[];
  callbackUrl?: string;
}

export interface RemoteExportDispatchPayload {
  jobId: string;
  projectId: string;
  mediaId: string;
  sourceBlobUrl: string;
  sourceHasAudio: boolean;
  selectedAudioStream: number;
  state: ProjectState;
  resolution: '480p' | '720p' | '1080p';
  quality: 'fast' | 'balanced' | 'high';
  customMusicBlobUrl?: string;
  callbackUrl?: string;
}

async function postToWorker<T>(endpointPath: string, payload: unknown): Promise<T> {
  const cfg = getAppConfig();
  if (!cfg.workerUrl) {
    throw new Error('WORKER_URL is not configured.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${cfg.workerUrl}${endpointPath}`, {
      method: 'POST',
      headers: getWorkerAuthHeaders(),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        (data as { error?: string | { message?: string } }).error;
      const errText = typeof msg === 'string' ? msg : msg?.message || `Worker returned HTTP ${res.status}`;
      throw new Error(errText);
    }
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function dispatchAnalyzeToWorker(payload: RemoteAnalyzeDispatchPayload) {
  return postToWorker<{ accepted: boolean; jobId: string }>('/worker/jobs/analyze', payload);
}

export async function dispatchUrlImportToWorker(payload: RemoteUrlImportDispatchPayload) {
  return postToWorker<{ accepted: boolean; importId: string }>('/worker/jobs/import-url', payload);
}

export async function dispatchExportToWorker(payload: RemoteExportDispatchPayload) {
  return postToWorker<{ accepted: boolean; jobId: string }>('/worker/jobs/export', payload);
}

export async function sendWorkerCallback(
  callbackUrl: string,
  event:
    | {
        type: 'analysis_progress';
        jobId: string;
        mediaId: string;
        projectId: string | null;
        status: string;
        progress: number;
        analysis?: MediaAnalysis;
        thumbnailBlobUrl?: string;
        error?: string;
      }
    | {
        type: 'url_import_progress';
        importId: string;
        status: string;
        progress: number;
        bytesDownloaded?: number;
        totalBytes?: number | null;
        mediaId?: string;
        projectId?: string;
        analysisJobId?: string;
        sourceBlobUrl?: string;
        thumbnailBlobUrl?: string;
        analysis?: MediaAnalysis;
        error?: string;
      }
    | {
        type: 'export_progress';
        jobId: string;
        status: string;
        progress: number;
        outputUrl?: string;
        blobUrl?: string;
        fileSizeBytes?: number;
        durationSec?: number;
        error?: string;
      },
): Promise<void> {
  if (!callbackUrl) return;
  try {
    await fetch(callbackUrl, {
      method: 'POST',
      headers: getWorkerAuthHeaders(),
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.warn('[workerBridge] Callback delivery failed:', err instanceof Error ? err.message : err);
  }
}
