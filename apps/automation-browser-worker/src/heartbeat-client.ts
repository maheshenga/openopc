import { createHash, createHmac } from 'node:crypto';
import {
  AUTOMATION_BROWSER_HEARTBEAT_PATH,
  AutomationErrorSchema,
  type AutomationEvent,
  type AutomationJobRequest,
  AutomationJobRequestSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  type AutomationWorkerHeartbeat,
  AutomationWorkerHeartbeatAcceptedSchema,
  AutomationWorkerHeartbeatSchema,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from '@kortix/intelligence-contracts';
import type { BrowserWorkerHeartbeatConfig } from './config';

const MAX_RESPONSE_BYTES = 64 * 1024;

export type BrowserWorkerHeartbeatTransport = (
  input: string | URL,
  init: RequestInit,
) => Promise<Response>;

export type BrowserWorkerHeartbeatSendInput = Readonly<{
  lease: AutomationLease;
  request: AutomationJobRequest;
  lastCompletedStep: number;
  signal?: AbortSignal;
}>;

export type BrowserWorkerHeartbeatEmitter = Readonly<{
  intervalMs: number;
  send(input: BrowserWorkerHeartbeatSendInput): Promise<AutomationEvent>;
  closeLease?(leaseId: string): void;
}>;

export class BrowserWorkerHeartbeatClientError extends Error {
  override readonly name = 'BrowserWorkerHeartbeatClientError';

  constructor(
    readonly reason: 'configuration' | 'transport' | 'protocol' | 'rejected',
    message: string,
    readonly response?: Readonly<{
      status: number;
      code: string;
      retryable: boolean;
    }>,
  ) {
    super(message);
  }
}

type EnabledHeartbeatConfig = Extract<BrowserWorkerHeartbeatConfig, { enabled: true }>;

function assertClientOptions(input: {
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  intervalMs: number;
  requestTimeoutMs: number;
}): URL {
  let controlUrl: URL;
  try {
    controlUrl = new URL(input.controlUrl);
  } catch {
    throw new BrowserWorkerHeartbeatClientError(
      'configuration',
      'Browser Worker heartbeat control URL is invalid',
    );
  }
  if (
    controlUrl.protocol !== 'https:' ||
    controlUrl.username !== '' ||
    controlUrl.password !== '' ||
    controlUrl.pathname !== '/' ||
    controlUrl.search !== '' ||
    controlUrl.hash !== '' ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input.serviceId) ||
    input.certificateFingerprint256.length < 1 ||
    input.certificateFingerprint256.length > 256 ||
    /[\r\n]/.test(input.certificateFingerprint256) ||
    input.sharedSecret.length < 32 ||
    input.sharedSecret.length > 4_096 ||
    !Number.isSafeInteger(input.intervalMs) ||
    input.intervalMs < 1 ||
    input.intervalMs > 60_000 ||
    !Number.isSafeInteger(input.requestTimeoutMs) ||
    input.requestTimeoutMs < 1 ||
    input.requestTimeoutMs > 30_000
  ) {
    throw new BrowserWorkerHeartbeatClientError(
      'configuration',
      'Browser Worker heartbeat client configuration is invalid',
    );
  }
  return new URL(AUTOMATION_BROWSER_HEARTBEAT_PATH, controlUrl);
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) {
      throw new BrowserWorkerHeartbeatClientError(
        'protocol',
        'Browser Worker heartbeat response is invalid',
      );
    }
  }
  if (response.body === null) {
    throw new BrowserWorkerHeartbeatClientError(
      'protocol',
      'Browser Worker heartbeat response is invalid',
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(
        new BrowserWorkerHeartbeatClientError(
          'transport',
          'Browser Worker heartbeat transport failed',
        ),
      );
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel('Browser Worker heartbeat response is too large').catch(() => {});
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker heartbeat response is invalid',
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel('Browser Worker heartbeat response read failed').catch(() => {});
    if (error instanceof BrowserWorkerHeartbeatClientError) throw error;
    throw new BrowserWorkerHeartbeatClientError(
      'transport',
      'Browser Worker heartbeat transport failed',
    );
  } finally {
    if (rejectAbort !== undefined) signal.removeEventListener('abort', rejectAbort);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new BrowserWorkerHeartbeatClientError(
      'protocol',
      'Browser Worker heartbeat response is invalid',
    );
  }
}

function createRequestSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason ?? 'browser execution aborted');
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => controller.abort('heartbeat request timed out'), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

export function createBrowserWorkerMtlsHeartbeatTransport(
  config: EnabledHeartbeatConfig,
  baseFetch: (input: string | URL, init: BunFetchRequestInit) => Promise<Response> = fetch,
): BrowserWorkerHeartbeatTransport {
  const tls = Object.freeze({
    cert: Bun.file(config.mtlsCertificatePath),
    key: Bun.file(config.mtlsPrivateKeyPath),
    ca: Bun.file(config.mtlsCaPath),
    rejectUnauthorized: true,
    serverName: new URL(config.controlUrl).hostname,
  });
  return (input, init) => baseFetch(input, { ...init, tls });
}

export function createBrowserWorkerHeartbeatClient(input: {
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  intervalMs?: number;
  requestTimeoutMs?: number;
  transport: BrowserWorkerHeartbeatTransport;
  now?: () => Date;
  nextNonce?: () => number;
}): BrowserWorkerHeartbeatEmitter {
  const intervalMs = input.intervalMs ?? 10_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 5_000;
  const endpoint = assertClientOptions({ ...input, intervalMs, requestTimeoutMs });
  const transport = input.transport;
  const now = input.now ?? (() => new Date());
  let lastNonce = 0;
  const nextNonce =
    input.nextNonce ??
    (() => {
      const timestampFloor = now().getTime() * 1_000;
      lastNonce = Math.max(lastNonce + 1, timestampFloor);
      return lastNonce;
    });
  const leaseStates = new Map<
    string,
    { nextOrdinal: number; failed: boolean; tail: Promise<void> }
  >();
  const closedLeaseIds = new Set<string>();

  const send = async (raw: BrowserWorkerHeartbeatSendInput): Promise<AutomationEvent> => {
    const lease = AutomationLeaseSchema.parse(raw.lease);
    const request = AutomationJobRequestSchema.parse(raw.request);
    if (
      lease.execution_domain !== 'browser' ||
      lease.job_id.length === 0 ||
      lease.project_id !== request.project_id ||
      !lease.owner.endsWith(`:${lease.lease_id}`) ||
      !Number.isSafeInteger(raw.lastCompletedStep) ||
      raw.lastCompletedStep < 0 ||
      raw.lastCompletedStep > request.steps.length
    ) {
      throw new BrowserWorkerHeartbeatClientError(
        'protocol',
        'Browser Worker heartbeat binding is invalid',
      );
    }
    if (closedLeaseIds.has(lease.lease_id)) {
      throw new BrowserWorkerHeartbeatClientError(
        'protocol',
        'Browser Worker heartbeat lease is already closed',
      );
    }
    const state = leaseStates.get(lease.lease_id) ?? {
      nextOrdinal: 1,
      failed: false,
      tail: Promise.resolve(),
    };
    leaseStates.set(lease.lease_id, state);

    const operation = state.tail.then(async () => {
      if (state.failed) {
        throw new BrowserWorkerHeartbeatClientError(
          'transport',
          'Browser Worker heartbeat stream is no longer usable',
        );
      }
      const observedAt = now();
      if (
        !Number.isFinite(observedAt.getTime()) ||
        Date.parse(lease.expires_at) <= observedAt.getTime() ||
        Date.parse(request.deadline_at) <= observedAt.getTime()
      ) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker heartbeat lease is expired',
        );
      }
      const ordinal = state.nextOrdinal;
      state.nextOrdinal += 1;
      const heartbeat: AutomationWorkerHeartbeat = AutomationWorkerHeartbeatSchema.parse({
        protocol_version: 'automation.v1',
        account_id: request.tenant_id,
        project_id: lease.project_id,
        job_id: lease.job_id,
        lease_id: lease.lease_id,
        lease_owner: lease.owner,
        kill_switch_generation: lease.kill_switch_generation,
        worker_id: input.serviceId,
        ordinal,
        observed_at: observedAt.toISOString(),
        event: {
          type: 'heartbeat',
          payload: { last_completed_step: raw.lastCompletedStep },
          trace_id: null,
        },
      });
      const nonce = nextNonce();
      if (!Number.isSafeInteger(nonce) || nonce < 1) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'configuration',
          'Browser Worker heartbeat nonce source is invalid',
        );
      }
      const bodySha256 = createHash('sha256')
        .update(canonicalAutomationRequestJson(heartbeat))
        .digest('hex');
      const signature = createHmac('sha256', input.sharedSecret)
        .update(
          canonicalAutomationWorkerProof({
            timestamp: heartbeat.observed_at,
            serviceId: input.serviceId,
            certificateFingerprint256: input.certificateFingerprint256,
            nonce,
            bodySha256,
          }),
        )
        .digest('hex');
      const body = JSON.stringify({
        protocol_version: 'automation.v1',
        proof: {
          service_id: input.serviceId,
          timestamp: heartbeat.observed_at,
          nonce,
          signature: `hmac-sha256:${signature}`,
        },
        heartbeat,
      });
      const requestSignal = createRequestSignal(raw.signal, requestTimeoutMs);
      let response: Response;
      let responseBody: unknown;
      try {
        if (requestSignal.signal.aborted) {
          throw new BrowserWorkerHeartbeatClientError(
            'transport',
            'Browser Worker heartbeat transport failed',
          );
        }
        response = await transport(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: requestSignal.signal,
        });
        responseBody = await readBoundedJson(response, requestSignal.signal);
      } catch (error) {
        state.failed = true;
        if (error instanceof BrowserWorkerHeartbeatClientError) throw error;
        throw new BrowserWorkerHeartbeatClientError(
          'transport',
          'Browser Worker heartbeat transport failed',
        );
      } finally {
        requestSignal.cleanup();
      }
      if (!response.ok) {
        state.failed = true;
        const error = AutomationErrorSchema.safeParse(responseBody);
        if (!error.success) {
          throw new BrowserWorkerHeartbeatClientError(
            'protocol',
            'Browser Worker heartbeat response is invalid',
          );
        }
        throw new BrowserWorkerHeartbeatClientError(
          'rejected',
          'Browser Worker heartbeat was rejected',
          { status: response.status, code: error.data.code, retryable: error.data.retryable },
        );
      }
      const accepted = AutomationWorkerHeartbeatAcceptedSchema.safeParse(responseBody);
      if (
        !accepted.success ||
        accepted.data.event.job_id !== heartbeat.job_id ||
        accepted.data.event.type !== 'heartbeat' ||
        accepted.data.event.status !== null ||
        canonicalAutomationRequestJson(accepted.data.event.payload) !==
          canonicalAutomationRequestJson(heartbeat.event.payload)
      ) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker heartbeat response is invalid',
        );
      }
      return accepted.data.event;
    });
    state.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return Object.freeze({
    intervalMs,
    send,
    closeLease(leaseId: string) {
      const state = leaseStates.get(leaseId);
      if (state !== undefined) state.failed = true;
      leaseStates.delete(leaseId);
      closedLeaseIds.add(leaseId);
      if (closedLeaseIds.size > 1_024) {
        const oldest = closedLeaseIds.values().next().value;
        if (oldest !== undefined) closedLeaseIds.delete(oldest);
      }
    },
  });
}

export function createConfiguredBrowserWorkerHeartbeatClient(
  config: BrowserWorkerHeartbeatConfig,
): BrowserWorkerHeartbeatEmitter | undefined {
  if (!config.enabled) return undefined;
  return createBrowserWorkerHeartbeatClient({
    controlUrl: config.controlUrl,
    serviceId: config.serviceId,
    certificateFingerprint256: config.certificateFingerprint256,
    sharedSecret: config.sharedSecret,
    intervalMs: config.intervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
    transport: createBrowserWorkerMtlsHeartbeatTransport(config),
  });
}

function waitForInterval(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runBrowserWorkerHeartbeatLoop(input: {
  emitter: BrowserWorkerHeartbeatEmitter;
  lease: AutomationLease;
  request: AutomationJobRequest;
  getLastCompletedStep: () => number;
  signal: AbortSignal;
}): Promise<void> {
  while (!input.signal.aborted) {
    await waitForInterval(input.emitter.intervalMs, input.signal);
    if (input.signal.aborted) return;
    await input.emitter.send({
      lease: input.lease,
      request: input.request,
      lastCompletedStep: input.getLastCompletedStep(),
      signal: input.signal,
    });
  }
}
