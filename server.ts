import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { v4 as uuid } from 'uuid';
import {
  computeEditImpact,
  createInitialProjectState,
  generateThreeVersions,
  searchMediaIndex,
} from './src/shared/timelineEngine';
import type {
  ExportJob,
  HistoryEntry,
  MediaAnalysis,
  ProjectRecord,
  ProjectState,
} from './src/shared/types';
import { type HandleUploadBody } from '@vercel/blob/client';
import { planEditFromPrompt } from './server/aiEditor';
import {
  downloadBlobToFile,
  handleBlobClientUpload,
  isVercelBlobConfigured,
  uploadFileToBlob,
} from './server/blobStorage';
import { getAppConfig, STRICT_MAX_UPLOAD_BYTES, SUPPORTED_LANGUAGES } from './server/config';
import { db, DEMOS_DIR, EXPORTS_DIR, MUSIC_DIR, TEMP_DIR, THUMBS_DIR, UPLOADS_DIR } from './server/db';
import { ensureDemoLibraryReady, getDemoCatalogMeta } from './server/demoGenerator';
import { runExportJob } from './server/exporter';
import { hasGeminiKey } from './server/geminiClient';
import {
  executeAnalysisJob,
  prepareFastMediaRecord,
  probeVideoFile,
  resumeIncompleteAnalysisJobs,
  retryFailedJobChunks,
  startBackgroundAnalysisJob,
} from './server/mediaProcessor';
import {
  applyManualWordCorrection,
  buildSrtSubtitles,
  buildVttSubtitles,
  extractAudioSnippetWav,
  getAnalysisJob,
  getLatestAnalysisJobForMedia,
  requestCancelAnalysisJob,
  translateProjectTranscript,
  updateAnalysisJobRow,
} from './server/transcriber';
import { getUrlImportJob, startUrlImportJob } from './server/urlImporter';
import {
  dispatchAnalyzeToWorker,
  dispatchExportToWorker,
  dispatchUrlImportToWorker,
  isAuthorizedWorkerRequest,
  isRemoteWorkerConfigured,
  sendWorkerCallback,
} from './server/workerBridge';

dotenv.config();

const cfg = getAppConfig();
const PORT = cfg.port || 3000;

function parseVocabularyInput(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((x) => String(x).trim()).filter(Boolean))).slice(0, 200);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return Array.from(new Set(parsed.map((x) => String(x).trim()).filter(Boolean))).slice(0, 200);
        }
      } catch {
        // Fallback to delimiter split
      }
    }
    return Array.from(
      new Set(
        trimmed
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ).slice(0, 200);
  }
  return [];
}

function sendV1Error(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable = false,
  details?: unknown,
) {
  res.status(status).json({
    error: {
      code,
      message,
      retryable,
      ...(details !== undefined ? { details } : {}),
    },
  });
}

function resolveConfinedPath(baseDir: string, untrustedName: string): string | null {
  const safeBase = path.resolve(baseDir);
  const cleanName = path.basename(String(untrustedName || '').trim());
  if (!cleanName || cleanName === '.' || cleanName === '..') return null;
  const target = path.resolve(safeBase, cleanName);
  if (!target.startsWith(safeBase + path.sep)) return null;
  return target;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) result[key] = val;
  }
  return result;
}

function setSessionCookie(res: Response, token: string, maxAgeSec: number) {
  res.setHeader(
    'Set-Cookie',
    `editmind_session=${encodeURIComponent(token)}; Max-Age=${maxAgeSec}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`,
  );
}

function clearSessionCookie(res: Response) {
  res.setHeader(
    'Set-Cookie',
    'editmind_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
  );
}

function streamMediaWithRanges(req: Request, res: Response, filePath: string, mimeType: string) {
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Media file not found on server.' });
    return;
  }
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (Number.isNaN(start) || start >= fileSize || end >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': mimeType,
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

function getAuthContext(req: Request): {
  userId: string | null;
  guestToken: string | null;
  authViaCookie: boolean;
} {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const row = db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
      .get(token) as { user_id: string; expires_at: string } | undefined;
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return { userId: row.user_id, guestToken: null, authViaCookie: false };
    }
  }
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.editmind_session) {
    const row = db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
      .get(cookies.editmind_session) as { user_id: string; expires_at: string } | undefined;
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return { userId: row.user_id, guestToken: null, authViaCookie: true };
    }
  }
  const guest = (req.headers['x-guest-id'] as string) || null;
  return { userId: null, guestToken: guest, authViaCookie: false };
}

function canAccessOwnedRecord(
  ctx: { userId: string | null; guestToken: string | null },
  row: { user_id?: unknown; guest_token?: unknown; source_type?: unknown },
): boolean {
  if (row.source_type === 'demo') return true;
  if (row.user_id) {
    return Boolean(ctx.userId && ctx.userId === row.user_id);
  }
  if (row.guest_token) {
    // Allow legacy unclaimed guest sessions or matching guest token / migrated signed-in user
    return Boolean(ctx.guestToken && ctx.guestToken === row.guest_token);
  }
  return true;
}

function hydrateProjectRow(row: Record<string, unknown>): ProjectRecord & { media: unknown } {
  const mediaRow = db
    .prepare('SELECT * FROM media_assets WHERE id = ?')
    .get(row.media_id as string) as Record<string, unknown> | undefined;

  const analysis: MediaAnalysis = mediaRow
    ? (JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis)
    : {
        mediaId: row.media_id as string,
        durationSec: 10,
        width: 1280,
        height: 720,
        fps: 24,
        hasAudio: true,
        codec: 'h264',
        analysisMode: 'local-ffmpeg',
        analysisNote: '',
        waveformPeaks: [],
        transcript: [],
        scenes: [],
        speakers: [],
        importantMoments: [],
        silences: [],
        fillers: [],
        topics: [],
        summary: '',
      };

  const state = JSON.parse(row.state_json as string) as ProjectState;
  const history = JSON.parse(row.history_json as string) as HistoryEntry[];
  const versions = JSON.parse(row.versions_json as string);
  let vocabulary: string[] = analysis.vocabulary || [];
  if (typeof row.vocabulary_json === 'string' && row.vocabulary_json.trim()) {
    try {
      const parsedVocab = JSON.parse(row.vocabulary_json);
      if (Array.isArray(parsedVocab) && parsedVocab.length > 0) {
        vocabulary = parsedVocab;
      }
    } catch {
      // ignore invalid JSON
    }
  }

  return {
    id: row.id as string,
    title: row.title as string,
    mediaId: row.media_id as string,
    thumbnailUrl: row.thumbnail_url as string,
    vocabulary,
    state,
    history,
    historyIndex: row.history_index as number,
    versions,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    media: mediaRow
      ? {
          id: mediaRow.id,
          sourceType: mediaRow.source_type,
          sourceUrl: (mediaRow.source_url as string | undefined) || undefined,
          blobUrl: (mediaRow.blob_url as string | undefined) || undefined,
          filename: mediaRow.filename,
          mimeType: mediaRow.mime_type,
          url:
            mediaRow.source_type === 'demo'
              ? `/api/demos/${mediaRow.id}/video`
              : `/api/media/${mediaRow.id}/stream`,
          thumbnailUrl: mediaRow.thumbnail_url,
          durationSec: mediaRow.duration_sec,
          width: mediaRow.width,
          height: mediaRow.height,
          hasAudio: Boolean(mediaRow.has_audio),
          analysisMode: mediaRow.analysis_mode,
          analysis: { ...analysis, vocabulary: analysis.vocabulary || vocabulary },
          createdAt: mediaRow.created_at,
        }
      : null,
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp4';
      cb(null, `${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: cfg.maxUploadBytes },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-matroska',
      'video/ogg',
      'video/x-m4v',
      'application/octet-stream',
    ];
    if (
      allowed.includes(file.mimetype) ||
      file.mimetype.startsWith('video/') ||
      /\.(mp4|webm|mov|mkv|ogv|m4v)$/i.test(file.originalname)
    ) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported video format. Please upload MP4, WebM, MOV, or MKV.'));
    }
  },
});

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MUSIC_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || '.mp3';
      cb(null, `bgm-${uuid()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/') || /\.(mp3|wav|aac|m4a|ogg|flac)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio format. Please upload MP3, WAV, AAC, or OGG.'));
    }
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Configurable CORS & Cookie-CSRF protection for split Vercel frontend + dedicated Cloud Run backend worker
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const isWildcard = cfg.corsOrigins.includes('*');
    const isAllowed = Boolean(
      origin &&
        (isWildcard ||
          cfg.corsOrigins.includes(origin) ||
          origin.endsWith('.vercel.app') ||
          origin.startsWith('http://localhost:') ||
          origin.startsWith('http://127.0.0.1:')),
    );
    if (origin && isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-guest-id, Idempotency-Key, Range, x-worker-secret, x-requested-with',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    // Verify Origin matches Host / allowed origin on cookie-authenticated mutations
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const ctx = getAuthContext(req);
      if (ctx.authViaCookie && origin && !isAllowed) {
        res.status(403).json({ error: 'Cross-origin mutation blocked.' });
        return;
      }
    }
    next();
  });

  // Build / verify bundled demo videos without blocking port 3000 bind, and resume any interrupted analysis jobs
  const demoReadyPromise = ensureDemoLibraryReady()
    .then(() => {
      console.log('[EDITMIND AI] Demo library ready.');
      if (!cfg.workerMode) {
        resumeIncompleteAnalysisJobs();
      }
    })
    .catch((err) => console.error('[EDITMIND AI] Demo library error:', err));

  // Health & capabilities
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      geminiConfigured: hasGeminiKey(),
      ffmpegReady: true,
      maxUploadBytes: cfg.maxUploadBytes,
      sttProvider: cfg.sttProvider,
      blobStorageConfigured: isVercelBlobConfigured(),
      directMultipartSupported: true,
      chunkSizeBytes: cfg.multipartChunkBytes,
      remoteWorkerConfigured: isRemoteWorkerConfigured(),
      workerMode: cfg.workerMode,
    });
  });

  app.get('/api/languages', (_req, res) => {
    res.json({ languages: SUPPORTED_LANGUAGES });
  });

  // Auth endpoints (optional accounts; guests work without login)
  app.post('/api/auth/signup', async (req, res) => {
    try {
      const { email, password, name } = req.body as {
        email?: string;
        password?: string;
        name?: string;
      };
      if (!email || !password || password.length < 6) {
        res.status(400).json({ error: 'Valid email and password (min 6 characters) required.' });
        return;
      }
      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
      if (existing) {
        res.status(409).json({ error: 'An account with that email already exists.' });
        return;
      }
      const id = uuid();
      const hash = await bcrypt.hash(password, 10);
      const now = new Date().toISOString();
      db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        email.toLowerCase(),
        (name || email.split('@')[0]).trim(),
        hash,
        now,
      );

      const token = uuid();
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
        token,
        id,
        expiresAt,
      );

      // Migrate any guest projects if x-guest-id is present
      const guestToken = req.headers['x-guest-id'] as string | undefined;
      if (guestToken) {
        db.prepare('UPDATE projects SET user_id = ? WHERE guest_token = ? AND user_id IS NULL').run(
          id,
          guestToken,
        );
        db.prepare('UPDATE media_assets SET user_id = ? WHERE guest_token = ? AND user_id IS NULL').run(
          id,
          guestToken,
        );
      }

      setSessionCookie(res, token, 30 * 24 * 3600);
      res.json({
        token,
        user: { id, email: email.toLowerCase(), name: (name || email.split('@')[0]).trim() },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Signup failed.' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    try {
      const { email, password } = req.body as { email?: string; password?: string };
      if (!email || !password) {
        res.status(400).json({ error: 'Email and password are required.' });
        return;
      }
      const user = db
        .prepare('SELECT * FROM users WHERE email = ?')
        .get(email.toLowerCase()) as
        | { id: string; email: string; name: string; password_hash: string }
        | undefined;
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        res.status(401).json({ error: 'Invalid email or password.' });
        return;
      }
      const token = uuid();
      const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
      db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(
        token,
        user.id,
        expiresAt,
      );
      setSessionCookie(res, token, 30 * 24 * 3600);
      res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Login failed.' });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const ctx = getAuthContext(req);
    if (!ctx.userId) {
      res.json({ user: null });
      return;
    }
    const user = db
      .prepare('SELECT id, email, name FROM users WHERE id = ?')
      .get(ctx.userId) as { id: string; email: string; name: string } | undefined;
    res.json({ user: user || null });
  });

  app.post('/api/auth/logout', (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(authHeader.slice(7).trim());
    }
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.editmind_session) {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(cookies.editmind_session);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Demo catalog & streaming
  app.get('/api/demos', async (_req, res) => {
    await demoReadyPromise;
    const catalog = getDemoCatalogMeta().map((item) => {
      const row = db
        .prepare('SELECT duration_sec, analysis_json FROM media_assets WHERE id = ?')
        .get(item.id) as { duration_sec: number; analysis_json: string } | undefined;
      const analysis = row ? (JSON.parse(row.analysis_json) as MediaAnalysis) : null;
      return {
        ...item,
        durationSec: row?.duration_sec || 30,
        topics: analysis?.topics || [],
        speakers: analysis?.speakers || [],
        transcriptCount: analysis?.transcript.length || 0,
      };
    });
    res.json({ demos: catalog });
  });

  app.get('/api/demos/:id/video', async (req, res) => {
    await demoReadyPromise;
    const videoPath = path.join(DEMOS_DIR, `${req.params.id}.mp4`);
    streamMediaWithRanges(req, res, videoPath, 'video/mp4');
  });

  app.get('/api/demos/:id/thumb', async (req, res) => {
    await demoReadyPromise;
    const thumbPath = path.join(THUMBS_DIR, `${req.params.id}.jpg`);
    if (!fs.existsSync(thumbPath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(thumbPath);
  });

  app.get('/api/thumbs/:filename', (req, res) => {
    const thumbPath = resolveConfinedPath(THUMBS_DIR, req.params.filename);
    if (!thumbPath || !fs.existsSync(thumbPath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(thumbPath);
  });

  // Helper: create media_assets + project + dispatch local or remote Cloud Run worker analysis job
  async function createIngestedMediaAndProject(params: {
    filePath: string;
    originalFilename: string;
    mimeType: string;
    sourceType: 'upload' | 'recording';
    title: string;
    audioStreamIndex: number;
    languageOverride?: string;
    vocabulary: string[];
    ctx: { userId: string | null; guestToken: string | null };
    blobUrl?: string;
    blobPathname?: string;
    waitForSync?: boolean;
  }) {
    const {
      filePath,
      originalFilename,
      mimeType,
      sourceType,
      title,
      audioStreamIndex,
      languageOverride,
      vocabulary,
      ctx,
      waitForSync,
    } = params;

    const mediaId = `med-${uuid()}`;
    const { analysis, thumbnailUrl } = await prepareFastMediaRecord({
      mediaId,
      filePath,
      filename: originalFilename,
      audioStreamIndex,
    });
    analysis.vocabulary = vocabulary;
    analysis.selectedLanguageOverride = languageOverride || 'auto';

    let resolvedBlobUrl = params.blobUrl || null;
    let resolvedBlobPathname = params.blobPathname || null;
    if (!resolvedBlobUrl && isVercelBlobConfigured()) {
      const uploaded = await uploadFileToBlob({
        localPath: filePath,
        blobPathname: `media/${mediaId}/${path.basename(originalFilename)}`,
        contentType: mimeType,
      }).catch(() => null);
      if (uploaded) {
        resolvedBlobUrl = uploaded.url;
        resolvedBlobPathname = uploaded.pathname;
      }
    }

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO media_assets
       (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, vocabulary_json, language_override, blob_url, blob_pathname, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      mediaId,
      ctx.userId,
      ctx.guestToken,
      sourceType,
      originalFilename,
      mimeType,
      filePath,
      thumbnailUrl || '/api/demos/demo-keynote/thumb',
      analysis.durationSec,
      analysis.width,
      analysis.height,
      analysis.hasAudio ? 1 : 0,
      analysis.analysisMode,
      JSON.stringify(analysis),
      JSON.stringify(vocabulary),
      languageOverride || null,
      resolvedBlobUrl,
      resolvedBlobPathname,
      now,
    );

    const projectId = `prj-${uuid()}`;
    const initialState = createInitialProjectState(analysis);
    const versions = generateThreeVersions(analysis);
    const initialHistory: HistoryEntry[] = [
      {
        id: uuid(),
        timestamp: now,
        label: 'Project Created',
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
      ctx.userId,
      ctx.guestToken,
      title,
      mediaId,
      thumbnailUrl || '/api/demos/demo-keynote/thumb',
      JSON.stringify(initialState),
      JSON.stringify(initialHistory),
      JSON.stringify(versions),
      JSON.stringify(vocabulary),
      now,
      now,
    );

    // Dispatch to remote Cloud Run worker if configured and source exists in Vercel Blob
    if (!waitForSync && isRemoteWorkerConfigured() && resolvedBlobUrl) {
      const jobId = `job-${uuid()}`;
      db.prepare(
        `INSERT INTO analysis_jobs
         (id, media_id, project_id, selected_audio_stream, language_override, status, overall_progress, audio_extraction_status, transcription_status, chunk_total, chunk_completed, chunk_failed, alignment_status, caption_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 5, 'pending', 'pending', 0, 0, 0, 'pending', 'pending', ?, ?)`,
      ).run(jobId, mediaId, projectId, audioStreamIndex, languageOverride || 'auto', now, now);

      try {
        await dispatchAnalyzeToWorker({
          jobId,
          mediaId,
          projectId,
          sourceBlobUrl: resolvedBlobUrl,
          filename: originalFilename,
          audioStreamIndex,
          languageOverride,
          vocabulary,
          callbackUrl: cfg.workerCallbackBaseUrl
            ? `${cfg.workerCallbackBaseUrl}/api/internal/worker-callback`
            : undefined,
        });
        const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<
          string,
          unknown
        >;
        return {
          mediaId,
          projectId,
          project: hydrateProjectRow(projectRow),
          job: getAnalysisJob(jobId)!,
        };
      } catch (dispatchErr) {
        console.warn(
          '[workerBridge] Remote dispatch failed, running analysis in local background worker:',
          dispatchErr instanceof Error ? dispatchErr.message : dispatchErr,
        );
        db.prepare('DELETE FROM analysis_jobs WHERE id = ?').run(jobId);
      }
    }

    const { job, promise } = startBackgroundAnalysisJob({
      mediaId,
      projectId,
      audioStreamIndex,
      languageOverride,
      vocabulary,
    });

    if (waitForSync) {
      await promise.catch(() => {});
    }

    const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<
      string,
      unknown
    >;
    return {
      mediaId,
      projectId,
      project: hydrateProjectRow(projectRow),
      job: getAnalysisJob(job.id) || job,
    };
  }

  // Upload or record real user media (NEVER substitutes demo media!)
  // Returns fast initial project immediately by default while background chunked transcription runs; pass ?sync=1 to await completion.
  app.post('/api/media/ingest', upload.single('video'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No video file provided.' });
        return;
      }

      const sourceType = req.body.sourceType === 'recording' ? 'recording' : 'upload';
      const title =
        (req.body.title as string | undefined)?.trim() ||
        path.parse(file.originalname).name ||
        (sourceType === 'recording' ? 'Camera Recording' : 'Uploaded Video');
      const requestedStreamIdx = parseInt(String(req.body.audioStreamIndex ?? '0'), 10);
      const audioStreamIndex = Number.isFinite(requestedStreamIdx) ? requestedStreamIdx : 0;
      const languageOverride = (req.body.languageOverride as string | undefined)?.trim() || undefined;
      const vocabulary = parseVocabularyInput(req.body.vocabulary);

      const ctx = getAuthContext(req);
      const mimeType =
        file.mimetype && file.mimetype !== 'application/octet-stream'
          ? file.mimetype
          : file.originalname.endsWith('.webm')
            ? 'video/webm'
            : file.originalname.endsWith('.mov')
              ? 'video/quicktime'
              : file.originalname.endsWith('.mkv')
                ? 'video/x-matroska'
                : 'video/mp4';

      const result = await createIngestedMediaAndProject({
        filePath: file.path,
        originalFilename: file.originalname,
        mimeType,
        sourceType,
        title,
        audioStreamIndex,
        languageOverride,
        vocabulary,
        ctx,
        waitForSync: req.query.sync === '1',
      });

      res.json({
        project: result.project,
        job: result.job,
      });
    } catch (err) {
      console.error('Ingest failed:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to process uploaded video.',
      });
    }
  });

  // Vercel Blob direct client multipart token exchange (up to 2 GB directly from browser to Vercel Blob)
  app.post('/api/blob/upload-token', async (req, res) => {
    try {
      const ctx = getAuthContext(req);
      const jsonResponse = await handleBlobClientUpload({
        request: req,
        body: req.body as HandleUploadBody,
        userId: ctx.userId,
        guestToken: ctx.guestToken,
      });
      res.json(jsonResponse);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to issue Vercel Blob upload token.',
      });
    }
  });

  // Ingest media uploaded directly to Vercel Blob
  app.post('/api/media/ingest-blob', async (req, res) => {
    try {
      const {
        blobUrl,
        blobPathname,
        filename,
        mimeType,
        sourceType,
        title,
        audioStreamIndex = 0,
        languageOverride,
        vocabulary,
      } = (req.body || {}) as {
        blobUrl?: string;
        blobPathname?: string;
        filename?: string;
        mimeType?: string;
        sourceType?: 'upload' | 'recording';
        title?: string;
        audioStreamIndex?: number;
        languageOverride?: string;
        vocabulary?: unknown;
      };
      if (!blobUrl) {
        res.status(400).json({ error: 'blobUrl is required.' });
        return;
      }

      const origName = (filename || 'uploaded-video.mp4').trim();
      const ext = path.extname(origName) || '.mp4';
      const localPath = path.join(UPLOADS_DIR, `${uuid()}${ext}`);
      await downloadBlobToFile(blobUrl, localPath);

      const ctx = getAuthContext(req);
      const result = await createIngestedMediaAndProject({
        filePath: localPath,
        originalFilename: origName,
        mimeType: mimeType || 'video/mp4',
        sourceType: sourceType === 'recording' ? 'recording' : 'upload',
        title: (title || '').trim() || path.parse(origName).name || 'Uploaded Video',
        audioStreamIndex: Number.isFinite(Number(audioStreamIndex)) ? Number(audioStreamIndex) : 0,
        languageOverride: languageOverride?.trim() || undefined,
        vocabulary: parseVocabularyInput(vocabulary),
        ctx,
        blobUrl,
        blobPathname,
        waitForSync: req.query.sync === '1',
      });

      res.json({
        project: result.project,
        job: result.job,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to ingest Blob media.',
      });
    }
  });

  // Streamed chunked multipart upload fallback (up to 2 GB / 60 min without needing Vercel Blob token)
  app.post('/api/uploads/multipart/init', (req, res) => {
    try {
      const {
        filename,
        mimeType,
        sizeBytes,
        sourceType,
        title,
        languageOverride,
        vocabulary,
        audioStreamIndex = 0,
      } = (req.body || {}) as {
        filename?: string;
        mimeType?: string;
        sizeBytes?: number;
        sourceType?: 'upload' | 'recording';
        title?: string;
        languageOverride?: string;
        vocabulary?: unknown;
        audioStreamIndex?: number;
      };
      if (!filename || !sizeBytes || !Number.isFinite(Number(sizeBytes)) || Number(sizeBytes) <= 0) {
        res.status(400).json({ error: 'Valid filename and positive sizeBytes are required.' });
        return;
      }
      if (Number(sizeBytes) > cfg.maxUploadBytes) {
        res.status(413).json({ error: 'File size exceeds the strict 2 GB upload limit.' });
        return;
      }

      const uploadId = `mpu-${uuid()}`;
      const chunkSizeBytes = cfg.multipartChunkBytes;
      const totalParts = Math.max(1, Math.ceil(Number(sizeBytes) / chunkSizeBytes));
      const stagingDir = path.join(TEMP_DIR, uploadId);
      fs.mkdirSync(stagingDir, { recursive: true });
      const ctx = getAuthContext(req);
      const now = new Date().toISOString();
      const parsedVocab = parseVocabularyInput(vocabulary);

      db.prepare(
        `INSERT INTO multipart_uploads
         (id, user_id, guest_token, filename, mime_type, size_bytes, chunk_size_bytes, total_parts, received_parts_json, staging_dir, source_type, title, language_override, vocabulary_json, audio_stream_index, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)`,
      ).run(
        uploadId,
        ctx.userId,
        ctx.guestToken,
        path.basename(filename),
        mimeType || 'video/mp4',
        Number(sizeBytes),
        chunkSizeBytes,
        totalParts,
        stagingDir,
        sourceType === 'recording' ? 'recording' : 'upload',
        (title || '').trim() || path.parse(filename).name || 'Uploaded Video',
        languageOverride?.trim() || null,
        JSON.stringify(parsedVocab),
        Number.isFinite(Number(audioStreamIndex)) ? Number(audioStreamIndex) : 0,
        now,
        now,
      );

      res.json({ uploadId, chunkSizeBytes, totalParts });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to initialize multipart upload.',
      });
    }
  });

  app.put(
    '/api/uploads/multipart/:uploadId/part/:partIndex',
    express.raw({ type: '*/*', limit: '32mb' }),
    (req, res) => {
      try {
        const row = db
          .prepare('SELECT * FROM multipart_uploads WHERE id = ?')
          .get(req.params.uploadId) as Record<string, unknown> | undefined;
        if (!row) {
          res.status(404).json({ error: 'Multipart upload session not found.' });
          return;
        }
        const ctx = getAuthContext(req);
        if (!canAccessOwnedRecord(ctx, row)) {
          res.status(403).json({ error: 'Access denied to this upload session.' });
          return;
        }
        const partIdx = parseInt(req.params.partIndex, 10);
        const totalParts = Number(row.total_parts);
        if (!Number.isInteger(partIdx) || partIdx < 0 || partIdx >= totalParts) {
          res.status(400).json({ error: `Invalid partIndex ${req.params.partIndex}.` });
          return;
        }
        const bodyBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
        if (bodyBuf.length === 0) {
          res.status(400).json({ error: 'Uploaded chunk part is empty.' });
          return;
        }

        const partPath = resolveConfinedPath(row.staging_dir as string, `part-${String(partIdx).padStart(6, '0')}`);
        if (!partPath) {
          res.status(400).json({ error: 'Invalid part path.' });
          return;
        }
        fs.writeFileSync(partPath, bodyBuf);

        const received = new Set<number>(JSON.parse((row.received_parts_json as string) || '[]') as number[]);
        received.add(partIdx);
        const receivedArr = Array.from(received).sort((a, b) => a - b);

        db.prepare('UPDATE multipart_uploads SET received_parts_json = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(receivedArr),
          new Date().toISOString(),
          row.id,
        );

        res.json({ ok: true, partIndex: partIdx, receivedCount: receivedArr.length, totalParts });
      } catch (err) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'Failed to store upload chunk.',
        });
      }
    },
  );

  app.post('/api/uploads/multipart/:uploadId/complete', async (req, res) => {
    try {
      const row = db
        .prepare('SELECT * FROM multipart_uploads WHERE id = ?')
        .get(req.params.uploadId) as Record<string, unknown> | undefined;
      if (!row) {
        res.status(404).json({ error: 'Multipart upload session not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, row)) {
        res.status(403).json({ error: 'Access denied to this upload session.' });
        return;
      }

      const totalParts = Number(row.total_parts);
      const stagingDir = row.staging_dir as string;
      const ext = path.extname(row.filename as string) || '.mp4';
      const assembledPath = path.join(UPLOADS_DIR, `${uuid()}${ext}`);

      const writeStream = fs.createWriteStream(assembledPath);
      let totalAssembledBytes = 0;

      for (let i = 0; i < totalParts; i++) {
        const partPath = resolveConfinedPath(stagingDir, `part-${String(i).padStart(6, '0')}`);
        if (!partPath || !fs.existsSync(partPath)) {
          writeStream.destroy();
          fs.rmSync(assembledPath, { force: true });
          res.status(400).json({ error: `Missing upload part ${i} of ${totalParts}.` });
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const readStream = fs.createReadStream(partPath);
          readStream.on('data', (chunk: Buffer | string) => {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            totalAssembledBytes += buf.length;
            if (totalAssembledBytes > cfg.maxUploadBytes) {
              readStream.destroy(new Error('Assembled upload exceeds 2 GB ceiling.'));
              return;
            }
            if (!writeStream.write(buf)) {
              readStream.pause();
              writeStream.once('drain', () => readStream.resume());
            }
          });
          readStream.on('end', () => resolve());
          readStream.on('error', reject);
        });
      }
      await new Promise<void>((resolve) => writeStream.end(() => resolve()));

      // Clean temporary staged chunks
      fs.rmSync(stagingDir, { recursive: true, force: true });
      db.prepare("UPDATE multipart_uploads SET status = 'completed', updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        row.id,
      );

      const result = await createIngestedMediaAndProject({
        filePath: assembledPath,
        originalFilename: row.filename as string,
        mimeType: (row.mime_type as string) || 'video/mp4',
        sourceType: row.source_type === 'recording' ? 'recording' : 'upload',
        title: (row.title as string) || 'Uploaded Video',
        audioStreamIndex: Number(row.audio_stream_index ?? 0),
        languageOverride: (row.language_override as string | null) || undefined,
        vocabulary: JSON.parse((row.vocabulary_json as string) || '[]') as string[],
        ctx,
        waitForSync: req.query.sync === '1',
      });

      res.json({
        project: result.project,
        job: result.job,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to assemble multipart upload.',
      });
    }
  });

  app.delete('/api/uploads/multipart/:uploadId', (req, res) => {
    const row = db
      .prepare('SELECT * FROM multipart_uploads WHERE id = ?')
      .get(req.params.uploadId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'Multipart upload session not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, row)) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    if (row.staging_dir && fs.existsSync(row.staging_dir as string)) {
      fs.rmSync(row.staging_dir as string, { recursive: true, force: true });
    }
    db.prepare('DELETE FROM multipart_uploads WHERE id = ?').run(row.id);
    res.json({ ok: true });
  });

  // Direct URL Video Intake (SSRF-safe, strictly 2 GB capped, async job + optional ?sync=1)
  app.post('/api/media/import-url', async (req, res) => {
    try {
      const { url, title, languageOverride, vocabulary } = (req.body || {}) as {
        url?: string;
        title?: string;
        languageOverride?: string;
        vocabulary?: unknown;
      };
      if (!url || !url.trim()) {
        res.status(400).json({ error: 'Please provide a video URL.' });
        return;
      }
      const ctx = getAuthContext(req);
      const parsedVocab = parseVocabularyInput(vocabulary);
      const { importJob, promise } = startUrlImportJob({
        url: url.trim(),
        title,
        userId: ctx.userId,
        guestToken: ctx.guestToken,
        languageOverride: languageOverride?.trim() || undefined,
        vocabulary: parsedVocab,
      });

      if (req.query.sync === '1') {
        await promise.catch(() => {});
      } else {
        // Allow fast synchronous URL/SSRF validation errors to surface immediately
        await new Promise((r) => setTimeout(r, 80));
      }

      const latest = getUrlImportJob(importJob.id) || importJob;
      if (latest.status === 'failed') {
        res.status(400).json({ error: latest.error || 'Failed to import video URL.', importJob: latest });
        return;
      }
      const projRow = latest.projectId
        ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(latest.projectId) as
            | Record<string, unknown>
            | undefined)
        : undefined;

      res.json({
        importJob: latest,
        project: projRow ? hydrateProjectRow(projRow) : null,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'URL import failed.',
      });
    }
  });

  app.get('/api/url-imports/:id', (req, res) => {
    const row = db.prepare('SELECT user_id, guest_token FROM url_imports WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'URL import job not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, row)) {
      res.status(403).json({ error: 'Access denied to this URL import job.' });
      return;
    }
    const job = getUrlImportJob(req.params.id)!;
    const projRow = job.projectId
      ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(job.projectId) as
          | Record<string, unknown>
          | undefined)
      : undefined;
    res.json({
      importJob: job,
      project: projRow ? hydrateProjectRow(projRow) : null,
    });
  });

  app.get('/api/media/:id/stream', (req, res) => {
    const row = db
      .prepare('SELECT file_path, mime_type FROM media_assets WHERE id = ?')
      .get(req.params.id) as { file_path: string; mime_type: string } | undefined;
    if (!row) {
      res.status(404).json({ error: 'Media asset not found.' });
      return;
    }
    streamMediaWithRanges(req, res, row.file_path, row.mime_type || 'video/mp4');
  });

  // Exact word/phrase audio snippet WAV endpoint for manual verification replay
  app.get('/api/media/:id/audio-snippet', async (req, res) => {
    try {
      const row = db
        .prepare('SELECT file_path, has_audio, analysis_json FROM media_assets WHERE id = ?')
        .get(req.params.id) as
        | { file_path: string; has_audio: number; analysis_json: string }
        | undefined;
      if (!row || !fs.existsSync(row.file_path)) {
        res.status(404).json({ error: 'Media file not found.' });
        return;
      }
      if (!row.has_audio) {
        res.status(400).json({ error: 'This media asset has no audio track.' });
        return;
      }
      const start = Number(req.query.start ?? 0);
      const end = Number(req.query.end ?? start + 1.5);
      const analysis = JSON.parse(row.analysis_json) as MediaAnalysis;
      const streamIdx =
        req.query.stream !== undefined
          ? Number(req.query.stream)
          : analysis.selectedAudioStream ?? 0;

      const wavPath = await extractAudioSnippetWav({
        mediaId: req.params.id,
        filePath: row.file_path as string,
        audioStreamIndex: Number.isFinite(streamIdx) ? streamIdx : 0,
        startSec: Number.isFinite(start) ? start : 0,
        endSec: Number.isFinite(end) ? end : (Number.isFinite(start) ? start : 0) + 1.5,
      });
      res.setHeader('Cache-Control', 'no-store');
      streamMediaWithRanges(req, res, wavPath, 'audio/wav');
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to extract audio snippet.',
      });
    }
  });

  // Trigger genuine chunked speech transcription & scene re-analysis in background (or ?sync=1)
  app.post('/api/media/:id/reanalyze', async (req, res) => {
    try {
      const mediaRow = db
        .prepare('SELECT * FROM media_assets WHERE id = ?')
        .get(req.params.id) as Record<string, unknown> | undefined;
      if (!mediaRow) {
        res.status(404).json({ error: 'Media asset not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, mediaRow)) {
        res.status(403).json({ error: 'Access denied to this media asset.' });
        return;
      }
      const filePath = mediaRow.file_path as string;
      if (!fs.existsSync(filePath)) {
        res.status(404).json({ error: 'Original source video file missing on server disk.' });
        return;
      }

      const { projectId, audioStreamIndex, languageOverride, vocabulary } = (req.body || {}) as {
        projectId?: string;
        audioStreamIndex?: number;
        languageOverride?: string;
        vocabulary?: unknown;
      };
      const prevAnalysis = JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis;
      const streamIdx = audioStreamIndex ?? prevAnalysis.selectedAudioStream ?? 0;
      const resolvedVocab =
        vocabulary !== undefined
          ? parseVocabularyInput(vocabulary)
          : parseVocabularyInput(mediaRow.vocabulary_json || prevAnalysis.vocabulary);
      const resolvedLang =
        languageOverride !== undefined
          ? languageOverride.trim() || undefined
          : (mediaRow.language_override as string | undefined) || undefined;

      db.prepare('UPDATE media_assets SET vocabulary_json = ?, language_override = ? WHERE id = ?').run(
        JSON.stringify(resolvedVocab),
        resolvedLang || null,
        mediaRow.id,
      );
      if (projectId) {
        db.prepare('UPDATE projects SET vocabulary_json = ? WHERE id = ?').run(
          JSON.stringify(resolvedVocab),
          projectId,
        );
      }

      const { job, promise } = startBackgroundAnalysisJob({
        mediaId: mediaRow.id as string,
        projectId: projectId ?? null,
        audioStreamIndex: streamIdx,
        languageOverride: resolvedLang,
        vocabulary: resolvedVocab,
      });

      if (req.query.sync === '1') {
        await promise.catch(() => {});
      }

      const refreshedMedia = db
        .prepare('SELECT analysis_json FROM media_assets WHERE id = ?')
        .get(mediaRow.id) as { analysis_json: string };
      const analysis = JSON.parse(refreshedMedia.analysis_json) as MediaAnalysis;
      const projRow = projectId
        ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined)
        : undefined;

      res.json({
        job: getAnalysisJob(job.id) || job,
        analysis,
        project: projRow ? hydrateProjectRow(projRow) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Re-analysis failed.' });
    }
  });

  // Select a specific audio stream on multi-track media and transcribe it cleanly
  app.post('/api/media/:id/select-audio-stream', async (req, res) => {
    try {
      const mediaRow = db
        .prepare('SELECT * FROM media_assets WHERE id = ?')
        .get(req.params.id) as Record<string, unknown> | undefined;
      if (!mediaRow) {
        res.status(404).json({ error: 'Media asset not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, mediaRow)) {
        res.status(403).json({ error: 'Access denied to this media asset.' });
        return;
      }
      const { audioStreamIndex = 0, projectId, languageOverride, vocabulary } = (req.body || {}) as {
        audioStreamIndex?: number;
        projectId?: string;
        languageOverride?: string;
        vocabulary?: unknown;
      };
      const meta = await probeVideoFile(mediaRow.file_path as string);
      if (audioStreamIndex < 0 || audioStreamIndex >= Math.max(1, meta.detectedAudioStreams)) {
        res.status(400).json({
          error: `Invalid audioStreamIndex ${audioStreamIndex}. Available streams: ${meta.detectedAudioStreams}.`,
        });
        return;
      }
      const prevAnalysis = JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis;
      const resolvedVocab =
        vocabulary !== undefined
          ? parseVocabularyInput(vocabulary)
          : parseVocabularyInput(mediaRow.vocabulary_json || prevAnalysis.vocabulary);
      const resolvedLang =
        languageOverride !== undefined
          ? languageOverride.trim() || undefined
          : (mediaRow.language_override as string | undefined) || undefined;

      const { job, promise } = startBackgroundAnalysisJob({
        mediaId: mediaRow.id as string,
        projectId: projectId ?? null,
        audioStreamIndex,
        languageOverride: resolvedLang,
        vocabulary: resolvedVocab,
      });

      if (req.query.sync === '1') {
        await promise.catch(() => {});
      }

      const refreshedMedia = db
        .prepare('SELECT analysis_json FROM media_assets WHERE id = ?')
        .get(mediaRow.id) as { analysis_json: string };
      const analysis = JSON.parse(refreshedMedia.analysis_json) as MediaAnalysis;
      const projRow = projectId
        ? (db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown> | undefined)
        : undefined;

      res.json({
        job: getAnalysisJob(job.id) || job,
        analysis,
        project: projRow ? hydrateProjectRow(projRow) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to switch audio stream.' });
    }
  });

  // Analysis job inspection & chunk recovery controls
  app.get('/api/analysis-jobs/:jobId', (req, res) => {
    const job = getAnalysisJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Analysis job not found.' });
      return;
    }
    const mediaRow = db.prepare('SELECT user_id, guest_token, source_type FROM media_assets WHERE id = ?').get(job.mediaId) as
      | Record<string, unknown>
      | undefined;
    const ctx = getAuthContext(req);
    if (mediaRow && !canAccessOwnedRecord(ctx, mediaRow)) {
      res.status(403).json({ error: 'Access denied to this analysis job.' });
      return;
    }
    const chunks = db
      .prepare(
        `SELECT id, chunk_index, source_start, source_end, status, provider, attempt_count, error
         FROM transcription_chunks WHERE job_id = ? ORDER BY chunk_index ASC`,
      )
      .all(job.id) as Array<Record<string, unknown>>;
    res.json({ job, chunks });
  });

  app.get('/api/projects/:id/analysis-status', (req, res) => {
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const media = db
      .prepare('SELECT analysis_json FROM media_assets WHERE id = ?')
      .get(proj.media_id as string) as { analysis_json: string } | undefined;
    const analysis = media ? (JSON.parse(media.analysis_json) as MediaAnalysis) : null;
    const job = getLatestAnalysisJobForMedia(proj.media_id as string);
    res.json({
      job,
      analysis,
      project: hydrateProjectRow(proj),
    });
  });

  app.post('/api/analysis-jobs/:jobId/retry-failed', async (req, res) => {
    const job = getAnalysisJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Analysis job not found.' });
      return;
    }
    const mediaRow = db.prepare('SELECT user_id, guest_token, source_type FROM media_assets WHERE id = ?').get(job.mediaId) as
      | Record<string, unknown>
      | undefined;
    const ctx = getAuthContext(req);
    if (mediaRow && !canAccessOwnedRecord(ctx, mediaRow)) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    const promise = retryFailedJobChunks(job.id);
    if (req.query.sync === '1') {
      const analysis = await promise;
      res.json({ job: getAnalysisJob(job.id), analysis });
      return;
    }
    void promise.catch((err) => console.error('[transcriber] retry-failed error:', err));
    res.json({ job: getAnalysisJob(job.id) });
  });

  app.post('/api/analysis-jobs/:jobId/retry', async (req, res) => {
    const prev = getAnalysisJob(req.params.jobId);
    if (!prev) {
      res.status(404).json({ error: 'Analysis job not found.' });
      return;
    }
    const mediaRow = db.prepare('SELECT user_id, guest_token, source_type FROM media_assets WHERE id = ?').get(prev.mediaId) as
      | Record<string, unknown>
      | undefined;
    const ctx = getAuthContext(req);
    if (mediaRow && !canAccessOwnedRecord(ctx, mediaRow)) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    const { job, promise } = startBackgroundAnalysisJob({
      mediaId: prev.mediaId,
      projectId: prev.projectId,
      audioStreamIndex: prev.selectedAudioStream,
    });
    if (req.query.sync === '1') {
      const analysis = await promise;
      res.json({ job: getAnalysisJob(job.id), analysis });
      return;
    }
    res.json({ job });
  });

  app.post('/api/analysis-jobs/:jobId/cancel', (req, res) => {
    const job = getAnalysisJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Analysis job not found.' });
      return;
    }
    const mediaRow = db.prepare('SELECT user_id, guest_token, source_type FROM media_assets WHERE id = ?').get(job.mediaId) as
      | Record<string, unknown>
      | undefined;
    const ctx = getAuthContext(req);
    if (mediaRow && !canAccessOwnedRecord(ctx, mediaRow)) {
      res.status(403).json({ error: 'Access denied.' });
      return;
    }
    requestCancelAnalysisJob(job.id);
    res.json({ ok: true, job: getAnalysisJob(job.id) });
  });

  // Upload real background music audio file for project
  app.post('/api/projects/:id/music', musicUpload.single('audio'), async (req, res) => {
    try {
      const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!proj) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, proj)) {
        res.status(403).json({ error: 'Access denied to this project.' });
        return;
      }
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No audio file provided.' });
        return;
      }
      const meta = await probeVideoFile(file.path).catch(() => ({ durationSec: 30 }));
      const storedFilename = path.basename(file.path);
      let musicUrl = `/api/music/${storedFilename}`;
      if (isVercelBlobConfigured()) {
        const uploaded = await uploadFileToBlob({
          localPath: file.path,
          blobPathname: `music/${storedFilename}`,
          contentType: file.mimetype || 'audio/mpeg',
        }).catch(() => null);
        if (uploaded?.url) musicUrl = uploaded.url;
      }
      res.json({
        url: musicUrl,
        filename: file.originalname,
        storedFilename,
        durationSec: meta.durationSec || 30,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to upload music track.' });
    }
  });

  app.get('/api/music/:filename', (req, res) => {
    const musicPath = resolveConfinedPath(MUSIC_DIR, req.params.filename);
    if (!musicPath) {
      res.status(404).end();
      return;
    }
    const ext = path.extname(musicPath).toLowerCase();
    const mime =
      ext === '.wav'
        ? 'audio/wav'
        : ext === '.ogg'
          ? 'audio/ogg'
          : ext === '.m4a' || ext === '.aac'
            ? 'audio/aac'
            : 'audio/mpeg';
    streamMediaWithRanges(req, res, musicPath, mime);
  });

  // Projects CRUD
  app.get('/api/projects', (req, res) => {
    const ctx = getAuthContext(req);
    let rows: Record<string, unknown>[] = [];
    if (ctx.userId) {
      rows = db
        .prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC')
        .all(ctx.userId) as Record<string, unknown>[];
    } else if (ctx.guestToken) {
      rows = db
        .prepare('SELECT * FROM projects WHERE guest_token = ? AND user_id IS NULL ORDER BY updated_at DESC')
        .all(ctx.guestToken) as Record<string, unknown>[];
    }
    res.json({ projects: rows.map(hydrateProjectRow) });
  });

  app.post('/api/projects/from-demo', async (req, res) => {
    await demoReadyPromise;
    const { demoId, title } = req.body as { demoId?: string; title?: string };
    if (!demoId) {
      res.status(400).json({ error: 'demoId is required.' });
      return;
    }
    const mediaRow = db
      .prepare("SELECT * FROM media_assets WHERE id = ? AND source_type = 'demo'")
      .get(demoId) as Record<string, unknown> | undefined;
    if (!mediaRow) {
      res.status(404).json({ error: 'Demo video not found.' });
      return;
    }
    const analysis = JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis;
    const initialState = createInitialProjectState(analysis);
    const versions = generateThreeVersions(analysis);
    const now = new Date().toISOString();
    const ctx = getAuthContext(req);
    const projectId = `prj-${uuid()}`;
    const demoMeta = getDemoCatalogMeta().find((d) => d.id === demoId);

    const history: HistoryEntry[] = [
      {
        id: uuid(),
        timestamp: now,
        label: 'Opened Demo Project',
        durationAfter: initialState.duration,
        stateSnapshot: initialState,
      },
    ];

    db.prepare(
      `INSERT INTO projects
       (id, user_id, guest_token, title, media_id, thumbnail_url, state_json, history_json, history_index, versions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      projectId,
      ctx.userId,
      ctx.guestToken,
      title || demoMeta?.title || 'Demo Project',
      demoId,
      mediaRow.thumbnail_url as string,
      JSON.stringify(initialState),
      JSON.stringify(history),
      JSON.stringify(versions),
      now,
      now,
    );

    const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<
      string,
      unknown
    >;
    res.json({ project: hydrateProjectRow(created) });
  });

  app.get('/api/projects/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, row)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    res.json({ project: hydrateProjectRow(row) });
  });

  app.patch('/api/projects/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, row)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const { title, state, history, historyIndex, versions } = req.body as {
      title?: string;
      state?: ProjectState;
      history?: HistoryEntry[];
      historyIndex?: number;
      versions?: unknown;
    };
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE projects
       SET title = ?, state_json = ?, history_json = ?, history_index = ?, versions_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      title ?? row.title,
      state ? JSON.stringify(state) : row.state_json,
      history ? JSON.stringify(history) : row.history_json,
      historyIndex ?? row.history_index,
      versions ? JSON.stringify(versions) : row.versions_json,
      now,
      req.params.id,
    );
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as Record<
      string,
      unknown
    >;
    res.json({ project: hydrateProjectRow(updated) });
  });

  app.post('/api/projects/:id/duplicate', (req, res) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, row)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const newId = `prj-${uuid()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO projects
       (id, user_id, guest_token, title, media_id, thumbnail_url, state_json, history_json, history_index, versions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId,
      row.user_id,
      row.guest_token,
      `${row.title as string} (Copy)`,
      row.media_id,
      row.thumbnail_url,
      row.state_json,
      row.history_json,
      row.history_index,
      row.versions_json,
      now,
      now,
    );
    const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(newId) as Record<
      string,
      unknown
    >;
    res.json({ project: hydrateProjectRow(created) });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, row)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  // AI Edit Plan + Impact Check
  app.post('/api/ai/plan', async (req, res) => {
    try {
      const { projectId, prompt, currentState } = req.body as {
        projectId?: string;
        prompt?: string;
        currentState?: ProjectState;
      };
      if (!projectId || !prompt) {
        res.status(400).json({ error: 'projectId and prompt are required.' });
        return;
      }
      const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
        | Record<string, unknown>
        | undefined;
      if (!proj) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, proj)) {
        res.status(403).json({ error: 'Access denied to this project.' });
        return;
      }
      const media = db
        .prepare('SELECT * FROM media_assets WHERE id = ?')
        .get(proj.media_id as string) as Record<string, unknown> | undefined;
      if (!media) {
        res.status(404).json({ error: 'Source media not found.' });
        return;
      }

      const analysis = JSON.parse(media.analysis_json as string) as MediaAnalysis;
      const state = currentState || (JSON.parse(proj.state_json as string) as ProjectState);
      const plan = await planEditFromPrompt(prompt, state, analysis);
      const impact = computeEditImpact(state, analysis, plan);
      const searchHits = plan.searchQuery
        ? searchMediaIndex(analysis, state.segments, plan.searchQuery)
        : [];

      res.json({
        plan,
        impact,
        searchHits,
        stagesExecuted: [
          'Understanding request',
          'Searching video',
          'Finding timestamps',
          'Preparing edit',
          'Preview ready',
        ],
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'AI planning error.' });
    }
  });

  // Fast Video Content Search
  app.post('/api/projects/:id/search', (req, res) => {
    const { query, state } = req.body as { query?: string; state?: ProjectState };
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const media = db
      .prepare('SELECT * FROM media_assets WHERE id = ?')
      .get(proj.media_id as string) as Record<string, unknown> | undefined;
    if (!media) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const analysis = JSON.parse(media.analysis_json as string) as MediaAnalysis;
    const activeState = state || (JSON.parse(proj.state_json as string) as ProjectState);
    const hits = searchMediaIndex(analysis, activeState.segments, query || '');
    res.json({ hits });
  });

  // Regenerate 3 Edit Versions
  app.post('/api/projects/:id/versions', (req, res) => {
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const media = db
      .prepare('SELECT * FROM media_assets WHERE id = ?')
      .get(proj.media_id as string) as Record<string, unknown> | undefined;
    if (!media) {
      res.status(404).json({ error: 'Media not found.' });
      return;
    }
    const analysis = JSON.parse(media.analysis_json as string) as MediaAnalysis;
    const versions = generateThreeVersions(analysis);
    db.prepare('UPDATE projects SET versions_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(versions),
      new Date().toISOString(),
      req.params.id,
    );
    res.json({ versions });
  });

  // Real FFmpeg MP4 Export
  app.post('/api/exports', async (req, res) => {
    const { projectId, state, resolution = '720p', quality = 'balanced' } = req.body as {
      projectId?: string;
      state?: ProjectState;
      resolution?: ExportJob['resolution'];
      quality?: ExportJob['quality'];
    };
    if (!projectId) {
      res.status(400).json({ error: 'projectId is required.' });
      return;
    }
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const media = db
      .prepare('SELECT * FROM media_assets WHERE id = ?')
      .get(proj.media_id as string) as Record<string, unknown> | undefined;
    if (!media) {
      res.status(404).json({ error: 'Source media not found.' });
      return;
    }

    const activeState = state || (JSON.parse(proj.state_json as string) as ProjectState);
    const mediaAnalysis = media.analysis_json
      ? (JSON.parse(media.analysis_json as string) as MediaAnalysis)
      : null;
    const jobId = `exp-${uuid()}`;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO exports (id, project_id, media_id, status, progress, resolution, quality, created_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(jobId, projectId, media.id, resolution, quality, now);

    const mediaBlobUrl = (media.blob_url as string | undefined) || undefined;
    let dispatchedRemotely = false;
    if (isRemoteWorkerConfigured() && mediaBlobUrl) {
      try {
        await dispatchExportToWorker({
          jobId,
          projectId,
          mediaId: media.id as string,
          sourceBlobUrl: mediaBlobUrl,
          sourceHasAudio: Boolean(media.has_audio),
          selectedAudioStream: mediaAnalysis?.selectedAudioStream ?? 0,
          state: activeState,
          resolution,
          quality,
          customMusicBlobUrl: activeState.audio.customMusicUrl?.startsWith('https://')
            ? activeState.audio.customMusicUrl
            : undefined,
          callbackUrl: cfg.workerCallbackBaseUrl
            ? `${cfg.workerCallbackBaseUrl}/api/internal/worker-callback`
            : undefined,
        });
        dispatchedRemotely = true;
      } catch (dispatchErr) {
        console.warn(
          '[workerBridge] Remote export dispatch failed, running FFmpeg locally:',
          dispatchErr instanceof Error ? dispatchErr.message : dispatchErr,
        );
      }
    }

    if (!dispatchedRemotely) {
      // Kick off FFmpeg background render without blocking HTTP response
      void runExportJob({
        jobId,
        projectId,
        mediaId: media.id as string,
        sourceFilePath: media.file_path as string,
        sourceHasAudio: Boolean(media.has_audio),
        selectedAudioStream: mediaAnalysis?.selectedAudioStream ?? 0,
        state: activeState,
        resolution,
        quality,
      });
    }

    res.json({
      job: {
        id: jobId,
        projectId,
        mediaId: media.id,
        status: 'queued',
        progress: 0,
        resolution,
        quality,
        createdAt: now,
      },
    });
  });

  // Downloadable .SRT and .VTT subtitles matching the current edited timeline (and optional ?lang translation track)
  app.get('/api/projects/:id/captions/export', (req, res) => {
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const format = String(req.query.format || 'srt').toLowerCase() === 'vtt' ? 'vtt' : 'srt';
    const lang = typeof req.query.lang === 'string' && req.query.lang !== 'original' ? req.query.lang.trim() : '';
    const activeState = JSON.parse(proj.state_json as string) as ProjectState;
    const media = db
      .prepare('SELECT analysis_json FROM media_assets WHERE id = ?')
      .get(proj.media_id as string) as { analysis_json: string } | undefined;
    const analysis = media ? (JSON.parse(media.analysis_json) as MediaAnalysis) : null;
    const translationTrack = lang ? analysis?.translationTracks?.[lang] : undefined;

    const slug =
      String(proj.title || 'captions')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'captions';
    const suffix = lang ? `.${lang}` : '';

    if (format === 'vtt') {
      const content = buildVttSubtitles(activeState, translationTrack);
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}${suffix}.vtt"`);
      res.send(content);
      return;
    }
    const content = buildSrtSubtitles(activeState, translationTrack);
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}${suffix}.srt"`);
    res.send(content);
  });

  // Project-specific custom vocabulary dictionary
  app.get('/api/projects/:id/vocabulary', (req, res) => {
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const vocab = parseVocabularyInput(proj.vocabulary_json);
    res.json({ vocabulary: vocab });
  });

  app.put('/api/projects/:id/vocabulary', (req, res) => {
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this project.' });
      return;
    }
    const vocab = parseVocabularyInput((req.body || {}).vocabulary);
    const now = new Date().toISOString();
    db.prepare('UPDATE projects SET vocabulary_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(vocab),
      now,
      proj.id,
    );
    const media = db
      .prepare('SELECT analysis_json FROM media_assets WHERE id = ?')
      .get(proj.media_id as string) as { analysis_json: string } | undefined;
    if (media) {
      const analysis = JSON.parse(media.analysis_json) as MediaAnalysis;
      analysis.vocabulary = vocab;
      db.prepare('UPDATE media_assets SET vocabulary_json = ?, analysis_json = ? WHERE id = ?').run(
        JSON.stringify(vocab),
        JSON.stringify(analysis),
        proj.media_id,
      );
    }
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(proj.id) as Record<
      string,
      unknown
    >;
    res.json({ vocabulary: vocab, project: hydrateProjectRow(updated) });
  });

  // Inline manual transcript word correction (updates transcript, captions, and search index)
  app.patch('/api/projects/:id/transcript/word', (req, res) => {
    try {
      const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!proj) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, proj)) {
        res.status(403).json({ error: 'Access denied to this project.' });
        return;
      }
      const { wordId, newWord } = (req.body || {}) as { wordId?: string; newWord?: string };
      if (!wordId || !newWord || !newWord.trim()) {
        res.status(400).json({ error: 'wordId and non-empty newWord are required.' });
        return;
      }
      const result = applyManualWordCorrection({
        projectId: proj.id as string,
        wordId,
        newWord,
      });
      const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(proj.id) as Record<
        string,
        unknown
      >;
      res.json({
        project: hydrateProjectRow(updated),
        analysis: result.analysis,
        updatedWord: result.updatedWord,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to update word.',
      });
    }
  });

  // Project-level retranscribe with optional language override & custom vocabulary
  app.post('/api/projects/:id/retranscribe', async (req, res) => {
    try {
      const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!proj) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, proj)) {
        res.status(403).json({ error: 'Access denied to this project.' });
        return;
      }
      const mediaRow = db
        .prepare('SELECT * FROM media_assets WHERE id = ?')
        .get(proj.media_id as string) as Record<string, unknown> | undefined;
      if (!mediaRow || !fs.existsSync(mediaRow.file_path as string)) {
        res.status(404).json({ error: 'Original source video file not found on disk.' });
        return;
      }

      const { languageOverride, vocabulary, audioStreamIndex } = (req.body || {}) as {
        languageOverride?: string;
        vocabulary?: unknown;
        audioStreamIndex?: number;
      };
      const prevAnalysis = JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis;
      const resolvedVocab =
        vocabulary !== undefined
          ? parseVocabularyInput(vocabulary)
          : parseVocabularyInput(proj.vocabulary_json || mediaRow.vocabulary_json || prevAnalysis.vocabulary);
      const resolvedLang =
        languageOverride !== undefined
          ? languageOverride.trim() || undefined
          : (mediaRow.language_override as string | undefined) || undefined;
      const streamIdx = audioStreamIndex ?? prevAnalysis.selectedAudioStream ?? 0;

      db.prepare('UPDATE media_assets SET vocabulary_json = ?, language_override = ? WHERE id = ?').run(
        JSON.stringify(resolvedVocab),
        resolvedLang && resolvedLang !== 'auto' ? resolvedLang : null,
        mediaRow.id,
      );
      db.prepare('UPDATE projects SET vocabulary_json = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify(resolvedVocab),
        new Date().toISOString(),
        proj.id,
      );

      const { job, promise } = startBackgroundAnalysisJob({
        mediaId: mediaRow.id as string,
        projectId: proj.id as string,
        audioStreamIndex: streamIdx,
        languageOverride: resolvedLang,
        vocabulary: resolvedVocab,
      });

      if (req.query.sync === '1') {
        await promise.catch(() => {});
      }

      const refreshedMedia = db
        .prepare('SELECT analysis_json FROM media_assets WHERE id = ?')
        .get(mediaRow.id) as { analysis_json: string };
      const updatedProj = db.prepare('SELECT * FROM projects WHERE id = ?').get(proj.id) as Record<
        string,
        unknown
      >;
      res.json({
        job: getAnalysisJob(job.id) || job,
        analysis: JSON.parse(refreshedMedia.analysis_json) as MediaAnalysis,
        project: hydrateProjectRow(updatedProj),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Retranscribe failed.' });
    }
  });

  // Optional separate translated caption/transcript track (never overwrites original transcript)
  app.post('/api/projects/:id/translate', async (req, res) => {
    try {
      const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!proj) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, proj)) {
        res.status(403).json({ error: 'Access denied to this project.' });
        return;
      }
      const { targetLanguage } = (req.body || {}) as { targetLanguage?: string };
      if (!targetLanguage || !targetLanguage.trim()) {
        res.status(400).json({ error: 'targetLanguage is required.' });
        return;
      }
      const result = await translateProjectTranscript({
        projectId: proj.id as string,
        targetLanguage: targetLanguage.trim(),
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Translation failed.' });
    }
  });

  // REST alias for AI prompt planning scoped by project id
  app.post('/api/projects/:id/ai/edit', async (req, res) => {
    try {
      const { prompt, currentState } = (req.body || {}) as {
        prompt?: string;
        currentState?: ProjectState;
      };
      if (!prompt) {
        res.status(400).json({ error: 'prompt is required.' });
        return;
      }
      const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
        | Record<string, unknown>
        | undefined;
      if (!proj) {
        res.status(404).json({ error: 'Project not found.' });
        return;
      }
      const ctx = getAuthContext(req);
      if (!canAccessOwnedRecord(ctx, proj)) {
        res.status(403).json({ error: 'Access denied to this project.' });
        return;
      }
      const media = db
        .prepare('SELECT * FROM media_assets WHERE id = ?')
        .get(proj.media_id as string) as Record<string, unknown> | undefined;
      if (!media) {
        res.status(404).json({ error: 'Source media not found.' });
        return;
      }
      const analysis = JSON.parse(media.analysis_json as string) as MediaAnalysis;
      const state = currentState || (JSON.parse(proj.state_json as string) as ProjectState);
      const plan = await planEditFromPrompt(prompt, state, analysis);
      const impact = computeEditImpact(state, analysis, plan);
      const searchHits = plan.searchQuery
        ? searchMediaIndex(analysis, state.segments, plan.searchQuery)
        : [];
      res.json({ plan, impact, searchHits });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'AI planning error.' });
    }
  });

  // =========================================================================
  // /api/v1 Production Worker Job Contract, 202 Async Status & Idempotency-Key
  // =========================================================================
  const registerV1Job = (
    jobId: string,
    kind: 'ingest' | 'import_url' | 'retranscribe' | 'export',
    targetId: string,
    projectId: string | null,
    mediaId: string | null,
  ) => {
    db.prepare(
      `INSERT OR REPLACE INTO v1_jobs (job_id, kind, target_id, project_id, media_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(jobId, kind, targetId, projectId, mediaId, new Date().toISOString());
  };

  const checkIdempotency = (req: Request, res: Response, endpoint: string): string | null => {
    const key = req.header('Idempotency-Key')?.trim();
    if (!key) return null;
    const row = db
      .prepare(
        'SELECT status_code, response_json FROM idempotency_keys WHERE idempotency_key = ? AND method = ? AND path = ?',
      )
      .get(key, req.method, endpoint) as { status_code: number; response_json: string } | undefined;
    if (row) {
      res.status(row.status_code).json(JSON.parse(row.response_json));
      return '__HIT__';
    }
    return key;
  };

  const saveIdempotency = (
    key: string | null,
    method: string,
    endpoint: string,
    statusCode: number,
    body: unknown,
  ) => {
    if (!key || key === '__HIT__') return;
    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (idempotency_key, method, path, status_code, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(key, method, endpoint, statusCode, JSON.stringify(body), new Date().toISOString());
  };

  app.post('/api/v1/media/ingest', upload.single('video'), async (req, res) => {
    const idem = checkIdempotency(req, res, '/api/v1/media/ingest');
    if (idem === '__HIT__') return;
    try {
      const file = req.file;
      if (!file) {
        sendV1Error(res, 400, 'MISSING_FILE', 'No video file was provided in the "video" field.', false);
        return;
      }
      const sourceType = req.body.sourceType === 'recording' ? 'recording' : 'upload';
      const title = (req.body.title as string | undefined)?.trim() || path.parse(file.originalname).name || 'Uploaded Video';
      const requestedStreamIdx = parseInt(String(req.body.audioStreamIndex ?? '0'), 10);
      const audioStreamIndex = Number.isFinite(requestedStreamIdx) ? requestedStreamIdx : 0;
      const languageOverride = (req.body.languageOverride as string | undefined)?.trim() || undefined;
      const vocabulary = parseVocabularyInput(req.body.vocabulary);
      const ctx = getAuthContext(req);
      const mimeType = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : 'video/mp4';

      const result = await createIngestedMediaAndProject({
        filePath: file.path,
        originalFilename: file.originalname,
        mimeType,
        sourceType,
        title,
        audioStreamIndex,
        languageOverride,
        vocabulary,
        ctx,
        waitForSync: false,
      });

      registerV1Job(result.job.id, 'ingest', result.job.id, result.projectId, result.mediaId);
      const payload = {
        job_id: result.job.id,
        media_id: result.mediaId,
        project_id: result.projectId,
        status: 'queued',
        links: {
          job: `/api/v1/jobs/${result.job.id}`,
          project: `/api/projects/${result.projectId}`,
          stream: `/api/media/${result.mediaId}/stream`,
        },
      };
      saveIdempotency(idem, 'POST', '/api/v1/media/ingest', 202, payload);
      res.status(202).json(payload);
    } catch (err) {
      sendV1Error(res, 500, 'INGEST_FAILED', err instanceof Error ? err.message : 'Ingest failed.', true);
    }
  });

  app.post('/api/v1/media/import-url', async (req, res) => {
    const idem = checkIdempotency(req, res, '/api/v1/media/import-url');
    if (idem === '__HIT__') return;
    const { url, title, languageOverride, vocabulary } = (req.body || {}) as {
      url?: string;
      title?: string;
      languageOverride?: string;
      vocabulary?: unknown;
    };
    if (!url || !url.trim()) {
      sendV1Error(res, 400, 'MISSING_URL', 'Request body must include a non-empty "url".', false);
      return;
    }
    const ctx = getAuthContext(req);
    const { importJob } = startUrlImportJob({
      url: url.trim(),
      title,
      userId: ctx.userId,
      guestToken: ctx.guestToken,
      languageOverride: languageOverride?.trim() || undefined,
      vocabulary: parseVocabularyInput(vocabulary),
    });
    await new Promise((r) => setTimeout(r, 80));
    const latest = getUrlImportJob(importJob.id) || importJob;
    if (latest.status === 'failed') {
      sendV1Error(res, 400, 'URL_VALIDATION_FAILED', latest.error || 'URL rejected.', false, { import_id: latest.id });
      return;
    }
    registerV1Job(latest.id, 'import_url', latest.id, latest.projectId || null, latest.mediaId || null);
    const payload = {
      job_id: latest.id,
      import_id: latest.id,
      status: latest.status === 'completed' ? 'succeeded' : 'running',
      links: {
        job: `/api/v1/jobs/${latest.id}`,
        import_status: `/api/url-imports/${latest.id}`,
      },
    };
    saveIdempotency(idem, 'POST', '/api/v1/media/import-url', 202, payload);
    res.status(202).json(payload);
  });

  app.post('/api/v1/projects/:id/retranscribe', (req, res) => {
    const endpoint = `/api/v1/projects/${req.params.id}/retranscribe`;
    const idem = checkIdempotency(req, res, endpoint);
    if (idem === '__HIT__') return;
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      sendV1Error(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.', false);
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      sendV1Error(res, 403, 'FORBIDDEN', 'Access denied to this project.', false);
      return;
    }
    const mediaRow = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(proj.media_id as string) as
      | Record<string, unknown>
      | undefined;
    if (!mediaRow || !fs.existsSync(mediaRow.file_path as string)) {
      sendV1Error(res, 404, 'MEDIA_MISSING', 'Source media file missing on server disk.', false);
      return;
    }
    const { languageOverride, vocabulary, audioStreamIndex } = (req.body || {}) as {
      languageOverride?: string;
      vocabulary?: unknown;
      audioStreamIndex?: number;
    };
    const prevAnalysis = JSON.parse(mediaRow.analysis_json as string) as MediaAnalysis;
    const resolvedVocab =
      vocabulary !== undefined
        ? parseVocabularyInput(vocabulary)
        : parseVocabularyInput(proj.vocabulary_json || mediaRow.vocabulary_json || prevAnalysis.vocabulary);
    const { job } = startBackgroundAnalysisJob({
      mediaId: mediaRow.id as string,
      projectId: proj.id as string,
      audioStreamIndex: audioStreamIndex ?? prevAnalysis.selectedAudioStream ?? 0,
      languageOverride: languageOverride?.trim() || undefined,
      vocabulary: resolvedVocab,
    });
    registerV1Job(job.id, 'retranscribe', job.id, proj.id as string, mediaRow.id as string);
    const payload = {
      job_id: job.id,
      project_id: proj.id,
      status: 'queued',
      links: { job: `/api/v1/jobs/${job.id}`, project: `/api/projects/${proj.id}` },
    };
    saveIdempotency(idem, 'POST', endpoint, 202, payload);
    res.status(202).json(payload);
  });

  app.post('/api/v1/projects/:id/exports', (req, res) => {
    const endpoint = `/api/v1/projects/${req.params.id}/exports`;
    const idem = checkIdempotency(req, res, endpoint);
    if (idem === '__HIT__') return;
    const proj = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!proj) {
      sendV1Error(res, 404, 'PROJECT_NOT_FOUND', 'Project not found.', false);
      return;
    }
    const ctx = getAuthContext(req);
    if (!canAccessOwnedRecord(ctx, proj)) {
      sendV1Error(res, 403, 'FORBIDDEN', 'Access denied to this project.', false);
      return;
    }
    const media = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(proj.media_id as string) as
      | Record<string, unknown>
      | undefined;
    if (!media) {
      sendV1Error(res, 404, 'MEDIA_NOT_FOUND', 'Source media not found.', false);
      return;
    }
    const { state, resolution = '720p', quality = 'balanced' } = (req.body || {}) as {
      state?: ProjectState;
      resolution?: ExportJob['resolution'];
      quality?: ExportJob['quality'];
    };
    const activeState = state || (JSON.parse(proj.state_json as string) as ProjectState);
    const mediaAnalysis = media.analysis_json ? (JSON.parse(media.analysis_json as string) as MediaAnalysis) : null;
    const jobId = `exp-${uuid()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO exports (id, project_id, media_id, status, progress, resolution, quality, created_at)
       VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
    ).run(jobId, proj.id, media.id, resolution, quality, now);

    void runExportJob({
      jobId,
      projectId: proj.id as string,
      mediaId: media.id as string,
      sourceFilePath: media.file_path as string,
      sourceHasAudio: Boolean(media.has_audio),
      selectedAudioStream: mediaAnalysis?.selectedAudioStream ?? 0,
      state: activeState,
      resolution,
      quality,
    });
    registerV1Job(jobId, 'export', jobId, proj.id as string, media.id as string);
    const payload = {
      job_id: jobId,
      project_id: proj.id,
      status: 'queued',
      links: { job: `/api/v1/jobs/${jobId}`, export: `/api/exports/${jobId}` },
    };
    saveIdempotency(idem, 'POST', endpoint, 202, payload);
    res.status(202).json(payload);
  });

  app.get('/api/v1/jobs/:job_id', (req, res) => {
    const jobId = req.params.job_id;
    const reg = db.prepare('SELECT * FROM v1_jobs WHERE job_id = ?').get(jobId) as
      | { job_id: string; kind: string; target_id: string; project_id: string | null; media_id: string | null }
      | undefined;
    const ctx = getAuthContext(req);

    if (reg?.kind === 'import_url' || jobId.startsWith('impurl-')) {
      const impRow = db.prepare('SELECT user_id, guest_token FROM url_imports WHERE id = ?').get(reg?.target_id || jobId) as
        | Record<string, unknown>
        | undefined;
      if (impRow && !canAccessOwnedRecord(ctx, impRow)) {
        sendV1Error(res, 403, 'FORBIDDEN', 'Access denied to this job.', false);
        return;
      }
      const imp = getUrlImportJob(reg?.target_id || jobId);
      if (!imp) {
        sendV1Error(res, 404, 'JOB_NOT_FOUND', 'URL import job not found.', false);
        return;
      }
      res.json({
        job_id: imp.id,
        kind: 'import_url',
        status:
          imp.status === 'completed'
            ? 'succeeded'
            : imp.status === 'failed'
              ? 'failed'
              : imp.status === 'queued'
                ? 'queued'
                : 'running',
        progress: imp.progress,
        result_links: {
          project: imp.projectId ? `/api/projects/${imp.projectId}` : null,
          analysis_job: imp.analysisJobId ? `/api/v1/jobs/${imp.analysisJobId}` : null,
        },
        error: imp.error ? { code: 'URL_IMPORT_ERROR', message: imp.error, retryable: true } : null,
      });
      return;
    }

    if (reg?.kind === 'export' || jobId.startsWith('exp-')) {
      const exp = db.prepare('SELECT * FROM exports WHERE id = ?').get(reg?.target_id || jobId) as
        | Record<string, unknown>
        | undefined;
      if (!exp) {
        sendV1Error(res, 404, 'JOB_NOT_FOUND', 'Export job not found.', false);
        return;
      }
      const proj = db.prepare('SELECT user_id, guest_token, source_type FROM projects p LEFT JOIN media_assets m ON p.media_id = m.id WHERE p.id = ?').get(exp.project_id as string) as
        | Record<string, unknown>
        | undefined;
      if (proj && !canAccessOwnedRecord(ctx, proj)) {
        sendV1Error(res, 403, 'FORBIDDEN', 'Access denied to this export job.', false);
        return;
      }
      res.json({
        job_id: exp.id,
        kind: 'export',
        status:
          exp.status === 'completed'
            ? 'succeeded'
            : exp.status === 'failed'
              ? 'failed'
              : exp.status === 'queued'
                ? 'queued'
                : 'running',
        progress: exp.progress,
        result_links: {
          download: exp.output_url ? `${exp.output_url as string}?dl=1` : null,
          stream: exp.output_url || null,
          blob_url: (exp.blob_url as string | undefined) || null,
        },
        error: exp.error ? { code: 'EXPORT_FAILED', message: exp.error, retryable: true } : null,
      });
      return;
    }

    const analysisJob = getAnalysisJob(reg?.target_id || jobId);
    if (!analysisJob) {
      sendV1Error(res, 404, 'JOB_NOT_FOUND', 'Job not found.', false);
      return;
    }
    const mediaRow = db.prepare('SELECT user_id, guest_token, source_type FROM media_assets WHERE id = ?').get(analysisJob.mediaId) as
      | Record<string, unknown>
      | undefined;
    if (mediaRow && !canAccessOwnedRecord(ctx, mediaRow)) {
      sendV1Error(res, 403, 'FORBIDDEN', 'Access denied to this job.', false);
      return;
    }
    res.json({
      job_id: analysisJob.id,
      kind: reg?.kind || 'ingest',
      status:
        analysisJob.status === 'complete' || analysisJob.status === 'partial'
          ? 'succeeded'
          : analysisJob.status === 'failed' || analysisJob.status === 'cancelled'
            ? 'failed'
            : analysisJob.status === 'queued'
              ? 'queued'
              : 'running',
      progress: analysisJob.overallProgress,
      result_links: {
        project: analysisJob.projectId ? `/api/projects/${analysisJob.projectId}` : null,
        analysis_status: analysisJob.projectId ? `/api/projects/${analysisJob.projectId}/analysis-status` : null,
      },
      error: analysisJob.error
        ? { code: 'TRANSCRIPTION_ERROR', message: analysisJob.error, retryable: true }
        : null,
    });
  });

  // =========================================================================
  // Separate Background Worker Routes (for Google Cloud Run WORKER_MODE=1)
  // + Signed Internal Callbacks back to the Control Plane
  // =========================================================================
  app.get('/worker/health', (req, res) => {
    if (!isAuthorizedWorkerRequest(req.headers.authorization, req.headers['x-worker-secret'] as string | undefined)) {
      res.status(401).json({ error: 'Unauthorized worker request.' });
      return;
    }
    res.json({
      ok: true,
      workerMode: cfg.workerMode,
      geminiConfigured: hasGeminiKey(),
      blobConfigured: isVercelBlobConfigured(),
      ffmpegReady: true,
    });
  });

  app.post('/worker/jobs/analyze', async (req, res) => {
    if (!isAuthorizedWorkerRequest(req.headers.authorization, req.headers['x-worker-secret'] as string | undefined)) {
      res.status(401).json({ error: 'Unauthorized worker request.' });
      return;
    }
    const {
      jobId,
      mediaId,
      projectId,
      sourceBlobUrl,
      filename,
      audioStreamIndex = 0,
      languageOverride,
      vocabulary = [],
      callbackUrl,
    } = (req.body || {}) as {
      jobId?: string;
      mediaId?: string;
      projectId?: string | null;
      sourceBlobUrl?: string;
      filename?: string;
      audioStreamIndex?: number;
      languageOverride?: string;
      vocabulary?: string[];
      callbackUrl?: string;
    };
    if (!jobId || !mediaId || !sourceBlobUrl || !filename) {
      res.status(400).json({ error: 'jobId, mediaId, sourceBlobUrl, and filename are required.' });
      return;
    }

    res.status(202).json({ accepted: true, jobId });

    void (async () => {
      const ext = path.extname(filename) || '.mp4';
      const localPath = path.join(UPLOADS_DIR, `${uuid()}${ext}`);
      try {
        await downloadBlobToFile(sourceBlobUrl, localPath);
        const { analysis, thumbnailUrl } = await prepareFastMediaRecord({
          mediaId,
          filePath: localPath,
          filename,
          audioStreamIndex,
        });
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO media_assets
           (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, vocabulary_json, language_override, blob_url, created_at)
           VALUES (?, NULL, 'worker', 'upload', ?, 'video/mp4', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          mediaId,
          filename,
          localPath,
          thumbnailUrl || '/api/demos/demo-keynote/thumb',
          analysis.durationSec,
          analysis.width,
          analysis.height,
          analysis.hasAudio ? 1 : 0,
          analysis.analysisMode,
          JSON.stringify(analysis),
          JSON.stringify(vocabulary),
          languageOverride || null,
          sourceBlobUrl,
          now,
        );
        db.prepare(
          `INSERT OR IGNORE INTO analysis_jobs
           (id, media_id, project_id, selected_audio_stream, language_override, status, overall_progress, audio_extraction_status, transcription_status, chunk_total, chunk_completed, chunk_failed, alignment_status, caption_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', 10, 'pending', 'pending', 0, 0, 0, 'pending', 'pending', ?, ?)`,
        ).run(jobId, mediaId, projectId ?? null, audioStreamIndex, languageOverride || 'auto', now, now);

        const finalAnalysis = await executeAnalysisJob(jobId, {
          audioStreamIndex,
          languageOverride,
          vocabulary,
        });

        let thumbBlobUrl: string | undefined;
        const thumbPath = path.join(THUMBS_DIR, `${mediaId}.jpg`);
        if (isVercelBlobConfigured() && fs.existsSync(thumbPath)) {
          const uploadedThumb = await uploadFileToBlob({
            localPath: thumbPath,
            blobPathname: `thumbs/${mediaId}.jpg`,
            contentType: 'image/jpeg',
          }).catch(() => null);
          thumbBlobUrl = uploadedThumb?.url;
        }

        if (callbackUrl) {
          await sendWorkerCallback(callbackUrl, {
            type: 'analysis_progress',
            jobId,
            mediaId,
            projectId: projectId ?? null,
            status: finalAnalysis.transcriptionStatus || 'complete',
            progress: 100,
            analysis: finalAnalysis,
            thumbnailBlobUrl: thumbBlobUrl,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Worker analysis error';
        updateAnalysisJobRow(jobId, { status: 'failed', transcriptionStatus: 'failed', error: msg });
        if (callbackUrl) {
          await sendWorkerCallback(callbackUrl, {
            type: 'analysis_progress',
            jobId,
            mediaId,
            projectId: projectId ?? null,
            status: 'failed',
            progress: 0,
            error: msg,
          });
        }
      } finally {
        if (fs.existsSync(localPath)) {
          fs.rmSync(localPath, { force: true });
        }
      }
    })();
  });

  app.post('/worker/jobs/import-url', (req, res) => {
    if (!isAuthorizedWorkerRequest(req.headers.authorization, req.headers['x-worker-secret'] as string | undefined)) {
      res.status(401).json({ error: 'Unauthorized worker request.' });
      return;
    }
    const { url, title, userId = null, guestToken = null, languageOverride, vocabulary, callbackUrl } = (req.body || {}) as {
      url?: string;
      title?: string;
      userId?: string | null;
      guestToken?: string | null;
      languageOverride?: string;
      vocabulary?: string[];
      callbackUrl?: string;
    };
    if (!url) {
      res.status(400).json({ error: 'url is required.' });
      return;
    }
    const { importJob, promise } = startUrlImportJob({
      url,
      title,
      userId,
      guestToken,
      languageOverride,
      vocabulary,
    });
    res.status(202).json({ accepted: true, importId: importJob.id });

    void promise
      .then(async (done) => {
        if (!callbackUrl) return;
        const mediaRow = done.mediaId
          ? (db.prepare('SELECT blob_url, thumbnail_url, analysis_json FROM media_assets WHERE id = ?').get(done.mediaId) as
              | { blob_url?: string; thumbnail_url?: string; analysis_json?: string }
              | undefined)
          : undefined;
        await sendWorkerCallback(callbackUrl, {
          type: 'url_import_progress',
          importId: done.id,
          status: done.status,
          progress: done.progress,
          bytesDownloaded: done.bytesDownloaded,
          totalBytes: done.totalBytes,
          mediaId: done.mediaId,
          projectId: done.projectId,
          analysisJobId: done.analysisJobId,
          sourceBlobUrl: mediaRow?.blob_url,
          thumbnailBlobUrl: mediaRow?.thumbnail_url,
          analysis: mediaRow?.analysis_json ? (JSON.parse(mediaRow.analysis_json) as MediaAnalysis) : undefined,
        });
      })
      .catch(async (err) => {
        if (callbackUrl) {
          await sendWorkerCallback(callbackUrl, {
            type: 'url_import_progress',
            importId: importJob.id,
            status: 'failed',
            progress: 0,
            error: err instanceof Error ? err.message : 'Worker URL import failed',
          });
        }
      });
  });

  app.post('/worker/jobs/export', async (req, res) => {
    if (!isAuthorizedWorkerRequest(req.headers.authorization, req.headers['x-worker-secret'] as string | undefined)) {
      res.status(401).json({ error: 'Unauthorized worker request.' });
      return;
    }
    const {
      jobId,
      projectId,
      mediaId,
      sourceBlobUrl,
      sourceHasAudio = true,
      selectedAudioStream = 0,
      state,
      resolution = '720p',
      quality = 'balanced',
      customMusicBlobUrl,
      callbackUrl,
    } = (req.body || {}) as {
      jobId?: string;
      projectId?: string;
      mediaId?: string;
      sourceBlobUrl?: string;
      sourceHasAudio?: boolean;
      selectedAudioStream?: number;
      state?: ProjectState;
      resolution?: ExportJob['resolution'];
      quality?: ExportJob['quality'];
      customMusicBlobUrl?: string;
      callbackUrl?: string;
    };
    if (!jobId || !projectId || !mediaId || !sourceBlobUrl || !state) {
      res.status(400).json({ error: 'jobId, projectId, mediaId, sourceBlobUrl, and state are required.' });
      return;
    }

    res.status(202).json({ accepted: true, jobId });

    void (async () => {
      const localPath = path.join(UPLOADS_DIR, `${uuid()}.mp4`);
      try {
        await downloadBlobToFile(sourceBlobUrl, localPath);
        const now = new Date().toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO exports (id, project_id, media_id, status, progress, resolution, quality, created_at)
           VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)`,
        ).run(jobId, projectId, mediaId, resolution, quality, now);

        const patchedState: ProjectState = customMusicBlobUrl
          ? { ...state, audio: { ...state.audio, customMusicUrl: customMusicBlobUrl } }
          : state;

        await runExportJob({
          jobId,
          projectId,
          mediaId,
          sourceFilePath: localPath,
          sourceHasAudio,
          selectedAudioStream,
          state: patchedState,
          resolution,
          quality,
        });

        const expRow = db.prepare('SELECT * FROM exports WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
        if (callbackUrl && expRow) {
          await sendWorkerCallback(callbackUrl, {
            type: 'export_progress',
            jobId,
            status: expRow.status as string,
            progress: Number(expRow.progress ?? 0),
            outputUrl: (expRow.output_url as string | undefined) || undefined,
            blobUrl: (expRow.blob_url as string | undefined) || undefined,
            fileSizeBytes: expRow.file_size_bytes ? Number(expRow.file_size_bytes) : undefined,
            durationSec: expRow.duration_sec ? Number(expRow.duration_sec) : undefined,
            error: (expRow.error as string | undefined) || undefined,
          });
        }
      } catch (err) {
        if (callbackUrl) {
          await sendWorkerCallback(callbackUrl, {
            type: 'export_progress',
            jobId,
            status: 'failed',
            progress: 0,
            error: err instanceof Error ? err.message : 'Worker export error',
          });
        }
      } finally {
        if (fs.existsSync(localPath)) {
          fs.rmSync(localPath, { force: true });
        }
      }
    })();
  });

  app.get('/worker/jobs/:jobId', (req, res) => {
    if (!isAuthorizedWorkerRequest(req.headers.authorization, req.headers['x-worker-secret'] as string | undefined)) {
      res.status(401).json({ error: 'Unauthorized worker request.' });
      return;
    }
    const analysisJob = getAnalysisJob(req.params.jobId);
    if (analysisJob) {
      res.json({ kind: 'analysis', job: analysisJob });
      return;
    }
    const exp = db.prepare('SELECT * FROM exports WHERE id = ?').get(req.params.jobId) as Record<string, unknown> | undefined;
    if (exp) {
      res.json({ kind: 'export', job: exp });
      return;
    }
    res.status(404).json({ error: 'Worker job not found.' });
  });

  app.post('/api/internal/worker-callback', (req, res) => {
    if (!isAuthorizedWorkerRequest(req.headers.authorization, req.headers['x-worker-secret'] as string | undefined)) {
      res.status(401).json({ error: 'Unauthorized callback.' });
      return;
    }
    const event = (req.body || {}) as {
      type?: string;
      jobId?: string;
      mediaId?: string;
      projectId?: string | null;
      status?: string;
      progress?: number;
      analysis?: MediaAnalysis;
      thumbnailBlobUrl?: string;
      outputUrl?: string;
      blobUrl?: string;
      fileSizeBytes?: number;
      durationSec?: number;
      error?: string;
    };

    if (event.type === 'analysis_progress' && event.jobId) {
      updateAnalysisJobRow(event.jobId, {
        status: event.status as never,
        overallProgress: event.progress,
        error: event.error,
        transcriptionStatus: event.status === 'failed' ? 'failed' : event.progress === 100 ? 'completed' : 'running',
        captionStatus: event.progress === 100 ? 'completed' : undefined,
      });
      if (event.analysis && event.mediaId) {
        db.prepare('UPDATE media_assets SET analysis_mode = ?, analysis_json = ?, thumbnail_url = COALESCE(?, thumbnail_url) WHERE id = ?').run(
          event.analysis.analysisMode,
          JSON.stringify(event.analysis),
          event.thumbnailBlobUrl || null,
          event.mediaId,
        );
        if (event.projectId) {
          const proj = db.prepare('SELECT state_json FROM projects WHERE id = ?').get(event.projectId) as
            | { state_json: string }
            | undefined;
          if (proj) {
            const cur = JSON.parse(proj.state_json) as ProjectState;
            const fresh = createInitialProjectState(event.analysis);
            const nextState: ProjectState = {
              ...fresh,
              audio: cur.audio,
              overlays: cur.overlays,
              trackVisibility: cur.trackVisibility,
              trackLocks: cur.trackLocks,
            };
            db.prepare('UPDATE projects SET state_json = ?, versions_json = ?, thumbnail_url = COALESCE(?, thumbnail_url), updated_at = ? WHERE id = ?').run(
              JSON.stringify(nextState),
              JSON.stringify(generateThreeVersions(event.analysis)),
              event.thumbnailBlobUrl || null,
              new Date().toISOString(),
              event.projectId,
            );
          }
        }
      }
      res.json({ ok: true });
      return;
    }

    if (event.type === 'export_progress' && event.jobId) {
      const cur = db.prepare('SELECT * FROM exports WHERE id = ?').get(event.jobId) as Record<string, unknown> | undefined;
      if (cur) {
        db.prepare(
          `UPDATE exports SET status = ?, progress = ?, output_url = ?, blob_url = ?, file_size_bytes = ?, duration_sec = ?, error = ? WHERE id = ?`,
        ).run(
          event.status ?? cur.status,
          event.progress ?? cur.progress,
          event.outputUrl ?? cur.output_url ?? `/api/exports/${event.jobId}/download`,
          event.blobUrl ?? cur.blob_url,
          event.fileSizeBytes ?? cur.file_size_bytes,
          event.durationSec ?? cur.duration_sec,
          event.error ?? cur.error,
          event.jobId,
        );
      }
      res.json({ ok: true });
      return;
    }

    res.json({ ok: true });
  });

  app.get('/api/exports/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM exports WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Export job not found.' });
      return;
    }
    const proj = db.prepare('SELECT user_id, guest_token FROM projects WHERE id = ?').get(row.project_id as string) as
      | Record<string, unknown>
      | undefined;
    const ctx = getAuthContext(req);
    if (proj && !canAccessOwnedRecord(ctx, proj)) {
      res.status(403).json({ error: 'Access denied to this export job.' });
      return;
    }
    res.json({
      job: {
        id: row.id,
        projectId: row.project_id,
        mediaId: row.media_id,
        status: row.status,
        progress: row.progress,
        resolution: row.resolution,
        quality: row.quality,
        outputUrl: row.output_url,
        blobUrl: row.blob_url,
        fileSizeBytes: row.file_size_bytes,
        durationSec: row.duration_sec,
        error: row.error,
        createdAt: row.created_at,
      },
    });
  });

  app.get('/api/exports/:id/download', (req, res) => {
    const row = db.prepare('SELECT output_path, blob_url, status FROM exports WHERE id = ?').get(req.params.id) as
      | { output_path?: string; blob_url?: string; status: string }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Exported video not found.' });
      return;
    }
    if ((!row.output_path || !fs.existsSync(row.output_path)) && row.blob_url) {
      res.redirect(302, row.blob_url);
      return;
    }
    if (!row.output_path || !fs.existsSync(row.output_path)) {
      res.status(404).json({ error: 'Exported video not found.' });
      return;
    }
    if (req.query.dl === '1') {
      res.download(row.output_path, `editmind-export-${req.params.id.slice(0, 8)}.mp4`);
      return;
    }
    streamMediaWithRanges(req, res, row.output_path, 'video/mp4');
  });

  // Explicit JSON error handler (handles Multer upload limit 413 and file filter rejections cleanly)
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Uploaded file exceeds the 2 GB server upload limit.'
          : err.message;
      res.status(status).json({ error: msg, code: err.code });
      return;
    }
    const msg = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(500).json({ error: msg });
  });

  // Mount Vite middleware in dev, or serve dist/ in production
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[EDITMIND AI] Full-stack server running at http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start EDITMIND AI server:', err);
  process.exit(1);
});
