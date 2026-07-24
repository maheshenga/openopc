import { randomUUID } from 'node:crypto';

import type {
  DeveloperModuleRelease,
  DeveloperModuleReleaseStatus,
  DeveloperModuleReviewRequirement,
} from './releases';

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

export interface DeveloperModuleReviewEvidence {
  requirement: DeveloperModuleReviewRequirement;
  outcome: 'passed';
  method: 'manual';
  summary: string;
  observed_at: string;
  tool?: string;
  tool_version?: string;
  evidence_digest?: `sha256:${string}`;
}

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
  history: DeveloperModuleReviewEvent[];
}

export type DeveloperModuleReviewErrorCode =
  | 'DEVELOPER_RELEASE_NOT_FOUND'
  | 'DEVELOPER_REVIEW_CONFLICT'
  | 'DEVELOPER_REVIEW_TRANSITION_INVALID'
  | 'DEVELOPER_REVIEW_REASON_REQUIRED'
  | 'DEVELOPER_REVIEW_REASON_INVALID'
  | 'DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE'
  | 'DEVELOPER_REVIEW_SELF_APPROVAL_DENIED'
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
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TOOL_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b/i,
];
const EVIDENCE_KEYS = new Set([
  'requirement',
  'outcome',
  'method',
  'summary',
  'observed_at',
  'tool',
  'tool_version',
  'evidence_digest',
]);

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

function normalizeEvidence(
  value: unknown,
  release: DeveloperModuleRelease,
  now: Date,
): DeveloperModuleReviewEvidence[] {
  if (!Array.isArray(value) || value.length !== release.review_requirements.length) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  const allowedRequirements = new Set(release.review_requirements);
  const byRequirement = new Map<DeveloperModuleReviewRequirement, DeveloperModuleReviewEvidence>();
  const releaseCreatedAt = Date.parse(release.created_at);

  for (const raw of value) {
    if (!isPlainObject(raw) || Object.keys(raw).some((key) => !EVIDENCE_KEYS.has(key))) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    const requirement = raw.requirement;
    if (
      typeof requirement !== 'string' ||
      !allowedRequirements.has(requirement as DeveloperModuleReviewRequirement) ||
      byRequirement.has(requirement as DeveloperModuleReviewRequirement) ||
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
    if (raw.tool !== undefined && (typeof raw.tool !== 'string' || !IDENTIFIER.test(raw.tool))) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    if (
      raw.tool_version !== undefined &&
      (typeof raw.tool_version !== 'string' ||
        !TOOL_VERSION.test(raw.tool_version) ||
        raw.tool === undefined)
    ) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }
    if (
      raw.evidence_digest !== undefined &&
      (typeof raw.evidence_digest !== 'string' || !SHA256.test(raw.evidence_digest))
    ) {
      fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    }

    const evidence: DeveloperModuleReviewEvidence = {
      requirement: requirement as DeveloperModuleReviewRequirement,
      outcome: 'passed',
      method: 'manual',
      summary: normalizeSummary(raw.summary),
      observed_at: raw.observed_at,
      ...(raw.tool !== undefined ? { tool: raw.tool as string } : {}),
      ...(raw.tool_version !== undefined ? { tool_version: raw.tool_version as string } : {}),
      ...(raw.evidence_digest !== undefined
        ? { evidence_digest: raw.evidence_digest as `sha256:${string}` }
        : {}),
    };
    byRequirement.set(evidence.requirement, evidence);
  }

  if (byRequirement.size !== release.review_requirements.length) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  const normalized = release.review_requirements.map((requirement) => {
    const evidence = byRequirement.get(requirement);
    if (!evidence) fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
    return evidence;
  });
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > EVIDENCE_MAX_BYTES) {
    fail('DEVELOPER_REVIEW_EVIDENCE_INCOMPLETE', 400);
  }
  return structuredClone(normalized);
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
      const isPublisherMember = await this.input.repository.isPublisherAccountMember(
        release.account_id,
        input.actorUserId,
      );
      if (release.created_by === input.actorUserId || isPublisherMember) {
        fail('DEVELOPER_REVIEW_SELF_APPROVAL_DENIED', 403);
      }
      toStatus = 'approved';
      reasonRequired = false;
      evidence = normalizeEvidence(input.evidence, release, this.now());
    } else if (input.decision === 'revoke' && release.status === 'approved') {
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
    return {
      release: cloneRelease(release),
      history: (await this.input.repository.history(release.account_id, release.release_id)).map(
        cloneEvent,
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
