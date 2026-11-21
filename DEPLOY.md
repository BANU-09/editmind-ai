# EDITMIND AI — Production Deployment Guide (Vercel + Vercel Blob + Google Cloud Run Worker)

This repository implements the full-stack **EDITMIND AI** platform with:
1. **Frontend (`dist/`)**: Vite + React 19 SPA deployed to **Vercel** (or served directly by `server.ts`).
2. **Backend API Control Plane (`server.ts`)**: Express + SQLite + `@google/genai` + AI edit planner + `@vercel/blob` token exchange + async job orchestrator.
3. **Media Storage (Vercel Blob)**: Persistent storage for large source videos (up to **2 GB** / 60 minutes via direct browser multipart upload), thumbnails, custom audio tracks, and rendered MP4 exports.
4. **Separate Background Worker (`Dockerfile` -> Google Cloud Run)**: Runs `server.ts` with `WORKER_MODE=1`, FFmpeg, FFprobe, Whisper/Gemini chunked speech recognition, and FFmpeg MP4 rendering, authenticated cleanly with `WORKER_SHARED_SECRET`.

---

## Architecture Overview

```
Browser (React SPA on Vercel)
  ├── Small files (< 16 MB) ─────────► POST /api/media/ingest
  ├── Large files (with Blob token) ─► POST /api/blob/upload-token ─► Direct multipart to Vercel Blob ─► POST /api/media/ingest-blob
  ├── Large files (without Blob) ────► Chunked 8 MB slices (/api/uploads/multipart/init -> PUT /part/:i -> POST /complete)
  └── Prompt / Timeline / Search ────► Control Plane API (/api/ai/plan, /api/projects/*, /api/exports)
                                            │
                                            ├─ Local mode (WORKER_URL unset): runs FFmpeg + STT in-process
                                            └─ Distributed mode (WORKER_URL set): dispatches signed HTTP jobs to Cloud Run Worker
                                                  └─ Cloud Run Worker (WORKER_MODE=1)
                                                        ├── Downloads source video from Vercel Blob
                                                        ├── Extracts 16kHz WAV chunks, transcribes via Gemini / Whisper
                                                        ├── Renders edited MP4 + burned ASS subtitles via FFmpeg
                                                        ├── Uploads thumbnails & final MP4 to Vercel Blob
                                                        └── Sends signed callbacks to /api/internal/worker-callback
```

---

## 1. Environment Variables

All secrets **MUST remain server-side only** (never prefix secrets with `VITE_`).

### Control Plane Backend Variables
- `PORT=3000`
- `APP_URL="https://api.your-domain.com"`
- `CORS_ORIGIN="https://your-app.vercel.app"` (never combine `*` with credentials)
- `GEMINI_API_KEY="..."` — Google Gemini API key (`@google/genai` STT, verification, translation, AI planner)
- `BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."` — Vercel Blob token for direct 2 GB multipart uploads & artifact persistence
- `WORKER_MODE=0`
- `WORKER_URL="https://editmind-worker-xxxxx.a.run.app"` — (Optional) External Google Cloud Run worker URL
- `WORKER_SHARED_SECRET="<strong-random-64-char-secret>"` — Shared Bearer / `x-worker-secret` key between Control Plane and Cloud Run Worker
- `WORKER_CALLBACK_BASE_URL="https://api.your-domain.com"` — Base URL the Cloud Run worker posts `/api/internal/worker-callback` updates back to
- `MAX_UPLOAD_BYTES=2147483648` (strict 2 GB ceiling)
- `MULTIPART_CHUNK_BYTES=8388608` (8 MB chunk size for chunked fallback)

### Vercel Frontend Build Variables (`vercel.json` project)
- `VITE_API_BASE_URL="https://api.your-domain.com"` (leave empty when frontend and backend share the same origin)

### Google Cloud Run Worker Variables (`WORKER_MODE=1`)
- `PORT=8080` (Cloud Run standard)
- `WORKER_MODE=1`
- `WORKER_SHARED_SECRET="<same-secret-as-control-plane>"`
- `GEMINI_API_KEY="..."`
- `BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."`
- `STT_PROVIDER="auto"`
- `AUDIO_CHUNK_TARGET_SEC=24`
- `STT_CONCURRENCY=2`

---

## 2. Deploy the Background Worker to Google Cloud Run

The repository includes a production `Dockerfile` with **Node 22 + FFmpeg + FFprobe + Python**.

```bash
# Build & push container to Google Artifact Registry / Cloud Build
gcloud builds submit --tag gcr.io/YOUR_GCP_PROJECT/editmind-worker

# Deploy to Cloud Run with long timeout (3600s for 60-min video jobs) & adequate memory/CPU
gcloud run deploy editmind-worker \
  --image gcr.io/YOUR_GCP_PROJECT/editmind-worker \
  --region us-central1 \
  --platform managed \
  --cpu 2 \
  --memory 4Gi \
  --timeout 3600 \
  --concurrency 4 \
  --no-allow-unauthenticated \
  --set-env-vars "WORKER_MODE=1,STT_PROVIDER=auto,MAX_UPLOAD_BYTES=2147483648" \
  --set-secrets "GEMINI_API_KEY=GEMINI_API_KEY:latest,BLOB_READ_WRITE_TOKEN=BLOB_READ_WRITE_TOKEN:latest,WORKER_SHARED_SECRET=WORKER_SHARED_SECRET:latest"
```

*Note*: If calling from an external control plane without GCP IAM ID tokens, permit public HTTPS ingress (`--allow-unauthenticated`) and rely on `WORKER_SHARED_SECRET` timing-safe authentication enforced on every `/worker/*` route.

---

## 3. Deploy the Frontend to Vercel + Provision Vercel Blob

1. Create a **Vercel Blob** store in the Vercel Dashboard -> Storage -> Create Database -> Blob, and copy `BLOB_READ_WRITE_TOKEN` into your backend environment (never expose it in frontend `VITE_*` variables).
2. Connect the repository to Vercel (`vercel.json` builds `dist/` with SPA fallback rewrites).
3. Configure `VITE_API_BASE_URL` in Vercel Project Settings -> Environment Variables pointing to your deployed Control Plane backend URL.
4. Set `CORS_ORIGIN` on the Control Plane backend to match your Vercel production domain (e.g., `https://editmind-ai.vercel.app`).
