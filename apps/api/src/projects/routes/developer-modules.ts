import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { DeveloperModuleDistributionError } from '../../developer/distribution';
import {
  ProjectModuleInstallationError,
  type ProjectModuleInstallationService,
} from '../../developer/installations';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';

type LoadedProject = { row: { accountId: string; projectId: string }; userId: string };
type LoadProjectForUser = (
  context: Context<AppEnv>,
  projectId: string,
  action: 'read' | 'write' | 'session' | 'manage',
) => Promise<LoadedProject | null>;
type AssertProjectCapability = (
  context: Context<AppEnv>,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
) => Promise<void>;

export interface ProjectDeveloperModuleRouteDependencies {
  loadProjectForUser: LoadProjectForUser;
  assertProjectCapability: AssertProjectCapability;
  installationService: Pick<
    ProjectModuleInstallationService,
    'list' | 'history' | 'install' | 'update' | 'rollback'
  >;
}

const moduleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const mutationBody = z
  .object({
    release_id: z.string().uuid(),
    expected_install_revision: z.number().int().nonnegative(),
    // Accepted for backwards-compatible clients, but deliberately ignored. The
    // canonical account always comes from the loaded project row.
    account_id: z.string().optional(),
  })
  .strict();

function installationErrorResponse(context: Context<AppEnv>, error: unknown): Response | null {
  if (error instanceof ProjectModuleInstallationError) {
    return context.json({ error: error.code }, error.status);
  }
  if (error instanceof DeveloperModuleDistributionError) {
    return context.json({ error: error.code }, error.status);
  }
  return null;
}

async function loadAndAuthorize(
  context: Context<AppEnv>,
  dependencies: ProjectDeveloperModuleRouteDependencies,
  projectId: string,
  action:
    | typeof PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ
    | typeof PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
): Promise<LoadedProject | Response> {
  const loaded = await dependencies.loadProjectForUser(context, projectId, 'read');
  if (!loaded) return context.json({ error: 'Not found' }, 404);
  await dependencies.assertProjectCapability(
    context,
    loaded.userId,
    loaded.row.accountId,
    projectId,
    action,
  );
  return loaded;
}

export function createProjectDeveloperModuleRoutes(
  dependencies: ProjectDeveloperModuleRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/modules',
      tags: ['developer'],
      summary: 'List installed developer modules for a project',
      ...auth,
      request: { params: z.object({ projectId: z.string() }) },
      responses: {
        200: json(z.object({ modules: z.array(z.record(z.unknown())) }), 'Installed modules'),
        ...errors(403, 404),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared auth/error helpers widen OpenAPIHono status unions.
    async (context: any) => {
      const projectId = context.req.valid('param').projectId;
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      );
      if (loaded instanceof Response) return loaded;
      const modules = await dependencies.installationService.list({
        accountId: loaded.row.accountId,
        projectId,
      });
      return context.json({ modules: [...modules] }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/modules/{moduleId}/history',
      tags: ['developer'],
      summary: 'List immutable installation history for a project developer module',
      ...auth,
      request: {
        params: z.object({ projectId: z.string(), moduleId }),
      },
      responses: {
        200: json(z.object({ history: z.array(z.record(z.unknown())) }), 'Installation history'),
        ...errors(403, 404),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared auth/error helpers widen OpenAPIHono status unions.
    async (context: any) => {
      const params = context.req.valid('param');
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        params.projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      );
      if (loaded instanceof Response) return loaded;
      try {
        const history = await dependencies.installationService.history({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          moduleId: params.moduleId,
        });
        return context.json({ history: [...history] }, 200);
      } catch (error) {
        const response = installationErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/modules/install',
      tags: ['developer'],
      summary: 'Install a published developer module release',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        headers: z.object({ 'Idempotency-Key': z.string().optional() }).passthrough(),
        body: { content: { 'application/json': { schema: mutationBody } } },
      },
      responses: {
        201: json(z.record(z.unknown()), 'Installed module transition'),
        ...errors(400, 403, 404, 409, 503),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared auth/error helpers widen OpenAPIHono status unions.
    async (context: any) => {
      const projectId = context.req.valid('param').projectId;
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      );
      if (loaded instanceof Response) return loaded;
      const body = context.req.valid('json');
      try {
        const transition = await dependencies.installationService.install({
          accountId: loaded.row.accountId,
          projectId,
          actorUserId: loaded.userId,
          releaseId: body.release_id,
          expectedInstallRevision: body.expected_install_revision as 0,
          idempotencyKey: context.req.header('Idempotency-Key'),
        });
        return context.json(transition, 201);
      } catch (error) {
        const response = installationErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  const moveRoute = (action: 'update' | 'rollback') =>
    app.openapi(
      createRoute({
        method: 'post',
        path: `/{projectId}/modules/{moduleId}/${action}`,
        tags: ['developer'],
        summary: `${action === 'update' ? 'Update' : 'Rollback'} a project developer module`,
        ...auth,
        request: {
          params: z.object({ projectId: z.string(), moduleId }),
          headers: z.object({ 'Idempotency-Key': z.string().optional() }).passthrough(),
          body: { content: { 'application/json': { schema: mutationBody } } },
        },
        responses: {
          200: json(z.record(z.unknown()), `${action}d module transition`),
          ...errors(400, 403, 404, 409, 503),
        },
      }),
      // biome-ignore lint/suspicious/noExplicitAny: Shared auth/error helpers widen OpenAPIHono status unions.
      async (context: any) => {
        const params = context.req.valid('param');
        const loaded = await loadAndAuthorize(
          context,
          dependencies,
          params.projectId,
          PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
        );
        if (loaded instanceof Response) return loaded;
        const body = context.req.valid('json');
        const command = {
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          moduleId: params.moduleId,
          actorUserId: loaded.userId,
          releaseId: body.release_id,
          expectedInstallRevision: body.expected_install_revision,
          idempotencyKey: context.req.header('Idempotency-Key'),
        };
        try {
          const transition =
            action === 'update'
              ? await dependencies.installationService.update(command)
              : await dependencies.installationService.rollback(command);
          return context.json(transition, 200);
        } catch (error) {
          const response = installationErrorResponse(context, error);
          if (response) return response;
          throw error;
        }
      },
    );

  moveRoute('update');
  moveRoute('rollback');
  return app;
}
