import { randomUUID } from 'node:crypto';
import {
  type AutomationEvent,
  AutomationEventSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  type AutomationStep,
  AutomationStepSchema,
  type BrowserPolicy,
  BrowserPolicySchema,
} from '@kortix/intelligence-contracts';
import { type Browser, type LaunchOptions, type Page, chromium } from 'playwright';
import { type ApprovalBinding, createBrowserActionRunner } from './action-runner';
import { browserWorkerConfig } from './config';
import {
  type BrowserAdapter,
  type BrowserProfileBroker,
  type PersistentProfileRequest,
  createBrowserContextManager,
} from './context-manager';
import { type EvidenceStore, createEvidenceWriter } from './evidence-writer';
import { type BrowserNetworkProxy, startBrowserNetworkProxy } from './network-proxy';
import { createBrowserOriginGuard } from './origin-guard';

export interface AutomationAuditSink {
  write(event: AutomationEvent): Promise<void>;
}

export type BrowserWorkerEnvelope<T> = Readonly<{
  authenticated: boolean;
  request: T;
}>;

export interface AuthenticatedRequestSource<T> {
  next(signal: AbortSignal): Promise<BrowserWorkerEnvelope<T> | null>;
  acknowledge(request: T): Promise<void>;
  reject(request: T, reason: string): Promise<void>;
}

export async function runBrowserWorkerLoop<T>(input: {
  source: AuthenticatedRequestSource<T>;
  execute(request: T): Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    const envelope = await input.source.next(input.signal);
    if (envelope === null) return;
    if (!envelope.authenticated) {
      await input.source.reject(envelope.request, 'worker request authentication failed');
      continue;
    }
    await input.execute(envelope.request);
    await input.source.acknowledge(envelope.request);
  }
}

type BrowserWorkerInput = Readonly<{
  lease: AutomationLease;
  steps: readonly AutomationStep[];
  policy: BrowserPolicy;
  signal: AbortSignal;
  isSignedLeaseValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (lease: AutomationLease) => Promise<boolean>;
  currentKillSwitchGeneration: (lease: AutomationLease) => Promise<number>;
  isActionHashCurrent: (step: AutomationStep, lease: AutomationLease) => Promise<boolean>;
  consumeApproval: (input: ApprovalBinding) => Promise<ApprovalBinding | null>;
  evidenceStore: EvidenceStore;
  auditSink: AutomationAuditSink;
  persistentProfile?: PersistentProfileRequest;
  profileBroker?: BrowserProfileBroker;
  maxRuntimeMs?: number;
  launchBrowser?: (options: LaunchOptions) => Promise<Browser>;
  startProxy?: typeof startBrowserNetworkProxy;
}>;

function workerEvent(
  lease: AutomationLease,
  type: AutomationEvent['type'],
  payload: Record<string, unknown>,
): AutomationEvent {
  return AutomationEventSchema.parse({
    protocol_version: 'automation.v1',
    event_id: randomUUID(),
    job_id: lease.job_id,
    sequence: 1,
    type,
    status: null,
    payload,
    trace_id: null,
    created_at: new Date().toISOString(),
  });
}

function parsedInput(input: BrowserWorkerInput): {
  lease: AutomationLease;
  policy: BrowserPolicy;
  steps: AutomationStep[];
} {
  const lease = AutomationLeaseSchema.parse(input.lease);
  const policy = BrowserPolicySchema.parse(input.policy);
  const steps = AutomationStepSchema.array()
    .min(1)
    .max(browserWorkerConfig.maxSteps)
    .parse(input.steps);
  return { lease, policy, steps };
}

export async function runIsolatedBrowserRequest(
  rawInput: BrowserWorkerInput,
): Promise<ReadonlyArray<AutomationEvent>> {
  const { lease, policy, steps } = parsedInput(rawInput);
  if (lease.execution_domain !== 'browser') throw new Error('browser execution domain required');
  if (!(await rawInput.isSignedLeaseValid(lease))) throw new Error('lease signature is invalid');
  if (Date.parse(lease.expires_at) <= Date.now()) throw new Error('lease expired');
  if (!(await rawInput.isLeaseCurrent(lease))) throw new Error('lease is no longer current');
  if ((await rawInput.currentKillSwitchGeneration(lease)) !== lease.kill_switch_generation) {
    throw new Error('kill-switch generation changed');
  }
  for (const step of steps) {
    if (!(await rawInput.isActionHashCurrent(step, lease))) {
      throw new Error('action hash is no longer current');
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('runtime-timeout'),
    Math.min(
      rawInput.maxRuntimeMs ?? browserWorkerConfig.maxRuntimeMs,
      browserWorkerConfig.maxRuntimeMs,
    ),
  );
  let killAudit: Promise<void> | undefined;
  const onCallerAbort = () => {
    killAudit = rawInput.auditSink.write(
      workerEvent(lease, 'kill_switch_activated', {
        project_id: lease.project_id,
        reason: 'caller_abort',
      }),
    );
    controller.abort(rawInput.signal.reason ?? 'kill-switch');
  };
  if (rawInput.signal.aborted) onCallerAbort();
  else rawInput.signal.addEventListener('abort', onCallerAbort, { once: true });
  if (controller.signal.aborted) {
    clearTimeout(timeout);
    rawInput.signal.removeEventListener('abort', onCallerAbort);
    await killAudit;
    throw new Error(String(controller.signal.reason ?? 'kill-switch'));
  }

  const guard = createBrowserOriginGuard();
  const proxyStarter = rawInput.startProxy ?? startBrowserNetworkProxy;
  let proxy: BrowserNetworkProxy | undefined;
  let browser: Browser | undefined;
  let session:
    | Awaited<ReturnType<ReturnType<typeof createBrowserContextManager>['openTemporary']>>
    | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    proxy = await proxyStarter({ guard, policy });
    const launch = rawInput.launchBrowser ?? ((options) => chromium.launch(options));
    browser = await launch({ headless: true, proxy: { server: proxy.serverUrl } });
    const manager = createBrowserContextManager({
      browser: browser as unknown as BrowserAdapter,
      closeBrowserOnAbort: true,
      profileBroker: rawInput.profileBroker,
      onCleanupError: (errors) => {
        cleanupErrors.push(...errors);
      },
    });
    if (policy.context.mode === 'persistent') {
      if (rawInput.persistentProfile === undefined || rawInput.profileBroker === undefined) {
        throw new Error('persistent profile grant and broker are required');
      }
      session = await manager.openPersistent(
        rawInput.persistentProfile,
        { projectId: lease.project_id, profileId: policy.context.profile_id },
        controller.signal,
      );
    } else {
      session = await manager.openTemporary(controller.signal);
    }
    const activePage = session.page as Page;
    let downloadCount = 0;
    const pendingDownloads = new Set<Promise<void>>();
    activePage.on('download', (download) => {
      downloadCount += 1;
      const cancellation = download
        .cancel()
        .catch(() => undefined)
        .then(() => undefined)
        .finally(() => pendingDownloads.delete(cancellation));
      pendingDownloads.add(cancellation);
    });
    const evidence = createEvidenceWriter(
      rawInput.evidenceStore,
      browserWorkerConfig.maxDownloadBytes,
    );
    const runner = createBrowserActionRunner({
      page: {
        goto: async (url) => (await activePage.goto(url))?.url() ?? url,
        click: (selector) => activePage.click(selector),
        fill: (selector, value) => activePage.fill(selector, value),
        textContent: (selector) => activePage.textContent(selector),
        screenshot: async () => new Uint8Array(await activePage.screenshot()),
      },
      isSignedLeaseValid: rawInput.isSignedLeaseValid,
      isLeaseCurrent: rawInput.isLeaseCurrent,
      currentKillSwitchGeneration: rawInput.currentKillSwitchGeneration,
      isActionHashCurrent: rawInput.isActionHashCurrent,
      consumeApproval: rawInput.consumeApproval,
      isAllowedUrl: (url, currentPolicy) => guard.isAllowed(url, currentPolicy),
      writeEvidence: (contentType, body) => evidence.write(contentType, body),
    });
    const aborted = new Promise<never>((_, reject) => {
      const rejectAbort = () => reject(new Error(String(controller.signal.reason ?? 'aborted')));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const events = await Promise.race([
      runner.run({ lease, policy, signal: controller.signal, steps }),
      aborted,
    ]);
    await Promise.allSettled(pendingDownloads);
    if (downloadCount > browserWorkerConfig.maxDownloads) {
      throw new Error('browser download count limit exceeded');
    }
    return events;
  } finally {
    clearTimeout(timeout);
    rawInput.signal.removeEventListener('abort', onCallerAbort);
    const results = await Promise.allSettled(
      [session?.close(), browser?.close(), proxy?.close(), killAudit].filter(
        (operation): operation is Promise<void> => operation !== undefined,
      ),
    );
    cleanupErrors.push(
      ...results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
    );
    if (cleanupErrors.length > 0) {
      await rawInput.auditSink.write(
        workerEvent(lease, 'job_failed', {
          cleanup_error_count: cleanupErrors.length,
          project_id: lease.project_id,
        }),
      );
    }
  }
}

export function startFailClosedWorkerServer(port = browserWorkerConfig.port) {
  return Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/health') return Response.json({ status: 'ready_for_authenticated_source' });
      return Response.json({ code: 'AUTHENTICATED_SOURCE_REQUIRED' }, { status: 503 });
    },
  });
}

if (import.meta.main) {
  startFailClosedWorkerServer();
}
