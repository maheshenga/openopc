import { describe, expect, test } from 'bun:test';
import type { IntelligenceCreateTaskRequest } from '@kortix/api-contract';
import type { StudioJobEvent } from '@kortix/api-contract';
import type { StudioJob } from '@kortix/api-contract';
import { canonicalStudioRequestHash } from '@kortix/studio-runtime';
import { createMemoryStudioRepository } from '../studio/repositories/memory';
import {
  type IntelligenceTaskCreateInput,
  IntelligenceTaskService,
  createDrizzleIntelligenceTaskStore,
  createInMemoryIntelligenceTaskStore,
  createStudioJobBridge,
  intelligenceStudioIdempotencyKey,
  intelligenceTaskRequestHash,
  studioRequestHash,
} from './task-service';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '11000000-0000-4000-a000-000000000002';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '12000000-0000-4000-a000-000000000002';
const USER_ID = '13000000-0000-4000-a000-000000000001';
const PROVIDER_ID = '14000000-0000-4000-a000-000000000001';
const JOB_ID = '16000000-0000-4000-a000-000000000001';
const OTHER_JOB_ID = '16000000-0000-4000-a000-000000000002';
const TASK_ID = '15000000-0000-4000-a000-000000000001';

const request = (overrides: Partial<IntelligenceCreateTaskRequest> = {}) =>
  ({
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: 'a'.repeat(64),
    provider_config_id: PROVIDER_ID,
    model: 'fake/image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'A studio test image',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    idempotency_key: 'intelligence-task-idempotency-01',
    parent_task_id: null,
    deadline_at: null,
    ...overrides,
  }) satisfies IntelligenceCreateTaskRequest;

function createInput(
  projectId = PROJECT_ID,
  taskRequest: IntelligenceCreateTaskRequest = request(),
): IntelligenceTaskCreateInput {
  return {
    accountId: ACCOUNT_ID,
    projectId,
    actorUserId: USER_ID,
    actorType: 'user',
    actingTokenId: null,
    agentName: null,
    sessionId: null,
    request: taskRequest,
  };
}

function createService(studioEvents: StudioJobEvent[] = []) {
  const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
  const createCalls: unknown[] = [];
  const readCursors: Array<string | null> = [];
  const service = new IntelligenceTaskService({
    store,
    createStudioJob: async (input) => {
      createCalls.push(input);
      return { jobId: JOB_ID, created: true };
    },
    readStudioEvents: async ({ cursor }) => {
      readCursors.push(cursor);
      return { items: studioEvents, next_cursor: null };
    },
    now: () => new Date('2026-07-18T12:00:00.000Z'),
  });
  return { service, store, createCalls, readCursors };
}

describe('IntelligenceTaskService', () => {
  test('creates one task and one Studio job, then replays the same IDs', async () => {
    const { service, createCalls } = createService();

    const first = await service.create(createInput());
    const replay = await service.create(createInput());

    expect(first).toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: true });
    expect(replay).toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: false });
    expect(createCalls).toHaveLength(1);
  });

  test('looks up a bound replay without creating another Studio job', async () => {
    const { service, createCalls } = createService();
    await service.create(createInput());
    const replayService = service as IntelligenceTaskService & {
      replay(input: {
        accountId: string;
        projectId: string;
        request: IntelligenceCreateTaskRequest;
      }): Promise<{ taskId: string; jobId: string; created: boolean } | null>;
    };

    await expect(
      replayService.replay({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        request: request(),
      }),
    ).resolves.toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: false });
    expect(createCalls).toHaveLength(1);
  });

  test('rejects an idempotency replay whose request hash differs', async () => {
    const { service, createCalls } = createService();
    await service.create(createInput());

    await expect(
      service.create(createInput(PROJECT_ID, request({ model: 'fake/another-image-v1' }))),
    ).rejects.toMatchObject({ code: 'INTELLIGENCE_IDEMPOTENCY_MISMATCH', status: 409 });
    expect(createCalls).toHaveLength(1);
  });

  test('rejects a bound task replay from a different account', async () => {
    const { service, createCalls } = createService();
    await service.create(createInput());

    await expect(
      service.create({ ...createInput(), accountId: OTHER_ACCOUNT_ID }),
    ).rejects.toMatchObject({ code: 'INTELLIGENCE_IDEMPOTENCY_MISMATCH', status: 409 });
    expect(createCalls).toHaveLength(1);
  });

  test('serializes concurrent creates for one project and idempotency key', async () => {
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    let createCalls = 0;
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: async () => {
        createCalls += 1;
        await Promise.resolve();
        return { jobId: JOB_ID, created: true };
      },
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });
    const results = await Promise.all([
      service.create(createInput()),
      service.create(createInput()),
      service.create(createInput()),
    ]);
    expect(createCalls).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => `${result.taskId}:${result.jobId}`)).size).toBe(1);
  });

  test('uses the Intelligence task insert as the created response boundary', async () => {
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: async () => ({ jobId: JOB_ID, created: false }),
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });

    await expect(service.create(createInput())).resolves.toEqual({
      taskId: TASK_ID,
      jobId: JOB_ID,
      created: true,
    });
  });

  test('hashes the complete request envelope, including card, parent, and deadline', () => {
    const base = request();
    const {
      parent_task_id: _parentTaskId,
      deadline_at: _deadlineAt,
      ...withoutOptionalNulls
    } = base;
    expect(intelligenceTaskRequestHash(withoutOptionalNulls)).toBe(
      intelligenceTaskRequestHash(base),
    );
    expect(intelligenceTaskRequestHash(base)).not.toBe(
      intelligenceTaskRequestHash({ ...base, agent_card_hash: 'b'.repeat(64) }),
    );
    expect(intelligenceTaskRequestHash(base)).not.toBe(
      intelligenceTaskRequestHash({ ...base, parent_task_id: TASK_ID }),
    );
    expect(intelligenceTaskRequestHash(base)).not.toBe(
      intelligenceTaskRequestHash({
        ...base,
        deadline_at: '2026-07-18T13:00:00.000Z',
      }),
    );
  });

  test('uses a project-scoped Intelligence Studio key and keeps the Studio hash separate', async () => {
    const { service, createCalls } = createService();
    const taskRequest = request();
    await service.create(createInput(PROJECT_ID, taskRequest));

    const call = createCalls[0] as Record<string, unknown>;
    expect(call.studioIdempotencyKey).toEqual(
      expect.stringContaining(`intelligence:v1:${PROJECT_ID}:`),
    );
    expect(call.studioIdempotencyKey).not.toContain(TASK_ID);
    expect(call.requestHash).toBe(intelligenceTaskRequestHash(taskRequest));
    expect(call.studioRequestHash).toBe(
      canonicalStudioRequestHash({
        capability: taskRequest.input.capability,
        provider_config_id: taskRequest.provider_config_id,
        model: taskRequest.model,
        input: taskRequest.input,
      }),
    );
    expect(call.studioRequestHash).not.toBe(call.requestHash);
  });

  test('reuses an existing Studio job before provider readiness on retry', async () => {
    const taskRequest = request();
    const studioKey = intelligenceStudioIdempotencyKey(PROJECT_ID, taskRequest.idempotency_key);
    const studioHash = studioRequestHash(taskRequest);
    const existingJob = {
      job_id: JOB_ID,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      idempotency_key: studioKey,
      request_hash: studioHash,
    } as StudioJob;
    const repository = createMemoryStudioRepository();
    repository.findJobByIdempotency = async () => existingJob;
    repository.getProvider = async () => {
      throw new Error('provider lookup must not run for an existing job');
    };
    let readinessChecks = 0;
    const bridge = createStudioJobBridge({
      repository,
      assertReadyBeforeReservation: async () => {
        readinessChecks += 1;
        throw new Error('Studio is no longer ready');
      },
    });

    await expect(
      bridge({
        ...createInput(PROJECT_ID, taskRequest),
        requestHash: intelligenceTaskRequestHash(taskRequest),
        studioRequestHash: studioHash,
        studioIdempotencyKey: studioKey,
        parentJobId: null,
      }),
    ).resolves.toEqual({ jobId: JOB_ID, created: false });
    expect(readinessChecks).toBe(0);
  });

  test('serializes concurrent service instances to one task and one Studio job', async () => {
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    let createCalls = 0;
    const makeService = () =>
      new IntelligenceTaskService({
        store,
        createStudioJob: async () => {
          createCalls += 1;
          await Promise.resolve();
          return { jobId: JOB_ID, created: true };
        },
        readStudioEvents: async () => ({ items: [], next_cursor: null }),
        now: () => new Date('2026-07-18T12:00:00.000Z'),
      });

    const [first, second] = await Promise.all([
      makeService().create(createInput()),
      makeService().create(createInput()),
    ]);
    expect(first).toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: true });
    expect(second).toEqual({ taskId: TASK_ID, jobId: JOB_ID, created: false });
    expect(createCalls).toBe(1);
  });

  test('keeps an unbound task retryable when Studio creation fails', async () => {
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    let attempts = 0;
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary Studio failure');
        return { jobId: JOB_ID, created: true };
      },
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });

    await expect(service.create(createInput())).rejects.toThrow('temporary Studio failure');
    await expect(
      store.get({ accountId: ACCOUNT_ID, projectId: PROJECT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ taskId: TASK_ID, jobId: null, status: 'queued' });

    await expect(service.create(createInput())).resolves.toEqual({
      taskId: TASK_ID,
      jobId: JOB_ID,
      created: false,
    });
    expect(attempts).toBe(2);
  });

  test('keeps unbound replay side-effect free and recovers only through create', async () => {
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    let attempts = 0;
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('attach outcome is uncertain');
        return { jobId: JOB_ID, created: false };
      },
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });
    await expect(service.create(createInput())).rejects.toThrow('attach outcome is uncertain');

    await expect(
      service.replay({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        request: request(),
      }),
    ).resolves.toBeNull();
    expect(attempts).toBe(1);

    await expect(service.create(createInput())).resolves.toEqual({
      taskId: TASK_ID,
      jobId: JOB_ID,
      created: false,
    });
    expect(attempts).toBe(2);
  });

  test('fails closed when the task store returns a different bound job', async () => {
    const baseStore = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    const store = {
      ...baseStore,
      async createWithJob(
        input: Parameters<typeof baseStore.createWithJob>[0],
        createJob: Parameters<typeof baseStore.createWithJob>[1],
      ) {
        const result = await baseStore.createWithJob(input, createJob);
        return { ...result, jobId: OTHER_JOB_ID };
      },
    };
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: async () => ({ jobId: JOB_ID, created: true }),
      readStudioEvents: async () => ({ items: [], next_cursor: null }),
    });

    await expect(service.create(createInput())).rejects.toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTION_FAILED',
      status: 503,
    });
  });

  test('fails closed when a durable replay points to an out-of-scope Studio job', async () => {
    let selectCalls = 0;
    const taskRow = {
      taskId: TASK_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: OTHER_JOB_ID,
      actorUserId: USER_ID,
      actorType: 'user',
      actingTokenId: null,
      agentName: null,
      sessionId: null,
      parentTaskId: null,
      capabilityId: 'studio.image.generate',
      capabilityVersion: '1.0.0',
      providerConfigId: PROVIDER_ID,
      model: 'fake/image-v1',
      requestHash: intelligenceTaskRequestHash(request()),
      idempotencyKey: request().idempotency_key,
      status: 'queued',
      agentCardHash: 'a'.repeat(64),
      studioSourceCursor: null,
      deadlineAt: null,
      createdAt: '2026-07-18T12:00:00.000Z',
      updatedAt: '2026-07-18T12:00:00.000Z',
    };
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCalls += 1;
              return selectCalls === 1 ? [taskRow] : [];
            },
          }),
        }),
      }),
    };
    const store = createDrizzleIntelligenceTaskStore(database as never);

    await expect(
      store.findByIdempotency({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        idempotencyKey: request().idempotency_key,
      }),
    ).rejects.toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTION_FAILED',
      status: 503,
    });
  });

  test('resolves a same-project parent and rejects a cross-project parent', async () => {
    const { service, store, createCalls } = createService();
    const parent = await service.create(
      createInput(PROJECT_ID, request({ idempotency_key: 'parent-task-idempotency-01' })),
    );
    await service.create(
      createInput(
        PROJECT_ID,
        request({ idempotency_key: 'child-task-idempotency-01', parent_task_id: parent.taskId }),
      ),
    );
    expect((createCalls[1] as Record<string, unknown>).parentJobId).toBe(JOB_ID);

    await expect(
      service.create(
        createInput(
          OTHER_PROJECT_ID,
          request({
            idempotency_key: 'foreign-child-idempotency-01',
            parent_task_id: parent.taskId,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'INTELLIGENCE_VALIDATION_ERROR', status: 400 });
    expect(createCalls).toHaveLength(2);

    await expect(
      store.findByIdempotency({
        accountId: ACCOUNT_ID,
        projectId: OTHER_PROJECT_ID,
        idempotencyKey: 'foreign-child-idempotency-01',
      }),
    ).resolves.toBeNull();

    const otherProjectParent = await service.create(
      createInput(
        OTHER_PROJECT_ID,
        request({ idempotency_key: 'foreign-project-parent-idempotency-01' }),
      ),
    );
    await expect(
      service.create(
        createInput(
          OTHER_PROJECT_ID,
          request({
            idempotency_key: 'foreign-child-idempotency-01',
            parent_task_id: otherProjectParent.taskId,
          }),
        ),
      ),
    ).resolves.toMatchObject({ created: true });
    expect(createCalls).toHaveLength(4);
  });

  test('does not expose a task or events across project boundaries', async () => {
    const { service } = createService();
    await service.create(createInput());

    await expect(
      service.events({
        accountId: ACCOUNT_ID,
        projectId: OTHER_PROJECT_ID,
        taskId: TASK_ID,
        cursor: null,
      }),
    ).resolves.toBeNull();
  });

  test('persists a monotonic public cursor and strips provider secrets and object keys', async () => {
    const studioEvents: StudioJobEvent[] = [
      {
        event_id: '17000000-0000-4000-a000-000000000001',
        job_id: JOB_ID,
        cursor: '2',
        type: 'progress',
        payload: {
          progress: 0.5,
          provider_request_id: 'provider-secret-id',
          object_key: 'private/object/key.png',
          raw_provider_body: { secret: 'must-not-leak' },
        },
        created_at: '2026-07-18T12:00:01.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000002',
        job_id: JOB_ID,
        cursor: '3',
        type: 'asset-created',
        payload: {
          asset_id: '18000000-0000-4000-a000-000000000001',
          signed_url: 'https://storage.example/signed-secret',
          object_key: 'private/object/key.png',
        },
        created_at: '2026-07-18T12:00:02.000Z',
      },
    ];
    const { service } = createService(studioEvents);
    await service.create(createInput());

    const firstPage = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(firstPage).not.toBeNull();
    expect(firstPage?.items.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(firstPage?.nextCursor).toBeNull();
    expect(firstPage?.items[1]).toMatchObject({ type: 'progress', progress: 0.5 });
    expect(firstPage?.items[2]).toMatchObject({
      type: 'asset_created',
      asset_ids: ['18000000-0000-4000-a000-000000000001'],
    });
    const serialized = JSON.stringify(firstPage);
    expect(serialized).not.toContain('provider-secret-id');
    expect(serialized).not.toContain('private/object/key.png');
    expect(serialized).not.toContain('signed-secret');

    const secondPage = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: '1',
    });
    expect(secondPage?.items.map((event) => event.sequence)).toEqual([2, 3]);
    expect(secondPage?.items[0].sequence).toBeGreaterThan(1);
  });

  test('publishes only allowlisted Studio error codes', async () => {
    const { service } = createService([
      {
        event_id: '17000000-0000-4000-a000-000000000006',
        job_id: JOB_ID,
        cursor: '2',
        type: 'progress',
        payload: { progress: 0.5, error_code: 'STUDIO_PROVIDER_TIMEOUT' },
        created_at: '2026-07-18T12:00:01.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000007',
        job_id: JOB_ID,
        cursor: '3',
        type: 'failed',
        payload: { error_code: 'SK-ABC1234567890' },
        created_at: '2026-07-18T12:00:02.000Z',
      },
    ]);
    await service.create(createInput());

    const page = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(page?.items[1]).toMatchObject({ error_code: 'STUDIO_PROVIDER_TIMEOUT' });
    expect(page?.items[2]).not.toHaveProperty('error_code');
    expect(JSON.stringify(page)).not.toContain('SK-ABC1234567890');
  });

  test('advances through internal Studio events without exposing them as public progress', async () => {
    const studioEvents: StudioJobEvent[] = [
      {
        event_id: '17000000-0000-4000-a000-000000000010',
        job_id: JOB_ID,
        cursor: '2',
        type: 'progress',
        payload: { progress: 0.25 },
        created_at: '2026-07-18T12:00:01.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000011',
        job_id: JOB_ID,
        cursor: '3',
        type: 'retry-scheduled',
        payload: { provider_request_id: 'private-retry-id', retry_after_seconds: 5 },
        created_at: '2026-07-18T12:00:02.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000012',
        job_id: JOB_ID,
        cursor: '4',
        type: 'billing-settled',
        payload: { actual_credits: 12.5, reservation_id: 'private-reservation-id' },
        created_at: '2026-07-18T12:00:03.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000013',
        job_id: JOB_ID,
        cursor: '5',
        type: 'succeeded',
        payload: {},
        created_at: '2026-07-18T12:00:04.000Z',
      },
    ];
    const { service, readCursors } = createService(studioEvents);
    await service.create(createInput());

    const page = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(page?.items.map((event) => event.type)).toEqual(['created', 'progress', 'succeeded']);
    expect(page?.items.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(page)).not.toContain('private-retry-id');
    expect(JSON.stringify(page)).not.toContain('private-reservation-id');

    await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: '0',
    });
    expect(readCursors).toEqual([null, '5']);
  });

  test('drains Studio event pages from the last returned cursor without skipping terminal events', async () => {
    const studioEvents: StudioJobEvent[] = [
      ...Array.from({ length: 101 }, (_, index) => ({
        event_id: `17000000-0000-4000-a000-${(index + 1).toString(16).padStart(12, '0')}`,
        job_id: JOB_ID,
        cursor: String(index + 1),
        type: 'retry-scheduled' as const,
        payload: { retry_after_seconds: 1 },
        created_at: new Date(Date.parse('2026-07-18T12:00:00.000Z') + index * 1_000).toISOString(),
      })),
      {
        event_id: '17000000-0000-4000-a000-000000000102',
        job_id: JOB_ID,
        cursor: '102',
        type: 'succeeded',
        payload: {},
        created_at: '2026-07-18T12:02:00.000Z',
      },
    ];
    const readCursors: Array<string | null> = [];
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: async () => ({ jobId: JOB_ID, created: true }),
      readStudioEvents: async ({ cursor }) => {
        readCursors.push(cursor);
        const after = Number(cursor ?? 0);
        const rows = studioEvents.filter((event) => Number(event.cursor) > after);
        return {
          items: rows.slice(0, 100),
          // Mirror the legacy repository bug: its continuation points at the
          // first row not returned. The bridge must advance from items.at(-1).
          next_cursor: rows.length > 100 ? rows[100].cursor : null,
        };
      },
    });
    await service.create(createInput());

    const page = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(page?.items.map((event) => event.type)).toEqual(['created', 'succeeded']);
    expect(readCursors).toEqual([null, '100']);
  });

  test('keeps a next cursor when exactly one public event remains after the page limit', async () => {
    const studioEvents: StudioJobEvent[] = Array.from({ length: 100 }, (_, index) => ({
      event_id: `17000000-0000-4000-a000-${(index + 1).toString(16).padStart(12, '0')}`,
      job_id: JOB_ID,
      cursor: String(index + 1),
      type: 'progress' as const,
      payload: { progress: (index + 1) / 100 },
      created_at: new Date(Date.parse('2026-07-18T12:00:00.000Z') + index * 1_000).toISOString(),
    }));
    const { service } = createService(studioEvents);
    await service.create(createInput());

    const first = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(first?.items).toHaveLength(100);
    expect(first?.nextCursor).toBe('100');

    const second = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: first?.nextCursor ?? null,
    });
    expect(second?.items).toHaveLength(1);
    expect(second?.items[0].sequence).toBe(101);
    expect(second?.nextCursor).toBeNull();
  });

  test('advances past malformed public payloads without fabricating unusable events', async () => {
    const studioEvents: StudioJobEvent[] = [
      {
        event_id: '17000000-0000-4000-a000-000000000020',
        job_id: JOB_ID,
        cursor: '2',
        type: 'progress',
        payload: { phase: 'operator-review', raw_provider_body: { secret: 'x' } },
        created_at: '2026-07-18T12:00:01.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000021',
        job_id: JOB_ID,
        cursor: '3',
        type: 'asset-created',
        payload: { asset_id: 'not-a-uuid', object_key: 'private/key' },
        created_at: '2026-07-18T12:00:02.000Z',
      },
    ];
    const { service } = createService(studioEvents);
    await service.create(createInput());
    const page = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(page?.items).toHaveLength(1);
    expect(page?.items[0].type).toBe('created');
    expect(JSON.stringify(page)).not.toContain('private/key');
  });

  test('does not regress a terminal task when a stale progress event arrives', async () => {
    const { service, store } = createService();
    await service.create(createInput());

    await expect(
      store.appendEvent({
        taskId: TASK_ID,
        eventId: '17000000-0000-4000-a000-000000000030',
        studioCursor: '2',
        type: 'succeeded',
        status: 'succeeded',
        payload: {},
        createdAt: '2026-07-18T12:00:02.000Z',
      }),
    ).resolves.toMatchObject({ status: 'succeeded' });

    await expect(
      store.appendEvent({
        taskId: TASK_ID,
        eventId: '17000000-0000-4000-a000-000000000031',
        studioCursor: '3',
        type: 'progress',
        status: 'running',
        payload: { progress: 0.5 },
        createdAt: '2026-07-18T12:00:03.000Z',
      }),
    ).resolves.toBeNull();

    await expect(
      store.get({ accountId: ACCOUNT_ID, projectId: PROJECT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ status: 'succeeded', studioSourceCursor: '3' });
  });

  test('does not expose a late asset event after the task is terminal', async () => {
    const { service, store } = createService([
      {
        event_id: '17000000-0000-4000-a000-000000000032',
        job_id: JOB_ID,
        cursor: '2',
        type: 'succeeded',
        payload: {},
        created_at: '2026-07-18T12:00:02.000Z',
      },
      {
        event_id: '17000000-0000-4000-a000-000000000033',
        job_id: JOB_ID,
        cursor: '3',
        type: 'asset-created',
        payload: { asset_id: '18000000-0000-4000-a000-000000000001' },
        created_at: '2026-07-18T12:00:03.000Z',
      },
    ]);
    await service.create(createInput());

    const page = await service.events({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      cursor: null,
    });
    expect(page?.items.map((event) => event.type)).toEqual(['created', 'succeeded']);
    await expect(
      store.get({ accountId: ACCOUNT_ID, projectId: PROJECT_ID, taskId: TASK_ID }),
    ).resolves.toMatchObject({ status: 'succeeded', studioSourceCursor: '3' });
  });

  test('fails closed when a different terminal event follows a terminal task', async () => {
    const { service, store } = createService();
    await service.create(createInput());
    await store.appendEvent({
      taskId: TASK_ID,
      eventId: '17000000-0000-4000-a000-000000000040',
      studioCursor: '2',
      type: 'succeeded',
      status: 'succeeded',
      payload: {},
      createdAt: '2026-07-18T12:00:02.000Z',
    });

    await expect(
      store.appendEvent({
        taskId: TASK_ID,
        eventId: '17000000-0000-4000-a000-000000000041',
        studioCursor: '3',
        type: 'failed',
        status: 'failed',
        payload: { error_code: 'PROVIDER_FAILED' },
        createdAt: '2026-07-18T12:00:03.000Z',
      }),
    ).rejects.toMatchObject({
      code: 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE',
      status: 503,
    });
  });
});
