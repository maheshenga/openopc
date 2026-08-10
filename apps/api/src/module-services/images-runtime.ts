import { loadRuntimeReleaseProfile } from '../release-profile/runtime';
import { createDefaultStudioModuleImageServices } from '../studio/default-routes';
import { type ModuleImageBackend, type ModuleImageDependencies, ModuleImageError } from './images';
import { StudioModuleImageBackend } from './images-studio';
import { requireModuleServiceOperation } from './service-auth';

export function createRuntimeModuleImageDependencies(): ModuleImageDependencies {
  let studio: ReturnType<typeof createDefaultStudioModuleImageServices> | undefined;
  let backend: ModuleImageBackend | null | undefined;
  const getStudio = () => {
    if (!studio) studio = createDefaultStudioModuleImageServices();
    return studio;
  };
  const getBackend = (): ModuleImageBackend | null => {
    if (backend !== undefined) return backend;
    const services = getStudio();
    backend =
      services.enabled && services.storageService
        ? new StudioModuleImageBackend({
            repository: services.repository,
            storageService: services.storageService,
            estimateSigningSecret: services.estimateSigningSecret,
            credentialBindingExists: services.credentialBindingExists,
          })
        : null;
    return backend;
  };
  return {
    runtime: loadRuntimeReleaseProfile(),
    requireCapability: (authorization, operation) =>
      requireModuleServiceOperation(authorization, { service: 'ai', operation }),
    loadAuthorization: async (grantId) =>
      (await getStudio().loadModuleServiceAuthorization?.(grantId)) ?? null,
    backend: createLazyModuleImageBackend(getBackend),
  };
}

function createLazyModuleImageBackend(
  resolve: () => ModuleImageBackend | null,
): ModuleImageBackend {
  const requireBackend = () => {
    const backend = resolve();
    if (!backend) throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
    return backend;
  };
  return {
    listModels: (scope) => requireBackend().listModels(scope),
    createEstimate: (scope, input) => requireBackend().createEstimate(scope, input),
    createJob: (scope, input) => requireBackend().createJob(scope, input),
    getJob: (scope, jobId) => requireBackend().getJob(scope, jobId),
    listEvents: (scope, jobId, page) => requireBackend().listEvents(scope, jobId, page),
    listJobOutputs: (scope, jobId, page) => requireBackend().listJobOutputs(scope, jobId, page),
    cancelJob: (scope, jobId) => requireBackend().cancelJob(scope, jobId),
    createAsset: (scope, input) => requireBackend().createAsset(scope, input),
    listAssets: (scope, page) => requireBackend().listAssets(scope, page),
    previewAsset: (scope, assetId) => requireBackend().previewAsset(scope, assetId),
    thumbnailAsset: (scope, assetId, preset) =>
      requireBackend().thumbnailAsset(scope, assetId, preset),
    downloadAsset: (scope, assetId) => requireBackend().downloadAsset(scope, assetId),
    deleteAsset: (scope, assetId) => {
      const backend = requireBackend();
      if (!backend.deleteAsset) throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 501);
      return backend.deleteAsset(scope, assetId);
    },
    setAssetRetention: (scope, assetId, policy) => {
      const backend = requireBackend();
      if (!backend.setAssetRetention) {
        throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 501);
      }
      return backend.setAssetRetention(scope, assetId, policy);
    },
  };
}
