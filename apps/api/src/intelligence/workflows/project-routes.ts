import {
  type IntelligenceWorkflowAddDependencyRequest,
  IntelligenceWorkflowAddDependencyRequestSchema,
  type IntelligenceWorkflowAppendNodeRequest,
  IntelligenceWorkflowAppendNodeRequestSchema,
  IntelligenceWorkflowCancelRequestSchema,
  IntelligenceWorkflowDependencyResponseSchema,
  IntelligenceWorkflowEventsResponseSchema,
  IntelligenceWorkflowNodeResponseSchema,
  IntelligenceWorkflowRunResponseSchema,
  IntelligenceWorkflowSealRequestSchema,
  IntelligenceWorkflowStartRequestSchema,
  IntelligenceWorkflowStartResponseSchema,
} from '@kortix/api-contract';
import type { WorkflowDependency, WorkflowNode, WorkflowRun } from '@kortix/intelligence-contracts';
import { canonicalWorkflowHash } from '@kortix/intelligence-orchestration';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { PROJECT_ACTIONS } from '../../iam/actions';
import type { AppEnv } from '../../types';
import { WorkflowStoreError } from './errors';
import { type WorkflowService, WorkflowServiceError } from './service';

const MAX_REQUEST_BYTES = 1024 * 1024 + 64 * 1024;
const RunIdSchema = z.string().uuid();
const EventQuerySchema = z
  .object({
    cursor: z
      .string()
      .regex(/^\d{1,16}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

class WorkflowRequestTooLargeError extends Error {}

type LoadProjectForUser = (
  c: Context<AppEnv>,
  projectId: string,
  action: 'read' | 'write' | 'session' | 'manage',
) => Promise<{ row: { accountId: string; projectId: string }; userId: string } | null>;

type AssertProjectCapability = (
  c: Context<AppEnv>,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
) => Promise<void>;

export type IntelligenceWorkflowProjectRouteDeps = {
  service: WorkflowService;
  loadProjectForUser: LoadProjectForUser;
  assertProjectCapability: AssertProjectCapability;
  isAgentCardTrusted(input: {
    accountId: string;
    projectId: string;
    agentName: string;
    actingTokenId: string;
    cardHash: string;
  }): Promise<boolean>;
  now?: () => string;
  randomUUID?: () => string;
};

type LoadedProject = { row: { accountId: string; projectId: string }; userId: string };

export function createIntelligenceWorkflowProjectRoutes(
  deps: IntelligenceWorkflowProjectRouteDeps,
) {
  const app = new Hono<AppEnv>();
  const now = deps.now ?? (() => new Date().toISOString());
  const randomUUID = deps.randomUUID ?? crypto.randomUUID.bind(crypto);

  app.post('/:projectId/intelligence/workflows', async (c) => {
    const loaded = await loadProjectOr404(c, deps, c.req.param('projectId'));
    if (loaded instanceof Response) return loaded;
    await assertCapability(c, deps, loaded, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN);
    const request = await parseBody(c, IntelligenceWorkflowStartRequestSchema);
    if (request instanceof Response) return request;
    const timestamp = now();
    const actor = actorContext(c, loaded);
    const run: WorkflowRun = {
      protocol_version: 'intelligence.workflow.v1',
      run_id: randomUUID(),
      account_id: loaded.row.accountId,
      project_id: loaded.row.projectId,
      actor_type: actor.actorType,
      actor_id: actor.actorId,
      agent_name: actor.agentName,
      idempotency_key: request.idempotency_key,
      request_hash: canonicalWorkflowHash(request),
      status: 'draft',
      graph_version: 0,
      policy_snapshot_hash: request.policy_snapshot_hash,
      evaluation_version: request.evaluation_version,
      max_nodes: request.max_nodes,
      max_dependencies: request.max_dependencies,
      max_approved_credits: request.max_approved_credits,
      deadline_at: request.deadline_at,
      created_at: timestamp,
      updated_at: timestamp,
      terminal_at: null,
    };
    try {
      const result = await deps.service.startRunFromRequest({ run, request });
      return c.json(
        IntelligenceWorkflowStartResponseSchema.parse({
          protocol_version: 'intelligence.workflow.v1',
          ...result,
        }),
        result.created ? 201 : 200,
      );
    } catch (error) {
      return workflowError(c, error);
    }
  });

  app.get('/:projectId/intelligence/workflows/:runId', async (c) => {
    const scope = await loadRunScope(c, deps, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ);
    if (scope instanceof Response) return scope;
    const run = await deps.service.getRun(scope);
    if (!run) return notFound(c);
    return c.json(
      IntelligenceWorkflowRunResponseSchema.parse({
        protocol_version: 'intelligence.workflow.v1',
        run,
      }),
    );
  });

  app.post('/:projectId/intelligence/workflows/:runId/cancel', async (c) => {
    const scope = await loadRunScope(c, deps, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_CANCEL);
    if (scope instanceof Response) return scope;
    const request = await parseBody(c, IntelligenceWorkflowCancelRequestSchema);
    if (request instanceof Response) return request;
    try {
      const run = await deps.service.cancelRun({
        ...scope,
        reasonCode: request.reason_code,
        cancelledAt: now(),
      });
      if (!run) return notFound(c);
      return c.json(
        IntelligenceWorkflowRunResponseSchema.parse({
          protocol_version: 'intelligence.workflow.v1',
          run,
        }),
      );
    } catch (error) {
      return workflowError(c, error);
    }
  });

  app.get('/:projectId/intelligence/workflows/:runId/events', async (c) => {
    const scope = await loadRunScope(c, deps, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ);
    if (scope instanceof Response) return scope;
    const query = parseEventQuery(c);
    if (!query.success) return invalid(c);
    if (!(await deps.service.getRun(scope))) return notFound(c);
    try {
      const result = await deps.service.readEvents({
        ...scope,
        afterSequence: Number(query.data.cursor ?? '0'),
        limit: query.data.limit ?? 100,
      });
      return c.json(
        IntelligenceWorkflowEventsResponseSchema.parse({
          protocol_version: 'intelligence.workflow.v1',
          run_id: scope.runId,
          items: result.items,
          next_cursor: result.nextCursor,
        }),
      );
    } catch (error) {
      return workflowError(c, error);
    }
  });

  app.post('/:projectId/intelligence/workflows/:runId/nodes', async (c) => {
    const scope = await loadRunScope(c, deps, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN);
    if (scope instanceof Response) return scope;
    const request = await parseBody(c, IntelligenceWorkflowAppendNodeRequestSchema);
    if (request instanceof Response) return request;
    const authorized = await authorizeGraphCommand(c, deps, scope, request.sender_card_hash);
    if (authorized instanceof Response) return authorized;
    if (!(await deps.service.getRun(scope))) return notFound(c);
    const timestamp = now();
    const node = workflowNode(scope.runId, request, timestamp);
    try {
      const result = await deps.service.appendNodeWithPayload({
        ...scope,
        expectedGraphVersion: request.expected_graph_version,
        idempotencyKey: request.idempotency_key,
        node,
        payload: request.payload,
      });
      return c.json(
        IntelligenceWorkflowNodeResponseSchema.parse({
          protocol_version: 'intelligence.workflow.v1',
          node: result.node,
          created: result.created,
          graph_version: result.graphVersion,
        }),
        result.created ? 201 : 200,
      );
    } catch (error) {
      return workflowError(c, error);
    }
  });

  app.post('/:projectId/intelligence/workflows/:runId/dependencies', async (c) => {
    const scope = await loadRunScope(c, deps, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN);
    if (scope instanceof Response) return scope;
    const request = await parseBody(c, IntelligenceWorkflowAddDependencyRequestSchema);
    if (request instanceof Response) return request;
    const authorized = await authorizeGraphCommand(c, deps, scope, request.sender_card_hash);
    if (authorized instanceof Response) return authorized;
    if (!(await deps.service.getRun(scope))) return notFound(c);
    const dependency = workflowDependency(scope.runId, request, now());
    try {
      const result = await deps.service.addDependency({
        ...scope,
        expectedGraphVersion: request.expected_graph_version,
        dependency,
      });
      return c.json(
        IntelligenceWorkflowDependencyResponseSchema.parse({
          protocol_version: 'intelligence.workflow.v1',
          dependency: result.dependency,
          created: result.created,
          graph_version: result.graphVersion,
        }),
        result.created ? 201 : 200,
      );
    } catch (error) {
      return workflowError(c, error);
    }
  });

  app.post('/:projectId/intelligence/workflows/:runId/seal', async (c) => {
    const scope = await loadRunScope(c, deps, PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN);
    if (scope instanceof Response) return scope;
    const request = await parseBody(c, IntelligenceWorkflowSealRequestSchema);
    if (request instanceof Response) return request;
    const authorized = await authorizeGraphCommand(c, deps, scope, request.sender_card_hash);
    if (authorized instanceof Response) return authorized;
    if (!(await deps.service.getRun(scope))) return notFound(c);
    try {
      const run = await deps.service.sealGraph({
        ...scope,
        expectedGraphVersion: request.expected_graph_version,
        updatedAt: now(),
      });
      if (!run) return notFound(c);
      return c.json(
        IntelligenceWorkflowRunResponseSchema.parse({
          protocol_version: 'intelligence.workflow.v1',
          run,
        }),
      );
    } catch (error) {
      return workflowError(c, error);
    }
  });

  return app;
}

function workflowNode(
  runId: string,
  request: IntelligenceWorkflowAppendNodeRequest,
  timestamp: string,
): WorkflowNode {
  return {
    protocol_version: 'intelligence.workflow.v1',
    node_id: request.node.node_id,
    run_id: runId,
    node_key: request.node.node_key,
    role: request.node.role,
    kind: request.node.kind,
    agent_name: request.node.agent_name,
    agent_card_hash: request.node.agent_card_hash,
    capability_id: request.node.capability_id,
    capability_version: request.node.capability_version,
    input_hash: canonicalWorkflowHash(request.payload),
    policy_snapshot_hash: request.node.policy_snapshot_hash,
    evaluation_version: request.node.evaluation_version,
    task_id: null,
    status: 'pending',
    attempt_count: 0,
    deadline_at: request.node.deadline_at,
    created_at: timestamp,
    updated_at: timestamp,
    terminal_at: null,
  };
}

function workflowDependency(
  runId: string,
  request: IntelligenceWorkflowAddDependencyRequest,
  timestamp: string,
): WorkflowDependency {
  return {
    protocol_version: 'intelligence.workflow.v1',
    dependency_id: request.dependency_id,
    run_id: runId,
    node_id: request.node_id,
    depends_on_node_id: request.depends_on_node_id,
    condition: request.condition,
    created_at: timestamp,
  };
}

async function loadProjectOr404(
  c: Context<AppEnv>,
  deps: Pick<IntelligenceWorkflowProjectRouteDeps, 'loadProjectForUser'>,
  projectId: string,
): Promise<LoadedProject | Response> {
  const loaded = await deps.loadProjectForUser(c, projectId, 'read');
  return loaded ?? notFound(c);
}

async function loadRunScope(
  c: Context<AppEnv>,
  deps: IntelligenceWorkflowProjectRouteDeps,
  action: string,
) {
  const parsedProjectId = RunIdSchema.safeParse(c.req.param('projectId'));
  const parsedRunId = RunIdSchema.safeParse(c.req.param('runId'));
  if (!parsedProjectId.success || !parsedRunId.success) return notFound(c);
  const loaded = await loadProjectOr404(c, deps, parsedProjectId.data);
  if (loaded instanceof Response) return loaded;
  await assertCapability(c, deps, loaded, action);
  return {
    accountId: loaded.row.accountId,
    projectId: loaded.row.projectId,
    runId: parsedRunId.data,
  };
}

function assertCapability(
  c: Context<AppEnv>,
  deps: IntelligenceWorkflowProjectRouteDeps,
  loaded: LoadedProject,
  action: string,
) {
  return deps.assertProjectCapability(
    c,
    loaded.userId,
    loaded.row.accountId,
    loaded.row.projectId,
    action,
  );
}

async function authorizeGraphCommand(
  c: Context<AppEnv>,
  deps: IntelligenceWorkflowProjectRouteDeps,
  scope: { accountId: string; projectId: string },
  cardHash: string,
): Promise<true | Response> {
  const actor = requestActor(c);
  if (!actor.agentName || !actor.actingTokenId) return untrusted(c);
  try {
    return (await deps.isAgentCardTrusted({
      ...scope,
      agentName: actor.agentName,
      actingTokenId: actor.actingTokenId,
      cardHash,
    }))
      ? true
      : untrusted(c);
  } catch {
    return untrusted(c);
  }
}

function actorContext(c: Context<AppEnv>, loaded: LoadedProject) {
  const actor = requestActor(c);
  if (c.get('authType') === 'service_account') {
    return { actorType: 'system' as const, actorId: loaded.userId, agentName: null };
  }
  return actor.agentName
    ? { actorType: 'agent' as const, actorId: loaded.userId, agentName: actor.agentName }
    : { actorType: 'user' as const, actorId: loaded.userId, agentName: null };
}

function requestActor(c: Context<AppEnv>) {
  if (c.get('authType') !== 'pat') return { agentName: null, actingTokenId: null };
  const grant = c.get('agentGrant') as { agent?: string } | null | undefined;
  return {
    agentName: grant?.agent ?? null,
    actingTokenId: c.get('iamTokenId') ?? null,
  };
}

async function parseBody<T extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: T,
): Promise<z.infer<T> | Response> {
  const length = Number(c.req.header('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) return tooLarge(c);
  let body: unknown;
  try {
    const text = await readBoundedRequestText(c.req.raw.body, MAX_REQUEST_BYTES);
    body = JSON.parse(text);
  } catch (error) {
    return error instanceof WorkflowRequestTooLargeError ? tooLarge(c) : invalid(c);
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : invalid(c);
}

async function readBoundedRequestText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new WorkflowRequestTooLargeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function parseEventQuery(c: Context<AppEnv>) {
  const entries = Object.fromEntries(new URL(c.req.url).searchParams.entries());
  return EventQuerySchema.safeParse(entries);
}

function workflowError(c: Context<AppEnv>, error: unknown) {
  if (error instanceof WorkflowStoreError) return conflict(c);
  if (error instanceof WorkflowServiceError) {
    if (error.code === 'WORKFLOW_PAYLOAD_AUTHORIZATION_REQUIRED') return untrusted(c);
    if (error.code === 'WORKFLOW_PAYLOAD_INVALID') return invalid(c);
    return conflict(c);
  }
  return c.json(
    {
      error: 'Intelligence workflow unavailable',
      code: 'INTELLIGENCE_WORKFLOW_UNAVAILABLE',
    },
    503,
  );
}

function invalid(c: Context<AppEnv>) {
  return c.json(
    {
      error: 'Invalid Intelligence workflow request',
      code: 'INTELLIGENCE_WORKFLOW_VALIDATION_ERROR',
    },
    400,
  );
}

function tooLarge(c: Context<AppEnv>) {
  return c.json(
    {
      error: 'Intelligence workflow request too large',
      code: 'INTELLIGENCE_WORKFLOW_VALIDATION_ERROR',
    },
    413,
  );
}

function conflict(c: Context<AppEnv>) {
  return c.json(
    {
      error: 'Intelligence workflow conflict',
      code: 'INTELLIGENCE_WORKFLOW_CONFLICT',
    },
    409,
  );
}

function untrusted(c: Context<AppEnv>) {
  return c.json(
    {
      error: 'Intelligence workflow Agent is not trusted',
      code: 'INTELLIGENCE_WORKFLOW_UNTRUSTED',
    },
    403,
  );
}

function notFound(c: Context<AppEnv>) {
  return c.json({ error: 'Not found' }, 404);
}
