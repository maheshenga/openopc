import { describe, expect, test } from 'bun:test';
import {
  AutomationCredentialBrokerError,
  createMemoryCredentialBroker,
  createMemoryCredentialReferenceStore,
  sanitizeAutomationAuditPayload,
} from './credential-broker';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const JOB_ID = '00000000-0000-4000-8000-000000000003';
const STEP_ID = '00000000-0000-4000-8000-000000000004';
const LOCATOR_ID = '00000000-0000-4000-8000-000000000005';
const ACTION_HASH = `sha256:${'b'.repeat(64)}` as const;
const NOW = new Date('2026-07-22T10:00:00.000Z');

function issueInput(overrides?: Partial<{ ttlMs: number }>) {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    locator: { kind: 'project_secret' as const, locatorId: LOCATOR_ID },
    ttlMs: 60_000,
    ...overrides,
  };
}

describe('automation credential broker', () => {
  test('issues only a short-lived opaque reference and persists no secret value', async () => {
    const store = createMemoryCredentialReferenceStore();
    const broker = createMemoryCredentialBroker({ store, now: () => NOW });

    const issued = await broker.issue(issueInput());

    expect(issued).toEqual({
      reference: expect.stringMatching(/^credential-ref:[0-9a-f-]{36}$/),
      expiresAt: '2026-07-22T10:01:00.000Z',
    });
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).toContain(LOCATOR_ID);
    expect(persisted).not.toContain('super-secret-value');
    expect(persisted).not.toContain('authorization');
  });

  test('resolves a locator only once for the exact job action and project binding', async () => {
    const broker = createMemoryCredentialBroker({ now: () => NOW });
    const issued = await broker.issue(issueInput());

    expect(
      await broker.resolve({
        reference: issued.reference,
        accountId: ACCOUNT_ID,
        projectId: '00000000-0000-4000-8000-000000000099',
        jobId: JOB_ID,
        stepId: STEP_ID,
        actionHash: ACTION_HASH,
      }),
    ).toBeNull();
    expect(
      await broker.resolve({
        reference: issued.reference,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        stepId: STEP_ID,
        actionHash: ACTION_HASH,
      }),
    ).toEqual({ kind: 'project_secret', locatorId: LOCATOR_ID });
    expect(
      await broker.resolve({
        reference: issued.reference,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        stepId: STEP_ID,
        actionHash: ACTION_HASH,
      }),
    ).toBeNull();
  });

  test('rejects references that exceed the maximum five-minute lifetime', async () => {
    const broker = createMemoryCredentialBroker({ now: () => NOW });

    await expect(broker.issue(issueInput({ ttlMs: 300_001 }))).rejects.toBeInstanceOf(
      AutomationCredentialBrokerError,
    );
  });

  test('removes secrets, credential references, and signed URL queries from audit payloads', () => {
    const sanitized = sanitizeAutomationAuditPayload({
      action: 'download',
      authorization: 'Bearer super-secret-value',
      headers: { Cookie: 'session=super-secret-value', safe: 'present' },
      nested: [
        {
          password: 'super-secret-value',
          callbackUrl:
            'https://assets.example.com/file.png?X-Amz-Credential=AKIA&X-Amz-Signature=signature-value',
          credentialReference: 'credential-ref:00000000-0000-4000-8000-000000000123',
        },
      ],
    });

    expect(sanitized).toEqual({
      action: 'download',
      headers: { safe: 'present' },
      nested: [{ callbackUrl: 'https://assets.example.com/file.png' }],
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('credential-ref:');
    expect(serialized).not.toContain('X-Amz-Signature');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('Cookie');
    expect(serialized).not.toContain('password');
  });
});
