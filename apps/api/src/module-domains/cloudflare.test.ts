import { describe, expect, test } from 'bun:test';

import {
  ModuleCustomDomainProviderError,
  createCloudflareCustomHostnamePort,
  parseModuleDomainOperatorConfig,
} from './cloudflare';

const CONFIG = {
  accountId: 'cf-account',
  zoneId: 'cf-zone',
  apiToken: 'cf-secret-token-1',
  cnameTarget: 'custom-hostnames.openopc.example',
  origin: 'https://module-host.openopc.example',
  controlledSuffix: 'openopc.example',
};

describe('Cloudflare custom hostnames adapter', () => {
  test('keeps an entirely unconfigured feature disabled and rejects partial or unsafe config', () => {
    expect(parseModuleDomainOperatorConfig(CONFIG)).toEqual(CONFIG);
    expect(
      parseModuleDomainOperatorConfig({
        accountId: '',
        zoneId: '',
        apiToken: '',
        cnameTarget: '',
        origin: '',
        controlledSuffix: '',
      }),
    ).toBeNull();
    expect(() => parseModuleDomainOperatorConfig({ ...CONFIG, apiToken: '' })).toThrow(
      'MODULE_DOMAIN_CONFIG_INVALID',
    );
    expect(() =>
      parseModuleDomainOperatorConfig({ ...CONFIG, origin: 'http://module-host.openopc.example' }),
    ).toThrow('MODULE_DOMAIN_CONFIG_INVALID');
    expect(() =>
      parseModuleDomainOperatorConfig({ ...CONFIG, origin: 'https://module-host.other.example' }),
    ).toThrow('MODULE_DOMAIN_CONFIG_INVALID');
    expect(() =>
      parseModuleDomainOperatorConfig({ ...CONFIG, cnameTarget: 'custom-hostnames.other.example' }),
    ).toThrow('MODULE_DOMAIN_CONFIG_INVALID');
    expect(() =>
      parseModuleDomainOperatorConfig({
        ...CONFIG,
        origin: 'https://module-host.attacker.example',
        cnameTarget: 'custom-hostnames.attacker.example',
      }),
    ).toThrow('MODULE_DOMAIN_CONFIG_INVALID');
    expect(() =>
      createCloudflareCustomHostnamePort({
        ...CONFIG,
        origin: 'http://module-host.openopc.example',
      }),
    ).toThrow('MODULE_DOMAIN_CONFIG_INVALID');
  });

  test('creates CNAME-validated hostnames without leaking the API token into JSON', async () => {
    const requests: Request[] = [];
    const port = createCloudflareCustomHostnamePort({
      ...CONFIG,
      fetch: async (request) => {
        requests.push(request.clone());
        return Response.json({
          success: true,
          result: {
            id: 'cf-hostname-id',
            hostname: 'app.customer.example',
            status: 'pending',
            ssl: { status: 'pending_validation' },
          },
        });
      },
    });

    await expect(port.create('app.customer.example')).resolves.toEqual({
      id: 'cf-hostname-id',
      state: 'pending',
      failureCode: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      'https://api.cloudflare.com/client/v4/zones/cf-zone/custom_hostnames',
    );
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${CONFIG.apiToken}`);
    const firstRequest = requests[0];
    if (!firstRequest) throw new Error('Cloudflare create request was not captured');
    const body = await firstRequest.json();
    expect(body).toEqual({
      hostname: 'app.customer.example',
      ssl: { method: 'cname', type: 'dv' },
    });
    expect(JSON.stringify(body)).not.toContain(CONFIG.apiToken);
  });

  test('maps active, failed, and delete lifecycle responses with bounded public failures', async () => {
    const responses = [
      Response.json({
        success: true,
        result: {
          id: 'cf-hostname-id',
          hostname: 'app.customer.example',
          status: 'active',
          ssl: { status: 'active' },
        },
      }),
      Response.json({
        success: true,
        result: {
          id: 'cf-hostname-id',
          hostname: 'app.customer.example',
          status: 'moved',
          ssl: { status: 'validation_timed_out' },
        },
      }),
      Response.json({ success: true, result: { id: 'cf-hostname-id' } }),
    ];
    const requests: Request[] = [];
    const port = createCloudflareCustomHostnamePort({
      ...CONFIG,
      fetch: async (request) => {
        requests.push(request.clone());
        const response = responses.shift();
        if (!response) throw new Error('Cloudflare response fixture exhausted');
        return response;
      },
    });

    await expect(port.get('cf-hostname-id')).resolves.toEqual({
      id: 'cf-hostname-id',
      state: 'active',
      failureCode: null,
    });
    await expect(port.get('cf-hostname-id')).resolves.toEqual({
      id: 'cf-hostname-id',
      state: 'failed',
      failureCode: 'validation_timed_out',
    });
    await expect(port.delete('cf-hostname-id')).resolves.toBeUndefined();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'DELETE']);
    expect(requests.at(-1)?.url).toBe(
      'https://api.cloudflare.com/client/v4/zones/cf-zone/custom_hostnames/cf-hostname-id',
    );
  });

  test('normalizes Cloudflare transport and schema failures to one provider error', async () => {
    for (const response of [
      new Response('upstream unavailable', { status: 503 }),
      Response.json({ success: false, errors: [{ code: 1000, message: 'secret detail' }] }),
      Response.json({ success: true, result: { id: '', status: 'active' } }),
    ]) {
      const port = createCloudflareCustomHostnamePort({
        ...CONFIG,
        fetch: async () => response,
      });
      try {
        await port.create('app.customer.example');
        throw new Error('Expected provider failure');
      } catch (error) {
        expect(error).toBeInstanceOf(ModuleCustomDomainProviderError);
        expect(error).toMatchObject({ code: 'MODULE_DOMAIN_PROVIDER_UNAVAILABLE' });
        expect(String(error)).not.toContain('secret detail');
      }
    }
  });

  test('treats an already removed hostname as an idempotent delete', async () => {
    const port = createCloudflareCustomHostnamePort({
      ...CONFIG,
      fetch: async () => new Response(null, { status: 404 }),
    });

    await expect(port.delete('already-removed')).resolves.toBeUndefined();
  });
});
