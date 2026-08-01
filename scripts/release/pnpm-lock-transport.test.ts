import { expect, test } from 'bun:test';

interface PnpmGitResolution {
  type?: unknown;
  repo?: unknown;
}

interface PnpmLockfile {
  packages?: Record<string, { resolution?: PnpmGitResolution }>;
}

function isCredentialFreeHttpsRepository(repo: unknown): boolean {
  if (typeof repo !== 'string') return false;

  try {
    const url = new URL(repo);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

test('uses credential-free HTTPS for every Git dependency', async () => {
  const lockfile = Bun.YAML.parse(
    await Bun.file(new URL('../../pnpm-lock.yaml', import.meta.url)).text(),
  ) as PnpmLockfile;

  const insecureGitRepositories = Object.entries(lockfile.packages ?? {}).flatMap(
    ([packageKey, entry]) => {
      const resolution = entry.resolution;
      if (resolution?.type !== 'git' || isCredentialFreeHttpsRepository(resolution.repo)) {
        return [];
      }
      return [{ packageKey, repo: resolution.repo }];
    },
  );

  expect(insecureGitRepositories).toEqual([]);
});
