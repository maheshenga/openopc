import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';

import {
  DeveloperModuleDistributionError,
  DeveloperModuleDistributionService,
  createMemoryDeveloperModuleDistributionRepository,
} from './distribution';
import {
  createEd25519ModuleSigningPort,
  verifyDeveloperModuleReleaseTrustSignature,
} from './module-signing';
import { DeveloperPublisherError } from './publishers';
import { type DeveloperModuleRelease, canonicalDeveloperModuleManifestDigest } from './releases';
import { type DeveloperModuleReviewRepository, DeveloperModuleReviewService } from './reviews';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ADMIN_ID = '20000000-0000-4000-a000-000000000004';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const NOW = new Date('2026-07-24T15:00:00.000Z');

type TrustState =
  | 'passed'
  | 'queued'
  | 'running'
  | 'failed'
  | 'inconclusive'
  | 'cancelled'
  | 'stale-policy';

function trustGate(state: TrustState = 'passed') {
  return {
    async evaluate(candidate: DeveloperModuleRelease) {
      if (state === 'passed') {
        return {
          ok: true as const,
          evidence: {
            run_id: '60000000-0000-4000-a000-000000000006',
            artifact_digest: `sha256:${'c'.repeat(64)}` as const,
            sbom_digest: `sha256:${'d'.repeat(64)}` as const,
            attestation_digest: `sha256:${'e'.repeat(64)}` as const,
            policy_digest: `sha256:${'f'.repeat(64)}` as const,
            runtime_descriptor_digest: candidate.runtime_descriptor_digest,
            runtime_kind: candidate.runtime_kind,
          },
        };
      }
      return {
        ok: false as const,
        code:
          state === 'queued' || state === 'running'
            ? ('DEVELOPER_TRUST_PENDING' as const)
            : state === 'stale-policy'
              ? ('DEVELOPER_TRUST_POLICY_STALE' as const)
              : ('DEVELOPER_TRUST_NOT_PASSED' as const),
      };
    },
  };
}

function release(
  status: DeveloperModuleRelease['status'] = 'approved',
  reviewRevision = 2,
): DeveloperModuleRelease {
  const result: DeveloperModuleRelease = {
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    item_name: 'recruiting-workbench',
    publisher_id: 'acme',
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    manifest: {
      schemaVersion: 2,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
    },
    manifest_digest: `sha256:${'a'.repeat(64)}`,
    artifact_id: '50000000-0000-4000-a000-000000000005',
    artifact_digest: `sha256:${'c'.repeat(64)}`,
    sbom_digest: `sha256:${'d'.repeat(64)}`,
    trust_attestation_digest: `sha256:${'e'.repeat(64)}`,
    verification_policy_digest: `sha256:${'f'.repeat(64)}`,
    runtime_descriptor_digest: null,
    runtime_descriptor_path: null,
    runtime_kind: null,
    review_requirements: ['manifest_review', 'source_scan', 'human_review'],
    status,
    review_revision: reviewRevision,
    signature_algorithm: null,
    signature_key_id: null,
    signature: null,
    signature_payload_digest: null,
    signed_at: null,
    published_at: null,
    revoked_at: null,
    created_by: '20000000-0000-4000-a000-000000000002',
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T14:00:00.000Z',
  };
  result.manifest_digest = canonicalDeveloperModuleManifestDigest(result.manifest);
  return result;
}

function signingPort() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return createEd25519ModuleSigningPort({
    keyId: 'openopc-test-2026',
    privateKey,
    publicKey,
  });
}

test('signs approved declarative release and publishes only after verification', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });

  const signed = await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  expect(signed.release.status).toBe('signed');
  expect(signed.release.review_revision).toBe(3);
  expect(signed.event.action).toBe('sign');

  const published = await service.publish({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'signed',
    expectedRevision: 3,
  });
  expect(published.release.status).toBe('published');
  expect(published.release.review_revision).toBe(4);
  expect(published.event.action).toBe('publish');
});

test('binds server runtime descriptor evidence into the release signature', async () => {
  const executable = release();
  executable.manifest.execution = {
    mode: 'server-adapter',
    entry: 'runtime/openopc.runtime.json',
  };
  executable.manifest.verification = { profile: 'server-conformance' };
  executable.manifest_digest = canonicalDeveloperModuleManifestDigest(executable.manifest);
  executable.runtime_descriptor_digest = `sha256:${'1'.repeat(64)}`;
  executable.runtime_descriptor_path = 'runtime/openopc.runtime.json';
  executable.runtime_kind = 'wasi-component';
  const signer = signingPort();
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [executable],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer,
    trustGate: trustGate(),
    now: () => NOW,
  });

  const signed = await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });

  expect(signed.release.runtime_descriptor_digest).toBe(executable.runtime_descriptor_digest);
  const tampered = structuredClone(signed.release);
  tampered.runtime_kind = 'oci-image';
  await expect(verifyDeveloperModuleReleaseTrustSignature(tampered, signer)).resolves.toBe(false);
});

test('checks Publisher platform-review authority before signing or publishing', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const allowed = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });
  await allowed.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  const calls: unknown[][] = [];
  const denied = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    permissions: {
      async requirePermission(...args) {
        calls.push(args);
        throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_SUSPENDED', 409);
      },
    },
    now: () => NOW,
  });

  await expect(
    denied.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).rejects.toMatchObject({ code: 'DEVELOPER_PUBLISHER_SUSPENDED', status: 409 });
  expect(calls).toEqual([
    ['acme', { accountId: ACCOUNT_ID, userId: ADMIN_ID, platformAdmin: true }, 'platform_review'],
  ]);
  expect(await repository.getAdmin(RELEASE_ID)).toEqual(
    expect.objectContaining({ status: 'signed', review_revision: 3 }),
  );
});

test('denies signing by a publisher-account member', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    publisherAccountMembers: [{ accountId: ACCOUNT_ID, userId: ADMIN_ID }],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });

  await expect(
    service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
    }),
  ).rejects.toEqual(
    expect.objectContaining({
      code: 'DEVELOPER_DISTRIBUTION_SELF_ACTION_DENIED',
      status: 403,
    }),
  );
});

test('fails closed when the module signer is unavailable without mutating the release', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({ repository, now: () => NOW });

  await expect(
    service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE', status: 503 }),
  );
  expect(await repository.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'approved',
    review_revision: 2,
    signature: null,
    signed_at: null,
  });
});

test.each(['queued', 'running', 'failed', 'inconclusive', 'cancelled', 'stale-policy'] as const)(
  '%s verification blocks signing before the signing port is called',
  async (state) => {
    let signingCalls = 0;
    const signer = signingPort();
    const repository = createMemoryDeveloperModuleDistributionRepository({
      releases: [release()],
      now: () => NOW,
    });
    const service = new DeveloperModuleDistributionService({
      repository,
      signer: {
        ...signer,
        async sign(payload) {
          signingCalls += 1;
          return signer.sign(payload);
        },
      },
      trustGate: trustGate(state),
      now: () => NOW,
    });

    await expect(
      service.sign({
        releaseId: RELEASE_ID,
        actorUserId: ADMIN_ID,
        expectedStatus: 'approved',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_TRUST_GATE_UNMET', status: 409 });
    expect(signingCalls).toBe(0);
  },
);

test('signs an approved non-declarative release without executing it', async () => {
  const executable = release();
  executable.manifest.execution = { mode: 'server-adapter', entry: 'server.ts' };
  executable.manifest.verification = { profile: 'server-conformance' };
  executable.manifest_digest = canonicalDeveloperModuleManifestDigest(executable.manifest);
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [executable],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });

  await expect(
    service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
    }),
  ).resolves.toMatchObject({ release: { status: 'signed' } });
});

test('has no schema-1 signature fallback when publishing persisted releases', async () => {
  const signer = signingPort();
  const signedRelease = release('signed', 3);
  const schema1Bytes = new TextEncoder().encode(
    `{"manifest_digest":"${signedRelease.manifest_digest}","module_id":"${signedRelease.module_id}","module_version":"${signedRelease.module_version}","publisher_id":"${signedRelease.publisher_id}","schema":1}`,
  );
  signedRelease.signature_algorithm = 'ed25519';
  signedRelease.signature_key_id = signer.keyId;
  signedRelease.signature = await signer.sign(schema1Bytes);
  signedRelease.signature_payload_digest = `sha256:${createHash('sha256').update(schema1Bytes).digest('hex')}`;
  signedRelease.signed_at = NOW.toISOString();
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [signedRelease],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    verifiers: [signer],
    now: () => NOW,
  });

  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_SIGNATURE_INVALID', status: 409 });
});

test.each([
  'artifact_digest',
  'sbom_digest',
  'trust_attestation_digest',
  'verification_policy_digest',
] as const)('rejects publication after %s is tampered', async (digestField) => {
  const signer = signingPort();
  const delegate = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  let tamper = false;
  const repository = {
    ...delegate,
    async getAdmin(releaseId: string) {
      const stored = await delegate.getAdmin(releaseId);
      if (stored && tamper) stored[digestField] = `sha256:${'0'.repeat(64)}`;
      return stored;
    },
  };
  const service = new DeveloperModuleDistributionService({
    repository,
    signer,
    verifiers: [signer],
    trustGate: trustGate(),
    now: () => NOW,
  });
  await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  tamper = true;

  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).rejects.toMatchObject({ code: 'DEVELOPER_MODULE_SIGNATURE_INVALID', status: 409 });
});

test('rejects stale distribution commands without signing', async () => {
  let signCalls = 0;
  const signer = signingPort();
  const guardedSigner = {
    ...signer,
    async sign(payload: Uint8Array) {
      signCalls += 1;
      return signer.sign(payload);
    },
  };
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: guardedSigner,
    now: () => NOW,
  });

  await expect(
    service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 1,
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_DISTRIBUTION_CONFLICT', status: 409 }),
  );
  expect(signCalls).toBe(0);
  expect(await repository.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'approved',
    review_revision: 2,
  });
});

test('revokes a published release with an immutable emergency event', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });
  await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  const published = await service.publish({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'signed',
    expectedRevision: 3,
  });

  const revoked = await service.revoke({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'published',
    expectedRevision: 4,
    reason: ' Emergency takedown after a verified security report. ',
  });

  expect(revoked.release).toMatchObject({
    status: 'revoked',
    review_revision: 5,
    published_at: published.release.published_at,
    revoked_at: NOW.toISOString(),
  });
  expect(revoked.event).toMatchObject({
    sequence: 5,
    action: 'revoke',
    from_status: 'published',
    to_status: 'revoked',
    reason: 'Emergency takedown after a verified security report.',
  });
});

test('rejects publication when the persisted manifest no longer matches its digest', async () => {
  const delegate = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  let tamperManifest = false;
  const repository = {
    ...delegate,
    async getAdmin(releaseId: string) {
      const stored = await delegate.getAdmin(releaseId);
      if (stored && tamperManifest) stored.manifest.version = '9.9.9';
      return stored;
    },
  };
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });
  await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  tamperManifest = true;

  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_MODULE_SIGNATURE_INVALID', status: 409 }),
  );
  expect(await delegate.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'signed',
    published_at: null,
  });
});

test('combines review and distribution history by release revision', async () => {
  const reviewEvent = {
    review_event_id: '40000000-0000-4000-a000-000000000001',
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    sequence: 2,
    action: 'approve' as const,
    from_status: 'review_pending' as const,
    to_status: 'approved' as const,
    actor_user_id: ADMIN_ID,
    actor_kind: 'platform_admin' as const,
    reason: 'Approved after manual review.',
    evidence: [],
    created_at: '2026-07-24T14:30:00.000Z',
  };
  const distributionEvent = {
    distribution_event_id: '40000000-0000-4000-a000-000000000002',
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    sequence: 3,
    action: 'sign' as const,
    from_status: 'approved' as const,
    to_status: 'signed' as const,
    actor_user_id: ADMIN_ID,
    actor_kind: 'platform_admin' as const,
    reason: null,
    created_at: NOW.toISOString(),
  };
  const reviewRepository = {
    async getPublisher() {
      return release('approved', 3);
    },
    async history() {
      return [reviewEvent];
    },
  } as unknown as DeveloperModuleReviewRepository;
  const distributionRepository = {
    async history() {
      return [distributionEvent];
    },
  };
  const service = new DeveloperModuleReviewService({
    repository: reviewRepository,
    distributionRepository,
  });

  const history = await service.combinedHistory({ accountId: ACCOUNT_ID, releaseId: RELEASE_ID });
  expect(history.map((event) => event.sequence)).toEqual([2, 3]);
  expect(history.map((event) => event.action)).toEqual(['approve', 'sign']);
});

test('replays the same successful sign command idempotently', async () => {
  let signCalls = 0;
  const signer = signingPort();
  const countingSigner = {
    ...signer,
    async sign(payload: Uint8Array) {
      signCalls += 1;
      return signer.sign(payload);
    },
  };
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: countingSigner,
    trustGate: trustGate(),
    now: () => NOW,
  });
  const command = {
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved' as const,
    expectedRevision: 2,
  };

  const first = await service.sign(command);
  const second = await service.sign(command);

  expect(signCalls).toBe(1);
  expect(second).toEqual(first);
  expect((await repository.history(ACCOUNT_ID, RELEASE_ID)).map((event) => event.sequence)).toEqual(
    [3],
  );
});

test('replays the same successful publish command idempotently', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });
  await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  const command = {
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'signed' as const,
    expectedRevision: 3,
  };

  const first = await service.publish(command);
  const second = await service.publish(command);

  expect(second).toEqual(first);
  expect((await repository.history(ACCOUNT_ID, RELEASE_ID)).map((event) => event.sequence)).toEqual(
    [3, 4],
  );
});

test('replays the same successful revoke command idempotently', async () => {
  const publishedRelease = release('published', 4);
  publishedRelease.signature_algorithm = 'ed25519';
  publishedRelease.signature_key_id = 'openopc-test-2026';
  publishedRelease.signature = `base64url:${'A'.repeat(86)}`;
  publishedRelease.signature_payload_digest = `sha256:${'b'.repeat(64)}`;
  publishedRelease.signed_at = '2026-07-24T14:30:00.000Z';
  publishedRelease.published_at = '2026-07-24T14:45:00.000Z';
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [publishedRelease],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({ repository, now: () => NOW });
  const command = {
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'published' as const,
    expectedRevision: 4,
    reason: 'Verified emergency takedown.',
  };

  const first = await service.revoke(command);
  const second = await service.revoke(command);

  expect(second).toEqual(first);
  expect((await repository.history(ACCOUNT_ID, RELEASE_ID)).map((event) => event.sequence)).toEqual(
    [5],
  );
});

test('maps signer failures to a code-only unavailable error without partial state', async () => {
  const signer = signingPort();
  const failingSigner = {
    ...signer,
    async sign(): Promise<`base64url:${string}`> {
      throw new Error('kms token=must-not-leak');
    },
  };
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: failingSigner,
    trustGate: trustGate(),
    now: () => NOW,
  });

  try {
    await service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
    });
    throw new Error('Expected signing to fail');
  } catch (error) {
    expect(error).toEqual(
      expect.objectContaining({ code: 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE', status: 503 }),
    );
    expect(JSON.stringify(error)).not.toContain('must-not-leak');
  }
  expect(await repository.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'approved',
    review_revision: 2,
    signature: null,
  });
});

test('discards generated signature state when the repository event write conflicts', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
    createId() {
      throw new DeveloperModuleDistributionError('DEVELOPER_DISTRIBUTION_CONFLICT', 409);
    },
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });

  await expect(
    service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_DISTRIBUTION_CONFLICT', status: 409 }),
  );
  expect(await repository.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'approved',
    review_revision: 2,
    signature: null,
  });
  expect(await repository.history(ACCOUNT_ID, RELEASE_ID)).toEqual([]);
});

test('fails publication when the persisted signature key is no longer available', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const originalSigner = signingPort();
  await new DeveloperModuleDistributionService({
    repository,
    signer: originalSigner,
    trustGate: trustGate(),
    now: () => NOW,
  }).sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rotatedSigner = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-rotated',
    privateKey,
    publicKey,
  });
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: rotatedSigner,
    now: () => NOW,
  });

  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE', status: 503 }),
  );
  expect(await repository.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'signed',
    published_at: null,
  });
});

test('lists and reads only published module releases', async () => {
  const published = release('published', 4);
  published.published_at = '2026-07-24T14:45:00.000Z';
  const signed = release('signed', 3);
  signed.release_id = '30000000-0000-4000-a000-000000000008';
  const revoked = release('revoked', 5);
  revoked.release_id = '30000000-0000-4000-a000-000000000009';
  revoked.revoked_at = NOW.toISOString();
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [published, signed, revoked],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({ repository, now: () => NOW });

  const page = await service.listPublished({ query: 'recruiting', limit: 10, offset: 0 });
  expect(page).toMatchObject({ total: 1 });
  expect(page.releases.map((item) => item.status)).toEqual(['published']);
  await expect(service.getPublished({ releaseId: RELEASE_ID })).resolves.toMatchObject({
    status: 'published',
  });
});

test('rejects an invalid persisted detached signature', async () => {
  const delegate = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  let tamperSignature = false;
  const repository = {
    ...delegate,
    async getAdmin(releaseId: string) {
      const stored = await delegate.getAdmin(releaseId);
      if (stored && tamperSignature) stored.signature = `base64url:${'A'.repeat(86)}`;
      return stored;
    },
  };
  const service = new DeveloperModuleDistributionService({
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });
  await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  tamperSignature = true;

  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_MODULE_SIGNATURE_INVALID', status: 409 }),
  );
  expect(await delegate.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'signed',
    published_at: null,
  });
});

test('rejects revocation reasons that contain credentials or unsafe text', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release('signed', 3)],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({ repository, now: () => NOW });

  await expect(
    service.revoke({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
      reason: 'token=sk-live-do-not-echo-this',
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_DISTRIBUTION_REASON_INVALID', status: 400 }),
  );
  expect(await repository.getAdmin(RELEASE_ID)).toMatchObject({
    status: 'signed',
    review_revision: 3,
  });
});

test('rejects a changed revocation target after a successful command', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release('published', 4)],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({ repository, now: () => NOW });
  await service.revoke({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'published',
    expectedRevision: 4,
    reason: 'Verified emergency takedown.',
  });

  await expect(
    service.revoke({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'published',
      expectedRevision: 4,
      reason: 'A different takedown reason.',
    }),
  ).rejects.toEqual(
    expect.objectContaining({ code: 'DEVELOPER_DISTRIBUTION_CONFLICT', status: 409 }),
  );
  expect(await repository.history(ACCOUNT_ID, RELEASE_ID)).toHaveLength(1);
});

test('revokes a signed release without inventing a publication timestamp', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release('signed', 3)],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({ repository, now: () => NOW });

  const revoked = await service.revoke({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'signed',
    expectedRevision: 3,
    reason: 'Signing key exposure requires immediate revocation.',
  });

  expect(revoked.release).toMatchObject({
    status: 'revoked',
    review_revision: 4,
    published_at: null,
    revoked_at: NOW.toISOString(),
  });
  expect(revoked.event).toMatchObject({ from_status: 'signed', sequence: 4 });
});
