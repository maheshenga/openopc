import { expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';

import { RESTRICTED_RUNTIME_CAPABILITIES } from '@kortix/api-contract';

import {
  DEVELOPER_RUNTIME_TEST_PROFILE,
  FUTURE_OCI_RUNTIME_TEST_PROFILE,
  FUTURE_WASI_RUNTIME_TEST_PROFILE,
  NON_READY_RUNTIME_TEST_PROFILE,
  RESTRICTED_RUNTIME_TEST_PROFILE,
} from '../release-profile/test-fixtures';
import {
  DeveloperModuleDistributionError,
  DeveloperModuleDistributionService,
  assertReleaseRuntimeAllowed,
  createMemoryDeveloperModuleDistributionRepository,
} from './distribution';
import {
  createEd25519ModuleSigningPort,
  createEd25519ModuleVerificationPort,
  verifyDeveloperModuleReleaseTrustSignature,
} from './module-signing';
import {
  type DeveloperPublisherAuthority,
  DeveloperPublisherError,
  type DeveloperPublisherPermissionPort,
} from './publishers';
import { type DeveloperModuleRelease, canonicalDeveloperModuleManifestDigest } from './releases';
import { type DeveloperModuleReviewRepository, DeveloperModuleReviewService } from './reviews';

const testPermissions = {
  async requirePermission() {
    return {} as never;
  },
};

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ADMIN_ID = '20000000-0000-4000-a000-000000000004';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const NOW = new Date('2026-07-24T15:00:00.000Z');

const platformPermissions: DeveloperPublisherPermissionPort = {
  async requirePermission(_publisherId, actor, permission) {
    if (permission === 'platform_review' && actor.platformAdmin) {
      return {} as DeveloperPublisherAuthority;
    }
    throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_FORBIDDEN', 403);
  },
};

test('release profile rejection happens before distribution repository or signer access', async () => {
  let calls = 0;
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: NON_READY_RUNTIME_TEST_PROFILE,
    repository: {
      async getAdmin() {
        calls += 1;
        return null;
      },
    } as never,
    signer: {
      algorithm: 'ed25519',
      keyId: 'never',
      async verify() {
        calls += 1;
        throw new Error('unexpected verifier call');
      },
      async sign() {
        calls += 1;
        throw new Error('unexpected signer call');
      },
    },
  });
  await expect(
    service.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE' });
  expect(calls).toBe(0);
});

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

function serverAdapterRelease(
  runtimeKind: DeveloperModuleRelease['runtime_kind'],
  status: DeveloperModuleRelease['status'] = 'approved',
  reviewRevision = status === 'approved' ? 2 : status === 'signed' ? 3 : 4,
): DeveloperModuleRelease {
  const result = release(status, reviewRevision);
  result.manifest.execution = {
    mode: 'server-adapter',
    entry: 'runtime/openopc.runtime.json',
  };
  result.manifest.verification = { profile: 'server-conformance' };
  result.manifest_digest = canonicalDeveloperModuleManifestDigest(result.manifest);
  result.runtime_kind = runtimeKind;
  if (runtimeKind !== null) {
    result.runtime_descriptor_digest = `sha256:${'1'.repeat(64)}`;
    result.runtime_descriptor_path = 'runtime/openopc.runtime.json';
  }
  if (status === 'signed' || status === 'published') {
    result.signature_algorithm = 'ed25519';
    result.signature_key_id = 'openopc-test-2026';
    result.signature = `base64url:${'A'.repeat(86)}`;
    result.signature_payload_digest = `sha256:${'b'.repeat(64)}`;
    result.signed_at = '2026-07-24T14:30:00.000Z';
  }
  if (status === 'published') result.published_at = '2026-07-24T14:45:00.000Z';
  return result;
}

function countedDistributionFixture(candidate: DeveloperModuleRelease) {
  const delegate = createMemoryDeveloperModuleDistributionRepository({
    releases: [candidate],
    now: () => NOW,
  });
  const effects = { signer: 0, sign: 0, transition: 0, history: 0 };
  const signer = signingPort();
  return {
    effects,
    repository: {
      ...delegate,
      async sign(command: Parameters<typeof delegate.sign>[0]) {
        effects.sign += 1;
        return delegate.sign(command);
      },
      async transition(command: Parameters<typeof delegate.transition>[0]) {
        effects.transition += 1;
        return delegate.transition(command);
      },
      async history(...args: Parameters<typeof delegate.history>) {
        effects.history += 1;
        return delegate.history(...args);
      },
    },
    signer: {
      ...signer,
      async sign(payload: Uint8Array) {
        effects.signer += 1;
        return signer.sign(payload);
      },
      async verify(...args: Parameters<typeof signer.verify>) {
        effects.signer += 1;
        return signer.verify(...args);
      },
    },
  };
}

test('sandboxed-web release eligibility follows the module render profile capability', () => {
  const candidate = release('published', 4);
  candidate.manifest.execution = { mode: 'sandboxed-web', entry: 'dist/index.html' };
  candidate.manifest.verification = { profile: 'sandboxed-web' };

  expect(() => assertReleaseRuntimeAllowed(candidate, RESTRICTED_RUNTIME_TEST_PROFILE)).toThrow(
    expect.objectContaining({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.app.render',
    }),
  );
  expect(() =>
    assertReleaseRuntimeAllowed(candidate, DEVELOPER_RUNTIME_TEST_PROFILE),
  ).not.toThrow();
});

test.each([
  ['OCI', 'oci-image'],
  ['old-null', null],
] as const)(
  'restricted profile rejects %s server-adapter sign, publish, get, and replay before side effects',
  async (_label, runtimeKind) => {
    const unavailable = {
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.oci.execute',
    };

    const signFixture = countedDistributionFixture(serverAdapterRelease(runtimeKind));
    const signService = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: signFixture.repository,
      signer: signFixture.signer,
      trustGate: trustGate(),
    });
    await expect(
      signService.sign({
        releaseId: RELEASE_ID,
        actorUserId: ADMIN_ID,
        expectedStatus: 'approved',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(signFixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });

    const publishFixture = countedDistributionFixture(serverAdapterRelease(runtimeKind, 'signed'));
    const publishService = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: publishFixture.repository,
      signer: publishFixture.signer,
      verifiers: [publishFixture.signer],
    });
    await expect(
      publishService.publish({
        releaseId: RELEASE_ID,
        actorUserId: ADMIN_ID,
        expectedStatus: 'signed',
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(publishFixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });

    const getFixture = countedDistributionFixture(serverAdapterRelease(runtimeKind, 'published'));
    const getService = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: getFixture.repository,
    });
    await expect(getService.getPublished({ releaseId: RELEASE_ID })).rejects.toMatchObject(
      unavailable,
    );
    expect(getFixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });

    const replayFixture = countedDistributionFixture(serverAdapterRelease(runtimeKind, 'signed'));
    const replayService = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: replayFixture.repository,
      signer: replayFixture.signer,
      trustGate: trustGate(),
    });
    await expect(
      replayService.sign({
        releaseId: RELEASE_ID,
        actorUserId: ADMIN_ID,
        expectedStatus: 'approved',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(replayFixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });
  },
);

test('restricted published list excludes OCI and old-null server adapters from page and total', async () => {
  const wasi = serverAdapterRelease('wasi-component', 'published');
  const oci = serverAdapterRelease('oci-image', 'published');
  oci.release_id = '30000000-0000-4000-a000-000000000008';
  const oldNull = serverAdapterRelease(null, 'published');
  oldNull.release_id = '30000000-0000-4000-a000-000000000009';
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository: createMemoryDeveloperModuleDistributionRepository({
      releases: [wasi, oci, oldNull],
    }),
  });

  const page = await service.listPublished({ limit: 10, offset: 0 });

  expect(page.total).toBe(1);
  expect(page.releases.map((candidate) => candidate.release_id)).toEqual([RELEASE_ID]);
  expect(page.releases.map((candidate) => candidate.runtime_kind)).toEqual(['wasi-component']);
});

test.each([
  ['signed', 3],
  ['published', 4],
] as const)(
  'restricted profile safely revokes an already-%s OCI release',
  async (status, revision) => {
    const repository = createMemoryDeveloperModuleDistributionRepository({
      releases: [serverAdapterRelease('oci-image', status, revision)],
      now: () => NOW,
    });
    const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository,
    });

    expect(RESTRICTED_RUNTIME_TEST_PROFILE.allows('module.oci.execute')).toBe(false);
    const revoked = await service.revoke({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: status,
      expectedRevision: revision,
      reason: 'Restricted-profile OCI safety withdrawal.',
    });

    expect(revoked.release.status).toBe('revoked');
    expect(revoked.event.action).toBe('revoke');
    expect(await repository.history(ACCOUNT_ID, RELEASE_ID)).toHaveLength(1);
  },
);

test.each([
  ['signed', 3],
  ['published', 4],
] as const)(
  'restricted profile fail-closes revoke for an already-%s old-null release without transitions or history',
  async (status, revision) => {
    const fixture = countedDistributionFixture(serverAdapterRelease(null, status, revision));
    const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: fixture.repository,
    });

    await expect(
      service.revoke({
        releaseId: RELEASE_ID,
        actorUserId: ADMIN_ID,
        expectedStatus: status,
        expectedRevision: revision,
        reason: 'Legacy metadata cannot authorize a safety transition.',
      }),
    ).rejects.toMatchObject({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.oci.execute',
    });
    expect(fixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });
  },
);

test('module.oci.execute is the only future-profile authorization delta for the same OCI target', async () => {
  expect(
    RESTRICTED_RUNTIME_CAPABILITIES.filter((capability) =>
      FUTURE_WASI_RUNTIME_TEST_PROFILE.allows(capability),
    ),
  ).toEqual(['module.wasi.execute']);
  expect(
    RESTRICTED_RUNTIME_CAPABILITIES.filter((capability) =>
      FUTURE_OCI_RUNTIME_TEST_PROFILE.allows(capability),
    ),
  ).toEqual(['module.wasi.execute', 'module.oci.execute']);

  const ociTarget = serverAdapterRelease('oci-image');
  const deniedFixture = countedDistributionFixture(ociTarget);
  const deniedService = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: FUTURE_WASI_RUNTIME_TEST_PROFILE,
    repository: deniedFixture.repository,
    signer: deniedFixture.signer,
    trustGate: trustGate(),
  });
  await expect(
    deniedService.sign({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'approved',
      expectedRevision: 2,
    }),
  ).rejects.toMatchObject({
    code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
    capability: 'module.oci.execute',
  });
  expect(deniedFixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });

  const signer = signingPort();
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [ociTarget],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: FUTURE_OCI_RUNTIME_TEST_PROFILE,
    repository,
    signer,
    verifiers: [signer],
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
  ).resolves.toMatchObject({ release: { runtime_kind: 'oci-image', status: 'signed' } });
  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).resolves.toMatchObject({ release: { runtime_kind: 'oci-image', status: 'published' } });
  await expect(service.getPublished({ releaseId: RELEASE_ID })).resolves.toMatchObject({
    runtime_kind: 'oci-image',
    status: 'published',
  });
  await expect(service.listPublished({ limit: 10, offset: 0 })).resolves.toMatchObject({
    total: 1,
    releases: [expect.objectContaining({ runtime_kind: 'oci-image', status: 'published' })],
  });
});

test.each([
  ['without module.oci.execute', FUTURE_WASI_RUNTIME_TEST_PROFILE],
  ['with module.oci.execute', FUTURE_OCI_RUNTIME_TEST_PROFILE],
] as const)(
  'future profile %s still rejects null metadata before side effects',
  async (_label, runtime) => {
    const fixture = countedDistributionFixture(serverAdapterRelease(null));
    const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
      runtime,
      repository: fixture.repository,
      signer: fixture.signer,
      trustGate: trustGate(),
    });
    await expect(
      service.sign({
        releaseId: RELEASE_ID,
        actorUserId: ADMIN_ID,
        expectedStatus: 'approved',
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.oci.execute',
    });
    expect(fixture.effects).toEqual({ signer: 0, sign: 0, transition: 0, history: 0 });
  },
);

test('signs approved declarative release and publishes only after verification', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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

test('allows a Publisher-member platform administrator to sign and publish their own release', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    publisherAccountMembers: [{ accountId: ACCOUNT_ID, userId: ADMIN_ID }],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    permissions: platformPermissions,
    now: () => NOW,
  });

  const signed = await service.sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  expect(signed.release).toMatchObject({
    status: 'signed',
    signature_algorithm: 'ed25519',
    signature_key_id: expect.any(String),
    signature: expect.any(String),
    signature_payload_digest: expect.any(String),
  });

  const published = await service.publish({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'signed',
    expectedRevision: 3,
  });
  expect(published.release.status).toBe('published');
});

test('requires the publisher permission port', () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({ releases: [release()] });

  expect(
    () =>
      new DeveloperModuleDistributionService({
        repository,
        permissions: undefined as never,
      }),
  ).toThrow('DEVELOPER_PUBLISHER_PERMISSION_PORT_REQUIRED');
});

test('fails closed when the module signer is unavailable without mutating the release', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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

test('rejects a legacy server-adapter release with no reviewed WASI metadata', async () => {
  const executable = release();
  executable.manifest.execution = { mode: 'server-adapter', entry: 'server.ts' };
  executable.manifest.verification = { profile: 'server-conformance' };
  executable.manifest_digest = canonicalDeveloperModuleManifestDigest(executable.manifest);
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [executable],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
  ).rejects.toMatchObject({
    code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
    status: 503,
  });
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    now: () => NOW,
  });
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

test('rechecks platform-review authority before replaying a completed sign command', async () => {
  let denied = false;
  const permissions = {
    async requirePermission() {
      if (denied) throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_SUSPENDED', 409);
      return {} as never;
    },
  };
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository,
    signer: signingPort(),
    trustGate: trustGate(),
    now: () => NOW,
  });
  const command = {
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved' as const,
    expectedRevision: 2,
  };

  await service.sign(command);
  denied = true;

  await expect(service.sign(command)).rejects.toMatchObject({
    code: 'DEVELOPER_PUBLISHER_SUSPENDED',
    status: 409,
  });
  expect(await repository.history(ACCOUNT_ID, RELEASE_ID)).toHaveLength(1);
});

test('rechecks platform-review authority before replaying a completed publish command', async () => {
  let denied = false;
  const permissions = {
    async requirePermission() {
      if (denied) throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_SUSPENDED', 409);
      return {} as never;
    },
  };
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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

  await service.publish(command);
  denied = true;

  await expect(service.publish(command)).rejects.toMatchObject({
    code: 'DEVELOPER_PUBLISHER_SUSPENDED',
    status: 409,
  });
  expect(await repository.history(ACCOUNT_ID, RELEASE_ID)).toHaveLength(2);
});

test('rechecks platform-review authority before replaying a completed revoke command', async () => {
  let denied = false;
  const permissions = {
    async requirePermission() {
      if (denied) throw new DeveloperPublisherError('DEVELOPER_PUBLISHER_SUSPENDED', 409);
      return {} as never;
    },
  };
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release('published', 4)],
    now: () => NOW,
  });
  const service = new DeveloperModuleDistributionService({
    permissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository,
    now: () => NOW,
  });
  const command = {
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'published' as const,
    expectedRevision: 4,
    reason: 'Verified emergency takedown.',
  };

  await service.revoke(command);
  denied = true;

  await expect(service.revoke(command)).rejects.toMatchObject({
    code: 'DEVELOPER_PUBLISHER_SUSPENDED',
    status: 409,
  });
  expect(await repository.history(ACCOUNT_ID, RELEASE_ID)).toHaveLength(1);
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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

test('publishes with a retained verification-only key after signer rotation', async () => {
  const repository = createMemoryDeveloperModuleDistributionRepository({
    releases: [release()],
    now: () => NOW,
  });
  const previous = generateKeyPairSync('ed25519');
  const previousSigner = createEd25519ModuleSigningPort({
    keyId: 'openopc-test-previous',
    privateKey: previous.privateKey,
    publicKey: previous.publicKey,
  });
  await new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository,
    signer: previousSigner,
    trustGate: trustGate(),
    now: () => NOW,
  }).sign({
    releaseId: RELEASE_ID,
    actorUserId: ADMIN_ID,
    expectedStatus: 'approved',
    expectedRevision: 2,
  });
  const rotatedSigner = signingPort();
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository,
    signer: rotatedSigner,
    verifiers: [
      rotatedSigner,
      createEd25519ModuleVerificationPort({
        keyId: previousSigner.keyId,
        publicKey: previous.publicKey,
      }),
    ],
    now: () => NOW,
  });

  await expect(
    service.publish({
      releaseId: RELEASE_ID,
      actorUserId: ADMIN_ID,
      expectedStatus: 'signed',
      expectedRevision: 3,
    }),
  ).resolves.toMatchObject({ release: { status: 'published' } });
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
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    now: () => NOW,
  });

  const page = await service.listPublished({ query: 'recruiting', limit: 10, offset: 0 });
  expect(page).toMatchObject({ total: 1 });
  expect(page.releases.map((item) => item.status)).toEqual(['published']);
  await expect(service.getPublished({ releaseId: RELEASE_ID })).resolves.toMatchObject({
    status: 'published',
  });
});

test('searches published v3 releases by catalog label before pagination', async () => {
  const published = release('published', 4);
  published.item_name = 'forecast-workbench';
  published.module_id = 'acme.forecast';
  published.manifest = {
    schemaVersion: 3,
    id: 'acme.forecast',
    version: '1.0.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    locales: ['en'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
    verification: { profile: 'sandboxed-web' },
    openopc: {
      sdkApiVersion: 'v1',
      catalog: { labels: ['weather'] },
    },
  };
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository: createMemoryDeveloperModuleDistributionRepository({ releases: [published] }),
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
  });

  const page = await service.listPublished({ query: 'weather', limit: 1, offset: 0 });

  expect(page.total).toBe(1);
  expect(page.releases.map((candidate) => candidate.release_id)).toEqual([published.release_id]);
});

test('filters server runtime kinds before published-list pagination and counting', async () => {
  const published = release('published', 4);
  published.published_at = '2026-07-24T14:45:00.000Z';
  let received: unknown;
  const repository = {
    async listPublished(input: unknown) {
      received = input;
      return { releases: [published], total: 201 };
    },
  } as never;
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
  });

  const page = await service.listPublished({ limit: 10, offset: 190 });

  expect(received).toEqual({
    serverAdapterRuntimeKinds: ['wasi-component'],
    limit: 10,
    offset: 190,
    query: undefined,
  });
  expect(page).toEqual({ releases: [published], total: 201 });
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
    permissions: testPermissions,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
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
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    now: () => NOW,
  });

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
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    now: () => NOW,
  });
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
  const service = new DeveloperModuleDistributionService({
    permissions: testPermissions,
    repository,
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    now: () => NOW,
  });

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
