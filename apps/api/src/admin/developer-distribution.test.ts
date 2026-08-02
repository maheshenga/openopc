import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { RESTRICTED_RUNTIME_TEST_PROFILE } from '../release-profile/test-fixtures';
import {
  DeveloperModuleDistributionService,
  createMemoryDeveloperModuleDistributionRepository,
} from '../developer/distribution';
import { createEd25519ModuleSigningPort } from '../developer/module-signing';
import {
  type DeveloperModuleRelease,
  canonicalDeveloperModuleManifestDigest,
} from '../developer/releases';
import { makeOpenApiApp } from '../openapi';
import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';
import { createAdminDecisionAuthorizer } from './admin-authorization';
import { registerAdminDeveloperDistributionRoutes } from './developer-distribution';

const testPermissions = {
  async requirePermission() {
    return {} as never;
  },
};

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const CREATOR_ID = '20000000-0000-4000-a000-000000000002';
const ADMIN_ID = '20000000-0000-4000-a000-000000000004';
const MEMBER_ADMIN_ID = '20000000-0000-4000-a000-000000000005';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const NOW = new Date('2026-07-24T15:00:00.000Z');

const manifest = {
  schemaVersion: 2 as const,
  id: 'acme.recruiting',
  version: '1.0.0',
  publisher: { id: 'acme', displayName: 'Acme' },
  category: 'industry' as const,
  locales: ['en'],
  compatibility: { platform: '^1.0.0' },
  execution: { mode: 'declarative' as const },
};

function release(
  status: DeveloperModuleRelease['status'] = 'approved',
  reviewRevision = 2,
): DeveloperModuleRelease {
  const signed = ['signed', 'published', 'revoked'].includes(status);
  return {
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    item_name: 'recruiting-workbench',
    publisher_id: 'acme',
    module_id: manifest.id,
    module_version: manifest.version,
    manifest,
    manifest_digest: canonicalDeveloperModuleManifestDigest(manifest),
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
    signature_algorithm: signed ? 'ed25519' : null,
    signature_key_id: signed ? 'module-key-2026' : null,
    signature: signed ? `base64url:${'a'.repeat(86)}` : null,
    signature_payload_digest: signed ? `sha256:${'b'.repeat(64)}` : null,
    signed_at: signed ? '2026-07-24T14:00:00.000Z' : null,
    published_at: status === 'published' || status === 'revoked' ? NOW.toISOString() : null,
    revoked_at: status === 'revoked' ? NOW.toISOString() : null,
    created_by: CREATOR_ID,
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T14:00:00.000Z',
  };
}

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return createEd25519ModuleSigningPort({
    keyId: 'module-key-2026',
    privateKey,
    publicKey,
  });
}

function service(input?: {
  release?: DeveloperModuleRelease;
  members?: string[];
  signerAvailable?: boolean;
}) {
  const signingPort = signer();
  return new DeveloperModuleDistributionService({
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    permissions: testPermissions,
    repository: createMemoryDeveloperModuleDistributionRepository({
      releases: [input?.release ?? release()],
      publisherAccountMembers: (input?.members ?? []).map((userId) => ({
        accountId: ACCOUNT_ID,
        userId,
      })),
      now: () => NOW,
      createId: (() => {
        let value = 0;
        return () => `40000000-0000-4000-a000-${String(++value).padStart(12, '0')}`;
      })(),
    }),
    signer: input?.signerAvailable === false ? null : signingPort,
    verifiers: [signingPort],
    trustGate: {
      evaluate: async (candidate) => {
        if (
          !candidate.artifact_digest ||
          !candidate.sbom_digest ||
          !candidate.trust_attestation_digest ||
          !candidate.verification_policy_digest
        ) {
          throw new Error('Trusted distribution fixture requires complete digests');
        }
        return {
          ok: true as const,
          evidence: {
            run_id: '60000000-0000-4000-a000-000000000006',
            artifact_digest: candidate.artifact_digest,
            sbom_digest: candidate.sbom_digest,
            attestation_digest: candidate.trust_attestation_digest,
            policy_digest: candidate.verification_policy_digest,
            runtime_descriptor_digest: candidate.runtime_descriptor_digest,
            runtime_kind: candidate.runtime_kind,
          },
        };
      },
    },
    now: () => NOW,
  });
}

function appHarness(input: {
  service: DeveloperModuleDistributionService;
  enabled?: boolean;
  recordAuditEvent?: (event: AuditEventInput) => Promise<unknown>;
  authorizationAudits?: AuditEventInput[];
}) {
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', async (context, next) => {
    const userId = context.req.header('x-test-user-id');
    if (!userId) throw new HTTPException(401, { message: 'Authentication required' });
    context.set('userId', userId);
    context.set('userEmail', 'admin@example.com');
    const permissions = context.req.header('x-test-permissions');
    const stepUp = context.req.header('x-test-step-up') !== 'missing';
    (context as unknown as { set(key: string, value: unknown): void }).set('adminSession', {
      userId,
      permissions:
        permissions === undefined
          ? ['developer.module.distribute']
          : permissions.split(',').filter(Boolean),
      stepUpAt: stepUp ? '2026-07-24T14:55:00.000Z' : null,
      stepUpExpiresAt: stepUp ? '2026-07-24T15:05:00.000Z' : null,
    });
    await next();
  });
  app.use('*', async (context, next) => {
    const role = context.req.header('x-test-platform-role');
    if (role !== 'admin' && role !== 'super_admin') {
      throw new HTTPException(403, { message: 'Admin access required' });
    }
    await next();
  });
  registerAdminDeveloperDistributionRoutes(app, {
    distributionService: input.service,
    enabled: input.enabled ?? true,
    recordAuditEvent: input.recordAuditEvent ?? (async () => undefined),
    authorizeAdminDecision: createAdminDecisionAuthorizer({
      now: () => NOW,
      recordAuditEvent: async (event) => {
        input.authorizationAudits?.push(structuredClone(event));
      },
    }),
  });
  return app;
}

const adminHeaders = {
  'x-test-user-id': ADMIN_ID,
  'x-test-platform-role': 'admin',
  'x-openopc-admin-reason': 'Publishing a verified module release',
  'content-type': 'application/json',
};

function actionRequest(
  app: ReturnType<typeof appHarness>,
  action: 'sign' | 'publish',
  body: unknown,
  headers: Record<string, string> = adminHeaders,
) {
  return app.request(`/developer/modules/releases/${RELEASE_ID}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('admin developer module distribution API', () => {
  test('stays behind the global authentication and platform-admin boundary', async () => {
    const app = appHarness({ service: service() });
    const body = { expected_status: 'approved', expected_revision: 2 };

    const anonymous = await actionRequest(app, 'sign', body, {
      'content-type': 'application/json',
    });
    const nonAdmin = await actionRequest(app, 'sign', body, {
      'x-test-user-id': ADMIN_ID,
      'x-test-platform-role': 'member',
      'content-type': 'application/json',
    });

    expect(anonymous.status).toBe(401);
    expect(nonAdmin.status).toBe(403);
  });

  test('signs then publishes with fenced revisions and bounded supplemental audit events', async () => {
    const audits: AuditEventInput[] = [];
    const authorizationAudits: AuditEventInput[] = [];
    const app = appHarness({
      service: service(),
      authorizationAudits,
      recordAuditEvent: async (event) => {
        audits.push(structuredClone(event));
      },
    });

    const signed = await actionRequest(
      app,
      'sign',
      { expected_status: 'approved', expected_revision: 2 },
      { ...adminHeaders, 'user-agent': 'distribution-test' },
    );
    const published = await actionRequest(app, 'publish', {
      expected_status: 'signed',
      expected_revision: 3,
    });

    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({
      release: expect.objectContaining({ status: 'signed', review_revision: 3 }),
      event: expect.objectContaining({ action: 'sign', sequence: 3 }),
    });
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({
      release: expect.objectContaining({ status: 'published', review_revision: 4 }),
      event: expect.objectContaining({ action: 'publish', sequence: 4 }),
    });
    expect(audits).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        action: 'developer.module.distribution.signed',
        resourceId: RELEASE_ID,
        before: { status: 'approved', review_revision: 2 },
        after: { status: 'signed', review_revision: 3 },
        userAgent: 'distribution-test',
      }),
      expect.objectContaining({
        action: 'developer.module.distribution.published',
        before: { status: 'signed', review_revision: 3 },
        after: { status: 'published', review_revision: 4 },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/base64url:|private|payload_digest/i);
    expect(authorizationAudits).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        action: 'admin.cross_tenant.authorized',
        metadata: expect.objectContaining({
          permission: 'developer.module.distribute',
          decision: 'allowed',
        }),
      }),
      expect.objectContaining({ action: 'admin.cross_tenant.authorized' }),
    ]);
  });

  test('requires exact distribution permission, step-up, and a bounded reason', async () => {
    const app = appHarness({ service: service() });
    const body = { expected_status: 'approved', expected_revision: 2 };
    const noPermission = await actionRequest(app, 'sign', body, {
      ...adminHeaders,
      'x-test-permissions': '',
    });
    const noStepUp = await actionRequest(app, 'sign', body, {
      ...adminHeaders,
      'x-test-step-up': 'missing',
    });
    const noReason = await actionRequest(app, 'sign', body, {
      'x-test-user-id': ADMIN_ID,
      'x-test-platform-role': 'admin',
      'content-type': 'application/json',
    });

    expect(noPermission.status).toBe(404);
    expect(noStepUp.status).toBe(403);
    expect(noReason.status).toBe(400);
  });

  test('allows publisher-account platform admins and returns stale conflicts as code-only errors', async () => {
    const app = appHarness({ service: service({ members: [MEMBER_ADMIN_ID] }) });
    const selfAction = await actionRequest(
      app,
      'sign',
      { expected_status: 'approved', expected_revision: 2 },
      {
        'x-test-user-id': MEMBER_ADMIN_ID,
        'x-test-platform-role': 'admin',
        'x-openopc-admin-reason': 'Publishing a verified module release',
        'content-type': 'application/json',
      },
    );
    const stale = await actionRequest(app, 'sign', {
      expected_status: 'approved',
      expected_revision: 99,
    });

    expect(selfAction.status).toBe(200);
    expect(await selfAction.json()).toEqual({
      release: expect.objectContaining({ status: 'signed', review_revision: 3 }),
      event: expect.objectContaining({ action: 'sign' }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'DEVELOPER_DISTRIBUTION_CONFLICT' });
  });

  test('fails closed when distribution or signer configuration is unavailable', async () => {
    const disabled = appHarness({ service: service(), enabled: false });
    const unavailable = appHarness({ service: service({ signerAvailable: false }) });
    const body = { expected_status: 'approved', expected_revision: 2 };
    const disabledResponse = await actionRequest(disabled, 'sign', body);
    const unavailableResponse = await actionRequest(unavailable, 'sign', body);

    expect(disabledResponse.status).toBe(503);
    expect(await disabledResponse.json()).toEqual({
      error: 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE',
    });
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.json()).toEqual({
      error: 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE',
    });
  });

  test('rejects invalid persisted signatures and strict-body key material without echoing values', async () => {
    const invalidSignature = appHarness({ service: service({ release: release('signed', 3) }) });
    const secret = 'do-not-echo-private-key-material';
    const invalid = await actionRequest(invalidSignature, 'publish', {
      expected_status: 'signed',
      expected_revision: 3,
    });
    const extra = await actionRequest(appHarness({ service: service() }), 'sign', {
      expected_status: 'approved',
      expected_revision: 2,
      private_key: secret,
    });

    expect(invalid.status).toBe(409);
    expect(await invalid.json()).toEqual({ error: 'DEVELOPER_MODULE_SIGNATURE_INVALID' });
    expect(extra.status).toBe(400);
    expect(await extra.text()).not.toContain(secret);
  });
});
