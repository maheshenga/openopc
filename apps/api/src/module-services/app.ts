import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import {
  ModuleServiceCapabilityRequestSchema,
  ModuleServiceConsentDeleteInputSchema,
  type ModuleServiceConsentPutInput,
  ModuleServiceConsentPutInputSchema,
  OpenOpcServiceNameSchema,
  parseModuleServiceConsentPutInput,
} from '@kortix/api-contract';

import { PROJECT_ACTIONS } from '../iam/actions';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import {
  type ModuleAiDependencies,
  createModuleAiRoutes,
  createRuntimeModuleAiDependencies,
} from './ai';
import {
  type ModuleServiceCapabilityBroker,
  ModuleServiceCapabilityError,
  type ModuleServiceConsent,
  type ModuleServiceConsentManager,
} from './capability-grants';
import {
  type ModulePaymentRouteDependencies,
  createModulePaymentRoutes,
  createRuntimeModulePaymentDependencies,
} from './payments';

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

export interface ModuleServiceProjectRouteDependencies {
  loadProjectForUser: LoadProjectForUser;
  assertProjectCapability: AssertProjectCapability;
  consentManager: Pick<
    ModuleServiceConsentManager,
    'currentInstallation' | 'list' | 'grant' | 'revoke'
  >;
  capabilityBroker: Pick<ModuleServiceCapabilityBroker, 'issue'> | null;
}

const projectParams = z.object({
  projectId: z.string().uuid(),
  installationId: z.string().uuid(),
});
const serviceParams = projectParams.extend({ service: OpenOpcServiceNameSchema });
const consentViewSchema = z.object({
  consent_id: z.string().uuid(),
  installation_id: z.string().uuid(),
  release_id: z.string().uuid(),
  install_revision: z.number().int().positive(),
  service: OpenOpcServiceNameSchema,
  operations: z.array(z.string()),
  consent_digest: z.string(),
  accepted_at: z.string(),
  revoked_at: z.string().nullable(),
});

function consentView(consent: ModuleServiceConsent) {
  return {
    consent_id: consent.consentId,
    installation_id: consent.installationId,
    release_id: consent.releaseId,
    install_revision: consent.installRevision,
    service: consent.service,
    operations: [...consent.operations],
    consent_digest: consent.consentDigest,
    accepted_at: consent.acceptedAt,
    revoked_at: consent.revokedAt,
  };
}

function serviceErrorResponse(context: Context<AppEnv>, error: unknown): Response | null {
  if (error instanceof ModuleServiceCapabilityError) {
    return context.json({ error: error.code }, error.status);
  }
  return null;
}

async function loadAndAuthorize(
  context: Context<AppEnv>,
  dependencies: ModuleServiceProjectRouteDependencies,
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

export function createModuleServiceProjectRoutes(
  dependencies: ModuleServiceProjectRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{projectId}/modules/{installationId}/service-consents',
      tags: ['developer'],
      summary: 'List developer module service consents',
      ...auth,
      request: { params: projectParams },
      responses: {
        200: json(z.object({ consents: z.array(consentViewSchema) }), 'Module service consents'),
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
        PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      );
      if (loaded instanceof Response) return loaded;
      try {
        const consents = await dependencies.consentManager.list({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
        });
        return context.json({ consents: consents.map(consentView) }, 200);
      } catch (error) {
        const response = serviceErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/{projectId}/modules/{installationId}/service-consents/{service}',
      tags: ['developer'],
      summary: 'Grant developer module service consent',
      ...auth,
      request: {
        params: serviceParams,
        body: { content: { 'application/json': { schema: ModuleServiceConsentPutInputSchema } } },
      },
      responses: {
        200: json(z.object({ consent: consentViewSchema }), 'Granted module service consent'),
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
      let body: ModuleServiceConsentPutInput;
      try {
        body = parseModuleServiceConsentPutInput(params.service, context.req.valid('json'));
      } catch {
        return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
      }
      try {
        const consent = await dependencies.consentManager.grant({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
          installRevision: body.expected_install_revision,
          service: params.service,
          operations: body.operations,
          actorUserId: loaded.userId,
        });
        return context.json({ consent: consentView(consent) }, 200);
      } catch (error) {
        const response = serviceErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{projectId}/modules/{installationId}/service-consents/{service}',
      tags: ['developer'],
      summary: 'Revoke developer module service consent',
      ...auth,
      request: {
        params: serviceParams,
        body: {
          content: { 'application/json': { schema: ModuleServiceConsentDeleteInputSchema } },
        },
      },
      responses: {
        200: json(z.object({ ok: z.literal(true) }), 'Revoked module service consent'),
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
      const body = context.req.valid('json');
      try {
        await dependencies.consentManager.revoke({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
          installRevision: body.expected_install_revision,
          service: params.service,
          actorUserId: loaded.userId,
        });
        return context.json({ ok: true }, 200);
      } catch (error) {
        const response = serviceErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{projectId}/modules/{installationId}/service-capabilities',
      tags: ['developer'],
      summary: 'Issue a short-lived developer module service capability',
      ...auth,
      request: {
        params: projectParams,
        body: { content: { 'application/json': { schema: ModuleServiceCapabilityRequestSchema } } },
      },
      responses: {
        201: json(
          z.object({
            token: z.string(),
            expires_at: z.string(),
            grant_id: z.string().uuid(),
          }),
          'Issued module service capability',
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
      if (!dependencies.capabilityBroker) {
        return context.json({ error: 'MODULE_SERVICE_UNAVAILABLE' }, 503);
      }
      const body = context.req.valid('json');
      try {
        const current = await dependencies.consentManager.currentInstallation({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
        });
        const issued = await dependencies.capabilityBroker.issue({
          accountId: loaded.row.accountId,
          projectId: params.projectId,
          installationId: params.installationId,
          installRevision: current.installRevision,
          service: body.service,
          operations: body.operations,
          actorUserId: loaded.userId,
        });
        return context.json(
          {
            token: issued.token,
            expires_at: issued.grant.expiresAt,
            grant_id: issued.grant.grantId,
          },
          201,
        );
      } catch (error) {
        const response = serviceErrorResponse(context, error);
        if (response) return response;
        throw error;
      }
    },
  );

  return app;
}

export function createModuleServicesApp(
  aiDependencies: ModuleAiDependencies = createRuntimeModuleAiDependencies(),
  paymentDependencies: ModulePaymentRouteDependencies = createRuntimeModulePaymentDependencies(),
) {
  const app = makeOpenApiApp<AppEnv>();
  app.route('/ai', createModuleAiRoutes(aiDependencies));
  app.route('/payments', createModulePaymentRoutes(paymentDependencies));
  return app;
}
