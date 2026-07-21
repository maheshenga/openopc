FROM oven/bun:1.3.14 AS bun-runtime
FROM mcr.microsoft.com/playwright:v1.61.1-noble

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/automation-browser-worker ./apps/automation-browser-worker
RUN corepack enable && pnpm install --frozen-lockfile --filter @kortix/automation-browser-worker...
RUN chown -R pwuser:pwuser /app

USER pwuser
ENV NODE_ENV=production
ENV HOME=/home/pwuser
ENV AUTOMATION_BROWSER_MAX_MEMORY_MB=512
ENV AUTOMATION_BROWSER_MAX_CPU_SECONDS=120
WORKDIR /app/apps/automation-browser-worker
CMD ["sh", "-c", "case \"$AUTOMATION_BROWSER_MAX_CPU_SECONDS:$AUTOMATION_BROWSER_MAX_MEMORY_MB\" in *[!0-9:]*) exit 64;; esac; ulimit -t \"$AUTOMATION_BROWSER_MAX_CPU_SECONDS\"; ulimit -v \"$((AUTOMATION_BROWSER_MAX_MEMORY_MB * 1024))\"; exec bun run src/worker.ts"]
