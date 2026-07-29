import { describe, expect, test } from 'bun:test';

import {
  type AccountRequestAuditEvent,
  type AccountRequestRecord,
  type AccountRequestRepository,
  createAccountRequestService,
} from './service';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MODULE_INSTALLATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = new Date('2026-07-28T12:00:00.000Z');

class MemoryRepository implements AccountRequestRepository {
  readonly members = new Set([`${ACCOUNT_A}:${USER_A}`, `${ACCOUNT_B}:${USER_B}`]);
  readonly moduleInstallations = new Set([`${ACCOUNT_A}:${MODULE_INSTALLATION_ID}`]);
  readonly records = new Map<string, AccountRequestRecord>();

  async isMember(accountId: string, userId: string): Promise<boolean> {
    return this.members.has(`${accountId}:${userId}`);
  }

  async moduleInstallationBelongsToAccount(
    accountId: string,
    installationId: string,
  ): Promise<boolean> {
    return this.moduleInstallations.has(`${accountId}:${installationId}`);
  }

  async createIdempotent(
    record: AccountRequestRecord,
  ): Promise<{ record: AccountRequestRecord; created: boolean }> {
    const key = `${record.accountId}:${record.requestedBy}:${record.idempotencyKey}`;
    const existing = [...this.records.values()].find(
      (candidate) =>
        `${candidate.accountId}:${candidate.requestedBy}:${candidate.idempotencyKey}` === key,
    );
    if (existing) return { record: structuredClone(existing), created: false };
    this.records.set(record.requestId, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }

  async listOwned(accountId: string, userId: string): Promise<AccountRequestRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.accountId === accountId && record.requestedBy === userId)
      .map((record) => structuredClone(record));
  }

  async cancelOwned(input: {
    accountId: string;
    userId: string;
    requestId: string;
    cancelledAt: string;
  }): Promise<
    | { kind: 'cancelled'; record: AccountRequestRecord }
    | { kind: 'not_found' }
    | { kind: 'not_cancellable' }
  > {
    const record = this.records.get(input.requestId);
    if (
      !record ||
      record.accountId !== input.accountId ||
      record.requestedBy !== input.userId
    ) {
      return { kind: 'not_found' };
    }
    if (record.status !== 'pending' && record.status !== 'cooling_off') {
      return { kind: 'not_cancellable' };
    }
    const cancelled: AccountRequestRecord = {
      ...record,
      status: 'cancelled',
      terminalAt: input.cancelledAt,
      updatedAt: input.cancelledAt,
    };
    this.records.set(record.requestId, cancelled);
    return { kind: 'cancelled', record: structuredClone(cancelled) };
  }
}

function harness() {
  const repository = new MemoryRepository();
  const audits: AccountRequestAuditEvent[] = [];
  const service = createAccountRequestService({
    repository,
    now: () => new Date(NOW),
    randomUUID: () => REQUEST_ID,
    recordAuditEvent: async (event) => audits.push(structuredClone(event)),
  });
  return { service, repository, audits };
}

function expectSuccess<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new Error('expected success');
  return result.data;
}

describe('account request service', () => {
  test('creates deletion cooling-off and expiring export requests with immutable identities', async () => {
    const { service } = harness();

    const deletion = expectSuccess(
      await service.create(
        { kind: 'account_deletion', idempotencyKey: 'delete-request-0001' },
        { accountId: ACCOUNT_A, userId: USER_A },
      ),
    );
    expect(deletion.request.status).toBe('cooling_off');
    expect(deletion.request.notBeforeAt).toBe('2026-08-04T12:00:00.000Z');
    expect(deletion.request.expiresAt).toBeNull();

    const exportRequest = expectSuccess(
      await service.create(
        { kind: 'data_export', idempotencyKey: 'export-request-0001' },
        { accountId: ACCOUNT_A, userId: USER_A },
      ),
    );
    expect(exportRequest.request.status).toBe('pending');
    expect(exportRequest.request.expiresAt).toBe('2026-08-04T12:00:00.000Z');
    expect(exportRequest.request.accountId).toBe(ACCOUNT_A);
    expect(exportRequest.request.requestedBy).toBe(USER_A);
  });

  test('replays identical idempotency keys and rejects conflicting reuse', async () => {
    const { service, audits } = harness();
    const input = {
      kind: 'security_report' as const,
      reason: 'credential exposure in a private workflow',
      idempotencyKey: 'security-report-0001',
    };

    const first = expectSuccess(
      await service.create(input, { accountId: ACCOUNT_A, userId: USER_A }),
    );
    const replay = expectSuccess(
      await service.create(input, { accountId: ACCOUNT_A, userId: USER_A }),
    );
    expect(replay.created).toBe(false);
    expect(replay.request.requestId).toBe(first.request.requestId);
    expect(audits).toHaveLength(1);

    const conflict = await service.create(
      { ...input, reason: 'different evidence under the same key' },
      { accountId: ACCOUNT_A, userId: USER_A },
    );
    expect(conflict).toEqual({
      success: false,
      error: {
        code: 'ACCOUNT_REQUEST_IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for a different account request',
        recoverable: false,
      },
    });
  });

  test('requires account-owned module installations and never audits raw report text', async () => {
    const { service, audits } = harness();
    const reason = 'secret token value must never enter audit metadata';
    const created = expectSuccess(
      await service.create(
        {
          kind: 'module_report',
          reason,
          moduleInstallationId: MODULE_INSTALLATION_ID,
          idempotencyKey: 'module-report-0001',
        },
        { accountId: ACCOUNT_A, userId: USER_A },
      ),
    );
    expect(created.request.moduleInstallationId).toBe(MODULE_INSTALLATION_ID);
    expect(JSON.stringify(audits)).not.toContain(reason);
    expect(audits[0]?.metadata).toEqual({
      kind: 'module_report',
      status: 'pending',
      module_installation_id: MODULE_INSTALLATION_ID,
    });

    const crossTenant = await service.create(
      {
        kind: 'module_report',
        moduleInstallationId: MODULE_INSTALLATION_ID,
        idempotencyKey: 'module-report-0002',
      },
      { accountId: ACCOUNT_B, userId: USER_B },
    );
    expect(crossTenant.success).toBe(false);
    if (crossTenant.success) throw new Error('expected opaque denial');
    expect(crossTenant.error.code).toBe('ACCOUNT_REQUEST_NOT_FOUND');
  });

  test('lists only owned records and gives opaque not-found across account boundaries', async () => {
    const { service } = harness();
    const created = expectSuccess(
      await service.create(
        { kind: 'data_export', idempotencyKey: 'export-request-0002' },
        { accountId: ACCOUNT_A, userId: USER_A },
      ),
    );

    const own = expectSuccess(await service.list({ accountId: ACCOUNT_A, userId: USER_A }));
    expect(own.requests.map((request) => request.requestId)).toEqual([
      created.request.requestId,
    ]);

    const foreignList = await service.list({ accountId: ACCOUNT_A, userId: USER_B });
    expect(foreignList.success).toBe(false);
    if (foreignList.success) throw new Error('expected opaque denial');
    expect(foreignList.error.code).toBe('ACCOUNT_REQUEST_NOT_FOUND');

    const foreignCancel = await service.cancel(created.request.requestId, {
      accountId: ACCOUNT_B,
      userId: USER_B,
    });
    expect(foreignCancel.success).toBe(false);
    if (foreignCancel.success) throw new Error('expected opaque denial');
    expect(foreignCancel.error.code).toBe('ACCOUNT_REQUEST_NOT_FOUND');
  });

  test('cancels only before processing and emits a sanitized cancellation audit', async () => {
    const { service, repository, audits } = harness();
    const created = expectSuccess(
      await service.create(
        { kind: 'account_deletion', idempotencyKey: 'delete-request-0002' },
        { accountId: ACCOUNT_A, userId: USER_A },
      ),
    );
    const cancelled = expectSuccess(
      await service.cancel(created.request.requestId, {
        accountId: ACCOUNT_A,
        userId: USER_A,
      }),
    );
    expect(cancelled.request.status).toBe('cancelled');
    expect(audits.at(-1)?.metadata).toEqual({
      kind: 'account_deletion',
      from_status: 'cooling_off',
      to_status: 'cancelled',
    });

    const processing: AccountRequestRecord = {
      ...created.request,
      requestId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      idempotencyKey: 'delete-request-0003',
      status: 'processing',
      processingStartedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    repository.records.set(processing.requestId, processing);
    const late = await service.cancel(processing.requestId, {
      accountId: ACCOUNT_A,
      userId: USER_A,
    });
    expect(late.success).toBe(false);
    if (late.success) throw new Error('expected cancellation conflict');
    expect(late.error.code).toBe('ACCOUNT_REQUEST_NOT_CANCELLABLE');
  });
});
