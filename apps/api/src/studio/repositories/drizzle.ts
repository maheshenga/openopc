import type { StudioAsset, StudioJob, StudioJobEvent } from '@kortix/api-contract';
import {
  StudioCredentialBindingSchema,
  type StudioPricingCatalogEntry,
  StudioPricingCatalogEntrySchema,
  type StudioProviderConfig,
} from '@kortix/api-contract';
import {
  type Database,
  studioAssetUploads,
  studioAssets,
  studioJobEvents,
  studioJobs,
  studioPricingCatalog,
  studioProviderConfigs,
} from '@kortix/db';
import { openAiCompatibleImageDefinition } from '@kortix/studio-adapters';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { StudioRepositoryError } from '../types';
import type {
  StudioCreateJobInput,
  StudioCreateJobResult,
  StudioPendingUploadRecord,
  StudioProviderConfigRecord,
  StudioProviderConfigWire,
  StudioRepository,
} from '../types';

type ProviderRow = typeof studioProviderConfigs.$inferSelect;
type PricingRow = typeof studioPricingCatalog.$inferSelect;
type JobRow = typeof studioJobs.$inferSelect;
type EventRow = typeof studioJobEvents.$inferSelect;
type UploadRow = typeof studioAssetUploads.$inferSelect;
type AssetRow = typeof studioAssets.$inferSelect;

function numberValue(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

function nullableNumberValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function providerCapabilities(row: ProviderRow): StudioProviderConfig['capabilities'] {
  const raw = row.capabilityMap;
  if (row.provider === 'openai-compatible') {
    try {
      return openAiCompatibleImageDefinition
        .capabilities({
          provider_config_id: row.providerConfigId,
          provider: row.provider,
          base_url: row.baseUrl ?? null,
          region: row.region ?? null,
          capability_map: raw,
          version_token: 'serialization-only',
        })
        .map((descriptor) => descriptor.capability)
        .filter((capability): capability is 'image.generate' => capability === 'image.generate');
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) {
    return raw.filter((item): item is 'image.generate' => item === 'image.generate');
  }
  if (raw && typeof raw === 'object') {
    const candidate = (raw as Record<string, unknown>).capabilities;
    if (Array.isArray(candidate)) {
      return candidate.filter((item): item is 'image.generate' => item === 'image.generate');
    }
    if ((raw as Record<string, unknown>)['image.generate']) return ['image.generate'];
  }
  return [];
}

function publicCredentialBinding(raw: unknown): StudioProviderConfig['credential_binding'] | null {
  if (!raw || typeof raw !== 'object') return raw == null ? { kind: 'none' } : null;
  const candidate = raw as Record<string, unknown>;
  if (candidate.kind === 'none') return { kind: 'none' };
  if (candidate.kind === 'secret' && typeof candidate.identifier === 'string') {
    return candidate.identifier ? { kind: 'secret', identifier: candidate.identifier } : null;
  }
  if (candidate.kind === 'connector' && typeof candidate.slug === 'string') {
    return candidate.slug ? { kind: 'connector', slug: candidate.slug } : null;
  }
  return null;
}

function serializeProvider(row: ProviderRow): StudioProviderConfigWire | null {
  if (row.provider !== 'fake' && row.provider !== 'openai-compatible') return null;
  const credential = publicCredentialBinding(row.credentialBinding);
  if (!credential) return null;
  return {
    provider_config_id: row.providerConfigId,
    account_id: row.accountId,
    project_id: row.projectId,
    provider: row.provider,
    display_name: row.displayName,
    base_url: row.baseUrl ?? null,
    region: row.region ?? null,
    credential_binding: credential,
    capabilities: providerCapabilities(row),
    enabled: row.enabled === true,
    created_at: row.createdAt ?? new Date(0).toISOString(),
    updated_at: row.updatedAt ?? new Date(0).toISOString(),
  };
}

function timestampValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function serializePricing(row: PricingRow): StudioPricingCatalogEntry {
  return StudioPricingCatalogEntrySchema.parse({
    pricing_catalog_id: row.pricingCatalogId,
    account_id: row.accountId,
    provider: row.provider,
    model: row.model,
    unit: row.unit,
    rate_data: row.rateData,
    maximum_cost_rule: row.maximumCostRule,
    markup_rule: row.markupRule,
    version: row.version,
    active: row.active,
    created_by_user_id: row.createdByUserId ?? null,
    created_at: timestampValue(row.createdAt),
  });
}

function serializeRawPricing(row: Record<string, unknown>): StudioPricingCatalogEntry {
  return StudioPricingCatalogEntrySchema.parse({
    pricing_catalog_id: row.pricing_catalog_id,
    account_id: row.account_id,
    provider: row.provider,
    model: row.model,
    unit: row.unit,
    rate_data: row.rate_data,
    maximum_cost_rule: row.maximum_cost_rule,
    markup_rule: row.markup_rule,
    version: Number(row.version),
    active: row.active,
    created_by_user_id: row.created_by_user_id ?? null,
    created_at: timestampValue(row.created_at),
  });
}

function canonicalProviderVersionSql(alias: 'chosen' | 'inserted' | 'target' | 'updated') {
  return sql.raw(`pg_catalog.md5(pg_catalog.jsonb_build_object(
    'provider_config_id', ${alias}.provider_config_id,
    'account_id', ${alias}.account_id,
    'project_id', ${alias}.project_id,
    'provider', ${alias}.provider,
    'base_url', ${alias}.base_url,
    'region', ${alias}.region,
    'credential_binding', ${alias}.credential_binding,
    'capability_map', ${alias}.capability_map,
    'enabled', ${alias}.enabled
  )::text)`);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function serializeRawProvider(
  row: Record<string, unknown>,
  versionToken: unknown,
): StudioProviderConfigRecord {
  const credential = StudioCredentialBindingSchema.safeParse(row.credential_binding);
  if (
    !credential.success ||
    row.provider !== 'openai-compatible' ||
    !row.capability_map ||
    typeof row.capability_map !== 'object' ||
    Array.isArray(row.capability_map) ||
    typeof versionToken !== 'string' ||
    versionToken.length === 0
  ) {
    throw new Error('Invalid Studio provider configuration row');
  }
  return {
    provider_config_id: String(row.provider_config_id),
    account_id: String(row.account_id),
    project_id: String(row.project_id),
    provider: row.provider,
    display_name: String(row.display_name),
    base_url: row.base_url === null ? null : String(row.base_url),
    region: row.region === null ? null : String(row.region),
    credential_binding: credential.data,
    capability_map: row.capability_map as Record<string, unknown>,
    version_token: versionToken,
    enabled: row.enabled === true,
    created_at: timestampValue(row.created_at),
    updated_at: timestampValue(row.updated_at),
  };
}

function serializeJob(row: JobRow): StudioJob {
  return {
    job_id: row.jobId,
    account_id: row.accountId,
    project_id: row.projectId,
    actor_user_id: row.actorUserId ?? null,
    actor_type: row.actorType as StudioJob['actor_type'],
    capability: row.capability as StudioJob['capability'],
    provider_config_id: row.providerConfigId,
    provider: row.provider,
    model: row.model,
    input: row.input as StudioJob['input'],
    status: row.status as StudioJob['status'],
    idempotency_key: row.idempotencyKey,
    request_hash: row.requestHash,
    attempt_count: row.attemptCount,
    reserved_credits: numberValue(row.reservedCredits),
    actual_credits: nullableNumberValue(row.actualCredits),
    error_code: (row.errorCode as StudioJob['error_code']) ?? null,
    error_message: row.errorMessage ?? null,
    created_at: row.createdAt ?? new Date(0).toISOString(),
    updated_at: row.updatedAt ?? new Date(0).toISOString(),
    started_at: row.startedAt ?? null,
    completed_at: row.completedAt ?? null,
  };
}

function serializeEvent(row: EventRow): StudioJobEvent {
  return {
    event_id: row.eventId,
    job_id: row.jobId,
    cursor: String(row.cursor),
    type: row.eventType as StudioJobEvent['type'],
    payload: row.payload ?? {},
    created_at: row.createdAt ?? new Date(0).toISOString(),
  };
}

function serializePendingUpload(row: UploadRow): StudioPendingUploadRecord {
  return {
    upload_id: row.uploadId,
    account_id: row.accountId,
    project_id: row.projectId,
    actor_user_id: row.actorUserId ?? null,
    asset_id: row.finalizedAssetId ?? null,
    object_key: row.objectKey,
    declared_mime_type: row.declaredMimeType,
    expected_size_bytes: Number(row.expectedSizeBytes),
    expected_checksum_sha256: row.expectedChecksumSha256,
    expires_at: row.expiresAt,
    status: row.status as StudioPendingUploadRecord['status'],
  };
}

function serializeRawPendingUpload(row: Record<string, unknown>): StudioPendingUploadRecord {
  return {
    upload_id: String(row.upload_id),
    account_id: String(row.account_id),
    project_id: String(row.project_id),
    actor_user_id: row.actor_user_id === null ? null : String(row.actor_user_id),
    asset_id: row.finalized_asset_id === null ? null : String(row.finalized_asset_id),
    object_key: String(row.object_key),
    declared_mime_type: String(row.declared_mime_type),
    expected_size_bytes: Number(row.expected_size_bytes),
    expected_checksum_sha256: String(row.expected_checksum_sha256),
    expires_at: timestampValue(row.expires_at),
    status: row.status as StudioPendingUploadRecord['status'],
  };
}

function serializeAsset(row: AssetRow): StudioAsset {
  return {
    asset_id: row.assetId,
    account_id: row.accountId,
    project_id: row.projectId,
    source_job_id: row.sourceJobId ?? null,
    kind: row.kind as StudioAsset['kind'],
    mime_type: row.mimeType,
    bucket: row.bucket,
    object_key: row.objectKey,
    checksum_sha256: row.checksumSha256,
    size_bytes: Number(row.sizeBytes),
    width: row.width ?? null,
    height: row.height ?? null,
    metadata: row.metadata ?? {},
    created_at: row.createdAt ?? new Date(0).toISOString(),
  };
}

function serializeRawAsset(row: Record<string, unknown>): StudioAsset {
  return {
    asset_id: String(row.asset_id),
    account_id: String(row.account_id),
    project_id: String(row.project_id),
    source_job_id: row.source_job_id === null ? null : String(row.source_job_id),
    kind: row.kind as StudioAsset['kind'],
    mime_type: String(row.mime_type),
    bucket: String(row.bucket),
    object_key: String(row.object_key),
    checksum_sha256: String(row.checksum_sha256),
    size_bytes: Number(row.size_bytes),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    metadata: recordValue(row.metadata) ?? {},
    created_at: timestampValue(row.created_at),
  };
}

function rowsFromExecute(value: unknown): Record<string, unknown>[] {
  if (!value || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    return [];
  }
  return Array.from(value as Iterable<Record<string, unknown>>);
}

export function createDrizzleStudioRepository(db: Database): StudioRepository {
  return {
    async listPricing(accountId) {
      const rows = await db
        .select()
        .from(studioPricingCatalog)
        .where(eq(studioPricingCatalog.accountId, accountId))
        .orderBy(
          asc(studioPricingCatalog.provider),
          asc(studioPricingCatalog.model),
          desc(studioPricingCatalog.version),
        );
      return rows.map(serializePricing);
    },

    async getActivePricing(accountId, pricingCatalogId) {
      const rows = await db
        .select()
        .from(studioPricingCatalog)
        .where(
          and(
            eq(studioPricingCatalog.accountId, accountId),
            eq(studioPricingCatalog.pricingCatalogId, pricingCatalogId),
            eq(studioPricingCatalog.active, true),
          ),
        )
        .limit(1);
      return rows[0] ? serializePricing(rows[0]) : null;
    },

    async createPricingVersion({ account_id, created_by_user_id, request }) {
      return db.transaction(
        async (tx) => {
          await tx.execute(sql`
          SELECT pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
              ${account_id}::uuid::text || chr(31) || ${request.provider} || chr(31) || ${request.model},
              0
            )
          )
        `);

          const [current] = await tx
            .select({
              version: sql<number>`COALESCE(MAX(${studioPricingCatalog.version}), 0)`,
            })
            .from(studioPricingCatalog)
            .where(
              and(
                eq(studioPricingCatalog.accountId, account_id),
                eq(studioPricingCatalog.provider, request.provider),
                eq(studioPricingCatalog.model, request.model),
              ),
            );
          const version = Number(current?.version ?? 0) + 1;
          const [row] = await tx
            .insert(studioPricingCatalog)
            .values({
              accountId: account_id,
              provider: request.provider,
              model: request.model,
              unit: request.unit,
              rateData: request.rate_data,
              maximumCostRule: request.maximum_cost_rule,
              markupRule: request.markup_rule,
              version,
              active: true,
              createdByUserId: created_by_user_id,
            })
            .returning();
          if (!row) throw new Error('Studio pricing version was not created');
          return serializePricing(row);
        },
        { isolationLevel: 'read committed' },
      );
    },

    async deactivatePricing(accountId, pricingCatalogId) {
      const result = await db.execute(sql`
        WITH target AS MATERIALIZED (
          SELECT *
          FROM kortix.studio_pricing_catalog
          WHERE account_id = ${accountId}::uuid
            AND pricing_catalog_id = ${pricingCatalogId}::uuid
          FOR UPDATE
        ), updated AS (
          UPDATE kortix.studio_pricing_catalog price
          SET active = false
          FROM target
          WHERE price.pricing_catalog_id = target.pricing_catalog_id
            AND target.active IS TRUE
          RETURNING price.*
        )
        SELECT * FROM updated
        UNION ALL
        SELECT * FROM target
        WHERE target.active IS FALSE
          AND NOT EXISTS (SELECT 1 FROM updated)
        LIMIT 1
      `);
      const row = rowsFromExecute(result)[0];
      return row ? serializeRawPricing(row) : null;
    },

    async createProviderConfig(provider, pricingReferences) {
      const result = await db.execute(sql`
        WITH project_scope AS MATERIALIZED (
          SELECT 1
          FROM kortix.projects project
          WHERE project.project_id = ${provider.project_id}::uuid
            AND project.account_id = ${provider.account_id}::uuid
        ), requested_prices AS MATERIALIZED (
          SELECT *
          FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(pricingReferences)}::jsonb)
            AS reference(pricing_catalog_id uuid, provider text, model text)
        ), locked_prices AS MATERIALIZED (
          SELECT price.pricing_catalog_id
          FROM kortix.studio_pricing_catalog price
          JOIN requested_prices reference
            ON reference.pricing_catalog_id = price.pricing_catalog_id
           AND reference.provider = price.provider
           AND reference.model = price.model
          WHERE price.account_id = ${provider.account_id}::uuid
            AND price.active IS TRUE
          FOR UPDATE OF price
        ), validation AS MATERIALIZED (
          SELECT
            EXISTS (SELECT 1 FROM project_scope) AS project_valid,
            (SELECT COUNT(*) FROM requested_prices) > 0
            AND (SELECT COUNT(*) FROM requested_prices) =
                (SELECT COUNT(*) FROM locked_prices) AS prices_valid
        ), inserted AS (
          INSERT INTO kortix.studio_provider_configs (
            account_id,
            project_id,
            provider,
            display_name,
            base_url,
            region,
            credential_binding,
            capability_map,
            enabled
          )
          SELECT
            ${provider.account_id}::uuid,
            ${provider.project_id}::uuid,
            ${provider.provider},
            ${provider.display_name},
            ${provider.base_url},
            ${provider.region},
            ${JSON.stringify(provider.credential_binding)}::jsonb,
            ${JSON.stringify(provider.capability_map)}::jsonb,
            ${provider.enabled}
          FROM validation
          WHERE validation.project_valid
            AND validation.prices_valid
          RETURNING *
        )
        SELECT
          CASE
            WHEN NOT validation.project_valid THEN 'not_found'
            WHEN NOT validation.prices_valid THEN 'pricing_invalid'
            ELSE 'ok'
          END AS mutation_code,
          CASE WHEN inserted.provider_config_id IS NULL THEN NULL ELSE pg_catalog.to_jsonb(inserted) END
            AS provider_row,
          CASE WHEN inserted.provider_config_id IS NULL THEN NULL ELSE ${canonicalProviderVersionSql('inserted')} END
            AS version_token
        FROM validation
        LEFT JOIN inserted ON true
      `);
      const envelope = rowsFromExecute(result)[0];
      const code = envelope?.mutation_code;
      if (code === 'not_found' || code === 'pricing_invalid') {
        return { ok: false, code };
      }
      if (code !== 'ok') throw new Error('Studio provider configuration create failed');
      const row = recordValue(envelope.provider_row);
      if (!row) throw new Error('Studio provider configuration was not created');
      return { ok: true, value: serializeRawProvider(row, envelope.version_token) };
    },

    async getProviderConfigRecord(accountId, projectId, providerConfigId) {
      const result = await db.execute(sql`
        SELECT
          pg_catalog.to_jsonb(target) AS provider_row,
          ${canonicalProviderVersionSql('target')} AS version_token
        FROM kortix.studio_provider_configs target
        WHERE target.account_id = ${accountId}::uuid
          AND target.project_id = ${projectId}::uuid
          AND target.provider_config_id = ${providerConfigId}::uuid
          AND target.provider = 'openai-compatible'
        LIMIT 1
      `);
      const envelope = rowsFromExecute(result)[0];
      if (!envelope) return null;
      const row = recordValue(envelope.provider_row);
      if (!row) throw new Error('Invalid Studio provider configuration row');
      return serializeRawProvider(row, envelope.version_token);
    },

    async updateProviderConfig(candidate, expectedVersionToken, pricingReferences, patch) {
      const result = await db.execute(sql`
        WITH target AS MATERIALIZED (
          SELECT
            target.*,
            ${canonicalProviderVersionSql('target')} AS version_token
          FROM kortix.studio_provider_configs target
          WHERE target.account_id = ${candidate.account_id}::uuid
            AND target.project_id = ${candidate.project_id}::uuid
            AND target.provider_config_id = ${candidate.provider_config_id}::uuid
            AND target.provider = 'openai-compatible'
          FOR UPDATE OF target
        ), requested_prices AS MATERIALIZED (
          SELECT *
          FROM pg_catalog.jsonb_to_recordset(${JSON.stringify(pricingReferences)}::jsonb)
            AS reference(pricing_catalog_id uuid, provider text, model text)
        ), locked_prices AS MATERIALIZED (
          SELECT price.pricing_catalog_id
          FROM target
          JOIN requested_prices reference ON true
          JOIN kortix.studio_pricing_catalog price
            ON reference.pricing_catalog_id = price.pricing_catalog_id
           AND reference.provider = price.provider
           AND reference.model = price.model
          WHERE price.account_id = target.account_id
            AND price.active IS TRUE
          FOR UPDATE OF price
        ), validation AS MATERIALIZED (
          SELECT
            EXISTS (SELECT 1 FROM target) AS target_exists,
            COALESCE((SELECT target.version_token = ${expectedVersionToken} FROM target), false)
              AS version_matches,
            (SELECT COUNT(*) FROM requested_prices) > 0
              AND (SELECT COUNT(*) FROM requested_prices) =
                  (SELECT COUNT(*) FROM locked_prices) AS prices_valid
        ), updated AS (
          UPDATE kortix.studio_provider_configs config
          SET display_name = CASE
                WHEN ${patch.display_name !== undefined} THEN ${candidate.display_name}
                ELSE config.display_name
              END,
              base_url = CASE
                WHEN ${patch.base_url !== undefined} THEN ${candidate.base_url}
                ELSE config.base_url
              END,
              region = CASE
                WHEN ${patch.region !== undefined} THEN ${candidate.region}
                ELSE config.region
              END,
              credential_binding = CASE
                WHEN ${patch.credential_binding !== undefined}
                  THEN ${JSON.stringify(candidate.credential_binding)}::jsonb
                ELSE config.credential_binding
              END,
              capability_map = CASE
                WHEN ${patch.capability_map !== undefined}
                  THEN ${JSON.stringify(candidate.capability_map)}::jsonb
                ELSE config.capability_map
              END,
              enabled = CASE
                WHEN ${patch.enabled !== undefined} THEN ${candidate.enabled}
                ELSE config.enabled
              END,
              updated_at = clock_timestamp()
          FROM target, validation
          WHERE config.provider_config_id = target.provider_config_id
            AND config.provider = 'openai-compatible'
            AND target.provider = ${candidate.provider}
            AND validation.version_matches
            AND validation.prices_valid
          RETURNING config.*
        )
        SELECT
          CASE
            WHEN NOT validation.target_exists THEN 'not_found'
            WHEN NOT validation.version_matches THEN 'stale'
            WHEN NOT validation.prices_valid THEN 'pricing_invalid'
            ELSE 'ok'
          END AS mutation_code,
          (SELECT pg_catalog.to_jsonb(updated) FROM updated LIMIT 1) AS provider_row,
          (SELECT ${canonicalProviderVersionSql('updated')} FROM updated LIMIT 1) AS version_token
        FROM validation
      `);
      const envelope = rowsFromExecute(result)[0];
      const code = envelope?.mutation_code;
      if (code === 'not_found' || code === 'stale' || code === 'pricing_invalid') {
        return { ok: false, code };
      }
      if (code !== 'ok') throw new Error('Studio provider configuration update failed');
      const row = recordValue(envelope.provider_row);
      if (!row) throw new Error('Studio provider configuration update returned no row');
      return { ok: true, value: serializeRawProvider(row, envelope.version_token) };
    },

    async disableProviderConfig(accountId, projectId, providerConfigId) {
      const result = await db.execute(sql`
        WITH target AS MATERIALIZED (
          SELECT config.*
          FROM kortix.studio_provider_configs config
          WHERE config.account_id = ${accountId}::uuid
            AND config.project_id = ${projectId}::uuid
            AND config.provider_config_id = ${providerConfigId}::uuid
            AND config.provider = 'openai-compatible'
          FOR UPDATE OF config
        ), updated AS (
          UPDATE kortix.studio_provider_configs config
          SET enabled = false,
              updated_at = clock_timestamp()
          FROM target
          WHERE config.provider_config_id = target.provider_config_id
            AND config.provider = 'openai-compatible'
            AND target.enabled IS TRUE
          RETURNING config.*
        ), chosen AS MATERIALIZED (
          SELECT * FROM updated
          UNION ALL
          SELECT * FROM target
          WHERE target.enabled IS FALSE
            AND NOT EXISTS (SELECT 1 FROM updated)
        )
        SELECT
          CASE WHEN EXISTS (SELECT 1 FROM chosen) THEN 'ok' ELSE 'not_found' END AS mutation_code,
          (SELECT pg_catalog.to_jsonb(chosen) FROM chosen LIMIT 1) AS provider_row,
          (SELECT ${canonicalProviderVersionSql('chosen')} FROM chosen LIMIT 1) AS version_token
      `);
      const envelope = rowsFromExecute(result)[0];
      if (envelope?.mutation_code === 'not_found') return { ok: false, code: 'not_found' };
      if (envelope?.mutation_code !== 'ok') {
        throw new Error('Studio provider configuration disable failed');
      }
      const row = recordValue(envelope.provider_row);
      if (!row) throw new Error('Studio provider configuration disable returned no row');
      return { ok: true, value: serializeRawProvider(row, envelope.version_token) };
    },

    async listProviders(projectId) {
      const rows = await db
        .select()
        .from(studioProviderConfigs)
        .where(
          and(
            eq(studioProviderConfigs.projectId, projectId),
            eq(studioProviderConfigs.enabled, true),
          ),
        );
      return rows
        .map(serializeProvider)
        .filter(
          (provider: StudioProviderConfigWire | null): provider is StudioProviderConfigWire =>
            !!provider,
        );
    },

    async getProvider(projectId, providerConfigId) {
      const rows = await db
        .select()
        .from(studioProviderConfigs)
        .where(
          and(
            eq(studioProviderConfigs.projectId, projectId),
            eq(studioProviderConfigs.providerConfigId, providerConfigId),
            eq(studioProviderConfigs.enabled, true),
          ),
        )
        .limit(1);
      return rows[0] ? serializeProvider(rows[0]) : null;
    },

    async createJob(input, provider, estimate, productionBinding): Promise<StudioCreateJobResult> {
      const existing = await db
        .select()
        .from(studioJobs)
        .where(
          and(
            eq(studioJobs.accountId, input.account_id),
            eq(studioJobs.idempotencyKey, input.idempotency_key),
          ),
        )
        .limit(1);
      if (existing[0]) {
        if (
          existing[0].projectId !== input.project_id ||
          existing[0].requestHash !== input.request_hash
        ) {
          return { created: false, mismatch: true };
        }
        return {
          job: serializeJob(existing[0]),
          created: false,
        };
      }

      const reservationExpiresAt = new Date(
        Math.max(Date.now() + 24 * 60 * 60_000, Date.parse(estimate.expires_at)),
      ).toISOString();
      const rpcRows = productionBinding
        ? await db.execute(sql`
            SELECT public.atomic_create_studio_job(
              ${input.account_id}::uuid,
              ${input.project_id}::uuid,
              ${input.actor_user_id}::uuid,
              ${input.actor_type},
              ${input.acting_token_id}::uuid,
              ${input.agent_name},
              ${input.session_id},
              ${input.parent_job_id}::uuid,
              ${input.capability},
              ${input.provider_config_id}::uuid,
              ${productionBinding.provider_config_version},
              ${provider.provider},
              ${input.model},
              ${productionBinding.pricing_snapshot.pricing_catalog_id}::uuid,
              ${productionBinding.pricing_snapshot.version}::integer,
              ${JSON.stringify(productionBinding.pricing_snapshot)}::jsonb,
              ${JSON.stringify(input.input)}::jsonb,
              ${input.idempotency_key},
              ${input.request_hash},
              ${String(estimate.max_approved_credits)}::numeric,
              ${reservationExpiresAt}::timestamptz
            ) AS result
          `)
        : await db.execute(sql`
            SELECT public.atomic_create_studio_job(
              ${input.account_id}::uuid,
              ${input.project_id}::uuid,
              ${input.actor_user_id}::uuid,
              ${input.actor_type},
              ${input.acting_token_id}::uuid,
              ${input.agent_name},
              ${input.session_id},
              ${input.parent_job_id}::uuid,
              ${input.capability},
              ${input.provider_config_id}::uuid,
              ${provider.provider},
              ${input.model},
              ${JSON.stringify(input.input)}::jsonb,
              ${input.idempotency_key},
              ${input.request_hash},
              ${String(estimate.max_approved_credits)}::numeric,
              ${reservationExpiresAt}::timestamptz
            ) AS result
          `);
      const rpc = rowsFromExecute(rpcRows)[0]?.result as Record<string, unknown> | undefined;
      if (!rpc || rpc.success !== true) {
        if (rpc?.code === 'idempotency_mismatch') {
          return { created: false, mismatch: true };
        }
        if (rpc?.code === 'insufficient_credits') {
          throw new StudioRepositoryError(
            'STUDIO_INSUFFICIENT_CREDITS',
            402,
            'Insufficient credits',
          );
        }
        if (rpc?.code === 'provider_config_stale') {
          throw new StudioRepositoryError(
            'STUDIO_PROVIDER_CONFIG_STALE',
            409,
            'Studio provider configuration is stale',
          );
        }
        if (rpc?.code === 'pricing_stale') {
          throw new StudioRepositoryError('STUDIO_PRICING_STALE', 409, 'Studio pricing is stale');
        }
        throw new Error(String(rpc?.error ?? 'Studio job reservation failed'));
      }
      const jobId = String(rpc.job_id);
      const rows = await db
        .select()
        .from(studioJobs)
        .where(and(eq(studioJobs.projectId, input.project_id), eq(studioJobs.jobId, jobId)))
        .limit(1);
      if (!rows[0]) throw new Error('Studio job was created but could not be reloaded');
      const job = serializeJob(rows[0]);
      return { job, created: rpc.idempotent !== true };
    },

    async findJobByIdempotency(accountId, idempotencyKey) {
      const rows = await db
        .select()
        .from(studioJobs)
        .where(
          and(eq(studioJobs.accountId, accountId), eq(studioJobs.idempotencyKey, idempotencyKey)),
        )
        .limit(1);
      return rows[0] ? serializeJob(rows[0]) : null;
    },

    async listJobs(projectId, limit, cursor) {
      const conditions = [eq(studioJobs.projectId, projectId)];
      if (cursor) conditions.push(lt(studioJobs.createdAt, cursor));
      const rows = await db
        .select()
        .from(studioJobs)
        .where(and(...conditions))
        .orderBy(desc(studioJobs.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(serializeJob);
      return {
        items: page,
        next_cursor: rows.length > limit ? rows[limit].createdAt : null,
      };
    },

    async getJob(projectId, jobId) {
      const rows = await db
        .select()
        .from(studioJobs)
        .where(and(eq(studioJobs.projectId, projectId), eq(studioJobs.jobId, jobId)))
        .limit(1);
      return rows[0] ? serializeJob(rows[0]) : null;
    },

    async requestCancellation(projectId, jobId) {
      const now = new Date().toISOString();
      const rows = await db.execute(sql`
        WITH locked AS (
          SELECT job_id, status
          FROM kortix.studio_jobs
          WHERE project_id = ${projectId}::uuid
            AND job_id = ${jobId}::uuid
            AND status IN ('queued', 'running')
          FOR UPDATE
        ), updated AS (
          UPDATE kortix.studio_jobs job
          SET cancellation_requested_at = ${now}::timestamptz,
              status = CASE WHEN locked.status = 'queued' THEN 'cancelled'::kortix.studio_job_status ELSE job.status END,
              completed_at = CASE WHEN locked.status = 'queued' THEN ${now}::timestamptz ELSE job.completed_at END,
              lease_owner = CASE WHEN locked.status = 'queued' THEN NULL ELSE job.lease_owner END,
              lease_expires_at = CASE WHEN locked.status = 'queued' THEN NULL ELSE job.lease_expires_at END,
              updated_at = ${now}::timestamptz
          FROM locked
          WHERE job.job_id = locked.job_id
          RETURNING job.job_id, job.status, locked.status AS prior_status
        ), released AS (
          UPDATE kortix.studio_credit_reservations reservation
          SET status = 'released',
              release_key = ${`studio:cancel:${jobId}`},
              released_at = ${now}::timestamptz
          FROM updated
          WHERE reservation.job_id = updated.job_id
            AND updated.prior_status = 'queued'
            AND reservation.status = 'active'
          RETURNING reservation.job_id
        ), next_cursor AS (
          SELECT COALESCE(MAX(event.cursor), 0) + 1 AS cursor
          FROM kortix.studio_job_events event
          JOIN updated ON updated.job_id = event.job_id
        ), terminal_event AS (
          INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
          SELECT updated.job_id, next_cursor.cursor, 'cancelled', ${JSON.stringify({ reason: 'user_cancelled' })}::jsonb, ${now}::timestamptz
          FROM updated CROSS JOIN next_cursor
          WHERE updated.prior_status = 'queued'
          RETURNING job_id
        )
        SELECT job_id, status FROM updated
      `);
      if (!rowsFromExecute(rows)[0]) return null;
      return this.getJob(projectId, jobId);
    },

    async listEvents(projectId, jobId, afterCursor) {
      const job = await this.getJob(projectId, jobId);
      if (!job) return { items: [], next_cursor: null };
      const conditions = [eq(studioJobEvents.jobId, jobId)];
      if (afterCursor) conditions.push(gt(studioJobEvents.cursor, Number(afterCursor)));
      const rows = await db
        .select()
        .from(studioJobEvents)
        .where(and(...conditions))
        .orderBy(studioJobEvents.cursor)
        .limit(101);
      const page = rows.slice(0, 100).map(serializeEvent);
      return {
        items: page,
        next_cursor: rows.length > 100 ? String(rows[100].cursor) : null,
      };
    },

    async createPendingUpload(input) {
      const result = await db.execute(sql`
        WITH inserted AS (
          INSERT INTO kortix.studio_asset_uploads (
            upload_id,
            account_id,
            project_id,
            actor_user_id,
            object_key,
            declared_mime_type,
            expected_size_bytes,
            expected_checksum_sha256,
            expires_at,
            status
          )
          SELECT
            ${input.upload_id}::uuid,
            project.account_id,
            project.project_id,
            ${input.actor_user_id}::uuid,
            ${input.object_key},
            ${input.declared_mime_type},
            ${input.expected_size_bytes},
            ${input.expected_checksum_sha256},
            ${input.expires_at}::timestamptz,
            'pending'
          FROM kortix.projects project
          WHERE project.project_id = ${input.project_id}::uuid
            AND project.account_id = ${input.account_id}::uuid
          RETURNING *
        )
        SELECT pg_catalog.to_jsonb(inserted) AS upload_row
        FROM inserted
        LIMIT 1
      `);
      const row = recordValue(rowsFromExecute(result)[0]?.upload_row);
      if (!row) throw new Error('Studio pending upload scope is invalid');
      return serializeRawPendingUpload(row);
    },

    async getUploadRecord(accountId, projectId, uploadId) {
      const [row] = await db
        .select()
        .from(studioAssetUploads)
        .where(
          and(
            eq(studioAssetUploads.accountId, accountId),
            eq(studioAssetUploads.projectId, projectId),
            eq(studioAssetUploads.uploadId, uploadId),
          ),
        )
        .limit(1);
      return row ? serializePendingUpload(row) : null;
    },

    async finalizeUploadRecord(input) {
      return db.transaction(
        async (tx) => {
          const locked = await tx.execute(sql`
            SELECT pg_catalog.to_jsonb(upload) AS upload_row,
                   upload.expires_at <= clock_timestamp() AS expired
            FROM kortix.studio_asset_uploads upload
            WHERE upload.account_id = ${input.account_id}::uuid
              AND upload.project_id = ${input.project_id}::uuid
              AND upload.upload_id = ${input.upload_id}::uuid
              AND upload.object_key = ${input.object_key}
            FOR UPDATE OF upload
          `);
          const lockedRow = rowsFromExecute(locked)[0];
          const upload = recordValue(lockedRow?.upload_row);
          if (!upload) return { outcome: 'not_found' as const };
          if (upload.status === 'finalized') {
            if (typeof upload.finalized_asset_id !== 'string') {
              return { outcome: 'not_found' as const };
            }
            const [asset] = await tx
              .select()
              .from(studioAssets)
              .where(
                and(
                  eq(studioAssets.assetId, upload.finalized_asset_id),
                  eq(studioAssets.accountId, input.account_id),
                  eq(studioAssets.projectId, input.project_id),
                  eq(studioAssets.objectKey, input.object_key),
                ),
              )
              .limit(1);
            return asset
              ? { outcome: 'finalized' as const, asset: serializeAsset(asset) }
              : { outcome: 'not_found' as const };
          }
          if (upload.status !== 'pending') return { outcome: 'not_found' as const };
          if (lockedRow?.expired === true) return { outcome: 'expired' as const };
          if (
            upload.declared_mime_type !== input.mime_type ||
            Number(upload.expected_size_bytes) !== input.size_bytes ||
            upload.expected_checksum_sha256 !== input.checksum_sha256
          ) {
            return { outcome: 'mismatch' as const };
          }

          const result = await tx.execute(sql`
            WITH inserted AS (
              INSERT INTO kortix.studio_assets (
                account_id,
                project_id,
                creator_user_id,
                source_job_id,
                kind,
                mime_type,
                bucket,
                object_key,
                checksum_sha256,
                size_bytes,
                width,
                height,
                metadata
              )
              SELECT
                upload.account_id,
                upload.project_id,
                upload.actor_user_id,
                NULL,
                'image',
                ${input.mime_type},
                ${input.bucket},
                upload.object_key,
                ${input.checksum_sha256},
                ${input.size_bytes},
                ${input.width},
                ${input.height},
                ${JSON.stringify(input.metadata)}::jsonb
              FROM kortix.studio_asset_uploads upload
              WHERE upload.account_id = ${input.account_id}::uuid
                AND upload.project_id = ${input.project_id}::uuid
                AND upload.upload_id = ${input.upload_id}::uuid
                AND upload.object_key = ${input.object_key}
                AND upload.status = 'pending'
              RETURNING *
            ), updated AS (
              UPDATE kortix.studio_asset_uploads upload
              SET status = 'finalized',
                  finalized_asset_id = inserted.asset_id,
                  updated_at = clock_timestamp()
              FROM inserted
              WHERE upload.upload_id = ${input.upload_id}::uuid
                AND upload.status = 'pending'
              RETURNING upload.upload_id
            )
            SELECT pg_catalog.to_jsonb(inserted) AS asset_row
            FROM inserted
            JOIN updated ON true
            LIMIT 1
          `);
          const row = recordValue(rowsFromExecute(result)[0]?.asset_row);
          if (!row) throw new Error('Studio upload finalization lost its locked pending row');
          return { outcome: 'finalized' as const, asset: serializeRawAsset(row) };
        },
        { isolationLevel: 'read committed' },
      );
    },

    async listAssets(projectId, limit, cursor) {
      const conditions = [eq(studioAssets.projectId, projectId)];
      if (cursor) conditions.push(lt(studioAssets.createdAt, cursor));
      const rows = await db
        .select()
        .from(studioAssets)
        .where(and(...conditions))
        .orderBy(desc(studioAssets.createdAt))
        .limit(limit + 1);
      const page = rows.slice(0, limit).map(serializeAsset);
      return {
        items: page,
        next_cursor: rows.length > limit ? rows[limit].createdAt : null,
      };
    },

    async getAsset(projectId, assetId) {
      const rows = await db
        .select()
        .from(studioAssets)
        .where(and(eq(studioAssets.projectId, projectId), eq(studioAssets.assetId, assetId)))
        .limit(1);
      return rows[0] ? serializeAsset(rows[0]) : null;
    },
  };
}
