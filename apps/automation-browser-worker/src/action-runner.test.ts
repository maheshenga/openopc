import { describe, expect, test } from 'bun:test';
import type {
  AutomationLease,
  AutomationStep,
  BrowserPolicy,
} from '@kortix/intelligence-contracts';
import {
  AUTOMATION_MAX_STEPS,
  browserAutomationRiskForAction,
} from '@kortix/intelligence-contracts';
import {
  type BrowserPageAdapter,
  type ConsumedApprovalBinding,
  createBrowserActionRunner,
} from './action-runner';

const ID = '10000000-0000-4000-a000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;
const APPROVAL_ID = '40000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '50000000-0000-4000-a000-000000000001';
const policy: BrowserPolicy = {
  allowed_origins: ['https://console.example.test'],
  network_mode: 'allowlist',
  open_network_expires_at: null,
  context: { mode: 'temporary', profile_id: null },
};
const lease = (): AutomationLease => ({
  lease_id: ID,
  job_id: '20000000-0000-4000-a000-000000000001',
  project_id: '30000000-0000-4000-a000-000000000001',
  execution_domain: 'browser',
  owner: 'browser-worker',
  permission_id: null,
  request_hash: HASH,
  kill_switch_generation: 7,
  issued_at: '2026-07-21T00:00:00.000Z',
  expires_at: '2999-01-01T00:00:00.000Z',
  signature: `hmac-sha256:${'b'.repeat(64)}`,
});
const step = (action: string, args: Record<string, unknown> = {}): AutomationStep => ({
  step_id: ID,
  sequence: 1,
  action,
  args,
  risk: browserAutomationRiskForAction(action) ?? 'observe',
  action_hash: HASH,
});

function page(initialUrl = 'about:blank'): {
  page: BrowserPageAdapter & { currentUrl(): string };
  calls: string[];
} {
  const calls: string[] = [];
  let currentUrl = initialUrl;
  return {
    calls,
    page: {
      currentUrl: () => currentUrl,
      goto: async (url) => {
        currentUrl = url;
        calls.push(`goto:${url}`);
        return url;
      },
      click: async (selector) => {
        calls.push(`click:${selector}`);
      },
      clickPoint: async (x: number, y: number) => {
        calls.push(`click-point:${x.toString()}:${y.toString()}`);
      },
      fill: async (selector, value) => {
        calls.push(`fill:${selector}:${value}`);
      },
      textContent: async (selector) => {
        calls.push(`read:${selector}`);
        return 'visible';
      },
      screenshot: async () => {
        calls.push('screenshot');
        return new Uint8Array();
      },
    },
  };
}

function runner(
  adapter: BrowserPageAdapter,
  options?: {
    actionHash?: boolean;
    approval?: boolean;
    approvalGrant?: Partial<ConsumedApprovalBinding>;
    emitted?: Array<Record<string, unknown>>;
    generation?: number;
    generations?: number[];
    fullAccessGrant?: boolean;
    isAllowedUrl?: (url: string) => boolean;
    signed?: boolean;
    approvalInputs?: Array<Record<string, unknown>>;
  },
) {
  return createBrowserActionRunner({
    page: adapter,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    isSignedLeaseValid: async () => options?.signed ?? true,
    isLeaseCurrent: async () => true,
    currentKillSwitchGeneration: async () =>
      options?.generations?.shift() ?? options?.generation ?? 7,
    isActionHashCurrent: async () => options?.actionHash ?? true,
    isFullAccessGrantCurrent: async () => options?.fullAccessGrant ?? true,
    consumeApproval: async (input) => {
      options?.approvalInputs?.push(input);
      if (!(options?.approval ?? false)) return null;
      return { ...input, ...options?.approvalGrant };
    },
    emitEvent: async (intent) => {
      options?.emitted?.push(intent);
    },
    isAllowedUrl: async (url) => options?.isAllowedUrl?.(url) ?? true,
    writeEvidence: async (_step, contentType, body) =>
      `evidence:${contentType}:${body.byteLength.toString()}`,
  });
}

describe('browser action runner', () => {
  test('requires approval for operate actions under the project-default policy', async () => {
    const fake = page();
    const operateClick = {
      ...step('browser.click', { selector: '#run' }),
      risk: 'operate' as const,
    };

    const events = await runner(fake.page).run({
      approvalPolicy: 'project-default',
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [operateClick],
    } as never);

    expect(events.map((event) => event.type)).toEqual(['approval_required']);
    expect(fake.calls).toEqual([]);
  });

  test('executes operate actions under full access only while the grant is current', async () => {
    const stepInput = {
      ...step('browser.click', { selector: '#run' }),
      risk: 'operate' as const,
    };
    const expired = page();
    const expiredEvents = await runner(expired.page, { fullAccessGrant: false }).run({
      approvalPolicy: 'full-access',
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [stepInput],
    });
    expect(expiredEvents.map((event) => event.type)).toEqual(['approval_required']);
    expect(expired.calls).toEqual([]);

    const current = page();
    await runner(current.page, { fullAccessGrant: true }).run({
      approvalPolicy: 'full-access',
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [stepInput],
    });
    expect(current.calls).toEqual(['click:#run']);
  });

  test('executes a canonical coordinate click through the structured page adapter', async () => {
    const fake = page();

    await runner(fake.page, { fullAccessGrant: true }).run({
      approvalPolicy: 'full-access',
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [step('browser.click', { x: 120, y: 48 })],
    });

    expect(fake.calls).toEqual(['click-point:120:48']);
  });

  test('executes a bounded canonical browser wait', async () => {
    const fake = page();

    const events = await runner(fake.page).run({
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [step('browser.wait', { milliseconds: 1 })],
    });

    expect(events.map((event) => event.type)).toEqual(['step_started', 'step_completed']);
    expect(fake.calls).toEqual([]);
  });

  test('executes an atomically started Resume effect without a duplicate start event', async () => {
    const fake = page();
    const emitted: Array<Record<string, unknown>> = [];
    const approvedStep = {
      ...step('browser.payment', { selector: '#pay' }),
      sequence: 3,
    };
    const currentLease = lease();
    const consumed: ConsumedApprovalBinding = {
      actionHash: approvedStep.action_hash,
      jobId: currentLease.job_id,
      projectId: currentLease.project_id,
      stepId: approvedStep.step_id,
      approvalId: APPROVAL_ID,
      attemptId: ATTEMPT_ID,
      leaseId: currentLease.lease_id,
      killSwitchGeneration: currentLease.kill_switch_generation,
      resumeAfterSequence: 2,
      stepStartedAtomically: true,
    };

    const events = await runner(fake.page, {
      approval: true,
      approvalGrant: consumed,
      emitted,
    }).run({
      lease: currentLease,
      policy,
      signal: new AbortController().signal,
      steps: [approvedStep],
    });

    expect(fake.calls).toEqual(['click:#pay']);
    expect(events.map((event) => event.type)).toEqual(['step_completed']);
    expect(emitted.map((event) => event.type)).toEqual(['step_completed']);
  });

  test('rejects invalid atomic-start bindings before an external effect', async () => {
    const approvedStep = {
      ...step('browser.payment', { selector: '#pay' }),
      sequence: 3,
    };
    const currentLease = lease();
    const valid: ConsumedApprovalBinding = {
      actionHash: approvedStep.action_hash,
      jobId: currentLease.job_id,
      projectId: currentLease.project_id,
      stepId: approvedStep.step_id,
      approvalId: APPROVAL_ID,
      attemptId: ATTEMPT_ID,
      leaseId: currentLease.lease_id,
      killSwitchGeneration: currentLease.kill_switch_generation,
      resumeAfterSequence: 2,
      stepStartedAtomically: true,
    };
    const cases: Array<Partial<ConsumedApprovalBinding>> = [
      { approvalId: '' },
      { attemptId: '' },
      { leaseId: '90000000-0000-4000-a000-000000000001' },
      { killSwitchGeneration: currentLease.kill_switch_generation + 1 },
      { resumeAfterSequence: approvedStep.sequence },
      { stepId: '90000000-0000-4000-a000-000000000002' },
      { actionHash: `sha256:${'9'.repeat(64)}` },
    ];

    for (const override of cases) {
      const fake = page();
      const events = await runner(fake.page, {
        approval: true,
        approvalGrant: { ...valid, ...override },
      }).run({
        lease: currentLease,
        policy,
        signal: new AbortController().signal,
        steps: [approvedStep],
      });
      expect(events.map((event) => event.type)).toEqual(['approval_required']);
      expect(fake.calls).toEqual([]);
    }
  });

  test('rejects malformed action arguments before attempting to consume approval', async () => {
    const fake = page();
    const approvalInputs: Array<Record<string, unknown>> = [];

    await expect(
      runner(fake.page, { approvalInputs }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [
          {
            ...step('browser.submit'),
            risk: 'external_effect',
          },
        ],
      }),
    ).rejects.toThrow();
    expect(approvalInputs).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  test('rechecks kill generation after approval consumption and before the effect', async () => {
    const fake = page();

    await expect(
      runner(fake.page, { approval: true, generations: [7, 8] }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [
          {
            ...step('browser.submit', { selector: '#submit' }),
            risk: 'external_effect',
          },
        ],
      }),
    ).rejects.toThrow('kill-switch');
    expect(fake.calls).toEqual([]);
  });

  test('executes only canonical structured navigate, click, fill, read, and screenshot actions', async () => {
    const fake = page();
    const events = await runner(fake.page).run({
      approvalPolicy: 'full-access',
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [
        step('browser.navigate', { url: 'https://console.example.test/a' }),
        step('browser.click', { selector: '#run' }),
        step('browser.type', { selector: '#name', value: 'OpenOPC' }),
        step('browser.read', { selector: '#status' }),
        step('browser.screenshot'),
      ],
    });
    expect(fake.calls).toEqual([
      'goto:https://console.example.test/a',
      'click:#run',
      'fill:#name:OpenOPC',
      'read:#status',
      'screenshot',
    ]);
    expect(events.filter((event) => event.type === 'step_completed')).toHaveLength(5);
    expect(events.map((event) => (event as { ordinal?: number }).ordinal)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(events.every((event) => !('event_id' in event))).toBeTrue();
    expect(events.every((event) => !('sequence' in event))).toBeTrue();
    expect(events.every((event) => !('status' in event))).toBeTrue();
    expect(events.at(-1)?.payload).toEqual({
      evidence_reference: 'evidence:image/png:0',
      step_id: ID,
    });
  });

  test('rejects legacy unnamespaced actions before risk or page access', async () => {
    const fake = page();

    await expect(
      runner(fake.page).run({
        approvalPolicy: 'full-access',
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('click', { selector: '#run' })],
      }),
    ).rejects.toThrow('unsupported browser action');
    expect(fake.calls).toEqual([]);
  });

  test('rejects a canonical action whose supplied risk does not match the server catalog', async () => {
    const fake = page();

    await expect(
      runner(fake.page).run({
        approvalPolicy: 'full-access',
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [{ ...step('browser.click', { selector: '#run' }), risk: 'observe' }],
      }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  test('rechecks the current page origin before every non-navigation action', async () => {
    const fake = page('https://unexpected.example.test/account');

    await expect(
      runner(fake.page, {
        fullAccessGrant: true,
        isAllowedUrl: (url) => url.startsWith('https://console.example.test/'),
      }).run({
        approvalPolicy: 'full-access',
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('browser.click', { selector: '#run' })],
      }),
    ).rejects.toThrow('current page origin');
    expect(fake.calls).toEqual([]);
  });

  test('rejects script-like, unknown, overflowing, and download actions before they reach the page', async () => {
    const fake = page();
    for (const action of ['evaluate', 'addScriptTag', 'download', 'unknown']) {
      await expect(
        runner(fake.page).run({
          lease: lease(),
          policy,
          signal: new AbortController().signal,
          steps: [step(action)],
        }),
      ).rejects.toThrow();
    }
    await expect(
      runner(fake.page).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: Array.from({ length: AUTOMATION_MAX_STEPS + 1 }, () => step('browser.screenshot')),
      }),
    ).rejects.toThrow();
    expect(fake.calls).toEqual([]);
  });

  test('pauses destructive actions for approval and re-checks domain, lease, kill-switch, origin, and action hash', async () => {
    const fake = page();
    const approved = await runner(fake.page).run({
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [step('browser.submit', { selector: '#submit' })],
    });
    expect(approved.map((event) => event.type)).toEqual(['approval_required']);
    expect(fake.calls).toEqual([]);
    await expect(
      runner(fake.page, { actionHash: false }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('browser.click', { selector: '#run' })],
      }),
    ).rejects.toThrow('action hash');
    await expect(
      runner(fake.page, { generation: 8 }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('browser.click', { selector: '#run' })],
      }),
    ).rejects.toThrow('kill-switch');
    await expect(
      runner(fake.page).run({
        lease: { ...lease(), execution_domain: 'desktop' },
        policy,
        signal: new AbortController().signal,
        steps: [step('browser.click', { selector: '#run' })],
      }),
    ).rejects.toThrow('browser');
  });

  test('binds every external-effect approval to project, step, and action hash', async () => {
    const fake = page();
    const approvalInputs: Array<Record<string, unknown>> = [];
    const externalClick = {
      ...step('browser.payment', { selector: '#pay' }),
    };

    const paused = await runner(fake.page, { approvalInputs }).run({
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [externalClick],
    });
    expect(paused.map((item) => item.type)).toEqual(['approval_required']);
    expect(fake.calls).toEqual([]);
    expect(approvalInputs).toEqual([
      { actionHash: HASH, jobId: lease().job_id, projectId: lease().project_id, stepId: ID },
    ]);

    const resumed = await runner(fake.page, { approval: true }).run({
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [externalClick],
    });
    expect(resumed.map((item) => item.type)).toEqual(['step_started', 'step_completed']);
    expect(fake.calls).toEqual(['click:#pay']);

    const wrongProject = page();
    const stillPaused = await runner(wrongProject.page, {
      approval: true,
      approvalGrant: { projectId: '90000000-0000-4000-a000-000000000001' },
    }).run({
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [externalClick],
    });
    expect(stillPaused.map((item) => item.type)).toEqual(['approval_required']);
    expect(wrongProject.calls).toEqual([]);
  });

  test('pauses submit, delete, and send until their bound approval is consumed', async () => {
    for (const action of ['browser.submit', 'browser.delete', 'browser.send']) {
      const fake = page();
      const selector = `#${action.slice('browser.'.length)}`;
      const destructive = step(action, { selector });
      const paused = await runner(fake.page).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [destructive],
      });
      expect(paused.map((item) => item.type)).toEqual(['approval_required']);
      expect(fake.calls).toEqual([]);

      await runner(fake.page, { approval: true }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [destructive],
      });
      expect(fake.calls).toEqual([`click:${selector}`]);
    }
  });

  test('rejects an unsigned or invalidly signed lease before it reaches the page', async () => {
    const fake = page();
    await expect(
      runner(fake.page, { signed: false }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('browser.click', { selector: '#run' })],
      }),
    ).rejects.toThrow('signature');
    expect(fake.calls).toEqual([]);
  });
});
