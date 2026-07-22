import { describe, expect, test } from 'bun:test';
import * as automation from './automation';
import {
  AutomationApprovalSchema,
  AutomationErrorSchema,
  AutomationEventSchema,
  AutomationJobRequestSchema,
  AutomationJobSchema,
  AutomationLeaseSchema,
  AutomationWorkerHeartbeatAcceptedSchema,
  AutomationWorkerHeartbeatSchema,
  AutomationWorkerServiceProofSchema,
  BrowserAutomationStepSchema,
  BrowserPolicySchema,
  DesktopPolicySchema,
  KillSwitchSchema,
  browserAutomationRiskForAction,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from './automation';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const EVENT_ID = '60000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '70000000-0000-4000-a000-000000000001';
const LEASE_ID = '80000000-0000-4000-a000-000000000001';
const DEVICE_ID = '90000000-0000-4000-a000-000000000001';
const AUDIT_EVENT_ID = 'a0000000-0000-4000-a000-000000000001';
const ACTION_HASH = `sha256:${'a'.repeat(64)}`;
const REQUEST_HASH = `sha256:${'b'.repeat(64)}`;
const FUTURE_AT = '2999-01-01T00:00:00.000Z';

function browserRequest() {
  return {
    protocol_version: 'automation.v1',
    tenant_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'browser',
    steps: [
      {
        step_id: STEP_ID,
        sequence: 1,
        action: 'navigate',
        args: { url: 'https://example.test/dashboard' },
        risk: 'observe',
        action_hash: ACTION_HASH,
      },
    ],
    capability_requirements: [
      {
        capability: 'browser.navigation',
        methods: ['navigate'],
        scope: { origins: ['https://example.test'] },
      },
    ],
    approval_policy: 'project-default',
    browser_policy: {
      allowed_origins: ['https://example.test'],
      network_mode: 'allowlist',
      open_network_expires_at: null,
      context: { mode: 'temporary', profile_id: null },
    },
    desktop_policy: null,
    idempotency_key: 'automation-request-00000001',
    deadline_at: FUTURE_AT,
    traceparent: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-01`,
  };
}

describe('OpenOPC automation wire contract', () => {
  test('accepts only canonical namespaced browser actions with server-owned risk and args', () => {
    const canonical = {
      ...browserRequest().steps[0],
      action: 'browser.navigate',
      args: { url: 'https://example.test/dashboard' },
      risk: 'operate',
    };

    expect(BrowserAutomationStepSchema.parse(canonical).action).toBe('browser.navigate');
    expect(
      BrowserAutomationStepSchema.safeParse({ ...canonical, action: 'navigate' }).success,
    ).toBeFalse();
    expect(
      BrowserAutomationStepSchema.safeParse({ ...canonical, risk: 'observe' }).success,
    ).toBeFalse();
    expect(
      BrowserAutomationStepSchema.safeParse({
        ...canonical,
        args: { url: 'https://example.test/dashboard', evaluate: 'alert(1)' },
      }).success,
    ).toBeFalse();
  });

  test('shares strict Browser Worker heartbeat and proof envelopes across services', () => {
    const heartbeat = AutomationWorkerHeartbeatSchema.parse({
      protocol_version: 'automation.v1',
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      lease_owner: `browser-worker-1:${LEASE_ID}`,
      kill_switch_generation: 2,
      worker_id: 'browser-worker-1',
      ordinal: 7,
      observed_at: '2026-07-21T00:00:00.000Z',
      event: {
        type: 'heartbeat',
        payload: { last_completed_step: 3 },
        trace_id: null,
      },
    });
    const proof = AutomationWorkerServiceProofSchema.parse({
      service_id: heartbeat.worker_id,
      timestamp: heartbeat.observed_at,
      nonce: 42,
      signature: `hmac-sha256:${'f'.repeat(64)}`,
    });
    const event = AutomationEventSchema.parse({
      protocol_version: 'automation.v1',
      event_id: EVENT_ID,
      job_id: JOB_ID,
      sequence: 8,
      type: 'heartbeat',
      status: null,
      payload: heartbeat.event.payload,
      trace_id: null,
      created_at: heartbeat.observed_at,
    });

    expect(
      canonicalAutomationWorkerProof({
        timestamp: proof.timestamp,
        serviceId: proof.service_id,
        certificateFingerprint256: 'AA:BB:CC:DD',
        nonce: proof.nonce,
        bodySha256: 'a'.repeat(64),
      }),
    ).toBe(`${proof.timestamp}\n${proof.service_id}\nAA:BB:CC:DD\n42\n${'a'.repeat(64)}`);
    expect(
      AutomationWorkerHeartbeatAcceptedSchema.parse({
        protocol_version: 'automation.v1',
        accepted: true,
        event,
      }).event,
    ).toEqual(event);
    expect(
      AutomationWorkerHeartbeatSchema.safeParse({
        ...heartbeat,
        event: { ...heartbeat.event, payload: { last_completed_step: 3, token: 'forbidden' } },
      }).success,
    ).toBeFalse();
  });

  test('shares a strict Browser Worker dispatch WebSocket contract', () => {
    expect(automation.AUTOMATION_BROWSER_DISPATCH_PATH).toBe(
      '/internal/automation/browser/dispatch',
    );
    const request = AutomationJobRequestSchema.parse({
      ...browserRequest(),
      steps: [
        {
          ...browserRequest().steps[0],
          action: 'browser.read',
          args: { selector: '#result' },
          risk: 'observe',
        },
      ],
    });
    const lease = AutomationLeaseSchema.parse({
      lease_id: LEASE_ID,
      job_id: JOB_ID,
      project_id: PROJECT_ID,
      execution_domain: 'browser',
      owner: `browser-worker-1:${LEASE_ID}`,
      permission_id: null,
      request_hash: REQUEST_HASH,
      kill_switch_generation: 2,
      issued_at: '2026-07-23T00:00:00.000Z',
      expires_at: FUTURE_AT,
      signature: `hmac-sha256:${'d'.repeat(64)}`,
    });
    const envelope = automation.AutomationBrowserDispatchEnvelopeSchema.parse({
      protocol_version: 'automation.v1',
      request,
      lease,
      policy_version: 'policy-v1',
      resume_after_sequence: 0,
      dispatched_at: '2026-07-23T00:00:01.000Z',
    });
    const controlProof = AutomationWorkerServiceProofSchema.parse({
      service_id: 'automation-control',
      timestamp: envelope.dispatched_at,
      nonce: 12,
      signature: `hmac-sha256:${'e'.repeat(64)}`,
    });
    const receipt = automation.AutomationBrowserDispatchReceiptSchema.parse({
      protocol_version: 'automation.v1',
      accepted: true,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      worker_id: 'browser-worker-1',
      dispatch_envelope_hash: REQUEST_HASH,
      dispatch_proof_nonce: controlProof.nonce,
      received_at: '2026-07-23T00:00:02.000Z',
    });
    const accepted = automation.AutomationBrowserDispatchAcceptedSchema.parse({
      protocol_version: 'automation.v1',
      receipt,
      proof: {
        service_id: receipt.worker_id,
        timestamp: receipt.received_at,
        nonce: 13,
        signature: `hmac-sha256:${'f'.repeat(64)}`,
      },
    });

    expect(
      automation.AutomationBrowserDispatchRequestSchema.parse({
        protocol_version: 'automation.v1',
        envelope,
        proof: controlProof,
      }).envelope,
    ).toEqual(envelope);
    expect(accepted.receipt).toEqual(receipt);
    expect(
      automation.AutomationBrowserDispatchAcceptedSchema.safeParse({
        ...accepted,
        worker_url: 'wss://worker.internal',
      }).success,
    ).toBeFalse();
    expect(
      automation.AutomationBrowserDispatchEnvelopeSchema.safeParse({
        ...envelope,
        request: { ...request, project_id: ACCOUNT_ID },
      }).success,
    ).toBeFalse();
  });

  test('parses a versioned Browser approval-resume dispatch envelope', () => {
    const request = AutomationJobRequestSchema.parse({
      ...browserRequest(),
      steps: [
        {
          ...browserRequest().steps[0],
          action: 'browser.submit',
          args: { selector: '#confirm' },
          risk: 'external_effect',
        },
      ],
    });
    const lease = AutomationLeaseSchema.parse({
      lease_id: LEASE_ID,
      job_id: JOB_ID,
      project_id: PROJECT_ID,
      execution_domain: 'browser',
      owner: `automation-control:${LEASE_ID}`,
      permission_id: null,
      request_hash: REQUEST_HASH,
      kill_switch_generation: 2,
      issued_at: '2026-07-23T00:00:00.000Z',
      expires_at: FUTURE_AT,
      signature: `hmac-sha256:${'d'.repeat(64)}`,
    });
    const resumeEnvelope = automation.AutomationBrowserDispatchEnvelopeSchema.parse({
      protocol_version: 'automation.v1',
      dispatch_kind: 'browser.approval-resume.v1',
      request,
      lease,
      policy_version: 'policy-v1',
      resume_after_sequence: 0,
      dispatched_at: '2026-07-23T00:00:01.000Z',
      approval_resume: {
        approval_id: APPROVAL_ID,
        attempt_id: '71000000-0000-4000-a000-000000000001',
        step_id: STEP_ID,
        action_hash: ACTION_HASH,
        token: `approval-resume.v1.${'A'.repeat(43)}`,
        expires_at: '2998-01-01T00:00:00.000Z',
      },
    });

    if (!('dispatch_kind' in resumeEnvelope)) {
      throw new Error('Expected Browser approval-resume envelope');
    }
    expect(automation.AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH).toBe(
      '/internal/automation/browser/approvals/consume',
    );
    expect(resumeEnvelope.dispatch_kind).toBe('browser.approval-resume.v1');
    expect(
      automation.AutomationBrowserDispatchEnvelopeSchema.safeParse({
        ...resumeEnvelope,
        approval_resume: {
          ...resumeEnvelope.approval_resume,
          action_hash: `sha256:${'0'.repeat(64)}`,
        },
      }).success,
    ).toBeFalse();
  });

  test('defines strict Browser approval-resume consumption contracts', () => {
    const attemptId = '71000000-0000-4000-a000-000000000001';
    const proof = AutomationWorkerServiceProofSchema.parse({
      service_id: 'browser-worker-1',
      timestamp: '2026-07-23T00:00:02.000Z',
      nonce: 14,
      signature: `hmac-sha256:${'f'.repeat(64)}`,
    });
    const request = automation.AutomationBrowserApprovalConsumeRequestSchema.parse({
      protocol_version: 'automation.v1',
      proof,
      consume: {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        job_id: JOB_ID,
        approval_id: APPROVAL_ID,
        attempt_id: attemptId,
        step_id: STEP_ID,
        action_hash: ACTION_HASH,
        lease_id: LEASE_ID,
        lease_owner: `automation-control:${LEASE_ID}`,
        kill_switch_generation: 2,
        resume_after_sequence: 0,
        token: `approval-resume.v1.${'A'.repeat(43)}`,
        requested_at: proof.timestamp,
      },
    });
    const accepted = automation.AutomationBrowserApprovalConsumeAcceptedSchema.parse({
      protocol_version: 'automation.v1',
      consumed: true,
      idempotent: false,
      approval_id: APPROVAL_ID,
      attempt_id: attemptId,
      job_id: JOB_ID,
      step_id: STEP_ID,
      started_at: proof.timestamp,
    });

    expect(request.consume.token).toStartWith('approval-resume.v1.');
    expect(accepted).not.toHaveProperty('token');
    expect(
      automation.AutomationBrowserApprovalConsumeRequestSchema.safeParse({
        ...request,
        consume: { ...request.consume, injected: true },
      }).success,
    ).toBeFalse();
  });

  test('negotiates Browser approval-resume capability without breaking legacy receipts', () => {
    const legacyReceipt = {
      protocol_version: 'automation.v1',
      accepted: true,
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      worker_id: 'browser-worker-1',
      dispatch_envelope_hash: REQUEST_HASH,
      dispatch_proof_nonce: 15,
      received_at: '2026-07-23T00:00:02.000Z',
    };

    expect(
      automation.AutomationBrowserDispatchReceiptSchema.parse(legacyReceipt),
    ).not.toHaveProperty('capabilities');
    expect(
      automation.AutomationBrowserDispatchReceiptSchema.parse({
        ...legacyReceipt,
        capabilities: ['browser.approval-resume.v1'],
      }).capabilities,
    ).toEqual(['browser.approval-resume.v1']);
    expect(
      automation.AutomationBrowserDispatchReceiptSchema.safeParse({
        ...legacyReceipt,
        capabilities: ['browser.unversioned'],
      }).success,
    ).toBeFalse();
  });

  test('defines the complete executable browser action catalog', () => {
    const cases = [
      ['browser.navigate', { url: 'https://example.test/dashboard' }, 'operate'],
      ['browser.click', { selector: '#open' }, 'operate'],
      ['browser.click', { x: 12, y: 34 }, 'operate'],
      ['browser.type', { selector: '#name', value: 'OpenOPC' }, 'operate'],
      ['browser.read', { selector: '#result' }, 'observe'],
      ['browser.screenshot', {}, 'observe'],
      ['browser.wait', { milliseconds: 250 }, 'observe'],
      ['browser.submit', { selector: '#submit' }, 'external_effect'],
      ['browser.payment', { selector: '#pay' }, 'external_effect'],
      ['browser.delete', { selector: '#delete' }, 'external_effect'],
      ['browser.send', { selector: '#send' }, 'external_effect'],
    ] as const;

    for (const [action, args, risk] of cases) {
      expect(
        BrowserAutomationStepSchema.safeParse({
          ...browserRequest().steps[0],
          action,
          args,
          risk,
        }).success,
      ).toBeTrue();
    }
  });

  test('derives browser risk from the shared server catalog', () => {
    expect(browserAutomationRiskForAction('browser.read')).toBe('observe');
    expect(browserAutomationRiskForAction('browser.click')).toBe('operate');
    expect(browserAutomationRiskForAction('browser.payment')).toBe('external_effect');
    expect(browserAutomationRiskForAction('navigate')).toBeNull();
  });

  test('canonicalizes request objects identically across control and worker runtimes', () => {
    expect(
      canonicalAutomationRequestJson({ z: 1, nested: { b: true, a: ['x', { d: 4, c: 3 }] } }),
    ).toBe('{"nested":{"a":["x",{"c":3,"d":4}],"b":true},"z":1}');
  });

  test('accepts a bounded browser automation request', () => {
    const parsed = AutomationJobRequestSchema.parse(browserRequest());

    expect(parsed).toMatchObject({
      protocol_version: 'automation.v1',
      tenant_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      execution_domain: 'browser',
    });
    expect(parsed.steps).toHaveLength(1);
  });

  test('accepts an unsampled W3C traceparent and rejects zero trace identifiers', () => {
    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        traceparent: `00-${'c'.repeat(32)}-${'d'.repeat(16)}-00`,
      }).success,
    ).toBeTrue();
    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        traceparent: `00-${'0'.repeat(32)}-${'d'.repeat(16)}-01`,
      }).success,
    ).toBeFalse();
  });

  test('rejects missing project scope and empty steps', () => {
    const missingProject = browserRequest() as Record<string, unknown>;
    delete missingProject.project_id;

    expect(AutomationJobRequestSchema.safeParse(missingProject).success).toBeFalse();
    expect(
      AutomationJobRequestSchema.safeParse({ ...browserRequest(), steps: [] }).success,
    ).toBeFalse();
  });

  test('rejects duplicate step sequences and more than 128 steps', () => {
    const step = browserRequest().steps[0];
    const duplicateSequence = [step, { ...step, step_id: EVENT_ID }];
    const tooManySteps = Array.from({ length: 129 }, (_, index) => ({
      ...step,
      step_id: `${String(index).padStart(8, '0')}-0000-4000-a000-000000000001`,
      sequence: index + 1,
    }));

    expect(
      AutomationJobRequestSchema.safeParse({ ...browserRequest(), steps: duplicateSequence })
        .success,
    ).toBeFalse();
    expect(
      AutomationJobRequestSchema.safeParse({ ...browserRequest(), steps: tooManySteps }).success,
    ).toBeFalse();
  });

  test('rejects expired deadlines, malformed hashes, and non-JSON arguments', () => {
    const step = browserRequest().steps[0];

    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        deadline_at: '2000-01-01T00:00:00.000Z',
      }).success,
    ).toBeFalse();
    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        steps: [{ ...step, action_hash: 'sha256:not-a-hash' }],
      }).success,
    ).toBeFalse();
    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        steps: [{ ...step, args: { value: undefined } }],
      }).success,
    ).toBeFalse();
  });

  test('preserves external-effect risk under full access and rejects bypass fields', () => {
    const step = {
      ...browserRequest().steps[0],
      action: 'submit',
      risk: 'external_effect',
    };
    const parsed = AutomationJobRequestSchema.parse({
      ...browserRequest(),
      approval_policy: 'full-access',
      steps: [step],
    });

    expect(parsed.steps[0]?.risk).toBe('external_effect');
    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        approval_policy: 'full-access',
        steps: [{ ...step, approval_bypass: true }],
      }).success,
    ).toBeFalse();
  });

  test('requires the execution-domain policy and validates privileged policy expiry', () => {
    expect(
      AutomationJobRequestSchema.safeParse({ ...browserRequest(), browser_policy: null }).success,
    ).toBeFalse();
    expect(
      AutomationJobRequestSchema.safeParse({
        ...browserRequest(),
        desktop_policy: {
          device_id: DEVICE_ID,
          allowed_applications: ['com.example.editor'],
          full_access_expires_at: null,
          kill_switch_generation: 0,
        },
      }).success,
    ).toBeFalse();
    expect(
      BrowserPolicySchema.safeParse({
        ...browserRequest().browser_policy,
        network_mode: 'open',
        open_network_expires_at: null,
      }).success,
    ).toBeFalse();
    expect(
      DesktopPolicySchema.safeParse({
        device_id: DEVICE_ID,
        allowed_applications: ['com.example.editor'],
        full_access_expires_at: FUTURE_AT,
        kill_switch_generation: 3,
      }).success,
    ).toBeTrue();
  });

  test('returns a validation failure instead of throwing for a malformed origin', () => {
    const parseMalformedOrigin = () =>
      BrowserPolicySchema.safeParse({
        ...browserRequest().browser_policy,
        allowed_origins: ['not-an-origin'],
      });

    expect(parseMalformedOrigin).not.toThrow();
    expect(parseMalformedOrigin().success).toBeFalse();
  });

  test('parses job, event, approval, lease, kill-switch, and public error envelopes', () => {
    const request = browserRequest();
    const job = AutomationJobSchema.parse({
      job_id: JOB_ID,
      account_id: ACCOUNT_ID,
      actor_user_id: USER_ID,
      request,
      request_hash: REQUEST_HASH,
      status: 'queued',
      policy_version: 'policy-v1',
      kill_switch_generation: 0,
      created_at: '2026-07-21T00:00:00.000Z',
      updated_at: '2026-07-21T00:00:00.000Z',
      terminal_at: null,
    });
    const event = AutomationEventSchema.parse({
      protocol_version: 'automation.v1',
      event_id: EVENT_ID,
      job_id: JOB_ID,
      sequence: 1,
      type: 'job_queued',
      status: 'queued',
      payload: { source: 'api' },
      trace_id: 'c'.repeat(32),
      created_at: '2026-07-21T00:00:00.000Z',
    });
    const approval = AutomationApprovalSchema.parse({
      approval_id: APPROVAL_ID,
      job_id: JOB_ID,
      step_id: STEP_ID,
      project_id: PROJECT_ID,
      action_hash: ACTION_HASH,
      status: 'pending',
      acting_user_id: null,
      expires_at: FUTURE_AT,
      resolved_at: null,
    });
    const lease = AutomationLeaseSchema.parse({
      lease_id: LEASE_ID,
      job_id: JOB_ID,
      project_id: PROJECT_ID,
      execution_domain: 'browser',
      owner: 'browser-worker-01',
      permission_id: null,
      request_hash: REQUEST_HASH,
      kill_switch_generation: 0,
      issued_at: '2026-07-21T00:00:00.000Z',
      expires_at: FUTURE_AT,
      signature: `hmac-sha256:${'e'.repeat(64)}`,
    });
    const killSwitch = KillSwitchSchema.parse({
      protocol_version: 'automation.v1',
      scope: { kind: 'project', account_id: ACCOUNT_ID, project_id: PROJECT_ID },
      generation: 1,
      active: true,
      actor_user_id: USER_ID,
      audit_event_id: AUDIT_EVENT_ID,
      activated_at: '2026-07-21T00:00:00.000Z',
      released_at: null,
    });
    const error = AutomationErrorSchema.parse({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_UNAVAILABLE',
      message: 'automation is disabled',
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    });

    expect(job.status).toBe('queued');
    expect(event.sequence).toBe(1);
    expect(approval.status).toBe('pending');
    expect(lease.owner).toBe('browser-worker-01');
    expect(killSwitch.generation).toBe(1);
    expect(error.code).toBe('AUTOMATION_UNAVAILABLE');
  });

  test('rejects inconsistent approval and lease lifecycles', () => {
    expect(
      AutomationApprovalSchema.safeParse({
        approval_id: APPROVAL_ID,
        job_id: JOB_ID,
        step_id: STEP_ID,
        project_id: PROJECT_ID,
        action_hash: ACTION_HASH,
        status: 'pending',
        acting_user_id: USER_ID,
        expires_at: FUTURE_AT,
        resolved_at: null,
      }).success,
    ).toBeFalse();
    expect(
      AutomationLeaseSchema.safeParse({
        lease_id: LEASE_ID,
        job_id: JOB_ID,
        project_id: PROJECT_ID,
        execution_domain: 'browser',
        owner: 'browser-worker-01',
        permission_id: null,
        request_hash: REQUEST_HASH,
        kill_switch_generation: 0,
        issued_at: FUTURE_AT,
        expires_at: '2026-07-21T00:00:00.000Z',
        signature: `hmac-sha256:${'e'.repeat(64)}`,
      }).success,
    ).toBeFalse();
  });

  test('keeps completed jobs readable after temporary browser authorization expires', () => {
    const archivedRequest = {
      ...browserRequest(),
      browser_policy: {
        ...browserRequest().browser_policy,
        network_mode: 'open',
        open_network_expires_at: '2000-01-02T00:00:00.000Z',
      },
      deadline_at: '2000-01-03T00:00:00.000Z',
    };

    expect(
      AutomationJobSchema.safeParse({
        job_id: JOB_ID,
        account_id: ACCOUNT_ID,
        actor_user_id: USER_ID,
        request: archivedRequest,
        request_hash: REQUEST_HASH,
        status: 'succeeded',
        policy_version: 'policy-v1',
        kill_switch_generation: 0,
        created_at: '2000-01-01T00:00:00.000Z',
        updated_at: '2000-01-03T00:00:00.000Z',
        terminal_at: '2000-01-03T00:00:00.000Z',
      }).success,
    ).toBeTrue();
  });
});
