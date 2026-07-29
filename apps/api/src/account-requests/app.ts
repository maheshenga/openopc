import { createRoute, z } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';

import { supabaseAuth } from '../middleware/auth';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import { recordAuditEvent } from '../shared/audit';
import { db } from '../shared/db';
import type { AppEnv } from '../types';
import { createDrizzleAccountRequestRepository } from './drizzle';
import {
  type AccountRequestError,
  type AccountRequestRecord,
  createAccountRequestService,
} from './service';

const AccountRequestKindSchema = z.enum([
  'data_export',
  'account_deletion',
  'security_report',
  'module_report',
]);

const AccountRequestStatusSchema = z.enum([
  'pending',
  'cooling_off',
  'processing',
  'completed',
  'cancelled',
  'rejected',
  'expired',
]);

const AccountRequestSchema = z.object({
  request_id: z.string().uuid(),
  account_id: z.string().uuid(),
  requested_by: z.string().uuid(),
  kind: AccountRequestKindSchema,
  status: AccountRequestStatusSchema,
  reason: z.string().nullable(),
  module_installation_id: z.string().uuid().nullable(),
  requested_at: z.string(),
  not_before_at: z.string().nullable(),
  processing_started_at: z.string().nullable(),
  terminal_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  result_metadata: z.record(z.unknown()),
  updated_at: z.string(),
});

const AccountRequestCreateBodySchema = z
  .object({
    account_id: z.string().uuid(),
    kind: AccountRequestKindSchema,
    reason: z.string().min(1).max(4000).optional(),
    module_installation_id: z.string().uuid().optional(),
    idempotency_key: z
      .string()
      .min(16)
      .max(255)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$/),
  })
  .strict();

const AccountRequestScopeQuerySchema = z.object({ account_id: z.string().uuid() }).strict();

function responseRecord(record: AccountRequestRecord) {
  return {
    request_id: record.requestId,
    account_id: record.accountId,
    requested_by: record.requestedBy,
    kind: record.kind,
    status: record.status,
    reason: record.reason,
    module_installation_id: record.moduleInstallationId,
    requested_at: record.requestedAt,
    not_before_at: record.notBeforeAt,
    processing_started_at: record.processingStartedAt,
    terminal_at: record.terminalAt,
    expires_at: record.expiresAt,
    result_metadata: record.resultMetadata,
    updated_at: record.updatedAt,
  };
}

function serviceErrorResponse(context: Context<AppEnv>, error: AccountRequestError) {
  const body = {
    error: true as const,
    code: error.code,
    message: error.message,
  };
  switch (error.code) {
    case 'ACCOUNT_REQUEST_INPUT_INVALID':
      return context.json({ ...body, status: 400 }, 400);
    case 'ACCOUNT_REQUEST_NOT_FOUND':
      return context.json({ ...body, status: 404 }, 404);
    case 'ACCOUNT_REQUEST_IDEMPOTENCY_CONFLICT':
    case 'ACCOUNT_REQUEST_NOT_CANCELLABLE':
      return context.json({ ...body, status: 409 }, 409);
    case 'ACCOUNT_REQUEST_DEPENDENCY_UNAVAILABLE':
      return context.json({ ...body, status: 503 }, 503);
  }
}

type AccountRequestService = ReturnType<typeof createAccountRequestService>;

export interface AccountRequestsAppDependencies {
  service: AccountRequestService;
  authenticate?: MiddlewareHandler<AppEnv>;
}

export function createAccountRequestsApp(dependencies: AccountRequestsAppDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', dependencies.authenticate ?? supabaseAuth);

  app.openapi(
    createRoute({
      method: 'post',
      path: '/requests',
      tags: ['account'],
      summary: 'Create an account-owned export, deletion, security, or module request',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: AccountRequestCreateBodySchema } },
        },
      },
      responses: {
        200: json(
          z.object({ request: AccountRequestSchema, created: z.literal(false) }),
          'Existing idempotent account request',
        ),
        201: json(
          z.object({ request: AccountRequestSchema, created: z.literal(true) }),
          'Account request created',
        ),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      if (context.get('authType') !== 'supabase') {
        return context.json(
          { error: true, code: 'ACCOUNT_REQUEST_NOT_FOUND', message: 'Not found', status: 403 },
          403,
        );
      }
      const body = context.req.valid('json');
      context.set('accountId', body.account_id);
      const result = await dependencies.service.create(
        {
          kind: body.kind,
          reason: body.reason,
          moduleInstallationId: body.module_installation_id,
          idempotencyKey: body.idempotency_key,
        },
        { accountId: body.account_id, userId: context.get('userId') },
      );
      if (!result.success) return serviceErrorResponse(context, result.error);
      const response = {
        request: responseRecord(result.data.request),
        created: result.data.created,
      };
      return result.data.created
        ? context.json({ ...response, created: true as const }, 201)
        : context.json({ ...response, created: false as const }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/requests',
      tags: ['account'],
      summary: 'List account requests owned by the authenticated member',
      ...auth,
      request: { query: AccountRequestScopeQuerySchema },
      responses: {
        200: json(z.object({ requests: z.array(AccountRequestSchema) }), 'Owned account requests'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      if (context.get('authType') !== 'supabase') {
        return context.json(
          { error: true, code: 'ACCOUNT_REQUEST_NOT_FOUND', message: 'Not found', status: 403 },
          403,
        );
      }
      const accountId = context.req.valid('query').account_id;
      context.set('accountId', accountId);
      const result = await dependencies.service.list({
        accountId,
        userId: context.get('userId'),
      });
      if (!result.success) return serviceErrorResponse(context, result.error);
      return context.json({ requests: result.data.requests.map(responseRecord) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/requests/{requestId}/cancel',
      tags: ['account'],
      summary: 'Cancel an owned account request before processing starts',
      ...auth,
      request: {
        params: z.object({ requestId: z.string().uuid() }),
        body: {
          required: true,
          content: {
            'application/json': { schema: AccountRequestScopeQuerySchema },
          },
        },
      },
      responses: {
        200: json(z.object({ request: AccountRequestSchema }), 'Account request cancelled'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      if (context.get('authType') !== 'supabase') {
        return context.json(
          { error: true, code: 'ACCOUNT_REQUEST_NOT_FOUND', message: 'Not found', status: 403 },
          403,
        );
      }
      const accountId = context.req.valid('json').account_id;
      context.set('accountId', accountId);
      const result = await dependencies.service.cancel(context.req.valid('param').requestId, {
        accountId,
        userId: context.get('userId'),
      });
      if (!result.success) return serviceErrorResponse(context, result.error);
      return context.json({ request: responseRecord(result.data.request) }, 200);
    },
  );

  return app;
}

export const accountRequestsApp = createAccountRequestsApp({
  service: createAccountRequestService({
    repository: createDrizzleAccountRequestRepository(db),
    recordAuditEvent,
  }),
});
