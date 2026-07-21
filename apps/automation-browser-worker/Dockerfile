FROM mcr.microsoft.com/playwright:v1.57.0-noble

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/automation-browser-worker ./apps/automation-browser-worker
RUN corepack enable && pnpm install --frozen-lockfile --filter @kortix/automation-browser-worker...
RUN chown -R pwuser:pwuser /app
USER pwuser
ENV NODE_ENV=production
ENV HOME=/home/pwuser
WORKDIR /app/apps/automation-browser-worker
CMD ["pnpm", "start"]
