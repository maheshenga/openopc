import { describe, expect, test } from 'bun:test';
import type {
  AutomationEvent,
  AutomationLease,
  AutomationStep,
  BrowserPolicy,
} from '@kortix/intelligence-contracts';
import type { Browser, Download, LaunchOptions } from 'playwright';
import {
  type AuthenticatedRequestSource,
  runBrowserWorkerLoop,
  runIsolatedBrowserRequest,
  startFailClosedWorkerServer,
} from './worker';

const ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '30000000-0000-4000-a000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;
const lease: AutomationLease = {
  lease_id: ID,
  job_id: '20000000-0000-4000-a000-000000000001',
  project_id: PROJECT_ID,
  execution_domain: 'browser',
  owner: 'browser-worker',
  permission_id: null,
  request_hash: HASH,
  kill_switch_generation: 1,
  issued_at: '2026-07-21T00:00:00.000Z',
  expires_at: '2999-01-01T00:00:00.000Z',
  signature: `hmac-sha256:${'b'.repeat(64)}`,
};
const policy: BrowserPolicy = {
  allowed_origins: ['https://console.example.test'],
  network_mode: 'allowlist',
  open_network_expires_at: null,
  context: { mode: 'temporary', profile_id: null },
};
const step = (action: string, args: Record<string, unknown> = {}): AutomationStep => ({
  step_id: ID,
  sequence: 1,
  action,
  args,
  risk: 'observe',
  action_hash: HASH,
});

function runtime(options?: { downloads?: number; hangingClick?: boolean }) {
  const closed: string[] = [];
  const contextOptions: unknown[] = [];
  let downloadHandler: ((download: Download) => void) | undefined;
  const page = {
    close: async () => {
      closed.push('page');
    },
    goto: async (url: string) => ({ url: () => url }),
    click: async () => {
      for (let index = 0; index < (options?.downloads ?? 0); index += 1) {
        downloadHandler?.({ cancel: async () => undefined } as Download);
      }
      if (options?.hangingClick) await new Promise(() => undefined);
    },
    fill: async () => undefined,
    textContent: async () => 'visible',
    screenshot: async () => Buffer.from('png'),
    on: (event: string, handler: (download: Download) => void) => {
      if (event === 'download') downloadHandler = handler;
    },
  };
  const context = {
    newPage: async () => page,
    close: async () => {
      closed.push('context');
    },
  };
  const browser = {
    newContext: async (input?: unknown) => {
      contextOptions.push(input);
      return context;
    },
    close: async () => {
      closed.push('browser');
    },
  } as unknown as Browser;
  const launchOptions: LaunchOptions[] = [];
  return {
    browser,
    closed,
    contextOptions,
    launchOptions,
    launchBrowser: async (launch: LaunchOptions) => {
      launchOptions.push(launch);
      return browser;
    },
  };
}

function dependencies(fake: ReturnType<typeof runtime>, overrides?: { signal?: AbortSignal }) {
  const audit: AutomationEvent[] = [];
  const evidence: string[] = [];
  return {
    audit,
    evidence,
    input: {
      auditSink: {
        write: async (event: AutomationEvent) => {
          audit.push(event);
        },
      },
      consumeApproval: async () => null,
      currentKillSwitchGeneration: async () => 1,
      evidenceStore: {
        put: async ({ reference }: { reference: string }) => {
          evidence.push(reference);
        },
      },
      isActionHashCurrent: async () => true,
      isLeaseCurrent: async () => true,
      isSignedLeaseValid: async () => true,
      launchBrowser: fake.launchBrowser,
      lease,
      policy,
      signal: overrides?.signal ?? new AbortController().signal,
      startProxy: async () => ({
        close: async () => {
          fake.closed.push('proxy');
        },
        serverUrl: 'http://127.0.0.1:12345',
      }),
      steps: [step('screenshot')],
    },
  };
}

describe('isolated browser worker', () => {
  test('rejects malformed wire input before starting a proxy or browser', async () => {
    const fake = runtime();
    let proxyStarts = 0;
    const fixture = dependencies(fake);
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        lease: { ...lease, lease_id: 'not-a-uuid' },
        startProxy: async () => {
          proxyStarts += 1;
          throw new Error('must not start');
        },
      } as never),
    ).rejects.toThrow();
    expect(proxyStarts).toBe(0);
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('rejects an invalid lease signature before starting a proxy or browser', async () => {
    const fake = runtime();
    let proxyStarts = 0;
    const fixture = dependencies(fake);
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        isSignedLeaseValid: async () => false,
        startProxy: async () => {
          proxyStarts += 1;
          throw new Error('must not start');
        },
      }),
    ).rejects.toThrow('signature');
    expect(proxyStarts).toBe(0);
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('launches through the pinned proxy and returns an opaque screenshot evidence reference', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const events = await runIsolatedBrowserRequest(fixture.input);

    expect(fake.launchOptions[0]?.proxy).toEqual({ server: 'http://127.0.0.1:12345' });
    expect(fixture.evidence).toHaveLength(1);
    expect(events.at(-1)?.payload.evidence_reference).toMatch(/^evidence:/);
    expect(fake.closed).toContain('proxy');
  });

  test('cancels downloads and rejects a request that exceeds the count budget', async () => {
    const fake = runtime({ downloads: 5 });
    const fixture = dependencies(fake);
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        steps: [step('click', { selector: '#export' })],
      }),
    ).rejects.toThrow('download count');
  });

  test('records kill-switch audit and stops a hanging action', async () => {
    const fake = runtime({ hangingClick: true });
    const controller = new AbortController();
    const fixture = dependencies(fake, { signal: controller.signal });
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      steps: [step('click', { selector: '#run' })],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('kill-switch');

    await expect(running).rejects.toThrow('kill-switch');
    expect(fixture.audit.map((event) => event.type)).toContain('kill_switch_activated');
    expect(fake.closed).toContain('browser');
  });

  test('does not allocate browser resources for an already-stopped request', async () => {
    const fake = runtime();
    const controller = new AbortController();
    controller.abort('kill-switch');
    const fixture = dependencies(fake, { signal: controller.signal });
    let proxyStarts = 0;
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        startProxy: async () => {
          proxyStarts += 1;
          throw new Error('must not start');
        },
      }),
    ).rejects.toThrow('kill-switch');
    expect(proxyStarts).toBe(0);
    expect(fixture.audit.map((event) => event.type)).toContain('kill_switch_activated');
  });

  test('enforces the configured runtime ceiling against a hanging action', async () => {
    const fake = runtime({ hangingClick: true });
    const fixture = dependencies(fake);
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        maxRuntimeMs: 5,
        steps: [step('click', { selector: '#run' })],
      }),
    ).rejects.toThrow('runtime-timeout');
    expect(fake.closed).toContain('browser');
  });

  test('binds a persistent context to the lease project and policy profile grant', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const profileId = '40000000-0000-4000-a000-000000000001';
    await runIsolatedBrowserRequest({
      ...fixture.input,
      persistentProfile: {
        brokerCredential: 'one-time-token',
        encryptedObjectRef: `projects/${PROJECT_ID}/browser-profiles/profile.enc`,
        profileId,
        projectId: PROJECT_ID,
      },
      policy: { ...policy, context: { mode: 'persistent', profile_id: profileId } },
      profileBroker: {
        fetchEncryptedProfile: async () => ({ storageState: { cookies: [] } }),
      },
    });

    expect(fake.contextOptions).toContainEqual({ storageState: { cookies: [] } });
  });
});

test('worker loop consumes only authenticated requests', async () => {
  const rejected: number[] = [];
  const acknowledged: number[] = [];
  const executed: number[] = [];
  const queue = [
    { authenticated: false, request: 1 },
    { authenticated: true, request: 2 },
  ];
  const source: AuthenticatedRequestSource<number> = {
    next: async () => queue.shift() ?? null,
    acknowledge: async (request) => {
      acknowledged.push(request);
    },
    reject: async (request) => {
      rejected.push(request);
    },
  };

  await runBrowserWorkerLoop({
    execute: async (request) => {
      executed.push(request);
    },
    signal: new AbortController().signal,
    source,
  });

  expect(rejected).toEqual([1]);
  expect(executed).toEqual([2]);
  expect(acknowledged).toEqual([2]);
});

test('worker entry server exposes health and rejects unauthenticated execution', async () => {
  const server = startFailClosedWorkerServer(0);
  try {
    const health = await fetch(new URL('/health', server.url));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ready_for_authenticated_source' });

    const execution = await fetch(new URL('/v1/jobs', server.url), { method: 'POST' });
    expect(execution.status).toBe(503);
    expect(await execution.json()).toEqual({ code: 'AUTHENTICATED_SOURCE_REQUIRED' });
  } finally {
    server.stop(true);
  }
});
