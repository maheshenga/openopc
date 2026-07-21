import { createHash, createHmac } from 'node:crypto';

export type AutomationControlActor = Readonly<{
  accountId: string;
  projectId: string;
  userId: string;
  roles: readonly ('member' | 'project_admin' | 'device_owner' | 'security_admin')[];
  deviceId: string | null;
}>;

export type AutomationControlRequest = Readonly<{
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  actor: AutomationControlActor;
  body?: unknown;
}>;

export type AutomationControlResponse = Readonly<{
  status: number;
  headers: Headers;
  body: unknown;
}>;

export interface AutomationControlClient {
  request(input: AutomationControlRequest): Promise<AutomationControlResponse>;
  stream(input: AutomationControlRequest): Promise<Response>;
}

export type AutomationControlClientOptions = Readonly<{
  baseUrl: string;
  sharedSecret: string;
  serviceId?: string;
  timeoutMs?: number;
  streamTimeoutMs?: number;
  mtlsCa?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}>;

function canonicalRoles(roles: readonly string[]): string {
  return [...new Set(roles)].sort().join(',');
}

function bodyText(body: unknown): string {
  return body === undefined ? '' : JSON.stringify(body);
}

function serviceHeaders(input: {
  serviceId: string;
  sharedSecret: string;
  timestamp: Date;
  request: AutomationControlRequest;
  body: string;
}): Record<string, string> {
  const actor = input.request.actor;
  const canonical = [
    input.timestamp.toISOString(),
    input.serviceId,
    input.request.method,
    input.request.path,
    createHash('sha256').update(input.body).digest('hex'),
    actor.accountId,
    actor.projectId,
    actor.userId,
    canonicalRoles(actor.roles),
    actor.deviceId ?? '',
  ].join('\n');
  const signature = createHmac('sha256', input.sharedSecret).update(canonical).digest('hex');
  return {
    'x-automation-service-id': input.serviceId,
    'x-automation-timestamp': input.timestamp.toISOString(),
    'x-automation-signature': `hmac-sha256:${signature}`,
    'x-automation-account-id': actor.accountId,
    'x-automation-project-id': actor.projectId,
    'x-automation-user-id': actor.userId,
    'x-automation-roles': canonicalRoles(actor.roles),
    'x-automation-device-id': actor.deviceId ?? '',
  };
}

export function createAutomationControlClient(
  options: AutomationControlClientOptions,
): AutomationControlClient {
  const requestFetch = options.fetch ?? fetch;
  const serviceId = options.serviceId ?? 'kortix-api';
  const timeoutMs = options.timeoutMs ?? 10_000;
  const streamTimeoutMs = options.streamTimeoutMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  async function send(input: AutomationControlRequest, streaming: boolean): Promise<Response> {
    const body = bodyText(input.body);
    const headers = serviceHeaders({
      serviceId,
      sharedSecret: options.sharedSecret,
      timestamp: now(),
      request: input,
      body,
    });
    if (body) headers['content-type'] = 'application/json';
    if (streaming) headers.accept = 'text/event-stream';
    const init = {
      method: input.method,
      headers,
      body: body || undefined,
      signal: AbortSignal.timeout(streaming ? streamTimeoutMs : timeoutMs),
      ...(options.mtlsCa ? { tls: { ca: options.mtlsCa } } : {}),
    } as RequestInit;
    return requestFetch(`${baseUrl}${input.path}`, init);
  }

  return {
    async request(input) {
      const response = await send(input, false);
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      }
      return { status: response.status, headers: response.headers, body };
    },
    stream: (input) => send(input, true),
  };
}
