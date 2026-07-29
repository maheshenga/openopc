import { randomUUID } from 'node:crypto';

import {
  type DeveloperModuleSignature,
  type DeveloperModuleSignaturePayloadV2,
  type ModuleSigningPort,
  type ModuleVerificationPort,
  canonicalDeveloperModuleSignaturePayloadV2,
  developerModuleReleaseSignaturePayloadV2,
  signDeveloperModulePayload,
  verifyDeveloperModuleReleaseTrustSignature,
} from './module-signing';
import type { DeveloperPublisherPermissionPort } from './publishers';
import type { DeveloperModuleRelease, DeveloperModuleReleaseStatus } from './releases';
import type { DeveloperModuleTrustGate } from './trust-gate';

export type DeveloperModuleDistributionAction = 'sign' | 'publish' | 'revoke';

export interface DeveloperModuleDistributionEvent {
  distribution_event_id: string;
  release_id: string;
  account_id: string;
  sequence: number;
  action: DeveloperModuleDistributionAction;
  from_status: DeveloperModuleReleaseStatus;
  to_status: DeveloperModuleReleaseStatus;
  actor_user_id: string;
  actor_kind: 'platform_admin';
  reason: string | null;
  created_at: string;
}

export interface DeveloperModuleDistributionTransition {
  release: DeveloperModuleRelease;
  event: DeveloperModuleDistributionEvent;
}

export interface DeveloperModulePublishedPage {
  releases: readonly DeveloperModuleRelease[];
  total: number;
}

export interface DeveloperModuleSignCommand {
  releaseId: string;
  actorUserId: string;
  expectedStatus: 'approved';
  expectedRevision: number;
  signature: DeveloperModuleSignature;
}

export interface DeveloperModuleDistributionTransitionCommand {
  releaseId: string;
  actorUserId: string;
  action: 'publish' | 'revoke';
  expectedStatus: 'signed' | 'published';
  expectedRevision: number;
  reason: string | null;
}

export interface DeveloperModuleDistributionRepository {
  getAdmin(releaseId: string): Promise<DeveloperModuleRelease | null>;
  isPublisherAccountMember(accountId: string, userId: string): Promise<boolean>;
  sign(command: DeveloperModuleSignCommand): Promise<DeveloperModuleDistributionTransition>;
  transition(
    command: DeveloperModuleDistributionTransitionCommand,
  ): Promise<DeveloperModuleDistributionTransition>;
  listPublished(input: {
    query?: string;
    limit: number;
    offset: number;
  }): Promise<DeveloperModulePublishedPage>;
  getPublished(releaseId: string): Promise<DeveloperModuleRelease | null>;
  history(
    accountId: string,
    releaseId: string,
  ): Promise<readonly DeveloperModuleDistributionEvent[]>;
}

export type DeveloperModuleDistributionErrorCode =
  | 'DEVELOPER_MODULE_SIGNER_UNAVAILABLE'
  | 'DEVELOPER_MODULE_SIGNATURE_INVALID'
  | 'DEVELOPER_MODULE_NOT_DISTRIBUTABLE'
  | 'DEVELOPER_MODULE_NOT_PUBLISHED'
  | 'DEVELOPER_MODULE_REVOKED'
  | 'DEVELOPER_DISTRIBUTION_SELF_ACTION_DENIED'
  | 'DEVELOPER_DISTRIBUTION_CONFLICT'
  | 'DEVELOPER_DISTRIBUTION_REASON_INVALID'
  | 'DEVELOPER_TRUST_GATE_UNMET'
  | 'DEVELOPER_RELEASE_NOT_FOUND';

export class DeveloperModuleDistributionError extends Error {
  constructor(
    readonly code: DeveloperModuleDistributionErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'DeveloperModuleDistributionError';
  }
}

function fail(
  code: DeveloperModuleDistributionErrorCode,
  status: DeveloperModuleDistributionError['status'],
): never {
  throw new DeveloperModuleDistributionError(code, status);
}

function cloneRelease(release: DeveloperModuleRelease): DeveloperModuleRelease {
  return structuredClone(release);
}

function cloneEvent(event: DeveloperModuleDistributionEvent): DeveloperModuleDistributionEvent {
  return structuredClone(event);
}

function signaturePayload(release: DeveloperModuleRelease): DeveloperModuleSignaturePayloadV2 {
  const payload = developerModuleReleaseSignaturePayloadV2(release);
  try {
    canonicalDeveloperModuleSignaturePayloadV2(payload);
  } catch {
    fail('DEVELOPER_MODULE_SIGNATURE_INVALID', 409);
  }
  return payload;
}

function assertExpectedRelease(
  release: DeveloperModuleRelease | null,
  expectedStatus: DeveloperModuleReleaseStatus,
  expectedRevision: number,
): DeveloperModuleRelease {
  if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
  if (release.status === 'revoked') fail('DEVELOPER_MODULE_REVOKED', 409);
  if (release.status !== expectedStatus || release.review_revision !== expectedRevision) {
    fail('DEVELOPER_DISTRIBUTION_CONFLICT', 409);
  }
  return release;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127) {
      return true;
    }
  }
  return false;
}

function normalizeRevocationReason(value: unknown): string {
  if (typeof value !== 'string') fail('DEVELOPER_DISTRIBUTION_REASON_INVALID', 400);
  const reason = value.trim();
  if (
    reason.length === 0 ||
    reason.length > 4_000 ||
    Buffer.byteLength(reason, 'utf8') > 8_192 ||
    containsControlCharacter(reason) ||
    /\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}/i.test(reason) ||
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/.test(reason) ||
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/i.test(reason)
  ) {
    fail('DEVELOPER_DISTRIBUTION_REASON_INVALID', 400);
  }
  return reason;
}

export class DeveloperModuleDistributionService {
  private readonly signer: ModuleSigningPort | null;
  private readonly verifiers: ReadonlyMap<string, ModuleVerificationPort>;
  private readonly now: () => Date;

  constructor(
    private readonly input: {
      repository: DeveloperModuleDistributionRepository;
      signer?: ModuleSigningPort | null;
      verifiers?: readonly ModuleVerificationPort[];
      trustGate?: Pick<DeveloperModuleTrustGate, 'evaluate'>;
      permissions?: DeveloperPublisherPermissionPort;
      now?: () => Date;
    },
  ) {
    this.signer = input.signer ?? null;
    this.now = input.now ?? (() => new Date());
    const verifiers = input.verifiers ?? (this.signer ? [this.signer] : []);
    this.verifiers = new Map(verifiers.map((verifier) => [verifier.keyId, verifier]));
  }

  /** Resolve an Admin release target before a privileged transition runs. */
  async getAdminRelease(releaseId: string): Promise<DeveloperModuleRelease | null> {
    const release = await this.input.repository.getAdmin(releaseId);
    return release ? cloneRelease(release) : null;
  }

  private async requirePlatformReview(
    release: DeveloperModuleRelease,
    actorUserId: string,
  ): Promise<void> {
    if (this.input.permissions) {
      await this.input.permissions.requirePermission(
        release.publisher_id,
        {
          accountId: release.account_id,
          userId: actorUserId,
          platformAdmin: true,
        },
        'platform_review',
      );
      return;
    }
    if (await this.input.repository.isPublisherAccountMember(release.account_id, actorUserId)) {
      fail('DEVELOPER_DISTRIBUTION_SELF_ACTION_DENIED', 403);
    }
  }

  private async replayCompletedTransition(
    release: DeveloperModuleRelease,
    input: {
      action: DeveloperModuleDistributionAction;
      actorUserId: string;
      expectedStatus: DeveloperModuleReleaseStatus;
      expectedRevision: number;
      toStatus: DeveloperModuleReleaseStatus;
      reason: string | null;
    },
  ): Promise<DeveloperModuleDistributionTransition | null> {
    if (
      release.status !== input.toStatus ||
      release.review_revision !== input.expectedRevision + 1
    ) {
      return null;
    }
    const history = await this.input.repository.history(release.account_id, release.release_id);
    const event = history.find((candidate) => candidate.sequence === release.review_revision);
    if (
      !event ||
      event.action !== input.action ||
      event.actor_user_id !== input.actorUserId ||
      event.from_status !== input.expectedStatus ||
      event.to_status !== input.toStatus ||
      event.reason !== input.reason
    ) {
      fail('DEVELOPER_DISTRIBUTION_CONFLICT', 409);
    }
    return { release: cloneRelease(release), event: cloneEvent(event) };
  }

  async sign(input: {
    releaseId: string;
    actorUserId: string;
    expectedStatus: 'approved';
    expectedRevision: number;
  }): Promise<DeveloperModuleDistributionTransition> {
    const current = await this.input.repository.getAdmin(input.releaseId);
    if (current) {
      const replay = await this.replayCompletedTransition(current, {
        action: 'sign',
        actorUserId: input.actorUserId,
        expectedStatus: input.expectedStatus,
        expectedRevision: input.expectedRevision,
        toStatus: 'signed',
        reason: null,
      });
      if (replay) return replay;
    }
    const release = assertExpectedRelease(current, input.expectedStatus, input.expectedRevision);
    await this.requirePlatformReview(release, input.actorUserId);
    if (!this.signer) fail('DEVELOPER_MODULE_SIGNER_UNAVAILABLE', 503);
    let trust: Awaited<ReturnType<DeveloperModuleTrustGate['evaluate']>>;
    try {
      if (!this.input.trustGate) fail('DEVELOPER_TRUST_GATE_UNMET', 409);
      trust = await this.input.trustGate.evaluate(release);
    } catch (error) {
      if (error instanceof DeveloperModuleDistributionError) throw error;
      fail('DEVELOPER_TRUST_GATE_UNMET', 409);
    }
    if (
      !trust.ok ||
      trust.evidence.artifact_digest !== release.artifact_digest ||
      trust.evidence.sbom_digest !== release.sbom_digest ||
      trust.evidence.attestation_digest !== release.trust_attestation_digest ||
      trust.evidence.policy_digest !== release.verification_policy_digest ||
      trust.evidence.runtime_descriptor_digest !== release.runtime_descriptor_digest ||
      trust.evidence.runtime_kind !== release.runtime_kind
    ) {
      fail('DEVELOPER_TRUST_GATE_UNMET', 409);
    }

    const payload = signaturePayload(release);
    let signature: DeveloperModuleSignature;
    try {
      signature = await signDeveloperModulePayload(payload, this.signer, this.now);
    } catch {
      fail('DEVELOPER_MODULE_SIGNER_UNAVAILABLE', 503);
    }
    return await this.input.repository.sign({
      releaseId: input.releaseId,
      actorUserId: input.actorUserId,
      expectedStatus: input.expectedStatus,
      expectedRevision: input.expectedRevision,
      signature,
    });
  }

  async publish(input: {
    releaseId: string;
    actorUserId: string;
    expectedStatus: 'signed';
    expectedRevision: number;
  }): Promise<DeveloperModuleDistributionTransition> {
    const current = await this.input.repository.getAdmin(input.releaseId);
    if (current) {
      const replay = await this.replayCompletedTransition(current, {
        action: 'publish',
        actorUserId: input.actorUserId,
        expectedStatus: input.expectedStatus,
        expectedRevision: input.expectedRevision,
        toStatus: 'published',
        reason: null,
      });
      if (replay) return replay;
    }
    const release = assertExpectedRelease(current, input.expectedStatus, input.expectedRevision);
    await this.requirePlatformReview(release, input.actorUserId);
    if (
      release.signature_algorithm !== 'ed25519' ||
      !release.signature_key_id ||
      !release.signature ||
      !release.signature_payload_digest ||
      !release.signed_at
    ) {
      fail('DEVELOPER_MODULE_SIGNATURE_INVALID', 409);
    }
    const verifier = this.verifiers.get(release.signature_key_id);
    if (!verifier) fail('DEVELOPER_MODULE_SIGNER_UNAVAILABLE', 503);
    if (!(await verifyDeveloperModuleReleaseTrustSignature(release, verifier))) {
      fail('DEVELOPER_MODULE_SIGNATURE_INVALID', 409);
    }

    return await this.input.repository.transition({
      releaseId: input.releaseId,
      actorUserId: input.actorUserId,
      action: 'publish',
      expectedStatus: input.expectedStatus,
      expectedRevision: input.expectedRevision,
      reason: null,
    });
  }

  async revoke(input: {
    releaseId: string;
    actorUserId: string;
    expectedStatus: 'signed' | 'published';
    expectedRevision: number;
    reason: string;
  }): Promise<DeveloperModuleDistributionTransition> {
    const reason = normalizeRevocationReason(input.reason);
    const current = await this.input.repository.getAdmin(input.releaseId);
    if (current) {
      const replay = await this.replayCompletedTransition(current, {
        action: 'revoke',
        actorUserId: input.actorUserId,
        expectedStatus: input.expectedStatus,
        expectedRevision: input.expectedRevision,
        toStatus: 'revoked',
        reason,
      });
      if (replay) return replay;
    }
    const release = assertExpectedRelease(current, input.expectedStatus, input.expectedRevision);
    await this.requirePlatformReview(release, input.actorUserId);
    return await this.input.repository.transition({
      releaseId: input.releaseId,
      actorUserId: input.actorUserId,
      action: 'revoke',
      expectedStatus: input.expectedStatus,
      expectedRevision: input.expectedRevision,
      reason,
    });
  }

  listPublished(input: {
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<DeveloperModulePublishedPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
    return this.input.repository.listPublished({
      query: input.query?.trim() || undefined,
      limit,
      offset,
    });
  }

  async getPublished(input: {
    releaseId: string;
  }): Promise<DeveloperModuleRelease> {
    const published = await this.input.repository.getPublished(input.releaseId);
    if (published) return published;
    const release = await this.input.repository.getAdmin(input.releaseId);
    if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    if (release.status === 'revoked') fail('DEVELOPER_MODULE_REVOKED', 409);
    fail('DEVELOPER_MODULE_NOT_PUBLISHED', 409);
  }
}

export function createMemoryDeveloperModuleDistributionRepository(input?: {
  releases?: readonly DeveloperModuleRelease[];
  publisherAccountMembers?: readonly { accountId: string; userId: string }[];
  now?: () => Date;
  createId?: () => string;
}): DeveloperModuleDistributionRepository {
  const releases = new Map(
    (input?.releases ?? []).map((release) => [release.release_id, cloneRelease(release)]),
  );
  const events = new Map<string, DeveloperModuleDistributionEvent[]>();
  const members = new Set(
    (input?.publisherAccountMembers ?? []).map((member) => `${member.accountId}\0${member.userId}`),
  );
  const now = input?.now ?? (() => new Date());
  const createId = input?.createId ?? randomUUID;

  function current(releaseId: string): DeveloperModuleRelease {
    const release = releases.get(releaseId);
    if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    return release;
  }

  function assertFence(
    release: DeveloperModuleRelease,
    status: DeveloperModuleReleaseStatus,
    revision: number,
  ): void {
    if (release.status !== status || release.review_revision !== revision) {
      fail('DEVELOPER_DISTRIBUTION_CONFLICT', 409);
    }
  }

  function buildEvent(
    release: DeveloperModuleRelease,
    input: {
      action: DeveloperModuleDistributionAction;
      fromStatus: DeveloperModuleReleaseStatus;
      actorUserId: string;
      reason: string | null;
      createdAt: string;
    },
  ): DeveloperModuleDistributionEvent {
    return {
      distribution_event_id: createId(),
      release_id: release.release_id,
      account_id: release.account_id,
      sequence: release.review_revision,
      action: input.action,
      from_status: input.fromStatus,
      to_status: release.status,
      actor_user_id: input.actorUserId,
      actor_kind: 'platform_admin',
      reason: input.reason,
      created_at: input.createdAt,
    };
  }

  function commitTransition(
    release: DeveloperModuleRelease,
    event: DeveloperModuleDistributionEvent,
  ): void {
    const history = events.get(release.release_id) ?? [];
    history.push(cloneEvent(event));
    releases.set(release.release_id, cloneRelease(release));
    events.set(release.release_id, history);
  }

  return {
    async getAdmin(releaseId) {
      const release = releases.get(releaseId);
      return release ? cloneRelease(release) : null;
    },
    async isPublisherAccountMember(accountId, userId) {
      return members.has(`${accountId}\0${userId}`);
    },
    async sign(command) {
      const release = cloneRelease(current(command.releaseId));
      assertFence(release, command.expectedStatus, command.expectedRevision);
      const fromStatus = release.status;
      const createdAt = now().toISOString();
      release.status = 'signed';
      release.review_revision += 1;
      release.signature_algorithm = command.signature.algorithm;
      release.signature_key_id = command.signature.key_id;
      release.signature = command.signature.signature;
      release.signature_payload_digest = command.signature.payload_digest;
      release.signed_at = command.signature.signed_at;
      release.updated_at = createdAt;
      const event = buildEvent(release, {
        action: 'sign',
        fromStatus,
        actorUserId: command.actorUserId,
        reason: null,
        createdAt,
      });
      commitTransition(release, event);
      return { release: cloneRelease(release), event: cloneEvent(event) };
    },
    async transition(command) {
      const release = cloneRelease(current(command.releaseId));
      assertFence(release, command.expectedStatus, command.expectedRevision);
      const fromStatus = release.status;
      const createdAt = now().toISOString();
      release.status = command.action === 'publish' ? 'published' : 'revoked';
      release.review_revision += 1;
      if (command.action === 'publish') release.published_at = createdAt;
      if (command.action === 'revoke') release.revoked_at = createdAt;
      release.updated_at = createdAt;
      const event = buildEvent(release, {
        action: command.action,
        fromStatus,
        actorUserId: command.actorUserId,
        reason: command.reason,
        createdAt,
      });
      commitTransition(release, event);
      return { release: cloneRelease(release), event: cloneEvent(event) };
    },
    async listPublished({ query, limit, offset }) {
      const normalizedQuery = query?.trim().toLowerCase() ?? '';
      const matches = [...releases.values()]
        .filter((release) => release.status === 'published')
        .filter(
          (release) =>
            !normalizedQuery ||
            [release.item_name, release.module_id, release.publisher_id].some((value) =>
              value.toLowerCase().includes(normalizedQuery),
            ),
        )
        .sort(
          (left, right) =>
            (right.published_at ?? '').localeCompare(left.published_at ?? '') ||
            right.release_id.localeCompare(left.release_id),
        );
      return {
        releases: matches.slice(offset, offset + limit).map(cloneRelease),
        total: matches.length,
      };
    },
    async getPublished(releaseId) {
      const release = releases.get(releaseId);
      return release?.status === 'published' ? cloneRelease(release) : null;
    },
    async history(accountId, releaseId) {
      const release = releases.get(releaseId);
      if (!release || release.account_id !== accountId) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
      return [...(events.get(releaseId) ?? [])]
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneEvent);
    },
  };
}
