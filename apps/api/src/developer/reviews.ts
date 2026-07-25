import { randomUUID } from 'node:crypto';

import type {
  DeveloperModuleDistributionEvent,
  DeveloperModuleDistributionRepository,
} from './distribution';
import type { DeveloperPublisherPermissionPort } from './publishers';
import type {
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewRequirement,
} from './releases';
import type { DeveloperModuleTrustGate } from './trust-gate';

export const DEVELOPER_MODULE_REVIEW_ACTIONS = [
  'submit',
  'resubmit',
  'request_changes',
  'approve',
  'revoke',
] as const;
export type DeveloperModuleReviewAction = (typeof DEVELOPER_MODULE_REVIEW_ACTIONS)[number];

export const DEVELOPER_MODULE_REVIEW_ACTOR_KINDS = ['publisher', 'platform_admin'] as const;
export type DeveloperModuleReviewActorKind = (typeof DEVELOPER_MODULE_REVIEW_ACTOR_KINDS)[number];

export type DeveloperModuleReviewDecision = 'request_changes' | 'approve' | 'revoke';

export const DEVELOPER_MODULE_AUTOMATIC_REQUIREMENTS = ['source_scan', 'sandbox_test'] as const;
export type DeveloperModuleAutomaticRequirement =
  (typeof DEVELOPER_MODULE_AUTOMATIC_REQUIREMENTS)[number];
export const DEVELOPER_MODULE_HUMAN_REQUIREMENTS = [
  'manifest_review',
  'permission_review',
  'desktop_security_review',
  'human_review',
] as const;
export type DeveloperModuleHumanRequirement = (typeof DEVELOPER_MODULE_HUMAN_REQUIREMENTS)[number];

export interface DeveloperModuleHumanReviewEvidence {
  requirement: DeveloperModuleHumanRequirement;
  outcome: 'passed';
  method: 'manual';
  summary: string;
  observed_at: string;
}

export interface DeveloperModuleAutomaticEvidence {
  requirement: DeveloperModuleAutomaticRequirement;
  outcome: 'passed';
  method: 'system_attestation';
  run_id: string;
  evidence_digest: `sha256:${string}`;
  policy_digest: `sha256:${string}`;
}

export type DeveloperModuleReviewEvidence =
  | DeveloperModuleHumanReviewEvidence
  | DeveloperModuleAutomaticEvidence;

export interface DeveloperModuleReviewEvent {
  review_event_id: string;
  release_id: string;
  account_id: string;
  sequence: number;
  action: DeveloperModuleReviewAction;
  from_status: DeveloperModuleReleaseStatus;
  to_status: DeveloperModuleReleaseStatus;
  actor_user_id: string;
  actor_kind: DeveloperModuleReviewActorKind;
  reason: string | null;
  evidence: DeveloperModuleReviewEvidence[];
  created_at: string;
}

export type DeveloperModuleLifecycleEvent =
  | DeveloperModuleReviewEvent
  | DeveloperModuleDistributionEvent;

export interface DeveloperModuleReviewTransition {
  release: DeveloperModuleRelease;
  event: DeveloperModuleReviewEvent;
}

export interface DeveloperModuleAdminReviewPage {
  releases: DeveloperModuleRelease[];
  next_cursor: string | null;
}

export interface DeveloperModuleAdminReviewDetail {
  release: DeveloperModuleRelease;
  history: DeveloperModuleLifecycleEvent[];
}

export type DeveloperModuleReviewErrorCode =
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'DEVELOPER_REVIEW_CONFLICT'
  | 'DEVELOPER_REVIEW_TRANSITION_INVALID'
  | 'DEVELOPER_REVIEW_REASON_REQUIRED'
  | 'DEVELOPER_REVIEW_REASON_INVALID'
  | 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE'
  | 'DEVELOPER_REVIEW_AUTOMATIC_EVIDENCE_FORBIDDEN'
  | 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED'
  | 'DEVELOPER_TRUST_GATE_UNMET'
  | 'DEVELOPER_REVIEW_INPUT_INVALID';

export class DeveloperModuleReviewError extends Error {
  constructor(
    readonly code: DeveloperModuleReviewErrorCode,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(code);
    this.name = 'DeveloperModuleReviewError';
  }
}

export interface DeveloperModuleReviewTransitionCommand {
  accountId: string;
  releaseId: string;
  expectedStatus: DeveloperModuleReleaseStatus;
  expectedRevision: number;
  action: DeveloperModuleReviewAction;
  toStatus: DeveloperModuleReleaseStatus;
  actorUserId: string;
  actorKind: DeveloperModuleReviewActorKind;
  reason: string | null;
  evidence: readonly DeveloperModuleReviewEvidence[];
}

export interface DeveloperModuleReviewRepository {
  getPublisher(accountId: string, releaseId: string): Promise<DeveloperModuleRelease | null>;
  getAdmin(releaseId: string): Promise<DeveloperModuleRelease | null>;
  isPublisherAccountMember(accountId: string, userId: string): Promise<boolean>;
  transition(
    command: DeveloperModuleReviewTransitionCommand,
  ): Promise<DeveloperModuleReviewTransition>;
  history(accountId: string, releaseId: string): Promise<readonly DeveloperModuleReviewEvent[]>;
  adminList(input: {
    status: DeveloperModuleReleaseStatus;
    limit: number;
    cursor?: string | null;
  }): Promise<DeveloperModuleAdminReviewPage>;
}

const REVIEW_REASON_MAX_CHARS = 4_000;
const REVIEW_REASON_MAX_BYTES = 8_192;
const EVIDENCE_SUMMARY_MAX_CHARS = 1_000;
const EVIDENCE_SUMMARY_MAX_BYTES = 2_048;
const EVIDENCE_MAX_BYTES = 32_768;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
];
const HUMAN_EVIDENCE_KEYS = new Set(['requirement', 'outcome', 'method', 'summary', 'observed_at']);

function cloneRelease(release: DeveloperModuleRelease): DeveloperModuleRelease {
  return structuredClone(release);
}

function cloneEvent(event: DeveloperModuleReviewEvent): DeveloperModuleReviewEvent {
  return structuredClone(event);
}

function fail(
  code: DeveloperModuleReviewErrorCode,
  status: DeveloperModuleReviewError['status'],
): never {
  throw new DeveloperModuleReviewError(code, status);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsCredential(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(value));
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

function normalizeText(
  value: unknown,
  input: {
    required: boolean;
    maxChars: number;
    maxBytes: number;
    invalidCode: DeveloperModuleReviewErrorCode;
  },
): string | null {
  if (value === undefined || value === null) {
    if (input.required) fail('DEVELOPER_REVIEW_REASON_REQUIRED', 400);
    return null;
  }
  if (typeof value !== 'string') fail(input.invalidCode, 400);
  const normalized = value.trim();
  if (!normalized) {
    if (input.required) fail('DEVELOPER_REVIEW_REASON_REQUIRED', 400);
    return null;
  }
  if (
    normalized.length > input.maxChars ||
    Buffer.byteLength(normalized, 'utf8') > input.maxBytes ||
    containsControlCharacter(normalized) ||
    containsCredential(normalized)
  ) {
    fail(input.invalidCode, 400);
  }
  return normalized;
}

function normalizeReason(value: unknown, required: boolean): string | null {
  return normalizeText(value, {
    required,
    maxChars: REVIEW_REASON_MAX_CHARS,
    maxBytes: REVIEW_REASON_MAX_BYTES,
    invalidCode: 'DEVELOPER_REVIEW_REASON_INVALID',
  });
}

function normalizeSummary(value: unknown): string {
  const summary = normalizeText(value, {
    required: true,
    maxChars: EVIDENCE_SUMMARY_MAX_CHARS,
    maxBytes: EVIDENCE_SUMMARY_MAX_BYTES,
    invalidCode: 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE',
  });
  if (!summary) fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  return summary;
}

function isAutomaticRequirement(
  requirement: DeveloperModuleReviewRequirement,
): requirement is DeveloperModuleAutomaticRequirement {
  return DEVELOPER_MODULE_AUTOMATIC_REQUIREMENTS.includes(
    requirement as DeveloperModuleAutomaticRequirement,
  );
}

function isHumanRequirement(
  requirement: DeveloperModuleReviewRequirement,
): requirement is DeveloperModuleHumanRequirement {
  return DEVELOPER_MODULE_HUMAN_REQUIREMENTS.includes(
    requirement as DeveloperModuleHumanRequirement,
  );
}

function normalizeHumanEvidence(
  value: unknown,
  release: DeveloperModuleRelease,
  now: Date,
): DeveloperModuleHumanReviewEvidence[] {
  if (!Array.isArray(value)) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  for (const raw of value) {
    if (
      isPlainObject(raw) &&
      (raw.method === 'system_attestation' ||
        (typeof raw.requirement === 'string' &&
          DEVELOPER_MODULE_AUTOMATIC_REQUIREMENTS.includes(
            raw.requirement as DeveloperModuleAutomaticRequirement,
          )))
    ) {
      fail('DEVELOPER_REVIEW_AUTOMATIC_EVIDENCE_FORBIDDEN', 400);
    }
  }
  const humanRequirements = release.review_requirements.filter(isHumanRequirement);
  if (value.length !== humanRequirements.length) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  const allowedRequirements = new Set(humanRequirements);
  const byRequirement = new Map<
    DeveloperModuleHumanRequirement,
    DeveloperModuleHumanReviewEvidence
  >();
  const releaseCreatedAt = Date.parse(release.created_at);

  for (const raw of value) {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => !HUMAN_EVIDENCE_KEYS.has(key))) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    const requirement = raw.requirement;
    if (
      typeof requirement !== 'string' ||
      !allowedRequirements.has(requirement as DeveloperModuleHumanRequirement) ||
      byRequirement.has(requirement as DeveloperModuleHumanRequirement) ||
      raw.outcome !== 'passed' ||
      raw.method !== 'manual'
    ) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    if (typeof raw.observed_at !== 'string') {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    const observedAt = Date.parse(raw.observed_at);
    if (
      !Number.isFinite(observedAt) ||
      new Date(observedAt).toISOString() !== raw.observed_at ||
      observedAt < releaseCreatedAt ||
      observedAt > now.getTime()
    ) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    const evidence: DeveloperModuleHumanReviewEvidence = {
      requirement: requirement as DeveloperModuleHumanRequirement,
      outcome: 'passed',
      method: 'manual',
      summary: normalizeSummary(raw.summary),
      observed_at: raw.observed_at,
    };
    byRequirement.set(evidence.requirement, evidence);
  }

  if (byRequirement.size !== humanRequirements.length) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  const normalized = humanRequirements.map((requirement) => {
    const evidence = byRequirement.get(requirement);
    if (!evidence) fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    return evidence;
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > EVIDENCE_MAX_BYTES) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  return structuredClone(normalized);
}

async function automaticEvidence(
  release: DeveloperModuleRelease,
  trustGate: Pick<DeveloperModuleTrustGate, 'evaluate'> | undefined,
): Promise<DeveloperModuleAutomaticEvidence[]> {
  if (!trustGate) fail('DEVELOPER_TRUST_GATE_UNMET', 409);
  let result: Awaited<ReturnType<DeveloperModuleTrustGate['evaluate']>>;
  try {
    result = await trustGate.evaluate(release);
  } catch {
    fail('DEVELOPER_TRUST_GATE_UNMET', 409);
  }
  if (!result.ok) fail('DEVELOPER_TRUST_GATE_UNMET', 409);
  return release.review_requirements.filter(isAutomaticRequirement).map((requirement) => ({
    requirement,
    outcome: 'passed',
    method: 'system_attestation',
    run_id: result.evidence.run_id,
    evidence_digest: result.evidence.attestation_digest,
    policy_digest: result.evidence.policy_digest,
  }));
}

function mergeEvidence(
  release: DeveloperModuleRelease,
  humanEvidence: readonly DeveloperModuleHumanReviewEvidence[],
  systemEvidence: readonly DeveloperModuleAutomaticEvidence[],
): DeveloperModuleReviewEvidence[] {
  const byRequirement = new Map<DeveloperModuleReviewRequirement, DeveloperModuleReviewEvidence>(
    [...humanEvidence, ...systemEvidence].map((evidence) => [evidence.requirement, evidence]),
  );
  const merged = release.review_requirements.map((requirement) => {
    const evidence = byRequirement.get(requirement);
    if (!evidence) fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    return evidence;
  });
  if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > EVIDENCE_MAX_BYTES) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  return structuredClone(merged);
}

function expectedRelease(
  release: DeveloperModuleRelease | null,
  expectedStatus: DeveloperModuleReleaseStatus,
  expectedRevision: number,
): DeveloperModuleRelease {
  if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    fail('DEVELOPER_REVIEW_INPUT_INVALID', 400);
  }
  if (release.status !== expectedStatus || release.review_revision !== expectedRevision) {
    fail('DEVELOPER_REVIEW_CONFLICT', 409);
  }
  return release;
}

export class DeveloperModuleReviewService {
  private readonly now: () => Date;

  constructor(
    private readonly input: {
      repository: DeveloperModuleReviewRepository;
      distributionRepository?: Pick<DeveloperModuleDistributionRepository, 'history'>;
      trustGate?: Pick<DeveloperModuleTrustGate, 'evaluate'>;
      permissions?: DeveloperPublisherPermissionPort;
      now?: () => Date;
    },
  ) {
    this.now = input.now ?? (() => new Date());
  }

  async requestReview(input: {
    accountId: string;
    releaseId: string;
    actorUserId: string;
    expectedStatus: DeveloperModuleReleaseStatus;
    expectedRevision: number;
    reason?: unknown;
  }): Promise<DeveloperModuleReviewTransition> {
    const release = expectedRelease(
      await this.input.repository.getPublisher(input.accountId, input.releaseId),
      input.expectedStatus,
      input.expectedRevision,
    );
    const transition =
      release.status === 'validated'
        ? { action: 'submit' as const, reasonRequired: false }
        : release.status === 'changes_requested'
          ? { action: 'resubmit' as const, reasonRequired: true }
          : null;
    if (!transition) fail('DEVELOPER_REVIEW_TRANSITION_INVALID', 409);

    await this.input.permissions?.requirePermission(
      release.publisher_id,
      { accountId: release.account_id, userId: input.actorUserId },
      'release',
    );

    return this.input.repository.transition({
      accountId: release.account_id,
      releaseId: release.release_id,
      expectedStatus: input.expectedStatus,
      expectedRevision: input.expectedRevision,
      action: transition.action,
      toStatus: 'review_pending',
      actorUserId: input.actorUserId,
      actorKind: 'publisher',
      reason: normalizeReason(input.reason, transition.reasonRequired),
      evidence: [],
    });
  }

  async decide(input: {
    releaseId: string;
    actorUserId: string;
    decision: DeveloperModuleReviewDecision;
    expectedStatus: DeveloperModuleReleaseStatus;
    expectedRevision: number;
    reason?: unknown;
    evidence?: unknown;
  }): Promise<DeveloperModuleReviewTransition> {
    const release = expectedRelease(
      await this.input.repository.getAdmin(input.releaseId),
      input.expectedStatus,
      input.expectedRevision,
    );

    let toStatus: DeveloperModuleReleaseStatus;
    let reasonRequired: boolean;
    let evidence: DeveloperModuleReviewEvidence[] = [];
    if (input.decision === 'request_changes' && release.status === 'review_pending') {
      toStatus = 'changes_requested';
      reasonRequired = true;
    } else if (input.decision === 'approve' && release.status === 'review_pending') {
      if (this.input.permissions) {
        await this.input.permissions.requirePermission(
          release.publisher_id,
          {
            accountId: release.account_id,
            userId: input.actorUserId,
            platformAdmin: true,
          },
          'platform_review',
        );
      } else {
        const isPublisherMember = await this.input.repository.isPublisherAccountMember(
          release.account_id,
          input.actorUserId,
        );
        if (release.created_by === input.actorUserId || isPublisherMember) {
          fail('DEVELOPER_REVIEW_SELF_APPROVAL_DENIED', 403);
        }
      }
      toStatus = 'approved';
      reasonRequired = false;
      const humanEvidence = normalizeHumanEvidence(input.evidence, release, this.now());
      evidence = mergeEvidence(
        release,
        humanEvidence,
        await automaticEvidence(release, this.input.trustGate),
      );
    } else if (input.decision === 'revoke' && release.status === 'approved') {
      await this.input.permissions?.requirePermission(
        release.publisher_id,
        {
          accountId: release.account_id,
          userId: input.actorUserId,
          platformAdmin: true,
        },
        'platform_review',
      );
      toStatus = 'revoked';
      reasonRequired = true;
    } else {
      fail('DEVELOPER_REVIEW_TRANSITION_INVALID', 409);
    }

    if (input.decision !== 'approve' && input.evidence !== undefined) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    return this.input.repository.transition({
      accountId: release.account_id,
      releaseId: release.release_id,
      expectedStatus: input.expectedStatus,
      expectedRevision: input.expectedRevision,
      action: input.decision,
      toStatus,
      actorUserId: input.actorUserId,
      actorKind: 'platform_admin',
      reason: normalizeReason(input.reason, reasonRequired),
      evidence,
    });
  }

  async history(input: {
    accountId: string;
    releaseId: string;
  }): Promise<readonly DeveloperModuleReviewEvent[]> {
    const release = await this.input.repository.getPublisher(input.accountId, input.releaseId);
    if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    return (await this.input.repository.history(input.accountId, input.releaseId)).map(cloneEvent);
  }

  async combinedHistory(input: {
    accountId: string;
    releaseId: string;
  }): Promise<readonly DeveloperModuleLifecycleEvent[]> {
    const release = await this.input.repository.getPublisher(input.accountId, input.releaseId);
    if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    const reviewHistory = await this.input.repository.history(input.accountId, input.releaseId);
    const distributionHistory = this.input.distributionRepository
      ? await this.input.distributionRepository.history(input.accountId, input.releaseId)
      : [];
    return [
      ...reviewHistory.map(cloneEvent),
      ...distributionHistory.map((event) => structuredClone(event)),
    ].sort(
      (left, right) =>
        left.sequence - right.sequence || left.created_at.localeCompare(right.created_at),
    );
  }

  async adminList(
    input: {
      status?: DeveloperModuleReleaseStatus;
      limit?: number;
      cursor?: string | null;
    } = {},
  ): Promise<DeveloperModuleAdminReviewPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
    const page = await this.input.repository.adminList({
      status: input.status ?? 'review_pending',
      limit,
      cursor: input.cursor,
    });
    return structuredClone(page);
  }

  async adminGet(input: { releaseId: string }): Promise<DeveloperModuleAdminReviewDetail> {
    const release = await this.input.repository.getAdmin(input.releaseId);
    if (!release) fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
    const reviewHistory = await this.input.repository.history(
      release.account_id,
      release.release_id,
    );
    const distributionHistory = this.input.distributionRepository
      ? await this.input.distributionRepository.history(release.account_id, release.release_id)
      : [];
    return {
      release: cloneRelease(release),
      history: [
        ...reviewHistory.map(cloneEvent),
        ...distributionHistory.map((event) => structuredClone(event)),
      ].sort(
        (left, right) =>
          left.sequence - right.sequence || left.created_at.localeCompare(right.created_at),
      ),
    };
  }
}

type MemoryReviewCursor = { updatedAt: string; releaseId: string };

function encodeCursor(value: MemoryReviewCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value: string | null | undefined): MemoryReviewCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      !isPlainObject(parsed) ||
      typeof parsed.updatedAt !== 'string' ||
      typeof parsed.releaseId !== 'string' ||
      Object.keys(parsed).some((key) => key !== 'updatedAt' && key !== 'releaseId')
    ) {
      fail('DEVELOPER_REVIEW_INPUT_INVALID', 400);
    }
    return { updatedAt: parsed.updatedAt, releaseId: parsed.releaseId };
  } catch (error) {
    if (error instanceof DeveloperModuleReviewError) throw error;
    fail('DEVELOPER_REVIEW_INPUT_INVALID', 400);
  }
}

export function createMemoryDeveloperModuleReviewRepository(input?: {
  releases?: readonly DeveloperModuleRelease[];
  publisherAccountMembers?: readonly { accountId: string; userId: string }[];
  now?: () => Date;
  createId?: () => string;
}): DeveloperModuleReviewRepository {
  const now = input?.now ?? (() => new Date());
  const createId = input?.createId ?? randomUUID;
  const releases = new Map(
    (input?.releases ?? []).map((release) => [release.release_id, cloneRelease(release)]),
  );
  const members = new Set(
    (input?.publisherAccountMembers ?? []).map((member) => `${member.accountId}\0${member.userId}`),
  );
  const events = new Map<string, DeveloperModuleReviewEvent[]>();

  return {
    async getPublisher(accountId, releaseId) {
      const release = releases.get(releaseId);
      return release?.account_id === accountId ? cloneRelease(release) : null;
    },

    async getAdmin(releaseId) {
      const release = releases.get(releaseId);
      return release ? cloneRelease(release) : null;
    },

    async isPublisherAccountMember(accountId, userId) {
      return members.has(`${accountId}\0${userId}`);
    },

    async transition(command) {
      const release = releases.get(command.releaseId);
      if (!release || release.account_id !== command.accountId) {
        fail('DEVELOPER_RELEASE_NOT_FOUND', 404);
      }
      if (
        release.status !== command.expectedStatus ||
        release.review_revision !== command.expectedRevision
      ) {
        fail('DEVELOPER_REVIEW_CONFLICT', 409);
      }

      const createdAt = now().toISOString();
      const nextRelease: DeveloperModuleRelease = {
        ...cloneRelease(release),
        status: command.toStatus,
        review_revision: release.review_revision + 1,
        updated_at: createdAt,
      };
      const event: DeveloperModuleReviewEvent = {
        review_event_id: createId(),
        release_id: release.release_id,
        account_id: release.account_id,
        sequence: nextRelease.review_revision,
        action: command.action,
        from_status: release.status,
        to_status: command.toStatus,
        actor_user_id: command.actorUserId,
        actor_kind: command.actorKind,
        reason: command.reason,
        evidence: structuredClone(command.evidence) as DeveloperModuleReviewEvidence[],
        created_at: createdAt,
      };
      releases.set(release.release_id, cloneRelease(nextRelease));
      const releaseEvents = events.get(release.release_id) ?? [];
      releaseEvents.push(cloneEvent(event));
      events.set(release.release_id, releaseEvents);
      return { release: cloneRelease(nextRelease), event: cloneEvent(event) };
    },

    async history(accountId, releaseId) {
      const release = releases.get(releaseId);
      if (!release || release.account_id !== accountId) return [];
      return (events.get(releaseId) ?? [])
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map(cloneEvent);
    },

    async adminList({ status, limit, cursor }) {
      const decoded = decodeCursor(cursor);
      const ordered = [...releases.values()]
        .filter((release) => release.status === status)
        .sort(
          (left, right) =>
            right.updated_at.localeCompare(left.updated_at) ||
            right.release_id.localeCompare(left.release_id),
        )
        .filter(
          (release) =>
            !decoded ||
            release.updated_at < decoded.updatedAt ||
            (release.updated_at === decoded.updatedAt && release.release_id < decoded.releaseId),
        );
      const page = ordered.slice(0, limit);
      const hasMore = ordered.length > limit;
      const last = page.at(-1);
      return {
        releases: page.map(cloneRelease),
        next_cursor:
          hasMore && last
            ? encodeCursor({ updatedAt: last.updated_at, releaseId: last.release_id })
            : null,
      };
    },
  };
}
