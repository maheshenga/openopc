import { describe, expect, test } from 'bun:test';
import {
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
} from '@kortix/api-contract';
import type { CapabilityDescriptor, TaskEvent } from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PROJECT_ACTIONS } from '../iam/actions';
import { buildProjectAgentCard } from './agent-cards';
import {
  type IntelligenceTaskEventReader,
  type StudioTaskExecutor,
  createIntelligenceProjectRoutes,
} from './project-routes';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '12000000-0000-4000-a000-000000000002';
const USER_ID = '13000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const TASK_ID = '15000000-0000-4000-a000-000000000001';
const JOB_ID = '16000000-0000-4000-a000-000000000001';
const EVENT_ID = '17000000-0000-4000-a000-000000000001';
const IAM_TOKEN_ID = '18000000-0000-4000-a000-000000000001';

const imageCapability: CapabilityDescriptor = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image',
  operation: 'generate',
  input_schema: { type: 'object', name: 'StudioImageGenerateInput' },
  output_schema: { type: 'array', asset_kinds: ['image'] },
  execution: 'async',
  risk: 'write',
  provenance_required: true,
};

const localCard = buildProjectAgentCard({
  projectId: PROJECT_ID,
  agentId: 'content-planner',
  displayName: 'Content Planner',
  capabilities: [imageCapability],
  trustTier: 'project',
});

const taskRequest = (
  overrides: Partial<IntelligenceCreateTaskRequest> = {},
): IntelligenceCreateTaskRequest => ({
  protocol_version: 'intelligence.v1',
  capability_id: 'studio.image.generate',
  agent_card_hash: localCard.card_hash,
  provider_config_id: PROVIDER_CONFIG_ID,
  model: 'fake/image-v1',
  input: {
    capability: 'image.generate',
    image: {
      prompt: 'A private prompt that must not be echoed',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    },
  },
  idempotency_key: 'intelligence-task-idempotency-key',
  parent_task_id: null,
  deadline_at: null,
  ...overrides,
});

type TestOptions = {
  capabilities?: CapabilityDescriptor[];
  denyAction?: boolean;
  executor?: StudioTaskExecutor | null;
  eventReader?: IntelligenceTaskEventReader | null;
  trustExternal?: boolean;
  projectMissing?: boolean;
  authType?: string;
};

function createApp(options: TestOptions = {}) {
  const actions: string[] = [];
  const createCalls: Parameters<StudioTaskExecutor['create']>[0][] = [];
  const rows = new Map<string, { taskId: string; jobId: string }>();
  const defaultExecutor: StudioTaskExecutor = {
    async create(input) {
      createCalls.push(input);
      const existing = rows.get(input.request.idempotency_key);
      if (existing) return { ...existing, created: false };
      const created = { taskId: TASK_ID, jobId: JOB_ID };
      rows.set(input.request.idempotency_key, created);
      return { ...created, created: true };
    },
  };
  const event: TaskEvent = {
    protocol_version: 'intelligence.v1',
    event_id: EVENT_ID,
    task_id: TASK_ID,
    sequence: 1,
    type: 'created',
    status: 'queued',
    created_at: '2026-07-18T12:00:00.000Z',
  };
  const defaultEventReader: IntelligenceTaskEventReader = {
    async read(input) {
      return input.projectId === PROJECT_ID && input.taskId === TASK_ID
        ? { items: [event], nextCursor: null }
        : null;
    },
  };
  const routes = createIntelligenceProjectRoutes({
    loadProjectForUser: async (_context, projectId) =>
      options.projectMissing || (projectId !== PROJECT_ID && projectId !== OTHER_PROJECT_ID)
        ? null
        : { row: { accountId: ACCOUNT_ID, projectId }, userId: USER_ID },
    assertProjectCapability: async (_context, _userId, _accountId, _projectId, action) => {
      actions.push(action);
      if (options.denyAction) throw new HTTPException(403, { message: 'Forbidden' });
    },
    capabilityRegistry: {
      list: async () => options.capabilities ?? [imageCapability],
    },
    getAgentCard: async () => localCard,
    taskExecutor: options.executor === null ? undefined : (options.executor ?? defaultExecutor),
    taskEventReader:
      options.eventReader === null ? undefined : (options.eventReader ?? defaultEventReader),
    agentTrustSource: {
      isTrusted: async () => options.trustExternal ?? false,
    },
  });
  const app = new Hono();
  app.use('*', async (context, next) => {
    const writable = context as unknown as { set(key: string, value: unknown): void };
    writable.set('authType', options.authType ?? 'pat');
    writable.set('iamTokenId', IAM_TOKEN_ID);
    writable.set('sessionId', 'session-1');
    writable.set('agentGrant', { agent: 'content-planner' });
    await next();
  });
  app.route('/v1/projects', routes);
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message, status: error.status }, error.status);
    }
    return context.json({ error: 'Internal error' }, 500);
  });
  return { app, actions, createCalls };
}

async function createTask(app: Hono, request: unknown = taskRequest()) {
  return app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

describe('Intelligence project routes', () => {
  test('keeps the request contract strict and rejects unsupported protocol revisions', async () => {
    expect(IntelligenceCreateTaskRequestSchema.safeParse(taskRequest()).success).toBe(true);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({ ...taskRequest(), secret: 'value' }).success,
    ).toBe(false);

    const { app, createCalls } = createApp();
    const response = await createTask(app, {
      ...taskRequest(),
      protocol_version: 'intelligence.v9',
    });

    expect(response.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  test('enforces project loading and the existing Studio capability action', async () => {
    const missing = createApp({ projectMissing: true });
    expect(
      (await missing.app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`)).status,
    ).toBe(404);

    const denied = createApp({ denyAction: true });
    expect(
      (await denied.app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`)).status,
    ).toBe(403);
    expect(denied.actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE]);
  });

  test('uses the jobs-run action only when creating a task', async () => {
    const { app, actions } = createApp();
    await createTask(app);
    expect(actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN]);
  });

  test('returns protocol-versioned empty discovery when Studio has no executable capability', async () => {
    const { app } = createApp({ capabilities: [] });
    const response = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/capabilities`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
    });
  });

  test('uses the provider-use action when returning the project Agent Card', async () => {
    const { app, actions } = createApp();
    const response = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/agent-card`);
    expect(response.status).toBe(200);
    expect(actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE]);
  });

  test('allows the local project card, derives agent attribution, and replays idempotently', async () => {
    const { app, createCalls } = createApp();
    const first = await createTask(app);
    const replay = await createTask(app);

    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      job_id: JOB_ID,
      created: true,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      job_id: JOB_ID,
      created: false,
    });
    expect(createCalls[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      actorType: 'agent',
      actingTokenId: IAM_TOKEN_ID,
      agentName: 'content-planner',
      sessionId: 'session-1',
    });
    expect(JSON.stringify(await createTask(app).then((response) => response.json()))).not.toContain(
      'private prompt',
    );
  });

  test('denies an external card without trust and fails closed when no executor is installed', async () => {
    const untrusted = createApp();
    const denied = await createTask(
      untrusted.app,
      taskRequest({ agent_card_hash: 'b'.repeat(64) }),
    );
    expect(denied.status).toBe(403);
    expect(untrusted.createCalls).toHaveLength(0);

    const unavailable = createApp({ executor: null });
    const response = await createTask(unavailable.app);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
    });
  });

  test('returns a redacted typed error when the task executor fails', async () => {
    const executor: StudioTaskExecutor = {
      async create() {
        throw new Error('provider=https://secret.example.test/v1 raw body omitted');
      },
    };
    const { app } = createApp({ executor });
    const response = await createTask(app);
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('https://secret.example.test');
    expect(JSON.parse(body)).toMatchObject({ code: 'INTELLIGENCE_TASK_EXECUTION_FAILED' });
  });

  test('returns executor-unavailable before capability discovery when no executor is installed', async () => {
    const { app } = createApp({ executor: null, capabilities: [] });
    const response = await createTask(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
    });
  });

  test('preserves the loaded project user for service-account attribution', async () => {
    const { app, createCalls } = createApp({ authType: 'service_account' });
    await createTask(app);
    expect(createCalls[0]).toMatchObject({
      actorUserId: USER_ID,
      actorType: 'system',
      actingTokenId: null,
    });
  });

  test('uses the typed executor-unavailable response when event reading is not installed', async () => {
    const { app } = createApp({ eventReader: null });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
    });
  });

  test('returns a redacted typed error when event reading fails', async () => {
    const eventReader: IntelligenceTaskEventReader = {
      async read() {
        throw new Error('signed=https://secret.example.test/object');
      },
    };
    const { app } = createApp({ eventReader });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
    );
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain('https://secret.example.test');
    expect(JSON.parse(body)).toMatchObject({ code: 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE' });
  });

  test('rejects malformed event route parameters before the reader is called', async () => {
    let reads = 0;
    const eventReader: IntelligenceTaskEventReader = {
      async read() {
        reads += 1;
        return { items: [], nextCursor: null };
      },
    };
    const { app } = createApp({ eventReader });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/not-a-uuid/events?cursor=%20`,
    );
    expect(response.status).toBe(400);
    expect(reads).toBe(0);
  });

  test('returns public events and keeps cross-project task reads opaque', async () => {
    const { app, actions } = createApp();
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      items: [
        {
          protocol_version: 'intelligence.v1',
          event_id: EVENT_ID,
          task_id: TASK_ID,
          sequence: 1,
          type: 'created',
          status: 'queued',
          created_at: '2026-07-18T12:00:00.000Z',
        },
      ],
      next_cursor: null,
    });
    expect(actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ]);

    const crossProject = await app.request(
      `/v1/projects/${OTHER_PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
    );
    expect(crossProject.status).toBe(404);
  });
});
