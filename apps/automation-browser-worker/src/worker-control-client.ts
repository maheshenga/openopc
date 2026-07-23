import { createHash, createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  type AutomationError,
  AutomationErrorSchema,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from '@kortix/intelligence-contracts';

const MAX_RESPONSE_BYTES = 64 * 1024;

type SafeParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{ success: false; error?: unknown }>;

export type WorkerControlResponseSchema<T> = Readonly<{
  safeParse(input: unknown): SafeParseResult<T>;
}>;

export type WorkerControlTransport = (
  input: string | URL,
  init: BunFetchRequestInit,
) => Promise<Response>;

export class WorkerControlClientError extends Error {
  override readonly name = 'WorkerControlClientError';

  constructor(
    readonly reason: 'configuration' | 'transport' | 'protocol' | 'rejected',
    message: string,
    readonly response?: Readonly<{ status: number; code: string; retryable: boolean }>,
  ) {
    super(message);
  }
}

export type WorkerControlResponse<T> =
  | Readonly<{ status: number; ok: true; body: T }>
  | Readonly<{ status: number; ok: false; body: AutomationError }>;

export type WorkerControlClient = Readonly<{
  request<T>(input: {
    path: string;
    bodyKey: string;
    body: unknown;
    schema: WorkerControlResponseSchema<T>;
    signal?: AbortSignal;
  }): Promise<WorkerControlResponse<T>>;
}>;

export type WorkerControlClientInput = Readonly<{
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  requestTimeoutMs: number;
  transport: WorkerControlTransport;
  nextNonce: () => number;
  now?: () => Date;
}>;

function controlOrigin(controlUrlText: string): URL {
  let controlUrl: URL;
  try {
    controlUrl = new URL(controlUrlText);
  } catch {
    throw new WorkerControlClientError(
      'configuration',
      'Worker Control client configuration is invalid',
    );
  }
  if (
    controlUrl.protocol !== 'https:' ||
    controlUrl.username !== '' ||
    controlUrl.password !== '' ||
    controlUrl.pathname !== '/' ||
    controlUrl.search !== '' ||
    controlUrl.hash !== ''
  ) {
    throw new WorkerControlClientError(
      'configuration',
      'Worker Control client configuration is invalid',
    );
  }
  return controlUrl;
}

function assertClientOptions(input: WorkerControlClientInput): URL {
  const origin = controlOrigin(input.controlUrl);
  if (
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(input.serviceId) ||
    input.certificateFingerprint256.length < 1 ||
    input.certificateFingerprint256.length > 256 ||
    /[\r\n]/.test(input.certificateFingerprint256) ||
    input.sharedSecret.length < 32 ||
    input.sharedSecret.length > 4_096 ||
    !Number.isSafeInteger(input.requestTimeoutMs) ||
    input.requestTimeoutMs < 1 ||
    input.requestTimeoutMs > 30_000
  ) {
    throw new WorkerControlClientError(
      'configuration',
      'Worker Control client configuration is invalid',
    );
  }
  return origin;
}

function requestPath(origin: URL, path: string): URL {
  if (!path.startsWith('/') || path.startsWith('//') || /[\r\n]/.test(path) || path.length > 512) {
    throw new WorkerControlClientError('configuration', 'Worker Control request path is invalid');
  }
  let endpoint: URL;
  try {
    endpoint = new URL(path, origin);
  } catch {
    throw new WorkerControlClientError('configuration', 'Worker Control request path is invalid');
  }
  if (
    endpoint.origin !== origin.origin ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new WorkerControlClientError('configuration', 'Worker Control request path is invalid');
  }
  return endpoint;
}

function requestBodyKey(bodyKey: string): string {
  if (
    !/^[a-z][a-z0-9_]{0,63}$/.test(bodyKey) ||
    bodyKey === 'proof' ||
    bodyKey === 'protocol_version'
  ) {
    throw new WorkerControlClientError('configuration', 'Worker Control request body is invalid');
  }
  return bodyKey;
}

function requestSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  aborted: Promise<never>;
  cleanup(): void;
} {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(caller?.reason ?? 'worker Control request aborted');
  if (caller?.aborted) onCallerAbort();
  else caller?.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => controller.abort('worker Control request timed out'), timeoutMs);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(new WorkerControlClientError('transport', 'Worker Control request failed'));
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  void aborted.catch(() => undefined);
  return {
    signal: controller.signal,
    aborted,
    cleanup() {
      clearTimeout(timeout);
      caller?.removeEventListener('abort', onCallerAbort);
      controller.signal.removeEventListener('abort', onAbort);
    },
  };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) {
      throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
    }
  }
  if (response.body === null) {
    throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(new WorkerControlClientError('transport', 'Worker Control request failed'));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener('abort', rejectAbort, { once: true });
  });
  void aborted.catch(() => undefined);
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel('Worker Control response is too large').catch(() => undefined);
        throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel('Worker Control response read failed').catch(() => undefined);
    if (error instanceof WorkerControlClientError) throw error;
    throw new WorkerControlClientError('transport', 'Worker Control request failed');
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
    throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
  }
}

export function createWorkerProofNonceSource(now: () => Date = () => new Date()): () => number {
  let lastNonce = 0;
  return () => {
    let timestamp: Date;
    try {
      timestamp = now();
    } catch {
      throw new WorkerControlClientError('configuration', 'Worker Control clock is invalid');
    }
    const timestampFloor = timestamp.getTime() * 1_000;
    const next = Math.max(lastNonce + 1, timestampFloor);
    if (!Number.isSafeInteger(next) || next < 1) {
      throw new WorkerControlClientError('configuration', 'Worker Control nonce source is invalid');
    }
    lastNonce = next;
    return next;
  };
}

export function createWorkerControlClient(input: WorkerControlClientInput): WorkerControlClient {
  const origin = assertClientOptions(input);
  const now = input.now ?? (() => new Date());
  let lastNonce = 0;

  return Object.freeze({
    async request<T>(call: {
      path: string;
      bodyKey: string;
      body: unknown;
      schema: WorkerControlResponseSchema<T>;
      signal?: AbortSignal;
    }) {
      const endpoint = requestPath(origin, call.path);
      const bodyKey = requestBodyKey(call.bodyKey);
      const request = requestSignal(call.signal, input.requestTimeoutMs);
      try {
        if (request.signal.aborted) {
          throw new WorkerControlClientError('transport', 'Worker Control request failed');
        }
        let timestamp: Date;
        try {
          timestamp = now();
        } catch {
          throw new WorkerControlClientError('configuration', 'Worker Control clock is invalid');
        }
        if (!Number.isFinite(timestamp.getTime())) {
          throw new WorkerControlClientError('configuration', 'Worker Control clock is invalid');
        }
        let nonce: number;
        try {
          nonce = input.nextNonce();
        } catch (error) {
          if (error instanceof WorkerControlClientError) throw error;
          throw new WorkerControlClientError('configuration', 'Worker Control nonce is invalid');
        }
        if (!Number.isSafeInteger(nonce) || nonce < 1 || nonce <= lastNonce) {
          throw new WorkerControlClientError('configuration', 'Worker Control nonce is invalid');
        }
        lastNonce = nonce;
        let bodySha256: string;
        try {
          bodySha256 = createHash('sha256')
            .update(canonicalAutomationRequestJson(call.body))
            .digest('hex');
        } catch {
          throw new WorkerControlClientError('protocol', 'Worker Control request is invalid');
        }
        const timestampText = timestamp.toISOString();
        const signature = createHmac('sha256', input.sharedSecret)
          .update(
            canonicalAutomationWorkerProof({
              timestamp: timestampText,
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
            timestamp: timestampText,
            nonce,
            signature: `hmac-sha256:${signature}`,
          },
          [bodyKey]: call.body,
        });

        let response: Response;
        let responseBody: unknown;
        try {
          response = await Promise.race([
            input.transport(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body,
              redirect: 'error',
              signal: request.signal,
            }),
            request.aborted,
          ]);
          if (request.signal.aborted) {
            throw new WorkerControlClientError('transport', 'Worker Control request failed');
          }
          responseBody = await readBoundedJson(response, request.signal);
          if (request.signal.aborted) {
            throw new WorkerControlClientError('transport', 'Worker Control request failed');
          }
        } catch (error) {
          if (error instanceof WorkerControlClientError) throw error;
          throw new WorkerControlClientError('transport', 'Worker Control request failed');
        }

        if (!response.ok) {
          const error = AutomationErrorSchema.safeParse(responseBody);
          if (!error.success) {
            throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
          }
          return {
            status: response.status,
            ok: false,
            body: { ...error.data, message: 'Worker Control request was rejected' },
          } as const;
        }
        let parsed: SafeParseResult<T>;
        try {
          parsed = call.schema.safeParse(responseBody);
        } catch {
          throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
        }
        if (!parsed.success) {
          throw new WorkerControlClientError('protocol', 'Worker Control response is invalid');
        }
        return { status: response.status, ok: true, body: parsed.data } as const;
      } finally {
        request.cleanup();
      }
    },
  });
}

export function createWorkerControlMtlsTransport(input: {
  controlUrl: string;
  mtlsCertificatePath: string;
  mtlsPrivateKeyPath: string;
  mtlsCaPath: string;
  baseFetch?: WorkerControlTransport;
}): WorkerControlTransport {
  const endpoint = controlOrigin(input.controlUrl);
  if (
    !isAbsolute(input.mtlsCertificatePath) ||
    !isAbsolute(input.mtlsPrivateKeyPath) ||
    !isAbsolute(input.mtlsCaPath)
  ) {
    throw new WorkerControlClientError(
      'configuration',
      'Worker Control mTLS paths must be absolute',
    );
  }
  const fetcher = input.baseFetch ?? fetch;
  const tls = {
    cert: Bun.file(input.mtlsCertificatePath),
    key: Bun.file(input.mtlsPrivateKeyPath),
    ca: Bun.file(input.mtlsCaPath),
    rejectUnauthorized: true,
    serverName: endpoint.hostname,
  };
  return (url, init) => fetcher(url, { ...init, tls });
}
