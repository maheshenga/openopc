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

export type BrowserWorkerEventSendInput = Readonly<{
  lease: AutomationLease;
  request: AutomationJobRequest;
  event: AutomationWorkerHeartbeat['event'];
  signal?: AbortSignal;
}>;

export type BrowserWorkerHeartbeatEmitter = Readonly<{
  intervalMs: number;
  emit?(input: BrowserWorkerEventSendInput): Promise<AutomationEvent>;
  send(input: BrowserWorkerHeartbeatSendInput): Promise<AutomationEvent>;
  closeLease?(leaseId: string): void;
}>;

export type BrowserWorkerAuthenticatedEventEmitter = BrowserWorkerHeartbeatEmitter &
  Readonly<{
    emit(input: BrowserWorkerEventSendInput): Promise<AutomationEvent>;
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

const SENSITIVE_KEY =
  /authorization|cookies?|credentials?|passwords?|secrets?|tokens?|apikeys?|clientsecret|sessioncookie|(?:pre)?signedurls?/;

function containsSensitiveKey(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveKey(entry, seen));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) =>
      SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, '')) ||
      containsSensitiveKey(entry, seen),
  );
}

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
}): BrowserWorkerAuthenticatedEventEmitter {
  const intervalMs = input.intervalMs ?? 10_000;
  const requestTimeoutMs = input.requestTimeoutMs ?? 5_000;
  const endpoint = assertClientOptions({
    ...input,
    intervalMs,
    requestTimeoutMs,
  });
  const transport = input.transport;
  const now = input.now ?? (() => new Date());
  let lastGeneratedNonce = 0;
  const nextNonce =
    input.nextNonce ??
    (() => {
      const timestampFloor = now().getTime() * 1_000;
      lastGeneratedNonce = Math.max(lastGeneratedNonce + 1, timestampFloor);
      return lastGeneratedNonce;
    });
  let lastIssuedNonce = 0;
  const leaseStates = new Map<string, { nextOrdinal: number; failed: boolean }>();
  const closedLeaseIds = new Set<string>();
  let tail: Promise<void> = Promise.resolve();

  const emit = async (raw: BrowserWorkerEventSendInput): Promise<AutomationEvent> => {
    const parsedLease = AutomationLeaseSchema.safeParse(raw.lease);
    const parsedRequest = AutomationJobRequestSchema.safeParse(raw.request);
    if (!parsedLease.success || !parsedRequest.success) {
      throw new BrowserWorkerHeartbeatClientError(
        'protocol',
        'Browser Worker heartbeat binding is invalid',
      );
    }
    const lease = parsedLease.data;
    const request = parsedRequest.data;
    if (
      lease.execution_domain !== 'browser' ||
      lease.job_id.length === 0 ||
      lease.project_id !== request.project_id ||
      !lease.owner.endsWith(`:${lease.lease_id}`) ||
      (raw.event.type === 'heartbeat' &&
        raw.event.payload.last_completed_step > request.steps.length)
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
    };
    leaseStates.set(lease.lease_id, state);

    const operation = tail.then(async () => {
      if (state.failed) {
        throw new BrowserWorkerHeartbeatClientError(
          'transport',
          'Browser Worker heartbeat stream is no longer usable',
        );
      }
      let hasSensitiveKey: boolean;
      try {
        hasSensitiveKey = containsSensitiveKey(raw.event.payload);
      } catch {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker event payload is invalid',
        );
      }
      if (hasSensitiveKey) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker event payload is invalid',
        );
      }
      let observedAt: Date;
      try {
        observedAt = now();
      } catch {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'transport',
          'Browser Worker heartbeat transport failed',
        );
      }
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
      const parsedHeartbeat = AutomationWorkerHeartbeatSchema.safeParse({
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
        event: raw.event,
      });
      if (!parsedHeartbeat.success) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker event payload is invalid',
        );
      }
      const heartbeat: AutomationWorkerHeartbeat = parsedHeartbeat.data;
      let nonce: number;
      try {
        nonce = nextNonce();
      } catch {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'configuration',
          'Browser Worker heartbeat nonce source is invalid',
        );
      }
      if (!Number.isSafeInteger(nonce) || nonce < 1 || nonce <= lastIssuedNonce) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'configuration',
          'Browser Worker heartbeat nonce source is invalid',
        );
      }
      lastIssuedNonce = nonce;
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
          {
            status: response.status,
            code: error.data.code,
            retryable: error.data.retryable,
          },
        );
      }
      const accepted = AutomationWorkerHeartbeatAcceptedSchema.safeParse(responseBody);
      if (
        !accepted.success ||
        accepted.data.event.job_id !== heartbeat.job_id ||
        accepted.data.event.type !== heartbeat.event.type ||
        canonicalAutomationRequestJson(accepted.data.event.payload) !==
          canonicalAutomationRequestJson(heartbeat.event.payload) ||
        accepted.data.event.trace_id !== heartbeat.event.trace_id
      ) {
        state.failed = true;
        throw new BrowserWorkerHeartbeatClientError(
          'protocol',
          'Browser Worker heartbeat response is invalid',
        );
      }
      return accepted.data.event;
    });
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const send = (raw: BrowserWorkerHeartbeatSendInput): Promise<AutomationEvent> =>
    emit({
      lease: raw.lease,
      request: raw.request,
      signal: raw.signal,
      event: {
        type: 'heartbeat',
        payload: { last_completed_step: raw.lastCompletedStep },
        trace_id: null,
      },
    });

  return Object.freeze({
    intervalMs,
    emit,
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
): BrowserWorkerAuthenticatedEventEmitter | undefined {
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
