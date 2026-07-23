import { describe, expect, test } from 'bun:test';
import {
  AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
  AUTOMATION_BROWSER_HEARTBEAT_PATH,
  AutomationBrowserApprovalConsumeInputSchema,
  AutomationBrowserAuthorityCheckInputSchema,
} from '@kortix/intelligence-contracts';
import { type AutomationControlConfig, loadAutomationControlConfig } from '../config';
import { createBrowserWorkerRoutes } from './browser-worker-routes';
import { createWorkerTlsAttestationHeaders } from './heartbeat-route';
import { createWorkerSecurityRuntime } from './worker-security-runtime';

const NOW = new Date('2099-07-23T10:00:00.000Z');
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'sha256:browser-worker-certificate';
const WORKER_SECRET = 'browser-worker-shared-secret-at-least-32-bytes';
const TLS_SECRET = 'trusted-tls-proxy-secret-at-least-32-bytes';

function enabledConfig(approvalResumeEnabled = true): AutomationControlConfig {
  return loadAutomationControlConfig({
    AUTOMATION_CONTROL_ENABLED: 'true',
    AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
    AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
    AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: String(approvalResumeEnabled),
    DATABASE_URL: 'postgresql://db.example.test/automation',
    REDIS_URL: 'redis://redis.example.test:6379',
    AUTOMATION_CONTROL_SHARED_SECRET: 'control-shared-secret-at-least-thirty-two-bytes',
    AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: 'sha256:automation-control-certificate',
    AUTOMATION_CONTROL_WORKER_SHARED_SECRET:
      'dedicated-control-worker-secret-at-least-thirty-two-bytes',
    AUTOMATION_APPROVAL_RESUME_TOKEN_PEPPER:
      'approval-resume-token-pepper-at-least-thirty-two-bytes',
    AUTOMATION_BROWSER_WORKER_TRUST_JSON: JSON.stringify({
      [WORKER_ID]: {
        fingerprints: [WORKER_FINGERPRINT],
        shared_secret: WORKER_SECRET,
      },
    }),
    AUTOMATION_WORKER_TLS_ATTESTATION_SECRET: TLS_SECRET,
    AUTOMATION_BROWSER_WORKER_URL: 'wss://browser-worker.example.test',
    AUTOMATION_CONTROL_MTLS_CERT_PATH: 'C:\\automation-control\\client.pem',
    AUTOMATION_CONTROL_MTLS_KEY_PATH: 'C:\\automation-control\\client-key.pem',
    AUTOMATION_CONTROL_MTLS_CA_PATH: 'C:\\automation-control\\ca.pem',
  });
}

function routeDependencies(
  config: AutomationControlConfig,
  security: ReturnType<typeof createWorkerSecurityRuntime>,
) {
  return {
    config,
    security,
    leaseManager: {
      async isCurrent() {
        return true;
      },
    },
    heartbeatEventSink: {
      async append() {
        throw new Error('unexpected heartbeat append');
      },
    },
    authorityStore: {
      async check() {
        throw new Error('unexpected authority check');
      },
    },
    approvalResumeStore: {
      async consumeAndStart() {
        throw new Error('unexpected approval consume');
      },
    },
    now: () => NOW,
  };
}

function attestedRequest(path: string, body: string): Request {
  const headers = createWorkerTlsAttestationHeaders({
    secret: TLS_SECRET,
    timestamp: NOW,
    method: 'POST',
    path,
    body,
    certificate: {
      authorized: true,
      serviceId: WORKER_ID,
      fingerprint256: WORKER_FINGERPRINT,
      validTo: '2099-07-24T10:00:00.000Z',
    },
  });
  return new Request(`https://control.internal${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

describe('Browser Worker route security composition', () => {
  test('uses one inbound replay domain while keeping the outbound signer dedicated to Control', async () => {
    const config = enabledConfig();
    const redisCalls: Array<{ command: string; args: string[] }> = [];
    const redisReplies: unknown[] = [1, 0, 0];
    const security = createWorkerSecurityRuntime({
      config,
      nextNonce: () => 101,
      now: () => NOW,
      redis: {
        async send(command, args) {
          redisCalls.push({ command, args });
          return redisReplies.shift();
        },
      },
    });
    const event = {
      protocol_version: 'automation.v1' as const,
      event_id: '50000000-0000-4000-a000-000000000001',
      job_id: JOB_ID,
      sequence: 1,
      type: 'heartbeat' as const,
      status: null,
      payload: { last_completed_step: 0 },
      trace_id: null,
      created_at: NOW.toISOString(),
    };
    const routes = createBrowserWorkerRoutes({
      ...routeDependencies(config, security),
      heartbeatEventSink: {
        async append() {
          return { accepted: true as const, event };
        },
      },
    });
    const heartbeat = {
      protocol_version: 'automation.v1' as const,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: `${WORKER_ID}:${LEASE_ID}`,
      kill_switch_generation: 1,
      worker_id: WORKER_ID,
      ordinal: 1,
      observed_at: NOW.toISOString(),
      event: {
        type: 'heartbeat' as const,
        payload: { last_completed_step: 0 },
        trace_id: null,
      },
    };
    const heartbeatProof = security.authenticator.sign({
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      timestamp: NOW,
      nonce: 41,
      body: heartbeat,
    });
    const heartbeatBody = JSON.stringify({
      protocol_version: 'automation.v1',
      proof: heartbeatProof,
      heartbeat,
    });
    const authority = AutomationBrowserAuthorityCheckInputSchema.parse({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: `${WORKER_ID}:${LEASE_ID}`,
      request_hash: `sha256:${'b'.repeat(64)}`,
      kill_switch_generation: 1,
      requested_at: NOW.toISOString(),
      check: {
        kind: 'action',
        step_id: '60000000-0000-4000-a000-000000000001',
        action_hash: `sha256:${'a'.repeat(64)}`,
      },
    });
    const authorityProof = security.authenticator.sign({
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      timestamp: NOW,
      nonce: 41,
      body: authority,
    });
    const authorityBody = JSON.stringify({
      protocol_version: 'automation.v1',
      proof: authorityProof,
      authority,
    });
    const consume = AutomationBrowserApprovalConsumeInputSchema.parse({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      approval_id: '70000000-0000-4000-a000-000000000001',
      attempt_id: '80000000-0000-4000-a000-000000000001',
      step_id: '60000000-0000-4000-a000-000000000001',
      action_hash: `sha256:${'a'.repeat(64)}`,
      lease_id: LEASE_ID,
      lease_owner: `${WORKER_ID}:${LEASE_ID}`,
      kill_switch_generation: 1,
      resume_after_sequence: 0,
      token: `approval-resume.v1.${'A'.repeat(43)}`,
      requested_at: NOW.toISOString(),
    });
    const consumeProof = security.authenticator.sign({
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      timestamp: NOW,
      nonce: 41,
      body: consume,
    });
    const consumeBody = JSON.stringify({
      protocol_version: 'automation.v1',
      proof: consumeProof,
      consume,
    });

    const heartbeatResponse = await routes.fetch(
      attestedRequest(AUTOMATION_BROWSER_HEARTBEAT_PATH, heartbeatBody),
    );
    const authorityReplay = await routes.fetch(
      attestedRequest(AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH, authorityBody),
    );
    const approvalReplay = await routes.fetch(
      attestedRequest(AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH, consumeBody),
    );

    expect(heartbeatResponse.status).toBe(200);
    expect(authorityReplay.status).toBe(409);
    expect(approvalReplay.status).toBe(409);
    expect(redisCalls).toHaveLength(3);
    expect(redisCalls[0]?.command).toBe('EVAL');
    expect(redisCalls[0]?.args[2]).toMatch(/^automation:worker-proof:nonce:v1:[a-f0-9]{64}$/);
    expect(redisCalls[1]?.args[2]).toBe(redisCalls[0]?.args[2]);
    expect(redisCalls[2]?.args[2]).toBe(redisCalls[0]?.args[2]);
    expect(security.signer.sign({ job_id: JOB_ID }, NOW)).toMatchObject({
      service_id: config.serviceId,
      nonce: 101,
    });
    expect(config.browserWorkerPeers[config.serviceId]).toBeUndefined();
  });

  test('mounts no inbound Worker routes when automation control is disabled', async () => {
    const config = enabledConfig();
    const security = createWorkerSecurityRuntime({
      config,
      nextNonce: () => 101,
      redis: {
        async send() {
          return 1;
        },
      },
    });
    const routes = createBrowserWorkerRoutes({
      ...routeDependencies(loadAutomationControlConfig({}), security),
    });

    for (const path of [
      AUTOMATION_BROWSER_HEARTBEAT_PATH,
      AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
      AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
    ]) {
      expect((await routes.request(path, { method: 'POST' })).status).toBe(404);
    }
  });

  test('fails closed when a child route gate is partially activated', () => {
    const config = enabledConfig(false);
    const security = createWorkerSecurityRuntime({
      config,
      nextNonce: () => 101,
      redis: {
        async send() {
          return 1;
        },
      },
    });
    const partialConfig: AutomationControlConfig = {
      ...config,
      browserHeartbeatEnabled: false,
    };

    expect(() => createBrowserWorkerRoutes(routeDependencies(partialConfig, security))).toThrow(
      /feature gates.*inconsistent/i,
    );

    const heartbeatWithoutControl: AutomationControlConfig = {
      ...loadAutomationControlConfig({}),
      browserHeartbeatEnabled: true,
    };
    expect(() =>
      createBrowserWorkerRoutes(routeDependencies(heartbeatWithoutControl, security)),
    ).toThrow(/feature gates.*inconsistent/i);
  });

  test('mounts heartbeat and authority at dispatch level but not approval consume', async () => {
    const config = enabledConfig(false);
    const security = createWorkerSecurityRuntime({
      config,
      nextNonce: () => 101,
      redis: {
        async send() {
          return 1;
        },
      },
    });
    const routes = createBrowserWorkerRoutes(routeDependencies(config, security));

    expect(
      (await routes.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, { method: 'POST' })).status,
    ).not.toBe(404);
    expect(
      (await routes.request(AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH, { method: 'POST' })).status,
    ).not.toBe(404);
    expect(
      (await routes.request(AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH, { method: 'POST' })).status,
    ).toBe(404);
  });

  test('mounts approval consume only when its exact gate is enabled', async () => {
    const config = enabledConfig();
    const security = createWorkerSecurityRuntime({
      config,
      nextNonce: () => 101,
      redis: {
        async send() {
          return 1;
        },
      },
    });
    const routes = createBrowserWorkerRoutes(routeDependencies(config, security));

    expect(
      (await routes.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, { method: 'POST' })).status,
    ).not.toBe(404);
    expect(
      (await routes.request(AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH, { method: 'POST' })).status,
    ).not.toBe(404);
    expect(
      (await routes.request(AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH, { method: 'POST' })).status,
    ).not.toBe(404);
  });
});
