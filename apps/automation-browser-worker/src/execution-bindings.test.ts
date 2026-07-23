import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  AutomationBrowserDispatchEnvelopeSchema,
  AutomationJobRequestSchema,
  type AutomationWorkerHeartbeat,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type { BrowserApprovalResumeClient } from './approval-resume-client';
import type { BrowserAuthorityClient } from './authority-client';
import type { EvidenceStore } from './evidence-writer';
import {
  type BrowserExecutionBindingInput,
  createBrowserExecutionBindings,
  executeBrowserDispatchWorkItem,
} from './execution-bindings';
import type { BrowserWorkerAuthenticatedEventEmitter } from './heartbeat-client';

const NOW = '2099-07-23T10:00:00.000Z';
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';

function workItem(input: { action?: 'browser.wait' | 'browser.payment'; resume?: boolean } = {}) {
  const action = input.action ?? 'browser.wait';
  const request = AutomationJobRequestSchema.parse({
    protocol_version: 'automation.v1',
    tenant_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'browser',
    steps: [
      {
        step_id: STEP_ID,
        sequence: 1,
        action,
        args: action === 'browser.wait' ? { milliseconds: 1 } : { selector: '#pay' },
        risk: action === 'browser.wait' ? 'observe' : 'external_effect',
        action_hash: `sha256:${'a'.repeat(64)}`,
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
    idempotency_key: `execution-bindings-${action}`,
    deadline_at: '2099-07-23T11:00:00.000Z',
    traceparent: null,
  });
  const lease = {
    lease_id: LEASE_ID,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    execution_domain: 'browser' as const,
    owner: `browser-worker:${LEASE_ID}`,
    permission_id: null,
    request_hash: `sha256:${createHash('sha256')
      .update(canonicalAutomationRequestJson(request))
      .digest('hex')}`,
    kill_switch_generation: 7,
    issued_at: '2099-07-23T09:00:00.000Z',
    expires_at: '2099-07-23T11:00:00.000Z',
    signature: `hmac-sha256:${'b'.repeat(64)}`,
  };
  return {
    envelope: AutomationBrowserDispatchEnvelopeSchema.parse({
      protocol_version: 'automation.v1',
      ...(input.resume
        ? {
            dispatch_kind: 'browser.approval-resume.v1',
            approval_resume: {
              approval_id: '60000000-0000-4000-a000-000000000001',
              attempt_id: '70000000-0000-4000-a000-000000000001',
              step_id: STEP_ID,
              action_hash: `sha256:${'a'.repeat(64)}`,
              token: `approval-resume.v1.${'A'.repeat(43)}`,
              expires_at: '2099-07-23T10:20:00.000Z',
            },
          }
        : {}),
      request,
      lease,
      policy_version: 'policy-v1',
      resume_after_sequence: 0,
      dispatched_at: NOW,
    }),
    signal: new AbortController().signal,
  };
}

function authority(reject = false): BrowserAuthorityClient {
  return {
    async check(input) {
      if (reject) throw new Error('authority rejected');
      return {
        protocol_version: 'automation.v1',
        authorized: true,
        check: input.check.kind,
        job_id: input.job_id,
        lease_id: input.lease_id,
        kill_switch_generation: input.kill_switch_generation,
        full_access_grant_current: false,
        checked_at: NOW,
      };
    },
  };
}

function approvalClient(calls: unknown[]): BrowserApprovalResumeClient {
  return {
    async consume(input) {
      calls.push(input);
      return {
        consumed: true,
        idempotent: false,
        approvalId: input.approval_id,
        attemptId: input.attempt_id,
        jobId: input.job_id,
        stepId: input.step_id,
        startedAt: NOW,
      };
    },
  };
}

const evidenceStore: EvidenceStore = { async put() {} };

function eventEmitter(
  events: AutomationWorkerHeartbeat['event'][],
): BrowserWorkerAuthenticatedEventEmitter {
  return {
    intervalMs: 60_000,
    async emit(input) {
      events.push(input.event);
      return {
        protocol_version: 'automation.v1',
        event_id: '80000000-0000-4000-a000-000000000001',
        job_id: input.lease.job_id,
        sequence: events.length,
        type: input.event.type,
        status: input.event.type === 'approval_required' ? 'awaiting_approval' : null,
        payload: input.event.payload,
        trace_id: input.event.trace_id,
        created_at: NOW,
      };
    },
    async send(input) {
      return this.emit({
        lease: input.lease,
        request: input.request,
        signal: input.signal,
        event: {
          type: 'heartbeat',
          payload: { last_completed_step: input.lastCompletedStep },
          trace_id: null,
        },
      });
    },
  };
}

function browserRuntime(): Pick<BrowserExecutionBindingInput, 'launchBrowser' | 'startProxy'> {
  const page = {
    on() {},
    close: async () => {},
    url: () => 'about:blank',
    goto: async (url: string) => ({ url: () => url }),
    click: async () => {},
    fill: async () => {},
    textContent: async () => null,
    screenshot: async () => new Uint8Array(),
    mouse: { click: async () => {} },
  };
  return {
    launchBrowser: (async () => ({
      newContext: async () => ({
        newPage: async () => page,
        close: async () => {},
        on() {},
        route: async () => {},
      }),
      close: async () => {},
    })) as unknown as BrowserExecutionBindingInput['launchBrowser'],
    startProxy: (async () => ({
      serverUrl: 'http://127.0.0.1:9',
      close: async () => {},
    })) as BrowserExecutionBindingInput['startProxy'],
  };
}

function inputFor(item = workItem(), rejectAuthority = false) {
  const events: AutomationWorkerHeartbeat['event'][] = [];
  const consumes: unknown[] = [];
  return {
    events,
    consumes,
    input: {
      workItem: item,
      authority: authority(rejectAuthority),
      approvalClient: approvalClient(consumes),
      evidenceStore,
      eventEmitter: eventEmitter(events),
      isolation: { attest: async () => true },
      ...browserRuntime(),
    },
  };
}

describe('browser execution bindings', () => {
  test('rejects authority before launching Playwright or creating an external effect', async () => {
    const fixture = inputFor(workItem(), true);
    let launches = 0;
    await expect(
      executeBrowserDispatchWorkItem({
        ...fixture.input,
        launchBrowser: (async () => {
          launches += 1;
          throw new Error('must not launch');
        }) as BrowserExecutionBindingInput['launchBrowser'],
      }),
    ).rejects.toThrow(/authority/i);
    expect(launches).toBe(0);
  });

  test('binds Resume consumption to its dispatch envelope', async () => {
    const fixture = inputFor(workItem({ action: 'browser.payment', resume: true }));
    const bindings = createBrowserExecutionBindings(fixture.input);
    const consumed = await bindings.consumeApproval({
      actionHash: `sha256:${'a'.repeat(64)}`,
      jobId: JOB_ID,
      projectId: PROJECT_ID,
      stepId: STEP_ID,
    });
    expect(consumed).not.toBeNull();
    expect(fixture.consumes).toHaveLength(1);
  });

  test('pauses on approval_required without terminal success', async () => {
    const fixture = inputFor(workItem({ action: 'browser.payment' }));
    const paused = await executeBrowserDispatchWorkItem(fixture.input);
    expect(paused.terminal).toBe('awaiting_approval');
    expect(fixture.events.map((event) => event.type)).toContain('approval_required');
    expect(fixture.events.map((event) => event.type)).not.toContain('job_succeeded');
  });

  test('emits one terminal success after normal completion', async () => {
    const fixture = inputFor();
    const completed = await executeBrowserDispatchWorkItem(fixture.input);
    expect(completed.terminal).toBe('succeeded');
    expect(fixture.events.filter((event) => event.type === 'job_succeeded')).toHaveLength(1);
  });
});
