import { describe, expect, test } from 'bun:test';
import type {
  AutomationLease,
  AutomationStep,
  BrowserPolicy,
} from '@kortix/intelligence-contracts';
import { AUTOMATION_MAX_STEPS } from '@kortix/intelligence-contracts';
import { type BrowserPageAdapter, createBrowserActionRunner } from './action-runner';

const ID = '10000000-0000-4000-a000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;
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
  risk: 'observe',
  action_hash: HASH,
});

function page(): { page: BrowserPageAdapter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    page: {
      goto: async (url) => {
        calls.push(`goto:${url}`);
        return url;
      },
      click: async (selector) => {
        calls.push(`click:${selector}`);
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
  options?: { actionHash?: boolean; generation?: number; signed?: boolean },
) {
  return createBrowserActionRunner({
    page: adapter,
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    isSignedLeaseValid: async () => options?.signed ?? true,
    isLeaseCurrent: async () => true,
    currentKillSwitchGeneration: async () => options?.generation ?? 7,
    isActionHashCurrent: async () => options?.actionHash ?? true,
    isAllowedUrl: async () => true,
  });
}

describe('browser action runner', () => {
  test('executes only structured navigate, click, fill, read, and screenshot actions', async () => {
    const fake = page();
    const events = await runner(fake.page).run({
      lease: lease(),
      policy,
      signal: new AbortController().signal,
      steps: [
        step('navigate', { url: 'https://console.example.test/a' }),
        step('click', { selector: '#run' }),
        step('fill', { selector: '#name', value: 'OpenOPC' }),
        step('read', { selector: '#status' }),
        step('screenshot'),
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
        steps: Array.from({ length: AUTOMATION_MAX_STEPS + 1 }, () => step('screenshot')),
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
      steps: [step('submit')],
    });
    expect(approved.map((event) => event.type)).toEqual(['approval_required']);
    expect(fake.calls).toEqual([]);
    await expect(
      runner(fake.page, { actionHash: false }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('click', { selector: '#run' })],
      }),
    ).rejects.toThrow('action hash');
    await expect(
      runner(fake.page, { generation: 8 }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('click', { selector: '#run' })],
      }),
    ).rejects.toThrow('kill-switch');
    await expect(
      runner(fake.page).run({
        lease: { ...lease(), execution_domain: 'desktop' },
        policy,
        signal: new AbortController().signal,
        steps: [step('click', { selector: '#run' })],
      }),
    ).rejects.toThrow('browser');
  });

  test('rejects an unsigned or invalidly signed lease before it reaches the page', async () => {
    const fake = page();
    await expect(
      runner(fake.page, { signed: false }).run({
        lease: lease(),
        policy,
        signal: new AbortController().signal,
        steps: [step('click', { selector: '#run' })],
      }),
    ).rejects.toThrow('signature');
    expect(fake.calls).toEqual([]);
  });
});
