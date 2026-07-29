import { createHash } from 'node:crypto';

export type AccountRequestKind =
  | 'data_export'
  | 'account_deletion'
  | 'security_report'
  | 'module_report';

export type AccountRequestStatus =
  | 'pending'
  | 'cooling_off'
  | 'processing'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export interface AccountRequestRecord {
  requestId: string;
  accountId: string;
  requestedBy: string;
  kind: AccountRequestKind;
  status: AccountRequestStatus;
  reason: string | null;
  moduleInstallationId: string | null;
  idempotencyKey: string;
  requestHash: string;
  requestedAt: string;
  notBeforeAt: string | null;
  processingStartedAt: string | null;
  terminalAt: string | null;
  expiresAt: string | null;
  resultMetadata: Record<string, unknown>;
  updatedAt: string;
}

export interface AccountRequestAuditEvent {
  accountId: string;
  actorUserId: string;
  action: 'account_request.created' | 'account_request.cancelled';
  resourceType: 'account_request';
  resourceId: string;
  metadata: Record<string, unknown>;
}

export interface AccountRequestRepository {
  isMember(accountId: string, userId: string): Promise<boolean>;
  moduleInstallationBelongsToAccount(accountId: string, installationId: string): Promise<boolean>;
  createIdempotent(
    record: AccountRequestRecord,
  ): Promise<{ record: AccountRequestRecord; created: boolean }>;
  listOwned(accountId: string, userId: string): Promise<AccountRequestRecord[]>;
  cancelOwned(input: {
    accountId: string;
    userId: string;
    requestId: string;
    cancelledAt: string;
  }): Promise<
    | { kind: 'cancelled'; record: AccountRequestRecord }
    | { kind: 'not_found' }
    | { kind: 'not_cancellable' }
  >;
}

export interface CreateAccountRequestInput {
  kind: AccountRequestKind;
  reason?: string;
  moduleInstallationId?: string;
  idempotencyKey: string;
}

export interface AccountRequestSubject {
  accountId: string;
  userId: string;
}

export type AccountRequestErrorCode =
  | 'ACCOUNT_REQUEST_INPUT_INVALID'
  | 'ACCOUNT_REQUEST_NOT_FOUND'
  | 'ACCOUNT_REQUEST_IDEMPOTENCY_CONFLICT'
  | 'ACCOUNT_REQUEST_NOT_CANCELLABLE'
  | 'ACCOUNT_REQUEST_DEPENDENCY_UNAVAILABLE';

export interface AccountRequestError {
  code: AccountRequestErrorCode;
  message: string;
  recoverable: boolean;
}

export type AccountRequestResult<T> =
  | { success: true; data: T }
  | { success: false; error: AccountRequestError };

export interface AccountRequestServiceDependencies {
  repository: AccountRequestRepository;
  now?: () => Date;
  randomUUID?: () => string;
  recordAuditEvent: (event: AccountRequestAuditEvent) => Promise<unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/;
const KINDS = new Set<AccountRequestKind>([
  'data_export',
  'account_deletion',
  'security_report',
  'module_report',
]);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const inputInvalid = (): AccountRequestResult<never> => ({
  success: false,
  error: {
    code: 'ACCOUNT_REQUEST_INPUT_INVALID',
    message: 'The account request input is invalid',
    recoverable: false,
  },
});

const notFound = (): AccountRequestResult<never> => ({
  success: false,
  error: {
    code: 'ACCOUNT_REQUEST_NOT_FOUND',
    message: 'The account request was not found',
    recoverable: false,
  },
});

const dependencyUnavailable = (): AccountRequestResult<never> => ({
  success: false,
  error: {
    code: 'ACCOUNT_REQUEST_DEPENDENCY_UNAVAILABLE',
    message: 'The account request service is temporarily unavailable',
    recoverable: true,
  },
});

function normalizedReason(reason: string | undefined): string | null | undefined {
  if (reason === undefined) return null;
  if (typeof reason !== 'string' || reason !== reason.trim()) return undefined;
  if (reason.length < 1 || reason.length > 4000 || Buffer.byteLength(reason, 'utf8') > 8192) {
    return undefined;
  }
  return reason;
}

function requestHash(input: {
  kind: AccountRequestKind;
  reason: string | null;
  moduleInstallationId: string | null;
}): string {
  const canonical = JSON.stringify([
    'account-request-v1',
    input.kind,
    input.reason,
    input.moduleInstallationId,
  ]);
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function auditMetadata(record: AccountRequestRecord): Record<string, unknown> {
  return {
    kind: record.kind,
    status: record.status,
    ...(record.moduleInstallationId ? { module_installation_id: record.moduleInstallationId } : {}),
  };
}

export function createAccountRequestService(dependencies: AccountRequestServiceDependencies) {
  const now = dependencies.now ?? (() => new Date());
  const randomUUID = dependencies.randomUUID ?? (() => crypto.randomUUID());

  return {
    async create(
      input: CreateAccountRequestInput,
      subject: AccountRequestSubject,
    ): Promise<AccountRequestResult<{ request: AccountRequestRecord; created: boolean }>> {
      const reason = normalizedReason(input.reason);
      const moduleInstallationId = input.moduleInstallationId ?? null;
      if (
        !UUID_RE.test(subject.accountId) ||
        !UUID_RE.test(subject.userId) ||
        !KINDS.has(input.kind) ||
        reason === undefined ||
        !IDEMPOTENCY_RE.test(input.idempotencyKey) ||
        (input.kind === 'module_report') !== (moduleInstallationId !== null) ||
        (moduleInstallationId !== null && !UUID_RE.test(moduleInstallationId))
      ) {
        return inputInvalid();
      }

      try {
        if (!(await dependencies.repository.isMember(subject.accountId, subject.userId))) {
          return notFound();
        }
        if (
          moduleInstallationId &&
          !(await dependencies.repository.moduleInstallationBelongsToAccount(
            subject.accountId,
            moduleInstallationId,
          ))
        ) {
          return notFound();
        }

        const requestedAt = now();
        if (!Number.isFinite(requestedAt.getTime())) return inputInvalid();
        const requestedAtIso = requestedAt.toISOString();
        const delayedAtIso = new Date(requestedAt.getTime() + SEVEN_DAYS_MS).toISOString();
        const record: AccountRequestRecord = {
          requestId: randomUUID(),
          accountId: subject.accountId,
          requestedBy: subject.userId,
          kind: input.kind,
          status: input.kind === 'account_deletion' ? 'cooling_off' : 'pending',
          reason,
          moduleInstallationId,
          idempotencyKey: input.idempotencyKey,
          requestHash: requestHash({ kind: input.kind, reason, moduleInstallationId }),
          requestedAt: requestedAtIso,
          notBeforeAt: input.kind === 'account_deletion' ? delayedAtIso : null,
          processingStartedAt: null,
          terminalAt: null,
          expiresAt: input.kind === 'data_export' ? delayedAtIso : null,
          resultMetadata: {},
          updatedAt: requestedAtIso,
        };

        const stored = await dependencies.repository.createIdempotent(record);
        if (stored.record.requestHash !== record.requestHash) {
          return {
            success: false,
            error: {
              code: 'ACCOUNT_REQUEST_IDEMPOTENCY_CONFLICT',
              message: 'The idempotency key was already used for a different account request',
              recoverable: false,
            },
          };
        }
        if (stored.created) {
          await dependencies.recordAuditEvent({
            accountId: subject.accountId,
            actorUserId: subject.userId,
            action: 'account_request.created',
            resourceType: 'account_request',
            resourceId: stored.record.requestId,
            metadata: auditMetadata(stored.record),
          });
        }
        return {
          success: true,
          data: { request: stored.record, created: stored.created },
        };
      } catch {
        return dependencyUnavailable();
      }
    },

    async list(
      subject: AccountRequestSubject,
    ): Promise<AccountRequestResult<{ requests: AccountRequestRecord[] }>> {
      if (!UUID_RE.test(subject.accountId) || !UUID_RE.test(subject.userId)) {
        return inputInvalid();
      }
      try {
        if (!(await dependencies.repository.isMember(subject.accountId, subject.userId))) {
          return notFound();
        }
        const requests = await dependencies.repository.listOwned(subject.accountId, subject.userId);
        return { success: true, data: { requests } };
      } catch {
        return dependencyUnavailable();
      }
    },

    async cancel(
      requestId: string,
      subject: AccountRequestSubject,
    ): Promise<AccountRequestResult<{ request: AccountRequestRecord }>> {
      if (
        !UUID_RE.test(requestId) ||
        !UUID_RE.test(subject.accountId) ||
        !UUID_RE.test(subject.userId)
      ) {
        return inputInvalid();
      }
      try {
        if (!(await dependencies.repository.isMember(subject.accountId, subject.userId))) {
          return notFound();
        }
        const cancelledAt = now();
        if (!Number.isFinite(cancelledAt.getTime())) return inputInvalid();
        const cancelled = await dependencies.repository.cancelOwned({
          accountId: subject.accountId,
          userId: subject.userId,
          requestId,
          cancelledAt: cancelledAt.toISOString(),
        });
        if (cancelled.kind === 'not_found') return notFound();
        if (cancelled.kind === 'not_cancellable') {
          return {
            success: false,
            error: {
              code: 'ACCOUNT_REQUEST_NOT_CANCELLABLE',
              message: 'The account request can no longer be cancelled',
              recoverable: false,
            },
          };
        }
        await dependencies.recordAuditEvent({
          accountId: subject.accountId,
          actorUserId: subject.userId,
          action: 'account_request.cancelled',
          resourceType: 'account_request',
          resourceId: cancelled.record.requestId,
          metadata: {
            kind: cancelled.record.kind,
            from_status: cancelled.record.kind === 'account_deletion' ? 'cooling_off' : 'pending',
            to_status: 'cancelled',
          },
        });
        return { success: true, data: { request: cancelled.record } };
      } catch {
        return dependencyUnavailable();
      }
    },
  };
}
