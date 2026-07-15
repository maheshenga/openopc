import type { StudioCredentialBinding } from '@kortix/api-contract';

export interface StudioResolvedCredential {
  source: 'secret' | 'connector';
  value: string;
  version_token: string;
}

export interface StudioCredentialResolver {
  resolve(input: {
    accountId: string;
    projectId: string;
    binding: StudioCredentialBinding;
  }): Promise<StudioResolvedCredential | null>;
}
