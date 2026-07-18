import { describe, expect, test } from 'bun:test';
import type { IntelligenceCreateTaskRequest, StudioJobEvent } from '@kortix/api-contract';
import { createFakeStudioProvider } from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { buildProjectAgentCard } from '../intelligence/agent-cards';
import { createProjectCapabilityRegistry } from '../intelligence/capability-registry';
import { createIntelligenceProjectRoutes } from '../intelligence/project-routes';
import {
  IntelligenceTaskService,
  createInMemoryIntelligenceTaskStore,
  createStudioJobBridge,
} from '../intelligence/task-service';
import { createMemoryStudioRepository } from '../studio/repositories/memory';

const ACCOUNT_ID = '31000000-0000-4000-a000-000000000001';
const PROJECT_ID = '32000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '32000000-0000-4000-a000-000000000002';
const USER_ID = '33000000-0000-4000-a000-000000000001';
const TASK_ID = '34000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '35000000-0000-4000-a000-000000000001';
const ASSET_ID = '36000000-0000-4000-a000-000000000001';
const NOW = '2026-07-18T12:00:00.000Z';
const PRIVATE_PROMPT = 'PRIVATE_ACCEPTANCE_PROMPT';
const PRIVATE_PROVIDER_RESPONSE = 'PRIVATE_PROVIDER_RESPONSE';
const PRIVATE_SIGNED_URL = 'https://storage.example.test/result.png?signature=PRIVATE_SIGNATURE';

const fakeProviderConfig = {
  provider_config_id: PROVIDER_CONFIG_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  provider: 'fake' as const,
  display_name: 'Protocol acceptance fake provider',
  base_url: null,
  region: null,
  credential_binding: { kind: 'none' as const },
  capabilities: ['image.generate' as const],
  enabled: true,
  created_at: NOW,
  updated_at: NOW,
};

describe('Intelligence protocol acceptance', () => {
  test('runs one governed image task through REST and A2A to terminal public events', async () => {
    const repository = createMemoryStudioRepository({
      providers: [fakeProviderConfig],
      now: () => NOW,
    });
    const store = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    const studioEvents: StudioJobEvent[] = [];
    let taskCreates = 0;
    let studioJobCreates = 0;
    let providerSubmissions = 0;
    let revoked = false;

    const originalCreateJob = repository.createJob.bind(repository);
    repository.createJob = async (...args) => {
      studioJobCreates += 1;
      return originalCreateJob(...args);
    };
    const service = new IntelligenceTaskService({
      store,
      createStudioJob: createStudioJobBridge({
        repository,
        assertReadyBeforeReservation: async () => {},
        now: () => new Date(NOW),
      }),
      readStudioEvents: async ({ jobId, cursor }) => ({
        items: studioEvents.filter(
          (event) => event.job_id === jobId && Number(event.cursor) > Number(cursor ?? 0),
        ),
        next_cursor: null,
      }),
      now: () => new Date(NOW),
    });
    const capabilityRegistry = createProjectCapabilityRegistry({
      repository,
      isStorageReady: async () => true,
    });
    const routes = createIntelligenceProjectRoutes({
      capabilityRegistry,
      getAgentCard: async ({ projectId, capabilities }) =>
        buildProjectAgentCard({
          projectId,
          agentId: 'kortix-studio',
          displayName: 'Kortix Studio',
          capabilities,
          protocols: ['mcp', 'a2a'],
        }),
      loadProjectForUser: async (_context, projectId) =>
        projectId === PROJECT_ID
          ? { row: { accountId: ACCOUNT_ID, projectId }, userId: USER_ID }
          : null,
      assertProjectCapability: async () => {
        if (revoked) throw new HTTPException(403, { message: 'Forbidden' });
      },
      taskExecutor: {
        replay: service.replay.bind(service),
        create: async (input) => {
          taskCreates += 1;
          return service.create(input);
        },
      },
      taskEventReader: { read: service.events.bind(service) },
    });
    const app = new Hono();
    app.use('*', async (context, next) => {
      const writable = context as unknown as { set(key: string, value: unknown): void };
      writable.set('authType', 'pat');
      writable.set('iamTokenId', 'acceptance-token');
      writable.set('sessionId', 'acceptance-session');
      writable.set('agentGrant', { agent: 'acceptance-agent' });
      await next();
    });
    app.route('/v1/projects', routes);
    app.onError((error, context) => {
      if (error instanceof HTTPException) {
        return context.json({ error: error.message, status: error.status }, error.status);
      }
      return context.json({ error: 'Internal error' }, 500);
    });

    const responseTexts: string[] = [];
    const discovery = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/capabilities?include=execution_targets`,
    );
    expect(discovery.status).toBe(200);
    const discoveryText = await discovery.text();
    responseTexts.push(discoveryText);
    const discoveryBody = JSON.parse(discoveryText) as {
      execution_targets: Array<{
        capability_id: 'studio.image.generate';
        provider_config_id: string;
        model: string;
      }>;
    };
    expect(discoveryBody.execution_targets).toEqual([
      {
        capability_id: 'studio.image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
      },
    ]);

    const card = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/agent-card`);
    expect(card.status).toBe(200);
    const cardText = await card.text();
    responseTexts.push(cardText);
    const cardHash = (JSON.parse(cardText) as { card_hash: string }).card_hash;
    const request: IntelligenceCreateTaskRequest = {
      protocol_version: 'intelligence.v1',
      agent_card_hash: cardHash,
      ...discoveryBody.execution_targets[0],
      input: {
        capability: 'image.generate',
        image: {
          prompt: PRIVATE_PROMPT,
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      },
      idempotency_key: 'intelligence-acceptance-task-0001',
      parent_task_id: null,
      deadline_at: null,
    };

    const created = await postJson(app, `/v1/projects/${PROJECT_ID}/intelligence/tasks`, request);
    expect(created.response.status).toBe(201);
    responseTexts.push(created.text);
    const createdBody = JSON.parse(created.text) as {
      task_id: string;
      job_id: string;
      created: boolean;
    };
    expect(createdBody).toMatchObject({ task_id: TASK_ID, created: true });

    const replayed = await postJson(app, `/v1/projects/${PROJECT_ID}/intelligence/tasks`, request);
    expect(replayed.response.status).toBe(200);
    responseTexts.push(replayed.text);
    expect(JSON.parse(replayed.text)).toMatchObject({
      task_id: TASK_ID,
      job_id: createdBody.job_id,
      created: false,
    });

    const a2aReplay = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/tasks`,
      {
        jsonrpc: '2.0',
        id: 'acceptance-a2a-replay',
        method: 'message/send',
        params: { sender_card_hash: cardHash, task: request },
      },
      'application/a2a+json',
    );
    expect(a2aReplay.response.status).toBe(200);
    expect(a2aReplay.response.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    responseTexts.push(a2aReplay.text);
    expect(JSON.parse(a2aReplay.text)).toMatchObject({
      id: TASK_ID,
      contextId: PROJECT_ID,
      metadata: { job_id: createdBody.job_id },
    });

    const crossTenant = await postJson(
      app,
      `/v1/projects/${OTHER_PROJECT_ID}/intelligence/tasks`,
      request,
    );
    expect(crossTenant.response.status).toBe(404);
    responseTexts.push(crossTenant.text);

    revoked = true;
    const revokedRequest = { ...request, idempotency_key: 'intelligence-revoked-task-0001' };
    const denied = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/tasks`,
      revokedRequest,
    );
    expect(denied.response.status).toBe(403);
    responseTexts.push(denied.text);
    expect(providerSubmissions).toBe(0);
    revoked = false;

    const jobs = await repository.listJobs(PROJECT_ID, 100, null);
    expect(jobs.items).toHaveLength(1);
    expect(jobs.items[0]?.job_id).toBe(createdBody.job_id);
    const task = await store.get({ accountId: ACCOUNT_ID, projectId: PROJECT_ID, taskId: TASK_ID });
    expect(task).toMatchObject({ taskId: TASK_ID, jobId: createdBody.job_id });
    expect({ taskCreates, studioJobCreates }).toEqual({ taskCreates: 1, studioJobCreates: 1 });

    const fakeProvider = createFakeStudioProvider();
    const providerContext = {
      correlationId: createdBody.job_id,
      submissionKey: `acceptance:${createdBody.job_id}`,
    };
    providerSubmissions += 1;
    const submission = await fakeProvider.submit(providerContext, request.input);
    if (submission.kind !== 'async') throw new Error('fake provider must be asynchronous');
    expect(await fakeProvider.poll(providerContext, submission.handle)).toMatchObject({
      status: 'succeeded',
    });
    const providerResult = await fakeProvider.fetchResult(providerContext, submission.handle);
    expect(providerResult.assets).toHaveLength(1);

    const queued = await repository.listEvents(PROJECT_ID, createdBody.job_id, null);
    studioEvents.push(
      ...queued.items,
      studioEvent(createdBody.job_id, '2', 'provider-submitted', {}),
      studioEvent(createdBody.job_id, '3', 'progress', {
        progress: 0.75,
        raw_provider_body: PRIVATE_PROVIDER_RESPONSE,
      }),
      studioEvent(createdBody.job_id, '4', 'asset-created', {
        asset_id: ASSET_ID,
        signed_url: PRIVATE_SIGNED_URL,
      }),
      studioEvent(createdBody.job_id, '5', 'succeeded', {}),
      studioEvent(createdBody.job_id, '6', 'billing-settled', {
        reservation_id: 'PRIVATE_RESERVATION_ID',
      }),
    );

    const events = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
    );
    expect(events.status).toBe(200);
    const eventsText = await events.text();
    responseTexts.push(eventsText);
    const eventsBody = JSON.parse(eventsText) as {
      items: Array<{ sequence: number; type: string; status: string; asset_ids?: string[] }>;
      next_cursor: string | null;
    };
    expect(eventsBody.items.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(eventsBody.items.at(-1)).toMatchObject({ type: 'succeeded', status: 'succeeded' });
    expect(eventsBody.items.find((event) => event.type === 'asset_created')?.asset_ids).toEqual([
      ASSET_ID,
    ]);
    expect(eventsBody.next_cursor).toBeNull();

    const cursorReplay = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events?cursor=1`,
    );
    expect(cursorReplay.status).toBe(200);
    const cursorText = await cursorReplay.text();
    responseTexts.push(cursorText);
    expect(
      (JSON.parse(cursorText) as { items: Array<{ sequence: number }> }).items.map(
        (event) => event.sequence,
      ),
    ).toEqual([2, 3, 4, 5, 6]);

    const a2aEvents = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
      { headers: { Accept: 'application/a2a+json' } },
    );
    expect(a2aEvents.status).toBe(200);
    const a2aEventsText = await a2aEvents.text();
    responseTexts.push(a2aEventsText);
    const a2aEventsBody = JSON.parse(a2aEventsText) as {
      id: string;
      contextId: string;
      status: { state: string };
      metadata: { events: Array<{ sequence: number }> };
    };
    expect(a2aEventsBody).toMatchObject({
      id: TASK_ID,
      contextId: PROJECT_ID,
      status: { state: 'completed' },
    });
    expect(a2aEventsBody.metadata.events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);

    expect(studioEvents.at(-1)?.type).toBe('billing-settled');
    expect(providerSubmissions).toBe(1);
    const publicWire = responseTexts.join('\n');
    for (const sensitive of [
      PRIVATE_PROMPT,
      PRIVATE_PROVIDER_RESPONSE,
      PRIVATE_SIGNED_URL,
      'PRIVATE_SIGNATURE',
      'PRIVATE_RESERVATION_ID',
    ]) {
      expect(publicWire).not.toContain(sensitive);
    }
  });
});

async function postJson(app: Hono, path: string, body: unknown, contentType = 'application/json') {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

function studioEvent(
  jobId: string,
  cursor: string,
  type: StudioJobEvent['type'],
  payload: Record<string, unknown>,
): StudioJobEvent {
  return {
    event_id: `37000000-0000-4000-a000-${cursor.padStart(12, '0')}`,
    job_id: jobId,
    cursor,
    type,
    payload,
    created_at: new Date(Date.parse(NOW) + Number(cursor) * 1_000).toISOString(),
  };
}
