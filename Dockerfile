FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 make g++ fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json .npmrc ./
# The CPU runtime is bundled in the npm package. This service uses CPU Whisper.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --no-audit --no-fund && npm cache clean --force

FROM dependencies AS runtime
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000 STORAGE_DIR=/data/storage
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
VOLUME ["/data/storage"]
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=8s --start-period=45s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["./node_modules/.bin/tsx", "server.ts"]

