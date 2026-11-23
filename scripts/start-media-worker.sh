#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  sudo apt-get update -qq
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg fonts-dejavu-core
fi
if [[ ! -f .installed ]]; then
  for prior in ../editmind-*; do
    if [[ ! -e node_modules && -f "$prior/.installed" && -d "$prior/node_modules" ]] && cmp -s package.json "$prior/package.json"; then
      ln -s "$(realpath "$prior/node_modules")" node_modules
      break
    fi
  done
  if [[ ! -d node_modules ]]; then npm install --ignore-scripts --no-fund --no-audit --legacy-peer-deps; fi
  node --input-type=module -e "import DB from 'better-sqlite3'; new DB(':memory:').close();"
  touch .installed
fi
export EDITMIND_PUBLIC_ORIGIN="${EDITMIND_PUBLIC_ORIGIN:-https://editmind-ai-banu09.vercel.app}"
export EDITMIND_PLANNER_URL="${EDITMIND_PLANNER_URL:-$EDITMIND_PUBLIC_ORIGIN/api/assistant}"
export NODE_ENV=production PORT="${PORT:-3000}" STT_PROVIDER="${STT_PROVIDER:-whisper}" STT_CONCURRENCY="${STT_CONCURRENCY:-1}"
export STT_WHISPER_MODEL="${STT_WHISPER_MODEL:-Xenova/whisper-base}"
export TEMP_MEDIA_DIR="${TEMP_MEDIA_DIR:?missing media scratch directory}"
export ANALYSIS_AUDIO_DIR="${ANALYSIS_AUDIO_DIR:?missing analysis directory}"
export STORAGE_DIR="${STORAGE_DIR:?missing storage directory}"
export CORS_ORIGIN="${CORS_ORIGIN:-$EDITMIND_PUBLIC_ORIGIN}"
export EDITMIND_MEDIA_RELEASE="$(cat revision)"
exec node server.mjs
