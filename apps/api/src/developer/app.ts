import { createRoute, z } from '@hono/zod-openapi';
import { validateRegistryItem } from '@kortix/registry';
import type { Context, MiddlewareHandler } from 'hono';

import { ACCOUNT_ACTIONS } from '../iam/actions';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { DeveloperModuleArtifactError, type DeveloperModuleArtifactService } from './artifacts';
import {
  DEVELOPER_MODULE_RELEASE_STATUSES,
  DEVELOPER_MODULE_REVIEW_REQUIREMENTS,
  DeveloperModuleReleaseError,
  type DeveloperModuleReleaseService,
} from './releases';
import { DeveloperModuleReviewError, type DeveloperModuleReviewService } from './reviews';

const RegistryValidationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
});

const RegistryValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(RegistryValidationIssueSchema),
});

const RegistryItemBodySchema = z.record(z.unknown());

const DeveloperModuleReleaseSchema = z.object({
  release_id: z.string().uuid(),
  account_id: z.string().uuid(),
  item_name: z.string(),
  publisher_id: z.string(),
  module_id: z.string(),
  module_version: z.string(),
  manifest: z.record(z.unknown()),
  manifest_digest: z.string(),
  artifact_id: z.string().uuid().nullable(),
  artifact_digest: z.string().nullable(),
  sbom_digest: z.string().nullable(),
  trust_attestation_digest: z.string().nullable(),
  verification_policy_digest: z.string().nullable(),
  review_requirements: z.array(z.enum(DEVELOPER_MODULE_REVIEW_REQUIREMENTS)),
  status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  review_revision: z.number().int().min(0),
  signature_algorithm: z.literal('ed25519').nullable(),
  signature_key_id: z.string().nullable(),
  signature: z.string().nullable(),
  signature_payload_digest: z.string().nullable(),
  signed_at: z.string().nullable(),
  published_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

const DeveloperModuleReleaseSubmissionSchema = z.object({
  created: z.boolean(),
  release: DeveloperModuleReleaseSchema,
});

const DeveloperModuleReleaseListSchema = z.object({
  releases: z.array(DeveloperModuleReleaseSchema),
});

const DeveloperModuleReleaseBodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    artifact_id: z.string().uuid().optional(),
    item: z.unknown().optional(),
  })
  .strict();

const DeveloperModuleArtifactSchema = z.object({
  artifact_id: z.string().uuid(),
  account_id: z.string().uuid(),
  publisher_id: z.string(),
  artifact_digest: z.string(),
  envelope_digest: z.string(),
  media_type: z.literal('application/vnd.openopc.developer-module.v2+json'),
  size_bytes: z.number().int().positive(),
  item_snapshot: z.record(z.unknown()),
  source_provenance: z.record(z.unknown()).nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
});

const DeveloperModuleDeclarativeArtifactBodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    item: z.record(z.unknown()),
  })
  .strict();

const DeveloperModuleArtifactUploadBodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    publisher_id: z.string(),
    expected_size: z.number().int().positive(),
    expected_digest: z.string(),
  })
  .strict();

const DeveloperModuleArtifactUploadTicketSchema = z.object({
  upload_id: z.string().uuid(),
  state: z.literal('created'),
  expected_digest: z.string(),
  expected_size: z.number().int().positive(),
  upload_url: z.string(),
  headers: z.record(z.string()),
  expires_at: z.string(),
});

const DeveloperModuleArtifactMutationBodySchema = z
  .object({ account_id: z.string().uuid().optional() })
  .strict();

const DeveloperModuleArtifactQuerySchema = z
  .object({ account_id: z.string().uuid().optional() })
  .strict();

const DeveloperModuleReleaseQuerySchema = z.object({
  account_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const DeveloperModuleReviewEvidenceSchema = z
  .object({
    requirement: z.enum(DEVELOPER_MODULE_REVIEW_REQUIREMENTS),
    outcome: z.literal('passed'),
    method: z.literal('manual'),
    summary: z.string(),
    observed_at: z.string(),
    tool: z.string().optional(),
    tool_version: z.string().optional(),
    evidence_digest: z.string().optional(),
  })
  .strict();

const DeveloperModuleReviewEventSchema = z.object({
  review_event_id: z.string().uuid(),
  release_id: z.string().uuid(),
  account_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  action: z.enum(['submit', 'resubmit', 'request_changes', 'approve', 'revoke']),
  from_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  to_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  actor_user_id: z.string().uuid(),
  actor_kind: z.enum(['publisher', 'platform_admin']),
  reason: z.string().nullable(),
  evidence: z.array(DeveloperModuleReviewEvidenceSchema),
  created_at: z.string(),
});

const DeveloperModuleReviewTransitionSchema = z.object({
  release: DeveloperModuleReleaseSchema,
  event: DeveloperModuleReviewEventSchema,
});

const DeveloperModuleReviewHistorySchema = z.object({
  history: z.array(DeveloperModuleReviewEventSchema),
});

const DeveloperModuleReviewRequestSchema = z
  .object({
    account_id: z.string().uuid().optional(),
    expected_status: z.enum(['validated', 'changes_requested']),
    expected_revision: z.number().int().min(0),
    reason: z.string().max(4_000).optional(),
  })
  .strict();

const DeveloperModuleReviewHistoryQuerySchema = z
  .object({ account_id: z.string().uuid().optional() })
  .strict();

type DeveloperAccountAction =
  | typeof ACCOUNT_ACTIONS.ACCOUNT_READ
  | typeof ACCOUNT_ACTIONS.ACCOUNT_WRITE;

export type DeveloperAppDependencies = Readonly<{
  authenticate: MiddlewareHandler<AppEnv>;
  resolveAccountId: (context: Context<AppEnv>, source: 'body' | 'query') => Promise<string>;
  authorizeAccount: (
    context: Context<AppEnv>,
    accountId: string,
    action: DeveloperAccountAction,
  ) => Promise<void>;
  artifactService: Pick<
    DeveloperModuleArtifactService,
    'createDeclarative' | 'createUpload' | 'finalizeUploadResult' | 'cancelUpload' | 'getArtifact'
  >;
  releaseService: Pick<DeveloperModuleReleaseService, 'submit' | 'list' | 'get'>;
  reviewService: Pick<DeveloperModuleReviewService, 'requestReview' | 'history'>;
}>;

function reviewErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperModuleReviewError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

function artifactErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperModuleArtifactError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 404) return context.json(body, 404);
  if (error.status === 409) return context.json(body, 409);
  return context.json(body, 503);
}

export function createDeveloperApp(dependencies: DeveloperAppDependencies) {
  const app = makeOpenApiApp<AppEnv>();

  app.use('*', dependencies.authenticate);
  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/validate',
      tags: ['developer'],
      summary: 'Validate a developer module registry item',
      ...auth,
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: RegistryItemBodySchema },
          },
        },
      },
      responses: {
        200: json(RegistryValidationResultSchema, 'Module validation result'),
        ...errors(400, 401),
      },
    }),
    (context) => context.json(validateRegistryItem(context.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/artifacts/declarative',
      tags: ['developer'],
      summary: 'Create a canonical declarative developer module artifact',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleDeclarativeArtifactBodySchema } },
        },
      },
      responses: {
        201: json(DeveloperModuleArtifactSchema, 'Declarative artifact created'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        const artifact = await dependencies.artifactService.createDeclarative({
          accountId,
          actorUserId: context.get('userId'),
          item: context.req.valid('json').item,
        });
        return context.json(artifact, 201);
      } catch (error) {
        return artifactErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/artifact-uploads',
      tags: ['developer'],
      summary: 'Create a bounded developer module artifact upload',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleArtifactUploadBodySchema } },
        },
      },
      responses: {
        201: json(DeveloperModuleArtifactUploadTicketSchema, 'Artifact upload created'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const body = context.req.valid('json');
      try {
        const upload = await dependencies.artifactService.createUpload({
          accountId,
          publisherId: body.publisher_id,
          expectedSize: body.expected_size,
          expectedDigest: body.expected_digest as `sha256:${string}`,
          actorUserId: context.get('userId'),
        });
        return context.json(upload, 201);
      } catch (error) {
        return artifactErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/artifact-uploads/{uploadId}/finalize',
      tags: ['developer'],
      summary: 'Finalize and validate a developer module artifact upload',
      ...auth,
      request: {
        params: z.object({ uploadId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleArtifactMutationBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperModuleArtifactSchema, 'Idempotent finalized artifact'),
        201: json(DeveloperModuleArtifactSchema, 'Artifact finalized'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        const result = await dependencies.artifactService.finalizeUploadResult({
          accountId,
          uploadId: context.req.valid('param').uploadId,
          actorUserId: context.get('userId'),
        });
        return context.json(result.artifact, result.created ? 201 : 200);
      } catch (error) {
        return artifactErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/modules/artifact-uploads/{uploadId}',
      tags: ['developer'],
      summary: 'Cancel a developer module artifact upload',
      ...auth,
      request: {
        params: z.object({ uploadId: z.string().uuid() }),
        query: DeveloperModuleArtifactQuerySchema,
      },
      responses: {
        204: { description: 'Artifact upload cancelled' },
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        await dependencies.artifactService.cancelUpload({
          accountId,
          uploadId: context.req.valid('param').uploadId,
        });
        return context.body(null, 204);
      } catch (error) {
        return artifactErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/artifacts/{artifactId}',
      tags: ['developer'],
      summary: 'Read account-scoped developer module artifact metadata',
      ...auth,
      request: {
        params: z.object({ artifactId: z.string().uuid() }),
        query: DeveloperModuleArtifactQuerySchema,
      },
      responses: {
        200: json(DeveloperModuleArtifactSchema, 'Developer module artifact'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const artifact = await dependencies.artifactService.getArtifact({
          accountId,
          artifactId: context.req.valid('param').artifactId,
        });
        return context.json(artifact, 200);
      } catch (error) {
        return artifactErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/releases',
      tags: ['developer'],
      summary: 'Submit an immutable validated developer module release',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleReleaseBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperModuleReleaseSubmissionSchema, 'Idempotent existing release'),
        201: json(DeveloperModuleReleaseSubmissionSchema, 'Validated release created'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        const body = context.req.valid('json');
        if (!body.artifact_id || body.item !== undefined) {
          return context.json({ error: 'DEVELOPER_RELEASE_ARTIFACT_REQUIRED' }, 400);
        }
        const result = await dependencies.releaseService.submit({
          accountId,
          actorUserId: context.get('userId'),
          artifactId: body.artifact_id,
        });
        return context.json(result, result.created ? 201 : 200);
      } catch (error) {
        if (error instanceof DeveloperModuleArtifactError) {
          return artifactErrorResponse(context, error);
        }
        if (!(error instanceof DeveloperModuleReleaseError)) throw error;
        const body = { error: error.code };
        if (error.status === 400) return context.json(body, 400);
        return context.json(body, 409);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases',
      tags: ['developer'],
      summary: 'List account-scoped developer module releases',
      ...auth,
      request: { query: DeveloperModuleReleaseQuerySchema },
      responses: {
        200: json(DeveloperModuleReleaseListSchema, 'Developer module releases'),
        ...errors(400, 401, 403),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      const query = context.req.valid('query');
      const releases = await dependencies.releaseService.list({ accountId, limit: query.limit });
      return context.json({ releases: [...releases] }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases/{releaseId}',
      tags: ['developer'],
      summary: 'Read one account-scoped developer module release',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        query: z.object({ account_id: z.string().uuid().optional() }),
      },
      responses: {
        200: json(DeveloperModuleReleaseSchema, 'Developer module release'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const release = await dependencies.releaseService.get({
          accountId,
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json(release, 200);
      } catch (error) {
        if (!(error instanceof DeveloperModuleReleaseError)) throw error;
        return context.json({ error: error.code }, 404);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/releases/{releaseId}/review-requests',
      tags: ['developer'],
      summary: 'Request or resubmit a developer module release for platform review',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleReviewRequestSchema } },
        },
      },
      responses: {
        201: json(DeveloperModuleReviewTransitionSchema, 'Review request recorded'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const body = context.req.valid('json');
      try {
        const transition = await dependencies.reviewService.requestReview({
          accountId,
          releaseId: context.req.valid('param').releaseId,
          actorUserId: context.get('userId'),
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
          reason: body.reason,
        });
        return context.json(transition, 201);
      } catch (error) {
        return reviewErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases/{releaseId}/review-history',
      tags: ['developer'],
      summary: 'Read immutable developer module review history',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        query: DeveloperModuleReviewHistoryQuerySchema,
      },
      responses: {
        200: json(DeveloperModuleReviewHistorySchema, 'Chronological review history'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const history = await dependencies.reviewService.history({
          accountId,
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json({ history: [...history] }, 200);
      } catch (error) {
        if (error instanceof DeveloperModuleReviewError && error.status === 404) {
          return context.json({ error: error.code }, 404);
        }
        throw error;
      }
    },
  );

  return app;
}
