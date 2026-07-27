import { expect, test } from 'bun:test';

const RUNNER_ID = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-a000-000000000002';
const CERTIFICATE_THUMBPRINT = 'a'.repeat(64);
const PROXY_SECRET = 'runner-proxy-secret-that-is-at-least-32-bytes';

test('Runner identity headers require proof that they came through the trusted mTLS proxy', async () => {
  const environment = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    INTERNAL_KORTIX_ENV: process.env.INTERNAL_KORTIX_ENV,
    RECALL_BASE_URL: process.env.RECALL_BASE_URL,
    FRONTEND_URL: process.env.FRONTEND_URL,
    ALLOWED_SANDBOX_PROVIDERS: process.env.ALLOWED_SANDBOX_PROVIDERS,
    OPENOPC_TRUST_RUNNER_MTLS_HEADERS: process.env.OPENOPC_TRUST_RUNNER_MTLS_HEADERS,
    OPENOPC_RUNNER_MTLS_PROXY_SECRET: process.env.OPENOPC_RUNNER_MTLS_PROXY_SECRET,
  };
  process.env.SUPABASE_URL = 'http://test.local';
  process.env.INTERNAL_KORTIX_ENV = 'dev';
  process.env.RECALL_BASE_URL = 'http://test.local';
  process.env.FRONTEND_URL = 'http://test.local';
  process.env.ALLOWED_SANDBOX_PROVIDERS = '';
  process.env.OPENOPC_TRUST_RUNNER_MTLS_HEADERS = 'true';
  process.env.OPENOPC_RUNNER_MTLS_PROXY_SECRET = PROXY_SECRET;
  const { moduleRunnerProtocol, moduleRuntimeApp } = await import('./index');
  const originalHeartbeatNode = moduleRunnerProtocol.heartbeatNode;
  try {
    moduleRunnerProtocol.heartbeatNode = async (_identity, command) => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      nodeIdentity: 'runner-test',
      status: 'active',
      softwareVersion: command.softwareVersion,
      attestationDigest: command.attestationDigest,
      certificateThumbprint: CERTIFICATE_THUMBPRINT,
      profiles: [],
      updatedAt: '2026-07-27T08:00:00.000Z',
    });

    const request = (proxySecret?: string) =>
      moduleRuntimeApp.request('/module-runtime/runners/heartbeat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-openopc-mtls-verified': 'SUCCESS',
          'x-openopc-client-cert-sha256': CERTIFICATE_THUMBPRINT,
          'x-openopc-runner-id': RUNNER_ID,
          'x-openopc-runner-account-id': ACCOUNT_ID,
          ...(proxySecret ? { 'x-openopc-runner-proxy-secret': proxySecret } : {}),
        },
        body: JSON.stringify({
          softwareVersion: '1.0.1',
          attestationDigest: `sha256:${'b'.repeat(64)}`,
        }),
      });

    expect((await request()).status).toBe(401);
    expect((await request('wrong-runner-proxy-secret-that-is-long-enough')).status).toBe(401);
    expect((await request(PROXY_SECRET)).status).toBe(200);
  } finally {
    moduleRunnerProtocol.heartbeatNode = originalHeartbeatNode;
    for (const [name, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 60_000);
