import { loadDeveloperTrustWorkerConfig } from './config';
import { createDeveloperTrustHealthHandler } from './health';
import { createDeveloperTrustReadiness } from './readiness';

const scannerNames = ['gitleaks', 'syft', 'osv-scanner', 'semgrep', 'license-policy'] as const;

function portFromEnvironment(value: string | undefined): number {
  if (value === undefined) return 8080;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DEVELOPER_TRUST_PORT_INVALID');
  }
  return port;
}

/**
 * The deployment image deliberately reports enabled infrastructure as unready
 * until concrete artifact, scanner, sandbox, and claim adapters are supplied.
 * This keeps code-bearing module submission fail-closed during the staged rollout.
 */
export function startDeveloperTrustWorkerServer(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = loadDeveloperTrustWorkerConfig(environment);
  const unavailable = async (): Promise<void> => {
    throw new Error('DEVELOPER_TRUST_RUNTIME_ADAPTERS_UNAVAILABLE');
  };
  const readiness = createDeveloperTrustReadiness({
    enabled: config.enabled,
    artifactStore: unavailable,
    policy: unavailable,
    scanners: Object.fromEntries(scannerNames.map((name) => [name, unavailable])),
    sandbox: unavailable,
    databaseClaims: unavailable,
  });
  return Bun.serve({
    hostname: '0.0.0.0',
    port: portFromEnvironment(environment.DEVELOPER_TRUST_PORT),
    fetch: createDeveloperTrustHealthHandler(readiness),
  });
}

if (import.meta.main) startDeveloperTrustWorkerServer();
