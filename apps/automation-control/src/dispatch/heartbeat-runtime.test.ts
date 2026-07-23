import { describe, expect, test } from 'bun:test';
import { loadAutomationControlConfig } from '../config';
import {
  AUTOMATION_BROWSER_HEARTBEAT_PATH,
  createWorkerTlsAttestationHeaders,
} from './heartbeat-route';
import { createBrowserWorkerHeartbeatRuntime } from './heartbeat-runtime';
import { createMemoryWorkerNonceStore, createWorkerServiceAuthenticator } from './worker-auth';

const NOW = new Date('2026-07-23T02:00:00.000Z');
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'AA:BB:CC:DD';
const WORKER_SECRET = 'worker-shared-secret-at-least-thirty-two-bytes';
const TLS_ATTESTATION_SECRET = 'trusted-proxy-attestation-secret-at-least-thirty-two-bytes';

describe('Browser Worker heartbeat runtime', () => {
  test('composes shared proof replay protection, lease fencing, and the durable sink', async () => {
    const config = loadAutomationControlConfig({
      AUTOMATION_CONTROL_ENABLED: 'true',
      AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
      DATABASE_URL: 'postgresql://db.example.test/automation',
      REDIS_URL: 'redis://redis.example.test:6379',
      AUTOMATION_CONTROL_SHARED_SECRET: 'control-shared-secret-at-least-thirty-two-bytes',
      AUTOMATION_BROWSER_WORKER_TRUST_JSON: JSON.stringify({
        [WORKER_ID]: {
          fingerprints: [WORKER_FINGERPRINT],
          shared_secret: WORKER_SECRET,
        },
      }),
      AUTOMATION_WORKER_TLS_ATTESTATION_SECRET: TLS_ATTESTATION_SECRET,
    });
    const heartbeat = {
      protocol_version: 'automation.v1' as const,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: `${WORKER_ID}:${LEASE_ID}`,
      kill_switch_generation: 3,
      worker_id: WORKER_ID,
      ordinal: 1,
      observed_at: NOW.toISOString(),
      event: {
        type: 'heartbeat' as const,
        payload: { last_completed_step: 0 },
        trace_id: null,
      },
    };
    const signer = createWorkerServiceAuthenticator({
      trustedPeers: config.browserWorkerPeers,
      nonceStore: createMemoryWorkerNonceStore(),
      now: () => NOW,
    });
    const proof = signer.sign({
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      timestamp: NOW,
      nonce: 11,
      body: heartbeat,
    });
    const body = JSON.stringify({ protocol_version: 'automation.v1', proof, heartbeat });
    const leaseChecks: unknown[] = [];
    const sinkCalls: unknown[] = [];
    const event = {
      protocol_version: 'automation.v1' as const,
      event_id: '50000000-0000-4000-a000-000000000001',
      job_id: JOB_ID,
      sequence: 8,
      type: 'heartbeat' as const,
      status: null,
      payload: heartbeat.event.payload,
      trace_id: null,
      created_at: NOW.toISOString(),
    };
    const app = createBrowserWorkerHeartbeatRuntime({
      config,
      authenticator: signer,
      now: () => NOW,
      leaseManager: {
        async isCurrent(jobId, owner, checkedAt) {
          leaseChecks.push({ jobId, owner, checkedAt });
          return true;
        },
      },
      eventSink: {
        async append(input) {
          sinkCalls.push(input);
          return { accepted: true as const, event };
        },
      },
    });
    const headers = createWorkerTlsAttestationHeaders({
      secret: TLS_ATTESTATION_SECRET,
      timestamp: NOW,
      method: 'POST',
      path: AUTOMATION_BROWSER_HEARTBEAT_PATH,
      body,
      certificate: {
        authorized: true,
        serviceId: WORKER_ID,
        fingerprint256: WORKER_FINGERPRINT,
        validTo: '2026-07-24T02:00:00.000Z',
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    const replay = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
    const identityMismatchHeartbeat = {
      ...heartbeat,
      worker_id: 'browser-worker-2',
      ordinal: 2,
    };
    const identityMismatchProof = signer.sign({
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      timestamp: NOW,
      nonce: 12,
      body: identityMismatchHeartbeat,
    });
    const identityMismatchBody = JSON.stringify({
      protocol_version: 'automation.v1',
      proof: identityMismatchProof,
      heartbeat: identityMismatchHeartbeat,
    });
    const identityMismatchHeaders = createWorkerTlsAttestationHeaders({
      secret: TLS_ATTESTATION_SECRET,
      timestamp: NOW,
      method: 'POST',
      path: AUTOMATION_BROWSER_HEARTBEAT_PATH,
      body: identityMismatchBody,
      certificate: {
        authorized: true,
        serviceId: WORKER_ID,
        fingerprint256: WORKER_FINGERPRINT,
        validTo: '2026-07-24T02:00:00.000Z',
      },
    });
    const identityMismatch = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...identityMismatchHeaders },
      body: identityMismatchBody,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'automation.v1',
      accepted: true,
      event,
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_CONFLICT',
      retryable: false,
    });
    expect(identityMismatch.status).toBe(401);
    expect(await identityMismatch.json()).toMatchObject({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_UNAUTHORIZED',
      retryable: false,
    });
    expect(leaseChecks).toEqual([
      { jobId: JOB_ID, owner: `${WORKER_ID}:${LEASE_ID}`, checkedAt: NOW },
    ]);
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0]).toMatchObject({
      workerId: WORKER_ID,
      workerOrdinal: 1,
      binding: {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        leaseId: LEASE_ID,
        owner: `${WORKER_ID}:${LEASE_ID}`,
        killSwitchGeneration: 3,
      },
    });
  });
});
