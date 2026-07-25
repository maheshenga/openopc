export interface DeveloperTrustReadinessClient {
  isReady(): Promise<boolean>;
}

type ReadinessFetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DeveloperTrustReadinessClientInput {
  enabled: boolean;
  url: string | null | undefined;
  fetcher?: ReadinessFetcher;
  timeoutMs?: number;
}

function readinessTarget(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const target = new URL(value);
    if (
      (target.protocol !== 'http:' && target.protocol !== 'https:') ||
      target.username ||
      target.password ||
      target.pathname !== '/readyz'
    ) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

export function createDeveloperTrustReadinessClient(
  input: DeveloperTrustReadinessClientInput,
): DeveloperTrustReadinessClient {
  const target = readinessTarget(input.url);
  const fetcher = input.fetcher ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1_500;
  return {
    async isReady() {
      if (!input.enabled || !target) return false;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      try {
        const response = await fetcher(target, {
          method: 'GET',
          redirect: 'error',
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
        if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
          return false;
        }
        const readiness = (await response.json()) as { enabled?: unknown; ready?: unknown };
        return readiness.enabled === true && readiness.ready === true;
      } catch {
        return false;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
