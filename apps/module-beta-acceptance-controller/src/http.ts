import { timingSafeEqual } from 'node:crypto';

import {
  type ModuleBetaArtifactRegistrationRequestV1,
  type ModuleBetaArtifactRegistrationResponseV1,
  type ModuleBetaCleanupRequestV1,
  type ModuleBetaCleanupResponseV1,
  type ModuleBetaInspectorEvidenceV1,
  parseModuleBetaArtifactRegistrationRequest,
  parseModuleBetaArtifactRegistrationResponse,
  parseModuleBetaCleanupRequest,
  parseModuleBetaCleanupResponse,
  parseModuleBetaInspectorEvidence,
} from '@openopc/module-runtime-contracts';

export interface ModuleBetaAcceptancePort {
  registerArtifact(
    input: ModuleBetaArtifactRegistrationRequestV1,
  ): Promise<ModuleBetaArtifactRegistrationResponseV1>;
  inspect(input: {
    acceptanceRunId: string;
    runId: string;
  }): Promise<ModuleBetaInspectorEvidenceV1 | null>;
  cleanup(
    input: ModuleBetaCleanupRequestV1,
  ): Promise<ModuleBetaCleanupResponseV1 | ModuleBetaCleanupPendingResponseV1>;
}

export interface ModuleBetaCleanupPendingResponseV1 {
  schemaVersion: 1;
  acceptanceRunId: string;
  dependencyIdentity: string;
  retentionRunId: string;
  state: 'queued' | 'running';
}

type HandlerInput =
  | { enabled: false; port: ModuleBetaAcceptancePort }
  | {
      enabled: true;
      token: string;
      controllerIdentity: string;
      port: ModuleBetaAcceptancePort;
    };

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROLLER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;
const MAX_REQUEST_BYTES = 1024 * 1024;

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function notFound(): Response {
  return json(404, { error: 'NOT_FOUND' });
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function acceptanceRunId(request: Request): string | null {
  const value = request.headers.get('x-openopc-module-beta-run-id');
  return value && RUN_ID.test(value) ? value : null;
}

async function boundedJson(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) || Number(contentLength) > MAX_REQUEST_BYTES)
  ) {
    throw new Error('REQUEST_TOO_LARGE');
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_REQUEST_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error('REQUEST_TOO_LARGE');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new Error('MODULE_BETA_ACCEPTANCE_REQUEST_INVALID');
  }
  return JSON.parse(body) as unknown;
}

export function createModuleBetaAcceptanceHandler(
  input: HandlerInput,
): (request: Request) => Promise<Response> {
  if (
    input.enabled &&
    (Buffer.byteLength(input.token, 'utf8') < 32 ||
      Buffer.byteLength(input.token, 'utf8') > 4_096 ||
      /[\0\r\n]/.test(input.token) ||
      !CONTROLLER_IDENTITY.test(input.controllerIdentity))
  ) {
    throw new Error('MODULE_BETA_ACCEPTANCE_CONFIG_INVALID');
  }

  return async (request) => {
    if (!input.enabled) return notFound();
    if (!authorized(request, input.token)) return notFound();
    const runId = acceptanceRunId(request);
    if (!runId) return notFound();
    const url = new URL(request.url);

    try {
      if (url.pathname === '/module-beta/trust/registrations' && request.method === 'POST') {
        const registration = parseModuleBetaArtifactRegistrationRequest(await boundedJson(request));
        if (registration.acceptanceRunId !== runId) return notFound();
        const response = parseModuleBetaArtifactRegistrationResponse(
          await input.port.registerArtifact(registration),
        );
        if (
          response.acceptanceRunId !== runId ||
          response.scenario !== registration.scenario ||
          response.artifactId !== registration.artifactId ||
          response.artifactDigest !== registration.artifactDigest ||
          response.dependencyIdentity !== input.controllerIdentity
        ) {
          throw new Error('MODULE_BETA_ACCEPTANCE_PORT_INVALID');
        }
        return json(201, response);
      }

      const evidencePath =
        request.method === 'GET'
          ? /^\/module-beta\/trust\/runs\/([^/]+)\/evidence$/.exec(url.pathname)
          : null;
      if (evidencePath) {
        const verificationRunId = decodeURIComponent(evidencePath[1]);
        if (!UUID.test(verificationRunId)) return notFound();
        const candidate = await input.port.inspect({
          acceptanceRunId: runId,
          runId: verificationRunId,
        });
        if (!candidate) return notFound();
        const response = parseModuleBetaInspectorEvidence(candidate);
        if (
          response.acceptanceRunId !== runId ||
          response.runId !== verificationRunId ||
          response.controllerIdentity !== input.controllerIdentity
        ) {
          throw new Error('MODULE_BETA_ACCEPTANCE_PORT_INVALID');
        }
        return json(200, response);
      }

      if (url.pathname === '/module-beta/trust/cleanup' && request.method === 'POST') {
        const cleanup = parseModuleBetaCleanupRequest(await boundedJson(request));
        if (cleanup.acceptanceRunId !== runId) return notFound();
        const candidate = await input.port.cleanup(cleanup);
        if (isRecord(candidate) && ('state' in candidate || 'retentionRunId' in candidate)) {
          const pending = parseModuleBetaCleanupPendingResponse(candidate);
          if (
            pending.acceptanceRunId !== runId ||
            pending.dependencyIdentity !== input.controllerIdentity
          ) {
            throw new Error('MODULE_BETA_ACCEPTANCE_PORT_INVALID');
          }
          return json(202, pending, { 'retry-after': '1' });
        }
        const response = parseModuleBetaCleanupResponse(candidate);
        if (
          response.acceptanceRunId !== runId ||
          response.dependencyIdentity !== input.controllerIdentity
        ) {
          throw new Error('MODULE_BETA_ACCEPTANCE_PORT_INVALID');
        }
        return json(200, response);
      }

      return notFound();
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error &&
          (error.message.endsWith('_INVALID') || error.message === 'REQUEST_TOO_LARGE'))
      ) {
        return json(400, { error: 'MODULE_BETA_ACCEPTANCE_REQUEST_INVALID' });
      }
      return json(503, { error: 'MODULE_BETA_ACCEPTANCE_UNAVAILABLE' });
    }
  };
}

export function parseModuleBetaCleanupPendingResponse(
  value: unknown,
): ModuleBetaCleanupPendingResponseV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'acceptanceRunId',
      'dependencyIdentity',
      'retentionRunId',
      'state',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    typeof value.dependencyIdentity !== 'string' ||
    !CONTROLLER_IDENTITY.test(value.dependencyIdentity) ||
    typeof value.retentionRunId !== 'string' ||
    !UUID.test(value.retentionRunId) ||
    (value.state !== 'queued' && value.state !== 'running')
  ) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PENDING_INVALID');
  }
  return structuredClone(value) as unknown as ModuleBetaCleanupPendingResponseV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}
