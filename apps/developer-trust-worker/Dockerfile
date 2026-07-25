# syntax=docker.io/docker/dockerfile:1

ARG BUN_VERSION=1.3.14

FROM node:22-slim AS deps
ARG PNPM_VERSION=8.11.0
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/developer-trust-worker ./apps/developer-trust-worker
COPY packages/registry ./packages/registry

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && \
    pnpm install --filter @openopc/developer-trust-worker... \
      --shamefully-hoist --prod=false --ignore-scripts

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV DEVELOPER_TRUST_PORT=8080

COPY LICENSE /LICENSE
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/developer-trust-worker ./apps/developer-trust-worker
COPY --from=deps /app/packages/registry ./packages/registry

RUN find apps/developer-trust-worker/src packages/registry/src \
      -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mts' \) -delete && \
    mkdir -p /tmp/openopc-developer-trust && \
    chown -R bun:bun /tmp/openopc-developer-trust

LABEL org.opencontainers.image.title="openopc-developer-trust-worker" \
      org.opencontainers.image.description="Isolated OpenOPC developer module trust worker" \
      org.opencontainers.image.licenses="Elastic-2.0" \
      org.opencontainers.image.vendor="OpenOPC"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.DEVELOPER_TRUST_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER bun

CMD ["bun", "run", "/app/apps/developer-trust-worker/src/main.ts"]
