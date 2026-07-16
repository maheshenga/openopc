import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { StudioCredentialBinding } from '@kortix/api-contract';
import {
  type StudioCredentialLookup,
  type StudioEncryptedCredentialRow,
  createStudioCredentialResolver,
} from './credentials';

const accountId = '10000000-0000-4000-a000-000000000001';
const projectId = '20000000-0000-4000-a000-000000000001';
const genericError = 'Studio credential resolution failed';

function encryptedRow(
  overrides: Partial<StudioEncryptedCredentialRow> = {},
): StudioEncryptedCredentialRow {
  return {
    project_id: projectId,
    value_enc: 'v1:iv:tag:ciphertext',
    version_token: 'secret:v1',
    ...overrides,
  };
}

function resolverInput(binding: StudioCredentialBinding) {
  return { accountId, projectId, binding };
}

function lookupWith(
  input: {
    secret?: StudioEncryptedCredentialRow | null;
    connector?: StudioEncryptedCredentialRow | null;
    onSecret?: StudioCredentialLookup['findSharedSecret'];
    onConnector?: StudioCredentialLookup['findActiveDefaultConnectorCredential'];
  } = {},
): StudioCredentialLookup {
  return {
    findSharedSecret:
      input.onSecret ?? (async () => (input.secret === undefined ? null : input.secret)),
    findActiveDefaultConnectorCredential:
      input.onConnector ?? (async () => (input.connector === undefined ? null : input.connector)),
  };
}

describe('Studio credential facade', () => {
  test('resolves none without touching lookup or decryption', async () => {
    let lookupCalls = 0;
    let decryptCalls = 0;
    const resolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async () => {
          lookupCalls += 1;
          return encryptedRow();
        },
        onConnector: async () => {
          lookupCalls += 1;
          return encryptedRow();
        },
      }),
      decrypt: () => {
        decryptCalls += 1;
        return 'unused';
      },
    });

    await expect(resolver.resolve(resolverInput({ kind: 'none' }))).resolves.toBeNull();
    expect(lookupCalls).toBe(0);
    expect(decryptCalls).toBe(0);
  });

  test('resolves a shared Secret with exact account, project, and identifier fencing', async () => {
    const calls: unknown[] = [];
    const decryptCalls: unknown[] = [];
    const resolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async (input) => {
          calls.push(input);
          return encryptedRow({ version_token: 'secret:rotated-2' });
        },
        onConnector: async () => {
          throw new Error('connector fallback must not run');
        },
      }),
      decrypt: (resolvedProjectId, valueEnc) => {
        decryptCalls.push({ resolvedProjectId, valueEnc });
        return '  sk-preserve-whitespace  ';
      },
    });

    const result = await resolver.resolve(
      resolverInput({ kind: 'secret', identifier: 'OPENAI_STUDIO_KEY' }),
    );

    expect(calls).toEqual([{ accountId, projectId, identifier: 'OPENAI_STUDIO_KEY' }]);
    expect(decryptCalls).toEqual([
      { resolvedProjectId: projectId, valueEnc: 'v1:iv:tag:ciphertext' },
    ]);
    expect(result).toEqual({
      source: 'secret',
      value: '  sk-preserve-whitespace  ',
      version_token: 'secret:rotated-2',
    });
    expect(Object.keys(result ?? {}).sort()).toEqual(['source', 'value', 'version_token']);
  });

  test('resolves an active default Connector credential by exact slug without Secret fallback', async () => {
    const calls: unknown[] = [];
    const resolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async () => {
          throw new Error('secret fallback must not run');
        },
        onConnector: async (input) => {
          calls.push(input);
          return encryptedRow({ version_token: 'connector:v4' });
        },
      }),
      decrypt: () => 'connector-token',
    });

    await expect(
      resolver.resolve(resolverInput({ kind: 'connector', slug: 'openai-images' })),
    ).resolves.toEqual({
      source: 'connector',
      value: 'connector-token',
      version_token: 'connector:v4',
    });
    expect(calls).toEqual([{ accountId, projectId, slug: 'openai-images' }]);
  });

  test('returns null for missing bindings and never decrypts or crosses binding kinds', async () => {
    let secretCalls = 0;
    let connectorCalls = 0;
    let decryptCalls = 0;
    const resolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async () => {
          secretCalls += 1;
          return null;
        },
        onConnector: async () => {
          connectorCalls += 1;
          return null;
        },
      }),
      decrypt: () => {
        decryptCalls += 1;
        return 'unused';
      },
    });

    await expect(
      resolver.resolve(resolverInput({ kind: 'secret', identifier: 'MISSING_SECRET' })),
    ).resolves.toBeNull();
    expect({ secretCalls, connectorCalls, decryptCalls }).toEqual({
      secretCalls: 1,
      connectorCalls: 0,
      decryptCalls: 0,
    });

    await expect(
      resolver.resolve(resolverInput({ kind: 'connector', slug: 'missing-connector' })),
    ).resolves.toBeNull();
    expect({ secretCalls, connectorCalls, decryptCalls }).toEqual({
      secretCalls: 1,
      connectorCalls: 1,
      decryptCalls: 0,
    });
  });

  test('rejects cross-project, empty ciphertext, and empty version rows before decryption', async () => {
    for (const row of [
      encryptedRow({ project_id: '20000000-0000-4000-a000-000000000099' }),
      encryptedRow({ value_enc: '' }),
      encryptedRow({ value_enc: '   ' }),
      encryptedRow({ version_token: '' }),
      encryptedRow({ version_token: '   ' }),
    ]) {
      let decryptCalls = 0;
      const resolver = createStudioCredentialResolver({
        lookup: lookupWith({ secret: row }),
        decrypt: () => {
          decryptCalls += 1;
          return 'must-not-run';
        },
      });
      await expect(
        resolver.resolve(resolverInput({ kind: 'secret', identifier: 'BOUND_SECRET' })),
      ).rejects.toThrow(genericError);
      expect(decryptCalls).toBe(0);
    }
  });

  test('wraps lookup and decrypt failures without leaking binding names or ciphertext', async () => {
    const lookupResolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async () => {
          throw new Error('database failed for LEAK_ME_IDENTIFIER');
        },
      }),
      decrypt: () => 'unused',
    });
    await expect(
      lookupResolver.resolve(resolverInput({ kind: 'secret', identifier: 'LEAK_ME_IDENTIFIER' })),
    ).rejects.toThrow(new Error(genericError));

    const decryptResolver = createStudioCredentialResolver({
      lookup: lookupWith({ secret: encryptedRow({ value_enc: 'ciphertext-LEAK-ME' }) }),
      decrypt: () => {
        throw new Error('bad ciphertext-LEAK-ME for LEAK_ME_IDENTIFIER');
      },
    });
    try {
      await decryptResolver.resolve(
        resolverInput({ kind: 'secret', identifier: 'LEAK_ME_IDENTIFIER' }),
      );
      throw new Error('expected credential resolution to fail');
    } catch (error) {
      expect(String(error)).toBe(`Error: ${genericError}`);
      expect(String(error)).not.toContain('LEAK_ME_IDENTIFIER');
      expect(String(error)).not.toContain('ciphertext-LEAK-ME');
    }
  });

  test('wraps malformed lookup rows without leaking runtime type errors', async () => {
    for (const malformedRow of [undefined, 'not-a-row']) {
      let decryptCalls = 0;
      const resolver = createStudioCredentialResolver({
        lookup: lookupWith({
          onSecret: async () =>
            malformedRow as unknown as Awaited<
              ReturnType<StudioCredentialLookup['findSharedSecret']>
            >,
        }),
        decrypt: () => {
          decryptCalls += 1;
          return 'must-not-run';
        },
      });

      await expect(
        resolver.resolve(resolverInput({ kind: 'secret', identifier: 'MALFORMED_ROW' })),
      ).rejects.toThrow(new Error(genericError));
      expect(decryptCalls).toBe(0);
    }
  });

  test('rejects empty decrypted plaintext but preserves non-empty plaintext exactly', async () => {
    for (const plaintext of ['', '   ', '\t\r\n']) {
      const resolver = createStudioCredentialResolver({
        lookup: lookupWith({ secret: encryptedRow() }),
        decrypt: () => plaintext,
      });
      await expect(
        resolver.resolve(resolverInput({ kind: 'secret', identifier: 'EMPTY_VALUE' })),
      ).rejects.toThrow(genericError);
    }
  });

  test('does not cache credentials and observes rotation on every resolve call', async () => {
    const rows = [
      encryptedRow({ value_enc: 'ciphertext-v1', version_token: 'secret:v1' }),
      encryptedRow({ value_enc: 'ciphertext-v2', version_token: 'secret:v2' }),
    ];
    const lookupValues: string[] = [];
    const decryptValues: string[] = [];
    const resolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async () => {
          const row = rows.shift() ?? null;
          if (row) lookupValues.push(row.version_token);
          return row;
        },
      }),
      decrypt: (_resolvedProjectId, valueEnc) => {
        decryptValues.push(valueEnc);
        return valueEnc === 'ciphertext-v1' ? 'plaintext-v1' : 'plaintext-v2';
      },
    });
    const input = resolverInput({ kind: 'secret', identifier: 'ROTATING_SECRET' });

    await expect(resolver.resolve(input)).resolves.toEqual({
      source: 'secret',
      value: 'plaintext-v1',
      version_token: 'secret:v1',
    });
    await expect(resolver.resolve(input)).resolves.toEqual({
      source: 'secret',
      value: 'plaintext-v2',
      version_token: 'secret:v2',
    });
    expect(lookupValues).toEqual(['secret:v1', 'secret:v2']);
    expect(decryptValues).toEqual(['ciphertext-v1', 'ciphertext-v2']);
  });

  test('fails closed for malformed runtime bindings and empty scope identifiers', async () => {
    let lookupCalls = 0;
    const resolver = createStudioCredentialResolver({
      lookup: lookupWith({
        onSecret: async () => {
          lookupCalls += 1;
          return encryptedRow();
        },
      }),
      decrypt: () => 'unused',
    });

    for (const input of [
      { accountId: '', projectId, binding: { kind: 'secret', identifier: 'KEY' } },
      { accountId, projectId: '', binding: { kind: 'secret', identifier: 'KEY' } },
      { accountId, projectId, binding: { kind: 'future-provider', value: 'KEY' } },
      { accountId, projectId, binding: null },
    ]) {
      await expect(
        resolver.resolve(input as unknown as Parameters<typeof resolver.resolve>[0]),
      ).rejects.toThrow(genericError);
    }
    expect(lookupCalls).toBe(0);
  });

  test('has no direct imports of API database, config, or Secret route modules', () => {
    const source = readFileSync(new URL('./credentials.ts', import.meta.url), 'utf8');
    for (const forbidden of [
      '@kortix/db',
      '../shared/db',
      '../config',
      '../projects/secrets',
      'decryptProjectSecret',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
