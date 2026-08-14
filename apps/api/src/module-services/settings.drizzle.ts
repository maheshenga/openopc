import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import {
  type RegistryOpenOpcSettingsDeclaration,
  validateRegistryModuleManifest,
} from '@kortix/registry';

import { ModuleSettingsError, type ModuleSettingsRepository } from './settings';

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

function manifestValue(row: Row): unknown {
  return jsonValue(row.manifest ?? row.release_manifest);
}

function scopeWhere(input: { accountId: string; projectId: string; installationId: string }) {
  return sql`
    account_id = ${input.accountId}
    AND project_id = ${input.projectId}
    AND installation_id = ${input.installationId}
  `;
}

export function createDrizzleModuleSettingsRepository(db: Database): ModuleSettingsRepository {
  return {
    async loadDefinition(input) {
      const result = await db.execute(sql`
        SELECT release.manifest AS manifest
        FROM kortix.project_module_installations installation
        INNER JOIN kortix.developer_module_releases release
          ON release.release_id = installation.active_release_id
        WHERE installation.account_id = ${input.accountId}
          AND installation.project_id = ${input.projectId}
          AND installation.installation_id = ${input.installationId}
          AND installation.status = 'active'
        LIMIT 1
      `);
      const row = rows(result)[0];
      if (!row) return null;
      const manifest = manifestValue(row);
      const validation = validateRegistryModuleManifest(manifest);
      if (!validation.valid || !manifest || typeof manifest !== 'object') {
        throw new ModuleSettingsError('MODULE_SETTINGS_STORAGE_UNAVAILABLE', 503);
      }
      const openopc = (manifest as { openopc?: { settings?: unknown } }).openopc;
      return openopc?.settings && typeof openopc.settings === 'object'
        ? (openopc.settings as RegistryOpenOpcSettingsDeclaration)
        : { fields: [] };
    },

    async readValues(input) {
      const revisionResult = await db.execute(sql`
        SELECT revision
        FROM kortix.project_module_settings
        WHERE ${scopeWhere(input)}
        LIMIT 1
      `);
      const revision = Number(rows(revisionResult)[0]?.revision ?? 0);
      const valuesResult = await db.execute(sql`
        SELECT setting_key AS "settingKey", value
        FROM kortix.project_module_setting_values
        WHERE ${scopeWhere(input)}
        ORDER BY setting_key ASC
      `);
      const values: Record<string, unknown> = {};
      for (const row of rows(valuesResult)) {
        const key = String(row.settingKey ?? row.setting_key ?? '');
        if (key) values[key] = jsonValue(row.value);
      }
      return { revision, values };
    },

    async replaceValues(input) {
      return db.transaction(async (tx) => {
        const metaResult = await tx.execute(sql`
          SELECT settings_id AS "settingsId", revision
          FROM kortix.project_module_settings
          WHERE ${scopeWhere(input)}
          FOR UPDATE
        `);
        let meta = rows(metaResult)[0];
        if (!meta) {
          const inserted = await tx.execute(sql`
            INSERT INTO kortix.project_module_settings
              (account_id, project_id, installation_id, revision)
            VALUES (${input.accountId}, ${input.projectId}, ${input.installationId}, 0)
            ON CONFLICT (installation_id) DO NOTHING
            RETURNING settings_id AS "settingsId", revision
          `);
          meta = rows(inserted)[0];
          if (!meta) {
            const retried = await tx.execute(sql`
              SELECT settings_id AS "settingsId", revision
              FROM kortix.project_module_settings
              WHERE ${scopeWhere(input)}
              FOR UPDATE
            `);
            meta = rows(retried)[0];
          }
        }
        if (!meta) throw new ModuleSettingsError('MODULE_SETTINGS_STORAGE_UNAVAILABLE', 503);
        const currentRevision = Number(meta.revision);
        if (!Number.isSafeInteger(currentRevision) || currentRevision !== input.expectedRevision) {
          throw new ModuleSettingsError('MODULE_SERVICE_CONFLICT', 409);
        }
        const nextRevision = currentRevision + 1;
        const keys = Object.keys(input.values);
        if (keys.length === 0) {
          await tx.execute(sql`
            DELETE FROM kortix.project_module_setting_values
            WHERE ${scopeWhere(input)}
          `);
        } else {
          const keyParams = sql.join(
            keys.map((key) => sql`${key}`),
            sql`, `,
          );
          await tx.execute(sql`
            DELETE FROM kortix.project_module_setting_values
            WHERE ${scopeWhere(input)}
              AND setting_key NOT IN (${keyParams})
          `);
          const tuples = keys.map(
            (key) => sql`(
              ${input.accountId}, ${input.projectId}, ${input.installationId}, ${key},
              ${JSON.stringify(input.values[key])}::jsonb, ${nextRevision}, ${input.actorUserId}
            )`,
          );
          await tx.execute(sql`
            INSERT INTO kortix.project_module_setting_values
              (account_id, project_id, installation_id, setting_key, value, revision, updated_by)
            VALUES ${sql.join(tuples, sql`, `)}
            ON CONFLICT (installation_id, setting_key) DO UPDATE SET
              value = EXCLUDED.value,
              revision = EXCLUDED.revision,
              updated_by = EXCLUDED.updated_by,
              updated_at = GREATEST(now(), project_module_setting_values.updated_at + interval '1 microsecond')
          `);
        }
        const updated = await tx.execute(sql`
          UPDATE kortix.project_module_settings
          SET revision = ${nextRevision},
              updated_at = GREATEST(now(), updated_at + interval '1 microsecond')
          WHERE settings_id = ${meta.settingsId}
            AND revision = ${currentRevision}
          RETURNING revision
        `);
        if (rows(updated).length === 0)
          throw new ModuleSettingsError('MODULE_SERVICE_CONFLICT', 409);
        return { revision: nextRevision, values: input.values };
      });
    },
  };
}
