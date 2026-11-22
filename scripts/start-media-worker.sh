#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg fonts-dejavu-core
fi
if [[ ! -f .installed ]]; then
  npm install --ignore-scripts --no-fund --no-audit --legacy-peer-deps
  node --input-type=module -e "import DB from 'better-sqlite3'; new DB(':memory:').close();"
  touch .installed
fi
export NODE_ENV=production PORT=3000 STT_PROVIDER=whisper STT_CONCURRENCY=1
export STT_WHISPER_MODEL=Xenova/whisper-base
export STORAGE_DIR=/mnt/editmind/storage
export CORS_ORIGIN=https://editmind-ai-banu09.vercel.app
exec node server.mjs
