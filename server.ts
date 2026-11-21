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
import { planEditFromPrompt } from './server/aiEditor';
import { getAppConfig, SUPPORTED_LANGUAGES } from './server/config';
import { db, DEMOS_DIR, EXPORTS_DIR, MUSIC_DIR, THUMBS_DIR, UPLOADS_DIR } from './server/db';
import { ensureDemoLibraryReady, getDemoCatalogMeta } from './server/demoGenerator';
import { runExportJob } from './server/exporter';
import { hasGeminiKey } from './server/geminiClient';
import {
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
} from './server/transcriber';
import { getUrlImportJob, startUrlImportJob } from './server/urlImporter';

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

function getAuthContext(req: Request): { userId: string | null; guestToken: string | null } {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const row = db
      .prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?')
      .get(token) as { user_id: string; expires_at: string } | undefined;
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return { userId: row.user_id, guestToken: null };
    }
  }
  const guest = (req.headers['x-guest-id'] as string) || null;
  return { userId: null, guestToken: guest };
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

  // Configurable CORS middleware for split Vercel frontend + dedicated backend worker
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (cfg.corsOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-guest-id, Idempotency-Key, Range',
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Build / verify bundled demo videos without blocking port 3000 bind, and resume any interrupted analysis jobs
  const demoReadyPromise = ensureDemoLibraryReady()
    .then(() => {
      console.log('[EDITMIND AI] Demo library ready.');
      resumeIncompleteAnalysisJobs();
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
    const safeName = path.basename(req.params.filename);
    const thumbPath = path.join(THUMBS_DIR, safeName);
    if (!fs.existsSync(thumbPath)) {
      res.status(404).end();
      return;
    }
    res.sendFile(thumbPath);
  });

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
      const mediaId = `med-${uuid()}`;
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

      const { analysis, thumbnailUrl } = await prepareFastMediaRecord({
        mediaId,
        filePath: file.path,
        filename: file.originalname,
        audioStreamIndex,
      });
      analysis.vocabulary = vocabulary;
      analysis.selectedLanguageOverride = languageOverride || 'auto';

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO media_assets
         (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, vocabulary_json, language_override, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mediaId,
        ctx.userId,
        ctx.guestToken,
        sourceType,
        file.originalname,
        mimeType,
        file.path,
        thumbnailUrl || '/api/demos/demo-keynote/thumb',
        analysis.durationSec,
        analysis.width,
        analysis.height,
        analysis.hasAudio ? 1 : 0,
        analysis.analysisMode,
        JSON.stringify(analysis),
        JSON.stringify(vocabulary),
        languageOverride || null,
        now,
      );

      // Create project linked strictly to this unique mediaId
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
        thumbnailUrl,
        JSON.stringify(initialState),
        JSON.stringify(initialHistory),
        JSON.stringify(versions),
        JSON.stringify(vocabulary),
        now,
        now,
      );

      const { job, promise } = startBackgroundAnalysisJob({
        mediaId,
        projectId,
        audioStreamIndex,
        languageOverride,
        vocabulary,
      });

      if (req.query.sync === '1') {
        await promise.catch(() => {});
      }

      const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<
        string,
        unknown
      >;
      res.json({
        project: hydrateProjectRow(projectRow),
        job: getAnalysisJob(job.id) || job,
      });
    } catch (err) {
      console.error('Ingest failed:', err);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to process uploaded video.',
      });
    }
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
    const job = getUrlImportJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'URL import job not found.' });
      return;
    }
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
    requestCancelAnalysisJob(job.id);
    res.json({ ok: true, job: getAnalysisJob(job.id) });
  });

  // Upload real background music audio file for project
  app.post('/api/projects/:id/music', musicUpload.single('audio'), async (req, res) => {
    try {
      const file = req.file;
      if (!file) {
        res.status(400).json({ error: 'No audio file provided.' });
        return;
      }
      const meta = await probeVideoFile(file.path).catch(() => ({ durationSec: 30 }));
      const storedFilename = path.basename(file.path);
      res.json({
        url: `/api/music/${storedFilename}`,
        filename: file.originalname,
        storedFilename,
        durationSec: meta.durationSec || 30,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to upload music track.' });
    }
  });

  app.get('/api/music/:filename', (req, res) => {
    const safeName = path.basename(req.params.filename);
    const musicPath = path.join(MUSIC_DIR, safeName);
    const ext = path.extname(safeName).toLowerCase();
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
  app.post('/api/exports', (req, res) => {
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
    const proj = db.prepare('SELECT vocabulary_json, media_id FROM projects WHERE id = ?').get(req.params.id) as
      | { vocabulary_json?: string; media_id: string }
      | undefined;
    if (!proj) {
      res.status(404).json({ error: 'Project not found.' });
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
    underlyingId: string,
    underlyingTable: 'analysis_jobs' | 'url_imports' | 'exports',
  ) => {
    db.prepare(
      `INSERT OR REPLACE INTO v1_jobs (id, kind, underlying_id, underlying_table, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(jobId, kind, underlyingId, underlyingTable, new Date().toISOString());
  };

  const checkIdempotency = (req: Request, res: Response, endpoint: string): string | null => {
    const key = req.header('Idempotency-Key')?.trim();
    if (!key) return null;
    const row = db
      .prepare('SELECT status_code, response_json FROM idempotency_keys WHERE key = ? AND method = ? AND path = ?')
      .get(key, req.method, endpoint) as { status_code: number; response_json: string } | undefined;
    if (row) {
      res.status(row.status_code).json(JSON.parse(row.response_json));
      return '__HIT__';
    }
    return key;
  };

  const saveIdempotency = (key: string | null, method: string, endpoint: string, statusCode: number, body: unknown) => {
    if (!key || key === '__HIT__') return;
    db.prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, method, path, status_code, response_json, created_at)
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
      const mediaId = `med-${uuid()}`;
      const mimeType = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : 'video/mp4';

      const { analysis, thumbnailUrl } = await prepareFastMediaRecord({
        mediaId,
        filePath: file.path,
        filename: file.originalname,
        audioStreamIndex,
      });
      analysis.vocabulary = vocabulary;
      analysis.selectedLanguageOverride = languageOverride || 'auto';

      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO media_assets
         (id, user_id, guest_token, source_type, filename, mime_type, file_path, thumbnail_url, duration_sec, width, height, has_audio, analysis_mode, analysis_json, vocabulary_json, language_override, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        mediaId, ctx.userId, ctx.guestToken, sourceType, file.originalname, mimeType, file.path,
        thumbnailUrl || '/api/demos/demo-keynote/thumb', analysis.durationSec, analysis.width, analysis.height,
        analysis.hasAudio ? 1 : 0, analysis.analysisMode, JSON.stringify(analysis), JSON.stringify(vocabulary),
        languageOverride || null, now,
      );

      const projectId = `prj-${uuid()}`;
      const initialState = createInitialProjectState(analysis);
      const versions = generateThreeVersions(analysis);
      const initialHistory: HistoryEntry[] = [
        { id: uuid(), timestamp: now, label: 'Project Created', durationAfter: initialState.duration, stateSnapshot: initialState },
      ];
      db.prepare(
        `INSERT INTO projects
         (id, user_id, guest_token, title, media_id, thumbnail_url, state_json, history_json, history_index, versions_json, vocabulary_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        projectId, ctx.userId, ctx.guestToken, title, mediaId, thumbnailUrl, JSON.stringify(initialState),
        JSON.stringify(initialHistory), JSON.stringify(versions), JSON.stringify(vocabulary), now, now,
      );

      const { job } = startBackgroundAnalysisJob({
        mediaId,
        projectId,
        audioStreamIndex,
        languageOverride,
        vocabulary,
      });
      registerV1Job(job.id, 'ingest', job.id, 'analysis_jobs');
      const payload = {
        job_id: job.id,
        media_id: mediaId,
        project_id: projectId,
        status: 'queued',
        links: {
          job: `/api/v1/jobs/${job.id}`,
          project: `/api/projects/${projectId}`,
          stream: `/api/media/${mediaId}/stream`,
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
    registerV1Job(latest.id, 'import_url', latest.id, 'url_imports');
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
    registerV1Job(job.id, 'retranscribe', job.id, 'analysis_jobs');
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
    registerV1Job(jobId, 'export', jobId, 'exports');
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
    const reg = db.prepare('SELECT * FROM v1_jobs WHERE id = ?').get(jobId) as
      | { id: string; kind: string; underlying_id: string; underlying_table: string }
      | undefined;

    if (reg?.underlying_table === 'url_imports' || jobId.startsWith('imp-')) {
      const imp = getUrlImportJob(reg?.underlying_id || jobId);
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

    if (reg?.underlying_table === 'exports' || jobId.startsWith('exp-')) {
      const exp = db.prepare('SELECT * FROM exports WHERE id = ?').get(reg?.underlying_id || jobId) as
        | Record<string, unknown>
        | undefined;
      if (!exp) {
        sendV1Error(res, 404, 'JOB_NOT_FOUND', 'Export job not found.', false);
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
        },
        error: exp.error ? { code: 'EXPORT_FAILED', message: exp.error, retryable: true } : null,
      });
      return;
    }

    const analysisJob = getAnalysisJob(reg?.underlying_id || jobId);
    if (!analysisJob) {
      sendV1Error(res, 404, 'JOB_NOT_FOUND', 'Job not found.', false);
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

  app.get('/api/exports/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM exports WHERE id = ?').get(req.params.id) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Export job not found.' });
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
        fileSizeBytes: row.file_size_bytes,
        durationSec: row.duration_sec,
        error: row.error,
        createdAt: row.created_at,
      },
    });
  });

  app.get('/api/exports/:id/download', (req, res) => {
    const row = db.prepare('SELECT output_path, status FROM exports WHERE id = ?').get(req.params.id) as
      | { output_path?: string; status: string }
      | undefined;
    if (!row || !row.output_path || !fs.existsSync(row.output_path)) {
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
