import { createHash } from 'node:crypto';
import {
  type AutomationEvent,
  type AutomationJobRequest,
  AutomationJobRequestSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  type AutomationStep,
  BrowserAutomationStepSchema,
  type BrowserPolicy,
  BrowserPolicySchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { type Browser, type LaunchOptions, type Page, chromium } from 'playwright';
import {
  type ApprovalBinding,
  type BrowserActionEventIntent,
  BrowserKillSwitchError,
  createBrowserActionRunner,
} from './action-runner';
import { browserWorkerConfig } from './config';
import {
  type BrowserAdapter,
  type BrowserProfileBroker,
  type PersistentProfileRequest,
  createBrowserContextManager,
} from './context-manager';
import { type EvidenceStore, createEvidenceWriter } from './evidence-writer';
import {
  type BrowserWorkerHeartbeatEmitter,
  runBrowserWorkerHeartbeatLoop,
} from './heartbeat-client';
import { type BrowserNetworkProxy, startBrowserNetworkProxy } from './network-proxy';
import { createBrowserOriginGuard } from './origin-guard';

export interface AutomationAuditSink {
  write(intent: AutomationAuditIntent): Promise<void>;
}

export type AutomationAuditIntent = Readonly<{
  protocol_version: AutomationEvent['protocol_version'];
  job_id: string;
  project_id: string;
  lease_id: string;
  kill_switch_generation: number;
  type: AutomationEvent['type'];
  payload: Record<string, unknown>;
  trace_id: string | null;
}>;

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
    if (input.signal.aborted) return;
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
  request: AutomationJobRequest;
  resumeAfterSequence: number;
  signal: AbortSignal;
  killSwitchSignal?: AbortSignal;
  isSignedLeaseValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (lease: AutomationLease) => Promise<boolean>;
  currentKillSwitchGeneration: (lease: AutomationLease) => Promise<number>;
  isActionHashCurrent: (step: AutomationStep, lease: AutomationLease) => Promise<boolean>;
  isFullAccessGrantCurrent: (lease: AutomationLease) => Promise<boolean>;
  isRuntimeIsolationAttested: (lease: AutomationLease) => Promise<boolean>;
  isResumeCursorCurrent: (input: {
    lease: AutomationLease;
    request: AutomationJobRequest;
    resumeAfterSequence: number;
  }) => Promise<boolean>;
  consumeApproval: (input: ApprovalBinding) => Promise<ApprovalBinding | null>;
  evidenceStore: EvidenceStore;
  auditSink: AutomationAuditSink;
  actionEventSink: { write(intent: BrowserActionEventIntent): Promise<void> };
  waitForApproval: (input: ApprovalBinding, signal: AbortSignal) => Promise<void>;
  persistentProfile?: PersistentProfileRequest;
  profileBroker?: BrowserProfileBroker;
  maxRuntimeMs?: number;
  launchBrowser?: (options: LaunchOptions) => Promise<Browser>;
  startProxy?: typeof startBrowserNetworkProxy;
  heartbeat?: BrowserWorkerHeartbeatEmitter;
}>;

function workerAuditIntent(
  lease: AutomationLease,
  type: AutomationEvent['type'],
  payload: Record<string, unknown>,
): AutomationAuditIntent {
  return {
    protocol_version: 'automation.v1',
    job_id: lease.job_id,
    project_id: lease.project_id,
    lease_id: lease.lease_id,
    kill_switch_generation: lease.kill_switch_generation,
    type,
    payload,
    trace_id: null,
  };
}

function parsedInput(input: BrowserWorkerInput): {
  lease: AutomationLease;
  policy: BrowserPolicy;
  request: AutomationJobRequest;
  steps: AutomationStep[];
} {
  const lease = AutomationLeaseSchema.parse(input.lease);
  if (input.request === undefined) throw new Error('canonical request is required');
  const request = AutomationJobRequestSchema.parse(input.request);
  if (request.execution_domain !== 'browser' || request.browser_policy === null) {
    throw new Error('canonical browser request is required');
  }
  const policy = BrowserPolicySchema.parse(request.browser_policy);
  const canonicalSteps = request.steps.map((step) => BrowserAutomationStepSchema.parse(step));
  if (
    canonicalSteps.some(
      (step, index) => index > 0 && step.sequence <= (canonicalSteps[index - 1]?.sequence ?? 0),
    )
  ) {
    throw new Error('browser request steps must be strictly ordered');
  }
  if (
    !Number.isInteger(input.resumeAfterSequence) ||
    input.resumeAfterSequence < 0 ||
    (input.resumeAfterSequence !== 0 &&
      !canonicalSteps.some((step) => step.sequence === input.resumeAfterSequence))
  ) {
    throw new Error('browser resume cursor is invalid');
  }
  const steps = BrowserAutomationStepSchema.array()
    .min(1)
    .max(browserWorkerConfig.maxSteps)
    .parse(canonicalSteps.filter((step) => step.sequence > input.resumeAfterSequence));
  return { lease, policy, request, steps };
}

function abortError(signal: AbortSignal): Error {
  return new Error(String(signal.reason ?? 'browser execution aborted'));
}

function abortableOperation<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  closeLate?: (value: T) => Promise<void>,
  trackLateCleanup?: (operation: Promise<void>) => void,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  let operation: Promise<T>;
  try {
    operation = start();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const onAbort = () => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', onAbort);
      if (closeLate !== undefined) {
        const cleanup = operation.then((value) => closeLate(value));
        if (trackLateCleanup === undefined) void cleanup.catch(() => undefined);
        else trackLateCleanup(cleanup);
      }
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function settleWithin<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<PromiseSettledResult<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then<PromiseSettledResult<T>, PromiseSettledResult<T>>(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      ),
      new Promise<PromiseRejectedResult>((resolve) => {
        timeout = setTimeout(
          () =>
            resolve({
              status: 'rejected',
              reason: new Error('browser worker finalization timed out'),
            }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function runIsolatedBrowserRequest(
  rawInput: BrowserWorkerInput,
): Promise<ReadonlyArray<BrowserActionEventIntent>> {
  const { lease, policy, request, steps } = parsedInput(rawInput);
  if (lease.execution_domain !== 'browser') throw new Error('browser execution domain required');
  const requestHash = `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(request))
    .digest('hex')}`;
  if (requestHash !== lease.request_hash) throw new Error('lease request hash mismatch');
  if (request.project_id !== lease.project_id)
    throw new Error('lease project does not match request');
  const controller = new AbortController();
  const startedAt = Date.now();
  const configuredRuntimeMs = Math.min(
    rawInput.maxRuntimeMs ?? browserWorkerConfig.maxRuntimeMs,
    browserWorkerConfig.maxRuntimeMs,
  );
  const runtimeDeadline = [
    { at: startedAt + configuredRuntimeMs, reason: 'runtime-timeout' },
    { at: Date.parse(request.deadline_at), reason: 'request-deadline' },
    { at: Date.parse(lease.expires_at), reason: 'lease-expired' },
  ].reduce((earliest, candidate) => (candidate.at < earliest.at ? candidate : earliest));
  const runtimeLimitMs = Math.max(0, runtimeDeadline.at - startedAt);
  const timeout = setTimeout(() => controller.abort(runtimeDeadline.reason), runtimeLimitMs);
  let killAudit: Promise<void> | undefined;
  const startKillAudit = (reason: 'generation_changed' | 'signal_abort'): Promise<void> =>
    Promise.resolve().then(() =>
      rawInput.auditSink.write(
        workerAuditIntent(lease, 'kill_switch_activated', {
          project_id: lease.project_id,
          reason,
        }),
      ),
    );
  const onCallerAbort = () => {
    controller.abort(rawInput.signal.reason ?? 'browser request cancelled');
  };
  if (rawInput.signal.aborted) onCallerAbort();
  else rawInput.signal.addEventListener('abort', onCallerAbort, { once: true });
  const onKillSwitchAbort = () => {
    controller.abort(rawInput.killSwitchSignal?.reason ?? 'kill-switch');
    killAudit ??= startKillAudit('signal_abort');
  };
  if (rawInput.killSwitchSignal?.aborted) onKillSwitchAbort();
  else rawInput.killSwitchSignal?.addEventListener('abort', onKillSwitchAbort, { once: true });

  const guard = createBrowserOriginGuard();
  const proxyStarter = rawInput.startProxy ?? startBrowserNetworkProxy;
  let proxy: BrowserNetworkProxy | undefined;
  let browser: Browser | undefined;
  let session:
    | Awaited<ReturnType<ReturnType<typeof createBrowserContextManager>['openTemporary']>>
    | undefined;
  const cleanupErrors: unknown[] = [];
  const lateCleanupOperations: Array<Promise<PromiseSettledResult<void>>> = [];
  const trackLateCleanup = (operation: Promise<void>): void => {
    lateCleanupOperations.push(
      operation.then<PromiseSettledResult<void>, PromiseSettledResult<void>>(
        () => ({ status: 'fulfilled', value: undefined }),
        (reason) => ({ status: 'rejected', reason }),
      ),
    );
  };
  let downloadCount = 0;
  let downloadCancellationsSettled = false;
  const pendingDownloads = new Set<Promise<PromiseSettledResult<void>>>();
  let actionEvents: ReadonlyArray<BrowserActionEventIntent> | undefined;
  let lastCompletedStep = 0;
  let heartbeatController: AbortController | undefined;
  let heartbeatLoop: Promise<void> | undefined;
  let heartbeatFailure: unknown;
  let stopHeartbeatOnExecutionAbort: (() => void) | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let cleanupFailure: AggregateError | undefined;
  try {
    if (controller.signal.aborted) throw abortError(controller.signal);
    if (!(await abortableOperation(() => rawInput.isSignedLeaseValid(lease), controller.signal))) {
      throw new Error('lease signature is invalid');
    }
    if (Date.parse(lease.expires_at) <= Date.now()) throw new Error('lease expired');
    if (!(await abortableOperation(() => rawInput.isLeaseCurrent(lease), controller.signal))) {
      throw new Error('lease is no longer current');
    }
    if (
      (await abortableOperation(
        () => rawInput.currentKillSwitchGeneration(lease),
        controller.signal,
      )) !== lease.kill_switch_generation
    ) {
      throw new BrowserKillSwitchError('kill-switch generation changed');
    }
    if (
      !(await abortableOperation(
        () =>
          rawInput.isResumeCursorCurrent({
            lease,
            request,
            resumeAfterSequence: rawInput.resumeAfterSequence,
          }),
        controller.signal,
      ))
    ) {
      throw new Error('browser resume cursor is no longer current');
    }
    for (const step of steps) {
      if (
        !(await abortableOperation(
          () => rawInput.isActionHashCurrent(step, lease),
          controller.signal,
        ))
      ) {
        throw new Error('action hash is no longer current');
      }
    }
    if (
      !(await abortableOperation(
        () => rawInput.isRuntimeIsolationAttested(lease),
        controller.signal,
      ))
    ) {
      throw new Error('runtime isolation is not attested');
    }
    if (rawInput.heartbeat !== undefined) {
      await abortableOperation(
        () =>
          rawInput.heartbeat?.send({
            lease,
            request,
            lastCompletedStep,
            signal: controller.signal,
          }) ?? Promise.reject(new Error('browser heartbeat emitter is unavailable')),
        controller.signal,
      );
      heartbeatController = new AbortController();
      stopHeartbeatOnExecutionAbort = () =>
        heartbeatController?.abort(controller.signal.reason ?? 'browser execution stopped');
      controller.signal.addEventListener('abort', stopHeartbeatOnExecutionAbort, { once: true });
      heartbeatLoop = runBrowserWorkerHeartbeatLoop({
        emitter: rawInput.heartbeat,
        lease,
        request,
        getLastCompletedStep: () => lastCompletedStep,
        signal: heartbeatController.signal,
      }).catch((error) => {
        heartbeatFailure = error;
        controller.abort('browser heartbeat transport failed');
      });
    }
    proxy = await abortableOperation(
      () => proxyStarter({ guard, policy }),
      controller.signal,
      (lateProxy) => lateProxy.close(),
      trackLateCleanup,
    );
    const proxyServerUrl = proxy.serverUrl;
    const launch = rawInput.launchBrowser ?? ((options) => chromium.launch(options));
    browser = await abortableOperation(
      () =>
        launch({
          args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
          chromiumSandbox: true,
          headless: true,
          proxy: { server: proxyServerUrl },
        }),
      controller.signal,
      (lateBrowser) => lateBrowser.close(),
      trackLateCleanup,
    );
    const manager = createBrowserContextManager({
      browser: browser as unknown as BrowserAdapter,
      closeBrowserOnAbort: true,
      profileBroker: rawInput.profileBroker,
      onCleanupError: (errors) => {
        cleanupErrors.push(...errors);
      },
      prepareContext: async (context) => {
        await context.route('**/*', async (route) => {
          if (
            controller.signal.aborted ||
            !(await guard.isAllowed(route.request().url(), policy))
          ) {
            await route.abort('blockedbyclient');
            return;
          }
          await route.continue();
        });
      },
    });
    session = await abortableOperation(
      () => {
        if (policy.context.mode === 'persistent') {
          if (rawInput.persistentProfile === undefined || rawInput.profileBroker === undefined) {
            throw new Error('persistent profile grant and broker are required');
          }
          return manager.openPersistent(
            rawInput.persistentProfile,
            {
              projectId: lease.project_id,
              profileId: policy.context.profile_id,
              jobId: lease.job_id,
              leaseId: lease.lease_id,
              killSwitchGeneration: lease.kill_switch_generation,
            },
            controller.signal,
          );
        }
        return manager.openTemporary(controller.signal);
      },
      controller.signal,
      (lateSession) => lateSession.close(),
      trackLateCleanup,
    );
    const activePage = session.page as Page;
    activePage.on('download', (download) => {
      downloadCount += 1;
      if (downloadCount > browserWorkerConfig.maxDownloads) {
        controller.abort('browser download count limit exceeded');
      }
      const cancellation = download
        .cancel()
        .then<PromiseSettledResult<void>, PromiseSettledResult<void>>(
          () => ({ status: 'fulfilled', value: undefined }),
          (reason) => ({ status: 'rejected', reason }),
        );
      pendingDownloads.add(cancellation);
    });
    const evidence = createEvidenceWriter(
      rawInput.evidenceStore,
      {
        tenantId: request.tenant_id,
        projectId: lease.project_id,
        jobId: lease.job_id,
        leaseId: lease.lease_id,
      },
      browserWorkerConfig.maxDownloadBytes,
    );
    const runner = createBrowserActionRunner({
      page: {
        currentUrl: () => activePage.url(),
        goto: async (url) => (await activePage.goto(url))?.url() ?? url,
        click: (selector) => activePage.click(selector),
        clickPoint: (x, y) => activePage.mouse.click(x, y),
        fill: (selector, value) => activePage.fill(selector, value),
        textContent: (selector) => activePage.textContent(selector),
        screenshot: async () => new Uint8Array(await activePage.screenshot()),
      },
      isSignedLeaseValid: rawInput.isSignedLeaseValid,
      isLeaseCurrent: rawInput.isLeaseCurrent,
      currentKillSwitchGeneration: rawInput.currentKillSwitchGeneration,
      emitEvent: (intent) => rawInput.actionEventSink.write(intent),
      onStepCompleted: (completedStepCount) => {
        lastCompletedStep = completedStepCount;
      },
      isActionHashCurrent: rawInput.isActionHashCurrent,
      isFullAccessGrantCurrent: rawInput.isFullAccessGrantCurrent,
      consumeApproval: rawInput.consumeApproval,
      isAllowedUrl: (url, currentPolicy) => guard.isAllowed(url, currentPolicy),
      waitForApproval: rawInput.waitForApproval,
      writeEvidence: (step, contentType, body) => evidence.write(step.step_id, contentType, body),
    });
    const aborted = new Promise<never>((_, reject) => {
      const rejectAbort = () => reject(new Error(String(controller.signal.reason ?? 'aborted')));
      if (controller.signal.aborted) rejectAbort();
      else controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const events = await Promise.race([
      runner.run({
        approvalPolicy: request.approval_policy,
        lease,
        policy,
        signal: controller.signal,
        steps,
      }),
      aborted,
    ]);
    const downloadResults = await Promise.all(pendingDownloads);
    downloadCancellationsSettled = true;
    const downloadErrors = downloadResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (downloadErrors.length > 0) {
      throw new AggregateError(downloadErrors, 'browser download cancellation failed');
    }
    if (downloadCount > browserWorkerConfig.maxDownloads) {
      throw new Error('browser download count limit exceeded');
    }
    actionEvents = events;
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    if (error instanceof BrowserKillSwitchError) {
      killAudit ??= startKillAudit('generation_changed');
    }
  } finally {
    heartbeatController?.abort('browser execution finalizing');
    if (heartbeatLoop !== undefined) {
      const heartbeatResult = await settleWithin(heartbeatLoop, Math.min(runtimeLimitMs, 1_000));
      if (heartbeatResult.status === 'rejected') cleanupErrors.push(heartbeatResult.reason);
    }
    if (stopHeartbeatOnExecutionAbort !== undefined) {
      controller.signal.removeEventListener('abort', stopHeartbeatOnExecutionAbort);
    }
    rawInput.heartbeat?.closeLease?.(lease.lease_id);
    if (heartbeatFailure !== undefined) {
      hasPrimaryError = true;
      primaryError = heartbeatFailure;
    }
    clearTimeout(timeout);
    rawInput.signal.removeEventListener('abort', onCallerAbort);
    rawInput.killSwitchSignal?.removeEventListener('abort', onKillSwitchAbort);
    if (!downloadCancellationsSettled && pendingDownloads.size > 0) {
      const downloadResults = await Promise.all(
        [...pendingDownloads].map((operation) =>
          settleWithin(operation, Math.min(runtimeLimitMs, 1_000)),
        ),
      );
      for (const result of downloadResults) {
        if (result.status === 'rejected') cleanupErrors.push(result.reason);
        else if (result.value.status === 'rejected') cleanupErrors.push(result.value.reason);
      }
    }
    if (lateCleanupOperations.length > 0) {
      const lateCleanupResults = await Promise.all(
        lateCleanupOperations.map((operation) =>
          settleWithin(operation, Math.min(runtimeLimitMs, 1_000)),
        ),
      );
      for (const result of lateCleanupResults) {
        if (result.status === 'rejected') cleanupErrors.push(result.reason);
        else if (result.value.status === 'rejected') cleanupErrors.push(result.value.reason);
      }
    }
    const results = await Promise.all(
      [session?.close(), browser?.close(), proxy?.close(), killAudit]
        .filter((operation): operation is Promise<void> => operation !== undefined)
        .map((operation) => settleWithin(operation, Math.min(runtimeLimitMs, 1_000))),
    );
    cleanupErrors.push(
      ...results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason),
    );
    if (cleanupErrors.length > 0) {
      let auditError: unknown;
      const auditResult = await settleWithin(
        rawInput.auditSink.write(
          workerAuditIntent(lease, 'job_failed', {
            cleanup_error_count: cleanupErrors.length,
            project_id: lease.project_id,
          }),
        ),
        Math.min(runtimeLimitMs, 1_000),
      );
      if (auditResult.status === 'rejected') auditError = auditResult.reason;
      const finalizationErrors =
        auditError === undefined ? cleanupErrors : [...cleanupErrors, auditError];
      if (primaryError instanceof Error) {
        if (primaryError.cause === undefined) {
          Object.defineProperty(primaryError, 'cause', {
            configurable: true,
            value: new AggregateError(finalizationErrors, 'browser worker finalization failed'),
          });
        }
      } else if (!hasPrimaryError) {
        cleanupFailure = new AggregateError(finalizationErrors, 'browser worker cleanup failed');
      }
    }
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (actionEvents === undefined) throw new Error('browser worker completed without action events');
  return actionEvents;
}

export function startFailClosedWorkerServer(port = browserWorkerConfig.port) {
  return Bun.serve({
    hostname: '0.0.0.0',
    port,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        return Response.json({ status: 'waiting_for_authenticated_source' }, { status: 503 });
      }
      return Response.json({ code: 'AUTHENTICATED_SOURCE_REQUIRED' }, { status: 503 });
    },
  });
}

if (import.meta.main) {
  startFailClosedWorkerServer();
}
