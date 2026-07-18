import {
  IntelligenceAgentCardResponseSchema,
  IntelligenceCapabilitiesResponseSchema,
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  IntelligenceTaskEventsResponseSchema,
  IntelligenceTaskResponseSchema,
} from '@kortix/api-contract';
import type { AgentCard, CapabilityDescriptor, TaskEvent } from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { PROJECT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';

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
  create(input: {
    accountId: string;
    projectId: string;
    actorUserId: string | null;
    actorType: 'user' | 'agent' | 'system';
    actingTokenId: string | null;
    agentName: string | null;
    sessionId: string | null;
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
    const capabilities = await listCapabilities(deps, projectId, actor);
    return c.json(
      IntelligenceCapabilitiesResponseSchema.parse({
        protocol_version: 'intelligence.v1',
        items: capabilities,
        next_cursor: null,
      }),
    );
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
      return c.json(IntelligenceAgentCardResponseSchema.parse(card));
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

    const parsed = IntelligenceCreateTaskRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return badRequest(c);
    if (!deps.taskExecutor) return unavailable(c, 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE');

    const actor = actorContext(c, loaded);
    const capabilities = await listCapabilities(deps, projectId, actor);
    if (!capabilities.some((capability) => capability.id === parsed.data.capability_id)) {
      return c.json(
        {
          error: 'Requested intelligence capability is unavailable',
          code: 'INTELLIGENCE_CAPABILITY_UNAVAILABLE',
        },
        409,
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
      return unavailable(c, 'INTELLIGENCE_AGENT_CARD_UNAVAILABLE');
    }

    if (parsed.data.agent_card_hash !== card.card_hash) {
      let trusted = false;
      try {
        trusted =
          (await deps.agentTrustSource?.isTrusted({
            projectId,
            accountId: loaded.row.accountId,
            cardHash: parsed.data.agent_card_hash,
          })) ?? false;
      } catch {
        trusted = false;
      }
      if (!trusted) {
        return c.json(
          {
            error: 'Agent Card is not trusted for this project',
            code: 'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
          },
          403,
        );
      }
    }

    let result: Awaited<ReturnType<StudioTaskExecutor['create']>>;
    try {
      result = await deps.taskExecutor.create({
        accountId: loaded.row.accountId,
        projectId,
        actorUserId: actor.actorUserId,
        actorType: actor.actorType,
        actingTokenId: actor.actingTokenId,
        agentName: actor.agentName,
        sessionId: actor.sessionId,
        request: parsed.data,
      });
    } catch {
      return unavailable(c, 'INTELLIGENCE_TASK_EXECUTION_FAILED');
    }
    const response = IntelligenceTaskResponseSchema.parse({
      protocol_version: 'intelligence.v1',
      task_id: result.taskId,
      job_id: result.jobId,
      created: result.created,
    });
    return c.json(response, result.created ? 201 : 200);
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
    } catch {
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
      return c.json(response);
    } catch {
      return unavailable(c, 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE');
    }
  });

  return app;
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

function unavailable(c: Context<AppEnv>, code: string) {
  return c.json({ error: 'Intelligence capability unavailable', code }, 503);
}

function isValidCursor(cursor: string): boolean {
  return cursor === cursor.trim() && cursor.length > 0 && cursor.length <= 256;
}
