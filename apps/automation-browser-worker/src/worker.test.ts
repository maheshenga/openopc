import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  AutomationJobRequest,
  AutomationLease,
  AutomationStep,
  BrowserPolicy,
} from '@kortix/intelligence-contracts';
import {
  browserAutomationRiskForAction,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import type { Browser, Download, LaunchOptions } from 'playwright';
import {
  type AuthenticatedRequestSource,
  type AutomationAuditIntent,
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
  risk: browserAutomationRiskForAction(action) ?? 'observe',
  action_hash: HASH,
});

function browserRequest(
  browserPolicy: BrowserPolicy = policy,
  steps: readonly AutomationStep[] = [step('browser.screenshot')],
  approvalPolicy: 'project-default' | 'full-access' = 'project-default',
): AutomationJobRequest {
  return {
    protocol_version: 'automation.v1',
    tenant_id: '50000000-0000-4000-a000-000000000001',
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'browser',
    steps: [...steps],
    capability_requirements: [{ capability: 'browser.page', methods: ['screenshot'], scope: {} }],
    approval_policy: approvalPolicy,
    browser_policy: browserPolicy,
    desktop_policy: null,
    idempotency_key: 'browser-worker-request-0001',
    deadline_at: '2999-01-01T00:00:00.000Z',
    traceparent: null,
  };
}

function requestHash(request: AutomationJobRequest): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalAutomationRequestJson(request)).digest('hex')}`;
}

function brokeredProfile(profileId: string, storageState: unknown = { cookies: [] }) {
  return {
    projectId: PROJECT_ID,
    profileId,
    jobId: lease.job_id,
    leaseId: lease.lease_id,
    killSwitchGeneration: lease.kill_switch_generation,
    status: 'active' as const,
    expiresAt: '2999-01-01T00:00:00.000Z',
    revokedAt: null,
    sealedStateRef: `sealed:projects/${PROJECT_ID}/browser-profiles/${profileId}.enc`,
    stateHash: `sha256:${createHash('sha256').update(JSON.stringify(storageState)).digest('hex')}`,
    storageState,
  };
}

function runtime(options?: {
  browserCloseError?: Error;
  clickError?: Error;
  downloadCancel?: () => Promise<void>;
  downloadCancelError?: Error;
  downloads?: number;
  hangingClick?: boolean;
}) {
  const closed: string[] = [];
  const contextOptions: unknown[] = [];
  const lifecycle: string[] = [];
  let downloadHandler: ((download: Download) => void) | undefined;
  let routeHandler:
    | ((route: {
        abort(code?: string): Promise<void>;
        continue(): Promise<void>;
        request(): { url(): string };
      }) => Promise<void>)
    | undefined;
  const page = {
    url: () => 'about:blank',
    close: async () => {
      closed.push('page');
    },
    goto: async (url: string) => ({ url: () => url }),
    click: async () => {
      lifecycle.push('click');
      for (let index = 0; index < (options?.downloads ?? 0); index += 1) {
        downloadHandler?.({
          cancel: async () => {
            if (options?.downloadCancel !== undefined) return options.downloadCancel();
            if (options?.downloadCancelError !== undefined) throw options.downloadCancelError;
          },
        } as Download);
      }
      if (options?.clickError !== undefined) throw options.clickError;
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
    newPage: async () => {
      lifecycle.push('newPage');
      return page;
    },
    route: async (_pattern: string, handler: typeof routeHandler) => {
      lifecycle.push('route');
      routeHandler = handler;
    },
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
      if (options?.browserCloseError !== undefined) throw options.browserCloseError;
    },
  } as unknown as Browser;
  const launchOptions: LaunchOptions[] = [];
  return {
    browser,
    closed,
    contextOptions,
    lifecycle,
    launchOptions,
    routeHandler: () => routeHandler,
    launchBrowser: async (launch: LaunchOptions) => {
      launchOptions.push(launch);
      return browser;
    },
  };
}

function dependencies(
  fake: ReturnType<typeof runtime>,
  overrides?: { killSwitchSignal?: AbortSignal; signal?: AbortSignal },
) {
  const audit: AutomationAuditIntent[] = [];
  const actionEvents: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const request = browserRequest();
  return {
    audit,
    actionEvents,
    evidence,
    input: {
      auditSink: {
        write: async (event: AutomationAuditIntent) => {
          audit.push(event);
        },
      },
      actionEventSink: {
        write: async (event: Record<string, unknown>) => {
          actionEvents.push(event);
        },
      },
      consumeApproval: async () => null,
      currentKillSwitchGeneration: async () => 1,
      evidenceStore: {
        put: async (input: Record<string, unknown>) => {
          evidence.push(input);
        },
      },
      isActionHashCurrent: async () => true,
      isFullAccessGrantCurrent: async () => true,
      isLeaseCurrent: async () => true,
      isResumeCursorCurrent: async () => true,
      isRuntimeIsolationAttested: async () => true,
      isSignedLeaseValid: async () => true,
      killSwitchSignal: overrides?.killSwitchSignal,
      launchBrowser: fake.launchBrowser,
      lease: { ...lease, request_hash: requestHash(request) },
      request,
      resumeAfterSequence: 0,
      signal: overrides?.signal ?? new AbortController().signal,
      startProxy: async () => ({
        close: async () => {
          fake.closed.push('proxy');
        },
        serverUrl: 'http://127.0.0.1:12345',
      }),
      waitForApproval: async () => undefined,
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

  test('rejects a canonical browser action with mismatched risk before resource allocation', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let proxyStarts = 0;
    const request = browserRequest(
      policy,
      [{ ...step('browser.click', { selector: '#run' }), risk: 'observe' }],
      'full-access',
    );

    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        lease: { ...lease, request_hash: requestHash(request) },
        request,
        startProxy: async () => {
          proxyStarts += 1;
          return fixture.input.startProxy();
        },
      }),
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

  test('keeps the live browser context open while a bound approval is awaited and consumed', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const request = browserRequest(
      policy,
      [step('browser.submit', { selector: '#submit' })],
      'full-access',
    );
    let releaseApproval: () => void = () => undefined;
    const approvalGate = new Promise<void>((resolve) => {
      releaseApproval = resolve;
    });
    let markWaiting: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    let consumeAttempts = 0;
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      consumeApproval: async (binding) => {
        consumeAttempts += 1;
        return consumeAttempts === 1 ? null : binding;
      },
      lease: { ...lease, request_hash: requestHash(request) },
      request,
      waitForApproval: async () => {
        markWaiting();
        await approvalGate;
      },
    });

    try {
      const state = await Promise.race([
        waiting.then(() => 'waiting' as const),
        running.then(() => 'completed' as const),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ]);
      expect(state).toBe('waiting');
      expect(fake.closed).not.toContain('browser');
      expect(fixture.actionEvents.map((event) => event.type)).toContain('approval_required');
      releaseApproval();

      const events = await running;
      expect(events.map((event) => event.type)).toEqual([
        'approval_required',
        'step_started',
        'step_completed',
      ]);
      expect(consumeAttempts).toBe(2);
      expect(fake.lifecycle).toContain('click');
      expect(fake.closed).toContain('browser');
    } finally {
      releaseApproval();
      await running.catch(() => undefined);
    }
  });

  test('refuses execution before resource allocation without runtime isolation attestation', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let proxyStarts = 0;

    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        isRuntimeIsolationAttested: async () => false,
        startProxy: async () => {
          proxyStarts += 1;
          throw new Error('must not start');
        },
      }),
    ).rejects.toThrow('runtime isolation is not attested');
    expect(proxyStarts).toBe(0);
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('starts the runtime deadline before asynchronous authority verification', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let releaseVerifier: () => void = () => undefined;
    const verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      isSignedLeaseValid: async () => {
        await verifierGate;
        return true;
      },
      maxRuntimeMs: 5,
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30)),
    ]);
    releaseVerifier();
    await running.catch(() => undefined);

    expect(outcome).toContain('runtime-timeout');
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('uses the signed request deadline to bound asynchronous authority verification', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const request = {
      ...fixture.input.request,
      deadline_at: new Date(Date.now() + 50).toISOString(),
    };
    let releaseVerifier: () => void = () => undefined;
    const verifierGate = new Promise<void>((resolve) => {
      releaseVerifier = resolve;
    });
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      isSignedLeaseValid: async () => {
        await verifierGate;
        return true;
      },
      lease: { ...lease, request_hash: requestHash(request) },
      maxRuntimeMs: 1_000,
      request,
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 150)),
    ]);
    releaseVerifier();
    await running.catch(() => undefined);

    expect(outcome).toContain('request-deadline');
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('enforces the runtime deadline while proxy startup is pending and closes a late proxy', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let releaseProxy: () => void = () => undefined;
    const proxyGate = new Promise<void>((resolve) => {
      releaseProxy = resolve;
    });
    let confirmProxyClosed: () => void = () => undefined;
    const proxyClosed = new Promise<void>((resolve) => {
      confirmProxyClosed = resolve;
    });
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      maxRuntimeMs: 5,
      startProxy: async () => {
        await proxyGate;
        return {
          close: async () => {
            fake.closed.push('late-proxy');
            confirmProxyClosed();
          },
          serverUrl: 'http://127.0.0.1:12345',
        };
      },
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30)),
    ]);
    releaseProxy();
    await running.catch(() => undefined);
    await proxyClosed;

    expect(outcome).toContain('runtime-timeout');
    expect(fake.closed).toContain('late-proxy');
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('rejects policy substitution that does not match the signed lease request hash', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const authorizedRequest = browserRequest();
    let proxyStarts = 0;

    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        lease: { ...lease, request_hash: requestHash(authorizedRequest) },
        request: browserRequest({
          ...policy,
          allowed_origins: ['https://attacker.example.test'],
        }),
        resumeAfterSequence: 0,
        isResumeCursorCurrent: async () => true,
        startProxy: async () => {
          proxyStarts += 1;
          throw new Error('must not start');
        },
      } as never),
    ).rejects.toThrow('request hash');
    expect(proxyStarts).toBe(0);
    expect(fake.launchOptions).toHaveLength(0);
  });

  test('rejects legacy independently supplied policy and steps without a canonical request', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let proxyStarts = 0;
    const { request: _request, ...legacyInput } = fixture.input as typeof fixture.input & {
      request?: AutomationJobRequest;
    };

    await expect(
      runIsolatedBrowserRequest({
        ...legacyInput,
        startProxy: async () => {
          proxyStarts += 1;
          throw new Error('must not start');
        },
      } as never),
    ).rejects.toThrow('canonical request');
    expect(proxyStarts).toBe(0);
  });

  test('launches through the pinned proxy and returns an opaque screenshot evidence reference', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const events = await runIsolatedBrowserRequest(fixture.input);

    expect(fake.launchOptions[0]?.proxy).toEqual({ server: 'http://127.0.0.1:12345' });
    expect(fake.launchOptions[0]?.chromiumSandbox).toBeTrue();
    expect(fake.launchOptions[0]?.args).toContain('--disable-quic');
    expect(fake.launchOptions[0]?.args).toContain(
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    );
    expect(fixture.evidence).toHaveLength(1);
    expect(fixture.evidence[0]).toMatchObject({
      jobId: lease.job_id,
      leaseId: lease.lease_id,
      projectId: PROJECT_ID,
      stepId: ID,
      tenantId: fixture.input.request.tenant_id,
    });
    expect(events.at(-1)?.payload.evidence_reference).toMatch(/^evidence:/);
    expect(fake.closed).toContain('proxy');
  });

  test('fails a successful request when security cleanup fails', async () => {
    const fake = runtime({ browserCloseError: new Error('browser close failed') });
    const fixture = dependencies(fake);

    await expect(runIsolatedBrowserRequest(fixture.input)).rejects.toThrow(
      'browser worker cleanup failed',
    );
    expect(fixture.audit.map((event) => event.type)).toContain('job_failed');
    expect(fake.closed).toContain('page');
    expect(fake.closed).toContain('context');
    expect(fake.closed).toContain('proxy');
  });

  test('preserves the primary execution error when cleanup and cleanup audit also fail', async () => {
    const fake = runtime({ browserCloseError: new Error('browser close failed') });
    const fixture = dependencies(fake);
    let actionHashChecks = 0;
    let failure: unknown;

    try {
      await runIsolatedBrowserRequest({
        ...fixture.input,
        auditSink: {
          write: async () => {
            throw new Error('cleanup audit failed');
          },
        },
        isActionHashCurrent: async () => {
          actionHashChecks += 1;
          return actionHashChecks === 1;
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('action hash is no longer current');
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(fake.closed).toContain('browser');
    expect(fake.closed).toContain('proxy');
  });

  test('bounds a hanging cleanup audit without weakening the cleanup failure', async () => {
    const fake = runtime({ browserCloseError: new Error('browser close failed') });
    const fixture = dependencies(fake);
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      auditSink: {
        write: async () => new Promise<void>(() => undefined),
      },
      maxRuntimeMs: 20,
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    expect(outcome).toContain('browser worker cleanup failed');
    expect(fake.closed).toContain('proxy');
  });

  test('installs the origin route before page creation and blocks a private request', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    await runIsolatedBrowserRequest(fixture.input);

    expect(fake.lifecycle.slice(0, 2)).toEqual(['route', 'newPage']);
    const handler = fake.routeHandler();
    expect(handler).toBeDefined();
    let aborted = false;
    let continued = false;
    await handler?.({
      abort: async () => {
        aborted = true;
      },
      continue: async () => {
        continued = true;
      },
      request: () => ({ url: () => 'http://127.0.0.1/private' }),
    });
    expect(aborted).toBeTrue();
    expect(continued).toBeFalse();
  });

  test('cancels downloads and rejects a request that exceeds the count budget', async () => {
    const fake = runtime({ downloads: 5 });
    const fixture = dependencies(fake);
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#export' })],
      'full-access',
    );
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        lease: { ...lease, request_hash: requestHash(request) },
        request,
      }),
    ).rejects.toThrow('download count');
  });

  test('aborts a hanging action immediately when the download count budget is exceeded', async () => {
    const fake = runtime({ downloads: 5, hangingClick: true });
    const fixture = dependencies(fake);
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#export' })],
      'full-access',
    );
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      lease: { ...lease, request_hash: requestHash(request) },
      maxRuntimeMs: 100,
      request,
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 50)),
    ]);

    expect(outcome).toContain('browser download count limit exceeded');
  });

  test('fails closed when a browser download cannot be cancelled', async () => {
    const fake = runtime({
      downloadCancelError: new Error('download cancel failed'),
      downloads: 1,
    });
    const fixture = dependencies(fake);
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#export' })],
      'full-access',
    );

    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        lease: { ...lease, request_hash: requestHash(request) },
        request,
      }),
    ).rejects.toThrow('browser download cancellation failed');
  });

  test('awaits pending download cancellation before surfacing an action failure', async () => {
    let releaseCancellation: () => void = () => undefined;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    const fake = runtime({
      clickError: new Error('page click failed'),
      downloadCancel: async () => cancellationGate,
      downloads: 1,
    });
    const fixture = dependencies(fake);
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#export' })],
      'full-access',
    );
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      lease: { ...lease, request_hash: requestHash(request) },
      request,
    });

    const earlyOutcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ]);
    releaseCancellation();

    expect(earlyOutcome).toBe('still-pending');
    await expect(running).rejects.toThrow('page click failed');
  });

  test('records kill-switch audit and stops a hanging action', async () => {
    const fake = runtime({ hangingClick: true });
    const controller = new AbortController();
    const fixture = dependencies(fake, { killSwitchSignal: controller.signal });
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#run' })],
      'full-access',
    );
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      lease: { ...lease, request_hash: requestHash(request) },
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('kill-switch');

    await expect(running).rejects.toThrow('kill-switch');
    expect(fixture.audit.map((event) => event.type)).toContain('kill_switch_activated');
    expect(fake.closed).toContain('browser');
  });

  test('does not record an ordinary request cancellation as a kill-switch activation', async () => {
    const fake = runtime({ hangingClick: true });
    const controller = new AbortController();
    const fixture = dependencies(fake, { signal: controller.signal });
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#run' })],
      'full-access',
    );
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      lease: { ...lease, request_hash: requestHash(request) },
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('request-cancelled');

    await expect(running).rejects.toThrow('request-cancelled');
    expect(fixture.audit.map((event) => event.type)).not.toContain('kill_switch_activated');
    expect(fake.closed).toContain('browser');
  });

  test('records kill-switch audit when the authoritative generation changes', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let generationChecks = 0;

    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        currentKillSwitchGeneration: async () => {
          generationChecks += 1;
          return generationChecks === 1 ? lease.kill_switch_generation : 2;
        },
      }),
    ).rejects.toThrow('kill-switch generation changed');

    expect(fixture.audit.map((event) => event.type)).toContain('kill_switch_activated');
    const killIntent = fixture.audit.find((event) => event.type === 'kill_switch_activated');
    expect(killIntent).not.toHaveProperty('event_id');
    expect(killIntent).not.toHaveProperty('sequence');
    expect(killIntent).not.toHaveProperty('status');
    expect(fake.closed).toContain('proxy');
  });

  test('does not let a hanging kill audit prevent abort cleanup', async () => {
    const fake = runtime({ hangingClick: true });
    const controller = new AbortController();
    const fixture = dependencies(fake, { killSwitchSignal: controller.signal });
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#run' })],
      'full-access',
    );
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      auditSink: {
        write: async (event) => {
          if (event.type === 'kill_switch_activated') {
            await new Promise<void>(() => undefined);
          }
        },
      },
      lease: { ...lease, request_hash: requestHash(request) },
      maxRuntimeMs: 20,
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort('kill-switch');

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
    ]);

    expect(outcome).toContain('kill-switch');
    expect(fake.closed).toContain('browser');
    expect(fake.closed).toContain('proxy');
  });

  test('does not allocate browser resources for an already-stopped request', async () => {
    const fake = runtime();
    const controller = new AbortController();
    controller.abort('kill-switch');
    const fixture = dependencies(fake, { killSwitchSignal: controller.signal });
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
    const request = browserRequest(
      policy,
      [step('browser.click', { selector: '#run' })],
      'full-access',
    );
    await expect(
      runIsolatedBrowserRequest({
        ...fixture.input,
        lease: { ...lease, request_hash: requestHash(request) },
        maxRuntimeMs: 5,
        request,
      }),
    ).rejects.toThrow('runtime-timeout');
    expect(fake.closed).toContain('browser');
  });

  test('enforces the runtime ceiling while browser allocation is still pending', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    let releaseLaunch: () => void = () => undefined;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      launchBrowser: async () => {
        await launchGate;
        return fake.browser;
      },
      maxRuntimeMs: 5,
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30)),
    ]);
    releaseLaunch();
    await running.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outcome).toContain('runtime-timeout');
    expect(fake.closed).toContain('browser');
    expect(fake.closed).toContain('proxy');
  });

  test('surfaces a failed close from a browser allocated after the runtime deadline', async () => {
    const fake = runtime({ browserCloseError: new Error('late browser close failed') });
    const fixture = dependencies(fake);
    const outcome = await runIsolatedBrowserRequest({
      ...fixture.input,
      launchBrowser: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return fake.browser;
      },
      maxRuntimeMs: 20,
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain('runtime-timeout');
    expect((outcome as Error).cause).toBeInstanceOf(AggregateError);
    expect(
      ((outcome as Error).cause as AggregateError).errors
        .map((error) => (error instanceof Error ? error.message : String(error)))
        .join(','),
    ).toContain('late browser close failed');
    expect(fixture.audit.map((event) => event.type)).toContain('job_failed');
  });

  test('enforces the runtime ceiling while persistent profile brokerage is pending', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const profileId = '40000000-0000-4000-a000-000000000001';
    const persistentPolicy: BrowserPolicy = {
      ...policy,
      context: { mode: 'persistent', profile_id: profileId },
    };
    const request = browserRequest(persistentPolicy);
    let releaseBroker: () => void = () => undefined;
    const brokerGate = new Promise<void>((resolve) => {
      releaseBroker = resolve;
    });
    const running = runIsolatedBrowserRequest({
      ...fixture.input,
      lease: { ...lease, request_hash: requestHash(request) },
      maxRuntimeMs: 5,
      persistentProfile: {
        brokerCredential: 'one-time-token',
      },
      profileBroker: {
        consumePersistentProfile: async () => {
          await brokerGate;
          return brokeredProfile(profileId);
        },
      },
      request,
    });

    const outcome = await Promise.race([
      running.then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'still-pending'>((resolve) => setTimeout(() => resolve('still-pending'), 30)),
    ]);
    releaseBroker();
    await running.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(outcome).toContain('runtime-timeout');
    expect(fake.closed).toContain('browser');
    expect(fake.closed).toContain('proxy');
  });

  test('binds a persistent context to the lease project and policy profile grant', async () => {
    const fake = runtime();
    const fixture = dependencies(fake);
    const profileId = '40000000-0000-4000-a000-000000000001';
    const persistentPolicy: BrowserPolicy = {
      ...policy,
      context: { mode: 'persistent', profile_id: profileId },
    };
    const request = browserRequest(persistentPolicy);
    const brokerInputs: Array<Record<string, unknown>> = [];
    await runIsolatedBrowserRequest({
      ...fixture.input,
      lease: { ...lease, request_hash: requestHash(request) },
      persistentProfile: {
        brokerCredential: 'one-time-token',
      },
      request,
      profileBroker: {
        consumePersistentProfile: async (input) => {
          brokerInputs.push(input);
          return brokeredProfile(profileId);
        },
      },
    });

    expect(brokerInputs).toEqual([
      {
        brokerCredential: 'one-time-token',
        jobId: lease.job_id,
        killSwitchGeneration: lease.kill_switch_generation,
        leaseId: lease.lease_id,
        profileId,
        projectId: PROJECT_ID,
      },
    ]);
    expect(fake.contextOptions).toContainEqual({
      acceptDownloads: false,
      serviceWorkers: 'block',
      storageState: { cookies: [] },
    });
  });
});

test('heartbeat transport failure aborts an active browser execution and closes resources', async () => {
  const fake = runtime({ hangingClick: true });
  const fixture = dependencies(fake);
  const request = browserRequest(
    policy,
    [step('browser.click', { selector: '#submit' })],
    'full-access',
  );
  const heartbeatFailure = new Error('authenticated heartbeat channel failed');
  const heartbeats: number[] = [];
  const closedLeases: string[] = [];

  const execution = runIsolatedBrowserRequest({
    ...fixture.input,
    request,
    lease: { ...lease, request_hash: requestHash(request) },
    heartbeat: {
      intervalMs: 5,
      async send(input) {
        heartbeats.push(input.lastCompletedStep);
        if (heartbeats.length > 1) throw heartbeatFailure;
        return {
          protocol_version: 'automation.v1',
          event_id: '60000000-0000-4000-a000-000000000001',
          job_id: lease.job_id,
          sequence: 1,
          type: 'heartbeat',
          status: null,
          payload: { last_completed_step: input.lastCompletedStep },
          trace_id: null,
          created_at: '2026-07-23T04:00:00.000Z',
        };
      },
      closeLease(leaseId) {
        closedLeases.push(leaseId);
      },
    },
  });

  await expect(execution).rejects.toBe(heartbeatFailure);
  expect(heartbeats).toEqual([0, 0]);
  expect(closedLeases).toEqual([lease.lease_id]);
  expect(fake.closed).toEqual(expect.arrayContaining(['context', 'browser', 'proxy']));
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

test('worker loop does not execute a request returned after shutdown begins', async () => {
  const controller = new AbortController();
  const executed: number[] = [];
  const acknowledged: number[] = [];
  const source: AuthenticatedRequestSource<number> = {
    next: async () => {
      controller.abort('shutdown');
      return { authenticated: true, request: 1 };
    },
    acknowledge: async (request) => {
      acknowledged.push(request);
    },
    reject: async () => undefined,
  };

  await runBrowserWorkerLoop({
    source,
    execute: async (request) => {
      executed.push(request);
    },
    signal: controller.signal,
  });

  expect(executed).toEqual([]);
  expect(acknowledged).toEqual([]);
});

test('worker entry server reports not-ready and rejects execution until a source is connected', async () => {
  const server = startFailClosedWorkerServer(0);
  try {
    const health = await fetch(new URL('/health', server.url));
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: 'waiting_for_authenticated_source' });

    const execution = await fetch(new URL('/v1/jobs', server.url), { method: 'POST' });
    expect(execution.status).toBe(503);
    expect(await execution.json()).toEqual({ code: 'AUTHENTICATED_SOURCE_REQUIRED' });
  } finally {
    server.stop(true);
  }
});
