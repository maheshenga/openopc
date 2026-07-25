#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import { type Page, type Route, chromium } from 'playwright';

const webRoot = path.resolve(import.meta.dirname, '../..');
const debugPagePath = path.join(webRoot, 'src/app/(system)/debug/developer-center/page.tsx');
const baseUrl = process.env.WEB_BASE_URL || process.env.E2E_BASE_URL || 'http://127.0.0.1:3312';
const screenshotPath = path.resolve(
  process.env.DEVELOPER_CENTER_SCREENSHOT ||
    path.join(webRoot, 'test-results/developer-center-review-smoke.png'),
);
const mobileScreenshotPath = path.resolve(
  process.env.DEVELOPER_CENTER_MOBILE_SCREENSHOT ||
    path.join(webRoot, 'test-results/developer-center-review-smoke-mobile.png'),
);

const ACCOUNT_A = '21000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '21000000-0000-4000-a000-000000000002';
const RELEASE_A_VALIDATED = '22000000-0000-4000-a000-000000000003';
const RELEASE_A_PENDING = '22000000-0000-4000-a000-000000000001';
const RELEASE_A_APPROVED = '22000000-0000-4000-a000-000000000004';
const RELEASE_A_CHANGES = '22000000-0000-4000-a000-000000000005';
const RELEASE_TRUST_RUNNING = '22000000-0000-4000-a000-000000000006';
const RELEASE_TRUST_FAILED = '22000000-0000-4000-a000-000000000007';
const RELEASE_TRUST_STALE = '22000000-0000-4000-a000-000000000008';
const RELEASE_TRUST_SIGNABLE = '22000000-0000-4000-a000-000000000009';
const RELEASE_B_PENDING = '22000000-0000-4000-a000-000000000002';
const PROJECT_ID = '24000000-0000-4000-a000-000000000001';
const MODULE_ID = 'openopc.recruiting';
const MODULE_RELEASE_V1 = '25000000-0000-4000-a000-000000000001';
const MODULE_RELEASE_V2 = '25000000-0000-4000-a000-000000000002';

const RELEASE_CREATED_AT = '2026-07-24T08:00:00.000Z';
const RELEASE_UPDATED_AT = '2026-07-24T08:05:00.000Z';
const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}`;
const POLICY_DIGEST = `sha256:${'b'.repeat(64)}`;
const SCANNER_SET_DIGEST = `sha256:${'c'.repeat(64)}`;
const SANDBOX_PROFILE_DIGEST = `sha256:${'d'.repeat(64)}`;
const SBOM_DIGEST = `sha256:${'e'.repeat(64)}`;
const ATTESTATION_DIGEST = `sha256:${'f'.repeat(64)}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function statusFromBrowserError(message: string): number | null {
  if (message.includes('status of 409 (Conflict)')) return 409;
  if (message.includes('status of 404 (Not Found)')) return 404;
  if (message.includes('status of 400 (Bad Request)')) return 400;
  return null;
}

function isExpectedBrowserError(message: string, expectedHttpStatus: boolean): boolean {
  return (
    message.includes('/_next/webpack-hmr') ||
    Boolean(statusFromBrowserError(message) && expectedHttpStatus)
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function release(
  releaseId: string,
  accountId: string,
  itemName: string,
  status: 'validated' | 'review_pending' | 'approved' | 'signed',
  revision: number,
  requirements: string[],
): Record<string, unknown> {
  return {
    release_id: releaseId,
    account_id: accountId,
    item_name: itemName,
    publisher_id: accountId === ACCOUNT_A ? 'openopc-labs' : 'openopc-team',
    module_id: accountId === ACCOUNT_A ? 'openopc.recruiting' : 'openopc.directory',
    module_version: '1.0.0',
    manifest: {
      type: 'registry:module',
      id: accountId === ACCOUNT_A ? 'openopc.recruiting' : 'openopc.directory',
      publisher_id: accountId === ACCOUNT_A ? 'openopc-labs' : 'openopc-team',
      version: '1.0.0',
      execution_mode: 'server',
      permissions: ['account.read'],
      review_requirements: requirements,
    },
    manifest_digest: `sha256:${releaseId.slice(-12).padEnd(64, '0')}`,
    artifact_id: `artifact-${releaseId}`,
    artifact_digest: ARTIFACT_DIGEST,
    sbom_digest: SBOM_DIGEST,
    trust_attestation_digest: ATTESTATION_DIGEST,
    verification_policy_digest: POLICY_DIGEST,
    review_requirements: requirements,
    status,
    review_revision: revision,
    signature_algorithm: status === 'signed' ? 'ed25519' : null,
    signature_key_id: status === 'signed' ? 'openopc-2026' : null,
    signature: status === 'signed' ? `base64url:${'s'.repeat(86)}` : null,
    signature_payload_digest: status === 'signed' ? `sha256:${'9'.repeat(64)}` : null,
    signed_at: status === 'signed' ? RELEASE_UPDATED_AT : null,
    published_at: null,
    revoked_at: null,
    created_by: '31000000-0000-4000-a000-000000000001',
    created_at: RELEASE_CREATED_AT,
    updated_at: RELEASE_UPDATED_AT,
  };
}

function finding(
  releaseId: string,
  severity: 'high' | 'low',
  index: number,
): Record<string, unknown> {
  return {
    finding_id: `${releaseId}-finding-${index}`,
    fingerprint: `sha256:${String(index).repeat(64)}`,
    scanner: severity === 'high' ? 'semgrep' : 'license-policy',
    rule_id: severity === 'high' ? 'openopc.security.command-injection' : 'license.notice',
    severity,
    path: severity === 'high' ? 'agent/main.ts' : 'LICENSE',
    location: severity === 'high' ? { line: 12 } : null,
    summary:
      severity === 'high'
        ? 'Potential command injection requires remediation.'
        : 'License notice should be retained.',
    disposition: severity === 'high' ? 'blocking' : 'observed',
    created_at: RELEASE_UPDATED_AT,
  };
}

function trustAttempt(input: {
  releaseId: string;
  attempt?: number;
  state: 'queued' | 'running' | 'passed' | 'failed';
  policyDigest?: string;
  artifactDigest?: string;
  findings?: Record<string, unknown>[];
}): Record<string, unknown> {
  const terminal = input.state === 'passed' || input.state === 'failed';
  return {
    run_id: `${input.releaseId}-attempt-${input.attempt ?? 1}`,
    attempt: input.attempt ?? 1,
    state: input.state,
    policy_digest: input.policyDigest ?? POLICY_DIGEST,
    scanner_set_digest: SCANNER_SET_DIGEST,
    sandbox_profile_digest: SANDBOX_PROFILE_DIGEST,
    terminal_reason: input.state === 'failed' ? 'sandbox_failed' : null,
    sbom_digest: input.state === 'passed' ? SBOM_DIGEST : null,
    attestation_digest: input.state === 'passed' ? ATTESTATION_DIGEST : null,
    started_at: input.state === 'queued' ? null : RELEASE_CREATED_AT,
    finished_at: terminal ? RELEASE_UPDATED_AT : null,
    created_at: RELEASE_CREATED_AT,
    findings: input.findings ?? [],
    attestation:
      input.state === 'passed'
        ? {
            attestation_digest: ATTESTATION_DIGEST,
            subject_artifact_digest: input.artifactDigest ?? ARTIFACT_DIGEST,
            predicate_type: 'https://openopc.dev/attestations/developer-module-verification/v1',
            policy_digest: input.policyDigest ?? POLICY_DIGEST,
            result: 'passed',
            sbom_digest: SBOM_DIGEST,
            issuer: 'openopc-developer-trust-worker',
            created_at: RELEASE_UPDATED_AT,
          }
        : null,
  };
}

function trustView(
  releaseValue: Record<string, unknown>,
  attempts: Record<string, unknown>[],
): Record<string, unknown> {
  return {
    release_id: releaseValue.release_id,
    account_id: releaseValue.account_id,
    artifact: {
      artifact_id: releaseValue.artifact_id,
      artifact_digest: releaseValue.artifact_digest,
      media_type: 'application/vnd.openopc.developer-module.v2+json',
      size_bytes: 4096,
      source_provenance: { source: 'browser-acceptance-fixture' },
      created_at: RELEASE_CREATED_AT,
    },
    attempts,
  };
}

function event(
  releaseValue: Record<string, unknown>,
  sequence: number,
  action: string,
  fromStatus: string,
  toStatus: string,
  reason: string | null = null,
): Record<string, unknown> {
  return {
    review_event_id: `32000000-0000-4000-a000-${String(sequence).padStart(12, '0')}`,
    release_id: releaseValue.release_id,
    account_id: releaseValue.account_id,
    sequence,
    action,
    from_status: fromStatus,
    to_status: toStatus,
    actor_user_id: '31000000-0000-4000-a000-000000000001',
    actor_kind: action === 'submit' || action === 'resubmit' ? 'publisher' : 'platform_admin',
    reason,
    evidence: [],
    created_at: RELEASE_UPDATED_AT,
  };
}

function runSourcePreflight(): void {
  assert(fs.existsSync(debugPagePath), `debug page is missing: ${debugPagePath}`);
  const source = fs.readFileSync(debugPagePath, 'utf8');
  for (const importName of [
    'PublisherReleaseListView',
    'PublisherReleaseDetailView',
    'DeveloperModuleSubmitView',
    'AdminDeveloperReviewQueueView',
    'AdminDeveloperReviewDetailView',
    'ProjectModulesView',
  ]) {
    assert(
      source.includes(importName),
      `debug page must import production component ${importName}`,
    );
  }
  assert(
    !source.includes('const STATUS_LABELS'),
    'debug page must not duplicate lifecycle status maps',
  );
  assert(source.includes('invalidateTokenCache'), 'debug page must clear its auth cache on exit');
  assert(
    source.includes('setSelectedAccountId(DEBUG_TEAM_ACCOUNT_ID)'),
    'debug account switching must update the shared account store',
  );
}

function jsonBody(route: Route): Record<string, unknown> {
  const raw = route.request().postData();
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installRoutes(page: Page) {
  const releases = new Map<string, Record<string, unknown>>([
    [
      RELEASE_A_VALIDATED,
      release(RELEASE_A_VALIDATED, ACCOUNT_A, 'Recruiting module', 'validated', 0, [
        'manifest_review',
        'human_review',
      ]),
    ],
    [
      RELEASE_A_PENDING,
      release(RELEASE_A_PENDING, ACCOUNT_A, 'Recruiting review', 'review_pending', 1, [
        'manifest_review',
        'source_scan',
        'sandbox_test',
        'permission_review',
        'human_review',
      ]),
    ],
    [
      RELEASE_A_APPROVED,
      release(RELEASE_A_APPROVED, ACCOUNT_A, 'Recruiting approved', 'approved', 2, [
        'manifest_review',
        'human_review',
      ]),
    ],
    [
      RELEASE_A_CHANGES,
      release(RELEASE_A_CHANGES, ACCOUNT_A, 'Recruiting changes', 'review_pending', 1, [
        'manifest_review',
        'human_review',
      ]),
    ],
    [
      RELEASE_TRUST_RUNNING,
      release(RELEASE_TRUST_RUNNING, ACCOUNT_A, 'Running trust review', 'review_pending', 1, [
        'manifest_review',
        'source_scan',
        'sandbox_test',
      ]),
    ],
    [
      RELEASE_TRUST_FAILED,
      release(RELEASE_TRUST_FAILED, ACCOUNT_A, 'Failed trust review', 'review_pending', 1, [
        'manifest_review',
        'source_scan',
        'sandbox_test',
      ]),
    ],
    [
      RELEASE_TRUST_STALE,
      release(RELEASE_TRUST_STALE, ACCOUNT_A, 'Stale trust review', 'review_pending', 1, [
        'manifest_review',
        'source_scan',
        'sandbox_test',
      ]),
    ],
    [
      RELEASE_TRUST_SIGNABLE,
      release(RELEASE_TRUST_SIGNABLE, ACCOUNT_A, 'Passing trust signature', 'approved', 2, [
        'manifest_review',
        'source_scan',
        'sandbox_test',
      ]),
    ],
    [
      RELEASE_B_PENDING,
      release(RELEASE_B_PENDING, ACCOUNT_B, 'Team directory', 'review_pending', 1, [
        'manifest_review',
        'human_review',
      ]),
    ],
  ]);
  const histories = new Map<string, Record<string, unknown>[]>(
    [...releases].map(([id, value]) => [
      id,
      value.status === 'validated'
        ? []
        : [event(value, 1, 'submit', 'validated', 'review_pending')],
    ]),
  );
  const moduleReleases = [
    {
      release_id: MODULE_RELEASE_V1,
      module_id: MODULE_ID,
      module_version: '1.0.0',
      name: 'Recruiting module',
      publisher_id: 'openopc-labs',
      signature_key_id: 'openopc-2026',
      signed_at: RELEASE_UPDATED_AT,
      published_at: RELEASE_UPDATED_AT,
      type: 'registry:module',
      source: 'openopc-modules',
    },
    {
      release_id: MODULE_RELEASE_V2,
      module_id: MODULE_ID,
      module_version: '2.0.0',
      name: 'Recruiting module',
      publisher_id: 'openopc-labs',
      signature_key_id: 'openopc-2026',
      signed_at: RELEASE_UPDATED_AT,
      published_at: RELEASE_UPDATED_AT,
      type: 'registry:module',
      source: 'openopc-modules',
    },
  ];
  const installations = new Map<string, Record<string, unknown>>();
  const installationHistories = new Map<string, Record<string, unknown>[]>();
  const artifacts = new Map<string, Record<string, unknown>>();
  const pendingUploads = new Map<string, Record<string, unknown>>();
  let forceModuleConflict = true;
  const requests = {
    validation: 0,
    submissions: 0,
    uploadTickets: [] as Record<string, unknown>[],
    uploadPuts: [] as string[],
    uploadFinalizations: [] as string[],
    trustReads: [] as string[],
    reviewRequests: [] as Record<string, unknown>[],
    decisions: [] as Record<string, unknown>[],
    distributions: [] as Record<string, unknown>[],
    accountIds: [] as string[],
    queueCursors: [] as (string | null)[],
    queueStatuses: [] as string[],
    adminDetailReads: [] as string[],
    projectModuleInstalls: [] as Record<string, unknown>[],
    projectModuleMoves: [] as Record<string, unknown>[],
    projectModuleHistories: [] as string[],
    unknown: [] as string[],
    forceConflict: true,
  };

  const trustFor = (releaseId: string, current: Record<string, unknown>) => {
    const attempt = (state: 'queued' | 'running' | 'passed' | 'failed', input = {}) =>
      trustAttempt({
        releaseId,
        state,
        artifactDigest: String(current.artifact_digest),
        ...input,
      });
    if (releaseId === RELEASE_TRUST_RUNNING) {
      return trustView(current, [attempt('running')]);
    }
    if (releaseId === RELEASE_TRUST_FAILED) {
      return trustView(current, [
        attempt('failed', { attempt: 1 }),
        attempt('failed', {
          attempt: 2,
          findings: [finding(releaseId, 'high', 1), finding(releaseId, 'low', 2)],
        }),
      ]);
    }
    if (releaseId === RELEASE_TRUST_STALE) {
      return trustView(current, [
        attempt('passed', { policyDigest: `sha256:${'0'.repeat(64)}` }),
      ]);
    }
    if (releaseId.startsWith('23000000-')) {
      return trustView(current, [attempt('queued')]);
    }
    return trustView(current, [attempt('passed')]);
  };

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/__developer-upload/') && request.method() === 'PUT') {
      requests.uploadPuts.push(url.pathname);
      await route.fulfill({ status: 200, body: '' });
      return;
    }
    const projectModulesPrefix = `/projects/${PROJECT_ID}/modules`;
    if (url.pathname.includes(projectModulesPrefix)) {
      assert(
        request.headers().authorization === 'Bearer debug-developer-center-token',
        `project module request missing debug token: ${url.pathname}`,
      );
      const body = request.method() === 'POST' ? jsonBody(route) : {};
      if (url.pathname.endsWith(projectModulesPrefix) && request.method() === 'GET') {
        await fulfill(route, 200, { modules: clone([...installations.values()]) });
        return;
      }
      if (url.pathname.endsWith('/history') && request.method() === 'GET') {
        const moduleId = decodeURIComponent(
          url.pathname.slice(0, -'/history'.length).split('/').at(-1) ?? '',
        );
        requests.projectModuleHistories.push(moduleId);
        const installation = installations.get(moduleId);
        await fulfill(route, 200, {
          history: clone(
            installation
              ? (installationHistories.get(String(installation.installation_id)) ?? [])
              : [],
          ),
        });
        return;
      }
      if (url.pathname.endsWith('/install') && request.method() === 'POST') {
        requests.projectModuleInstalls.push(clone(body));
        const releaseId = String(body.release_id ?? '');
        const release = moduleReleases.find((candidate) => candidate.release_id === releaseId);
        if (!release || installations.has(release.module_id)) {
          await fulfill(route, 409, { error: 'PROJECT_MODULE_INSTALL_CONFLICT' });
          return;
        }
        const installationId = '26000000-0000-4000-a000-000000000001';
        const event = {
          installation_event_id: '27000000-0000-4000-a000-000000000001',
          installation_id: installationId,
          project_id: PROJECT_ID,
          account_id: ACCOUNT_A,
          sequence: 1,
          action: 'install',
          from_release_id: null,
          to_release_id: releaseId,
          expected_revision: 0,
          resulting_revision: 1,
          idempotency_key: String(request.headers()['idempotency-key'] ?? ''),
          actor_user_id: '31000000-0000-4000-a000-000000000001',
          created_at: RELEASE_UPDATED_AT,
        };
        const installation = {
          installation_id: installationId,
          project_id: PROJECT_ID,
          account_id: ACCOUNT_A,
          module_id: release.module_id,
          active_release_id: releaseId,
          active_version: release.module_version,
          install_revision: 1,
          status: 'active',
          installed_by: '31000000-0000-4000-a000-000000000001',
          created_at: RELEASE_UPDATED_AT,
          updated_at: RELEASE_UPDATED_AT,
        };
        installations.set(release.module_id, installation);
        installationHistories.set(installationId, [event]);
        await fulfill(route, 201, { installation, event });
        return;
      }
      const moveMatch = url.pathname.match(
        new RegExp(`${projectModulesPrefix}/([^/]+)/(update|rollback)$`),
      );
      if (moveMatch && request.method() === 'POST') {
        const moduleId = decodeURIComponent(moveMatch[1]);
        const action = moveMatch[2];
        requests.projectModuleMoves.push({ action, ...clone(body) });
        const installation = installations.get(moduleId);
        const expectedRevision = Number(body.expected_install_revision);
        if (!installation || expectedRevision !== Number(installation.install_revision)) {
          await fulfill(route, 409, { error: 'PROJECT_MODULE_INSTALL_CONFLICT' });
          return;
        }
        if (action === 'rollback' && forceModuleConflict) {
          forceModuleConflict = false;
          await fulfill(route, 409, { error: 'PROJECT_MODULE_INSTALL_CONFLICT' });
          return;
        }
        const releaseId = String(body.release_id ?? '');
        const release = moduleReleases.find((candidate) => candidate.release_id === releaseId);
        const history = installationHistories.get(String(installation.installation_id)) ?? [];
        if (
          !release ||
          (action === 'rollback' && !history.some((event) => event.to_release_id === releaseId))
        ) {
          await fulfill(route, 409, { error: 'PROJECT_MODULE_ROLLBACK_TARGET_INVALID' });
          return;
        }
        const nextRevision = expectedRevision + 1;
        const event = {
          installation_event_id: `27000000-0000-4000-a000-${String(nextRevision).padStart(12, '0')}`,
          installation_id: installation.installation_id,
          project_id: PROJECT_ID,
          account_id: ACCOUNT_A,
          sequence: nextRevision,
          action,
          from_release_id: installation.active_release_id,
          to_release_id: releaseId,
          expected_revision: expectedRevision,
          resulting_revision: nextRevision,
          idempotency_key: String(request.headers()['idempotency-key'] ?? ''),
          actor_user_id: '31000000-0000-4000-a000-000000000001',
          created_at: RELEASE_UPDATED_AT,
        };
        const nextInstallation = {
          ...installation,
          active_release_id: releaseId,
          active_version: release.module_version,
          install_revision: nextRevision,
          updated_at: RELEASE_UPDATED_AT,
        };
        installations.set(moduleId, nextInstallation);
        history.push(event);
        installationHistories.set(String(installation.installation_id), history);
        await fulfill(route, 200, { installation: nextInstallation, event });
        return;
      }
      requests.unknown.push(`${request.method()} ${url.pathname}`);
      await fulfill(route, 500, { error: 'UNEXPECTED_PROJECT_MODULE_REQUEST' });
      return;
    }
    if (url.pathname.endsWith('/marketplace/items') && request.method() === 'GET') {
      await fulfill(route, 200, { items: clone(moduleReleases) });
      return;
    }
    if (!url.pathname.includes('/developer/modules/')) return route.continue();
    assert(
      request.headers().authorization === 'Bearer debug-developer-center-token',
      `developer request missing debug token: ${url.pathname}`,
    );

    const pathName = url.pathname;
    const body = request.method() === 'POST' ? jsonBody(route) : {};
    const isAdmin = pathName.includes('/admin/developer/modules/');

    if (
      pathName.endsWith('/developer/modules/artifacts/declarative') &&
      request.method() === 'POST'
    ) {
      const item = (body.item ?? {}) as Record<string, unknown>;
      const artifactId = `artifact-declarative-${artifacts.size + 1}`;
      const artifact = {
        artifact_id: artifactId,
        account_id: String(body.account_id ?? ACCOUNT_A),
        publisher_id: String(item.publisher_id ?? 'openopc-labs'),
        artifact_digest: ARTIFACT_DIGEST,
        envelope_digest: `sha256:${'8'.repeat(64)}`,
        media_type: 'application/vnd.openopc.developer-module.v2+json',
        size_bytes: JSON.stringify(item).length,
        item_snapshot: clone(item),
        source_provenance: null,
        created_by: '31000000-0000-4000-a000-000000000001',
        created_at: RELEASE_CREATED_AT,
      };
      artifacts.set(artifactId, artifact);
      await fulfill(route, 201, clone(artifact));
      return;
    }

    if (
      pathName.endsWith('/developer/modules/artifact-uploads') &&
      request.method() === 'POST'
    ) {
      requests.uploadTickets.push(clone(body));
      const uploadId = `upload-${requests.uploadTickets.length}`;
      pendingUploads.set(uploadId, clone(body));
      await fulfill(route, 201, {
        upload_id: uploadId,
        state: 'created',
        expected_digest: body.expected_digest,
        expected_size: body.expected_size,
        upload_url: `${baseUrl}/__developer-upload/${uploadId}`,
        headers: { 'x-openopc-upload-fixture': 'accepted' },
        expires_at: '2026-07-25T10:00:00.000Z',
      });
      return;
    }

    const uploadMatch = pathName.match(
      /\/developer\/modules\/artifact-uploads\/([^/]+)(?:\/(finalize))?$/,
    );
    if (uploadMatch) {
      const uploadId = decodeURIComponent(uploadMatch[1]);
      const pendingUpload = pendingUploads.get(uploadId);
      if (!pendingUpload) {
        await fulfill(route, 404, { error: 'DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND' });
        return;
      }
      if (uploadMatch[2] === 'finalize' && request.method() === 'POST') {
        requests.uploadFinalizations.push(uploadId);
        const artifactId = `artifact-package-${uploadId}`;
        const artifact = {
          artifact_id: artifactId,
          account_id: String(body.account_id ?? ACCOUNT_A),
          publisher_id: String(pendingUpload.publisher_id ?? 'openopc-labs'),
          artifact_digest: String(pendingUpload.expected_digest),
          envelope_digest: `sha256:${'7'.repeat(64)}`,
          media_type: 'application/vnd.openopc.developer-module.v2+json',
          size_bytes: Number(pendingUpload.expected_size),
          item_snapshot: {
            type: 'registry:module',
            item_name: 'Packaged module',
            publisher_id: pendingUpload.publisher_id,
          },
          source_provenance: { source: 'browser-package-upload' },
          created_by: '31000000-0000-4000-a000-000000000001',
          created_at: RELEASE_CREATED_AT,
        };
        artifacts.set(artifactId, artifact);
        await fulfill(route, 200, clone(artifact));
        return;
      }
      if (request.method() === 'DELETE') {
        pendingUploads.delete(uploadId);
        await route.fulfill({ status: 204, body: '' });
        return;
      }
    }

    if (pathName.endsWith('/developer/modules/validate') && request.method() === 'POST') {
      requests.validation += 1;
      await fulfill(route, 200, { valid: true, issues: [] });
      return;
    }

    if (
      !isAdmin &&
      pathName.endsWith('/developer/modules/releases') &&
      request.method() === 'GET'
    ) {
      const accountId = url.searchParams.get('account_id') ?? '';
      requests.accountIds.push(accountId);
      await fulfill(route, 200, {
        releases: clone([...releases.values()].filter((value) => value.account_id === accountId)),
      });
      return;
    }

    if (
      !isAdmin &&
      pathName.endsWith('/developer/modules/releases') &&
      request.method() === 'POST'
    ) {
      requests.submissions += 1;
      const accountId = String(body.account_id ?? '');
      requests.accountIds.push(accountId);
      const artifact = artifacts.get(String(body.artifact_id ?? ''));
      if (!artifact || artifact.account_id !== accountId) {
        await fulfill(route, 404, { error: 'DEVELOPER_ARTIFACT_NOT_FOUND' });
        return;
      }
      const item = (artifact.item_snapshot ?? {}) as Record<string, unknown>;
      const created = release(
        `23000000-0000-4000-a000-${String(requests.submissions).padStart(12, '0')}`,
        accountId,
        String(item.item_name ?? 'Submitted module'),
        'validated',
        0,
        artifact.source_provenance
          ? ['manifest_review', 'source_scan', 'sandbox_test', 'human_review']
          : Array.isArray(item.review_requirements)
          ? item.review_requirements.map(String)
          : ['manifest_review', 'human_review'],
      );
      created.manifest = item;
      created.artifact_id = artifact.artifact_id;
      created.artifact_digest = artifact.artifact_digest;
      created.verification_policy_digest = POLICY_DIGEST;
      releases.set(String(created.release_id), created);
      histories.set(String(created.release_id), []);
      await fulfill(route, 201, { created: true, release: clone(created) });
      return;
    }

    const publicMatch = pathName.match(/\/developer\/modules\/releases\/([^/]+)(?:\/(.*))?$/);
    if (!isAdmin && publicMatch) {
      const releaseId = decodeURIComponent(publicMatch[1]);
      const suffix = publicMatch[2] ?? '';
      const current = releases.get(releaseId);
      const accountId = url.searchParams.get('account_id') ?? String(body.account_id ?? '');
      if (accountId) requests.accountIds.push(accountId);
      if (!current || (accountId && current.account_id !== accountId)) {
        await fulfill(route, 404, { error: 'DEVELOPER_RELEASE_NOT_FOUND' });
        return;
      }
      if (suffix === 'trust' && request.method() === 'GET') {
        requests.trustReads.push(releaseId);
        await fulfill(route, 200, clone(trustFor(releaseId, current)));
        return;
      }
      if (suffix === 'review-history' && request.method() === 'GET') {
        await fulfill(route, 200, { history: clone(histories.get(releaseId) ?? []) });
        return;
      }
      if (suffix === 'review-requests' && request.method() === 'POST') {
        requests.reviewRequests.push(clone(body));
        const fromStatus = String(current.status);
        current.status = 'review_pending';
        current.review_revision = Number(current.review_revision) + 1;
        const nextEvent = event(
          current,
          Number(current.review_revision),
          'submit',
          fromStatus,
          'review_pending',
        );
        histories.get(releaseId)?.push(nextEvent);
        await fulfill(route, 200, { release: clone(current), event: clone(nextEvent) });
        return;
      }
      if (suffix === '' && request.method() === 'GET') {
        await fulfill(route, 200, clone(current));
        return;
      }
    }

    if (
      isAdmin &&
      pathName.endsWith('/admin/developer/modules/reviews') &&
      request.method() === 'GET'
    ) {
      const cursor = url.searchParams.get('cursor');
      if (cursor === 'not-a-valid-cursor') {
        await fulfill(route, 400, { error: 'DEVELOPER_REVIEW_INPUT_INVALID' });
        return;
      }
      const status = url.searchParams.get('status') ?? 'review_pending';
      requests.queueCursors.push(cursor);
      requests.queueStatuses.push(status);
      const rows = [...releases.values()].filter((value) => value.status === status);
      const pageRows = cursor ? rows.slice(1) : rows.slice(0, 1);
      await fulfill(route, 200, {
        releases: clone(pageRows),
        next_cursor: cursor ? null : rows.length > 1 ? 'cursor-1' : null,
      });
      return;
    }

    const adminTrustMatch = pathName.match(
      /\/admin\/developer\/modules\/releases\/([^/]+)\/trust$/,
    );
    if (isAdmin && adminTrustMatch && request.method() === 'GET') {
      const releaseId = decodeURIComponent(adminTrustMatch[1]);
      const current = releases.get(releaseId);
      if (!current) {
        await fulfill(route, 404, { error: 'DEVELOPER_RELEASE_NOT_FOUND' });
        return;
      }
      requests.trustReads.push(releaseId);
      await fulfill(route, 200, clone(trustFor(releaseId, current)));
      return;
    }

    const distributionMatch = pathName.match(
      /\/admin\/developer\/modules\/releases\/([^/]+)\/(sign|publish)$/,
    );
    if (isAdmin && distributionMatch && request.method() === 'POST') {
      const releaseId = decodeURIComponent(distributionMatch[1]);
      const action = distributionMatch[2];
      const current = releases.get(releaseId);
      if (!current) {
        await fulfill(route, 404, { error: 'DEVELOPER_RELEASE_NOT_FOUND' });
        return;
      }
      requests.distributions.push({ release_id: releaseId, action, ...clone(body) });
      const expectedStatus = action === 'sign' ? 'approved' : 'signed';
      if (
        current.status !== expectedStatus ||
        Number(current.review_revision) !== Number(body.expected_revision)
      ) {
        await fulfill(route, 409, { error: 'DEVELOPER_DISTRIBUTION_CONFLICT' });
        return;
      }
      const fromStatus = String(current.status);
      current.status = action === 'sign' ? 'signed' : 'published';
      current.review_revision = Number(current.review_revision) + 1;
      if (action === 'sign') {
        current.signature_algorithm = 'ed25519';
        current.signature_key_id = 'openopc-2026';
        current.signature = `base64url:${'s'.repeat(86)}`;
        current.signature_payload_digest = `sha256:${'9'.repeat(64)}`;
        current.signed_at = RELEASE_UPDATED_AT;
      } else {
        current.published_at = RELEASE_UPDATED_AT;
      }
      const nextEvent = event(
        current,
        Number(current.review_revision),
        action,
        fromStatus,
        String(current.status),
      );
      histories.get(releaseId)?.push(nextEvent);
      await fulfill(route, 200, { release: clone(current), event: clone(nextEvent) });
      return;
    }

    const adminMatch = pathName.match(
      /\/admin\/developer\/modules\/releases\/([^/]+)\/review(?:-decisions)?$/,
    );
    if (isAdmin && adminMatch) {
      const releaseId = decodeURIComponent(adminMatch[1]);
      const current = releases.get(releaseId);
      if (!current) {
        await fulfill(route, 404, { error: 'DEVELOPER_RELEASE_NOT_FOUND' });
        return;
      }
      if (pathName.endsWith('/review') && request.method() === 'GET') {
        requests.adminDetailReads.push(releaseId);
        await fulfill(route, 200, {
          release: clone(current),
          history: clone(histories.get(releaseId) ?? []),
        });
        return;
      }
      if (pathName.endsWith('/review-decisions') && request.method() === 'POST') {
        requests.decisions.push(clone(body));
        if (requests.forceConflict && body.decision === 'approve') {
          requests.forceConflict = false;
          current.review_revision = Number(current.review_revision) + 1;
          current.updated_at = new Date().toISOString();
          await fulfill(route, 409, { error: 'DEVELOPER_REVIEW_CONFLICT' });
          return;
        }
        const fromStatus = String(current.status);
        const nextStatus =
          body.decision === 'approve'
            ? 'approved'
            : body.decision === 'revoke'
              ? 'revoked'
              : 'changes_requested';
        current.status = nextStatus;
        current.review_revision = Number(current.review_revision) + 1;
        const nextEvent = event(
          current,
          Number(current.review_revision),
          String(body.decision),
          fromStatus,
          nextStatus,
          typeof body.reason === 'string' ? body.reason : null,
        );
        histories.get(releaseId)?.push(nextEvent);
        await fulfill(route, 200, { release: clone(current), event: clone(nextEvent) });
        return;
      }
    }

    requests.unknown.push(`${request.method()} ${pathName}`);
    await fulfill(route, 500, { error: 'UNEXPECTED_DEVELOPER_CENTER_REQUEST' });
  });

  return requests;
}

async function visibleText(page: Page, text: RegExp | string): Promise<void> {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 30_000 });
}

async function fillApprovalEvidence(page: Page): Promise<void> {
  const summaries = page.getByRole('textbox', { name: /evidence summary/i });
  for (let index = 0; index < (await summaries.count()); index += 1) {
    await summaries
      .nth(index)
      .fill('Reviewed the declared requirement and recorded a redacted pass.');
  }
}

function decodePng(buffer: Buffer): { width: number; height: number; pixels: Buffer; bpp: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert(buffer.subarray(0, 8).equals(signature), 'Developer Center screenshot is not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  assert(bitDepth === 8 && (colorType === 2 || colorType === 6), 'Unsupported screenshot PNG');
  const bpp = colorType === 6 ? 4 : 3;
  const rowBytes = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * rowBytes);
  let sourceOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[sourceOffset++];
    const rowOffset = y * rowBytes;
    const previousOffset = (y - 1) * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const left = x >= bpp ? pixels[rowOffset + x - bpp] : 0;
      const up = y > 0 ? pixels[previousOffset + x] : 0;
      const upperLeft = y > 0 && x >= bpp ? pixels[previousOffset + x - bpp] : 0;
      const value = raw[sourceOffset++];
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const leftDistance = Math.abs(estimate - left);
        const upDistance = Math.abs(estimate - up);
        const upperLeftDistance = Math.abs(estimate - upperLeft);
        predictor =
          leftDistance <= upDistance && leftDistance <= upperLeftDistance
            ? left
            : upDistance <= upperLeftDistance
              ? up
              : upperLeft;
      }
      pixels[rowOffset + x] = (value + predictor) & 0xff;
    }
  }
  return { width, height, pixels, bpp };
}

async function assertScreenshotHasVisualContent(filePath: string): Promise<void> {
  const image = decodePng(fs.readFileSync(filePath));
  const pixels = image.pixels;
  let minimum = 255;
  let maximum = 0;
  let visibleSamples = 0;
  const stride = image.bpp * 64;
  for (let index = 0; index < pixels.length; index += stride) {
    const alpha = image.bpp === 4 ? pixels[index + 3] : 255;
    if (alpha === 0) continue;
    visibleSamples += 1;
    const luminance = Math.round(
      0.2126 * pixels[index] + 0.7152 * pixels[index + 1] + 0.0722 * pixels[index + 2],
    );
    minimum = Math.min(minimum, luminance);
    maximum = Math.max(maximum, luminance);
  }
  assert(visibleSamples > 10, 'Developer Center screenshot has no visible pixels');
  assert(maximum - minimum > 10, 'Developer Center screenshot is visually blank');
}

async function main() {
  runSourcePreflight();
  const browser = await chromium.launch();
  const consoleErrors: string[] = [];
  const expectedDeveloperHttpStatuses: number[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (
      (pathname.includes('/developer/modules/') ||
        pathname.includes(`/projects/${PROJECT_ID}/modules`)) &&
      (response.status() === 400 || response.status() === 404 || response.status() === 409)
    ) {
      expectedDeveloperHttpStatuses.push(response.status());
    }
  });
  page.on('console', (message) => {
    const status = statusFromBrowserError(message.text());
    const expectedIndex = status ? expectedDeveloperHttpStatuses.indexOf(status) : -1;
    const expectedHttpStatus = expectedIndex >= 0;
    if (expectedHttpStatus) expectedDeveloperHttpStatuses.splice(expectedIndex, 1);
    if (message.type() === 'error' && !isExpectedBrowserError(message.text(), expectedHttpStatus)) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  const requests = await installRoutes(page);

  try {
    await page.goto(`${baseUrl}/debug/developer-center`, { waitUntil: 'domcontentloaded' });
    await visibleText(page, 'Recent releases');

    const search = page.getByPlaceholder('Search loaded releases');
    await search.fill('Recruiting');
    await visibleText(page, 'Recruiting module');
    await search.fill('does-not-exist');
    await visibleText(page, 'No releases found.');
    await search.fill('');

    await page.getByTestId('debug-publisher-submit').click();
    await page.getByRole('tab', { name: /^package upload$/i }).click();
    await page.locator('#developer-module-package').setInputFiles({
      name: 'recruiting.openopc',
      mimeType: 'application/vnd.openopc.developer-module.v2+json',
      buffer: Buffer.from('{"fixture":"developer-package"}'),
    });
    await page.locator('#developer-module-publisher').fill('openopc-labs');
    await page.getByRole('button', { name: /^upload package$/i }).click();
    await visibleText(page, 'Packaged module');
    await visibleText(page, 'Sandbox verification is queued.');
    assert(requests.uploadTickets.length === 1, 'package upload must request one upload ticket');
    assert(requests.uploadPuts.length === 1, 'package bytes must be uploaded exactly once');
    assert(
      requests.uploadFinalizations.length === 1,
      'package upload must finalize exactly one server artifact',
    );
    assert(requests.submissions === 1, 'package artifact must submit one immutable release');
    await visibleText(page, 'Immutable attempts');
    await visibleText(page, 'Attempt 1');

    await page.getByTestId('debug-publisher-submit').click();
    const manifest = page.locator('#developer-module-json');
    await manifest.fill('{');
    await page.getByRole('button', { name: /^validate$/i }).click();
    await visibleText(page, 'INVALID_JSON');
    assert(requests.validation === 0, 'malformed JSON must not call validation API');

    await manifest.fill(
      JSON.stringify({
        type: 'registry:module',
        publisher_id: 'openopc-labs',
        id: 'openopc.recruiting',
        version: '1.1.0',
        item_name: 'Submitted module',
        review_requirements: ['manifest_review', 'human_review'],
      }),
    );
    await page.getByRole('button', { name: /^validate$/i }).click();
    await visibleText(page, 'Confirm submission');
    assert(Number(requests.validation) === 1, 'valid manifest should call validation exactly once');
    await page.getByRole('button', { name: /^submit release$/i }).click();
    await visibleText(page, 'Submitted module');
    assert(
      Number(requests.submissions) === 2,
      'both package and declarative submissions should post once',
    );

    await page.getByTestId('debug-project-modules').click();
    await visibleText(page, 'No modules installed');
    await visibleText(page, 'Available modules');
    const installModule = page.getByTestId('install-module');
    assert(
      (await installModule.count()) === 2,
      'both published exact module releases must be visible',
    );
    await installModule.filter({ hasText: 'Install' }).first().click();
    await visibleText(page, 'Install exact release?');
    await page.getByRole('button', { name: /^install release$/i }).click();
    await visibleText(page, '1 active');
    await visibleText(page, '1.0.0');
    assert(
      requests.projectModuleInstalls.length === 1 &&
        requests.projectModuleInstalls[0].release_id === MODULE_RELEASE_V1,
      'project install must use the exact v1 release id',
    );

    await page.getByTestId('update-module').click();
    await visibleText(page, 'Update exact release?');
    await page.getByRole('button', { name: /^update release$/i }).click();
    await page.getByText('2.0.0', { exact: true }).first().waitFor({ state: 'visible' });
    assert(
      requests.projectModuleMoves.some(
        (move) => move.action === 'update' && move.release_id === MODULE_RELEASE_V2,
      ),
      'project update must target the exact v2 release id',
    );

    await page.getByTestId('rollback-module').click();
    await visibleText(page, 'Rollback exact release?');
    await page.getByRole('button', { name: /^rollback release$/i }).click();
    await page.getByText('2.0.0', { exact: true }).first().waitFor({ state: 'visible' });
    assert(
      requests.projectModuleMoves.filter((move) => move.action === 'rollback').length === 1,
      'stale rollback must not be replayed automatically',
    );
    await page.getByTestId('rollback-module').click();
    await visibleText(page, 'Rollback exact release?');
    await page.getByRole('button', { name: /^rollback release$/i }).click();
    await page.getByText('1.0.0', { exact: true }).first().waitFor({ state: 'visible' });
    assert(
      requests.projectModuleMoves.filter((move) => move.action === 'rollback').length === 2,
      'rollback retry must be an explicit second request after refetch',
    );
    assert(
      requests.projectModuleHistories.length >= 1,
      'history must be read when a project module state is reloaded',
    );
    await page.getByTestId('history-module').click();
    await visibleText(page, 'Installation history');
    await visibleText(page, 'Revision 2');
    await page.keyboard.press('Escape');

    await page.getByTestId('debug-publisher-detail').click();
    await visibleText(page, 'Recruiting module');
    await page.getByRole('button', { name: /^request review$/i }).click();
    await page.getByLabel('Status: Review pending').waitFor({ state: 'visible' });
    assert(requests.reviewRequests.length === 1, 'publisher review request should post once');
    assert(
      requests.reviewRequests[0].expected_status === 'validated',
      'review request status mismatch',
    );
    assert(requests.reviewRequests[0].expected_revision === 0, 'review request revision mismatch');

    await page.getByTestId('debug-admin-queue').click();
    await visibleText(page, 'Review queue');
    assert(
      requests.queueCursors.at(-1) === null,
      'the first admin queue request must not include a cursor',
    );
    const next = page.getByRole('button', { name: /^next page$/i });
    await next.waitFor({ state: 'visible' });
    await next.click();
    await visibleText(page, 'Recruiting review');
    assert(
      requests.queueCursors.at(-1) === 'cursor-1',
      'next page must request the advertised cursor',
    );
    assert(
      requests.unknown.length === 0,
      `unexpected Developer Center requests: ${requests.unknown.join(', ')}`,
    );

    for (const trustCase of [
      {
        releaseId: RELEASE_TRUST_RUNNING,
        title: 'Running trust review',
        message: 'Sandbox verification is still running.',
      },
      {
        releaseId: RELEASE_TRUST_FAILED,
        title: 'Failed trust review',
        message: 'Sandbox verification did not pass.',
      },
      {
        releaseId: RELEASE_TRUST_STALE,
        title: 'Stale trust review',
        message: 'Automatic verification uses a stale policy and must be retried.',
      },
    ]) {
      await page.goto(
        `${baseUrl}/debug/developer-center?mode=admin-detail&releaseId=${trustCase.releaseId}`,
        { waitUntil: 'domcontentloaded' },
      );
      await visibleText(page, trustCase.title);
      await visibleText(page, trustCase.message);
      await fillApprovalEvidence(page);
      assert(
        await page.getByTestId('approve-decision').isDisabled(),
        `approval must stay disabled for ${trustCase.title}`,
      );
      if (trustCase.releaseId === RELEASE_TRUST_FAILED) {
        await visibleText(page, 'Immutable attempts');
        await visibleText(page, 'Attempt 1');
        await visibleText(page, 'Attempt 2');
        await visibleText(page, 'High findings');
        await visibleText(page, 'Low findings');
      }
    }

    await page.goto(
      `${baseUrl}/debug/developer-center?mode=admin-detail&releaseId=${RELEASE_TRUST_SIGNABLE}`,
      { waitUntil: 'domcontentloaded' },
    );
    await visibleText(page, 'Passing trust signature');
    await visibleText(page, 'Automatic trust checks passed.');
    const signRelease = page.getByTestId('sign-release');
    assert(!(await signRelease.isDisabled()), 'passing trust must enable release signing');
    await signRelease.click();
    await page.getByLabel('Status: Signed').waitFor({ state: 'visible' });
    await visibleText(page, 'Signature verified');
    assert(
      requests.distributions.some(
        (request) =>
          request.release_id === RELEASE_TRUST_SIGNABLE && request.action === 'sign',
      ),
      'passing release must call the sign endpoint once',
    );

    await page.goto(
      `${baseUrl}/debug/developer-center?mode=admin-detail&releaseId=${RELEASE_A_PENDING}`,
      { waitUntil: 'domcontentloaded' },
    );
    await visibleText(page, 'Review decisions');
    const approve = page.getByTestId('approve-decision');
    assert(await approve.isDisabled(), 'Approve must remain disabled with incomplete evidence');
    await fillApprovalEvidence(page);
    assert(!(await approve.isDisabled()), 'Approve should enable with complete evidence');
    await approve.click();
    await visibleText(page, 'Another administrator changed this release.');
    assert(requests.decisions.length === 1, 'forced conflict should issue one decision request');
    await page.getByRole('button', { name: /reload latest release/i }).click();
    await visibleText(page, 'Revision 2');
    assert(
      requests.adminDetailReads.filter((releaseId) => releaseId === RELEASE_A_PENDING).length >= 2,
      'conflict reload must fetch the latest admin detail',
    );
    await fillApprovalEvidence(page);
    await page.getByTestId('approve-decision').click();
    await page.getByLabel('Status: Approved').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 3');
    assert(
      Number(requests.decisions.length) === 2,
      'approval retry should be an explicit second request',
    );
    assert(requests.decisions[1].decision === 'approve', 'approval decision payload mismatch');
    assert(
      (await page.getByText('Another administrator changed this release.').count()) === 0,
      'successful approval retry must clear the conflict state',
    );

    await page.getByTestId('debug-admin-queue').click();
    await visibleText(page, 'Review queue');
    await visibleText(page, 'Recruiting module');
    assert(
      requests.queueCursors.at(-1) === null,
      'returning to the queue must reset the prior page cursor',
    );

    await page.goto(
      `${baseUrl}/debug/developer-center?mode=admin-detail&releaseId=${RELEASE_A_CHANGES}`,
      { waitUntil: 'domcontentloaded' },
    );
    await visibleText(page, 'Recruiting changes');
    await page
      .getByPlaceholder('Reason for request changes or emergency revoke')
      .fill('Clarify permission handling before this release can be approved.');
    await page.getByTestId('request-changes-decision').click();
    await page.getByLabel('Status: Changes requested').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 2');
    assert(
      requests.decisions.at(-1)?.decision === 'request_changes',
      'request changes decision payload mismatch',
    );

    await page.getByTestId('debug-admin-queue').click();
    await page.getByRole('button', { name: /^changes requested$/i }).click();
    await visibleText(page, 'Recruiting changes');
    assert(
      requests.queueStatuses.at(-1) === 'changes_requested',
      'admin queue status filter mismatch',
    );

    await page.goto(
      `${baseUrl}/debug/developer-center?mode=admin-detail&releaseId=${RELEASE_A_APPROVED}`,
      { waitUntil: 'domcontentloaded' },
    );
    await visibleText(page, 'Recruiting approved');
    await page
      .getByPlaceholder('Reason for request changes or emergency revoke')
      .fill('Emergency revoke after a verified policy regression.');
    await page.getByTestId('revoke-decision').click();
    await page.getByRole('button', { name: /^revoke release$/i }).click();
    await page.getByLabel('Status: Revoked').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 3');
    assert(requests.decisions.at(-1)?.decision === 'revoke', 'revoke decision payload mismatch');

    await page.getByTestId('debug-admin-queue').click();
    await page.getByRole('button', { name: /^revoked$/i }).click();
    await visibleText(page, 'Recruiting approved');
    assert(requests.queueStatuses.at(-1) === 'revoked', 'revoked queue filter mismatch');

    await page.getByTestId('debug-account-b').click();
    await visibleText(page, 'Team directory');
    assert(
      !(await page.getByText('Recruiting module').count()),
      'team switch must not reuse personal rows',
    );
    assert(
      (await page.getByTestId('debug-capabilities').textContent())?.includes(
        'account.write: denied',
      ),
      'team write capability mismatch',
    );
    assert(
      (await page.getByTestId('debug-selected-account').textContent()) === ACCOUNT_B,
      'team switch must update the shared account store',
    );
    await page.getByTestId('debug-publisher-detail').click();
    await visibleText(page, 'DEVELOPER_RELEASE_NOT_FOUND');
    assert(
      requests.accountIds.includes(ACCOUNT_B),
      'account substitution must reach the tenant-scoped publisher boundary',
    );
    await page.getByTestId('debug-account-a').click();
    await visibleText(page, 'Recruiting module');
    assert(
      (await page.getByTestId('debug-selected-account').textContent()) === ACCOUNT_A,
      'personal switch must restore the shared account store',
    );

    await page.getByTestId('debug-admin-malformed-cursor').click();
    await visibleText(
      page,
      'The review queue cursor is invalid. Reset to the first page and try again.',
    );
    await page.getByRole('button', { name: /reset to first page/i }).click();
    await visibleText(page, 'Review queue');

    await page.goto(`${baseUrl}/debug/developer-center?mode=publisher-list`, {
      waitUntil: 'domcontentloaded',
    });
    await visibleText(page, 'Recent releases');
    await page.getByTestId('debug-publisher-detail').click();
    await visibleText(page, 'Recruiting module');
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await visibleText(page, 'Recent releases');
    await page.goForward({ waitUntil: 'domcontentloaded' });
    await visibleText(page, 'Recruiting module');
    assert(
      new URL(page.url()).searchParams.get('releaseId') === RELEASE_A_VALIDATED,
      'forward navigation must restore the publisher release deep link',
    );
    await page.getByLabel('Status: Review pending').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 1');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await visibleText(page, 'Recruiting module');
    await page.getByLabel('Status: Review pending').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 1');
    await page.goto(
      `${baseUrl}/debug/developer-center?mode=admin-detail&releaseId=${RELEASE_A_PENDING}`,
      { waitUntil: 'domcontentloaded' },
    );
    await visibleText(page, 'Recruiting review');
    await page.getByLabel('Status: Approved').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 3');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await visibleText(page, 'Recruiting review');
    await page.getByLabel('Status: Approved').waitFor({ state: 'visible' });
    await visibleText(page, 'Revision 3');

    const bodyText = await page.locator('body').innerText();
    assert(
      !/video|voice|3d|digital human|batch remix/i.test(bodyText),
      'cancelled multimedia copy leaked into Developer Center',
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    assert(overflow, 'desktop Developer Center harness has horizontal overflow');
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    assert(fs.statSync(screenshotPath).size > 0, 'Developer Center screenshot is empty');
    await assertScreenshotHasVisualContent(screenshotPath);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/debug/developer-center?mode=project-modules`, {
      waitUntil: 'domcontentloaded',
    });
    await visibleText(page, 'Installed modules');
    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    assert(mobileOverflow, 'mobile Project Modules view has horizontal overflow');
    await page.screenshot({ path: mobileScreenshotPath, fullPage: false });
    assert(fs.statSync(mobileScreenshotPath).size > 0, 'mobile screenshot is empty');
    await assertScreenshotHasVisualContent(mobileScreenshotPath);
    assert(consoleErrors.length === 0, `unexpected browser errors: ${consoleErrors.join(' | ')}`);
    assert(
      requests.unknown.length === 0,
      `unexpected Developer Center requests: ${requests.unknown.join(', ')}`,
    );

    console.log(
      `[developer-center-review] ok: mocked publisher/admin/project-module flows; screenshots=${screenshotPath},${mobileScreenshotPath}`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
