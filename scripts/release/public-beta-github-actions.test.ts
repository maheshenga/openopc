import { describe, expect, test } from 'bun:test';

import {
  type PublicBetaGitHubActionsClient,
  authenticatePublicBetaCertifierRun,
  authenticatePublicBetaSourceRun,
  authenticatePublicBetaToolBuilderRun,
} from './public-beta-github-actions';

const REPOSITORY = 'openopc/platform';
const RUN_ID = '101';
const HEAD_SHA = 'a'.repeat(40);
const CONTROL_SHA = 'd'.repeat(40);
const OTHER_SHA = 'c'.repeat(40);
const ARTIFACT_DIGEST = `sha256:${'b'.repeat(64)}`;
const NOW = new Date('2026-07-30T12:00:00.000Z');

function run(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    repository: { full_name: REPOSITORY, id: 711 },
    head_repository: { full_name: REPOSITORY, id: 711 },
    path: '.github/workflows/openopc-public-beta-gates.yml',
    name: 'OpenOPC Public Beta Gates',
    event: 'workflow_dispatch',
    head_branch: 'staging',
    head_sha: HEAD_SHA,
    run_attempt: 1,
    status: 'completed',
    conclusion: 'success',
    run_started_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-30T10:05:00.000Z',
    ...overrides,
  };
}

function artifact(
  overrides: Record<string, unknown> = {},
  name = 'openopc-public-beta-source-candidate',
): Record<string, unknown> {
  return {
    id: 202,
    name,
    size_in_bytes: 1_024,
    expired: false,
    expires_at: '2026-08-01T10:00:00.000Z',
    workflow_run: {
      id: 101,
      head_sha: HEAD_SHA,
      repository_id: 711,
      head_repository_id: 711,
    },
    digest: ARTIFACT_DIGEST,
    ...overrides,
  };
}

function client(workflowRun: unknown, artifacts: readonly unknown[]): PublicBetaGitHubActionsClient {
  return {
    async getWorkflowRun() {
      return workflowRun;
    },
    async listWorkflowRunArtifacts() {
      return artifacts;
    },
    async downloadArtifactArchive() {},
    async getRepositoryFile() {
      return new Uint8Array();
    },
  };
}

function sourceInput(
  mutation: Record<string, unknown> = {},
  artifacts: readonly unknown[] = [artifact()],
) {
  return {
    client: client(run(mutation), artifacts),
    expectedRepository: REPOSITORY,
    expectedCommit: HEAD_SHA,
    runId: RUN_ID,
    now: NOW,
  };
}

function builderInput(
  mutation: Record<string, unknown> = {},
  artifacts: readonly unknown[] = [
    artifact({}, 'openopc-cosign-toolchain-v3.1.2.1'),
  ],
) {
  return {
    client: client(
      run({
        path: '.github/workflows/openopc-cosign-builder.yml',
        name: 'OpenOPC Cosign Builder',
        event: 'workflow_dispatch',
        head_branch: 'main',
        ...mutation,
      }),
      artifacts,
    ),
    expectedRepository: REPOSITORY as const,
    expectedControlSha: HEAD_SHA,
    runId: RUN_ID,
    now: NOW,
  };
}

function certifierInput(
  mutation: Record<string, unknown> = {},
  artifacts: readonly unknown[] = [
    artifact(
      {
        workflow_run: {
          id: 101,
          head_sha: CONTROL_SHA,
          repository_id: 711,
          head_repository_id: 711,
        },
      },
      'openopc-public-beta-certified-candidate',
    ),
  ],
) {
  return {
    client: client(
      run({
        path: '.github/workflows/openopc-public-beta-certify.yml',
        name: 'OpenOPC Public Beta Certify',
        event: 'workflow_run',
        head_branch: 'main',
        head_sha: CONTROL_SHA,
        display_title: `OpenOPC Public Beta Certify ${HEAD_SHA}`,
        ...mutation,
      }),
      artifacts,
    ),
    expectedRepository: REPOSITORY,
    expectedCommit: HEAD_SHA,
    expectedControlSha: CONTROL_SHA,
    runId: RUN_ID,
    now: NOW,
  };
}

describe('public beta GitHub Actions authentication', () => {
  test('authenticates one completed protected source run and artifact', async () => {
    const result = await authenticatePublicBetaSourceRun(sourceInput());
    expect(result).toMatchObject({
      repository: REPOSITORY,
      workflow: '.github/workflows/openopc-public-beta-gates.yml',
      headSha: HEAD_SHA,
      artifactDigest: ARTIFACT_DIGEST,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  test('authenticates one completed protected tool-builder run and artifact', async () => {
    const result = await authenticatePublicBetaToolBuilderRun(builderInput());
    expect(result).toMatchObject({
      repository: REPOSITORY,
      workflow: '.github/workflows/openopc-cosign-builder.yml',
      workflowRef: 'refs/heads/main',
      controlSha: HEAD_SHA,
      event: 'workflow_dispatch',
      artifactDigest: ARTIFACT_DIGEST,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  test('authenticates one completed protected certifier run and artifact', async () => {
    const result = await authenticatePublicBetaCertifierRun(certifierInput());
    expect(result).toMatchObject({
      repository: REPOSITORY,
      workflow: '.github/workflows/openopc-public-beta-certify.yml',
      workflowRef: 'refs/heads/main',
      controlSha: CONTROL_SHA,
      event: 'workflow_run',
      artifactDigest: ARTIFACT_DIGEST,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  test.each([
    ['fork', { repository: { full_name: 'fork/platform', id: 711 } }],
    ['workflow', { path: '.github/workflows/other.yml' }],
    ['event', { event: 'pull_request_target' }],
    ['branch', { head_branch: 'staging' }],
    ['sha', { head_sha: OTHER_SHA }],
    ['attempt', { run_attempt: 0 }],
    ['conclusion', { conclusion: 'failure' }],
  ])('rejects tool-builder mutation %s', async (_name, mutation) => {
    expect(await authenticatePublicBetaToolBuilderRun(builderInput(mutation))).toBe(false);
  });

  test.each([
    ['workflow', { path: '.github/workflows/other.yml' }],
    ['name', { name: 'OpenOPC Cosign Builder' }],
    ['event', { event: 'push' }],
    ['branch', { head_branch: 'main' }],
    ['sha', { head_sha: OTHER_SHA }],
    ['attempt', { run_attempt: 0 }],
    ['conclusion', { conclusion: 'failure' }],
  ])('rejects source mutation %s', async (_name, mutation) => {
    expect(await authenticatePublicBetaSourceRun(sourceInput(mutation))).toBe(false);
  });

  test.each([
    ['workflow', { path: '.github/workflows/other.yml' }],
    ['name', { name: 'OpenOPC Cosign Builder' }],
    ['event', { event: 'workflow_dispatch' }],
    ['branch', { head_branch: 'staging' }],
    ['control sha', { head_sha: OTHER_SHA }],
    ['candidate sha title', { display_title: `OpenOPC Public Beta Certify ${OTHER_SHA}` }],
    ['attempt', { run_attempt: 0 }],
    ['conclusion', { conclusion: 'failure' }],
  ])('rejects certifier mutation %s', async (_name, mutation) => {
    expect(await authenticatePublicBetaCertifierRun(certifierInput(mutation))).toBe(false);
  });

  test.each([
    ['source rejects push event', authenticatePublicBetaSourceRun, sourceInput({ event: 'push' })],
    ['builder rejects source event', authenticatePublicBetaToolBuilderRun, builderInput({ event: 'push' })],
    ['certifier rejects builder event', authenticatePublicBetaCertifierRun, certifierInput({ event: 'workflow_dispatch' })],
    ['source rejects main branch', authenticatePublicBetaSourceRun, sourceInput({ head_branch: 'main' })],
    ['certifier rejects ref branch', authenticatePublicBetaCertifierRun, certifierInput({ head_branch: 'staging' })],
  ])('%s', async (_name, authenticate, input) => {
    expect(await authenticate(input as never)).toBe(false);
  });

  test('rejects zero or two current artifacts with each canonical name', async () => {
    expect(await authenticatePublicBetaSourceRun(sourceInput({}, []))).toBe(false);
    expect(await authenticatePublicBetaSourceRun(sourceInput({}, [artifact(), artifact()]))).toBe(false);
    expect(await authenticatePublicBetaToolBuilderRun(builderInput({}, []))).toBe(false);
    expect(
      await authenticatePublicBetaToolBuilderRun(
        builderInput({}, [
          artifact({}, 'openopc-cosign-toolchain-v3.1.2.1'),
          artifact({}, 'openopc-cosign-toolchain-v3.1.2.1'),
        ]),
      ),
    ).toBe(false);
    expect(await authenticatePublicBetaCertifierRun(certifierInput({}, []))).toBe(false);
    expect(
      await authenticatePublicBetaCertifierRun(
        certifierInput({}, [
          artifact({}, 'openopc-public-beta-certified-candidate'),
          artifact({}, 'openopc-public-beta-certified-candidate'),
        ]),
      ),
    ).toBe(false);
  });

  test.each([
    ['expired', { expired: true }],
    ['expiry at validation time', { expires_at: NOW.toISOString() }],
    ['non-canonical digest', { digest: `sha256:${'B'.repeat(64)}` }],
    ['zero size', { size_in_bytes: 0 }],
    ['unsafe size', { size_in_bytes: Number.MAX_SAFE_INTEGER + 1 }],
    ['wrong run id', { workflow_run: { id: 999, head_sha: HEAD_SHA, repository_id: 711, head_repository_id: 711 } }],
    ['wrong repository id', { workflow_run: { id: 101, head_sha: HEAD_SHA, repository_id: 712, head_repository_id: 711 } }],
    ['wrong head sha', { workflow_run: { id: 101, head_sha: OTHER_SHA, repository_id: 711, head_repository_id: 711 } }],
  ])('rejects invalid artifact %s', async (_name, mutation) => {
    expect(await authenticatePublicBetaToolBuilderRun(builderInput({}, [artifact(mutation, 'openopc-cosign-toolchain-v3.1.2.1')]))).toBe(false);
  });

  test.each([
    ['artifact getter throws', null],
    ['symbol-bearing run', { [Symbol('hostile')]: true }],
    ['non-plain run', Object.assign(Object.create({}), run())],
  ])('fails closed for hostile input %s', async (name, hostileRun) => {
    if (name === 'artifact getter throws') {
      const hostileArtifact = {
        ...artifact({}, 'openopc-cosign-toolchain-v3.1.2.1'),
        get digest() { throw new Error('hostile'); },
      };
      expect(await authenticatePublicBetaToolBuilderRun(builderInput({}, [hostileArtifact]))).toBe(false);
      return;
    }
    expect(await authenticatePublicBetaToolBuilderRun(builderInput(hostileRun as Record<string, unknown>))).toBe(false);
  });

  test('fails closed for a run getter that throws during snapshot', async () => {
    const hostileRun = run({
      path: '.github/workflows/openopc-cosign-builder.yml',
      name: 'OpenOPC Cosign Builder',
      event: 'workflow_dispatch',
      head_branch: 'main',
    });
    Object.defineProperty(hostileRun, 'status', { enumerable: true, get() { throw new Error('hostile'); } });
    const input = builderInput();
    input.client = client(hostileRun, [artifact({}, 'openopc-cosign-toolchain-v3.1.2.1')]);
    expect(await authenticatePublicBetaToolBuilderRun(input)).toBe(false);
  });

  test.each([
    ['wrong run id', { id: 102 }],
    ['inverted timestamps', { run_started_at: '2026-07-30T10:05:00.000Z', updated_at: '2026-07-30T10:00:00.000Z' }],
    ['invalid timestamp', { updated_at: 'not-a-date' }],
  ])('rejects invalid run metadata %s', async (_name, mutation) => {
    expect(await authenticatePublicBetaToolBuilderRun(builderInput(mutation))).toBe(false);
  });

  test('normalizes repository-name comparison only', async () => {
    const result = await authenticatePublicBetaToolBuilderRun(
      builderInput({ repository: { full_name: 'OpenOPC/platform', id: 711 }, head_repository: { full_name: 'OPENOPC/PLATFORM', id: 711 } }),
    );
    expect(result).not.toBe(false);
  });
});
