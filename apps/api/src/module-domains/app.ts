import { timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { PROJECT_ACTIONS } from '../iam/actions';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import {
  ModuleCustomDomainBindingError,
  type ModuleCustomDomainBindingService,
  type ModuleCustomDomainBindingView,
  type ModuleCustomDomainCreation,
} from './bindings';

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

export interface ModuleCustomDomainProjectRouteDependencies {
  loadProjectForUser: LoadProjectForUser;
  assertProjectCapability: AssertProjectCapability;
  bindingService: Pick<
    ModuleCustomDomainBindingService,
    'create' | 'list' | 'verify' | 'disable'
  > | null;
}

export interface ModuleCustomDomainInternalRouteDependencies {
  bindingService: Pick<ModuleCustomDomainBindingService, 'resolve'> | null;
  internalServiceKey: string;
}

const projectParams = z.object({
  projectId: z.string().uuid(),
  installationId: z.string().uuid(),
});
const bindingParams = projectParams.extend({ bindingId: z.string().uuid() });
const createBody = z
  .object({
    hostname: z.string().min(1).max(253),
    expected_install_revision: z.number().int().positive(),
  })
  .strict();

const bindingViewSchema = z.object({
  binding_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  release_id: z.string().uuid(),
  hostname: z.string(),
  hostname_ascii: z.string(),
  state: z.enum(['requested', 'dns_pending', 'hostname_pending', 'active', 'failed', 'disabled']),
  cname_target: z.string(),
  failure_code: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

function bindingWire(value: ModuleCustomDomainBindingView) {
  return {
    binding_id: value.bindingId,
    installation_id: value.installationId,
    release_id: value.releaseId,
    hostname: value.hostname,
    hostname_ascii: value.hostnameAscii,
    state: value.state,
    cname_target: value.cnameTarget,
    failure_code: value.failureCode,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

function creationWire(value: ModuleCustomDomainCreation) {
  return {
    binding: bindingWire(value.binding),
    verification_record: value.verificationRecord,
    cname_record: value.cnameRecord,
  };
}

function domainErrorResponse(context: Context<AppEnv>, error: unknown): Response | null {
  if (!(error instanceof ModuleCustomDomainBindingError)) return null;
  return context.json({ error: error.code }, error.status);
}

async function loadAndAuthorize(
  context: Context<AppEnv>,
  dependencies: ModuleCustomDomainProjectRouteDependencies,
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

export function createModuleCustomDomainProjectRoutes(
  dependencies: ModuleCustomDomainProjectRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/modules/{installationId}/domains',
      tags: ['developer'],
      summary: 'Request a verified custom domain for a developer module',
      ...auth,
      request: {
        params: projectParams,
        body: { required: true, content: { 'application/json': { schema: createBody } } },
      },
      responses: {
        201: json(
          z.object({
            binding: bindingViewSchema,
            verification_record: z.object({
              type: z.literal('TXT'),
              name: z.string(),
              value: z.string(),
            }),
            cname_record: z.object({
              type: z.literal('CNAME'),
              name: z.string(),
              value: z.string(),
            }),
          }),
          'Custom domain verification instructions',
        ),
        ...errors(400, 403, 404, 409, 503),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared OpenAPI helpers widen status unions.
    async (context: any) => {
      const params = context.req.valid('param');
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        params.projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      );
      if (loaded instanceof Response) return loaded;
      if (!dependencies.bindingService)
        return context.json({ error: 'MODULE_DOMAIN_UNAVAILABLE' }, 503);
      try {
        const created = await dependencies.bindingService.create({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
          expectedInstallRevision: context.req.valid('json').expected_install_revision,
          hostname: context.req.valid('json').hostname,
          actorUserId: loaded.userId,
        });
        return context.json(creationWire(created), 201);
      } catch (error) {
        const response = domainErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/modules/{installationId}/domains',
      tags: ['developer'],
      summary: 'List custom domains for a developer module',
      ...auth,
      request: { params: projectParams },
      responses: {
        200: json(z.object({ bindings: z.array(bindingViewSchema) }), 'Custom domains'),
        ...errors(403, 404, 503),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared OpenAPI helpers widen status unions.
    async (context: any) => {
      const params = context.req.valid('param');
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        params.projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      );
      if (loaded instanceof Response) return loaded;
      if (!dependencies.bindingService)
        return context.json({ error: 'MODULE_DOMAIN_UNAVAILABLE' }, 503);
      try {
        const bindings = await dependencies.bindingService.list({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
        });
        return context.json({ bindings: bindings.map(bindingWire) }, 200);
      } catch (error) {
        const response = domainErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/modules/{installationId}/domains/{bindingId}/verify',
      tags: ['developer'],
      summary: 'Verify DNS and advance a custom hostname',
      ...auth,
      request: { params: bindingParams },
      responses: {
        200: json(bindingViewSchema, 'Custom domain status'),
        ...errors(403, 404, 409, 503),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared OpenAPI helpers widen status unions.
    async (context: any) => {
      const params = context.req.valid('param');
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        params.projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      );
      if (loaded instanceof Response) return loaded;
      if (!dependencies.bindingService)
        return context.json({ error: 'MODULE_DOMAIN_UNAVAILABLE' }, 503);
      try {
        const value = await dependencies.bindingService.verify({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
          bindingId: params.bindingId,
        });
        return context.json(bindingWire(value), 200);
      } catch (error) {
        const response = domainErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/modules/{installationId}/domains/{bindingId}',
      tags: ['developer'],
      summary: 'Disable a custom hostname',
      ...auth,
      request: { params: bindingParams },
      responses: {
        200: json(bindingViewSchema, 'Disabled custom domain'),
        ...errors(403, 404, 409, 503),
      },
    }),
    // biome-ignore lint/suspicious/noExplicitAny: Shared OpenAPI helpers widen status unions.
    async (context: any) => {
      const params = context.req.valid('param');
      const loaded = await loadAndAuthorize(
        context,
        dependencies,
        params.projectId,
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      );
      if (loaded instanceof Response) return loaded;
      if (!dependencies.bindingService)
        return context.json({ error: 'MODULE_DOMAIN_UNAVAILABLE' }, 503);
      try {
        const value = await dependencies.bindingService.disable({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
          bindingId: params.bindingId,
        });
        return context.json(bindingWire(value), 200);
      } catch (error) {
        const response = domainErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  return app;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createModuleCustomDomainInternalRoutes(
  dependencies: ModuleCustomDomainInternalRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();
  app.get('/resolve', async (context) => {
    if (
      dependencies.internalServiceKey.length < 16 ||
      !safeEqual(context.req.header('X-Kortix-Internal-Key') ?? '', dependencies.internalServiceKey)
    ) {
      return context.json({ error: 'Unauthorized' }, 401);
    }
    if (!dependencies.bindingService) return context.json({ error: 'Not found' }, 404);
    const hostname = context.req.query('hostname') ?? '';
    if (!hostname || hostname.length > 253) return context.json({ error: 'Not found' }, 404);
    const resolved = await dependencies.bindingService.resolve(hostname);
    return resolved ? context.json(resolved, 200) : context.json({ error: 'Not found' }, 404);
  });
  return app;
}
