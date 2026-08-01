import { describe, expect, test } from 'bun:test';

import {
  createModuleCustomDomainInternalRoutes,
  createModuleCustomDomainProjectRoutes,
} from './app';
import {
  type ModuleCustomDomainBinding,
  ModuleCustomDomainBindingError,
  ModuleCustomDomainBindingService,
  type ModuleCustomDomainInstallation,
  canTransitionModuleCustomDomainBinding,
  createMemoryModuleCustomDomainBindingRepository,
  createNodeAuthoritativeDnsResolver,
} from './bindings';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';
const PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000003';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const USER_ID = '50000000-0000-4000-a000-000000000005';
const BINDING_ID = '60000000-0000-4000-a000-000000000006';
const OTHER_BINDING_ID = '60000000-0000-4000-a000-000000000007';
const NOW = '2026-08-01T04:00:00.000Z';
const CNAME_TARGET = 'custom-hostnames.openopc.example';
const VERIFICATION_VALUE =
  'openopc-domain-verification=BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
const VERIFICATION_HASH = 'sha256:7d81a57dffecac52a9777eb2e1282229253e787a28a25718fb327e3c0e8d48dc';

function installation(
  overrides: Partial<ModuleCustomDomainInstallation> = {},
): ModuleCustomDomainInstallation {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 3,
    installationStatus: 'active',
    releaseId: RELEASE_ID,
    releaseAccountId: ACCOUNT_ID,
    releaseStatus: 'published',
    releaseExecutionMode: 'sandboxed-web',
    signatureAlgorithm: 'ed25519',
    signature: `base64url:${'s'.repeat(86)}`,
    signedAt: NOW,
    ...overrides,
  };
}

function binding(overrides: Partial<ModuleCustomDomainBinding> = {}): ModuleCustomDomainBinding {
  return {
    bindingId: OTHER_BINDING_ID,
    environment: 'dev',
    accountId: OTHER_ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: RELEASE_ID,
    hostname: 'claimed.customer.example',
    hostnameAscii: 'claimed.customer.example',
    state: 'active',
    verificationTokenHash: VERIFICATION_HASH,
    cloudflareCustomHostnameId: 'cf-existing',
    cnameTarget: CNAME_TARGET,
    failureCode: null,
    createdBy: USER_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(input?: {
  installations?: ModuleCustomDomainInstallation[];
  bindings?: ModuleCustomDomainBinding[];
}) {
  const baseRepository = createMemoryModuleCustomDomainBindingRepository({
    installations: input?.installations ?? [installation()],
    bindings: input?.bindings ?? [],
  });
  let persisted: ModuleCustomDomainBinding | null = null;
  const repository = {
    ...baseRepository,
    async create(value: ModuleCustomDomainBinding) {
      persisted = structuredClone(value);
      return baseRepository.create(value);
    },
  };
  const dns = {
    txtValues: [] as string[],
    cnameValues: [] as string[],
    calls: [] as Array<{ hostname: string; txtName: string }>,
    async resolve(input: { hostname: string; txtName: string }) {
      this.calls.push(input);
      return { txtValues: [...this.txtValues], cnameValues: [...this.cnameValues] };
    },
  };
  const cloudflare = {
    calls: [] as string[],
    createState: { state: 'pending' as const, id: 'cf-created', failureCode: null },
    getState: { state: 'active' as const, id: 'cf-created', failureCode: null },
    async create(hostname: string) {
      this.calls.push(`create:${hostname}`);
      return this.createState;
    },
    async get(id: string) {
      this.calls.push(`get:${id}`);
      return this.getState;
    },
    async delete(id: string) {
      this.calls.push(`delete:${id}`);
    },
  };
  const service = new ModuleCustomDomainBindingService({
    repository,
    dns,
    cloudflare,
    cnameTarget: CNAME_TARGET,
    platformHostnames: ['api.openopc.example'],
    // A shared dev/preview data plane must not make a dev hostname resolvable in staging.
    environment: 'dev',
    now: () => new Date(NOW),
    createBindingId: () => BINDING_ID,
    createVerificationTokenBytes: () => Buffer.alloc(32, 7),
  });
  return { repository, baseRepository, service, dns, cloudflare, persisted: () => persisted };
}

async function expectDomainError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error('Expected domain operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ModuleCustomDomainBindingError);
    expect(error).toMatchObject({ code });
  }
}

describe('module custom domain bindings', () => {
  test('normalizes Unicode hostnames and returns the TXT secret only on creation', async () => {
    const h = harness();

    const created = await h.service.create({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      expectedInstallRevision: 3,
      hostname: '例子.测试',
      actorUserId: USER_ID,
    });

    expect(created).toEqual({
      binding: expect.objectContaining({
        bindingId: BINDING_ID,
        hostname: '例子.测试',
        hostnameAscii: 'xn--fsqu00a.xn--0zwm56d',
        state: 'dns_pending',
        cnameTarget: CNAME_TARGET,
      }),
      verificationRecord: {
        type: 'TXT',
        name: '_openopc-verification.xn--fsqu00a.xn--0zwm56d',
        value: VERIFICATION_VALUE,
      },
      cnameRecord: {
        type: 'CNAME',
        name: 'xn--fsqu00a.xn--0zwm56d',
        value: CNAME_TARGET,
      },
    });
    expect(h.persisted()).toMatchObject({
      state: 'requested',
      verificationTokenHash: VERIFICATION_HASH,
    });
    expect(JSON.stringify(h.persisted())).not.toContain(VERIFICATION_VALUE);
    expect(JSON.stringify(created)).not.toMatch(/cloudflare.*token|api[_-]?token/i);

    const listed = await h.service.list({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
    });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(VERIFICATION_VALUE);
    expect(JSON.stringify(listed)).not.toContain(VERIFICATION_HASH);
  });

  test('rejects non-DNS, wildcard, localhost, and platform-owned hostnames', async () => {
    for (const hostname of [
      '127.0.0.1',
      '::1',
      'localhost',
      'shop.localhost',
      '*.customer.example',
      'api.openopc.example',
      'child.api.openopc.example',
    ]) {
      const h = harness();
      await expectDomainError(
        h.service.create({
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          expectedInstallRevision: 3,
          hostname,
          actorUserId: USER_ID,
        }),
        'MODULE_DOMAIN_HOSTNAME_FORBIDDEN',
      );
    }
  });

  test('rejects stale, cross-account, unsigned, and already claimed releases', async () => {
    await expectDomainError(
      harness().service.create({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        expectedInstallRevision: 2,
        hostname: 'stale.customer.example',
        actorUserId: USER_ID,
      }),
      'MODULE_DOMAIN_INSTALLATION_STALE',
    );

    for (const current of [
      installation({ releaseAccountId: OTHER_ACCOUNT_ID }),
      installation({ signatureAlgorithm: null, signature: null, signedAt: null }),
      installation({ releaseExecutionMode: 'server-adapter' } as never),
    ]) {
      await expectDomainError(
        harness({ installations: [current] }).service.create({
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          expectedInstallRevision: 3,
          hostname: 'release.customer.example',
          actorUserId: USER_ID,
        }),
        'MODULE_DOMAIN_RELEASE_NOT_ELIGIBLE',
      );
    }

    await expectDomainError(
      harness({ bindings: [binding()] }).service.create({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        expectedInstallRevision: 3,
        hostname: 'CLAIMED.customer.example',
        actorUserId: USER_ID,
      }),
      'MODULE_DOMAIN_HOSTNAME_CONFLICT',
    );
  });

  test('requires authoritative TXT and CNAME proof before Cloudflare and polls only on verify', async () => {
    const h = harness();
    const created = await h.service.create({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      expectedInstallRevision: 3,
      hostname: 'App.Customer.Example',
      actorUserId: USER_ID,
    });
    expect(h.cloudflare.calls).toEqual([]);

    h.dns.txtValues = [created.verificationRecord.value];
    await expectDomainError(
      h.service.verify({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        bindingId: BINDING_ID,
      }),
      'MODULE_DOMAIN_DNS_PENDING',
    );
    expect(h.cloudflare.calls).toEqual([]);

    h.dns.cnameValues = [`${CNAME_TARGET}.`];
    const pending = await h.service.verify({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      bindingId: BINDING_ID,
    });
    expect(pending.state).toBe('hostname_pending');
    expect(h.cloudflare.calls).toEqual(['create:app.customer.example']);

    const active = await h.service.verify({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      bindingId: BINDING_ID,
    });
    expect(active.state).toBe('active');
    expect(h.cloudflare.calls).toEqual(['create:app.customer.example', 'get:cf-created']);
    expect(await h.service.resolve('APP.CUSTOMER.EXAMPLE')).toEqual({
      bindingId: BINDING_ID,
      routePath: `/v1/module-host/releases/${RELEASE_ID}`,
    });

    const disabled = await h.service.disable({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      bindingId: BINDING_ID,
    });
    expect(disabled.state).toBe('disabled');
    expect(h.cloudflare.calls.at(-1)).toBe('delete:cf-created');
    expect(await h.service.resolve('app.customer.example')).toBeNull();
  });

  test('deletes a failed Cloudflare hostname before leaving the binding failed', async () => {
    const h = harness({
      bindings: [
        binding({
          bindingId: BINDING_ID,
          accountId: ACCOUNT_ID,
          state: 'hostname_pending',
          cloudflareCustomHostnameId: 'cf-failed',
        }),
      ],
    });
    h.cloudflare.getState = {
      state: 'failed',
      id: 'cf-failed',
      failureCode: 'validation_timed_out',
    } as never;

    const failed = await h.service.verify({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      bindingId: BINDING_ID,
    });

    expect(failed).toMatchObject({ state: 'failed', failureCode: 'validation_timed_out' });
    expect(h.cloudflare.calls).toEqual(['get:cf-failed', 'delete:cf-failed']);
  });

  test('removes a provider hostname left on a failed binding when the owner disables it', async () => {
    const h = harness({
      bindings: [
        binding({
          bindingId: BINDING_ID,
          accountId: ACCOUNT_ID,
          state: 'failed',
          cloudflareCustomHostnameId: 'cf-orphaned',
          failureCode: 'validation_timed_out',
        }),
      ],
    });

    const disabled = await h.service.disable({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      bindingId: BINDING_ID,
    });

    expect(disabled.state).toBe('disabled');
    expect(h.cloudflare.calls).toEqual(['delete:cf-orphaned']);
  });

  test('compensates a provider hostname when the durable state transition loses a race', async () => {
    const h = harness();
    const created = await h.service.create({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      expectedInstallRevision: 3,
      hostname: 'race.customer.example',
      actorUserId: USER_ID,
    });
    h.dns.txtValues = [created.verificationRecord.value];
    h.dns.cnameValues = [`${CNAME_TARGET}.`];
    const transition = h.repository.transition;
    h.repository.transition = async (input) =>
      input.to === 'hostname_pending' ? null : transition(input);

    await expectDomainError(
      h.service.verify({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        bindingId: BINDING_ID,
      }),
      'MODULE_DOMAIN_STATE_CONFLICT',
    );
    expect(h.cloudflare.calls).toEqual(['create:race.customer.example', 'delete:cf-created']);
  });

  test('does not resolve an active hostname from another deployment environment', async () => {
    const stagingBinding = {
      ...binding({
        bindingId: BINDING_ID,
        accountId: ACCOUNT_ID,
        hostname: 'staging.customer.example',
        hostnameAscii: 'staging.customer.example',
      }),
      environment: 'staging',
    } as ModuleCustomDomainBinding;
    const h = harness({ bindings: [stagingBinding] });

    await expect(h.service.resolve('staging.customer.example')).resolves.toBeNull();
  });

  test('enforces the approved state-transition matrix', () => {
    const allowed = new Set([
      'requested:dns_pending',
      'requested:failed',
      'requested:disabled',
      'dns_pending:hostname_pending',
      'dns_pending:failed',
      'dns_pending:disabled',
      'hostname_pending:active',
      'hostname_pending:failed',
      'hostname_pending:disabled',
      'active:disabled',
      'failed:disabled',
    ]);
    const states = [
      'requested',
      'dns_pending',
      'hostname_pending',
      'active',
      'failed',
      'disabled',
    ] as const;
    for (const from of states) {
      for (const to of states) {
        expect(canTransitionModuleCustomDomainBinding(from, to)).toBe(allowed.has(`${from}:${to}`));
      }
    }
  });

  test('discovers authoritative nameservers before reading TXT and CNAME records', async () => {
    const calls: string[] = [];
    let servers: string[] = [];
    const resolver = createNodeAuthoritativeDnsResolver({
      resolveNs: async (name) => {
        calls.push(`ns:${name}`);
        if (name === 'app.customer.example') throw new Error('ENODATA');
        return ['ns1.dns.example'];
      },
      resolve4: async (name) => {
        calls.push(`a:${name}`);
        return ['192.0.2.53'];
      },
      resolve6: async () => [],
      createResolver: () => ({
        setServers(values) {
          servers = [...values];
        },
        async resolveTxt(name) {
          calls.push(`txt:${name}`);
          return [['openopc-domain-', 'verification=value']];
        },
        async resolveCname(name) {
          calls.push(`cname:${name}`);
          return [`${CNAME_TARGET}.`];
        },
      }),
    });

    await expect(
      resolver.resolve({
        hostname: 'app.customer.example',
        txtName: '_openopc-verification.app.customer.example',
      }),
    ).resolves.toEqual({
      txtValues: ['openopc-domain-verification=value'],
      cnameValues: [`${CNAME_TARGET}.`],
    });
    expect(servers).toEqual(['192.0.2.53']);
    expect(calls).toEqual([
      'ns:app.customer.example',
      'ns:customer.example',
      'a:ns1.dns.example',
      'txt:_openopc-verification.app.customer.example',
      'cname:app.customer.example',
    ]);
  });

  test('routes project management through project authorization and hides inactive internal lookups', async () => {
    const h = harness();
    const capabilities: string[] = [];
    const projectRoutes = createModuleCustomDomainProjectRoutes({
      loadProjectForUser: async (_context, projectId) => ({
        row: { accountId: ACCOUNT_ID, projectId },
        userId: USER_ID,
      }),
      assertProjectCapability: async (_context, _userId, _accountId, _projectId, action) => {
        capabilities.push(action);
      },
      bindingService: h.service,
    });
    const createResponse = await projectRoutes.request(
      `/${PROJECT_ID}/modules/${INSTALLATION_ID}/domains`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostname: 'route.customer.example',
          expected_install_revision: 3,
        }),
      },
    );
    expect(createResponse.status).toBe(201);
    const body = await createResponse.json();
    expect(body).toEqual(
      expect.objectContaining({
        verification_record: expect.objectContaining({ type: 'TXT' }),
        cname_record: { type: 'CNAME', name: 'route.customer.example', value: CNAME_TARGET },
      }),
    );
    expect(JSON.stringify(body)).not.toContain(VERIFICATION_HASH);
    expect(capabilities).toEqual(['project.customize.write']);

    const internalRoutes = createModuleCustomDomainInternalRoutes({
      bindingService: h.service,
      internalServiceKey: 'internal-test-key',
    });
    const denied = await internalRoutes.request('/resolve?hostname=route.customer.example', {
      headers: { 'X-Kortix-Internal-Key': 'wrong' },
    });
    expect(denied.status).toBe(401);

    const misconfigured = await createModuleCustomDomainInternalRoutes({
      bindingService: h.service,
      internalServiceKey: '',
    }).request('/resolve?hostname=route.customer.example', {
      headers: { 'X-Kortix-Internal-Key': '' },
    });
    expect(misconfigured.status).toBe(401);

    const inactive = await internalRoutes.request('/resolve?hostname=route.customer.example', {
      headers: { 'X-Kortix-Internal-Key': 'internal-test-key' },
    });
    expect(inactive.status).toBe(404);
    expect(await inactive.json()).toEqual({ error: 'Not found' });
  });
});
