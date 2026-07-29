import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { seedRepoViaGitPush } from '../git-backends/seed';
import { commitFile } from '../github';
import { commitFileToBranch } from './branches';
import { mergeBranches } from './merge';

const execFileAsync = promisify(execFile);
const originalGitCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
async function git(args: string[], cwd?: string): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, timeout: 30_000 });
  return result.stdout.toString();
}

async function authorOf(remote: string, ref = 'main'): Promise<string> {
  return (await git(['--git-dir', remote, 'show', '-s', '--format=%an <%ae>', ref])).trim();
}

async function createRemote(): Promise<{ remote: string; url: string }> {
  const root = await mkdtemp(join(tmpdir(), 'openopc-author-brand-'));
  const remote = join(root, 'remote.git');
  await git(['init', '--bare', remote]);
  return { remote, url: pathToFileURL(remote).href };
}

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })));
  cleanupRoots.clear();
  if (originalGitCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = originalGitCacheDir;
});

async function projectFor(remote: string) {
  const root = await mkdtemp(join(tmpdir(), 'openopc-git-cache-'));
  cleanupRoots.add(root);
  process.env.KORTIX_GIT_CACHE_DIR = root;
  return {
    projectId: crypto.randomUUID(),
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'unused-for-local-file-remote',
  };
}

describe('user-visible Git authors use the product brand by default', () => {
  test('writes the product display name for a managed branch commit', async () => {
    const { remote, url } = await createRemote();
    cleanupRoots.add(join(remote, '..'));
    const project = await projectFor(url);

    await commitFileToBranch(project, {
      path: 'README.md',
      content: '# Brand check\n',
      message: 'Add readme',
    });

    expect(await authorOf(remote)).toBe('OpenOPC <noreply@kortix.ai>');
  }, 60_000);

  test('writes the product display name for a generated merge commit', async () => {
    const { remote, url } = await createRemote();
    cleanupRoots.add(join(remote, '..'));
    const project = await projectFor(url);
    await commitFileToBranch(project, { path: 'README.md', content: '# Base\n', message: 'Base' });

    const worktree = await mkdtemp(join(tmpdir(), 'openopc-merge-worktree-'));
    cleanupRoots.add(worktree);
    await git(['clone', url, worktree]);
    await git(['config', 'user.name', 'Test User'], worktree);
    await git(['config', 'user.email', 'test@example.com'], worktree);
    await git(['checkout', '-b', 'feature', 'origin/main'], worktree);
    await writeFile(join(worktree, 'feature.txt'), 'feature\n');
    await git(['add', 'feature.txt'], worktree);
    await git(['commit', '-m', 'Feature'], worktree);
    await git(['push', 'origin', 'feature'], worktree);

    await commitFileToBranch(project, { path: 'main.txt', content: 'main\n', message: 'Main' });
    await mergeBranches(project, 'main', 'feature');

    expect(await authorOf(remote)).toBe('OpenOPC <noreply@kortix.ai>');
  }, 60_000);

  test('writes the product display name for both deterministic and project seed commits', async () => {
    const { remote, url } = await createRemote();
    cleanupRoots.add(join(remote, '..'));

    await seedRepoViaGitPush({
      upstreamUrl: url,
      token: 'unused-for-local-file-remote',
      baseFiles: [{ path: 'BASE.md', content: '# Shared base\n' }],
      files: [{ path: 'README.md', content: '# Project\n' }],
    });

    const authors = (await git(['--git-dir', remote, 'log', '--format=%an <%ae>', 'main']))
      .trim()
      .split(/\r?\n/);
    expect(authors).toEqual([
      'OpenOPC <noreply@kortix.ai>',
      'OpenOPC <noreply@kortix.ai>',
    ]);
  }, 60_000);

  test('sends the product display name as the GitHub Contents API author and committer', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ content: { sha: 'commit-sha' } });
    }) as typeof fetch;

    try {
      await commitFile({
        owner: 'openopc',
        repo: 'brand-check',
        path: 'README.md',
        content: '# Project\n',
        message: 'Add readme',
        auth: { token: 'test-token', source: 'pat' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestBody).toMatchObject({
      author: { name: 'OpenOPC', email: 'noreply@kortix.ai' },
      committer: { name: 'OpenOPC', email: 'noreply@kortix.ai' },
    });
  });

  test('contains no legacy product display name in user-visible Git identity configuration', async () => {
    const files = [
      '../git-backends/seed.ts',
      '../github.ts',
      '../lib/triggers.ts',
      '../routes/r9.ts',
      '../../snapshots/build-context.ts',
    ];
    const offenders: string[] = [];

    for (const relativePath of files) {
      const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
      source.split(/\r?\n/).forEach((line, index) => {
        if (
          /(?:authorName|GIT_AUTHOR_NAME|GIT_COMMITTER_NAME|user\.name).*['"]Kortix['"]/.test(
            line,
          )
        ) {
          offenders.push(`${relativePath}:${index + 1}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  test('restores the cache-directory environment inherited by later tests', () => {
    expect(process.env.KORTIX_GIT_CACHE_DIR).toBe(originalGitCacheDir);
  });
});
