import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import {
  ModuleServiceCapabilityRequestSchema,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
} from '@kortix/api-contract';
import { type RegistryModuleManifest, validateRegistryModuleManifest } from '@kortix/registry';

import { isoTimestamp, nullableIsoTimestamp } from '../shared/iso-timestamp';
import {
  type AppendModuleServiceAuditInput,
  ModuleServiceCapabilityError,
  type ModuleServiceCapabilityGrant,
  type ModuleServiceCapabilityRepository,
  type ModuleServiceConsent,
  type ModuleServiceInstallationContext,
} from './capability-grants';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Executor = Pick<Database, 'execute'> | Pick<Transaction, 'execute'>;
type Row = Record<string, unknown>;

function rows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Row[] }).rows;
  }
  return [];
}

function value(row: Row, camel: string, snake: string): unknown {
  return row[camel] ?? row[snake];
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function prefixedKeys(prefix: string, name: string): [string, string] {
  const camel = prefix ? `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}` : name;
  const snake = prefix ? `${prefix}_${snakeCase(name)}` : snakeCase(name);
  return [camel, snake];
}

function field(row: Row, prefix: string, name: string): unknown {
  const [camel, snake] = prefixedKeys(prefix, name);
  return value(row, camel, snake);
}

function fieldString(row: Row, prefix: string, name: string): string {
  const candidate = field(row, prefix, name);
  if (typeof candidate !== 'string') {
    throw new TypeError(`Missing module service row field ${prefix}${name}`);
  }
  return candidate;
}

function fieldNullableString(row: Row, prefix: string, name: string): string | null {
  const candidate = field(row, prefix, name);
  return candidate === null || candidate === undefined ? null : String(candidate);
}

function fieldNumber(row: Row, prefix: string, name: string): number {
  const candidate = Number(field(row, prefix, name));
  if (!Number.isSafeInteger(candidate)) {
    throw new TypeError(`Missing module service row field ${prefix}${name}`);
  }
  return candidate;
}

function timestampValue(row: Row, prefix: string, name: string): string {
  const candidate = field(row, prefix, name);
  return isoTimestamp(candidate, `module service timestamp ${prefix}${name}`);
}

function nullableTimestampValue(row: Row, prefix: string, name: string): string | null {
  const candidate = field(row, prefix, name);
  return nullableIsoTimestamp(candidate, `module service timestamp ${prefix}${name}`);
}

function jsonValue(row: Row, camel: string, snake: string): unknown {
  const candidate = value(row, camel, snake);
  if (typeof candidate !== 'string') return candidate;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function operations(row: Row, service: OpenOpcServiceName, prefix = ''): OpenOpcServiceOperation[] {
  const candidate = field(row, prefix, 'operations');
  const parsed = ModuleServiceCapabilityRequestSchema.safeParse({
    service,
    operations:
      typeof candidate === 'string'
        ? jsonValue({ operations: candidate }, 'operations', 'operations')
        : candidate,
  });
  if (!parsed.success) throw new TypeError('Invalid module service operations row');
  return [...parsed.data.operations];
}

function manifest(row: Row, prefix = ''): RegistryModuleManifest {
  const candidate = field(row, prefix, 'manifest');
  const parsed =
    typeof candidate === 'string'
      ? jsonValue({ manifest: candidate }, 'manifest', 'manifest')
      : candidate;
  const result = validateRegistryModuleManifest(parsed);
  if (!result.valid) throw new TypeError('Invalid module service release manifest');
  return parsed as RegistryModuleManifest;
}

function installation(row: Row, prefix = ''): ModuleServiceInstallationContext {
  const installationStatus = fieldString(row, prefix, 'installationStatus');
  if (installationStatus !== 'active' && installationStatus !== 'blocked') {
    throw new TypeError('Invalid module service installation status');
  }
  return {
    accountId: fieldString(row, prefix, 'accountId'),
    projectId: fieldString(row, prefix, 'projectId'),
    installationId: fieldString(row, prefix, 'installationId'),
    installRevision: fieldNumber(row, prefix, 'installRevision'),
    releaseId: fieldString(row, prefix, 'releaseId'),
    moduleId: fieldString(row, prefix, 'moduleId'),
    moduleVersion: fieldString(row, prefix, 'moduleVersion'),
    installationStatus,
    releaseStatus: fieldString(row, prefix, 'releaseStatus'),
    signatureAlgorithm: fieldNullableString(row, prefix, 'signatureAlgorithm'),
    signature: fieldNullableString(row, prefix, 'signature'),
    signedAt: nullableTimestampValue(row, prefix, 'signedAt'),
    manifest: manifest(row, prefix),
  };
}

function consent(row: Row, prefix = ''): ModuleServiceConsent {
  const service = fieldString(row, prefix, 'service') as OpenOpcServiceName;
  return {
    consentId: fieldString(row, prefix, 'consentId'),
    accountId: fieldString(row, prefix, 'accountId'),
    projectId: fieldString(row, prefix, 'projectId'),
    installationId: fieldString(row, prefix, 'installationId'),
    releaseId: fieldString(row, prefix, 'releaseId'),
    installRevision: fieldNumber(row, prefix, 'installRevision'),
    service,
    operations: operations(row, service, prefix),
    consentDigest: fieldString(row, prefix, 'consentDigest') as `sha256:${string}`,
    acceptedBy: fieldString(row, prefix, 'acceptedBy'),
    acceptedAt: timestampValue(row, prefix, 'acceptedAt'),
    revokedBy: fieldNullableString(row, prefix, 'revokedBy'),
    revokedAt: nullableTimestampValue(row, prefix, 'revokedAt'),
  };
}

function grant(row: Row, prefix = ''): ModuleServiceCapabilityGrant {
  const service = fieldString(row, prefix, 'service') as OpenOpcServiceName;
  return {
    grantId: fieldString(row, prefix, 'grantId'),
    accountId: fieldString(row, prefix, 'accountId'),
    projectId: fieldString(row, prefix, 'projectId'),
    installationId: fieldString(row, prefix, 'installationId'),
    releaseId: fieldString(row, prefix, 'releaseId'),
    consentId: fieldString(row, prefix, 'consentId'),
    service,
    operations: operations(row, service, prefix),
    tokenHash: fieldString(row, prefix, 'tokenHash') as `sha256:${string}`,
    expiresAt: timestampValue(row, prefix, 'expiresAt'),
    revokedAt: nullableTimestampValue(row, prefix, 'revokedAt'),
    createdAt: timestampValue(row, prefix, 'createdAt'),
  };
}

const installationProjection = sql`
  installation.account_id AS "accountId",
  installation.project_id AS "projectId",
  installation.installation_id AS "installationId",
  installation.install_revision AS "installRevision",
  installation.active_release_id AS "releaseId",
  installation.module_id AS "moduleId",
  installation.active_version AS "moduleVersion",
  installation.status AS "installationStatus",
  release.status AS "releaseStatus",
  release.signature_algorithm AS "signatureAlgorithm",
  release.signature AS "signature",
  release.signed_at AS "signedAt",
  release.manifest AS "manifest"
`;

const consentProjection = sql`
  consent.consent_id AS "consentId",
  consent.account_id AS "accountId",
  consent.project_id AS "projectId",
  consent.installation_id AS "installationId",
  consent.release_id AS "releaseId",
  consent.install_revision AS "installRevision",
  consent.service AS "service",
  consent.operations AS "operations",
  consent.consent_digest AS "consentDigest",
  consent.accepted_by AS "acceptedBy",
  consent.accepted_at AS "acceptedAt",
  consent.revoked_by AS "revokedBy",
  consent.revoked_at AS "revokedAt"
`;

async function appendAudit(
  executor: Executor,
  input: AppendModuleServiceAuditInput,
): Promise<void> {
  await executor.execute(sql`
    INSERT INTO kortix.module_service_audit_events (
      event_id, account_id, project_id, installation_id, release_id, grant_id,
      service, operation, outcome, code, request_id, created_at
    ) VALUES (
      ${input.eventId}, ${input.accountId}, ${input.projectId}, ${input.installationId},
      ${input.releaseId}, ${input.grantId}, ${input.service}, ${input.operation},
      ${input.outcome}, ${input.code}, ${input.requestId}, ${input.createdAt}
    )
  `);
}

export function createDrizzleModuleServiceCapabilityRepository(
  db: Database,
): ModuleServiceCapabilityRepository {
  return {
    async resolveInstallation(input) {
      const result = await db.execute(sql`
        SELECT ${installationProjection}
        FROM kortix.project_module_installations installation
        INNER JOIN kortix.developer_module_releases release
          ON release.release_id = installation.active_release_id
        WHERE installation.account_id = ${input.accountId}
          AND installation.project_id = ${input.projectId}
          AND installation.installation_id = ${input.installationId}
        LIMIT 1
      `);
      const row = rows(result)[0];
      return row ? installation(row) : null;
    },

    async listConsents(input) {
      const result = await db.execute(sql`
        SELECT ${consentProjection}
        FROM kortix.project_module_service_consents consent
        WHERE consent.account_id = ${input.accountId}
          AND consent.project_id = ${input.projectId}
          AND consent.installation_id = ${input.installationId}
        ORDER BY consent.accepted_at DESC, consent.consent_id DESC
      `);
      return rows(result).map((row) => consent(row));
    },

    async findActiveConsent(input) {
      const result = await db.execute(sql`
        SELECT ${consentProjection}
        FROM kortix.project_module_service_consents consent
        WHERE consent.account_id = ${input.accountId}
          AND consent.project_id = ${input.projectId}
          AND consent.installation_id = ${input.installationId}
          AND consent.release_id = ${input.releaseId}
          AND consent.install_revision = ${input.installRevision}
          AND consent.service = ${input.service}
          AND consent.revoked_at IS NULL
        LIMIT 1
      `);
      const row = rows(result)[0];
      return row ? consent(row) : null;
    },

    async createConsent(input) {
      return db.transaction(async (tx) => {
        const locked = rows(
          await tx.execute(sql`
            SELECT installation.installation_id AS "installationId"
            FROM kortix.project_module_installations installation
            INNER JOIN kortix.developer_module_releases release
              ON release.release_id = installation.active_release_id
            WHERE installation.account_id = ${input.consent.accountId}
              AND installation.project_id = ${input.consent.projectId}
              AND installation.installation_id = ${input.consent.installationId}
              AND installation.install_revision = ${input.consent.installRevision}
              AND installation.active_release_id = ${input.consent.releaseId}
              AND installation.status = 'active'
              AND release.status = 'published'
            FOR UPDATE OF installation, release
          `),
        )[0];
        if (!locked) throw new ModuleServiceCapabilityError('MODULE_SERVICE_CONFLICT', 409);
        const inserted = rows(
          await tx.execute(sql`
            INSERT INTO kortix.project_module_service_consents (
              consent_id, account_id, project_id, installation_id, release_id,
              install_revision, service, operations, consent_digest, accepted_by, accepted_at
            ) VALUES (
              ${input.consent.consentId}, ${input.consent.accountId}, ${input.consent.projectId},
              ${input.consent.installationId}, ${input.consent.releaseId},
              ${input.consent.installRevision}, ${input.consent.service},
              ${JSON.stringify(input.consent.operations)}::jsonb, ${input.consent.consentDigest},
              ${input.consent.acceptedBy}, ${input.consent.acceptedAt}
            )
            RETURNING
              consent_id AS "consentId", account_id AS "accountId", project_id AS "projectId",
              installation_id AS "installationId", release_id AS "releaseId",
              install_revision AS "installRevision", service, operations,
              consent_digest AS "consentDigest", accepted_by AS "acceptedBy",
              accepted_at AS "acceptedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt"
          `),
        )[0];
        if (!inserted) throw new ModuleServiceCapabilityError('MODULE_SERVICE_CONFLICT', 409);
        await appendAudit(tx, input.audit);
        return consent(inserted);
      });
    },

    async storeGrant(input) {
      return db.transaction(async (tx) => {
        const locked = rows(
          await tx.execute(sql`
            SELECT consent.consent_id AS "consentId"
            FROM kortix.project_module_service_consents consent
            INNER JOIN kortix.project_module_installations installation
              ON installation.installation_id = consent.installation_id
             AND installation.project_id = consent.project_id
             AND installation.account_id = consent.account_id
            INNER JOIN kortix.developer_module_releases release
              ON release.release_id = consent.release_id
             AND release.account_id = consent.account_id
            WHERE consent.consent_id = ${input.consentId}
              AND consent.account_id = ${input.accountId}
              AND consent.project_id = ${input.projectId}
              AND consent.installation_id = ${input.installationId}
              AND consent.release_id = ${input.releaseId}
              AND consent.install_revision = ${input.installRevision}
              AND consent.service = ${input.service}
              AND consent.operations @> ${JSON.stringify(input.operations)}::jsonb
              AND consent.revoked_at IS NULL
              AND installation.install_revision = ${input.installRevision}
              AND installation.active_release_id = ${input.releaseId}
              AND installation.status = 'active'
              AND release.status = 'published'
            FOR UPDATE OF consent, installation, release
          `),
        )[0];
        if (!locked) throw new ModuleServiceCapabilityError('MODULE_SERVICE_CONFLICT', 409);
        const inserted = rows(
          await tx.execute(sql`
            INSERT INTO kortix.module_service_capability_grants (
              grant_id, account_id, project_id, installation_id, release_id,
              consent_id, service, operations, token_hash, expires_at, created_at
            ) VALUES (
              ${input.grantId}, ${input.accountId}, ${input.projectId}, ${input.installationId},
              ${input.releaseId}, ${input.consentId}, ${input.service},
              ${JSON.stringify(input.operations)}::jsonb, ${input.tokenHash},
              ${input.expiresAt}, ${input.createdAt}
            )
            RETURNING
              grant_id AS "grantId", account_id AS "accountId", project_id AS "projectId",
              installation_id AS "installationId", release_id AS "releaseId",
              consent_id AS "consentId", service, operations, token_hash AS "tokenHash",
              expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"
          `),
        )[0];
        if (!inserted) throw new ModuleServiceCapabilityError('MODULE_SERVICE_CONFLICT', 409);
        await appendAudit(tx, input.audit);
        return grant(inserted);
      });
    },

    async getAuthorization(grantId) {
      const result = await db.execute(sql`
        SELECT
          capability_grant.grant_id AS "grant_grant_id",
          capability_grant.account_id AS "grant_account_id",
          capability_grant.project_id AS "grant_project_id",
          capability_grant.installation_id AS "grant_installation_id",
          capability_grant.release_id AS "grant_release_id",
          capability_grant.consent_id AS "grant_consent_id",
          capability_grant.service AS "grant_service",
          capability_grant.operations AS "grant_operations",
          capability_grant.token_hash AS "grant_token_hash",
          capability_grant.expires_at AS "grant_expires_at",
          capability_grant.revoked_at AS "grant_revoked_at",
          capability_grant.created_at AS "grant_created_at",
          consent.consent_id AS "consent_consent_id",
          consent.account_id AS "consent_account_id",
          consent.project_id AS "consent_project_id",
          consent.installation_id AS "consent_installation_id",
          consent.release_id AS "consent_release_id",
          consent.install_revision AS "consent_install_revision",
          consent.service AS "consent_service",
          consent.operations AS "consent_operations",
          consent.consent_digest AS "consent_consent_digest",
          consent.accepted_by AS "consent_accepted_by",
          consent.accepted_at AS "consent_accepted_at",
          consent.revoked_by AS "consent_revoked_by",
          consent.revoked_at AS "consent_revoked_at",
          installation.account_id AS "installation_account_id",
          installation.project_id AS "installation_project_id",
          installation.installation_id AS "installation_installation_id",
          installation.install_revision AS "installation_install_revision",
          installation.active_release_id AS "installation_release_id",
          installation.module_id AS "installation_module_id",
          installation.active_version AS "installation_module_version",
          installation.status AS "installation_installation_status",
          release.status AS "installation_release_status",
          release.signature_algorithm AS "installation_signature_algorithm",
          release.signature AS "installation_signature",
          release.signed_at AS "installation_signed_at",
          release.manifest AS "installation_manifest"
        FROM kortix.module_service_capability_grants capability_grant
        INNER JOIN kortix.project_module_service_consents consent
          ON consent.consent_id = capability_grant.consent_id
        INNER JOIN kortix.project_module_installations installation
          ON installation.installation_id = capability_grant.installation_id
         AND installation.project_id = capability_grant.project_id
         AND installation.account_id = capability_grant.account_id
        INNER JOIN kortix.developer_module_releases release
          ON release.release_id = installation.active_release_id
        WHERE capability_grant.grant_id = ${grantId}
        LIMIT 1
      `);
      const row = rows(result)[0];
      return row
        ? {
            grant: grant(row, 'grant'),
            consent: consent(row, 'consent'),
            installation: installation(row, 'installation'),
          }
        : null;
    },

    async revokeByConsent(input) {
      return db.transaction(async (tx) => {
        const locked = rows(
          await tx.execute(sql`
            SELECT ${consentProjection}
            FROM kortix.project_module_service_consents consent
            WHERE consent.consent_id = ${input.consentId}
              AND consent.revoked_at IS NULL
            FOR UPDATE OF consent
          `),
        )[0];
        if (!locked) return null;
        const current = consent(locked);
        const updated = rows(
          await tx.execute(sql`
            UPDATE kortix.project_module_service_consents
            SET revoked_by = ${input.actorUserId}, revoked_at = ${input.revokedAt}
            WHERE consent_id = ${input.consentId} AND revoked_at IS NULL
            RETURNING
              consent_id AS "consentId", account_id AS "accountId", project_id AS "projectId",
              installation_id AS "installationId", release_id AS "releaseId",
              install_revision AS "installRevision", service, operations,
              consent_digest AS "consentDigest", accepted_by AS "acceptedBy",
              accepted_at AS "acceptedAt", revoked_by AS "revokedBy", revoked_at AS "revokedAt"
          `),
        )[0];
        if (!updated) throw new ModuleServiceCapabilityError('MODULE_SERVICE_CONFLICT', 409);
        const revokedGrants = rows(
          await tx.execute(sql`
            UPDATE kortix.module_service_capability_grants
            SET revoked_at = ${input.revokedAt}
            WHERE consent_id = ${input.consentId} AND revoked_at IS NULL
            RETURNING grant_id AS "grantId"
          `),
        );
        await appendAudit(tx, {
          eventId: input.auditEventId,
          accountId: current.accountId,
          projectId: current.projectId,
          installationId: current.installationId,
          releaseId: current.releaseId,
          grantId: null,
          service: current.service,
          operation: null,
          outcome: 'revoked',
          code: null,
          requestId: input.requestId,
          createdAt: input.revokedAt,
        });
        return { consent: consent(updated), revokedGrantCount: revokedGrants.length };
      });
    },

    async appendAudit(input) {
      await appendAudit(db, input);
    },
  };
}
