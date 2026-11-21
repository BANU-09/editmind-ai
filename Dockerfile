# Production container for EDITMIND AI media processing backend & worker
# Hosts Express API, FFmpeg/FFprobe media pipeline, SQLite persistence, and 2 GB upload/URL intake.
# Pair with Vercel frontend (set VITE_API_BASE_URL to this service URL) or serve monolithic dist + API.

FROM node:22-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY . .

RUN npm run build

ENV NODE_ENV=production
ENV PORT=3000
ENV STORAGE_DIR=/data/storage

RUN mkdir -p /data/storage/.tmp /data/storage/.hf_cache

EXPOSE 3000
VOLUME ["/data/storage"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npx", "tsx", "server.ts"]
