import type { StudioCredentialLookup, StudioEncryptedCredentialRow } from '../../api/src/studio/credentials';
import type { StudioSqlClient } from './postgres';

export class PostgresStudioCredentialLookup implements StudioCredentialLookup {
  constructor(private readonly client: StudioSqlClient) {}

  async findSharedSecret(input: {
    accountId: string;
    projectId: string;
    identifier: string;
  }): Promise<StudioEncryptedCredentialRow | null> {
    const rows = await this.client.unsafe(
      `
      SELECT
        secret.project_id,
        secret.value_enc,
        md5(jsonb_build_object(
          'secret_id', secret.secret_id,
          'identifier', secret.identifier,
          'active', secret.active,
          'updated_at', secret.updated_at
        )::text) AS version_token
      FROM kortix.project_secrets secret
      JOIN kortix.projects project ON project.project_id = secret.project_id
      WHERE secret.project_id = $1::uuid
        AND project.account_id = $2::uuid
        AND secret.identifier = $3
        AND secret.owner_user_id IS NULL
        AND secret.active = true
        AND btrim(secret.value_enc) <> ''
      LIMIT 1
      `,
      [input.projectId, input.accountId, input.identifier],
    );
    return mapCredentialRow(rows[0]);
  }

  async findActiveDefaultConnectorCredential(input: {
    accountId: string;
    projectId: string;
    slug: string;
  }): Promise<StudioEncryptedCredentialRow | null> {
    const rows = await this.client.unsafe(
      `
      SELECT
        connector.project_id,
        credential.value_enc,
        md5(jsonb_build_object(
          'connector_id', connector.connector_id,
          'profile_id', profile.profile_id,
          'credential_id', credential.credential_id,
          'connector_updated_at', connector.updated_at,
          'profile_updated_at', profile.updated_at,
          'credential_updated_at', credential.updated_at
        )::text) AS version_token
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
      WHERE connector.project_id = $1::uuid
        AND connector.account_id = $2::uuid
        AND connector.slug = $3
        AND connector.enabled = true
        AND connector.status = 'active'
        AND btrim(credential.value_enc) <> ''
      LIMIT 1
      `,
      [input.projectId, input.accountId, input.slug],
    );
    return mapCredentialRow(rows[0]);
  }
}

function mapCredentialRow(row: Record<string, unknown> | undefined): StudioEncryptedCredentialRow | null {
  if (!row) return null;
  const projectId = typeof row.project_id === 'string' ? row.project_id : '';
  const valueEnc = typeof row.value_enc === 'string' ? row.value_enc : '';
  const versionToken = typeof row.version_token === 'string' ? row.version_token : '';
  return projectId && valueEnc && versionToken
    ? { project_id: projectId, value_enc: valueEnc, version_token: versionToken }
    : null;
}
