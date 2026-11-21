import path from 'path';

export interface LanguageOption {
  code: string;
  label: string;
  nativeLabel: string;
  whisperLanguage: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'auto', label: 'Auto-Detect', nativeLabel: 'Auto-Detect', whisperLanguage: 'auto' },
  { code: 'en', label: 'English', nativeLabel: 'English', whisperLanguage: 'english' },
  { code: 'en-IN', label: 'Indian English', nativeLabel: 'English (India)', whisperLanguage: 'english' },
  { code: 'hi', label: 'Hindi', nativeLabel: 'हिन्दी (Hindi)', whisperLanguage: 'hindi' },
  { code: 'ta', label: 'Tamil', nativeLabel: 'தமிழ் (Tamil)', whisperLanguage: 'tamil' },
  { code: 'te', label: 'Telugu', nativeLabel: 'తెలుగు (Telugu)', whisperLanguage: 'telugu' },
  { code: 'kn', label: 'Kannada', nativeLabel: 'ಕನ್ನಡ (Kannada)', whisperLanguage: 'kannada' },
  { code: 'ml', label: 'Malayalam', nativeLabel: 'മലയാളം (Malayalam)', whisperLanguage: 'malayalam' },
  { code: 'bn', label: 'Bengali', nativeLabel: 'বাংলা (Bengali)', whisperLanguage: 'bengali' },
  { code: 'mr', label: 'Marathi', nativeLabel: 'मराठी (Marathi)', whisperLanguage: 'marathi' },
  { code: 'gu', label: 'Gujarati', nativeLabel: 'ગુજરાતી (Gujarati)', whisperLanguage: 'gujarati' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español', whisperLanguage: 'spanish' },
  { code: 'fr', label: 'French', nativeLabel: 'Français', whisperLanguage: 'french' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch', whisperLanguage: 'german' },
  { code: 'ja', label: 'Japanese', nativeLabel: '日本語', whisperLanguage: 'japanese' },
  { code: 'ko', label: 'Korean', nativeLabel: '한국어', whisperLanguage: 'korean' },
  { code: 'zh', label: 'Chinese', nativeLabel: '中文', whisperLanguage: 'chinese' },
  { code: 'ar', label: 'Arabic', nativeLabel: 'العربية', whisperLanguage: 'arabic' },
  { code: 'pt', label: 'Portuguese', nativeLabel: 'Português', whisperLanguage: 'portuguese' },
];

export function resolveLanguageMeta(code?: string): LanguageOption {
  const normalized = (code || 'auto').trim();
  const lower = normalized.toLowerCase();
  const exact = SUPPORTED_LANGUAGES.find(
    (l) => l.code.toLowerCase() === lower || l.label.toLowerCase() === lower || l.whisperLanguage.toLowerCase() === lower,
  );
  if (exact) return exact;

  // Match ISO prefix like hi-IN -> hi, ta-IN -> ta, en-US -> en
  const prefix = lower.split('-')[0];
  const byPrefix = SUPPORTED_LANGUAGES.find((l) => l.code.toLowerCase() === prefix);
  if (byPrefix) return byPrefix;

  return {
    code: normalized || 'en',
    label: normalized ? normalized.toUpperCase() : 'English',
    nativeLabel: normalized || 'English',
    whisperLanguage: prefix || 'english',
  };
}

export const STRICT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // Strictly 2 GB (2,147,483,648 bytes)

export type SttProviderMode = 'auto' | 'gemini' | 'whisper' | 'mock';

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function parseBoundedFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function getAppConfig() {
  const requestedMax = Number(process.env.MAX_UPLOAD_BYTES || STRICT_MAX_UPLOAD_BYTES);
  // Enforce strict 2 GB ceiling: never allow unlimited or >2 GB upload size
  const maxUploadBytes = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.min(STRICT_MAX_UPLOAD_BYTES, requestedMax)
    : STRICT_MAX_UPLOAD_BYTES;

  const envProvider = (process.env.STT_PROVIDER || '').trim().toLowerCase();
  const sttProvider: SttProviderMode =
    process.env.FORCE_LOCAL_STT === '1'
      ? 'whisper'
      : envProvider === 'gemini' || envProvider === 'whisper' || envProvider === 'mock'
        ? (envProvider as SttProviderMode)
        : 'auto';

  const storageDir = path.resolve(process.cwd(), process.env.STORAGE_DIR || 'storage');
  const tempMediaDir = process.env.TEMP_MEDIA_DIR
    ? path.resolve(process.cwd(), process.env.TEMP_MEDIA_DIR)
    : path.join(storageDir, '.tmp');

  return {
    port: parseBoundedInt(process.env.PORT, 3000, 1, 65535),
    maxUploadBytes,
    allowedMediaFormats: (process.env.ALLOWED_MEDIA_FORMATS || 'mp4,webm,mov,mkv,ogv,m4v')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sttProvider,
    sttGeminiModel: process.env.STT_GEMINI_MODEL || 'gemini-3.5-transcribe',
    sttWhisperModel: process.env.STT_WHISPER_MODEL || 'Xenova/whisper-base',
    verifyModel: process.env.VERIFY_MODEL || 'gemini-4-hydrogen',
    langDetectModel: process.env.LANG_DETECT_MODEL || 'gemini-4-hydrogen',
    translateModel: process.env.TRANSLATE_MODEL || 'gemini-4-hydrogen',
    editPlannerModel: process.env.EDIT_PLANNER_MODEL || 'gemini-4-hydrogen',
    chunkTargetSec: parseBoundedFloat(process.env.AUDIO_CHUNK_TARGET_SEC, 24, 10, 45),
    chunkMinSec: parseBoundedFloat(process.env.AUDIO_CHUNK_MIN_SEC, 12, 5, 25),
    chunkMaxSec: parseBoundedFloat(process.env.AUDIO_CHUNK_MAX_SEC, 30, 15, 60),
    chunkOverlapSec: parseBoundedFloat(process.env.AUDIO_CHUNK_OVERLAP_SEC, 1.25, 0.25, 3),
    sttConcurrency: parseBoundedInt(process.env.STT_CONCURRENCY, 2, 1, 6),
    sttRetryCount: parseBoundedInt(process.env.STT_RETRY_COUNT, 3, 1, 5),
    sttTimeoutMs: parseBoundedInt(process.env.STT_TIMEOUT_MS, 35000, 5000, 120000),
    verifyPassEnabled: process.env.STT_VERIFY_PASS !== '0',
    storageDir,
    tempMediaDir,
    hfCacheDir: process.env.HF_CACHE_DIR
      ? path.resolve(process.cwd(), process.env.HF_CACHE_DIR)
      : path.join(storageDir, '.hf_cache'),
    urlImportTimeoutMs: parseBoundedInt(process.env.URL_IMPORT_TIMEOUT_MS, 180000, 5000, 900000),
    urlImportMaxRedirects: parseBoundedInt(process.env.URL_IMPORT_MAX_REDIRECTS, 5, 0, 10),
    corsOrigins: (process.env.CORS_ORIGIN || '*')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    s3Endpoint: process.env.S3_ENDPOINT || '',
    s3Bucket: process.env.S3_BUCKET || '',
    s3Region: process.env.S3_REGION || 'auto',
    publicWorkerUrl: process.env.PUBLIC_WORKER_URL || '',
  };
}
