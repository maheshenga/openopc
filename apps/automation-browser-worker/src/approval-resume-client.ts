import { createHash, createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  AutomationBrowserApprovalConsumeAcceptedSchema,
  type AutomationBrowserApprovalConsumeInput,
  AutomationBrowserApprovalConsumeInputSchema,
  AutomationErrorSchema,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from '@kortix/intelligence-contracts';

const MAX_RESPONSE_BYTES = 64 * 1024;

export type BrowserApprovalResumeTransport = (
  input: string | URL,
  init: BunFetchRequestInit,
) => Promise<Response>;

export type BrowserApprovalResumeClient = Readonly<{
  consume(input: AutomationBrowserApprovalConsumeInput): Promise<
    Readonly<{
      consumed: true;
      idempotent: boolean;
      approvalId: string;
      attemptId: string;
      jobId: string;
      stepId: string;
      startedAt: string;
    }>
  >;
}>;

export class BrowserApprovalResumeClientError extends Error {
  override readonly name = 'BrowserApprovalResumeClientError';

  constructor(
    readonly reason: 'configuration' | 'transport' | 'protocol' | 'rejected',
    message: string,
    readonly response?: Readonly<{ status: number; code: string; retryable: boolean }>,
  ) {
    super(message);
  }
}

function controlEndpoint(controlUrlText: string): URL {
  let controlUrl: URL;
  try {
    controlUrl = new URL(controlUrlText);
  } catch {
    throw new BrowserApprovalResumeClientError(
      'configuration',
      'Browser approval resume Control URL is invalid',
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
    throw new BrowserApprovalResumeClientError(
      'configuration',
      'Browser approval resume Control URL is invalid',
    );
  }
  return new URL(AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH, controlUrl);
}

function assertClientOptions(input: {
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  requestTimeoutMs: number;
}): URL {
  const endpoint = controlEndpoint(input.controlUrl);
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
    throw new BrowserApprovalResumeClientError(
      'configuration',
      'Browser approval resume client configuration is invalid',
    );
  }
  return endpoint;
}

function requestSignal(timeoutMs: number): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort('approval resume request timed out'),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
    },
  };
}

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAX_RESPONSE_BYTES) {
      throw new BrowserApprovalResumeClientError(
        'protocol',
        'Browser approval resume response is invalid',
      );
    }
  }
  if (response.body === null) {
    throw new BrowserApprovalResumeClientError(
      'protocol',
      'Browser approval resume response is invalid',
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () =>
      reject(
        new BrowserApprovalResumeClientError(
          'transport',
          'Browser approval resume transport failed',
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
        void reader.cancel('Browser approval resume response is too large').catch(() => {});
        throw new BrowserApprovalResumeClientError(
          'protocol',
          'Browser approval resume response is invalid',
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel('Browser approval resume response read failed').catch(() => {});
    if (error instanceof BrowserApprovalResumeClientError) throw error;
    throw new BrowserApprovalResumeClientError(
      'transport',
      'Browser approval resume transport failed',
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
    throw new BrowserApprovalResumeClientError(
      'protocol',
      'Browser approval resume response is invalid',
    );
  }
}

export function createBrowserApprovalResumeClient(input: {
  controlUrl: string;
  serviceId: string;
  certificateFingerprint256: string;
  sharedSecret: string;
  requestTimeoutMs: number;
  transport: BrowserApprovalResumeTransport;
  nextNonce: () => number;
  now?: () => Date;
}): BrowserApprovalResumeClient {
  const endpoint = assertClientOptions(input);
  const now = input.now ?? (() => new Date());
  let lastNonce = 0;

  return Object.freeze({
    async consume(rawInput) {
      const consume = AutomationBrowserApprovalConsumeInputSchema.parse(rawInput);
      const timestamp = now();
      if (!Number.isFinite(timestamp.getTime())) {
        throw new BrowserApprovalResumeClientError(
          'configuration',
          'Browser approval resume clock is invalid',
        );
      }
      const nonce = input.nextNonce();
      if (!Number.isSafeInteger(nonce) || nonce < 1 || nonce <= lastNonce) {
        throw new BrowserApprovalResumeClientError(
          'configuration',
          'Browser approval resume nonce is invalid',
        );
      }
      lastNonce = nonce;
      const timestampText = timestamp.toISOString();
      const bodySha256 = createHash('sha256')
        .update(canonicalAutomationRequestJson(consume))
        .digest('hex');
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
        consume,
      });

      const request = requestSignal(input.requestTimeoutMs);
      let response: Response;
      let responseBody: unknown;
      try {
        response = await input.transport(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: request.signal,
        });
        responseBody = await readBoundedJson(response, request.signal);
      } catch (error) {
        if (error instanceof BrowserApprovalResumeClientError) throw error;
        throw new BrowserApprovalResumeClientError(
          'transport',
          'Browser approval resume transport failed',
        );
      } finally {
        request.cleanup();
      }

      if (!response.ok) {
        const error = AutomationErrorSchema.safeParse(responseBody);
        if (!error.success) {
          throw new BrowserApprovalResumeClientError(
            'protocol',
            'Browser approval resume response is invalid',
          );
        }
        throw new BrowserApprovalResumeClientError(
          'rejected',
          'Browser approval resume was rejected',
          { status: response.status, code: error.data.code, retryable: error.data.retryable },
        );
      }

      const accepted = AutomationBrowserApprovalConsumeAcceptedSchema.safeParse(responseBody);
      if (
        !accepted.success ||
        accepted.data.approval_id !== consume.approval_id ||
        accepted.data.attempt_id !== consume.attempt_id ||
        accepted.data.job_id !== consume.job_id ||
        accepted.data.step_id !== consume.step_id
      ) {
        throw new BrowserApprovalResumeClientError(
          'protocol',
          'Browser approval resume response is invalid',
        );
      }
      return {
        consumed: true,
        idempotent: accepted.data.idempotent,
        approvalId: accepted.data.approval_id,
        attemptId: accepted.data.attempt_id,
        jobId: accepted.data.job_id,
        stepId: accepted.data.step_id,
        startedAt: accepted.data.started_at,
      };
    },
  });
}

export function createBrowserApprovalResumeMtlsTransport(input: {
  controlUrl: string;
  mtlsCertificatePath: string;
  mtlsPrivateKeyPath: string;
  mtlsCaPath: string;
  baseFetch?: BrowserApprovalResumeTransport;
}): BrowserApprovalResumeTransport {
  const endpoint = controlEndpoint(input.controlUrl);
  if (
    !isAbsolute(input.mtlsCertificatePath) ||
    !isAbsolute(input.mtlsPrivateKeyPath) ||
    !isAbsolute(input.mtlsCaPath)
  ) {
    throw new BrowserApprovalResumeClientError(
      'configuration',
      'Browser approval resume mTLS paths must be absolute',
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
