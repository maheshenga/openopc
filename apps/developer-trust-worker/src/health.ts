import type { DeveloperTrustReadiness } from './readiness';

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
}

export function createDeveloperTrustHealthHandler(input: {
  check(): Promise<DeveloperTrustReadiness | Record<string, unknown>>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== 'GET') return json(404, { error: 'NOT_FOUND' });
    if (path === '/healthz') return json(200, { status: 'ok' });
    if (path !== '/readyz') return json(404, { error: 'NOT_FOUND' });

    try {
      const readiness = await input.check();
      return json(readiness.ready === true ? 200 : 503, readiness);
    } catch {
      return json(503, { enabled: true, ready: false });
    }
  };
}
