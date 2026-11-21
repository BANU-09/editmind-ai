import { del, put } from '@vercel/blob';
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import type { IncomingMessage } from 'node:http';
import fs from 'fs';
import { Readable } from 'stream';
import { getAppConfig, STRICT_MAX_UPLOAD_BYTES } from './config';

export interface BlobUploadResult {
  url: string;
  downloadUrl: string;
  pathname: string;
  contentType: string;
  sizeBytes: number;
}

const ALLOWED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/ogg',
  'video/x-m4v',
  'audio/mpeg',
  'audio/wav',
  'audio/aac',
  'audio/ogg',
  'application/octet-stream',
];

export function isVercelBlobConfigured(): boolean {
  const token = getAppConfig().blobReadWriteToken;
  return Boolean(token && token.length > 10 && !token.includes('MY_BLOB_TOKEN'));
}

export function assertTrustedVercelBlobUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid Vercel Blob URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Vercel Blob URL must use HTTPS.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('.blob.vercel-storage.com')) {
    throw new Error(`Untrusted Blob host "${host}". Expected *.blob.vercel-storage.com.`);
  }
  return parsed;
}

export async function uploadFileToBlob(params: {
  localPath: string;
  blobPathname: string;
  contentType: string;
}): Promise<BlobUploadResult | null> {
  const cfg = getAppConfig();
  if (!isVercelBlobConfigured()) return null;
  if (!fs.existsSync(params.localPath)) {
    throw new Error(`Cannot upload missing file to Vercel Blob: ${params.localPath}`);
  }
  const stat = fs.statSync(params.localPath);
  if (stat.size > STRICT_MAX_UPLOAD_BYTES) {
    throw new Error('Artifact exceeds 2 GB maximum Vercel Blob upload ceiling.');
  }

  const stream = fs.createReadStream(params.localPath);
  const res = await put(params.blobPathname, stream, {
    access: 'public',
    token: cfg.blobReadWriteToken,
    contentType: params.contentType,
    multipart: stat.size > 12 * 1024 * 1024,
    addRandomSuffix: false,
    allowOverwrite: true,
  });

  return {
    url: res.url,
    downloadUrl: res.downloadUrl,
    pathname: res.pathname,
    contentType: res.contentType,
    sizeBytes: stat.size,
  };
}

export async function deleteBlobObject(urlOrPathname: string): Promise<void> {
  const cfg = getAppConfig();
  if (!isVercelBlobConfigured() || !urlOrPathname) return;
  try {
    await del(urlOrPathname, { token: cfg.blobReadWriteToken });
  } catch (err) {
    console.warn('[blob] Failed to delete blob object:', err instanceof Error ? err.message : err);
  }
}

export async function handleBlobClientUpload(params: {
  request: IncomingMessage;
  body: HandleUploadBody;
  userId: string | null;
  guestToken: string | null;
}) {
  const cfg = getAppConfig();
  if (!isVercelBlobConfigured()) {
    throw new Error('Vercel Blob storage (BLOB_READ_WRITE_TOKEN) is not configured on the server.');
  }

  return handleUpload({
    token: cfg.blobReadWriteToken,
    request: params.request,
    body: params.body,
    onBeforeGenerateToken: async (pathname) => {
      const cleanName = pathname.replace(/[^a-zA-Z0-9._/-]/g, '_');
      if (!cleanName) {
        throw new Error('Invalid blob pathname.');
      }
      return {
        allowedContentTypes: ALLOWED_VIDEO_MIME_TYPES,
        maximumSizeInBytes: cfg.maxUploadBytes,
        addRandomSuffix: true,
        tokenPayload: JSON.stringify({
          userId: params.userId,
          guestToken: params.guestToken,
        }),
      };
    },
    onUploadCompleted: async ({ blob }) => {
      console.log(`[blob] Direct multipart upload completed: ${blob.pathname} -> ${blob.url}`);
    },
  });
}

export async function downloadBlobToFile(blobUrl: string, destPath: string): Promise<number> {
  const safeUrl = assertTrustedVercelBlobUrl(blobUrl);
  const res = await fetch(safeUrl.toString());
  if (!res.ok || !res.body) {
    throw new Error(`Failed to fetch blob media (${res.status} ${res.statusText}).`);
  }

  const contentLenHeader = res.headers.get('content-length');
  if (contentLenHeader) {
    const contentLen = Number(contentLenHeader);
    if (Number.isFinite(contentLen) && contentLen > STRICT_MAX_UPLOAD_BYTES) {
      throw new Error('Remote blob exceeds 2 GB size limit.');
    }
  }

  let downloaded = 0;
  const writable = fs.createWriteStream(destPath);
  const readable = Readable.fromWeb(res.body as unknown as import('stream/web').ReadableStream);

  await new Promise<void>((resolve, reject) => {
    readable.on('data', (chunk: Buffer) => {
      downloaded += chunk.length;
      if (downloaded > STRICT_MAX_UPLOAD_BYTES) {
        readable.destroy(new Error('Blob download exceeded strict 2 GB maximum limit.'));
        return;
      }
      if (!writable.write(chunk)) {
        readable.pause();
        writable.once('drain', () => readable.resume());
      }
    });
    readable.on('end', () => writable.end());
    readable.on('error', (err) => {
      writable.destroy();
      reject(err);
    });
    writable.on('finish', () => resolve());
    writable.on('error', (err) => reject(err));
  });

  return downloaded;
}
