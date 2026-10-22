# Dockerfile único com alvos api, worker e web. Base: Ubuntu 24.04 (FFmpeg 6.1 com libass,
# libopus, drawtext com text_align) + Node.js 22 copiado da imagem oficial.
FROM node:22.22.0-bookworm-slim AS node

FROM ubuntu:24.04 AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/timeline/package.json packages/timeline/
COPY packages/media/package.json packages/media/
COPY packages/providers/package.json packages/providers/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
COPY packages/db/package.json packages/db/
RUN npm ci --no-audit --no-fund

FROM deps AS source
COPY . .
RUN npm run db:generate

# ---------------------------------------------------------------- API
FROM source AS api
USER ubuntu
EXPOSE 4000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "cd /app/packages/db && npx prisma migrate deploy && cd /app/apps/api && exec node --import tsx src/main.ts"]

# ---------------------------------------------------------------- worker
FROM source AS worker
RUN mkdir -p /data/tmp && chown ubuntu:ubuntu /data/tmp
USER ubuntu
ENV WORKER_TMP_DIR=/data/tmp FONTS_DIR=/app/assets/fonts
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "cd /app/apps/worker && exec node --import tsx src/main.ts"]

# ---------------------------------------------------------------- web
FROM source AS web
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && npm run build
USER ubuntu
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "cd /app/apps/web && exec npx next start --port 3000"]
