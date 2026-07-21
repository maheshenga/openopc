import { describe, expect, test } from 'bun:test';
import type { AutomationJobRequest, AutomationStep } from '@kortix/intelligence-contracts';
import type { AutomationActor } from '../repository';
import { evaluateAutomationPolicy } from './evaluate';
import type { PolicyInput } from './types';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000099';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-22T02:00:00.000Z');

const MEMBER: AutomationActor = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  userId: USER_ID,
  roles: ['member'],
  deviceId: null,
};

const ADMIN: AutomationActor = {
  ...MEMBER,
  roles: ['project_admin'],
};

const STEP: AutomationStep = {
  step_id: '40000000-0000-4000-a000-000000000001',
  sequence: 1,
  action: 'browser.read',
  args: {},
  risk: 'observe',
  action_hash: `sha256:${'a'.repeat(64)}`,
};

const JOB: AutomationJobRequest = {
  protocol_version: 'automation.v1',
  tenant_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  source_run_id: null,
  execution_domain: 'browser',
  steps: [STEP],
  capability_requirements: [{ capability: 'browser.page', methods: ['read'], scope: {} }],
  approval_policy: 'project-default',
  browser_policy: {
    allowed_origins: ['https://app.example.com'],
    network_mode: 'allowlist',
    open_network_expires_at: null,
    context: { mode: 'temporary', profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'automation-policy-test-0001',
  deadline_at: '2030-07-22T03:00:00.000Z',
  traceparent: null,
};
const BROWSER_POLICY = JOB.browser_policy;
if (!BROWSER_POLICY) throw new Error('Expected browser policy fixture');

function policyInput(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    actor: MEMBER,
    job: JOB,
    step: STEP,
    policy: {
      version: 'policy-7',
      allowedOrigins: ['https://app.example.com'],
      openNetworkAllowed: false,
      persistentProfilesAllowed: false,
      fullAccessAllowed: false,
    },
    target: {
      origin: 'https://app.example.com/dashboard/items?id=1',
      resolvedAddresses: ['93.184.216.34'],
      deviceId: null,
      applicationId: null,
      profileProjectId: null,
    },
    now: NOW,
    ...overrides,
  };
}

describe('automation policy evaluation', () => {
  test('allows an exact configured origin with a normal subpath', () => {
    expect(evaluateAutomationPolicy(policyInput())).toEqual({
      allowed: true,
      policyVersion: 'policy-7',
      risk: 'observe',
      approvalRequired: false,
    });
  });

  test('rejects a lookalike origin instead of using string-prefix matching', () => {
    const decision = evaluateAutomationPolicy(
      policyInput({
        target: {
          ...policyInput().target,
          origin: 'https://app.example.com.attacker.test/path',
        },
      }),
    );

    expect(decision).toMatchObject({ allowed: false, code: 'ORIGIN_DENIED' });
  });

  test('rejects private targets and DNS answers that rebind to a private address', () => {
    const directPrivate = evaluateAutomationPolicy(
      policyInput({
        policy: { ...policyInput().policy, allowedOrigins: ['http://127.0.0.1'] },
        target: {
          ...policyInput().target,
          origin: 'http://127.0.0.1/admin',
          resolvedAddresses: ['127.0.0.1'],
        },
      }),
    );
    const rebound = evaluateAutomationPolicy(
      policyInput({
        target: {
          ...policyInput().target,
          resolvedAddresses: ['93.184.216.34', '10.0.0.8'],
        },
      }),
    );

    expect(directPrivate).toMatchObject({ allowed: false, code: 'ORIGIN_DENIED' });
    expect(rebound).toMatchObject({ allowed: false, code: 'ORIGIN_DENIED' });
  });

  test('rejects a persistent browser profile owned by another project', () => {
    const decision = evaluateAutomationPolicy(
      policyInput({
        job: {
          ...JOB,
          browser_policy: {
            ...BROWSER_POLICY,
            context: {
              mode: 'persistent',
              profile_id: '50000000-0000-4000-a000-000000000001',
            },
          },
        },
        policy: { ...policyInput().policy, persistentProfilesAllowed: true },
        target: { ...policyInput().target, profileProjectId: OTHER_PROJECT_ID },
      }),
    );

    expect(decision).toMatchObject({ allowed: false, code: 'SCOPE_DENIED' });
  });

  test('allows temporary open networking only for an administrator before expiry', () => {
    const openJob: AutomationJobRequest = {
      ...JOB,
      browser_policy: {
        ...BROWSER_POLICY,
        network_mode: 'open',
        open_network_expires_at: '2026-07-22T02:05:00.000Z',
      },
    };
    const openBrowserPolicy = openJob.browser_policy;
    if (!openBrowserPolicy) throw new Error('Expected open browser policy fixture');
    const policy = { ...policyInput().policy, openNetworkAllowed: true };

    expect(
      evaluateAutomationPolicy(policyInput({ actor: MEMBER, job: openJob, policy })),
    ).toMatchObject({ allowed: false, code: 'ROLE_DENIED' });
    expect(
      evaluateAutomationPolicy(policyInput({ actor: ADMIN, job: openJob, policy })),
    ).toMatchObject({ allowed: true });
    expect(
      evaluateAutomationPolicy(
        policyInput({
          actor: ADMIN,
          job: {
            ...openJob,
            browser_policy: {
              ...openBrowserPolicy,
              open_network_expires_at: '2026-07-22T01:59:59.000Z',
            },
          },
          policy,
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'FEATURE_DISABLED' });
  });

  test('denies full access to members and still requires approval for external effects', () => {
    const externalStep: AutomationStep = {
      ...STEP,
      action: 'browser.submit',
      // The client claim is deliberately wrong; the server catalog must win.
      risk: 'observe',
    };
    const fullAccessJob = { ...JOB, approval_policy: 'full-access' as const };
    const policy = { ...policyInput().policy, fullAccessAllowed: true };

    expect(
      evaluateAutomationPolicy(
        policyInput({ actor: MEMBER, job: fullAccessJob, step: externalStep, policy }),
      ),
    ).toMatchObject({ allowed: false, code: 'ROLE_DENIED' });
    expect(
      evaluateAutomationPolicy(
        policyInput({ actor: ADMIN, job: fullAccessJob, step: externalStep, policy }),
      ),
    ).toEqual({
      allowed: true,
      policyVersion: 'policy-7',
      risk: 'external_effect',
      approvalRequired: true,
    });
  });

  test('denies actions that are absent from the server action catalog', () => {
    const decision = evaluateAutomationPolicy(
      policyInput({ step: { ...STEP, action: 'browser.unknown-experimental-action' } }),
    );

    expect(decision).toMatchObject({ allowed: false, code: 'FEATURE_DISABLED' });
  });
});
