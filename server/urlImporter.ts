import dns from 'dns/promises';
import fs from 'fs';
import net from 'net';
import path from 'path';
import { v4 as uuid } from 'uuid';
import { createInitialProjectState, generateThreeVersions } from '../src/shared/timelineEngine';
import type { HistoryEntry, UrlImportJob } from '../src/shared/types';
import { getAppConfig } from './config';
import { db, UPLOADS_DIR } from './db';
import { prepareFastMediaRecord, startBackgroundAnalysisJob } from './mediaProcessor';

function isPrivateOrBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 192 && b === 0 && parts[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // multicast & reserved
  return false;
}

export function isBlockedIpAddress(rawIp: string): boolean {
  const ip = rawIp.trim().toLowerCase();
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    return isPrivateOrBlockedIpv4(ip);
  }
  if (net.isIPv6(ip)) {
    if (ip === '::' || ip === '::1') return true;
    // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
    if (ip.startsWith('::ffff:')) {
      const v4 = ip.slice(7);
      if (net.isIPv4(v4)) return isPrivateOrBlockedIpv4(v4);
    }
    if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd')) {
      return true; // link-local or ULA
    }
    return false;
  }
  return true;
}

export async function validateSafePublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid video URL format. Please provide a valid http:// or https:// video URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol "${parsed.protocol}". Only http:// and https:// URLs are allowed.`);
  }

  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host === 'metadata.google.internal'
  ) {
    throw new Error(`Blocked restricted host "${host}" for security reasons.`);
  }

  // Optional test bypass strictly for local benchmark loopback fixtures when explicitly enabled in dev/test
  const allowLoopbackForTests =
    process.env.ALLOW_LOCALHOST_URL_IMPORT_FOR_TEST === '1' ||
    process.env.ALLOW_PRIVATE_URL_IMPORTS === '1';

  if (net.isIP(host)) {
    if (!allowLoopbackForTests && isBlockedIpAddress(host)) {
      throw new Error(`Blocked private or loopback IP address "${host}".`);
    }
    return parsed;
  }

  const records = await dns.lookup(host, { all: true }).catch(() => {
    throw new Error(`DNS resolution failed for host "${host}".`);
  });

  if (records.length === 0) {
    throw new Error(`No DNS records found for host "${host}".`);
  }

  for (const rec of records) {
    if (!allowLoopbackForTests && isBlockedIpAddress(rec.address)) {
      throw new Error(`Resolved IP "${rec.address}" for "${host}" is private or restricted (SSRF blocked).`);
    }
  }

  return parsed;
}

export function hydrateUrlImportRow(row: Record<string, unknown>): UrlImportJob {
  return {
    id: row.id as string,
    url: row.url as string,
    status: row.status as UrlImportJob['status'],
    progress: Number(row.progress ?? 0),
    bytesDownloaded: Number(row.bytes_downloaded ?? 0),
    totalBytes: row.total_bytes !== null && row.total_bytes !== undefined ? Number(row.total_bytes) : null,
    mediaId: (row.media_id as string | undefined) || undefined,
    projectId: (row.project_id as string | undefined) || undefined,
    analysisJobId: (row.analysis_job_id as string | undefined) || undefined,
    error: (row.error as string | undefined) || undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function getUrlImportJob(importId: string): UrlImportJob | null {
  const row = db.prepare('SELECT * FROM url_imports WHERE id = ?').get(importId) as
    | Record<string, unknown>
    | undefined;
  return row ? hydrateUrlImportRow(row) : null;
}

function updateUrlImportRow(importId: string, patch: Partial<UrlImportJob>) {
  const cur = db.prepare('SELECT * FROM url_imports WHERE id = ?').get(importId) as
    | Record<string, unknown>
    | undefined;
  if (!cur) return;
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE url_imports SET
      status = ?,
      progress = ?,
      bytes_downloaded = ?,
      total_bytes = ?,
      media_id = ?,
      project_id = ?,
      analysis_job_id = ?,
      error = ?,
      updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.status ?? cur.status,
    patch.progress ?? cur.progress,
    patch.bytesDownloaded ?? cur.bytes_downloaded,
    patch.totalBytes !== undefined ? patch.totalBytes : cur.total_bytes,
    patch.mediaId !== undefined ? patch.mediaId : cur.media_id,
    patch.projectId !== undefined ? patch.projectId : cur.project_id,
    patch.analysisJobId !== undefined ? patch.analysisJobId : cur.analysis_job_id,
    patch.error !== undefined ? patch.error : cur.error,
    now,
    importId,
  );
}

function inferExtension(urlObj: URL, contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('webm')) return '.webm';
  if (ct.includes('quicktime')) return '.mov';
  if (ct.includes('x-matroska')) return '.mkv';
  if (ct.includes('mp4')) return '.mp4';
  const ext = path.extname(urlObj.pathname).toLowerCase();
  if (['.mp4', '.webm', '.mov', '.mkv', '.ogv', '.m4v'].includes(ext)) return ext;
  return '.mp4';
}

export function startUrlImportJob(params: {
  url: string;
  title?: string;
  userId: string | null;
  guestToken: string | null;
  languageOverride?: string;
  vocabulary?: string[];
}): { importJob: UrlImportJob; promise: Promise<UrlImportJob> } {
  const cfg = getAppConfig();
  const importId = `impurl-${uuid()}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO url_imports
     (id, url, user_id, guest_token, title, status, progress, bytes_downloaded, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 2, 0, ?, ?)`,
  ).run(importId, params.url.trim(), params.userId, params.guestToken, params.title || null, now, now);

  const run = async (): Promise<UrlImportJob> => {
    let destPath = '';
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), cfg.urlImportTimeoutMs);

    try {
      updateUrlImportRow(importId, { status: 'validating', progress: 5 });

      let currentUrl = await validateSafePublicHttpUrl(params.url);
      let response: globalThis.Response | null = null;

      for (let hop = 0; hop <= cfg.urlImportMaxRedirects; hop++) {
        const res = await fetch(currentUrl.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'EDITMIND-AI-Importer/1.0',
          },
        });

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) {
            throw new Error(`Remote server returned redirect ${res.status} without Location header.`);
          }
          const nextResolved = new URL(loc, currentUrl);
          currentUrl = await validateSafePublicHttpUrl(nextResolved.toString());
          if (hop === cfg.urlImportMaxRedirects) {
            throw new Error(`Too many redirects (max ${cfg.urlImportMaxRedirects}) while fetching video URL.`);
          }
          continue;
        }

        response = res;
        break;
      }

      if (!response || !response.ok) {
        const code = response ? response.status : 0;
        throw new Error(`Remote server returned HTTP ${code} while fetching video URL.`);
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('text/plain')) {
        throw new Error(
          `URL returned "${contentType}" instead of a downloadable video stream. Provide a direct MP4/WebM/MOV/MKV video file URL.`,
        );
      }

      const clHeader = response.headers.get('content-length');
      const totalBytes = clHeader ? parseInt(clHeader, 10) : null;
      if (totalBytes !== null && Number.isFinite(totalBytes) && totalBytes > cfg.maxUploadBytes) {
        throw new Error(
          `Remote video (${(totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB) exceeds the strict 2 GB import limit.`,
        );
      }

      if (!response.body) {
        throw new Error('Remote response had an empty body.');
      }

      const ext = inferExtension(currentUrl, contentType);
      const originalFilename =
        path.basename(currentUrl.pathname) && path.extname(currentUrl.pathname)
          ? path.basename(currentUrl.pathname)
          : `imported-video${ext}`;
      destPath = path.join(UPLOADS_DIR, `${uuid()}${ext}`);

      updateUrlImportRow(importId, {
        status: 'downloading',
        progress: 12,
        totalBytes: totalBytes && Number.isFinite(totalBytes) ? totalBytes : null,
      });

      const writeStream = fs.createWriteStream(destPath);
      const reader = response.body.getReader();
      let downloaded = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          downloaded += value.byteLength;
          if (downloaded > cfg.maxUploadBytes) {
            reader.cancel('Exceeded 2 GB max upload limit').catch(() => {});
            throw new Error('Remote video stream exceeded the strict 2 GB maximum size limit.');
          }

          if (!writeStream.write(value)) {
            await new Promise<void>((resolve, reject) => {
              writeStream.once('drain', resolve);
              writeStream.once('error', reject);
            });
          }

          if (totalBytes && totalBytes > 0) {
            const pct = Math.min(78, 12 + Math.round((downloaded / totalBytes) * 66));
            updateUrlImportRow(importId, { progress: pct, bytesDownloaded: downloaded });
          } else {
            updateUrlImportRow(importId, { bytesDownloaded: downloaded });
          }
        }
      } finally {
        await new Promise<void>((resolve) => writeStream.end(() => resolve()));
      }

      if (downloaded < 256) {
        throw new Error('Downloaded file is too small or empty to be a valid video.');
      }

      updateUrlImportRow(importId, { status: 'probing', progress: 84, bytesDownloaded: downloaded });

      const mediaId = `med-${uuid()}`;
      const mimeType = contentType.startsWith('video/')
        ? contentType.split(';')[0]
        : ext === '.webm'
          ? 'video/webm'
          : ext === '.mov'
            ? 'video/quicktime'
            : ext === '.mkv'
              ? 'video/x-matroska'
              : 'video/mp4';

      const { analysis, thumbnailUrl } = await prepareFastMediaRecord({
        mediaId,
        filePath: destPath,
        filename: originalFilename,
      });

      if (params.vocabulary && params.vocabulary.length > 0) {
        analysis.vocabulary = params.vocabulary;
      }
      if (params.languageOverride) {
        analysis.selectedLanguageOverride = params.languageOverride;
      }

      const vocabJson = JSON.stringify(params.vocabulary || []);
      const createdAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO media_assets
         (id, user_id, guest_token, source_type, source_url, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, vocabulary_json, created_at)
         VALUES (?, ?, ?, 'url', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mediaId,
        params.userId,
        params.guestToken,
        params.url.trim(),
        originalFilename,
        mimeType,
        destPath,
        thumbnailUrl || '/api/demos/demo-keynote/thumb',
        analysis.durationSec,
        analysis.width,
        analysis.height,
        analysis.hasAudio ? 1 : 0,
        analysis.analysisMode,
        JSON.stringify(analysis),
        vocabJson,
        createdAt,
      );

      const projectId = `prj-${uuid()}`;
      const projectTitle =
        (params.title || '').trim() || path.parse(originalFilename).name || 'Imported Video';
      const initialState = createInitialProjectState(analysis);
      const versions = generateThreeVersions(analysis);
      const initialHistory: HistoryEntry[] = [
        {
          id: uuid(),
          timestamp: createdAt,
          label: 'Project Created from URL',
          durationAfter: initialState.duration,
          stateSnapshot: initialState,
        },
      ];

      db.prepare(
        `INSERT INTO projects
         (id, user_id, guest_token, title, media_id, thumbnail_url, state_json, history_json, history_index, versions_json, vocabulary_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        projectId,
        params.userId,
        params.guestToken,
        projectTitle,
        mediaId,
        thumbnailUrl,
        JSON.stringify(initialState),
        JSON.stringify(initialHistory),
        JSON.stringify(versions),
        vocabJson,
        createdAt,
        createdAt,
      );

      const { job: analysisJob } = startBackgroundAnalysisJob({
        mediaId,
        projectId,
        audioStreamIndex: 0,
        languageOverride: params.languageOverride,
        vocabulary: params.vocabulary,
      });

      updateUrlImportRow(importId, {
        status: 'completed',
        progress: 100,
        mediaId,
        projectId,
        analysisJobId: analysisJob.id,
      });

      return getUrlImportJob(importId)!;
    } catch (err) {
      if (destPath && fs.existsSync(destPath)) {
        fs.rmSync(destPath, { force: true });
      }
      const msg =
        err instanceof Error
          ? err.name === 'AbortError'
            ? `URL download timed out after ${Math.round(cfg.urlImportTimeoutMs / 1000)}s.`
            : err.message
          : 'Failed to import video from URL.';

      updateUrlImportRow(importId, {
        status: 'failed',
        error: msg.slice(0, 400),
      });
      throw new Error(msg);
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  const promise = run();
  return {
    importJob: getUrlImportJob(importId)!,
    promise,
  };
}
