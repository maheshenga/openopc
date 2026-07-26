FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS deploy

ARG PNPM_VERSION=8.11.0
ENV CI=true
WORKDIR /workspace

COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/module-beta-acceptance-controller/package.json apps/module-beta-acceptance-controller/package.json
COPY packages/module-runtime-contracts/package.json packages/module-runtime-contracts/package.json

RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

COPY apps/module-beta-acceptance-controller apps/module-beta-acceptance-controller
COPY packages/module-runtime-contracts packages/module-runtime-contracts

RUN pnpm --filter '@openopc/module-beta-acceptance-controller' deploy --prod /opt/controller \
    && find /opt/controller -type f \( -name '*.test.*' -o -name '*.spec.*' \) -delete

FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOME=/tmp/openopc-controller \
    TMPDIR=/tmp/openopc-controller \
    XDG_CACHE_HOME=/tmp/openopc-controller/.cache

RUN addgroup -S -g 65532 openopc \
    && adduser -S -D -H -u 65532 -G openopc openopc \
    && mkdir -p /tmp/openopc-controller \
    && chown 65532:65532 /tmp/openopc-controller \
    && chmod 0700 /tmp/openopc-controller

COPY --from=deploy --chown=65532:65532 /opt/controller/package.json ./package.json
COPY --from=deploy --chown=65532:65532 /opt/controller/src ./src
COPY --from=deploy --chown=65532:65532 /opt/controller/node_modules ./node_modules

RUN chmod -R a-w /app

USER 65532:65532
CMD ["bun", "run", "src/main.ts"]
