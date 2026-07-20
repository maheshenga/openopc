import {
  IntelligenceAgentCardResponseSchema,
  IntelligenceCapabilitiesResponseSchema,
  IntelligenceCapabilityDiscoveryResponseSchema,
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  type IntelligenceExecutionTarget,
  IntelligenceTaskEventsResponseSchema,
  IntelligenceTaskResponseSchema,
} from '@kortix/api-contract';
import type { AgentCard, CapabilityDescriptor, TaskEvent } from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { PROJECT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import {
  A2AProtocolError,
  createA2ATaskAdapter,
  parseA2ATaskRequest,
  serializeAgentCard,
} from './a2a';
import { isIntelligenceTaskServiceError } from './task-service';

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

export interface IntelligenceCapabilityRegistry {
  list(
    projectId: string,
    actor: {
      accountId: string;
      userId: string;
      actorType: 'user' | 'agent' | 'system';
      actingTokenId: string | null;
    },
  ): Promise<CapabilityDescriptor[]>;
  discover?(
    projectId: string,
    actor: {
      accountId: string;
      userId: string;
      actorType: 'user' | 'agent' | 'system';
      actingTokenId: string | null;
    },
  ): Promise<{
    capabilities: CapabilityDescriptor[];
    executionTargets: IntelligenceExecutionTarget[];
  }>;
}

export interface IntelligenceAgentCardSource {
  get(input: {
    projectId: string;
    accountId: string;
    userId: string;
    capabilities: readonly CapabilityDescriptor[];
  }): Promise<AgentCard>;
}

export interface AgentTrustSource {
  isTrusted(input: {
    projectId: string;
    accountId: string;
    cardHash: string;
  }): Promise<boolean>;
}

export interface StudioTaskExecutor {
  /** Read-only lookup for already-bound work; unbound recovery must return null. */
  replay?(input: {
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    actorType: 'user' | 'agent' | 'system';
    agentName?: string | null;
    request: IntelligenceCreateTaskRequest;
  }): Promise<{ taskId: string; jobId: string; created: boolean } | null>;
  create(input: {
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    actorType: 'user' | 'agent' | 'system';
    actingTokenId: string | null;
    agentName: string | null;
    sessionId: string | null;
    estimateMode: 'external_signed' | 'trusted_internal';
    request: IntelligenceCreateTaskRequest;
  }): Promise<{ taskId: string; jobId: string; created: boolean }>;
}

export interface IntelligenceTaskEventReader {
  read(input: {
    accountId: string;
    projectId: string;
    taskId: string;
    cursor: string | null;
  }): Promise<{ items: TaskEvent[]; nextCursor: string | null } | null>;
}

export interface IntelligenceProjectRouteDeps {
  capabilityRegistry: IntelligenceCapabilityRegistry;
  getAgentCard: IntelligenceAgentCardSource['get'];
  loadProjectForUser: LoadProjectForUser;
  assertProjectCapability: AssertProjectCapability;
  taskExecutor?: StudioTaskExecutor;
  taskEventReader?: IntelligenceTaskEventReader;
  agentTrustSource?: AgentTrustSource;
}

type LoadedProject = { row: { accountId: string; projectId: string }; userId: string };

export function createIntelligenceProjectRoutes(deps: IntelligenceProjectRouteDeps) {
  const app = new Hono<AppEnv>();

  app.get('/:projectId/intelligence/capabilities', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE,
    );

    const actor = actorContext(c, loaded);
    const include = c.req.query('include');
    if (include !== undefined && include !== 'execution_targets') return badRequest(c);
    if (include === 'execution_targets') {
      const discovery = await discoverCapabilities(deps, projectId, actor);
      if (discovery.executionTargets.length > 1024) {
        return unavailable(c, 'INTELLIGENCE_DISCOVERY_TOO_LARGE');
      }
      try {
        return c.json(
          IntelligenceCapabilityDiscoveryResponseSchema.parse({
            protocol_version: 'intelligence.v1',
            items: discovery.capabilities,
            execution_targets: discovery.executionTargets,
            next_cursor: null,
          }),
        );
      } catch {
        return unavailable(c, 'INTELLIGENCE_DISCOVERY_INVALID');
      }
    }
    const capabilities = await listCapabilities(deps, projectId, actor);
    try {
      return c.json(
        IntelligenceCapabilitiesResponseSchema.parse({
          protocol_version: 'intelligence.v1',
          items: capabilities,
          next_cursor: null,
        }),
      );
    } catch {
      return unavailable(c, 'INTELLIGENCE_DISCOVERY_INVALID');
    }
  });

  app.get('/:projectId/intelligence/agent-card', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE,
    );

    const actor = actorContext(c, loaded);
    const capabilities = await listCapabilities(deps, projectId, actor);
    if (capabilities.length === 0) {
      return unavailable(c, 'INTELLIGENCE_CAPABILITIES_UNAVAILABLE');
    }
    try {
      const card = await deps.getAgentCard({
        projectId,
        accountId: loaded.row.accountId,
        userId: loaded.userId,
        capabilities,
      });
      const parsed = IntelligenceAgentCardResponseSchema.parse(card);
      return acceptsA2A(c) ? serializeAgentCard(parsed) : c.json(parsed);
    } catch {
      return unavailable(c, 'INTELLIGENCE_AGENT_CARD_UNAVAILABLE');
    }
  });

  app.post('/:projectId/intelligence/tasks', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN,
    );

    const body = await c.req.json().catch(() => null);
    const isA2A = hasMediaType(c.req.header('content-type'), 'application/a2a+json');
    let request: IntelligenceCreateTaskRequest;
    if (isA2A) {
      try {
        request = parseA2ATaskRequest(body).request;
      } catch (error) {
        return a2aProtocolErrorResponse(error);
      }
    } else {
      const parsed = IntelligenceCreateTaskRequestSchema.safeParse(body);
      if (!parsed.success) return badRequest(c);
      request = parsed.data;
    }
    const taskExecutor = deps.taskExecutor;
    if (!taskExecutor) {
      return unavailable(c, 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE', isA2A);
    }

    const actor = actorContext(c, loaded);

    if (!isA2A && taskExecutor.replay) {
      try {
        const replay = await taskExecutor.replay({
          accountId: loaded.row.accountId,
          projectId,
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          agentName: actor.agentName,
          request,
        });
        if (replay) return intelligenceTaskResponse(c, replay);
      } catch (error) {
        const typed = intelligenceTaskErrorResponse(c, error);
        if (typed) return typed;
        return unavailable(c, 'INTELLIGENCE_TASK_EXECUTION_FAILED');
      }
    }

    const discovery = await discoverCapabilities(deps, projectId, actor);
    const capabilities = discovery.capabilities;
    if (!capabilities.some((capability) => capability.id === request.capability_id)) {
      return taskConflict(
        c,
        isA2A,
        'Requested intelligence capability is unavailable',
        'INTELLIGENCE_CAPABILITY_UNAVAILABLE',
      );
    }
    if (
      !discovery.executionTargets.some(
        (target) =>
          target.capability_id === request.capability_id &&
          target.provider_config_id === request.provider_config_id &&
          target.model === request.model,
      )
    ) {
      return taskConflict(
        c,
        isA2A,
        'Requested intelligence execution target is unavailable',
        'INTELLIGENCE_EXECUTION_TARGET_UNAVAILABLE',
      );
    }

    let card: AgentCard;
    try {
      card = await deps.getAgentCard({
        projectId,
        accountId: loaded.row.accountId,
        userId: loaded.userId,
        capabilities,
      });
      IntelligenceAgentCardResponseSchema.parse(card);
    } catch {
      return unavailable(c, 'INTELLIGENCE_AGENT_CARD_UNAVAILABLE', isA2A);
    }

    const localCard = request.agent_card_hash === card.card_hash;
    if (isA2A && localCard && (actor.actorType !== 'agent' || !actor.agentName)) {
      return agentCardUntrusted(c, true);
    }
    if (!localCard) {
      let trusted = false;
      try {
        trusted =
          (await deps.agentTrustSource?.isTrusted({
            projectId,
            accountId: loaded.row.accountId,
            cardHash: request.agent_card_hash,
          })) ?? false;
      } catch {
        trusted = false;
      }
      if (!trusted) {
        return agentCardUntrusted(c, isA2A);
      }
    }

    if (isA2A) {
      try {
        const adapter = createA2ATaskAdapter({
          ...(taskExecutor.replay ? { replay: taskExecutor.replay.bind(taskExecutor) } : {}),
          create: taskExecutor.create.bind(taskExecutor),
          async events(input) {
            return deps.taskEventReader ? deps.taskEventReader.read(input) : null;
          },
        });
        const response = await adapter.create({
          accountId: loaded.row.accountId,
          projectId,
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actingTokenId: actor.actingTokenId,
          agentName: actor.agentName,
          sessionId: actor.sessionId,
          estimateMode: estimateModeForActor(actor.actorType),
          body,
        });
        return a2aJsonResponse(response);
      } catch (error) {
        return a2aTaskErrorResponse(error);
      }
    }

    let result: Awaited<ReturnType<StudioTaskExecutor['create']>>;
    try {
      result = await taskExecutor.create({
        accountId: loaded.row.accountId,
        projectId,
        actorUserId: actor.actorUserId,
        actorType: actor.actorType,
        actingTokenId: actor.actingTokenId,
        agentName: actor.agentName,
        sessionId: actor.sessionId,
        estimateMode: estimateModeForActor(actor.actorType),
        request,
      });
    } catch (error) {
      const typed = intelligenceTaskErrorResponse(c, error);
      if (typed) return typed;
      return unavailable(c, 'INTELLIGENCE_TASK_EXECUTION_FAILED');
    }
    return intelligenceTaskResponse(c, result);
  });

  app.get('/:projectId/intelligence/tasks/:taskId/events', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ,
    );
    if (!deps.taskEventReader) return unavailable(c, 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE');

    const cursor = c.req.query('cursor') ?? null;
    if (cursor !== null && !isValidCursor(cursor)) return badRequest(c);
    const taskId = c.req.param('taskId');
    if (!z.string().uuid().safeParse(taskId).success) return badRequest(c);
    let result: Awaited<ReturnType<IntelligenceTaskEventReader['read']>>;
    try {
      result = await deps.taskEventReader.read({
        accountId: loaded.row.accountId,
        projectId,
        taskId,
        cursor,
      });
    } catch (error) {
      const typed = intelligenceTaskErrorResponse(c, error);
      if (typed) return typed;
      return unavailable(c, 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE');
    }
    if (!result) return c.json({ error: 'Not found' }, 404);
    try {
      const response = IntelligenceTaskEventsResponseSchema.parse({
        protocol_version: 'intelligence.v1',
        task_id: taskId,
        items: result.items,
        next_cursor: result.nextCursor,
      });
      if (response.items.some((event) => event.task_id !== taskId)) {
        return unavailable(c, 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE');
      }
      if (acceptsA2A(c)) {
        const adapter = createA2ATaskAdapter({
          async create() {
            throw new Error('A2A task creation is unavailable on the events route');
          },
          async events() {
            return { items: response.items, nextCursor: response.next_cursor };
          },
        });
        const task = await adapter.events({
          accountId: loaded.row.accountId,
          projectId,
          taskId,
          cursor,
        });
        if (!task) return c.json({ error: 'Not found' }, 404);
        return a2aJsonResponse(task);
      }
      return c.json(response);
    } catch {
      return unavailable(c, 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE');
    }
  });

  return app;
}

function estimateModeForActor(
  actorType: 'user' | 'agent' | 'system',
): 'external_signed' | 'trusted_internal' {
  return actorType === 'user' ? 'external_signed' : 'trusted_internal';
}

async function loadProjectOr404(
  c: Context<AppEnv>,
  deps: Pick<IntelligenceProjectRouteDeps, 'loadProjectForUser'>,
  projectId: string,
): Promise<LoadedProject | Response> {
  const loaded = await deps.loadProjectForUser(c, projectId, 'read');
  return loaded ?? c.json({ error: 'Not found' }, 404);
}

async function listCapabilities(
  deps: Pick<IntelligenceProjectRouteDeps, 'capabilityRegistry'>,
  projectId: string,
  actor: ReturnType<typeof actorContext>,
): Promise<CapabilityDescriptor[]> {
  try {
    return await deps.capabilityRegistry.list(projectId, {
      accountId: actor.accountId,
      userId: actor.actorUserId ?? '',
      actorType: actor.actorType,
      actingTokenId: actor.actingTokenId,
    });
  } catch {
    return [];
  }
}

async function discoverCapabilities(
  deps: Pick<IntelligenceProjectRouteDeps, 'capabilityRegistry'>,
  projectId: string,
  actor: ReturnType<typeof actorContext>,
): Promise<{
  capabilities: CapabilityDescriptor[];
  executionTargets: IntelligenceExecutionTarget[];
}> {
  try {
    if (!deps.capabilityRegistry.discover) {
      return {
        capabilities: await listCapabilities(deps, projectId, actor),
        executionTargets: [],
      };
    }
    const discovery = await deps.capabilityRegistry.discover(projectId, {
      accountId: actor.accountId,
      userId: actor.actorUserId ?? '',
      actorType: actor.actorType,
      actingTokenId: actor.actingTokenId,
    });
    const available = new Set(discovery.capabilities.map((capability) => capability.id));
    return {
      capabilities: discovery.capabilities,
      executionTargets: discovery.executionTargets.filter((target) =>
        available.has(target.capability_id),
      ),
    };
  } catch {
    return { capabilities: [], executionTargets: [] };
  }
}

function actorContext(c: Context<AppEnv>, loaded: LoadedProject) {
  const authType = c.get('authType');
  if (authType === 'service_account') {
    return {
      accountId: loaded.row.accountId,
      actorUserId: loaded.userId,
      actorType: 'system' as const,
      actingTokenId: null,
      agentName: null,
      sessionId: null,
    };
  }
  if (authType === 'pat') {
    const grant = c.get('agentGrant') as { agent?: string } | null | undefined;
    return {
      accountId: loaded.row.accountId,
      actorUserId: loaded.userId,
      actorType: grant ? ('agent' as const) : ('user' as const),
      actingTokenId: c.get('iamTokenId') ?? null,
      agentName: grant?.agent ?? null,
      sessionId: c.get('sessionId') ?? null,
    };
  }
  return {
    accountId: loaded.row.accountId,
    actorUserId: loaded.userId,
    actorType: 'user' as const,
    actingTokenId: null,
    agentName: null,
    sessionId: null,
  };
}

function badRequest(c: Context<AppEnv>) {
  return c.json(
    { error: 'Invalid Intelligence request', code: 'INTELLIGENCE_VALIDATION_ERROR' },
    400,
  );
}

function unavailable(c: Context<AppEnv>, code: string, isA2A = false) {
  if (isA2A) {
    return a2aJsonResponse({ error: 'A2A task capability unavailable', code }, 503);
  }
  return c.json({ error: 'Intelligence capability unavailable', code }, 503);
}

function taskConflict(c: Context<AppEnv>, isA2A: boolean, error: string, code: string) {
  return isA2A ? a2aJsonResponse({ error, code }, 409) : c.json({ error, code }, 409);
}

function intelligenceTaskResponse(
  c: Context<AppEnv>,
  result: { taskId: string; jobId: string; created: boolean },
) {
  try {
    const response = IntelligenceTaskResponseSchema.parse({
      protocol_version: 'intelligence.v1',
      task_id: result.taskId,
      job_id: result.jobId,
      created: result.created,
    });
    return c.json(response, result.created ? 201 : 200);
  } catch {
    return unavailable(c, 'INTELLIGENCE_TASK_EXECUTION_FAILED');
  }
}

function intelligenceTaskErrorResponse(c: Context<AppEnv>, error: unknown): Response | null {
  if (!isIntelligenceTaskServiceError(error)) return null;
  if (error.code === 'INTELLIGENCE_IDEMPOTENCY_MISMATCH') {
    return c.json(
      { error: 'Intelligence task idempotency conflict', code: error.code },
      error.status,
    );
  }
  if (error.code === 'INTELLIGENCE_VALIDATION_ERROR') {
    return c.json({ error: 'Invalid Intelligence request', code: error.code }, error.status);
  }
  if (error.code === 'INTELLIGENCE_ESTIMATE_INVALID') {
    return c.json({ error: 'Invalid Intelligence estimate approval', code: error.code }, 409);
  }
  if (error.code === 'INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED') {
    return c.json({ error: 'Intelligence estimate credit limit exceeded', code: error.code }, 409);
  }
  return unavailable(c, error.code);
}

function isValidCursor(cursor: string): boolean {
  if (cursor !== cursor.trim() || !/^\d+$/.test(cursor) || cursor.length > 16) return false;
  const value = Number(cursor);
  return Number.isSafeInteger(value) && value >= 0;
}

function acceptsA2A(c: Context<AppEnv>): boolean {
  return hasMediaType(c.req.header('accept'), 'application/a2a+json');
}

function hasMediaType(header: string | undefined, mediaType: string): boolean {
  return Boolean(
    header?.split(',').some((value) => value.split(';', 1)[0]?.trim().toLowerCase() === mediaType),
  );
}

function a2aJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/a2a+json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function a2aProtocolErrorResponse(error: unknown): Response {
  const protocolError =
    error instanceof A2AProtocolError ? error : new A2AProtocolError('A2A_INVALID_REQUEST', 400);
  return a2aJsonResponse(
    { error: 'Invalid A2A request', code: protocolError.code },
    protocolError.status,
  );
}

function agentCardUntrusted(c: Context<AppEnv>, isA2A: boolean): Response {
  if (isA2A) {
    return a2aJsonResponse(
      { error: 'A2A sender is not trusted for this project', code: 'A2A_AGENT_UNTRUSTED' },
      403,
    );
  }
  return c.json(
    {
      error: 'Agent Card is not trusted for this project',
      code: 'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
    },
    403,
  );
}

function a2aTaskErrorResponse(error: unknown): Response {
  if (isIntelligenceTaskServiceError(error)) {
    const message =
      error.code === 'INTELLIGENCE_IDEMPOTENCY_MISMATCH'
        ? 'A2A task idempotency conflict'
        : error.code === 'INTELLIGENCE_VALIDATION_ERROR'
          ? 'Invalid A2A task request'
          : 'A2A task execution unavailable';
    return a2aJsonResponse({ error: message, code: error.code }, error.status);
  }
  return a2aJsonResponse(
    { error: 'A2A task execution unavailable', code: 'INTELLIGENCE_TASK_EXECUTION_FAILED' },
    503,
  );
}
