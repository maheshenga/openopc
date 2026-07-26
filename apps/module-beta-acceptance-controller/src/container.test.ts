import { expect, test } from 'bun:test';

const dockerfileUrl = new URL('../Dockerfile', import.meta.url);

test('production image is pinned and contains only the portable runtime closure', async () => {
  const file = Bun.file(dockerfileUrl);
  expect(await file.exists()).toBe(true);

  const dockerfile = await file.text();
  const instructions = dockerfile.replace(/\\\r?\n\s*/g, ' ');
  const fromInstructions = dockerfile.match(/^FROM .+$/gm) ?? [];

  expect(fromInstructions).toEqual([
    'FROM node:22-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS deploy',
    'FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS runtime',
  ]);
  expect(dockerfile).toContain('ARG PNPM_VERSION=8.11.0');
  expect(dockerfile).toContain('COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./');
  expect(dockerfile).not.toContain('COPY package.json pnpm-lock.yaml');
  expect(instructions).toContain(
    "pnpm --filter '@openopc/module-beta-acceptance-controller' deploy --prod /opt/controller",
  );
  expect(instructions).toContain(
    "find /opt/controller -type f \\( -name '*.test.*' -o -name '*.spec.*' \\) -delete",
  );
  expect(dockerfile).toContain('COPY apps/module-beta-acceptance-controller/package.json');
  expect(dockerfile).toContain('COPY packages/module-runtime-contracts/package.json');

  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  expect(runtimeStage).toContain(
    'COPY --from=deploy --chown=65532:65532 /opt/controller/package.json ./package.json',
  );
  expect(runtimeStage).toContain(
    'COPY --from=deploy --chown=65532:65532 /opt/controller/src ./src',
  );
  expect(runtimeStage).toContain(
    'COPY --from=deploy --chown=65532:65532 /opt/controller/node_modules ./node_modules',
  );
  expect(runtimeStage).not.toMatch(/^COPY (?!--from=deploy\b)/m);
  expect(runtimeStage).not.toMatch(/(?:^|\s)(?:test|tests|docs?|tsconfig)(?:\/|\s|$)/im);
});

test('runtime is rootless and compatible with a read-only root filesystem', async () => {
  const file = Bun.file(dockerfileUrl);
  expect(await file.exists()).toBe(true);

  const dockerfile = await file.text();
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  const instructions = runtimeStage.replace(/\\\r?\n\s*/g, ' ');

  expect(instructions).toMatch(
    /ENV NODE_ENV=production .*HOME=\/tmp\/openopc-controller .*TMPDIR=\/tmp\/openopc-controller/,
  );
  expect(runtimeStage).toContain('chmod -R a-w /app');
  expect(runtimeStage).toMatch(/^USER 65532:65532$/m);
  expect(runtimeStage).toContain('CMD ["bun", "run", "src/main.ts"]');
  expect(runtimeStage).not.toMatch(/^EXPOSE\b/m);
  expect(runtimeStage).not.toContain('sh -c');
  expect(runtimeStage).not.toMatch(/^ENTRYPOINT\s+[^[]/m);
});
