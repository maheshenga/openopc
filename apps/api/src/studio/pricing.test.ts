import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { StudioCreatePricingCatalogRequest } from '@kortix/api-contract';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import { createStudioAccountRoutes } from './account-routes';
import { StudioPricingService } from './pricing';
import { createDrizzleStudioRepository } from './repositories/drizzle';
import { createMemoryStudioRepository } from './repositories/memory';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ACTOR_USER_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000002';

function pricingRequest(
  overrides: Partial<StudioCreatePricingCatalogRequest> = {},
): StudioCreatePricingCatalogRequest {
  return {
    provider: 'openai-compatible',
    model: 'gpt-image-1',
    unit: 'image',
    rate_data: { rate_credits: 1.25 },
    maximum_cost_rule: { max_provider_credits: 8 },
    markup_rule: { markup_credits: 0.5 },
    ...overrides,
  };
}

describe('Studio pricing service', () => {
  test('allocates immutable monotonic versions inside the repository boundary', async () => {
    const repository = createMemoryStudioRepository();
    const service = new StudioPricingService(repository);

    const [first, second] = await Promise.all([
      service.create({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        request: pricingRequest(),
      }),
      service.create({
        accountId: ACCOUNT_ID,
        actorUserId: ACTOR_USER_ID,
        request: pricingRequest(),
      }),
    ]);

    expect(first).toMatchObject({
      ok: true,
      value: { account_id: ACCOUNT_ID, version: 1, active: true },
    });
    expect(second).toMatchObject({
      ok: true,
      value: { account_id: ACCOUNT_ID, version: 2, active: true },
    });
  });

  test('locks the pricing tuple before reading the current version and inserting', async () => {
    const calls: string[] = [];
    let transactionConfig: unknown;
    const inserted = {
      pricingCatalogId: '30000000-0000-4000-a000-000000000001',
      accountId: ACCOUNT_ID,
      ...pricingRequest(),
      rateData: pricingRequest().rate_data,
      maximumCostRule: pricingRequest().maximum_cost_rule,
      markupRule: pricingRequest().markup_rule,
      version: 7,
      active: true,
      createdByUserId: ACTOR_USER_ID,
      createdAt: new Date('2026-07-17T00:00:00.000Z'),
    };
    const db = {
      transaction: async (run: (tx: unknown) => Promise<unknown>, config: unknown) => {
        transactionConfig = config;
        return run({
          execute: async () => {
            calls.push('lock');
            return [];
          },
          select: () => ({
            from: () => ({
              where: async () => {
                calls.push('select');
                return [{ version: 6 }];
              },
            }),
          }),
          insert: () => ({
            values: (values: { version: number }) => {
              calls.push(`insert:${values.version}`);
              return { returning: async () => [inserted] };
            },
          }),
        });
      },
      execute: () => {
        throw new Error('version allocation must run inside a transaction');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    await expect(
      repository.createPricingVersion({
        account_id: ACCOUNT_ID,
        created_by_user_id: ACTOR_USER_ID,
        request: pricingRequest(),
      }),
    ).resolves.toMatchObject({ version: 7, account_id: ACCOUNT_ID });
    expect(calls).toEqual(['lock', 'select', 'insert:7']);
    expect(transactionConfig).toEqual({ isolationLevel: 'read committed' });

    const source = readFileSync(new URL('./repositories/drizzle.ts', import.meta.url), 'utf8');
    expect(source).toContain('pg_advisory_xact_lock');
    expect(source).toContain('${account_id}::uuid::text');
  });

  test('rejects values that cannot round-trip through numeric(12,4) before repository writes', async () => {
    const repository = createMemoryStudioRepository();
    let writes = 0;
    const createPricingVersion = repository.createPricingVersion.bind(repository);
    repository.createPricingVersion = async (input) => {
      writes += 1;
      return createPricingVersion(input);
    };
    const service = new StudioPricingService(repository);

    for (const request of [
      pricingRequest({ rate_data: { rate_credits: 0.00001 } }),
      pricingRequest({ maximum_cost_rule: { max_provider_credits: 100_000_000 } }),
      pricingRequest({ markup_rule: { markup_credits: 1.00001 } }),
    ]) {
      await expect(
        service.create({ accountId: ACCOUNT_ID, actorUserId: ACTOR_USER_ID, request }),
      ).resolves.toEqual({ ok: false, code: 'invalid_pricing' });
    }

    expect(writes).toBe(0);
  });

  test('lists and deactivates only within the requested account and keeps replay idempotent', async () => {
    const repository = createMemoryStudioRepository();
    const service = new StudioPricingService(repository);
    const created = await service.create({
      accountId: ACCOUNT_ID,
      actorUserId: ACTOR_USER_ID,
      request: pricingRequest(),
    });
    if (!created.ok) throw new Error('expected pricing creation to succeed');

    await expect(service.list(OTHER_ACCOUNT_ID)).resolves.toEqual([]);
    await expect(
      service.deactivate({
        accountId: OTHER_ACCOUNT_ID,
        pricingCatalogId: created.value.pricing_catalog_id,
      }),
    ).resolves.toEqual({ ok: false, code: 'not_found' });

    const first = await service.deactivate({
      accountId: ACCOUNT_ID,
      pricingCatalogId: created.value.pricing_catalog_id,
    });
    const replay = await service.deactivate({
      accountId: ACCOUNT_ID,
      pricingCatalogId: created.value.pricing_catalog_id,
    });
    expect(first).toMatchObject({ ok: true, value: { active: false } });
    expect(replay).toEqual(first);
  });
});

describe('Studio pricing account routes', () => {
  function createApp(deniedAction?: string) {
    const repository = createMemoryStudioRepository();
    let writes = 0;
    const createPricingVersion = repository.createPricingVersion.bind(repository);
    const deactivatePricing = repository.deactivatePricing.bind(repository);
    repository.createPricingVersion = async (input) => {
      writes += 1;
      return createPricingVersion(input);
    };
    repository.deactivatePricing = async (...input) => {
      writes += 1;
      return deactivatePricing(...input);
    };
    const assertedActions: string[] = [];
    const routes = createStudioAccountRoutes({
      pricingService: new StudioPricingService(repository),
      assertAccountCapability: async (_c, _userId, _accountId, action) => {
        assertedActions.push(action);
        if (action === deniedAction) throw new HTTPException(403, { message: 'denied' });
      },
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      (c as unknown as { set(key: string, value: unknown): void }).set('userId', ACTOR_USER_ID);
      await next();
    });
    app.route('/v1/accounts', routes);
    app.onError((error, c) =>
      error instanceof HTTPException
        ? c.json({ error: error.message }, error.status)
        : c.json({ error: 'internal' }, 500),
    );
    return { app, assertedActions, writes: () => writes };
  }

  test('requires billing.read for list and billing.write for create and deactivate', async () => {
    const { app, assertedActions } = createApp();

    const list = await app.request(`/v1/accounts/${ACCOUNT_ID}/studio/pricing-catalog`);
    expect(list.status).toBe(200);

    const create = await app.request(`/v1/accounts/${ACCOUNT_ID}/studio/pricing-catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pricingRequest()),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { pricing_catalog_id: string };

    const deactivate = await app.request(
      `/v1/accounts/${ACCOUNT_ID}/studio/pricing-catalog/${created.pricing_catalog_id}/deactivate`,
      { method: 'POST' },
    );
    expect(deactivate.status).toBe(200);
    expect(await deactivate.json()).toMatchObject({ active: false });
    expect(assertedActions).toEqual([
      ACCOUNT_ACTIONS.BILLING_READ,
      ACCOUNT_ACTIONS.BILLING_WRITE,
      ACCOUNT_ACTIONS.BILLING_WRITE,
    ]);
  });

  test('performs no pricing write when billing.write is denied', async () => {
    const { app, writes } = createApp(ACCOUNT_ACTIONS.BILLING_WRITE);

    const response = await app.request(`/v1/accounts/${ACCOUNT_ID}/studio/pricing-catalog`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pricingRequest()),
    });

    expect(response.status).toBe(403);
    expect(writes()).toBe(0);
  });
});
