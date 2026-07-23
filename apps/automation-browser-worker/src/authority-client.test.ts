import { describe, expect, test } from 'bun:test';
import { AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH } from '@kortix/intelligence-contracts';
import { createBrowserAuthorityClient } from './authority-client';
import { createWorkerControlClient } from './worker-control-client';

const NOW = new Date('2099-07-23T10:00:00.000Z');
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const LEASE_ID = '80000000-0000-4000-a000-000000000001';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'sha256:browser-worker-certificate';
const WORKER_SECRET = 'browser-worker-shared-secret-at-least-32-bytes';
const AUTHORITY_INPUT = {
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  lease_owner: `browser-worker-1:${LEASE_ID}`,
  request_hash: `sha256:${'a'.repeat(64)}`,
  kill_switch_generation: 7,
  check: { kind: 'generation' as const },
};

const ACCEPTED = {
  protocol_version: 'automation.v1' as const,
  authorized: true as const,
  check: 'generation' as const,
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  kill_switch_generation: 7,
  full_access_grant_current: false,
  checked_at: NOW.toISOString(),
};

describe('Browser authority client', () => {
  test('adds a request timestamp and binds the accepted authority response', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createWorkerControlClient({
      controlUrl: 'https://control.internal',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      requestTimeoutMs: 5_000,
      nextNonce: () => 101,
      now: () => NOW,
      transport: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
        return Response.json(ACCEPTED);
      },
    });

    const authority = createBrowserAuthorityClient({ client, now: () => NOW });
    const result = await authority.check(AUTHORITY_INPUT);

    expect(result).toEqual(ACCEPTED);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `https://control.internal${AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH}`,
      body: {
        proof: { service_id: WORKER_ID, nonce: 101 },
        authority: { ...AUTHORITY_INPUT, requested_at: NOW.toISOString() },
      },
    });
  });

  test('rejects accepted responses with wrong job, lease, or check without leaking the body', async () => {
    for (const overrides of [
      { job_id: '40000000-0000-4000-a000-000000000099' },
      { lease_id: '80000000-0000-4000-a000-000000000099' },
      { check: 'lease' as const },
    ]) {
      const client = createWorkerControlClient({
        controlUrl: 'https://control.internal',
        serviceId: WORKER_ID,
        certificateFingerprint256: WORKER_FINGERPRINT,
        sharedSecret: WORKER_SECRET,
        requestTimeoutMs: 5_000,
        nextNonce: () => 102,
        now: () => NOW,
        transport: async () => Response.json({ ...ACCEPTED, ...overrides }),
      });

      const authority = createBrowserAuthorityClient({ client, now: () => NOW });
      const error = await authority.check(AUTHORITY_INPUT).catch((caught) => caught);
      expect(error).toMatchObject({
        name: 'BrowserAuthorityClientError',
        reason: 'protocol',
        message: 'Browser authority check response is invalid',
      });
      expect(String(error)).not.toMatch(/40000000-0000-4000-a000-000000000099|secret|token/i);
    }
  });
});
