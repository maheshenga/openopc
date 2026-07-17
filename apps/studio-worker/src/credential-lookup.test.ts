import { describe, expect, test } from 'bun:test';
import { PostgresStudioCredentialLookup } from './credential-lookup';

describe('PostgresStudioCredentialLookup', () => {
  test('loads an active shared secret only through the owning account and project', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const lookup = new PostgresStudioCredentialLookup({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [
          {
            project_id: '55555555-5555-4555-8555-555555555555',
            value_enc: 'v1:encrypted',
            version_token: 'secret-version',
          },
        ];
      },
    });

    await expect(
      lookup.findSharedSecret({
        accountId: '44444444-4444-4444-8444-444444444444',
        projectId: '55555555-5555-4555-8555-555555555555',
        identifier: 'IMAGE_PROVIDER',
      }),
    ).resolves.toMatchObject({ value_enc: 'v1:encrypted', version_token: 'secret-version' });
    expect(queries[0]?.text).toContain('JOIN kortix.projects project');
    expect(queries[0]?.text).toContain('secret.owner_user_id IS NULL');
    expect(queries[0]?.text).toContain("secret.active = true");
    expect(queries[0]?.values).toEqual([
      '55555555-5555-4555-8555-555555555555',
      '44444444-4444-4444-8444-444444444444',
      'IMAGE_PROVIDER',
    ]);
  });

  test('loads an active default connector credential by project-owned slug', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const lookup = new PostgresStudioCredentialLookup({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [];
      },
    });

    await expect(
      lookup.findActiveDefaultConnectorCredential({
        accountId: '44444444-4444-4444-8444-444444444444',
        projectId: '55555555-5555-4555-8555-555555555555',
        slug: 'aliyun-media',
      }),
    ).resolves.toBeNull();
    expect(queries[0]?.text).toContain('JOIN kortix.executor_connection_profiles profile');
    expect(queries[0]?.text).toContain("profile.is_default = true");
    expect(queries[0]?.text).toContain('JOIN kortix.executor_credentials credential');
    expect(queries[0]?.text).toContain("connector.status = 'active'");
    expect(queries[0]?.values).toEqual([
      '55555555-5555-4555-8555-555555555555',
      '44444444-4444-4444-8444-444444444444',
      'aliyun-media',
    ]);
  });
});
