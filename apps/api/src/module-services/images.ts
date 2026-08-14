import {
  type ModuleServiceCapabilityClaimsV1,
  type ModuleServiceErrorCode,
  OPENOPC_IMAGE_ASSET_MAX_BYTES,
  OPENOPC_IMAGE_MIME_TYPES,
  type OpenOpcImageAsset,
  type OpenOpcImageAssetCreateMetadata,
  OpenOpcImageAssetCreateMetadataSchema,
  type OpenOpcImageAssetDeleteResult,
  OpenOpcImageAssetDeleteResultSchema,
  type OpenOpcImageAssetListInput,
  OpenOpcImageAssetListInputSchema,
  type OpenOpcImageAssetPage,
  OpenOpcImageAssetPageSchema,
  type OpenOpcImageAssetPreview,
  OpenOpcImageAssetPreviewSchema,
  OpenOpcImageAssetSchema,
  type OpenOpcImageAssetThumbnail,
  OpenOpcImageAssetThumbnailInputSchema,
  OpenOpcImageAssetThumbnailSchema,
  type OpenOpcImageEstimate,
  type OpenOpcImageEstimateCreateInput,
  OpenOpcImageEstimateCreateInputSchema,
  OpenOpcImageEstimateSchema,
  type OpenOpcImageJob,
  type OpenOpcImageJobCreateInput,
  OpenOpcImageJobCreateInputSchema,
  type OpenOpcImageJobEventPage,
  OpenOpcImageJobEventPageSchema,
  type OpenOpcImageJobListInput,
  OpenOpcImageJobListInputSchema,
  type OpenOpcImageJobPage,
  OpenOpcImageJobPageSchema,
  OpenOpcImageJobSchema,
  type OpenOpcImageModelListResponse,
  OpenOpcImageModelListResponseSchema,
  type OpenOpcImagePageInput,
  OpenOpcImagePageInputSchema,
} from '@kortix/api-contract';
import { Hono } from 'hono';
import { z } from 'zod';

import {
  ReleaseProfileUnavailableError,
  type RuntimeReleaseProfile,
  assertRuntimeCapability,
} from '../release-profile/runtime';
import type { AppEnv } from '../types';
import {
  ModuleServiceCapabilityError,
  type ModuleServiceCapabilityRepository,
  isModuleServiceAuthorizationValid,
} from './capability-grants';

const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_METADATA_JSON_BYTES = 16 * 1024;
const ResourceIdSchema = z.string().uuid();
const RetentionRequestSchema = z.object({ policy: z.enum(['temporary', 'retained']) }).strict();

export type ModuleServiceAuthorization = NonNullable<
  Awaited<ReturnType<ModuleServiceCapabilityRepository['getAuthorization']>>
>;

export type ModuleImageScope = {
  claims: Extract<ModuleServiceCapabilityClaimsV1, { service: 'ai' }>;
  actorUserId: string;
};

export type ModuleImageAssetUpload = {
  bytes: Uint8Array;
  mimeType: (typeof OPENOPC_IMAGE_MIME_TYPES)[number];
  filename: string;
  metadata: Record<string, unknown>;
  retention: OpenOpcImageAssetCreateMetadata['retention'];
};

export type ModuleImageAssetDownload = {
  bytes: Uint8Array;
  mimeType: (typeof OPENOPC_IMAGE_MIME_TYPES)[number];
  filename: string;
};

export type ModuleImageAssetListPage = Required<Pick<OpenOpcImagePageInput, 'cursor' | 'limit'>> &
  Pick<OpenOpcImageAssetListInput, 'source_job_id' | 'source' | 'created_after' | 'created_before'>;

export type ModuleImageJobListPage = Required<Pick<OpenOpcImagePageInput, 'cursor' | 'limit'>> &
  Pick<OpenOpcImageJobListInput, 'status' | 'created_after' | 'created_before'>;

export interface ModuleImageBackend {
  listModels(scope: ModuleImageScope): Promise<OpenOpcImageModelListResponse>;
  createEstimate(
    scope: ModuleImageScope,
    input: OpenOpcImageEstimateCreateInput,
  ): Promise<OpenOpcImageEstimate>;
  createJob(
    scope: ModuleImageScope,
    input: OpenOpcImageJobCreateInput,
  ): Promise<{ job: OpenOpcImageJob; created: boolean }>;
  listJobs(scope: ModuleImageScope, page: ModuleImageJobListPage): Promise<OpenOpcImageJobPage>;
  getJob(scope: ModuleImageScope, jobId: string): Promise<OpenOpcImageJob>;
  listEvents(
    scope: ModuleImageScope,
    jobId: string,
    page: Required<Pick<OpenOpcImagePageInput, 'cursor' | 'limit'>>,
  ): Promise<OpenOpcImageJobEventPage>;
  listJobOutputs(
    scope: ModuleImageScope,
    jobId: string,
    page: Required<Pick<OpenOpcImagePageInput, 'cursor' | 'limit'>>,
  ): Promise<OpenOpcImageAssetPage>;
  cancelJob(scope: ModuleImageScope, jobId: string): Promise<OpenOpcImageJob>;
  createAsset(scope: ModuleImageScope, input: ModuleImageAssetUpload): Promise<OpenOpcImageAsset>;
  listAssets(
    scope: ModuleImageScope,
    page: ModuleImageAssetListPage,
  ): Promise<OpenOpcImageAssetPage>;
  previewAsset(scope: ModuleImageScope, assetId: string): Promise<OpenOpcImageAssetPreview>;
  thumbnailAsset(
    scope: ModuleImageScope,
    assetId: string,
    preset: 'small' | 'medium' | 'large',
  ): Promise<OpenOpcImageAssetThumbnail>;
  downloadAsset(scope: ModuleImageScope, assetId: string): Promise<ModuleImageAssetDownload>;
  deleteAsset?(scope: ModuleImageScope, assetId: string): Promise<OpenOpcImageAssetDeleteResult>;
  setAssetRetention?(
    scope: ModuleImageScope,
    assetId: string,
    policy: 'temporary' | 'retained',
  ): Promise<OpenOpcImageAsset>;
}

export interface ModuleImageDependencies {
  runtime: RuntimeReleaseProfile;
  requireCapability(
    authorization: string | undefined,
    operation: 'image.generate',
  ): Promise<ModuleServiceCapabilityClaimsV1>;
  loadAuthorization(grantId: string): Promise<ModuleServiceAuthorization | null>;
  backend: ModuleImageBackend | null;
  now?: () => Date;
}

export class ModuleImageError extends Error {
  constructor(
    readonly code: ModuleServiceErrorCode,
    readonly status: number,
  ) {
    super(code);
    this.name = 'ModuleImageError';
  }
}

export function createModuleImageRoutes(dependencies: ModuleImageDependencies) {
  const app = new Hono<AppEnv>();

  app.get('/models', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) =>
      parseBackendResponse(OpenOpcImageModelListResponseSchema, await backend.listModels(scope)),
    ),
  );

  app.post('/estimates', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const input = await parseJsonBody(context.req.raw, OpenOpcImageEstimateCreateInputSchema);
      return parseBackendResponse(
        OpenOpcImageEstimateSchema,
        await backend.createEstimate(scope, input),
      );
    }),
  );

  app.post('/jobs', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const input = await parseJsonBody(context.req.raw, OpenOpcImageJobCreateInputSchema);
      if (context.req.header('idempotency-key') !== input.idempotency_key) {
        throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
      }
      const result = await backend.createJob(scope, input);
      return {
        payload: parseBackendResponse(OpenOpcImageJobSchema, result.job),
        status: result.created ? 201 : 200,
      };
    }),
  );

  app.get('/jobs', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const page = parseJobPage(
        context.req.query('cursor'),
        context.req.query('limit'),
        context.req.query('status'),
        context.req.query('created_after'),
        context.req.query('created_before'),
      );
      return parseBackendResponse(OpenOpcImageJobPageSchema, await backend.listJobs(scope, page));
    }),
  );

  app.get('/jobs/:jobId', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const jobId = parseResourceId(context.req.param('jobId'));
      return parseBackendResponse(OpenOpcImageJobSchema, await backend.getJob(scope, jobId));
    }),
  );

  app.get('/jobs/:jobId/events', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const jobId = parseResourceId(context.req.param('jobId'));
      const page = parsePage(context.req.query('cursor'), context.req.query('limit'));
      return parseBackendResponse(
        OpenOpcImageJobEventPageSchema,
        await backend.listEvents(scope, jobId, page),
      );
    }),
  );

  app.get('/jobs/:jobId/outputs', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const jobId = parseResourceId(context.req.param('jobId'));
      const page = parsePage(context.req.query('cursor'), context.req.query('limit'));
      return parseBackendResponse(
        OpenOpcImageAssetPageSchema,
        await backend.listJobOutputs(scope, jobId, page),
      );
    }),
  );

  app.post('/jobs/:jobId/cancel', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const jobId = parseResourceId(context.req.param('jobId'));
      return parseBackendResponse(OpenOpcImageJobSchema, await backend.cancelJob(scope, jobId));
    }),
  );

  app.post('/assets', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      rejectOversizedMultipart(context.req.header('content-length'));
      let form: FormData;
      try {
        form = await context.req.raw.formData();
      } catch {
        throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
      }
      const file = form.get('file');
      if (!(file instanceof Blob)) {
        throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
      }
      const mimeType = file.type.split(';')[0]?.trim().toLowerCase();
      if (
        file.size < 1 ||
        file.size > OPENOPC_IMAGE_ASSET_MAX_BYTES ||
        !OPENOPC_IMAGE_MIME_TYPES.includes(mimeType as (typeof OPENOPC_IMAGE_MIME_TYPES)[number])
      ) {
        throw new ModuleImageError(
          file.size > OPENOPC_IMAGE_ASSET_MAX_BYTES
            ? 'OPENOPC_IMAGE_ASSET_TOO_LARGE'
            : 'OPENOPC_IMAGE_ASSET_INVALID',
          file.size > OPENOPC_IMAGE_ASSET_MAX_BYTES ? 413 : 400,
        );
      }
      const filenameValue = form.get('filename');
      const filename =
        typeof filenameValue === 'string' && filenameValue.trim()
          ? filenameValue
          : file instanceof File
            ? file.name
            : '';
      const metadata = parseMetadata(form.get('metadata'));
      const retentionValue = form.get('retention');
      const parsedMetadata = OpenOpcImageAssetCreateMetadataSchema.safeParse({
        filename,
        metadata,
        ...(typeof retentionValue === 'string' && retentionValue
          ? { retention: retentionValue }
          : {}),
      });
      if (!parsedMetadata.success) {
        throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
      }
      const asset = await backend.createAsset(scope, {
        bytes: new Uint8Array(await file.arrayBuffer()),
        mimeType: mimeType as ModuleImageAssetUpload['mimeType'],
        filename: parsedMetadata.data.filename,
        metadata: parsedMetadata.data.metadata ?? {},
        retention: parsedMetadata.data.retention,
      });
      return { payload: parseBackendResponse(OpenOpcImageAssetSchema, asset), status: 201 };
    }),
  );

  app.get('/assets', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const page = parseAssetPage(
        context.req.query('cursor'),
        context.req.query('limit'),
        context.req.query('source_job_id'),
        context.req.query('source'),
        context.req.query('created_after'),
        context.req.query('created_before'),
      );
      return parseBackendResponse(
        OpenOpcImageAssetPageSchema,
        await backend.listAssets(scope, page),
      );
    }),
  );

  app.get('/assets/:assetId/preview-url', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const assetId = parseResourceId(context.req.param('assetId'));
      return parseBackendResponse(
        OpenOpcImageAssetPreviewSchema,
        await backend.previewAsset(scope, assetId),
      );
    }),
  );

  app.get('/assets/:assetId/thumbnail-url', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      const assetId = parseResourceId(context.req.param('assetId'));
      const parsed = OpenOpcImageAssetThumbnailInputSchema.safeParse({
        ...(context.req.query('preset') ? { preset: context.req.query('preset') } : {}),
      });
      if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
      return parseBackendResponse(
        OpenOpcImageAssetThumbnailSchema,
        await backend.thumbnailAsset(scope, assetId, parsed.data.preset ?? 'medium'),
      );
    }),
  );

  app.get('/assets/:assetId/download', async (context) => {
    try {
      const { scope, backend } = await authorize(context.req.header('authorization'), dependencies);
      const assetId = parseResourceId(context.req.param('assetId'));
      const download = await backend.downloadAsset(scope, assetId);
      if (
        !(download.bytes instanceof Uint8Array) ||
        download.bytes.byteLength < 1 ||
        download.bytes.byteLength > OPENOPC_IMAGE_ASSET_MAX_BYTES ||
        !OPENOPC_IMAGE_MIME_TYPES.includes(download.mimeType) ||
        !download.filename ||
        download.filename.length > 255
      ) {
        throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 500);
      }
      const responseBytes = Uint8Array.from(download.bytes);
      return new Response(responseBytes.buffer, {
        status: 200,
        headers: {
          'content-type': download.mimeType,
          'content-length': String(download.bytes.byteLength),
          'content-disposition': `attachment; filename="${safeFilename(download.filename)}"`,
          'cache-control': 'private, no-store',
        },
      });
    } catch (error) {
      return moduleImageErrorResponse(error);
    }
  });

  app.post('/assets/:assetId/delete', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      if (!backend.deleteAsset) throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 501);
      const assetId = parseResourceId(context.req.param('assetId'));
      return parseBackendResponse(
        OpenOpcImageAssetDeleteResultSchema,
        await backend.deleteAsset(scope, assetId),
      );
    }),
  );

  app.post('/assets/:assetId/retention', (context) =>
    executeJson(context.req.header('authorization'), dependencies, async (scope, backend) => {
      if (!backend.setAssetRetention) {
        throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 501);
      }
      const assetId = parseResourceId(context.req.param('assetId'));
      const body = await parseJsonBody(context.req.raw, RetentionRequestSchema);
      return parseBackendResponse(
        OpenOpcImageAssetSchema,
        await backend.setAssetRetention(scope, assetId, body.policy),
      );
    }),
  );

  return app;
}

async function executeJson(
  authorization: string | undefined,
  dependencies: ModuleImageDependencies,
  operation: (
    scope: ModuleImageScope,
    backend: ModuleImageBackend,
  ) => Promise<unknown | { payload: unknown; status: number }>,
): Promise<Response> {
  try {
    const { scope, backend } = await authorize(authorization, dependencies);
    const result = await operation(scope, backend);
    if (isStatusResult(result)) return jsonResponse(result.payload, result.status);
    return jsonResponse(result, 200);
  } catch (error) {
    return moduleImageErrorResponse(error);
  }
}

async function authorize(
  authorizationHeader: string | undefined,
  dependencies: ModuleImageDependencies,
): Promise<{ scope: ModuleImageScope; backend: ModuleImageBackend }> {
  assertRuntimeCapability('module.ai.gateway', dependencies.runtime);
  assertRuntimeCapability('studio.image.generate', dependencies.runtime);
  const claims = await dependencies.requireCapability(authorizationHeader, 'image.generate');
  if (claims.service !== 'ai' || !claims.operations.includes('image.generate')) {
    throw new ModuleImageError('MODULE_SERVICE_OPERATION_DENIED', 403);
  }
  const authorization = await dependencies.loadAuthorization(claims.grantId);
  if (
    !authorization ||
    !authorizationMatchesClaims(authorization, claims) ||
    !isModuleServiceAuthorizationValid({
      authorization,
      accountId: claims.accountId,
      projectId: claims.projectId,
      service: 'ai',
      operation: 'image.generate',
      now: (dependencies.now ?? (() => new Date()))(),
    }) ||
    !ResourceIdSchema.safeParse(authorization.consent.acceptedBy).success
  ) {
    throw new ModuleImageError('MODULE_SERVICE_CAPABILITY_REVOKED', 403);
  }
  if (!dependencies.backend) {
    throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
  }
  return {
    scope: {
      claims,
      actorUserId: authorization.consent.acceptedBy,
    },
    backend: dependencies.backend,
  };
}

function authorizationMatchesClaims(
  authorization: ModuleServiceAuthorization,
  claims: Extract<ModuleServiceCapabilityClaimsV1, { service: 'ai' }>,
): boolean {
  return (
    authorization.grant.grantId === claims.grantId &&
    authorization.grant.consentId === claims.consentId &&
    authorization.grant.installationId === claims.installationId &&
    authorization.grant.releaseId === claims.releaseId &&
    authorization.consent.consentId === claims.consentId &&
    authorization.consent.installRevision === claims.installRevision &&
    authorization.installation.installationId === claims.installationId &&
    authorization.installation.releaseId === claims.releaseId &&
    authorization.installation.installRevision === claims.installRevision &&
    authorization.installation.moduleId === claims.moduleId &&
    authorization.installation.moduleVersion === claims.moduleVersion
  );
}

function parseResourceId(value: string): string {
  const parsed = ResourceIdSchema.safeParse(value);
  if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
  return parsed.data;
}

function parsePage(
  cursor: string | undefined,
  rawLimit: string | undefined,
): Required<Pick<OpenOpcImagePageInput, 'cursor' | 'limit'>> {
  const numericLimit = rawLimit === undefined ? 100 : Number(rawLimit);
  const parsed = OpenOpcImagePageInputSchema.safeParse({
    cursor: cursor ?? null,
    limit: numericLimit,
  });
  if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
  return { cursor: parsed.data.cursor ?? null, limit: parsed.data.limit ?? 100 };
}

function parseJobPage(
  cursor: string | undefined,
  rawLimit: string | undefined,
  status: string | undefined,
  createdAfter: string | undefined,
  createdBefore: string | undefined,
): ModuleImageJobListPage {
  const numericLimit = rawLimit === undefined ? 100 : Number(rawLimit);
  const parsed = OpenOpcImageJobListInputSchema.safeParse({
    cursor: cursor ?? null,
    limit: numericLimit,
    ...(status !== undefined ? { status } : {}),
    ...(createdAfter !== undefined ? { created_after: createdAfter } : {}),
    ...(createdBefore !== undefined ? { created_before: createdBefore } : {}),
  });
  if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
  return {
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit ?? 100,
    ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
    ...(parsed.data.created_after !== undefined
      ? { created_after: parsed.data.created_after }
      : {}),
    ...(parsed.data.created_before !== undefined
      ? { created_before: parsed.data.created_before }
      : {}),
  };
}

function parseAssetPage(
  cursor: string | undefined,
  rawLimit: string | undefined,
  sourceJobId: string | undefined,
  source: string | undefined,
  createdAfter: string | undefined,
  createdBefore: string | undefined,
): ModuleImageAssetListPage {
  const numericLimit = rawLimit === undefined ? 100 : Number(rawLimit);
  const parsed = OpenOpcImageAssetListInputSchema.safeParse({
    cursor: cursor ?? null,
    limit: numericLimit,
    ...(sourceJobId !== undefined ? { source_job_id: sourceJobId } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(createdAfter !== undefined ? { created_after: createdAfter } : {}),
    ...(createdBefore !== undefined ? { created_before: createdBefore } : {}),
  });
  if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
  return {
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit ?? 100,
    ...(parsed.data.source_job_id !== undefined
      ? { source_job_id: parsed.data.source_job_id }
      : {}),
    ...(parsed.data.source !== undefined ? { source: parsed.data.source } : {}),
    ...(parsed.data.created_after !== undefined
      ? { created_after: parsed.data.created_after }
      : {}),
    ...(parsed.data.created_before !== undefined
      ? { created_before: parsed.data.created_before }
      : {}),
  };
}

async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
  return parsed.data;
}

function parseMetadata(value: FormDataEntryValue | null): Record<string, unknown> {
  if (value === null) return {};
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_METADATA_JSON_BYTES) {
    throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid metadata');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
  }
}

function rejectOversizedMultipart(contentLength: string | undefined): void {
  if (contentLength === undefined) return;
  const length = Number(contentLength);
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > OPENOPC_IMAGE_ASSET_MAX_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    throw new ModuleImageError('OPENOPC_IMAGE_ASSET_TOO_LARGE', 413);
  }
}

function parseBackendResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
  return parsed.data;
}

function isStatusResult(value: unknown): value is { payload: unknown; status: number } {
  return (
    !!value &&
    typeof value === 'object' &&
    'payload' in value &&
    'status' in value &&
    typeof (value as { status?: unknown }).status === 'number'
  );
}

function moduleImageErrorResponse(error: unknown): Response {
  if (error instanceof ReleaseProfileUnavailableError) {
    return jsonResponse({ error: 'MODULE_SERVICE_UNAVAILABLE' }, 503);
  }
  if (error instanceof ModuleServiceCapabilityError) {
    return jsonResponse({ error: error.code }, error.status);
  }
  if (error instanceof ModuleImageError) return jsonResponse({ error: error.code }, error.status);
  return jsonResponse({ error: 'OPENOPC_IMAGE_INTERNAL_ERROR' }, 500);
}

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function safeFilename(value: string): string {
  const result = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '"' || character === '\\' || codePoint <= 0x1f || codePoint === 0x7f
      ? '_'
      : character;
  })
    .slice(0, 180)
    .join('');
  return result || 'image';
}
