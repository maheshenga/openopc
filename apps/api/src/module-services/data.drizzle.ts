import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import { OpenOpcModuleDocumentKeySchema } from '@kortix/api-contract';

import { ModuleDataError, type ModuleDataStore, type ModuleDocumentRecord } from './data';

type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows;
  }
  return [];
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(row: Row): ModuleDocumentRecord {
  const key = String(row.key ?? row.document_key ?? '');
  const revision = Number(row.revision);
  const updatedAt = row.updatedAt ?? row.updated_at;
  if (!OpenOpcModuleDocumentKeySchema.safeParse(key).success || !Number.isSafeInteger(revision)) {
    throw new ModuleDataError('MODULE_DATA_STORAGE_UNAVAILABLE', 503);
  }
  return {
    key,
    revision,
    value: jsonValue(row.value),
    updatedAt: String(updatedAt),
  };
}

function encodeCursor(key: string): string {
  return Buffer.from(JSON.stringify({ key }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null): string | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      key?: unknown;
    };
    if (
      typeof parsed.key !== 'string' ||
      !OpenOpcModuleDocumentKeySchema.safeParse(parsed.key).success
    ) {
      throw new Error('invalid cursor');
    }
    return parsed.key;
  } catch {
    throw new ModuleDataError('MODULE_SERVICE_INPUT_INVALID', 400);
  }
}

export function createDrizzleModuleDataStore(db: Database): ModuleDataStore {
  return {
    async listDocuments(input) {
      const cursorKey = decodeCursor(input.cursor);
      const result = await db.execute(sql`
        SELECT document_key AS "key", revision, value, updated_at AS "updatedAt"
        FROM kortix.project_module_documents
        WHERE account_id = ${input.accountId}
          AND project_id = ${input.projectId}
          AND installation_id = ${input.installationId}
          AND (${cursorKey} IS NULL OR document_key > ${cursorKey})
        ORDER BY document_key ASC
        LIMIT ${input.limit + 1}
      `);
      const documents = rows(result).map(record);
      const hasNext = documents.length > input.limit;
      const page = hasNext ? documents.slice(0, input.limit) : documents;
      const lastDocument = page.at(-1);
      return {
        documents: page,
        nextCursor: hasNext && lastDocument ? encodeCursor(lastDocument.key) : null,
      };
    },

    async readDocument(input) {
      const result = await db.execute(sql`
        SELECT document_key AS "key", revision, value, updated_at AS "updatedAt"
        FROM kortix.project_module_documents
        WHERE account_id = ${input.accountId}
          AND project_id = ${input.projectId}
          AND installation_id = ${input.installationId}
          AND document_key = ${input.key}
        LIMIT 1
      `);
      const row = rows(result)[0];
      return row ? record(row) : null;
    },

    async writeDocument(input) {
      const result =
        input.expectedRevision === null
          ? await db.execute(sql`
              INSERT INTO kortix.project_module_documents
                (account_id, project_id, installation_id, document_key, revision, value)
              VALUES
                (${input.accountId}, ${input.projectId}, ${input.installationId}, ${input.key}, 1, ${JSON.stringify(input.value)}::jsonb)
              ON CONFLICT (installation_id, document_key) DO NOTHING
              RETURNING document_key AS "key", revision, value, updated_at AS "updatedAt"
            `)
          : await db.execute(sql`
              UPDATE kortix.project_module_documents
              SET value = ${JSON.stringify(input.value)}::jsonb,
                  revision = revision + 1,
                  updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
              WHERE account_id = ${input.accountId}
                AND project_id = ${input.projectId}
                AND installation_id = ${input.installationId}
                AND document_key = ${input.key}
                AND revision = ${input.expectedRevision}
              RETURNING document_key AS "key", revision, value, updated_at AS "updatedAt"
            `);
      const row = rows(result)[0];
      if (!row) throw new ModuleDataError('MODULE_SERVICE_CONFLICT', 409);
      return record(row);
    },

    async deleteDocument(input) {
      const result = await db.execute(sql`
        DELETE FROM kortix.project_module_documents
        WHERE account_id = ${input.accountId}
          AND project_id = ${input.projectId}
          AND installation_id = ${input.installationId}
          AND document_key = ${input.key}
          AND revision = ${input.expectedRevision}
        RETURNING document_id
      `);
      if (rows(result).length === 0) throw new ModuleDataError('MODULE_SERVICE_CONFLICT', 409);
    },
  };
}

export { decodeCursor, encodeCursor };
