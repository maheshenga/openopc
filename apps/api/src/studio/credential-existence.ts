import type { StudioCredentialBinding } from '@kortix/api-contract';
import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';
import type { StudioCredentialBindingExists } from './index';

function firstRow(value: unknown): Record<string, unknown> | null {
  if (!value || typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function') {
    return null;
  }
  return Array.from(value as Iterable<Record<string, unknown>>)[0] ?? null;
}

export function createStudioCredentialBindingExists(
  database: Pick<Database, 'execute'>,
): StudioCredentialBindingExists {
  return async ({ accountId, projectId, binding }) => {
    if (binding.kind === 'none') return true;
    const result = await database.execute(
      binding.kind === 'secret'
        ? sharedSecretExistsQuery({ accountId, projectId, binding })
        : connectorCredentialExistsQuery({ accountId, projectId, binding }),
    );
    return firstRow(result)?.credential_exists === true;
  };
}

function sharedSecretExistsQuery(input: {
  accountId: string;
  projectId: string;
  binding: Extract<StudioCredentialBinding, { kind: 'secret' }>;
}) {
  return sql`
    SELECT EXISTS (
      SELECT 1
      FROM kortix.project_secrets secret
      JOIN kortix.projects project
        ON project.project_id = secret.project_id
      WHERE secret.project_id = ${input.projectId}::uuid
        AND project.account_id = ${input.accountId}::uuid
        AND secret.identifier = ${input.binding.identifier}
        AND secret.owner_user_id IS NULL
        AND secret.active = true
        AND btrim(secret.value_enc) <> ''
    ) AS credential_exists
  `;
}

function connectorCredentialExistsQuery(input: {
  accountId: string;
  projectId: string;
  binding: Extract<StudioCredentialBinding, { kind: 'connector' }>;
}) {
  return sql`
    SELECT EXISTS (
      SELECT 1
      FROM kortix.executor_connectors connector
      JOIN kortix.projects project
        ON project.project_id = connector.project_id
       AND project.account_id = connector.account_id
      JOIN kortix.executor_connection_profiles profile
        ON profile.connector_id = connector.connector_id
       AND profile.account_id = connector.account_id
       AND profile.project_id = connector.project_id
       AND profile.is_default = true
       AND profile.status = 'active'
      JOIN kortix.executor_credentials credential
        ON credential.connector_id = connector.connector_id
       AND credential.profile_id = profile.profile_id
      WHERE connector.project_id = ${input.projectId}::uuid
        AND connector.account_id = ${input.accountId}::uuid
        AND connector.slug = ${input.binding.slug}
        AND connector.enabled = true
        AND connector.status = 'active'
        AND btrim(credential.value_enc) <> ''
    ) AS credential_exists
  `;
}
