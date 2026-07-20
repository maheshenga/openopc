import { describe, expect, test } from 'bun:test';
import {
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  type IntelligenceExecutionTarget,
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
import { IntelligenceTaskServiceError } from './task-service';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '12000000-0000-4000-a000-000000000002';
const USER_ID = '13000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const TASK_ID = '15000000-0000-4000-a000-000000000001';
const OTHER_TASK_ID = '15000000-0000-4000-a000-000000000002';
const JOB_ID = '16000000-0000-4000-a000-000000000001';
const OTHER_JOB_ID = '16000000-0000-4000-a000-000000000002';
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

const a2aTaskEnvelope = (request: IntelligenceCreateTaskRequest = taskRequest()) => ({
  jsonrpc: '2.0',
  id: 'message-1',
  method: 'message/send',
  params: { sender_card_hash: request.agent_card_hash, task: request },
});

type TestOptions = {
  capabilities?: CapabilityDescriptor[];
  executionTargets?: IntelligenceExecutionTarget[];
  listOnlyRegistry?: boolean;
  denyAction?: boolean;
  executor?: StudioTaskExecutor | null;
  eventReader?: IntelligenceTaskEventReader | null;
  trustExternal?: boolean;
  omitTrustSource?: boolean;
  agentGrant?: string | null;
  projectMissing?: boolean;
  authType?: string;
};

function createApp(options: TestOptions = {}) {
  const actions: string[] = [];
  const trustCalls: Array<{ projectId: string; accountId: string; cardHash: string }> = [];
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
    job_id: JOB_ID,
    sequence: 1,
    type: 'created',
    status: 'queued',
    created_at: '2026-07-18T12:00:00.000Z',
  };
  const defaultEventReader: IntelligenceTaskEventReader = {
    async findByJob(input) {
      return input.projectId === PROJECT_ID && input.jobId === JOB_ID
        ? { taskId: TASK_ID, jobId: JOB_ID }
        : null;
    },
    async read(input) {
      return input.projectId === PROJECT_ID && input.taskId === TASK_ID
        ? { items: [event], nextCursor: null }
        : null;
    },
  };
  const capabilityRegistry = options.listOnlyRegistry
    ? { list: async () => options.capabilities ?? [imageCapability] }
    : {
        list: async () => options.capabilities ?? [imageCapability],
        discover: async () => ({
          capabilities: options.capabilities ?? [imageCapability],
          executionTargets: options.executionTargets ?? [
            {
              capability_id: 'studio.image.generate' as const,
              provider_config_id: PROVIDER_CONFIG_ID,
              model: 'fake/image-v1',
            },
          ],
        }),
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
    capabilityRegistry,
    getAgentCard: async () => localCard,
    taskExecutor: options.executor === null ? undefined : (options.executor ?? defaultExecutor),
    taskEventReader:
      options.eventReader === null ? undefined : (options.eventReader ?? defaultEventReader),
    ...(options.omitTrustSource
      ? {}
      : {
          agentTrustSource: {
            isTrusted: async (input) => {
              trustCalls.push(input);
              return options.trustExternal ?? false;
            },
          },
        }),
  });
  const app = new Hono();
  app.use('*', async (context, next) => {
    const writable = context as unknown as { set(key: string, value: unknown): void };
    writable.set('authType', options.authType ?? 'pat');
    writable.set('iamTokenId', IAM_TOKEN_ID);
    writable.set('sessionId', 'session-1');
    writable.set(
      'agentGrant',
      options.agentGrant === null ? null : { agent: options.agentGrant ?? 'content-planner' },
    );
    await next();
  });
  app.route('/v1/projects', routes);
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message, status: error.status }, error.status);
    }
    return context.json({ error: 'Internal error' }, 500);
  });
  return { app, actions, createCalls, trustCalls };
}

async function createTask(app: Hono, request: unknown = taskRequest()) {
  return app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
}

async function createA2ATask(app: Hono, request: IntelligenceCreateTaskRequest = taskRequest()) {
  return app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/a2a+json' },
    body: JSON.stringify(a2aTaskEnvelope(request)),
  });
}

describe('Intelligence project routes', () => {
  test('keeps the request contract strict and rejects unsupported protocol revisions', async () => {
    expect(IntelligenceCreateTaskRequestSchema.safeParse(taskRequest()).success).toBe(true);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({ ...taskRequest(), secret: 'value' }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...taskRequest(),
        input: { ...taskRequest().input, provider_url: 'https://secret.example.test' },
      }).success,
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

  test('returns only governed execution choices needed to create a task', async () => {
    const { app } = createApp();
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/capabilities?include=execution_targets`,
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      protocol_version: 'intelligence.v1',
      items: [imageCapability],
      execution_targets: [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/base_url|credential_binding|provider_url|secret/i);

    const invalid = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/capabilities?include=credentials`,
    );
    expect(invalid.status).toBe(400);
  });

  test('returns a typed error instead of overflowing the discovery response', async () => {
    const executionTargets = Array.from({ length: 1025 }, (_, index) => ({
      capability_id: 'studio.image.generate' as const,
      provider_config_id: `14000000-0000-4000-a000-${index.toString(16).padStart(12, '0')}`,
      model: `fake/image-${index}`,
    }));
    const { app } = createApp({ executionTargets });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/capabilities?include=execution_targets`,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_DISCOVERY_TOO_LARGE',
    });
  });

  test('uses the provider-use action when returning the project Agent Card', async () => {
    const { app, actions } = createApp();
    const response = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/agent-card`);
    expect(response.status).toBe(200);
    expect(actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE]);
  });

  test('negotiates an A2A Agent Card without changing the default JSON response', async () => {
    const { app } = createApp();
    const defaultResponse = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/agent-card`);
    const a2aResponse = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/agent-card`, {
      headers: { Accept: 'application/a2a+json' },
    });

    expect(defaultResponse.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await defaultResponse.json()).toEqual(localCard);
    expect(a2aResponse.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    const body = await a2aResponse.json();
    expect(body).toMatchObject({
      protocolVersion: '1.0.1',
      skills: [{ id: 'studio.image.generate' }],
      metadata: { card_hash: localCard.card_hash },
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|token|credential|provider_url/i);
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
      estimateMode: 'trusted_internal',
    });
    expect(JSON.stringify(await createTask(app).then((response) => response.json()))).not.toContain(
      'private prompt',
    );
  });

  test('requires signed estimates for users and reserves trusted estimates for server identities', async () => {
    const user = createApp({ agentGrant: null });
    const agent = createApp();
    const system = createApp({ authType: 'service_account', agentGrant: null });

    expect((await createTask(user.app)).status).toBe(201);
    expect((await createTask(agent.app)).status).toBe(201);
    expect((await createTask(system.app)).status).toBe(201);

    expect(user.createCalls[0]?.estimateMode).toBe('external_signed');
    expect(agent.createCalls[0]?.estimateMode).toBe('trusted_internal');
    expect(system.createCalls[0]?.estimateMode).toBe('trusted_internal');
  });

  test('runs an A2A message/send task through the governed project executor', async () => {
    const { app, createCalls } = createApp();
    const response = await createA2ATask(app);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    const body = await response.json();
    expect(body).toMatchObject({
      id: TASK_ID,
      contextId: PROJECT_ID,
      status: { state: 'submitted' },
      metadata: { job_id: JOB_ID },
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      actorType: 'agent',
      actingTokenId: IAM_TOKEN_ID,
      estimateMode: 'trusted_internal',
      request: taskRequest(),
    });
    expect(JSON.stringify(body)).not.toMatch(/private prompt|provider_url|credential|signed_url/i);
  });

  test('requires a local Agent grant or explicit trust for every external A2A card', async () => {
    const withoutGrant = createApp({ agentGrant: null });
    const localDenied = await createA2ATask(withoutGrant.app);
    expect(localDenied.status).toBe(403);
    expect(localDenied.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    expect(await localDenied.json()).toMatchObject({ code: 'A2A_AGENT_UNTRUSTED' });
    expect(withoutGrant.createCalls).toHaveLength(0);

    const externalRequest = taskRequest({ agent_card_hash: 'b'.repeat(64) });
    const withoutTrustSource = createApp({ omitTrustSource: true });
    const externalDenied = await createA2ATask(withoutTrustSource.app, externalRequest);
    expect(externalDenied.status).toBe(403);
    expect(withoutTrustSource.createCalls).toHaveLength(0);

    const trusted = createApp({ trustExternal: true });
    expect((await createA2ATask(trusted.app, externalRequest)).status).toBe(200);
    expect(trusted.trustCalls).toEqual([
      { projectId: PROJECT_ID, accountId: ACCOUNT_ID, cardHash: 'b'.repeat(64) },
    ]);
  });

  test('accepts the local service card from any authorized project Agent grant', async () => {
    const { app } = createApp({ agentGrant: 'research-agent' });
    const response = await createA2ATask(app);

    expect(response.status).toBe(200);
  });

  test('rejects malformed, unsupported, and expired A2A tasks before execution', async () => {
    const { app, createCalls } = createApp();
    const malformed = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/a2a+json; charset=utf-8' },
      body: JSON.stringify({ ...a2aTaskEnvelope(), credential: 'must-not-be-accepted' }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'A2A_INVALID_REQUEST' });

    const unsupportedRequest = {
      ...taskRequest(),
      capability_id: 'studio.video.generate',
    };
    const unsupported = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/a2a+json' },
      body: JSON.stringify({
        ...a2aTaskEnvelope(),
        params: {
          sender_card_hash: unsupportedRequest.agent_card_hash,
          task: unsupportedRequest,
        },
      }),
    });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ code: 'A2A_UNSUPPORTED_CAPABILITY' });

    const expired = await createA2ATask(
      app,
      taskRequest({ deadline_at: '2020-01-01T00:00:00.000Z' }),
    );
    expect(expired.status).toBe(409);
    expect(expired.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    expect(await expired.json()).toMatchObject({ code: 'A2A_DEADLINE_EXPIRED' });
    expect(createCalls).toHaveLength(0);
  });

  test('keeps the A2A media type for governed preflight failures', async () => {
    const cases = [
      {
        app: createApp({ executor: null }).app,
        status: 503,
        code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
      },
      {
        app: createApp({ capabilities: [] }).app,
        status: 409,
        code: 'INTELLIGENCE_CAPABILITY_UNAVAILABLE',
      },
      {
        app: createApp({ executionTargets: [] }).app,
        status: 409,
        code: 'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
      },
    ];

    for (const item of cases) {
      const response = await createA2ATask(item.app);
      expect(response.status).toBe(item.status);
      expect(response.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
      expect(await response.json()).toMatchObject({ code: item.code });
    }
  });

  test('replays a bound task after provider discovery becomes unavailable', async () => {
    const capabilities = [imageCapability];
    const executionTargets: IntelligenceExecutionTarget[] = [
      {
        capability_id: 'studio.image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
      },
    ];
    let existing = false;
    let replayCalls = 0;
    const executor = {
      async replay() {
        replayCalls += 1;
        return existing ? { taskId: TASK_ID, jobId: JOB_ID, created: false } : null;
      },
      async create() {
        existing = true;
        return { taskId: TASK_ID, jobId: JOB_ID, created: true };
      },
    } as StudioTaskExecutor & {
      replay(): Promise<{ taskId: string; jobId: string; created: boolean } | null>;
    };
    const { app } = createApp({ capabilities, executionTargets, executor });

    expect((await createTask(app)).status).toBe(201);
    capabilities.length = 0;
    executionTargets.length = 0;

    const replay = await createTask(app);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      job_id: JOB_ID,
      created: false,
    });
    expect(replayCalls).toBe(2);
  });

  test('rejects a task selection that is not in the governed execution targets', async () => {
    const { app, createCalls } = createApp();
    const response = await createTask(app, taskRequest({ model: 'unlisted/image-model' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
    });
    expect(createCalls).toHaveLength(0);
  });

  test('fails closed for a list-only registry instead of bypassing target binding', async () => {
    const { app, createCalls } = createApp({ listOnlyRegistry: true });
    const response = await createTask(app, taskRequest({ model: 'unlisted/image-model' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
    });
    expect(createCalls).toHaveLength(0);
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

  test('returns stable redacted estimate errors from the task executor', async () => {
    const leakedToken = 'studio-estimate-v2.private-token-claims';
    for (const code of [
      'INTELLIGENCE_ESTIMATE_INVALID',
      'INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED',
    ] as const) {
      const executor: StudioTaskExecutor = {
        async create() {
          const error = new IntelligenceTaskServiceError(code, 409);
          Object.assign(error, { estimate_token: leakedToken });
          throw error;
        },
      };
      const { app } = createApp({ executor, agentGrant: null });
      const response = await createTask(app);
      const body = await response.text();

      expect(response.status, code).toBe(409);
      expect(JSON.parse(body), code).toMatchObject({ code });
      expect(body, code).not.toContain(leakedToken);
    }
  });

  test('returns a redacted A2A error when the governed executor fails', async () => {
    const executor: StudioTaskExecutor = {
      async create() {
        throw new Error('provider=https://secret.example.test/v1 raw response=credential');
      },
    };
    const { app } = createApp({ executor });
    const response = await createA2ATask(app);

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    const body = await response.text();
    expect(body).not.toMatch(/secret\.example|raw response|credential/i);
    expect(JSON.parse(body)).toMatchObject({ code: 'INTELLIGENCE_TASK_EXECUTION_FAILED' });
  });

  test('returns the stable conflict response for an idempotency mismatch', async () => {
    const executor: StudioTaskExecutor = {
      async create() {
        throw Object.assign(new Error('private request body must not be returned'), {
          code: 'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
          status: 409,
        });
      },
    };
    const { app } = createApp({ executor });
    const response = await createTask(app);
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).not.toContain('private request body');
    expect(JSON.parse(body)).toEqual({
      error: 'Intelligence task idempotency conflict',
      code: 'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
    });
  });

  test('maps a malformed task executor result to a typed unavailable response', async () => {
    const executor: StudioTaskExecutor = {
      async create() {
        return {
          taskId: 'not-a-uuid',
          jobId: JOB_ID,
          created: true,
        };
      },
    };
    const { app } = createApp({ executor });
    const response = await createTask(app);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTION_FAILED',
    });
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

  test('resolves a project Intelligence task by its bound Studio job', async () => {
    const { app, actions } = createApp();
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/by-job/${JOB_ID}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      job_id: JOB_ID,
    });
    expect(actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ]);
  });

  test('keeps cross-project, missing, and legacy Studio jobs opaque', async () => {
    const { app } = createApp();
    const responses = await Promise.all([
      app.request(`/v1/projects/${OTHER_PROJECT_ID}/intelligence/tasks/by-job/${JOB_ID}`),
      app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks/by-job/${OTHER_JOB_ID}`),
      createApp({
        eventReader: {
          async findByJob() {
            return null;
          },
          async read() {
            return null;
          },
        },
      }).app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks/by-job/${JOB_ID}`),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404, 404]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { error: 'Not found' },
      { error: 'Not found' },
      { error: 'Not found' },
    ]);
  });

  test('rejects a malformed source job before task lookup', async () => {
    let lookups = 0;
    const { app } = createApp({
      eventReader: {
        async findByJob() {
          lookups += 1;
          return null;
        },
        async read() {
          return null;
        },
      },
    });

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/by-job/not-a-uuid`,
    );
    expect(response.status).toBe(400);
    expect(lookups).toBe(0);
  });

  test('returns lookup unavailable when the task binding reader is not installed', async () => {
    const { app } = createApp({ eventReader: null });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/by-job/${JOB_ID}`,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_LOOKUP_UNAVAILABLE',
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

  test('rejects events that belong to a different task', async () => {
    const eventReader: IntelligenceTaskEventReader = {
      async read() {
        return {
          items: [
            {
              protocol_version: 'intelligence.v1',
              event_id: EVENT_ID,
              task_id: OTHER_TASK_ID,
              sequence: 1,
              type: 'created',
              status: 'queued',
              created_at: '2026-07-18T12:00:00.000Z',
            },
          ],
          nextCursor: null,
        };
      },
    };
    const { app } = createApp({ eventReader });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE',
    });
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

  test('rejects non-numeric and unsafe event cursors before the reader is called', async () => {
    let reads = 0;
    const eventReader: IntelligenceTaskEventReader = {
      async read() {
        reads += 1;
        return { items: [], nextCursor: null };
      },
    };
    const { app } = createApp({ eventReader });
    for (const cursor of ['NaN', '1.5', '9007199254740992']) {
      const response = await app.request(
        `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events?cursor=${cursor}`,
      );
      expect(response.status).toBe(400);
    }
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
          job_id: JOB_ID,
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

  test('negotiates public task events as an A2A task state', async () => {
    const { app, actions } = createApp();
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
      { headers: { Accept: 'application/json;q=0.5, application/a2a+json; q=1' } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/a2a\+json/);
    expect(await response.json()).toEqual({
      id: TASK_ID,
      contextId: PROJECT_ID,
      status: { state: 'submitted', timestamp: '2026-07-18T12:00:00.000Z' },
      metadata: {
        events: [
          {
            protocol_version: 'intelligence.v1',
            event_id: EVENT_ID,
            task_id: TASK_ID,
            job_id: JOB_ID,
            sequence: 1,
            type: 'created',
            status: 'queued',
            created_at: '2026-07-18T12:00:00.000Z',
          },
        ],
      },
    });
    expect(actions).toEqual([PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ]);
  });
});
