import { createRoute, z } from '@hono/zod-openapi';
import { validateRegistryItem } from '@kortix/registry';
import type { Context, MiddlewareHandler } from 'hono';

import { ACCOUNT_ACTIONS } from '../iam/actions';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import {
  ReleaseProfileUnavailableError,
  type RestrictedRuntimeCapability,
} from '../release-profile/runtime';
import type { AppEnv } from '../types';
import {
  DEVELOPER_APPLICATION_STATES,
  DeveloperApplicationError,
  type DeveloperApplicationService,
} from './applications';
import { DeveloperModuleArtifactError, type DeveloperModuleArtifactService } from './artifacts';
import {
  DEVELOPER_ORGANIZATION_VERIFICATION_STATES,
  DEVELOPER_PUBLISHER_ROLES,
  DeveloperPublisherError,
  type DeveloperPublisherService,
} from './publishers';
import {
  DEVELOPER_MODULE_RELEASE_STATUSES,
  DEVELOPER_MODULE_REVIEW_REQUIREMENTS,
  DeveloperModuleReleaseError,
  type DeveloperModuleReleaseService,
} from './releases';
import {
  DEVELOPER_MODULE_HUMAN_REQUIREMENTS,
  DeveloperModuleReviewError,
  type DeveloperModuleReviewService,
} from './reviews';
import {
  DeveloperModuleVerificationError,
  type DeveloperModuleVerificationService,
} from './verification';

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

const DeveloperModuleHumanReviewEvidenceSchema = z
  .object({
    requirement: z.enum(DEVELOPER_MODULE_HUMAN_REQUIREMENTS),
    outcome: z.literal('passed'),
    method: z.literal('manual'),
    summary: z.string(),
    observed_at: z.string(),
  })
  .strict();

const DeveloperModuleAutomaticEvidenceSchema = z
  .object({
    requirement: z.enum(['source_scan', 'sandbox_test', 'sdk_contract_test']),
    outcome: z.literal('passed'),
    method: z.literal('system_attestation'),
    run_id: z.string().uuid(),
    evidence_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    policy_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

const DeveloperModuleReviewEvidenceSchema = z.union([
  DeveloperModuleHumanReviewEvidenceSchema,
  DeveloperModuleAutomaticEvidenceSchema,
]);

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

const DeveloperModuleVerificationMutationSchema = z
  .object({ account_id: z.string().uuid().optional() })
  .strict();
const DeveloperModuleTrustQuerySchema = z
  .object({ account_id: z.string().uuid().optional() })
  .strict();
const DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const DeveloperOrganizationSchema = z.object({
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

const DeveloperApplicationPolicyVersionsSchema = z
  .object({
    moduleRules: z.string().min(1).max(64),
    acceptableUse: z.string().min(1).max(64),
  })
  .strict();

export const DeveloperApplicationSchema = z.object({
  application_id: z.string().uuid(),
  account_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  state: z.enum(DEVELOPER_APPLICATION_STATES),
  revision: z.number().int().nonnegative(),
  policy_versions: DeveloperApplicationPolicyVersionsSchema,
  submitted_at: z.string().nullable(),
  decided_at: z.string().nullable(),
  suspended_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  created_by: z.string().uuid(),
  updated_by: z.string().uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const DeveloperApplicationSubmitBodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    organization_name: z.string().min(1).max(255),
    policy_versions: DeveloperApplicationPolicyVersionsSchema,
  })
  .strict();

const DeveloperApplicationCurrentResponseSchema = z.object({
  application: DeveloperApplicationSchema.nullable(),
  current_policy_versions: DeveloperApplicationPolicyVersionsSchema,
});

const DeveloperApplicationSubmitResponseSchema = DeveloperApplicationCurrentResponseSchema.extend({
  application: DeveloperApplicationSchema,
  created: z.boolean(),
});

const DeveloperInvitationSchema = z.object({
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

export const DeveloperPublisherSchema = z.object({
  publisher_id: z.string(),
  account_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  slug: z.string(),
  display_name: z.string(),
  status: z.enum(['active', 'suspended']),
  authority_revision: z.number().int().nonnegative(),
  suspended_reason: z.string().nullable(),
  suspended_by: z.string().uuid().nullable(),
  suspended_at: z.string().nullable(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const DeveloperPublisherMemberSchema = z.object({
  member_id: z.string().uuid(),
  account_id: z.string().uuid(),
  publisher_id: z.string(),
  user_id: z.string().uuid(),
  role: z.enum(DEVELOPER_PUBLISHER_ROLES),
  revision: z.number().int().nonnegative(),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_by: z.string().uuid().nullable(),
  updated_at: z.string(),
});

const DeveloperAccessSchema = z.object({
  account_id: z.string().uuid(),
  user_id: z.string().uuid(),
  organization: DeveloperOrganizationSchema.nullable(),
  invitations: z.array(DeveloperInvitationSchema),
  publishers: z.array(
    z.object({
      publisher: DeveloperPublisherSchema,
      membership: DeveloperPublisherMemberSchema.nullable(),
    }),
  ),
});

const DeveloperAccountQuerySchema = z.object({ account_id: z.string().uuid().optional() }).strict();
const DeveloperInvitationAcceptBodySchema = z
  .object({ account_id: z.string().uuid().optional(), token: z.string().min(1).max(512) })
  .strict();
const DeveloperPublisherCreateBodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    organization_id: z.string().uuid(),
    slug: z.string(),
    display_name: z.string(),
  })
  .strict();
const DeveloperPublisherMemberBodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    role: z.enum(DEVELOPER_PUBLISHER_ROLES),
    expected_revision: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const DeveloperModuleVerificationRunSchema = z.object({
  run_id: z.string().uuid(),
  release_id: z.string().uuid(),
  artifact_id: z.string().uuid(),
  account_id: z.string().uuid(),
  policy_digest: DigestSchema,
  scanner_set_digest: DigestSchema,
  sandbox_profile_digest: DigestSchema,
  attempt: z.number().int().positive(),
  state: z.enum(['queued', 'running', 'passed', 'failed', 'inconclusive', 'cancelled']),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.string().nullable(),
  heartbeat_at: z.string().nullable(),
  terminal_reason: z.string().nullable(),
  sbom_digest: DigestSchema.nullable(),
  attestation_digest: DigestSchema.nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const DeveloperModuleVerificationFindingSchema = z.object({
  finding_id: z.string().uuid(),
  fingerprint: DigestSchema,
  scanner: z.string(),
  rule_id: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
  path: z.string().nullable(),
  location: z.record(z.unknown()).nullable(),
  summary: z.string(),
  disposition: z.enum(['blocking', 'observed']),
  created_at: z.string(),
});

const DeveloperModuleTrustAttestationSchema = z.object({
  attestation_digest: DigestSchema,
  subject_artifact_digest: DigestSchema,
  predicate_type: z.string(),
  policy_digest: DigestSchema,
  result: z.enum(['passed', 'failed', 'inconclusive', 'cancelled']),
  sbom_digest: DigestSchema,
  issuer: z.string(),
  created_at: z.string(),
});

export const DeveloperModuleTrustViewSchema = z.object({
  release_id: z.string().uuid(),
  account_id: z.string().uuid(),
  artifact: z.object({
    artifact_id: z.string().uuid(),
    artifact_digest: DigestSchema,
    media_type: z.string(),
    size_bytes: z.number().int().positive(),
    source_provenance: z.record(z.unknown()).nullable(),
    created_at: z.string(),
  }),
  attempts: z.array(
    z.object({
      run_id: z.string().uuid(),
      attempt: z.number().int().positive(),
      state: z.enum(['queued', 'running', 'passed', 'failed', 'inconclusive', 'cancelled']),
      policy_digest: DigestSchema,
      scanner_set_digest: DigestSchema,
      sandbox_profile_digest: DigestSchema,
      terminal_reason: z.string().nullable(),
      sbom_digest: DigestSchema.nullable(),
      attestation_digest: DigestSchema.nullable(),
      started_at: z.string().nullable(),
      finished_at: z.string().nullable(),
      created_at: z.string(),
      findings: z.array(DeveloperModuleVerificationFindingSchema),
      attestation: DeveloperModuleTrustAttestationSchema.nullable(),
    }),
  ),
});

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
  applicationService: Pick<DeveloperApplicationService, 'submit' | 'current'> & {
    readonly currentPolicyVersions: DeveloperApplicationService['currentPolicyVersions'];
  };
  artifactService: Pick<
    DeveloperModuleArtifactService,
    'createDeclarative' | 'createUpload' | 'finalizeUploadResult' | 'cancelUpload' | 'getArtifact'
  >;
  releaseService: Pick<DeveloperModuleReleaseService, 'submit' | 'list' | 'get'>;
  reviewService: Pick<DeveloperModuleReviewService, 'requestReview' | 'history'>;
  verificationService: Pick<DeveloperModuleVerificationService, 'getTrustView' | 'retryPublisher'>;
  publisherService: Pick<
    DeveloperPublisherService,
    | 'getDeveloperAccess'
    | 'acceptInvitation'
    | 'createPublisher'
    | 'listPublishers'
    | 'setMemberRole'
    | 'auditHistory'
  >;
}>;

function reviewErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (error instanceof DeveloperPublisherError) return publisherErrorResponse(context, error);
  if (!(error instanceof DeveloperModuleReviewError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

function artifactErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (error instanceof ReleaseProfileUnavailableError) {
    return context.json({ code: error.code, capability: error.capability }, error.status);
  }
  if (error instanceof DeveloperPublisherError) return publisherErrorResponse(context, error);
  if (!(error instanceof DeveloperModuleArtifactError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 404) return context.json(body, 404);
  if (error.status === 409) return context.json(body, 409);
  return context.json(body, 503);
}

function verificationErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperModuleVerificationError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

function publisherErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperPublisherError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

function applicationErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperApplicationError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  if (error.status === 409) return context.json(body, 409);
  return context.json(body, 503);
}

function requireApplicationService(dependencies: DeveloperAppDependencies) {
  const service = dependencies.applicationService;
  if (!service) {
    throw new DeveloperApplicationError('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE', 503);
  }
  return service;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function legacyReleaseCapability(value: unknown): RestrictedRuntimeCapability | null {
  const body = objectValue(value);
  if (!body) return null;
  if (
    Object.hasOwn(body, 'artifact_url') ||
    Object.hasOwn(body, 'artifactUrl') ||
    Object.hasOwn(body, 'source_url') ||
    Object.hasOwn(body, 'sourceUrl')
  ) {
    return 'artifact.remote-url';
  }
  if (!Object.hasOwn(body, 'item')) return null;

  const item = objectValue(body.item);
  const module = objectValue(item?.module);
  const runtime = objectValue(item?.runtime) ?? objectValue(module?.runtime);
  if (runtime?.kind === 'oci-image') return 'module.oci.execute';
  return 'artifact.remote-url';
}

async function rejectLegacyReleaseBeforeAuthentication(
  context: Context<AppEnv>,
  next: () => Promise<void>,
) {
  if (context.req.method !== 'POST') return next();
  const contentType = context.req.header('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) return next();
  try {
    const capability = legacyReleaseCapability(await context.req.raw.clone().json());
    if (capability) {
      const error = new ReleaseProfileUnavailableError(capability);
      return context.json({ code: error.code, capability: error.capability }, error.status);
    }
  } catch {
    // Let the request reach the normal JSON validator so malformed bodies retain its response.
  }
  return next();
}

export function createDeveloperApp(dependencies: DeveloperAppDependencies) {
  requireApplicationService(dependencies);
  const app = makeOpenApiApp<AppEnv>();

  app.use('/modules/releases', rejectLegacyReleaseBeforeAuthentication);
  app.use('*', dependencies.authenticate);

  app.openapi(
    createRoute({
      method: 'post',
      path: '/applications',
      tags: ['developer'],
      summary: 'Submit the current account for developer admission',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperApplicationSubmitBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperApplicationSubmitResponseSchema, 'Idempotent developer application'),
        201: json(DeveloperApplicationSubmitResponseSchema, 'Developer application submitted'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const body = context.req.valid('json');
      try {
        const service = requireApplicationService(dependencies);
        const result = await service.submit({
          actor: { accountId, userId: context.get('userId') },
          organizationName: body.organization_name,
          policyVersions: body.policy_versions,
        });
        const response = {
          ...result,
          current_policy_versions: service.currentPolicyVersions,
        };
        return context.json(response, result.created ? 201 : 200);
      } catch (error) {
        return applicationErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/applications/current',
      tags: ['developer'],
      summary: 'Read the current account developer application',
      ...auth,
      request: { query: DeveloperAccountQuerySchema },
      responses: {
        200: json(DeveloperApplicationCurrentResponseSchema, 'Current developer application'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const service = requireApplicationService(dependencies);
        const application = await service.current({
          accountId,
          userId: context.get('userId'),
        });
        return context.json(
          { application, current_policy_versions: service.currentPolicyVersions },
          200,
        );
      } catch (error) {
        return applicationErrorResponse(context, error);
      }
    },
  );

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
      method: 'get',
      path: '/access',
      tags: ['developer'],
      summary: 'Read the current developer organization and Publisher access',
      ...auth,
      request: { query: DeveloperAccountQuerySchema },
      responses: {
        200: json(DeveloperAccessSchema, 'Developer access state'),
        ...errors(400, 401, 403),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      const access = await dependencies.publisherService.getDeveloperAccess({
        accountId,
        userId: context.get('userId'),
        email: context.get('userEmail'),
      });
      return context.json(access, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/invitations/accept',
      tags: ['developer'],
      summary: 'Accept a one-time developer invitation',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperInvitationAcceptBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperInvitationSchema, 'Developer invitation accepted'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        const invitation = await dependencies.publisherService.acceptInvitation(
          context.req.valid('json').token,
          {
            accountId,
            userId: context.get('userId'),
            email: context.get('userEmail'),
          },
        );
        return context.json(invitation, 200);
      } catch (error) {
        return publisherErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/publishers',
      tags: ['developer'],
      summary: 'Create a Publisher for a verified developer organization',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperPublisherCreateBodySchema } },
        },
      },
      responses: {
        201: json(
          z.object({
            publisher: DeveloperPublisherSchema,
            organization: DeveloperOrganizationSchema,
            member: DeveloperPublisherMemberSchema.nullable(),
          }),
          'Publisher created',
        ),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const body = context.req.valid('json');
      try {
        const authority = await dependencies.publisherService.createPublisher({
          actor: {
            accountId,
            userId: context.get('userId'),
            email: context.get('userEmail'),
          },
          organizationId: body.organization_id,
          slug: body.slug,
          displayName: body.display_name,
        });
        return context.json(authority, 201);
      } catch (error) {
        return publisherErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/publishers',
      tags: ['developer'],
      summary: 'List account-scoped Publishers',
      ...auth,
      request: { query: DeveloperAccountQuerySchema },
      responses: {
        200: json(z.object({ publishers: z.array(DeveloperPublisherSchema) }), 'Publishers'),
        ...errors(400, 401, 403),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      const publishers = await dependencies.publisherService.listPublishers({
        accountId,
        userId: context.get('userId'),
        email: context.get('userEmail'),
      });
      return context.json({ publishers: [...publishers] }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'put',
      path: '/publishers/{publisherId}/members/{userId}',
      tags: ['developer'],
      summary: 'Create or revision-fence a Publisher member role',
      ...auth,
      request: {
        params: z.object({ publisherId: z.string(), userId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperPublisherMemberBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperPublisherMemberSchema, 'Publisher member updated'),
        201: json(DeveloperPublisherMemberSchema, 'Publisher member created'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const body = context.req.valid('json');
      const params = context.req.valid('param');
      try {
        const member = await dependencies.publisherService.setMemberRole({
          actor: {
            accountId,
            userId: context.get('userId'),
            email: context.get('userEmail'),
          },
          publisherId: params.publisherId,
          userId: params.userId,
          role: body.role,
          expectedRevision: body.expected_revision,
        });
        return context.json(member, body.expected_revision === null ? 201 : 200);
      } catch (error) {
        return publisherErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases/{releaseId}/trust',
      tags: ['developer'],
      summary: 'Read account-scoped developer module trust evidence',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        query: DeveloperModuleTrustQuerySchema,
      },
      responses: {
        200: json(DeveloperModuleTrustViewSchema, 'Safe developer module trust view'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const view = await dependencies.verificationService.getTrustView({
          accountId,
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json(view, 200);
      } catch (error) {
        return verificationErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/releases/{releaseId}/verification-retries',
      tags: ['developer'],
      summary: 'Retry terminal developer module verification',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleVerificationMutationSchema } },
        },
      },
      responses: {
        201: json(DeveloperModuleVerificationRunSchema, 'Verification retry queued'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        const run = await dependencies.verificationService.retryPublisher({
          accountId,
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json(run, 201);
      } catch (error) {
        return verificationErrorResponse(context, error);
      }
    },
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
          actorUserId: context.get('userId'),
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
        if (error instanceof ReleaseProfileUnavailableError) {
          return context.json({ code: error.code, capability: error.capability }, error.status);
        }
        if (error instanceof DeveloperPublisherError) {
          return publisherErrorResponse(context, error);
        }
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
