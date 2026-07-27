import type { Context, MiddlewareHandler } from 'hono';
import { z } from 'zod';

import { PROJECT_ACTIONS } from '../iam/actions';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import {
  RuntimeArtifactAccessError,
  type RuntimeArtifactService,
} from './runtime-artifacts';
import {
  type ModuleExecution,
  ModuleExecutionError,
  type ModuleExecutionEstimate,
  type ModuleExecutionEvent,
  type ModuleExecutionService,
} from './executions';
import {
  type ModuleRunnerIdentity,
  type ModuleRunnerProtocol,
  ModuleRunnerProtocolError,
  type RunnerRegistrationIdentity,
} from './runner-protocol';

type LoadedProject = { row: { accountId: string; projectId: string }; userId: string };

export interface ModuleRuntimeAppDependencies {
  authenticateUser: MiddlewareHandler<AppEnv>;
  loadProjectForUser(
    context: Context<AppEnv>,
    projectId: string,
    action: 'read' | 'write' | 'session' | 'manage',
  ): Promise<LoadedProject | null>;
  assertProjectCapability(
    context: Context<AppEnv>,
    userId: string,
    accountId: string,
    projectId: string,
    action: string,
  ): Promise<void>;
  executionService: Pick<
    ModuleExecutionService,
    'estimate' | 'create' | 'confirm' | 'cancel' | 'get' | 'events'
  >;
  runnerProtocol: Pick<
    ModuleRunnerProtocol,
    'register' | 'heartbeatNode' | 'claimNext' | 'heartbeatLease' | 'appendEvidence' | 'finalize'
  >;
  runtimeArtifactService: Pick<RuntimeArtifactService, 'openForLease'>;
  authenticateRunner(context: Context<AppEnv>): Promise<ModuleRunnerIdentity>;
  registrationIdentity(context: Context<AppEnv>): Promise<RunnerRegistrationIdentity>;
}

const uuid = z.string().uuid();
const digest = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value),
);
const RUNNER_CONTROL_MAX_REQUEST_BYTES = 16 * 1024;
const RUNNER_REGISTRATION_MAX_REQUEST_BYTES = 64 * 1024;
const RUNNER_EVIDENCE_MAX_REQUEST_BYTES = 512 * 1024;
const RUNNER_FINALIZE_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const projectInput = z.object({ installation_id: uuid }).strict();
const createInput = projectInput
  .extend({ deadline_at: z.string().datetime({ offset: true }), input: z.unknown() })
  .strict()
  .refine((value) => Object.hasOwn(value, 'input'));

function executionWire(value: ModuleExecution) {
  return {
    execution_id: value.executionId,
    account_id: value.accountId,
    project_id: value.projectId,
    installation_id: value.installationId,
    release_id: value.releaseId,
    state: value.state,
    kill_switch_generation: value.killSwitchGeneration,
    deadline_at: value.deadlineAt,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
    terminal_at: value.terminalAt,
  };
}

function estimateWire(value: ModuleExecutionEstimate) {
  return {
    account_id: value.accountId,
    project_id: value.projectId,
    installation_id: value.installationId,
    install_revision: value.installRevision,
    release_id: value.releaseId,
    release_digest: value.releaseDigest,
    runtime_kind: value.runtimeKind,
    runtime_profile: value.runtimeProfile,
    resource_ceilings: {
      cpu_millis: value.resourceCeilings.cpuMillis,
      memory_mib: value.resourceCeilings.memoryMiB,
      wall_time_ms: value.resourceCeilings.wallTimeMs,
      cost_micro: value.resourceCeilings.costMicro,
    },
    confirmation_required: value.confirmationRequired,
  };
}

function eventWire(value: ModuleExecutionEvent) {
  return {
    event_id: value.eventId,
    execution_id: value.executionId,
    sequence: value.sequence,
    event_type: value.eventType,
    payload: value.payload,
    created_at: value.createdAt,
  };
}

function errorResponse(context: Context<AppEnv>, error: unknown): Response | null {
  if (
    error instanceof ModuleExecutionError ||
    error instanceof ModuleRunnerProtocolError ||
    error instanceof RuntimeArtifactAccessError
  ) {
    return context.json({ error: error.code }, error.status);
  }
  return null;
}

async function jsonBody(context: Context<AppEnv>): Promise<unknown> {
  return context.req.json().catch(() => null);
}

class ModuleRuntimeRequestTooLargeError extends Error {}

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
        throw new ModuleRuntimeRequestTooLargeError();
      }
      text += decoder.decode(next.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function runnerBody<T extends z.ZodTypeAny>(
  context: Context<AppEnv>,
  schema: T,
  maxBytes: number,
  errorCode: 'RUNNER_REGISTRATION_INVALID' | 'RUNNER_EXECUTION_UNAVAILABLE',
): Promise<z.infer<T> | Response> {
  const contentLength = Number(context.req.header('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return context.json({ error: errorCode }, 413);
  }
  try {
    const value = JSON.parse(await readBoundedRequestText(context.req.raw.body, maxBytes));
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : context.json({ error: errorCode }, 400);
  } catch (error) {
    return context.json(
      { error: errorCode },
      error instanceof ModuleRuntimeRequestTooLargeError ? 413 : 400,
    );
  }
}

async function projectAuthorization(
  context: Context<AppEnv>,
  dependencies: ModuleRuntimeAppDependencies,
  projectId: string,
  write: boolean,
): Promise<LoadedProject | Response> {
  const loaded = await dependencies.loadProjectForUser(context, projectId, 'read');
  if (!loaded) return context.json({ error: 'MODULE_EXECUTION_NOT_FOUND' }, 404);
  await dependencies.assertProjectCapability(
    context,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    write ? PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE : PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
  );
  return loaded;
}

export function createModuleRuntimeApp(dependencies: ModuleRuntimeAppDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  app.use('/projects/*', dependencies.authenticateUser);

  app.post('/projects/:projectId/module-executions/estimate', async (context) => {
    const body = projectInput.safeParse(await jsonBody(context));
    if (!body.success) return context.json({ error: 'MODULE_EXECUTION_INPUT_INVALID' }, 400);
    const projectId = context.req.param('projectId');
    const loaded = await projectAuthorization(context, dependencies, projectId, false);
    if (loaded instanceof Response) return loaded;
    try {
      return context.json(
        estimateWire(
          await dependencies.executionService.estimate({
            accountId: loaded.row.accountId,
            projectId,
            installationId: body.data.installation_id,
            actorUserId: loaded.userId,
          }),
        ),
        200,
      );
    } catch (error) {
      const response = errorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post('/projects/:projectId/module-executions', async (context) => {
    const body = createInput.safeParse(await jsonBody(context));
    const idempotencyKey = context.req.header('Idempotency-Key');
    if (!body.success || !idempotencyKey) {
      return context.json({ error: 'MODULE_EXECUTION_INPUT_INVALID' }, 400);
    }
    const projectId = context.req.param('projectId');
    const loaded = await projectAuthorization(context, dependencies, projectId, true);
    if (loaded instanceof Response) return loaded;
    try {
      const created = await dependencies.executionService.create({
        accountId: loaded.row.accountId,
        projectId,
        installationId: body.data.installation_id,
        actorUserId: loaded.userId,
        idempotencyKey,
        deadlineAt: body.data.deadline_at,
        input: body.data.input,
      });
      return context.json(executionWire(created), 201);
    } catch (error) {
      const response = errorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  const executionAction = (action: 'confirm' | 'cancel') =>
    app.post(`/projects/:projectId/module-executions/:executionId/${action}`, async (context) => {
      const projectId = context.req.param('projectId');
      const executionId = context.req.param('executionId');
      const loaded = await projectAuthorization(context, dependencies, projectId, true);
      if (loaded instanceof Response) return loaded;
      try {
        const value =
          action === 'confirm'
            ? await dependencies.executionService.confirm({
                accountId: loaded.row.accountId,
                projectId,
                executionId,
                actorUserId: loaded.userId,
              })
            : await dependencies.executionService.cancel({
                accountId: loaded.row.accountId,
                projectId,
                executionId,
              });
        return context.json(executionWire(value), 200);
      } catch (error) {
        const response = errorResponse(context, error);
        if (response) return response;
        throw error;
      }
    });
  executionAction('confirm');
  executionAction('cancel');

  app.get('/projects/:projectId/module-executions/:executionId', async (context) => {
    const projectId = context.req.param('projectId');
    const executionId = context.req.param('executionId');
    const loaded = await projectAuthorization(context, dependencies, projectId, false);
    if (loaded instanceof Response) return loaded;
    try {
      return context.json(
        executionWire(
          await dependencies.executionService.get({
            accountId: loaded.row.accountId,
            projectId,
            executionId,
          }),
        ),
        200,
      );
    } catch (error) {
      const response = errorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.get('/projects/:projectId/module-executions/:executionId/events', async (context) => {
    const projectId = context.req.param('projectId');
    const executionId = context.req.param('executionId');
    const loaded = await projectAuthorization(context, dependencies, projectId, false);
    if (loaded instanceof Response) return loaded;
    try {
      const events = await dependencies.executionService.events({
        accountId: loaded.row.accountId,
        projectId,
        executionId,
      });
      return context.json({ events: events.map(eventWire) }, 200);
    } catch (error) {
      const response = errorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  app.post('/module-runtime/runners/register', async (context) => {
    try {
      const identity = await dependencies.registrationIdentity(context);
      const body = await runnerBody(
        context,
        z
          .object({
            registrationToken: z.string().min(1),
            nodeIdentity: z.string().min(1).max(255),
            softwareVersion: z.string().min(1).max(128),
            attestationDigest: digest,
            profiles: z
              .array(
                z.object({
                  profileName: z.string().min(1).max(128),
                  runtimeKind: z.enum(['wasi-component', 'oci-image']),
                }),
              )
              .min(1)
              .max(32),
          })
          .strict(),
        RUNNER_REGISTRATION_MAX_REQUEST_BYTES,
        'RUNNER_REGISTRATION_INVALID',
      );
      if (body instanceof Response) return body;
      return context.json(await dependencies.runnerProtocol.register(identity, body), 201);
    } catch (error) {
      const response = errorResponse(context, error);
      if (response) return response;
      throw error;
    }
  });

  const withRunner = async (
    context: Context<AppEnv>,
    operation: (identity: ModuleRunnerIdentity) => Promise<Response>,
  ) => {
    try {
      return await operation(await dependencies.authenticateRunner(context));
    } catch (error) {
      const response = errorResponse(context, error);
      if (response) return response;
      throw error;
    }
  };

  app.post('/module-runtime/runners/heartbeat', async (context) => {
    return withRunner(context, async (identity) => {
      const body = await runnerBody(
        context,
        z
          .object({ softwareVersion: z.string().min(1).max(128), attestationDigest: digest })
          .strict(),
        RUNNER_CONTROL_MAX_REQUEST_BYTES,
        'RUNNER_REGISTRATION_INVALID',
      );
      if (body instanceof Response) return body;
      return context.json(await dependencies.runnerProtocol.heartbeatNode(identity, body), 200);
    });
  });

  app.post('/module-runtime/claims/next', async (context) => {
    return withRunner(context, async (identity) => {
      const body = await runnerBody(
        context,
        z.object({}).strict(),
        RUNNER_CONTROL_MAX_REQUEST_BYTES,
        'RUNNER_EXECUTION_UNAVAILABLE',
      );
      if (body instanceof Response) return body;
      const claimed = await dependencies.runnerProtocol.claimNext(identity, body);
      return claimed ? context.json(claimed, 200) : new Response(null, { status: 204 });
    });
  });

  app.post('/module-runtime/artifacts/fetch', async (context) => {
    return withRunner(context, async (identity) => {
      if (context.req.header('range') !== undefined) {
        return context.json({ error: 'RUNNER_EXECUTION_UNAVAILABLE' }, 400);
      }
      const body = await runnerBody(
        context,
        z
          .object({
            projectId: uuid,
            executionId: uuid,
            leaseId: uuid,
            generation: z.number().int().positive(),
          })
          .strict(),
        RUNNER_CONTROL_MAX_REQUEST_BYTES,
        'RUNNER_EXECUTION_UNAVAILABLE',
      );
      if (body instanceof Response) return body;
      const artifact = await dependencies.runtimeArtifactService.openForLease({
        accountId: identity.accountId,
        projectId: body.projectId,
        executionId: body.executionId,
        leaseId: body.leaseId,
        generation: body.generation,
        runnerId: identity.runnerId,
      });
      return new Response(artifact.body, {
        status: 200,
        headers: {
          'content-type': 'application/wasm',
          'content-length': String(artifact.bytes),
          'x-openopc-artifact-sha256': artifact.digest,
        },
      });
    });
  });

  app.post('/module-runtime/leases/heartbeat', async (context) => {
    return withRunner(context, async (identity) => {
      const body = await runnerBody(
        context,
        z
          .object({
            projectId: uuid,
            executionId: uuid,
            leaseId: uuid,
            generation: z.number().int().positive(),
          })
          .strict(),
        RUNNER_CONTROL_MAX_REQUEST_BYTES,
        'RUNNER_EXECUTION_UNAVAILABLE',
      );
      if (body instanceof Response) return body;
      return context.json(await dependencies.runnerProtocol.heartbeatLease(identity, body), 200);
    });
  });

  app.post('/module-runtime/evidence', async (context) => {
    return withRunner(context, async (identity) => {
      const body = await runnerBody(
        context,
        z
          .object({
            projectId: uuid,
            executionId: uuid,
            leaseId: uuid,
            generation: z.number().int().positive(),
            eventType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
            evidence: z.record(z.unknown()),
          })
          .strict(),
        RUNNER_EVIDENCE_MAX_REQUEST_BYTES,
        'RUNNER_EXECUTION_UNAVAILABLE',
      );
      if (body instanceof Response) return body;
      return context.json(await dependencies.runnerProtocol.appendEvidence(identity, body), 200);
    });
  });

  app.post('/module-runtime/finalize', async (context) => {
    return withRunner(context, async (identity) => {
      const body = await runnerBody(
        context,
        z
          .object({
            projectId: uuid,
            executionId: uuid,
            leaseId: uuid,
            generation: z.number().int().positive(),
            outcome: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']),
            evidenceDigest: digest,
            evidence: z.record(z.unknown()),
            usage: z.record(z.unknown()),
          })
          .strict(),
        RUNNER_FINALIZE_MAX_REQUEST_BYTES,
        'RUNNER_EXECUTION_UNAVAILABLE',
      );
      if (body instanceof Response) return body;
      return context.json(await dependencies.runnerProtocol.finalize(identity, body), 200);
    });
  });

  return app;
}
