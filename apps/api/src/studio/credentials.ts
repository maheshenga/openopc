import type { StudioCredentialResolver, StudioResolvedCredential } from '@kortix/studio-runtime';

export interface StudioEncryptedCredentialRow {
  project_id: string;
  value_enc: string;
  version_token: string;
}

export interface StudioCredentialLookup {
  findSharedSecret(input: {
    accountId: string;
    projectId: string;
    identifier: string;
  }): Promise<StudioEncryptedCredentialRow | null>;
  findActiveDefaultConnectorCredential(input: {
    accountId: string;
    projectId: string;
    slug: string;
  }): Promise<StudioEncryptedCredentialRow | null>;
}

const resolutionError = (): Error => new Error('Studio credential resolution failed');

function isCanonicalNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim();
}

function resolveRow(
  row: StudioEncryptedCredentialRow,
  projectId: string,
  source: StudioResolvedCredential['source'],
  decrypt: (projectId: string, valueEnc: string) => string,
): StudioResolvedCredential {
  if (
    row.project_id !== projectId ||
    typeof row.value_enc !== 'string' ||
    row.value_enc.trim().length === 0 ||
    typeof row.version_token !== 'string' ||
    row.version_token.trim().length === 0
  ) {
    throw resolutionError();
  }

  let value: string;
  try {
    value = decrypt(projectId, row.value_enc);
  } catch {
    throw resolutionError();
  }
  if (typeof value !== 'string' || value.trim().length === 0) throw resolutionError();

  return { source, value, version_token: row.version_token };
}

export function createStudioCredentialResolver(input: {
  lookup: StudioCredentialLookup;
  decrypt: (projectId: string, valueEnc: string) => string;
}): StudioCredentialResolver {
  return {
    async resolve(request) {
      if (
        !isCanonicalNonEmpty(request?.accountId) ||
        !isCanonicalNonEmpty(request?.projectId) ||
        typeof request.binding !== 'object' ||
        request.binding === null
      ) {
        throw resolutionError();
      }

      if (request.binding.kind === 'none') return null;

      let row: StudioEncryptedCredentialRow | null;
      let source: StudioResolvedCredential['source'];
      try {
        if (request.binding.kind === 'secret') {
          if (!isCanonicalNonEmpty(request.binding.identifier)) throw resolutionError();
          source = 'secret';
          row = await input.lookup.findSharedSecret({
            accountId: request.accountId,
            projectId: request.projectId,
            identifier: request.binding.identifier,
          });
        } else if (request.binding.kind === 'connector') {
          if (!isCanonicalNonEmpty(request.binding.slug)) throw resolutionError();
          source = 'connector';
          row = await input.lookup.findActiveDefaultConnectorCredential({
            accountId: request.accountId,
            projectId: request.projectId,
            slug: request.binding.slug,
          });
        } else {
          throw resolutionError();
        }
      } catch {
        throw resolutionError();
      }

      if (row === null) return null;
      try {
        return resolveRow(row, request.projectId, source, input.decrypt);
      } catch {
        throw resolutionError();
      }
    },
  };
}
