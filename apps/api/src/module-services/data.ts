import {
  type ModuleServiceCapabilityClaimsV1,
  type ModuleServiceErrorCode,
  type OpenOpcDataServiceOperation,
  OpenOpcModuleDocumentDeleteInputSchema,
  OpenOpcModuleDocumentKeySchema,
  OpenOpcModuleDocumentListInputSchema,
  OpenOpcModuleDocumentWriteInputSchema,
} from '@kortix/api-contract';

import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { ModuleServiceCapabilityError } from './capability-grants';
import { requireModuleServiceOperation } from './service-auth';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 503;
type DataClaims = Extract<ModuleServiceCapabilityClaimsV1, { service: 'data' }>;

export interface ModuleDataScope {
  accountId: string;
  projectId: string;
  installationId: string;
}

export interface ModuleDocumentRecord {
  key: string;
  revision: number;
  value: unknown;
  updatedAt: string | Date;
}

export interface ModuleDataStore {
  listDocuments(input: ModuleDataScope & { cursor: string | null; limit: number }): Promise<{
    documents: readonly ModuleDocumentRecord[];
    nextCursor: string | null;
  }>;
  readDocument(input: ModuleDataScope & { key: string }): Promise<ModuleDocumentRecord | null>;
  writeDocument(
    input: ModuleDataScope & {
      key: string;
      expectedRevision: number | null;
      value: unknown;
    },
  ): Promise<ModuleDocumentRecord>;
  deleteDocument(input: ModuleDataScope & { key: string; expectedRevision: number }): Promise<void>;
}

export class ModuleDataError extends Error {
  readonly name = 'ModuleDataError';

  constructor(
    readonly code: Extract<
      ModuleServiceErrorCode,
      | 'MODULE_SERVICE_CONFLICT'
      | 'MODULE_SERVICE_INPUT_INVALID'
      | 'MODULE_DATA_DOCUMENT_NOT_FOUND'
      | 'MODULE_DATA_STORAGE_UNAVAILABLE'
    >,
    readonly status: ErrorStatus,
  ) {
    super(code);
  }
}

export interface ModuleDataRouteDependencies {
  requireCapability(
    authorization: string | undefined,
    operation: OpenOpcDataServiceOperation,
  ): Promise<DataClaims>;
  store: ModuleDataStore;
}

function scope(claims: DataClaims): ModuleDataScope {
  return {
    accountId: claims.accountId,
    projectId: claims.projectId,
    installationId: claims.installationId,
  };
}

function keyFromContext(context: { req: { param(name: string): string } }): string | null {
  const raw = context.req.param('key');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return OpenOpcModuleDocumentKeySchema.safeParse(decoded).success ? decoded : null;
}

function keyFromQuery(context: { req: { query(name: string): string | undefined } }):
  | string
  | null {
  const key = context.req.query('key');
  return key && OpenOpcModuleDocumentKeySchema.safeParse(key).success ? key : null;
}

async function readJson(context: { req: { text(): Promise<string> } }): Promise<unknown> {
  try {
    const body = await context.req.text();
    return body ? (JSON.parse(body) as unknown) : null;
  } catch {
    return null;
  }
}

function documentView(document: ModuleDocumentRecord) {
  return {
    key: document.key,
    revision: document.revision,
    etag: `"rev-${document.revision}"`,
    value: document.value,
    updated_at: new Date(document.updatedAt).toISOString(),
  };
}

function errorResponse(
  context: { json(payload: { error: string }, status: ErrorStatus): Response },
  error: unknown,
) {
  if (error instanceof ModuleDataError || error instanceof ModuleServiceCapabilityError) {
    return context.json({ error: error.code }, error.status as ErrorStatus);
  }
  return context.json({ error: 'MODULE_DATA_STORAGE_UNAVAILABLE' }, 503);
}

export function createRuntimeModuleDataDependencies(): ModuleDataRouteDependencies {
  return {
    requireCapability: (authorization, operation) =>
      requireModuleServiceOperation(authorization, {
        service: 'data',
        operation,
      }) as Promise<DataClaims>,
    store: unavailableModuleDataStore,
  };
}

export function createModuleDataRoutes(dependencies: ModuleDataRouteDependencies) {
  const app = makeOpenApiApp<AppEnv>();

  app.get('/documents', async (context) => {
    const query = context.req.query();
    const parsed = OpenOpcModuleDocumentListInputSchema.safeParse({
      cursor: query.cursor ?? null,
      limit: query.limit === undefined ? undefined : Number(query.limit),
    });
    if (!parsed.success) return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.list',
      );
      const page = await dependencies.store.listDocuments({
        ...scope(claims),
        cursor: parsed.data.cursor ?? null,
        limit: parsed.data.limit,
      });
      return context.json(
        {
          data: page.documents.map(documentView),
          next_cursor: page.nextCursor,
        },
        200,
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get('/document', async (context) => {
    const key = keyFromQuery(context);
    if (!key) return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.read',
      );
      const document = await dependencies.store.readDocument({ ...scope(claims), key });
      if (!document) throw new ModuleDataError('MODULE_DATA_DOCUMENT_NOT_FOUND', 404);
      return context.json(documentView(document), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.put('/document', async (context) => {
    const body = await readJson(context);
    const parsed = OpenOpcModuleDocumentWriteInputSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.write',
      );
      const document = await dependencies.store.writeDocument({
        ...scope(claims),
        key: parsed.data.key,
        expectedRevision: parsed.data.expected_revision,
        value: parsed.data.value,
      });
      return context.json(documentView(document), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.delete('/document', async (context) => {
    const body = await readJson(context);
    const parsed = OpenOpcModuleDocumentDeleteInputSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.delete',
      );
      await dependencies.store.deleteDocument({
        ...scope(claims),
        key: parsed.data.key,
        expectedRevision: parsed.data.expected_revision,
      });
      return context.json({ ok: true }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.get('/documents/:key', async (context) => {
    const key = keyFromContext(context);
    if (!key) return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.read',
      );
      const document = await dependencies.store.readDocument({ ...scope(claims), key });
      if (!document) throw new ModuleDataError('MODULE_DATA_DOCUMENT_NOT_FOUND', 404);
      return context.json(documentView(document), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.put('/documents/:key', async (context) => {
    const key = keyFromContext(context);
    const body = await readJson(context);
    const parsed = OpenOpcModuleDocumentWriteInputSchema.safeParse(
      body && typeof body === 'object' ? { ...(body as Record<string, unknown>), key } : body,
    );
    if (!key || !parsed.success)
      return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.write',
      );
      const document = await dependencies.store.writeDocument({
        ...scope(claims),
        key,
        expectedRevision: parsed.data.expected_revision,
        value: parsed.data.value,
      });
      return context.json(documentView(document), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.delete('/documents/:key', async (context) => {
    const key = keyFromContext(context);
    const body = await readJson(context);
    const parsed = OpenOpcModuleDocumentDeleteInputSchema.safeParse(
      body && typeof body === 'object' ? { ...(body as Record<string, unknown>), key } : body,
    );
    if (!key || !parsed.success)
      return context.json({ error: 'MODULE_SERVICE_INPUT_INVALID' }, 400);
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'documents.delete',
      );
      await dependencies.store.deleteDocument({
        ...scope(claims),
        key,
        expectedRevision: parsed.data.expected_revision,
      });
      return context.json({ ok: true }, 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}

const unavailableModuleDataStore: ModuleDataStore = {
  async listDocuments() {
    throw new ModuleDataError('MODULE_DATA_STORAGE_UNAVAILABLE', 503);
  },
  async readDocument() {
    throw new ModuleDataError('MODULE_DATA_STORAGE_UNAVAILABLE', 503);
  },
  async writeDocument() {
    throw new ModuleDataError('MODULE_DATA_STORAGE_UNAVAILABLE', 503);
  },
  async deleteDocument() {
    throw new ModuleDataError('MODULE_DATA_STORAGE_UNAVAILABLE', 503);
  },
};
