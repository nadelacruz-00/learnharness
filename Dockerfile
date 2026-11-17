# syntax=docker/dockerfile:1
# LearnHarness server image (fork: remote server mode). Runs the Next.js
# standalone server behind a Cloudflare Tunnel + Cloudflare Access.
# See docs/remote-server.md. Build on the target architecture: native modules
# (@napi-rs/canvas, @resvg/resvg-js, photon) are traced per build platform.

# node:26-bookworm-slim, multi-arch index digest (amd64 + arm64), 2026-11-11.
ARG NODE_IMAGE=node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

FROM ${NODE_IMAGE} AS build
WORKDIR /app
# The image needs no Electron runtime.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY plugins ./plugins
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run plugins:setup \
 && npm run build \
 && node scripts/build-server.mjs

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    LH_SERVER_MODE=remote \
    LH_DATA_DIR=/data/data \
    LH_AUTH_FILE=/data/auth.json \
    HOME=/data/home
RUN groupadd --system --gid 10001 learnharness \
 && useradd --system --uid 10001 --gid learnharness --home-dir /data/home --no-create-home learnharness \
 && mkdir -p /data/data /data/home \
 && chown -R learnharness:learnharness /data
WORKDIR /app
COPY --from=build --chown=root:root /app/.next/standalone ./
USER learnharness
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "server.js"]
