import { describe, expect, test } from 'bun:test';
import type {
  IntelligenceCreateTaskRequest,
  IntelligenceExecutionTarget,
  IntelligenceWorkflowStartRequest,
} from '@kortix/api-contract';
import {
  type CapabilityDescriptor,
  type WorkflowEvent,
  WorkflowEventSchema,
  type WorkflowRun,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { buildProjectAgentCard } from '../intelligence/agent-cards';
import type { ProjectCapabilityCatalogPort } from '../intelligence/capability-catalog';
import {
  type StudioTaskExecutor,
  createIntelligenceProjectRoutes,
} from '../intelligence/project-routes';
import { createIntelligenceWorkflowProjectRoutes } from '../intelligence/workflows/project-routes';
import type { WorkflowService } from '../intelligence/workflows/service';

const ACCOUNT_ID = '81000000-0000-4000-a000-000000000001';
const PROJECT_ID = '82000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '82000000-0000-4000-a000-000000000002';
const USER_ID = '83000000-0000-4000-a000-000000000001';
const RUN_ID = '84000000-0000-4000-a000-000000000001';
const TASK_ID = '85000000-0000-4000-a000-000000000001';
const JOB_ID = '86000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '87000000-0000-4000-a000-000000000001';
const ASSET_ID = '88000000-0000-4000-a000-000000000001';
const PRIVATE_PROMPT = 'PRIVATE_AG_UI_ACCEPTANCE_PROMPT';
const PRIVATE_PROVIDER_URL = 'https://private.example.test/never-expose';

const capability: CapabilityDescriptor = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image',
  operation: 'generate',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  execution: 'async',
  risk: 'write',
  provenance_required: true,
};

const agentCard = buildProjectAgentCard({
  projectId: PROJECT_ID,
  agentId: 'acceptance-agent',
  displayName: 'Acceptance Agent',
  capabilities: [capability],
  trustTier: 'project',
});

const executionTarget: IntelligenceExecutionTarget = {
  capability_id: 'studio.image.generate',
  provider_config_id: PROVIDER_CONFIG_ID,
  model: 'fake/image-v1',
};

function taskRequest(): IntelligenceCreateTaskRequest {
  return {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: agentCard.card_hash,
    provider_config_id: PROVIDER_CONFIG_ID,
    model: 'fake/image-v1',
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
    idempotency_key: 'ag-ui-acceptance-task-0001',
    parent_task_id: null,
    deadline_at: null,
  };
}

function workflowRequest(): IntelligenceWorkflowStartRequest {
  return {
    protocol_version: 'intelligence.workflow.v1',
    idempotency_key: 'ag-ui-acceptance-workflow-0001',
    goal: PRIVATE_PROMPT,
    context_asset_ids: [],
    policy_snapshot_hash: null,
    evaluation_version: 'acceptance-v1',
    max_nodes: 4,
    max_dependencies: 4,
    max_approved_credits: 10,
    deadline_at: null,
  };
}

function workflowEvent(overrides: Partial<WorkflowEvent>): WorkflowEvent {
  return WorkflowEventSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    event_id: '89000000-0000-4000-a000-000000000001',
    run_id: RUN_ID,
    sequence: 1,
    type: 'run_started',
    status: 'running',
    graph_version: 0,
    node_id: null,
    task_id: null,
    progress: null,
    reason_code: null,
    asset_ids: [],
    route_reason_codes: [],
    evaluation_version: 'acceptance-v1',
    created_at: '2026-07-21T12:00:00.000Z',
    ...overrides,
  });
}

function createApp(agUiEnabled: boolean) {
  const catalogItem = {
    ref: { kind: 'capability' as const, id: capability.id, version: capability.version },
    title: 'Governed image generation',
    summary: 'Generate one image through the project executor.',
    risk: 'write' as const,
    availability: 'available' as const,
    capability_id: capability.id,
    executable: true,
    source: 'studio' as const,
  };
  const catalog: ProjectCapabilityCatalogPort = {
    async search(input) {
      return input.projectId === PROJECT_ID
        ? { items: [catalogItem], next_cursor: null }
        : { items: [], next_cursor: null };
    },
    async describe(input) {
      return input.projectId === PROJECT_ID && input.ref.id === capability.id
        ? capability.input_schema
        : null;
    },
  };
  const taskExecutor: StudioTaskExecutor = {
    async create() {
      return { taskId: TASK_ID, jobId: JOB_ID, created: true };
    },
  };
  let run: WorkflowRun | null = null;
  const durableEvents: WorkflowEvent[] = [
    workflowEvent({}),
    workflowEvent({
      event_id: '89000000-0000-4000-a000-000000000002',
      sequence: 2,
      type: 'run_succeeded',
      status: 'succeeded',
      asset_ids: [ASSET_ID],
    }),
  ];
  const workflowService = {
    async startRunFromRequest(input: { run: WorkflowRun }) {
      run = input.run;
      return { run, created: true };
    },
    async getRun(input: { accountId: string; projectId: string; runId: string }) {
      return input.accountId === ACCOUNT_ID &&
        input.projectId === PROJECT_ID &&
        input.runId === RUN_ID
        ? run
        : null;
    },
    async readEvents(input: { accountId: string; projectId: string; runId: string; afterSequence: number }) {
      return {
        items:
          input.accountId === ACCOUNT_ID &&
          input.projectId === PROJECT_ID &&
          input.runId === RUN_ID
            ? durableEvents.filter((event) => event.sequence > input.afterSequence)
            : [],
        nextCursor: null,
      };
    },
  } as unknown as WorkflowService;
  const loadProjectForUser = async (_context: unknown, projectId: string) =>
    projectId === PROJECT_ID
      ? { row: { accountId: ACCOUNT_ID, projectId }, userId: USER_ID }
      : null;
  const assertProjectCapability = async () => {};
  const projectRoutes = createIntelligenceProjectRoutes({
    capabilityRegistry: {
      async list() {
        return [capability];
      },
      async discover() {
        return { capabilities: [capability], executionTargets: [executionTarget] };
      },
    },
    capabilityCatalog: catalog,
    getAgentCard: async () => agentCard,
    loadProjectForUser,
    assertProjectCapability,
    taskExecutor,
    agentTrustSource: { isTrusted: async () => false },
  });
  const workflowRoutes = createIntelligenceWorkflowProjectRoutes({
    service: workflowService,
    randomUUID: () => RUN_ID,
    loadProjectForUser,
    assertProjectCapability,
    isAgentCardTrusted: async () => true,
    agUi: { enabled: agUiEnabled },
  });
  const app = new Hono();
  app.use('*', async (context, next) => {
    const writable = context as unknown as { set(key: string, value: unknown): void };
    writable.set('authType', 'pat');
    writable.set('iamTokenId', 'ag-ui-acceptance-token');
    writable.set('sessionId', 'ag-ui-acceptance-session');
    writable.set('agentGrant', { agent: 'acceptance-agent' });
    await next();
  });
  app.route('/v1/projects', projectRoutes);
  app.route('/v1/projects', workflowRoutes);
  app.onError((error, context) => {
    if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
    return context.json({ error: 'Internal error' }, 500);
  });
  return app;
}

describe('OpenOPC AG-UI protocol acceptance', () => {
  test('keeps catalog, task, workflow, REST fallback, and AG-UI replay project-scoped', async () => {
    const app = createApp(true);

    const catalog = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/catalog?query=image&limit=20`,
    );
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({
      items: [{ ref: { kind: 'capability', id: capability.id, version: capability.version } }],
      next_cursor: null,
    });
    const description = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/catalog/describe?kind=capability&id=${encodeURIComponent(capability.id)}&version=${capability.version}`,
    );
    expect(description.status).toBe(200);
    expect(await description.json()).toMatchObject({ input_schema: capability.input_schema });

    const task = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(taskRequest()),
    });
    expect(task.status).toBe(201);
    expect(await task.json()).toMatchObject({ task_id: TASK_ID, job_id: JOB_ID, created: true });

    const workflow = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflowRequest()),
    });
    expect(workflow.status).toBe(201);
    expect(await workflow.json()).toMatchObject({ run: { run_id: RUN_ID }, created: true });

    const fallback = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/events?cursor=0&limit=100`,
    );
    expect(fallback.status).toBe(200);
    expect((await fallback.json()).items.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);

    const stream = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream?cursor=0`,
      { headers: { Accept: 'text/event-stream' } },
    );
    expect(stream.status).toBe(200);
    const wire = await stream.text();
    expect(wire.match(/^id: \d+$/gm)).toEqual(['id: 1', 'id: 2']);
    expect(wire).toContain('event: RUN_STARTED');
    expect(wire).toContain('event: RUN_FINISHED');
    expect(wire).toContain(ASSET_ID);
    expect(wire).not.toMatch(new RegExp(`${PRIVATE_PROMPT}|${PRIVATE_PROVIDER_URL}`, 'i'));
    expect(wire).not.toMatch(/payload_ref|provider_url|signed_url|credential/i);

    const foreign = await Promise.all([
      app.request(`/v1/projects/${OTHER_PROJECT_ID}/intelligence/catalog?query=image`),
      app.request(
        `/v1/projects/${OTHER_PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream?cursor=0`,
      ),
    ]);
    expect(foreign.map((response) => response.status)).toEqual([404, 404]);

    const disabled = await createApp(false).request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream?cursor=0`,
    );
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toMatchObject({ code: 'INTELLIGENCE_AG_UI_DISABLED' });
  });
});
