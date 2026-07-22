import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  type AutomationBrowserDispatchEnvelope,
  AutomationBrowserDispatchEnvelopeSchema,
  AutomationJobRequestSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type { ApprovalBinding } from './action-runner';
import { createDispatchApprovalConsumer } from './approval-resume';
import {
  type BrowserApprovalResumeClient,
  BrowserApprovalResumeClientError,
} from './approval-resume-client';

const NOW = new Date('2099-07-23T10:00:00.000Z');
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const CURSOR_STEP_ID = '50000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000002';
const APPROVAL_ID = '60000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '70000000-0000-4000-a000-000000000001';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
const RESUME_TOKEN = `approval-resume.v1.${'A'.repeat(43)}`;

const REQUEST = AutomationJobRequestSchema.parse({
  protocol_version: 'automation.v1',
  tenant_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  source_run_id: null,
  execution_domain: 'browser',
  steps: [
    {
      step_id: '50000000-0000-4000-a000-000000000000',
      sequence: 1,
      action: 'browser.wait',
      args: { milliseconds: 1 },
      risk: 'observe',
      action_hash: `sha256:${'8'.repeat(64)}`,
    },
    {
      step_id: CURSOR_STEP_ID,
      sequence: 2,
      action: 'browser.wait',
      args: { milliseconds: 1 },
      risk: 'observe',
      action_hash: `sha256:${'9'.repeat(64)}`,
    },
    {
      step_id: STEP_ID,
      sequence: 3,
      action: 'browser.payment',
      args: { selector: '#pay' },
      risk: 'external_effect',
      action_hash: ACTION_HASH,
    },
  ],
  capability_requirements: [{ capability: 'browser.page', methods: ['click'], scope: {} }],
  approval_policy: 'project-default',
  browser_policy: {
    allowed_origins: ['https://example.test'],
    network_mode: 'allowlist',
    open_network_expires_at: null,
    context: { mode: 'temporary', profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'approval-resume-adapter-0001',
  deadline_at: '2099-07-23T11:00:00.000Z',
  traceparent: null,
});

const LEASE = {
  lease_id: LEASE_ID,
  job_id: JOB_ID,
  project_id: PROJECT_ID,
  execution_domain: 'browser' as const,
  owner: `browser-worker-1:${LEASE_ID}`,
  permission_id: null,
  request_hash: `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(REQUEST))
    .digest('hex')}` as const,
  kill_switch_generation: 7,
  issued_at: '2099-07-23T09:59:00.000Z',
  expires_at: '2099-07-23T10:30:00.000Z',
  signature: `hmac-sha256:${'b'.repeat(64)}` as const,
};

const RESUME_ENVELOPE = AutomationBrowserDispatchEnvelopeSchema.parse({
  protocol_version: 'automation.v1',
  dispatch_kind: 'browser.approval-resume.v1',
  request: REQUEST,
  lease: LEASE,
  policy_version: 'policy-v1',
  resume_after_sequence: 2,
  dispatched_at: NOW.toISOString(),
  approval_resume: {
    approval_id: APPROVAL_ID,
    attempt_id: ATTEMPT_ID,
    step_id: STEP_ID,
    action_hash: ACTION_HASH,
    token: RESUME_TOKEN,
    expires_at: '2099-07-23T10:20:00.000Z',
  },
});

const STANDARD_ENVELOPE = AutomationBrowserDispatchEnvelopeSchema.parse({
  protocol_version: 'automation.v1',
  request: REQUEST,
  lease: LEASE,
  policy_version: 'policy-v1',
  resume_after_sequence: 2,
  dispatched_at: NOW.toISOString(),
});

const BASE_APPROVAL_BINDING: ApprovalBinding = {
  actionHash: ACTION_HASH,
  jobId: JOB_ID,
  projectId: PROJECT_ID,
  stepId: STEP_ID,
};

function workItem(envelope: AutomationBrowserDispatchEnvelope = RESUME_ENVELOPE) {
  return { envelope, signal: new AbortController().signal };
}

function clientHarness(
  overrides: Partial<{
    approvalId: string;
    attemptId: string;
    jobId: string;
    stepId: string;
  }> = {},
) {
  const inputs: unknown[] = [];
  const client: BrowserApprovalResumeClient = {
    async consume(input) {
      inputs.push(input);
      return {
        consumed: true,
        idempotent: false,
        approvalId: APPROVAL_ID,
        attemptId: ATTEMPT_ID,
        jobId: JOB_ID,
        stepId: STEP_ID,
        startedAt: NOW.toISOString(),
        ...overrides,
      };
    },
  };
  return { client, inputs };
}

describe('dispatch-bound approval consumer', () => {
  test('consumes the signed Resume credential and returns an atomic-start binding', async () => {
    const harness = clientHarness();
    const consumeApproval = createDispatchApprovalConsumer({
      workItem: workItem(),
      client: harness.client,
      now: () => NOW,
    });

    expect(await consumeApproval(BASE_APPROVAL_BINDING)).toEqual({
      ...BASE_APPROVAL_BINDING,
      approvalId: APPROVAL_ID,
      attemptId: ATTEMPT_ID,
      leaseId: LEASE_ID,
      killSwitchGeneration: LEASE.kill_switch_generation,
      resumeAfterSequence: 2,
      stepStartedAtomically: true,
    });
    expect(harness.inputs).toEqual([
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        token: RESUME_TOKEN,
        requested_at: NOW.toISOString(),
      }),
    ]);
  });

  test('returns null without a network call for standard or mismatched dispatch bindings', async () => {
    const cases: Array<{
      envelope: AutomationBrowserDispatchEnvelope;
      binding: ApprovalBinding;
    }> = [
      { envelope: STANDARD_ENVELOPE, binding: BASE_APPROVAL_BINDING },
      {
        envelope: RESUME_ENVELOPE,
        binding: { ...BASE_APPROVAL_BINDING, jobId: '30000000-0000-4000-a000-000000000099' },
      },
      {
        envelope: RESUME_ENVELOPE,
        binding: {
          ...BASE_APPROVAL_BINDING,
          projectId: '20000000-0000-4000-a000-000000000099',
        },
      },
      {
        envelope: RESUME_ENVELOPE,
        binding: { ...BASE_APPROVAL_BINDING, stepId: CURSOR_STEP_ID },
      },
      {
        envelope: RESUME_ENVELOPE,
        binding: { ...BASE_APPROVAL_BINDING, actionHash: `sha256:${'0'.repeat(64)}` },
      },
    ];

    for (const current of cases) {
      const harness = clientHarness();
      const consumeApproval = createDispatchApprovalConsumer({
        workItem: workItem(current.envelope),
        client: harness.client,
        now: () => NOW,
      });
      await expect(consumeApproval(current.binding)).resolves.toBeNull();
      expect(harness.inputs).toHaveLength(0);
    }
  });

  test('rejects every mismatched consume receipt before returning the atomic marker', async () => {
    for (const overrides of [
      { approvalId: '60000000-0000-4000-a000-000000000099' },
      { attemptId: '70000000-0000-4000-a000-000000000099' },
      { jobId: '30000000-0000-4000-a000-000000000099' },
      { stepId: '50000000-0000-4000-a000-000000000099' },
    ]) {
      const harness = clientHarness(overrides);
      const consumeApproval = createDispatchApprovalConsumer({
        workItem: workItem(),
        client: harness.client,
        now: () => NOW,
      });
      await expect(consumeApproval(BASE_APPROVAL_BINDING)).rejects.toBeInstanceOf(
        BrowserApprovalResumeClientError,
      );
    }
  });
});
