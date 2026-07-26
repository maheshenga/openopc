import type { ModuleBetaAcceptanceController } from './controller';
import { createModuleBetaAcceptanceHandler } from './http';

type ServerInput =
  | { enabled: false }
  | {
      enabled: true;
      token: string;
      controllerIdentity: string;
      controller: ModuleBetaAcceptanceController;
      now?: () => Date;
    };

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

function notFound(): Response {
  return json(404, { error: 'NOT_FOUND' });
}

export function createModuleBetaAcceptanceServerHandler(
  input: ServerInput,
): (request: Request) => Promise<Response> {
  const business = input.enabled
    ? createModuleBetaAcceptanceHandler({
        enabled: true,
        token: input.token,
        controllerIdentity: input.controllerIdentity,
        port: input.controller,
      })
    : null;
  const now = input.enabled ? (input.now ?? (() => new Date())) : () => new Date();

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/healthz') return json(200, { status: 'ok' });
    if (request.method === 'GET' && path === '/readyz') {
      if (!input.enabled) return json(503, { enabled: false, ready: false, reason: 'disabled' });
      let checkedAt: string;
      try {
        const checked = now();
        if (!Number.isFinite(checked.valueOf())) throw new Error('invalid clock');
        checkedAt = checked.toISOString();
        await input.controller.assertReady();
      } catch {
        const checked = now();
        checkedAt = Number.isFinite(checked.valueOf())
          ? checked.toISOString()
          : '1970-01-01T00:00:00.000Z';
        return json(503, {
          enabled: true,
          ready: false,
          identity: input.controllerIdentity,
          reason: 'dependency_unavailable',
          checkedAt,
        });
      }
      return json(200, {
        enabled: true,
        ready: true,
        identity: input.controllerIdentity,
        checkedAt,
      });
    }
    return business ? business(request) : notFound();
  };
}
