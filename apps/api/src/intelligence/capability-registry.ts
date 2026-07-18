import {
  type IntelligenceExecutionTarget,
  IntelligenceExecutionTargetSchema,
  type StudioCapabilityDescriptor,
  StudioCredentialBindingSchema,
  studioPhase1Capabilities,
} from '@kortix/api-contract';
import {
  type CapabilityDescriptor,
  CapabilityDescriptorSchema,
} from '@kortix/intelligence-contracts';
import {
  type StudioProviderDefinitionRegistration,
  fakeStudioDefinitionConfig,
  resolveStudioProviderDefinition,
} from '../studio/providers';
import type {
  StudioProviderConfigRecord,
  StudioProviderConfigWire,
  StudioRepository,
} from '../studio/types';

export interface CapabilityRegistryActor {
  accountId: string;
  userId?: string;
  actorType?: 'user' | 'agent' | 'system';
  actingTokenId?: string | null;
}

export interface ProjectCapabilityRegistryDeps {
  repository: Pick<StudioRepository, 'listProviders' | 'getProviderConfigRecord'>;
  isStorageReady?: () => Promise<boolean>;
  storageReady?: () => Promise<boolean>;
  credentialBindingExists?: (input: {
    accountId: string;
    projectId: string;
    binding: StudioProviderConfigRecord['credential_binding'];
  }) => Promise<boolean>;
  resolveProviderDefinition?: (provider: string) => StudioProviderDefinitionRegistration | null;
}

const phaseCapabilityById = new Map(
  studioPhase1Capabilities.map((capability) => [capability.capability, capability]),
);

export function createProjectCapabilityRegistry(deps: ProjectCapabilityRegistryDeps) {
  const resolveDefinition = deps.resolveProviderDefinition ?? resolveStudioProviderDefinition;
  const checkStorage = deps.isStorageReady ?? deps.storageReady ?? (async () => false);

  const discover = async (projectId: string, actor: CapabilityRegistryActor) => {
    try {
      if (!(await checkStorage())) return emptyDiscovery();
      const providers = [...(await deps.repository.listProviders(projectId))].sort((left, right) =>
        compareStrings(
          `${left.provider_config_id}\u0000${left.provider}`,
          `${right.provider_config_id}\u0000${right.provider}`,
        ),
      );
      const descriptors = new Map<string, CapabilityDescriptor>();
      const executionTargets = new Map<string, IntelligenceExecutionTarget>();

      for (const provider of providers) {
        try {
          if (!isUsableProvider(provider, projectId, actor.accountId)) continue;
          const prepared = await prepareProvider(provider, projectId, actor, deps);
          if (!prepared) continue;
          const registration = resolveDefinition(provider.provider);
          if (!registration) continue;

          const providerCapabilities = registration.definition.capabilities(prepared);
          for (const descriptor of providerCapabilities) {
            if (descriptor.supported_models.length === 0) continue;
            const phaseDescriptor = phaseCapabilityById.get(descriptor.capability);
            if (!phaseDescriptor) continue;
            const mapped = toIntelligenceCapability(phaseDescriptor);
            if (!mapped) continue;
            let hasValidTarget = false;
            for (const model of descriptor.supported_models) {
              const target = IntelligenceExecutionTargetSchema.safeParse({
                capability_id: mapped.id,
                provider_config_id: provider.provider_config_id,
                model,
              });
              if (!target.success) continue;
              hasValidTarget = true;
              executionTargets.set(
                `${target.data.capability_id}\u0000${target.data.provider_config_id}\u0000${target.data.model}`,
                target.data,
              );
            }
            if (hasValidTarget) descriptors.set(`${mapped.id}\u0000${mapped.version}`, mapped);
          }
        } catch {
          // A malformed provider must not hide healthy providers from discovery.
        }
      }

      return {
        capabilities: [...descriptors.values()].sort((left, right) =>
          compareStrings(`${left.id}\u0000${left.version}`, `${right.id}\u0000${right.version}`),
        ),
        executionTargets: [...executionTargets.values()].sort((left, right) =>
          compareStrings(
            `${left.capability_id}\u0000${left.provider_config_id}\u0000${left.model}`,
            `${right.capability_id}\u0000${right.provider_config_id}\u0000${right.model}`,
          ),
        ),
      };
    } catch {
      return emptyDiscovery();
    }
  };

  return {
    discover,
    async list(projectId: string, actor: CapabilityRegistryActor): Promise<CapabilityDescriptor[]> {
      return (await discover(projectId, actor)).capabilities;
    },
  };
}

function emptyDiscovery(): {
  capabilities: CapabilityDescriptor[];
  executionTargets: IntelligenceExecutionTarget[];
} {
  return { capabilities: [], executionTargets: [] };
}

function isUsableProvider(
  provider: StudioProviderConfigWire,
  projectId: string,
  accountId: string,
): boolean {
  return (
    provider.enabled &&
    provider.project_id === projectId &&
    provider.account_id === accountId &&
    (provider.provider === 'fake' || provider.provider === 'openai-compatible') &&
    StudioCredentialBindingSchema.safeParse(provider.credential_binding).success &&
    Array.isArray(provider.capabilities) &&
    provider.capabilities.includes('image.generate')
  );
}

async function prepareProvider(
  provider: StudioProviderConfigWire,
  projectId: string,
  actor: CapabilityRegistryActor,
  deps: ProjectCapabilityRegistryDeps,
): Promise<StudioProviderConfigRecord | ReturnType<typeof fakeStudioDefinitionConfig> | null> {
  const providerBinding = StudioCredentialBindingSchema.safeParse(provider.credential_binding);
  if (!providerBinding.success) return null;
  if (provider.provider === 'fake' && providerBinding.data.kind === 'none') {
    return fakeStudioDefinitionConfig({ providerConfigId: provider.provider_config_id });
  }
  if (provider.provider === 'fake') return null;

  const raw = await deps.repository.getProviderConfigRecord(
    actor.accountId,
    projectId,
    provider.provider_config_id,
  );
  const rawBinding = raw ? StudioCredentialBindingSchema.safeParse(raw.credential_binding) : null;
  if (
    !raw ||
    !rawBinding?.success ||
    !raw.enabled ||
    raw.account_id !== actor.accountId ||
    raw.project_id !== projectId ||
    raw.provider !== provider.provider ||
    raw.provider_config_id !== provider.provider_config_id ||
    rawBinding.data.kind === 'none' ||
    !deps.credentialBindingExists
  ) {
    return null;
  }
  try {
    return (await deps.credentialBindingExists({
      accountId: actor.accountId,
      projectId,
      binding: rawBinding.data,
    }))
      ? raw
      : null;
  } catch {
    return null;
  }
}

function toIntelligenceCapability(
  descriptor: StudioCapabilityDescriptor,
): CapabilityDescriptor | null {
  const [modalityPart, operationPart] = descriptor.capability.split('.', 2);
  const modality = modalityPart as CapabilityDescriptor['modality'];
  if (!['text', 'image', 'video', 'audio', '3d', 'avatar'].includes(modality)) return null;
  const operation = operationPart || 'execute';
  const inputName = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(descriptor.input_schema)
    ? descriptor.input_schema
    : 'StudioInput';
  const outputKinds = descriptor.output_asset_kinds.filter(
    (kind) => typeof kind === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(kind),
  );
  const candidate = {
    id: `studio.${descriptor.capability}`,
    version: `${descriptor.version}.0.0`,
    modality,
    operation,
    input_schema: { type: 'object', name: inputName },
    output_schema: { type: 'array', asset_kinds: outputKinds },
    execution: descriptor.async ? 'async' : 'sync',
    risk: 'write' as const,
    provenance_required: true,
  };
  const parsed = CapabilityDescriptorSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
