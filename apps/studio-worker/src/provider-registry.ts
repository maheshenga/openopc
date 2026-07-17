import {
  createFakeStudioProvider,
  type StudioProviderAdapter,
  type StudioReferenceAssetResolver,
  type StudioResolvedCredential,
} from '@kortix/studio-runtime';
import {
  createOpenAiCompatibleImageAdapter,
  OPENAI_COMPATIBLE_DEFINITION_ID,
  parseOpenAiCompatibleCapabilityMap,
  safeStudioFetch,
} from '@kortix/studio-adapters';
import type { StudioWorkerJob, StudioWorkerProviderConfig } from './contracts';

export interface StudioProviderRegistry {
  resolve(input: {
    job: StudioWorkerJob;
    config: StudioWorkerProviderConfig;
    credential: StudioResolvedCredential | null;
    referenceAssets: StudioReferenceAssetResolver;
  }): Promise<StudioProviderAdapter | null>;
}

export function createStudioProviderRegistry(input: {
  fakeProviderEnabled: boolean;
  openAiCompatibleEnabled: boolean;
}): StudioProviderRegistry {
  const fake = input.fakeProviderEnabled ? createFakeStudioProvider() : null;
  return {
    async resolve(request) {
      if (!request.config.enabled || request.config.provider !== request.job.provider) return null;
      if (request.config.provider === 'fake') {
        return request.config.credentialBinding.kind === 'none' && fake ? fake : null;
      }
      if (
        !input.openAiCompatibleEnabled ||
        request.config.definitionId !== OPENAI_COMPATIBLE_DEFINITION_ID ||
        request.config.provider !== OPENAI_COMPATIBLE_DEFINITION_ID ||
        !request.credential
      ) {
        return null;
      }
      const baseUrl = parseSafeBaseUrl(request.config.baseUrl);
      if (!baseUrl) return null;

      let map: ReturnType<typeof parseOpenAiCompatibleCapabilityMap>;
      try {
        map = parseOpenAiCompatibleCapabilityMap(request.config.capabilityMap);
      } catch {
        return null;
      }
      const model = map.capabilities['image.generate'].models.find(
        (candidate) => candidate.model === request.job.model,
      );
      if (!model) return null;

      // The adapter snapshots the resolved credential and model for this invocation.
      void request.referenceAssets;
      return createOpenAiCompatibleImageAdapter({
        baseUrl,
        model,
        credential: request.credential,
        fetch: safeStudioFetch,
      });
    },
  };
}

function parseSafeBaseUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
