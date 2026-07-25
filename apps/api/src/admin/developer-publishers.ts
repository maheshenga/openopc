import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import { DeveloperPublisherSchema } from '../developer/app';
import {
  DEVELOPER_ORGANIZATION_VERIFICATION_STATES,
  DeveloperPublisherError,
  type DeveloperPublisherService,
} from '../developer/publishers';
import { auth, errors, json } from '../openapi';
import type { AppEnv } from '../types';

const InvitationSchema = z.object({
  invitation_id: z.string().uuid(),
  account_id: z.string().uuid(),
  organization_id: z.string().uuid().nullable(),
  email: z.string(),
  state: z.enum(['pending', 'accepted', 'expired', 'revoked']),
  expires_at: z.string(),
  accepted_by: z.string().uuid().nullable(),
  accepted_at: z.string().nullable(),
  revoked_by: z.string().uuid().nullable(),
  revoked_at: z.string().nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
});

const OrganizationSchema = z.object({
  organization_id: z.string().uuid(),
  account_id: z.string().uuid(),
  name: z.string(),
  verification_state: z.enum(DEVELOPER_ORGANIZATION_VERIFICATION_STATES),
  verification_metadata: z.record(z.unknown()),
  verification_revision: z.number().int().nonnegative(),
  verification_changed_by: z.string().uuid().nullable(),
  verification_changed_at: z.string().nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

const InviteBodySchema = z
  .object({
    account_id: z.string().uuid(),
    organization_id: z.string().uuid().optional(),
    organization_name: z.string(),
    email: z.string().email(),
    expires_at: z.string().optional(),
  })
  .strict();

const VerificationBodySchema = z
  .object({
    account_id: z.string().uuid(),
    state: z.enum(['verified', 'rejected', 'suspended']),
    metadata: z.record(z.unknown()).optional(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();

const SuspensionBodySchema = z
  .object({
    account_id: z.string().uuid(),
    reason: z.string(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();

const ReinstatementBodySchema = z
  .object({
    account_id: z.string().uuid(),
    expected_revision: z.number().int().nonnegative(),
  })
  .strict();

export interface AdminDeveloperPublisherRouteDependencies {
  publisherService: Pick<
    DeveloperPublisherService,
    'invite' | 'setVerification' | 'suspend' | 'reinstate'
  >;
}

function actor(context: Context<AppEnv>) {
  return {
    accountId: context.get('accountId') ?? '',
    userId: context.get('userId'),
    email: context.get('userEmail'),
    platformAdmin: true,
  } as const;
}

function errorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperPublisherError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

export function registerAdminDeveloperPublisherRoutes(
  app: OpenAPIHono<AppEnv>,
  dependencies: AdminDeveloperPublisherRouteDependencies,
): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/invitations',
      tags: ['admin', 'developer'],
      summary: 'Invite a developer into a bounded organization',
      ...auth,
      request: {
        body: { required: true, content: { 'application/json': { schema: InviteBodySchema } } },
      },
      responses: {
        201: json(
          z.object({ invitation: InvitationSchema, token: z.string() }),
          'One-time developer invitation',
        ),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      context.set('accountId', body.account_id);
      try {
        const result = await dependencies.publisherService.invite({
          actor: actor(context),
          accountId: body.account_id,
          organizationId: body.organization_id,
          organizationName: body.organization_name,
          email: body.email,
          expiresAt: body.expires_at,
        });
        return context.json(result, 201);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/developer/organizations/{organizationId}/verification',
      tags: ['admin', 'developer'],
      summary: 'Revision-fence developer organization verification',
      ...auth,
      request: {
        params: z.object({ organizationId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: VerificationBodySchema } },
        },
      },
      responses: {
        200: json(OrganizationSchema, 'Organization verification updated'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      context.set('accountId', body.account_id);
      try {
        const organization = await dependencies.publisherService.setVerification({
          actor: actor(context),
          accountId: body.account_id,
          organizationId: context.req.valid('param').organizationId,
          state: body.state,
          metadata: body.metadata,
          expectedRevision: body.expected_revision,
        });
        return context.json(organization, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/publishers/{publisherId}/suspensions',
      tags: ['admin', 'developer'],
      summary: 'Suspend a Publisher with revision fencing',
      ...auth,
      request: {
        params: z.object({ publisherId: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: SuspensionBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperPublisherSchema, 'Publisher suspended'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      context.set('accountId', body.account_id);
      try {
        const publisher = await dependencies.publisherService.suspend({
          actor: actor(context),
          accountId: body.account_id,
          publisherId: context.req.valid('param').publisherId,
          reason: body.reason,
          expectedRevision: body.expected_revision,
        });
        return context.json(publisher, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/publishers/{publisherId}/reinstatements',
      tags: ['admin', 'developer'],
      summary: 'Reinstate a suspended Publisher with revision fencing',
      ...auth,
      request: {
        params: z.object({ publisherId: z.string() }),
        body: {
          required: true,
          content: { 'application/json': { schema: ReinstatementBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperPublisherSchema, 'Publisher reinstated'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      context.set('accountId', body.account_id);
      try {
        const publisher = await dependencies.publisherService.reinstate({
          actor: actor(context),
          accountId: body.account_id,
          publisherId: context.req.valid('param').publisherId,
          expectedRevision: body.expected_revision,
        });
        return context.json(publisher, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );
}
