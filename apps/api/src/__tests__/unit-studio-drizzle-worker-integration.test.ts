import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createDrizzleStudioRepository } from '../studio/repositories/drizzle';

const JOB_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const PROVIDER_ID = '44444444-4444-4444-8444-444444444444';
const MODULE_GRANT_ID = '88888888-8888-4888-8888-888888888888';

function jobRow(status: 'queued' | 'running' | 'cancelled' = 'queued') {
  return {
    jobId: JOB_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    actorUserId: '55555555-5555-4555-8555-555555555555',
    actorType: 'agent',
    capability: 'image.generate',
    providerConfigId: PROVIDER_ID,
    provider: 'fake',
    model: 'fake-image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'Studio',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    status,
    idempotencyKey: 'idem-1',
    requestHash: 'hash-1',
    attemptCount: status === 'running' ? 1 : 0,
    reservedCredits: '1.0000',
    actualCredits: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-15T10:00:00.000Z',
    updatedAt: '2026-07-15T10:00:00.000Z',
    startedAt: status === 'running' ? '2026-07-15T10:00:01.000Z' : null,
    completedAt: status === 'cancelled' ? '2026-07-15T10:00:02.000Z' : null,
  };
}

function createJobInputFixture() {
  return {
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_user_id: '55555555-5555-4555-8555-555555555555',
    actor_type: 'user' as const,
    acting_token_id: null,
    agent_name: null,
    session_id: null,
    parent_job_id: null,
    capability: 'image.generate' as const,
    provider_config_id: PROVIDER_ID,
    model: 'fake-image-v1',
    input: jobRow().input as never,
    estimate_id: '77777777-7777-4777-8777-777777777777',
    estimate_token: 'studio-estimate-token',
    idempotency_key: 'idem-1',
    request_hash: 'hash-1',
  };
}

function providerFixture() {
  return {
    provider_config_id: PROVIDER_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    provider: 'fake' as const,
    display_name: 'Fake',
    base_url: null,
    region: null,
    credential_binding: { kind: 'none' as const },
    capabilities: ['image.generate' as const],
    enabled: true,
    created_at: '2026-07-15T10:00:00.000Z',
    updated_at: '2026-07-15T10:00:00.000Z',
  };
}

function estimateFixture() {
  return {
    estimate_id: '77777777-7777-4777-8777-777777777777',
    estimate_token: 'studio-estimate-token',
    expires_at: '2026-07-15T10:05:00.000Z',
    currency: 'credits' as const,
    input_hash: 'hash-1',
    provider_cost_credits: 1,
    platform_cost_credits: 0,
    max_approved_credits: 1,
    line_items: [],
  };
}

function selectChain(rows: unknown[]) {
  return {
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: async () => rows }),
        limit: async () => rows,
      }),
    }),
  };
}

function collectBoundValues(node: unknown, values: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return values;
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return values;
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') values.push(chunk);
    else collectBoundValues(chunk, values);
  }
  return values;
}

function productionBindingFixture() {
  return {
    provider_config_version: 'canonical-provider-version-7',
    pricing_snapshot: {
      pricing_catalog_id: '88888888-8888-4888-8888-888888888888',
      version: 3,
      provider: 'openai-compatible',
      model: 'gpt-image-1',
      unit: 'image' as const,
      rate_credits: 2,
      max_provider_credits: 10,
      markup_credits: 0.25,
    },
  };
}

describe('Studio Drizzle repository worker integration', () => {
  test('allowlists public credential-binding fields instead of returning stored extras', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              providerConfigId: PROVIDER_ID,
              accountId: ACCOUNT_ID,
              projectId: PROJECT_ID,
              provider: 'fake',
              displayName: 'Fake',
              baseUrl: null,
              region: null,
              credentialBinding: {
                kind: 'secret',
                identifier: 'studio-primary',
                api_key: 'sk-must-not-leave-the-server',
                value: 'also-private',
              },
              capabilityMap: { 'image.generate': true },
              enabled: true,
              createdAt: '2026-07-15T10:00:00.000Z',
              updatedAt: '2026-07-15T10:00:00.000Z',
            },
          ],
        }),
      }),
      execute: async () => [],
      insert: () => {
        throw new Error('unexpected insert');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    const providers = await repository.listProviders(PROJECT_ID);

    expect(providers[0]?.credential_binding).toEqual({
      kind: 'secret',
      identifier: 'studio-primary',
    });
  });

  test('creates the durable job through atomic_create_studio_job so a reservation exists', async () => {
    let selectCalls = 0;
    let executeCalls = 0;
    const db = {
      select: () => selectChain(selectCalls++ === 0 ? [] : [jobRow()]),
      execute: async () => {
        executeCalls += 1;
        return [{ result: { success: true, idempotent: false, job_id: JOB_ID } }];
      },
      insert: () => {
        throw new Error('createJob must not directly insert studio_jobs');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    const result = await repository.createJob(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        actor_user_id: '55555555-5555-4555-8555-555555555555',
        actor_type: 'agent',
        acting_token_id: '66666666-6666-4666-8666-666666666666',
        agent_name: 'image-agent',
        session_id: 'session-1',
        parent_job_id: null,
        capability: 'image.generate',
        provider_config_id: PROVIDER_ID,
        model: 'fake-image-v1',
        input: jobRow().input as never,
        estimate_id: '77777777-7777-4777-8777-777777777777',
        estimate_token: 'studio-estimate-token',
        idempotency_key: 'idem-1',
        request_hash: 'hash-1',
      },
      {
        provider_config_id: PROVIDER_ID,
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        provider: 'fake',
        display_name: 'Fake',
        base_url: null,
        region: null,
        credential_binding: { kind: 'none' },
        capabilities: ['image.generate'],
        enabled: true,
        created_at: '2026-07-15T10:00:00.000Z',
        updated_at: '2026-07-15T10:00:00.000Z',
      },
      {
        estimate_id: '77777777-7777-4777-8777-777777777777',
        estimate_token: 'studio-estimate-token',
        expires_at: '2026-07-15T10:05:00.000Z',
        currency: 'credits',
        input_hash: 'hash-1',
        provider_cost_credits: 1,
        platform_cost_credits: 0,
        max_approved_credits: 1,
        line_items: [],
      },
    );

    expect(executeCalls).toBe(1);
    expect(result).toMatchObject({ created: true, job: { job_id: JOB_ID, status: 'queued' } });
  });

  test('atomically attaches a module grant after the legacy reservation RPC creates a row', async () => {
    let selectCalls = 0;
    let transactionCalls = 0;
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const moduleRow = {
      ...jobRow(),
      actorType: 'module',
      actingTokenId: null,
      moduleServiceGrantId: MODULE_GRANT_ID,
    };
    const transactionClient = {
      execute: async (query: unknown) => {
        const compiled = new PgDialect().sqlToQuery(query as never);
        queries.push({ sql: compiled.sql.toLowerCase(), params: [...compiled.params] });
        return queries.length === 1
          ? [{ result: { success: true, idempotent: false, job_id: JOB_ID } }]
          : [{ module_service_grant_id: MODULE_GRANT_ID }];
      },
    };
    const db = {
      select: () => selectChain(selectCalls++ === 0 ? [] : [moduleRow]),
      transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        transactionCalls += 1;
        return callback(transactionClient);
      },
      execute: async () => {
        throw new Error('module reservation must use a transaction');
      },
      insert: () => {
        throw new Error('createJob must not directly insert studio_jobs');
      },
      update: () => {
        throw new Error('module identity must be updated by the transaction');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    const result = await repository.createJob(
      {
        ...createJobInputFixture(),
        actor_type: 'module',
        acting_token_id: null,
        module_service_grant_id: MODULE_GRANT_ID,
      },
      providerFixture(),
      estimateFixture(),
    );

    expect(transactionCalls).toBe(1);
    expect(queries[0]?.params[3]).toBe('user');
    expect(queries[0]?.params).not.toContain(MODULE_GRANT_ID);
    expect(queries[1]?.params).toContain(MODULE_GRANT_ID);
    expect(result).toMatchObject({
      created: true,
      job: {
        job_id: JOB_ID,
        actor_type: 'module',
        module_service_grant_id: MODULE_GRANT_ID,
      },
    });
  });

  test('does not rewrite a concurrent idempotent user row as a module job', async () => {
    let selectCalls = 0;
    let transactionCalls = 0;
    let transactionQueryCount = 0;
    const userRow = { ...jobRow(), actorType: 'user', moduleServiceGrantId: null };
    const transactionClient = {
      execute: async () => {
        transactionQueryCount += 1;
        return [{ result: { success: true, idempotent: true, job_id: JOB_ID } }];
      },
    };
    const db = {
      select: () => selectChain(selectCalls++ === 0 ? [] : [userRow]),
      transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
        transactionCalls += 1;
        return callback(transactionClient);
      },
      execute: async () => {
        throw new Error('module reservation must use a transaction');
      },
      insert: () => {
        throw new Error('unexpected insert');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    const result = await repository.createJob(
      {
        ...createJobInputFixture(),
        actor_type: 'module',
        acting_token_id: null,
        module_service_grant_id: MODULE_GRANT_ID,
      },
      providerFixture(),
      estimateFixture(),
    );

    expect(transactionCalls).toBe(1);
    expect(transactionQueryCount).toBe(1);
    expect(result).toEqual({ created: false, mismatch: true });
  });

  test('binds the exact production provider and pricing snapshot to the 21-argument RPC', async () => {
    let selectCalls = 0;
    let executedQuery: unknown;
    const db = {
      select: () => selectChain(selectCalls++ === 0 ? [] : [jobRow()]),
      execute: async (query: unknown) => {
        executedQuery = query;
        return [{ result: { success: true, idempotent: false, job_id: JOB_ID } }];
      },
      insert: () => {
        throw new Error('createJob must not directly insert studio_jobs');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);
    const jobInput = {
      ...createJobInputFixture(),
      model: 'gpt-image-1',
      input: {
        ...jobRow().input,
        image: { ...jobRow().input.image, output_count: 2 },
      } as never,
    };
    const provider = {
      ...providerFixture(),
      provider: 'openai-compatible' as const,
      credential_binding: { kind: 'secret' as const, identifier: 'studio-image-key' },
    };
    const estimate = { ...estimateFixture(), max_approved_credits: 10.5 };
    const binding = productionBindingFixture();

    await repository.createJob(jobInput, provider, estimate, binding);

    const values = collectBoundValues(executedQuery);
    expect(values.slice(0, 20)).toEqual([
      ACCOUNT_ID,
      PROJECT_ID,
      jobInput.actor_user_id,
      jobInput.actor_type,
      jobInput.acting_token_id,
      jobInput.agent_name,
      jobInput.session_id,
      jobInput.parent_job_id,
      jobInput.capability,
      PROVIDER_ID,
      binding.provider_config_version,
      'openai-compatible',
      'gpt-image-1',
      binding.pricing_snapshot.pricing_catalog_id,
      binding.pricing_snapshot.version,
      JSON.stringify(binding.pricing_snapshot),
      JSON.stringify(jobInput.input),
      jobInput.idempotency_key,
      jobInput.request_hash,
      String(estimate.max_approved_credits),
    ]);
    expect(values).toHaveLength(21);
    expect(values[20]).toBeString();
  });

  test('records cancellation requests for running jobs instead of rejecting them', async () => {
    let executeCalls = 0;
    const db = {
      select: () => selectChain([jobRow('running')]),
      execute: async () => {
        executeCalls += 1;
        return [{ job_id: JOB_ID, status: 'running' }];
      },
      insert: () => {
        throw new Error('unexpected insert');
      },
      update: () => {
        throw new Error('running cancellation must be atomic SQL');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    const result = await repository.requestCancellation(PROJECT_ID, JOB_ID);

    expect(executeCalls).toBe(1);
    expect(result).toMatchObject({ job_id: JOB_ID, status: 'running' });
  });

  test('preserves atomic RPC idempotency when a concurrent creator wins', async () => {
    let selectCalls = 0;
    const db = {
      select: () => selectChain(selectCalls++ === 0 ? [] : [jobRow()]),
      execute: async () => [{ result: { success: true, idempotent: true, job_id: JOB_ID } }],
      insert: () => {
        throw new Error('unexpected insert');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);
    const provider = {
      provider_config_id: PROVIDER_ID,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      provider: 'fake' as const,
      display_name: 'Fake',
      base_url: null,
      region: null,
      credential_binding: { kind: 'none' as const },
      capabilities: ['image.generate' as const],
      enabled: true,
      created_at: '2026-07-15T10:00:00.000Z',
      updated_at: '2026-07-15T10:00:00.000Z',
    };
    const result = await repository.createJob(
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        actor_user_id: '55555555-5555-4555-8555-555555555555',
        actor_type: 'user',
        acting_token_id: null,
        agent_name: null,
        session_id: null,
        parent_job_id: null,
        capability: 'image.generate',
        provider_config_id: PROVIDER_ID,
        model: 'fake-image-v1',
        input: jobRow().input as never,
        estimate_id: '77777777-7777-4777-8777-777777777777',
        estimate_token: 'studio-estimate-token',
        idempotency_key: 'idem-1',
        request_hash: 'hash-1',
      },
      provider,
      {
        estimate_id: '77777777-7777-4777-8777-777777777777',
        estimate_token: 'studio-estimate-token',
        expires_at: '2026-07-15T10:05:00.000Z',
        currency: 'credits',
        input_hash: 'hash-1',
        provider_cost_credits: 1,
        platform_cost_credits: 0,
        max_approved_credits: 1,
        line_items: [],
      },
    );

    expect(result).toMatchObject({ created: false, job: { job_id: JOB_ID } });
  });

  test('raises a typed public error when the reservation RPC reports insufficient credits', async () => {
    const db = {
      select: () => selectChain([]),
      execute: async () => [
        {
          result: {
            success: false,
            code: 'insufficient_credits',
            error: 'Insufficient credits',
            required: 1,
            available: 0,
          },
        },
      ],
      insert: () => {
        throw new Error('unexpected insert');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    try {
      await repository.createJob(createJobInputFixture(), providerFixture(), estimateFixture());
      throw new Error('Expected createJob to reject');
    } catch (error) {
      expect(error).toMatchObject({
        studioCode: 'STUDIO_INSUFFICIENT_CREDITS',
        httpStatus: 402,
        message: 'Insufficient credits',
      });
    }
  });

  test.each([
    ['provider_config_stale', 'STUDIO_PROVIDER_CONFIG_STALE'],
    ['pricing_stale', 'STUDIO_PRICING_STALE'],
  ] as const)('maps %s reservation fencing to a stable 409 error', async (rpcCode, studioCode) => {
    const db = {
      select: () => selectChain([]),
      execute: async () => [
        { result: { success: false, code: rpcCode, error: 'internal database detail' } },
      ],
      insert: () => {
        throw new Error('unexpected insert');
      },
      update: () => {
        throw new Error('unexpected update');
      },
    };
    const repository = createDrizzleStudioRepository(db as never);

    try {
      await repository.createJob(
        { ...createJobInputFixture(), model: 'gpt-image-1' },
        {
          ...providerFixture(),
          provider: 'openai-compatible',
          credential_binding: { kind: 'secret', identifier: 'studio-image-key' },
        },
        estimateFixture(),
        productionBindingFixture(),
      );
      throw new Error('Expected createJob to reject');
    } catch (error) {
      expect(error).toMatchObject({ studioCode, httpStatus: 409 });
      expect((error as Error).message).not.toContain('internal database detail');
    }
  });
});
