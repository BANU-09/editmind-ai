import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { getAppConfig } from './config';

const cfg = getAppConfig();
const STORAGE_DIR = cfg.storageDir;
export const DEMOS_DIR = path.join(STORAGE_DIR, 'demos');
export const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');
export const THUMBS_DIR = path.join(STORAGE_DIR, 'thumbs');
export const EXPORTS_DIR = path.join(STORAGE_DIR, 'exports');
export const MUSIC_DIR = path.join(STORAGE_DIR, 'music');
export const AUDIO_DIR = process.env.ANALYSIS_AUDIO_DIR || path.join(STORAGE_DIR, 'audio');
export const TEMP_DIR = cfg.tempMediaDir;

for (const dir of [STORAGE_DIR, DEMOS_DIR, UPLOADS_DIR, THUMBS_DIR, EXPORTS_DIR, MUSIC_DIR, AUDIO_DIR, TEMP_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const DB_PATH = path.join(STORAGE_DIR, 'editmind.db');
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    guest_token TEXT,
    source_type TEXT NOT NULL,
    source_url TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    thumbnail_url TEXT NOT NULL,
    duration_sec REAL NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    has_audio INTEGER NOT NULL,
    analysis_mode TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    vocabulary_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    guest_token TEXT,
    title TEXT NOT NULL,
    media_id TEXT NOT NULL,
    thumbnail_url TEXT NOT NULL,
    state_json TEXT NOT NULL,
    history_json TEXT NOT NULL,
    history_index INTEGER NOT NULL,
    versions_json TEXT NOT NULL,
    vocabulary_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (media_id) REFERENCES media_assets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS exports (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL,
    resolution TEXT NOT NULL,
    quality TEXT NOT NULL,
    output_path TEXT,
    output_url TEXT,
    file_size_bytes INTEGER,
    duration_sec REAL,
    error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS analysis_jobs (
    id TEXT PRIMARY KEY,
    media_id TEXT NOT NULL,
    project_id TEXT,
    selected_audio_stream INTEGER NOT NULL DEFAULT 0,
    language_override TEXT,
    detected_language TEXT,
    status TEXT NOT NULL,
    overall_progress INTEGER NOT NULL DEFAULT 0,
    audio_extraction_status TEXT NOT NULL DEFAULT 'pending',
    transcription_status TEXT NOT NULL DEFAULT 'pending',
    chunk_total INTEGER NOT NULL DEFAULT 0,
    chunk_completed INTEGER NOT NULL DEFAULT 0,
    chunk_failed INTEGER NOT NULL DEFAULT 0,
    alignment_status TEXT NOT NULL DEFAULT 'pending',
    caption_status TEXT NOT NULL DEFAULT 'pending',
    provider_used TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (media_id) REFERENCES media_assets(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS transcription_chunks (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    source_start REAL NOT NULL,
    source_end REAL NOT NULL,
    overlap_before REAL NOT NULL DEFAULT 0,
    overlap_after REAL NOT NULL DEFAULT 0,
    wav_path TEXT NOT NULL,
    compressed_path TEXT,
    status TEXT NOT NULL,
    provider TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    raw_text TEXT,
    language TEXT,
    words_json TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES analysis_jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS url_imports (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    user_id TEXT,
    guest_token TEXT,
    title TEXT,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    bytes_downloaded INTEGER NOT NULL DEFAULT 0,
    total_bytes INTEGER,
    media_id TEXT,
    project_id TEXT,
    analysis_job_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    idempotency_key TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (idempotency_key, method, path)
  );

  CREATE TABLE IF NOT EXISTS v1_jobs (
    job_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    project_id TEXT,
    media_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS multipart_uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    guest_token TEXT,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    chunk_size_bytes INTEGER NOT NULL,
    total_parts INTEGER NOT NULL,
    received_parts_json TEXT NOT NULL DEFAULT '[]',
    staging_dir TEXT NOT NULL,
    source_type TEXT NOT NULL,
    title TEXT NOT NULL,
    language_override TEXT,
    vocabulary_json TEXT NOT NULL DEFAULT '[]',
    audio_stream_index INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

// Safe incremental column migrations for pre-existing editmind.db files
const migrations: string[] = [
  "ALTER TABLE exports ADD COLUMN render_request_json TEXT",
  "ALTER TABLE multipart_uploads ADD COLUMN project_id TEXT",
  "ALTER TABLE analysis_jobs ADD COLUMN metrics_json TEXT",
  "ALTER TABLE media_assets ADD COLUMN upload_fingerprint TEXT",
  "CREATE INDEX IF NOT EXISTS media_upload_fingerprint ON media_assets(upload_fingerprint)",
  "ALTER TABLE media_assets ADD COLUMN source_url TEXT",
  "ALTER TABLE media_assets ADD COLUMN vocabulary_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE media_assets ADD COLUMN language_override TEXT",
  "ALTER TABLE media_assets ADD COLUMN blob_url TEXT",
  "ALTER TABLE media_assets ADD COLUMN blob_pathname TEXT",
  "ALTER TABLE projects ADD COLUMN vocabulary_json TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE analysis_jobs ADD COLUMN language_override TEXT",
  "ALTER TABLE analysis_jobs ADD COLUMN detected_language TEXT",
  "ALTER TABLE exports ADD COLUMN blob_url TEXT",
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch {
    // Column already exists
  }
}

