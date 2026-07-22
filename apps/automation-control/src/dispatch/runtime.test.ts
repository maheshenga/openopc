import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AutomationJob,
  AutomationJobRequestSchema,
  AutomationJobSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type { AutomationControlConfig } from '../config';
import { materializeAutomationEvent } from '../event-store';
import { createMemoryLeaseManager } from '../lease-manager';
import type { AppendAutomationEventInput, AutomationRepository } from '../repository';
import { transitionAutomationJob } from '../state-machine';
import { createAutomationDesktopDispatchRuntime } from './runtime';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const DEVICE_ID = '70000000-0000-4000-a000-000000000001';
const PERMISSION_ID = '80000000-0000-4000-a000-000000000001';
const NOW = new Date('2099-07-22T08:00:00.000Z');
const SHARED_SECRET = 'test-shared-secret-that-is-at-least-32-bytes';

const CONFIG: AutomationControlConfig = {
  enabled: true,
  desktopCoordinatorEnabled: true,
  browserHeartbeatEnabled: false,
  browserDispatch: { enabled: false },
  port: 4011,
  automationApiUrl: 'https://api.example.test',
  databaseUrl: 'postgresql://automation:password@db.example.test/automation',
  redisUrl: 'redis://redis.example.test:6379',
  serviceId: 'automation-control',
  sharedSecret: SHARED_SECRET,
  browserWorkerPeers: {},
  workerTlsAttestationSecret: '',
  workerProofSkewMs: 60_000,
  workerHeartbeatMaxBodyBytes: 64 * 1024,
  workerHeartbeatBodyReadTimeoutMs: 5_000,
  leaseMs: 30_000,
  coordinatorPollMs: 1_000,
  coordinatorBatchSize: 4,
};

function jobFixture(): AutomationJob {
  const request = AutomationJobRequestSchema.parse({
    protocol_version: 'automation.v1',
    tenant_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'desktop',
    steps: [
      {
        step_id: STEP_ID,
        sequence: 1,
        action: 'desktop.read_screen',
        args: { method: 'desktop.cua.get_screen_size', params: {} },
        risk: 'observe',
        action_hash: `sha256:${'a'.repeat(64)}`,
      },
    ],
    capability_requirements: [
      {
        capability: 'desktop',
        methods: ['read_screen'],
        scope: { device_id: DEVICE_ID, permission_id: PERMISSION_ID },
      },
    ],
    approval_policy: 'project-default',
    browser_policy: null,
    desktop_policy: {
      device_id: DEVICE_ID,
      allowed_applications: ['desktop'],
      full_access_expires_at: null,
      kill_switch_generation: 0,
    },
    idempotency_key: 'runtime-desktop-observe-0001',
    deadline_at: '2099-07-22T08:05:00.000Z',
    traceparent: null,
  });
  const requestHash = `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(request))
    .digest('hex')}`;
  return AutomationJobSchema.parse({
    job_id: JOB_ID,
    account_id: ACCOUNT_ID,
    actor_user_id: USER_ID,
    request,
    request_hash: requestHash,
    status: 'dispatched',
    policy_version: `sha256:${'b'.repeat(64)}`,
    kill_switch_generation: 0,
    created_at: '2099-07-22T07:59:00.000Z',
    updated_at: '2099-07-22T07:59:30.000Z',
    terminal_at: null,
  });
}

function repositoryFixture(job: AutomationJob): AutomationRepository {
  let current = structuredClone(job);
  let sequence = 0;
  return {
    async createJob() {
      throw new Error('not used');
    },
    async getJobForProject(accountId, projectId, jobId) {
      return accountId === ACCOUNT_ID && projectId === PROJECT_ID && jobId === JOB_ID
        ? structuredClone(current)
        : null;
    },
    async listDispatchCandidates() {
      return [structuredClone(current)];
    },
    async appendEvent(input: AppendAutomationEventInput) {
      sequence += 1;
      if (input.transition !== null) {
        const status = transitionAutomationJob(current.status, input.transition);
        current = {
          ...current,
          status,
          updated_at: input.occurredAt.toISOString(),
          terminal_at: status === 'succeeded' ? input.occurredAt.toISOString() : null,
        };
      }
      return materializeAutomationEvent(input, sequence);
    },
    async requestCancellation() {
      throw new Error('not used');
    },
  };
}

describe('automation desktop dispatch runtime', () => {
  test('does not compose the coordinator while its independent rollout flag is disabled', () => {
    const job = jobFixture();
    const runtime = createAutomationDesktopDispatchRuntime({
      config: { ...CONFIG, desktopCoordinatorEnabled: false },
      repository: repositoryFixture(job),
      leaseManager: createMemoryLeaseManager({
        sharedSecret: SHARED_SECRET,
        jobs: [],
      }),
    });

    expect(runtime).toBeNull();
  });

  test('routes the bounded observe step through the signed API Tunnel executor', async () => {
    const job = jobFixture();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const runtime = createAutomationDesktopDispatchRuntime({
      config: CONFIG,
      repository: repositoryFixture(job),
      leaseManager: createMemoryLeaseManager({
        sharedSecret: SHARED_SECRET,
        jobs: [
          {
            jobId: JOB_ID,
            projectId: PROJECT_ID,
            executionDomain: 'desktop',
            requestHash: job.request_hash,
            killSwitchGeneration: 0,
            status: 'queued',
          },
        ],
      }),
      now: () => NOW,
      fetch: (async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ ok: true, result: { width: 1920, height: 1080 } });
      }) as typeof fetch,
    });
    if (runtime === null) throw new Error('expected desktop dispatch runtime');

    const result = await runtime.dispatchDesktopStep({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      owner: CONFIG.serviceId,
    });

    expect(result.result).toEqual({ width: 1920, height: 1080 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.test/internal/automation/desktop/execute');
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      tunnel_id: DEVICE_ID,
      account_id: ACCOUNT_ID,
      method: 'desktop.cua.get_screen_size',
      required_permission_id: PERMISSION_ID,
    });
  });
});
