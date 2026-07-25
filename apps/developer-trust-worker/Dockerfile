# syntax=docker.io/docker/dockerfile:1.7

ARG BUN_VERSION=1.3.14

FROM zricethezav/gitleaks:v8.28.0@sha256:bf00b5e039f0fad4b32935dc5ec1e358f227ccd097bcb64b971f0331072fe2ae AS gitleaks
FROM anchore/syft:v1.33.0@sha256:cefadcf11bd9cce9e3ec5248bb1538a84e33d519486c1b4523ac155c9b5f5033 AS syft
FROM ghcr.io/google/osv-scanner:v2.0.2@sha256:605ba21aa2ed10a61bddc3988ae8a996980d79c93a7adc1f7966fbc6392ea04d AS osv
FROM semgrep/semgrep:1.171.0@sha256:296fc4912420833abfcf5090ec49a81bf1330bb61fc193cd09255f88b8267ba9 AS wasmtime
ARG WASMTIME_VERSION=47.0.2
USER root
RUN apk add --no-cache xz && \
    curl -fsSL --retry 3 \
      "https://github.com/bytecodealliance/wasmtime/releases/download/v${WASMTIME_VERSION}/wasmtime-v${WASMTIME_VERSION}-x86_64-musl.tar.xz" \
      -o /tmp/wasmtime.tar.xz && \
    tar -xJf /tmp/wasmtime.tar.xz -C /tmp && \
    test -x "/tmp/wasmtime-v${WASMTIME_VERSION}-x86_64-musl/wasmtime"

FROM node:22-slim AS deps
ARG PNPM_VERSION=8.11.0
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/developer-trust-worker ./apps/developer-trust-worker
COPY packages/registry ./packages/registry
COPY packages/module-runtime-contracts ./packages/module-runtime-contracts

RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && \
    pnpm install --filter @openopc/developer-trust-worker... \
      --frozen-lockfile --shamefully-hoist --prod=false --ignore-scripts

FROM oven/bun:${BUN_VERSION}-alpine AS bun-runtime

FROM semgrep/semgrep:1.171.0@sha256:296fc4912420833abfcf5090ec49a81bf1330bb61fc193cd09255f88b8267ba9 AS runtime-base
ARG WASMTIME_VERSION=47.0.2
USER root
WORKDIR /app
ENTRYPOINT []

ENV NODE_ENV=production
ENV DEVELOPER_TRUST_PORT=8080

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=gitleaks /usr/bin/gitleaks /opt/openopc/scanners/gitleaks
COPY --from=syft /syft /opt/openopc/scanners/syft
COPY --from=osv /osv-scanner /opt/openopc/scanners/osv-scanner
COPY --from=wasmtime "/tmp/wasmtime-v${WASMTIME_VERSION}-x86_64-musl/wasmtime" /opt/openopc/bin/wasmtime
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/developer-trust-worker ./apps/developer-trust-worker
COPY --from=deps /app/packages/registry ./packages/registry
COPY --from=deps /app/packages/module-runtime-contracts ./packages/module-runtime-contracts
COPY LICENSE /LICENSE

RUN mkdir -p /opt/openopc/policies /tmp/openopc-developer-trust && \
    cp apps/developer-trust-worker/policies/semgrep.yml /opt/openopc/policies/semgrep.yml && \
    printf '#!/bin/sh\nprintf "openopc-license-policy-v1\\n"\n' > /opt/openopc/scanners/license-policy && \
    chmod 0555 /opt/openopc/scanners/* /opt/openopc/bin/wasmtime && \
    chmod 0444 /opt/openopc/policies/semgrep.yml && \
    addgroup -S -g 65532 openopc && \
    adduser -S -D -H -u 65532 -G openopc openopc && \
    chown -R openopc:openopc /tmp/openopc-developer-trust

LABEL org.opencontainers.image.title="openopc-developer-trust-worker" \
      org.opencontainers.image.description="Isolated OpenOPC developer module trust worker" \
      org.opencontainers.image.licenses="Elastic-2.0" \
      org.opencontainers.image.vendor="OpenOPC"

FROM runtime-base AS test
USER openopc
CMD ["bun", "test", "/app/apps/developer-trust-worker/src"]

FROM runtime-base AS runtime
RUN find apps/developer-trust-worker/src \
      -type f \( -name '*.test.ts' -o -name '*.test.tsx' -o -name '*.test.mts' \) -delete

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.DEVELOPER_TRUST_PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER openopc
CMD ["bun", "run", "/app/apps/developer-trust-worker/src/main.ts"]
