import { expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as sunaPush from './suna-push';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  return (await execFileAsync('git', args, { cwd, timeout: 30_000 })).stdout.toString();
}

test('configures the product display name for a Suna migration commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'openopc-suna-author-'));
  try {
    await git(['init', '-b', 'main', root]);
    const configureMigrationGitIdentity = (sunaPush as Record<string, unknown>)
      .configureMigrationGitIdentity as ((repoPath: string) => void) | undefined;
    expect(configureMigrationGitIdentity).toBeTypeOf('function');
    if (!configureMigrationGitIdentity) return;
    configureMigrationGitIdentity(root);
    await writeFile(join(root, 'note.txt'), 'migrated\n');
    await git(['add', 'note.txt'], root);
    await git(['commit', '-m', 'Migration'], root);

    const author = (await git(['show', '-s', '--format=%an <%ae>', 'HEAD'], root)).trim();
    expect(author).toBe('OpenOPC Migration <migration@kortix.com>');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 20_000);
