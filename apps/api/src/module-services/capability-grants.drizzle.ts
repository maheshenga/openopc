import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import {
  ModuleServiceCapabilityRequestSchema,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
} from '@kortix/api-contract';
import { type RegistryModuleManifest, validateRegistryModuleManifest } from '@kortix/registry';

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

function stringValue(row: Row, camel: string, snake: string): string {
  const candidate = value(row, camel, snake);
  if (typeof candidate !== 'string')
    throw new TypeError(`Missing module service row field ${camel}`);
  return candidate;
}

function nullableString(row: Row, camel: string, snake: string): string | null {
  const candidate = value(row, camel, snake);
  return candidate === null || candidate === undefined ? null : String(candidate);
}

function timestampString(row: Row, camel: string, snake: string): string {
  const candidate = value(row, camel, snake);
  const parsed = candidate instanceof Date ? candidate : new Date(String(candidate));
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Invalid module service row timestamp ${camel}`);
  }
  return parsed.toISOString();
}

function nullableTimestampString(row: Row, camel: string, snake: string): string | null {
  const candidate = value(row, camel, snake);
  if (candidate === null || candidate === undefined) return null;
  return timestampString(row, camel, snake);
}

function numberValue(row: Row, camel: string, snake: string): number {
  const candidate = Number(value(row, camel, snake));
  if (!Number.isSafeInteger(candidate)) {
    throw new TypeError(`Missing module service row field ${camel}`);
  }
  return candidate;
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

function prefixedKey(prefix: string, name: string): string {
  return prefix
    ? `${prefix}${name.slice(0, 1).toUpperCase()}${name.slice(1)}`
    : name;
}

function operations(
  row: Row,
  service: OpenOpcServiceName,
  camel = 'operations',
): OpenOpcServiceOperation[] {
  const parsed = ModuleServiceCapabilityRequestSchema.safeParse({
    service,
    operations: jsonValue(
      row,
      camel,
      camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    ),
  });
  if (!parsed.success) throw new TypeError('Invalid module service operations row');
  return [...parsed.data.operations];
}

function manifest(row: Row, camel = 'manifest'): RegistryModuleManifest {
  const candidate = jsonValue(row, camel, camel);
  const result = validateRegistryModuleManifest(candidate);
  if (!result.valid) throw new TypeError('Invalid module service release manifest');
  return candidate as RegistryModuleManifest;
}

function installation(row: Row, prefix = ''): ModuleServiceInstallationContext {
  const key = (name: string) => prefixedKey(prefix, name);
  const installationStatus = stringValue(row, key('installationStatus'), 'installation_status');
  if (installationStatus !== 'active' && installationStatus !== 'blocked') {
    throw new TypeError('Invalid module service installation status');
  }
  return {
    accountId: stringValue(row, key('accountId'), 'account_id'),
    projectId: stringValue(row, key('projectId'), 'project_id'),
    installationId: stringValue(row, key('installationId'), 'installation_id'),
    installRevision: numberValue(row, key('installRevision'), 'install_revision'),
    releaseId: stringValue(row, key('releaseId'), 'release_id'),
    moduleId: stringValue(row, key('moduleId'), 'module_id'),
    moduleVersion: stringValue(row, key('moduleVersion'), 'module_version'),
    installationStatus,
    releaseStatus: stringValue(row, key('releaseStatus'), 'release_status'),
    signatureAlgorithm: nullableString(row, key('signatureAlgorithm'), 'signature_algorithm'),
    signature: nullableString(row, key('signature'), 'signature'),
    signedAt: nullableTimestampString(row, key('signedAt'), 'signed_at'),
    manifest: manifest(row, key('manifest')),
  };
}

function consent(row: Row, prefix = ''): ModuleServiceConsent {
  const key = (name: string) => prefixedKey(prefix, name);
  const service = stringValue(row, key('service'), 'service') as OpenOpcServiceName;
  return {
    consentId: stringValue(row, key('consentId'), 'consent_id'),
    accountId: stringValue(row, key('accountId'), 'account_id'),
    projectId: stringValue(row, key('projectId'), 'project_id'),
    installationId: stringValue(row, key('installationId'), 'installation_id'),
    releaseId: stringValue(row, key('releaseId'), 'release_id'),
    installRevision: numberValue(row, key('installRevision'), 'install_revision'),
    service,
    operations: operations(row, service, key('operations')),
    consentDigest: stringValue(row, key('consentDigest'), 'consent_digest') as `sha256:${string}`,
    acceptedBy: stringValue(row, key('acceptedBy'), 'accepted_by'),
    acceptedAt: timestampString(row, key('acceptedAt'), 'accepted_at'),
    revokedBy: nullableString(row, key('revokedBy'), 'revoked_by'),
    revokedAt: nullableTimestampString(row, key('revokedAt'), 'revoked_at'),
  };
}

function grant(row: Row, prefix = ''): ModuleServiceCapabilityGrant {
  const key = (name: string) => prefixedKey(prefix, name);
  const service = stringValue(row, key('service'), 'service') as OpenOpcServiceName;
  return {
    grantId: stringValue(row, key('grantId'), 'grant_id'),
    accountId: stringValue(row, key('accountId'), 'account_id'),
    projectId: stringValue(row, key('projectId'), 'project_id'),
    installationId: stringValue(row, key('installationId'), 'installation_id'),
    releaseId: stringValue(row, key('releaseId'), 'release_id'),
    consentId: stringValue(row, key('consentId'), 'consent_id'),
    service,
    operations: operations(row, service, key('operations')),
    tokenHash: stringValue(row, key('tokenHash'), 'token_hash') as `sha256:${string}`,
    expiresAt: timestampString(row, key('expiresAt'), 'expires_at'),
    revokedAt: nullableTimestampString(row, key('revokedAt'), 'revoked_at'),
    createdAt: timestampString(row, key('createdAt'), 'created_at'),
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

const grantProjection = sql`
  capability_grant.grant_id AS "grantId",
  capability_grant.account_id AS "accountId",
  capability_grant.project_id AS "projectId",
  capability_grant.installation_id AS "installationId",
  capability_grant.release_id AS "releaseId",
  capability_grant.consent_id AS "consentId",
  capability_grant.service AS "service",
  capability_grant.operations AS "operations",
  capability_grant.token_hash AS "tokenHash",
  capability_grant.expires_at AS "expiresAt",
  capability_grant.revoked_at AS "revokedAt",
  capability_grant.created_at AS "createdAt"
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
          capability_grant.grant_id AS "grantGrantId",
          capability_grant.account_id AS "grantAccountId",
          capability_grant.project_id AS "grantProjectId",
          capability_grant.installation_id AS "grantInstallationId",
          capability_grant.release_id AS "grantReleaseId",
          capability_grant.consent_id AS "grantConsentId",
          capability_grant.service AS "grantService",
          capability_grant.operations AS "grantOperations",
          capability_grant.token_hash AS "grantTokenHash",
          capability_grant.expires_at AS "grantExpiresAt",
          capability_grant.revoked_at AS "grantRevokedAt",
          capability_grant.created_at AS "grantCreatedAt",
          consent.consent_id AS "consentConsentId",
          consent.account_id AS "consentAccountId",
          consent.project_id AS "consentProjectId",
          consent.installation_id AS "consentInstallationId",
          consent.release_id AS "consentReleaseId",
          consent.install_revision AS "consentInstallRevision",
          consent.service AS "consentService",
          consent.operations AS "consentOperations",
          consent.consent_digest AS "consentConsentDigest",
          consent.accepted_by AS "consentAcceptedBy",
          consent.accepted_at AS "consentAcceptedAt",
          consent.revoked_by AS "consentRevokedBy",
          consent.revoked_at AS "consentRevokedAt",
          installation.account_id AS "installationAccountId",
          installation.project_id AS "installationProjectId",
          installation.installation_id AS "installationInstallationId",
          installation.install_revision AS "installationInstallRevision",
          installation.active_release_id AS "installationReleaseId",
          installation.module_id AS "installationModuleId",
          installation.active_version AS "installationModuleVersion",
          installation.status AS "installationInstallationStatus",
          release.status AS "installationReleaseStatus",
          release.signature_algorithm AS "installationSignatureAlgorithm",
          release.signature AS "installationSignature",
          release.signed_at AS "installationSignedAt",
          release.manifest AS "installationManifest"
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
