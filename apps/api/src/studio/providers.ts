import {
  type StudioCreateProviderConfigRequest,
  StudioCreateProviderConfigRequestSchema,
  type StudioEstimateResponse,
  type StudioUpdateProviderConfigRequest,
  StudioUpdateProviderConfigRequestSchema,
} from '@kortix/api-contract';
import {
  OPENAI_COMPATIBLE_DEFINITION_ID,
  type StudioResolvedAddress,
  openAiCompatibleImageDefinition,
  parseOpenAiCompatibleCapabilityMap,
  validateStudioOrigin,
} from '@kortix/studio-adapters';
import type {
  StudioCostEstimate,
  StudioPricingSnapshot,
  StudioProviderDefinition,
  StudioProviderDefinitionConfig,
} from '@kortix/studio-runtime';
import type {
  StudioCreateProviderConfigInput,
  StudioProviderConfigRecord,
  StudioProviderConfigRepository,
  StudioProviderConfigWire,
  StudioProviderPricingReference,
} from './types';

export const FAKE_STUDIO_PROVIDER_CONFIG_VERSION = 'fake-provider-definition-v1';
export const FAKE_STUDIO_PRICING_CATALOG_ID = '76000000-0000-4000-a000-000000000001';
export const FAKE_STUDIO_PRICING_VERSION = 1;

export type StudioProviderDefinitionRegistration = {
  definition: StudioProviderDefinition;
  resolvePricingCatalogId(
    config: StudioProviderDefinitionConfig,
    capability: 'image.generate',
    model: string,
  ): string | null;
  lineItems(cost: StudioCostEstimate): StudioEstimateResponse['line_items'];
};

const fakeStudioImageDefinition: StudioProviderDefinition = {
  id: 'fake',
  capabilities(config) {
    return config.provider === 'fake'
      ? [
          {
            capability: 'image.generate',
            version: 1,
            display_name: 'Fake image generation',
            input_schema: 'StudioImageGenerateInput',
            output_asset_kinds: ['image'],
            supported_models: ['fake/image-v1'],
            limits: { min_outputs: 1, max_outputs: 8, max_reference_images: 8 },
            async: true,
            cancellable: true,
            required_credential_type: 'none',
            accepted_credential_types: ['none'],
          },
        ]
      : [];
  },
  validate(config, model, input) {
    if (config.provider !== 'fake' || model !== 'fake/image-v1') {
      return {
        ok: false,
        code: 'STUDIO_MODEL_UNSUPPORTED',
        message: 'Studio model is not supported',
      };
    }
    return input.capability === 'image.generate'
      ? { ok: true }
      : {
          ok: false,
          code: 'STUDIO_VALIDATION_ERROR',
          message: 'Invalid Studio input',
        };
  },
  estimate(config, pricing, input) {
    const validation = this.validate(config, pricing.model, input);
    if (!validation.ok || pricing.pricing_catalog_id !== FAKE_STUDIO_PRICING_CATALOG_ID) {
      throw new Error(validation.ok ? 'Invalid fake Studio pricing' : validation.code);
    }
    const qualityMultiplier = input.image.quality === 'high' ? 2 : 1;
    const providerCredits = input.image.output_count * qualityMultiplier;
    return {
      provider_credits: providerCredits,
      platform_credits: 0,
      max_credits: providerCredits,
    };
  },
};

const registrations = new Map<string, StudioProviderDefinitionRegistration>([
  [
    'openai-compatible',
    {
      definition: openAiCompatibleImageDefinition,
      resolvePricingCatalogId(config, capability, model) {
        const parsed = parseOpenAiCompatibleCapabilityMap(config.capability_map);
        return (
          parsed.capabilities[capability].models.find((candidate) => candidate.model === model)
            ?.pricing_catalog_id ?? null
        );
      },
      lineItems(cost) {
        return [
          { label: 'Provider image generation', credits: cost.provider_credits },
          ...(cost.platform_credits > 0
            ? [{ label: 'Studio platform fee', credits: cost.platform_credits }]
            : []),
        ];
      },
    },
  ],
  [
    'fake',
    {
      definition: fakeStudioImageDefinition,
      resolvePricingCatalogId(_config, capability, model) {
        return capability === 'image.generate' && model === 'fake/image-v1'
          ? FAKE_STUDIO_PRICING_CATALOG_ID
          : null;
      },
      lineItems(cost) {
        return [{ label: 'Fake image generation', credits: cost.provider_credits }];
      },
    },
  ],
]);

export function resolveStudioProviderDefinition(
  provider: string,
): StudioProviderDefinitionRegistration | null {
  return registrations.get(provider) ?? null;
}

export function fakeStudioPricingSnapshot(): StudioPricingSnapshot {
  return {
    pricing_catalog_id: FAKE_STUDIO_PRICING_CATALOG_ID,
    version: FAKE_STUDIO_PRICING_VERSION,
    provider: 'fake',
    model: 'fake/image-v1',
    unit: 'image',
    rate_credits: 1,
    max_provider_credits: 16,
    markup_credits: 0,
  };
}

export function fakeStudioDefinitionConfig(input: {
  providerConfigId: string;
}): StudioProviderDefinitionConfig {
  return {
    provider_config_id: input.providerConfigId,
    provider: 'fake',
    base_url: null,
    region: null,
    capability_map: { capabilities: ['image.generate'] },
    version_token: FAKE_STUDIO_PROVIDER_CONFIG_VERSION,
  };
}

export type StudioProviderConfigServiceResult =
  | { ok: true; value: StudioProviderConfigWire }
  | {
      ok: false;
      code: 'invalid_config' | 'invalid_origin' | 'pricing_invalid' | 'not_found' | 'stale';
    };

export type StudioProviderOriginValidator = (url: URL) => Promise<void>;

export function createStudioProviderOriginValidator(input: {
  resolve: (hostname: string) => Promise<readonly StudioResolvedAddress[]>;
  allowPrivateOrigins: ReadonlySet<string>;
  allowInsecureLocalEndpoints: boolean;
}): StudioProviderOriginValidator {
  return async (url) => {
    await validateStudioOrigin({ url, ...input });
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function toStudioProviderConfigWire(
  record: StudioProviderConfigRecord,
): StudioProviderConfigWire {
  let capabilities: StudioProviderConfigWire['capabilities'] = [];
  try {
    capabilities = openAiCompatibleImageDefinition
      .capabilities(record)
      .map((descriptor) => descriptor.capability)
      .filter((capability): capability is 'image.generate' => capability === 'image.generate');
  } catch {
    capabilities = [];
  }
  return {
    provider_config_id: record.provider_config_id,
    account_id: record.account_id,
    project_id: record.project_id,
    provider: 'openai-compatible',
    display_name: record.display_name,
    base_url: record.base_url,
    region: record.region,
    credential_binding: record.credential_binding,
    capabilities,
    enabled: record.enabled,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

type PreparedProviderConfig =
  | {
      ok: true;
      input: StudioCreateProviderConfigInput;
      pricingReferences: StudioProviderPricingReference[];
    }
  | { ok: false; code: 'invalid_config' | 'invalid_origin' };

async function prepareProviderConfig(input: {
  accountId: string;
  projectId: string;
  request: StudioCreateProviderConfigRequest;
  validateOrigin: StudioProviderOriginValidator;
}): Promise<PreparedProviderConfig> {
  const parsedRequest = StudioCreateProviderConfigRequestSchema.safeParse(input.request);
  if (!parsedRequest.success) return { ok: false, code: 'invalid_config' };
  const request = parsedRequest.data;
  if (
    request.provider !== OPENAI_COMPATIBLE_DEFINITION_ID ||
    request.base_url === null ||
    request.credential_binding.kind === 'none'
  ) {
    return { ok: false, code: 'invalid_config' };
  }

  let capabilityMap: ReturnType<typeof parseOpenAiCompatibleCapabilityMap>;
  let baseUrl: URL;
  try {
    capabilityMap = parseOpenAiCompatibleCapabilityMap(request.capability_map);
    baseUrl = new URL(request.base_url);
  } catch {
    return { ok: false, code: 'invalid_config' };
  }

  const pricingReferences: StudioProviderPricingReference[] = capabilityMap.capabilities[
    'image.generate'
  ].models.map((model) => ({
    pricing_catalog_id: model.pricing_catalog_id,
    provider: request.provider,
    model: model.model,
  }));
  if (pricingReferences.some((reference) => !isUuid(reference.pricing_catalog_id))) {
    return { ok: false, code: 'invalid_config' };
  }

  try {
    await input.validateOrigin(baseUrl);
  } catch {
    return { ok: false, code: 'invalid_origin' };
  }

  return {
    ok: true,
    input: {
      account_id: input.accountId,
      project_id: input.projectId,
      provider: request.provider,
      display_name: request.display_name,
      base_url: baseUrl.toString(),
      region: request.region,
      credential_binding: request.credential_binding,
      capability_map: { ...capabilityMap },
      enabled: request.enabled ?? true,
    },
    pricingReferences,
  };
}

export class StudioProviderConfigService {
  constructor(
    private readonly repository: StudioProviderConfigRepository,
    private readonly options: { validateOrigin: StudioProviderOriginValidator },
  ) {}

  async create(input: {
    accountId: string;
    projectId: string;
    request: StudioCreateProviderConfigRequest;
  }): Promise<StudioProviderConfigServiceResult> {
    const prepared = await prepareProviderConfig({
      ...input,
      validateOrigin: this.options.validateOrigin,
    });
    if (!prepared.ok) return prepared;
    const created = await this.repository.createProviderConfig(
      prepared.input,
      prepared.pricingReferences,
    );
    if (!created.ok) return created;
    return { ok: true, value: toStudioProviderConfigWire(created.value) };
  }

  async update(input: {
    accountId: string;
    projectId: string;
    providerConfigId: string;
    request: StudioUpdateProviderConfigRequest;
  }): Promise<StudioProviderConfigServiceResult> {
    const parsedPatch = StudioUpdateProviderConfigRequestSchema.safeParse(input.request);
    if (!parsedPatch.success) return { ok: false, code: 'invalid_config' };
    const existing = await this.repository.getProviderConfigRecord(
      input.accountId,
      input.projectId,
      input.providerConfigId,
    );
    if (!existing) return { ok: false, code: 'not_found' };
    const patch = parsedPatch.data;
    const prepared = await prepareProviderConfig({
      accountId: input.accountId,
      projectId: input.projectId,
      validateOrigin: this.options.validateOrigin,
      request: {
        provider: 'openai-compatible',
        display_name: patch.display_name ?? existing.display_name,
        base_url: patch.base_url === undefined ? existing.base_url : patch.base_url,
        region: patch.region === undefined ? existing.region : patch.region,
        credential_binding: patch.credential_binding ?? existing.credential_binding,
        capability_map: patch.capability_map ?? existing.capability_map,
        enabled: patch.enabled ?? existing.enabled,
      },
    });
    if (!prepared.ok) return prepared;
    const updated = await this.repository.updateProviderConfig(
      {
        ...prepared.input,
        provider_config_id: existing.provider_config_id,
        created_at: existing.created_at,
      },
      existing.version_token,
      prepared.pricingReferences,
      patch,
    );
    if (!updated.ok) return updated;
    return { ok: true, value: toStudioProviderConfigWire(updated.value) };
  }

  async disable(input: {
    accountId: string;
    projectId: string;
    providerConfigId: string;
  }): Promise<StudioProviderConfigServiceResult> {
    const disabled = await this.repository.disableProviderConfig(
      input.accountId,
      input.projectId,
      input.providerConfigId,
    );
    if (!disabled.ok) return disabled;
    return { ok: true, value: toStudioProviderConfigWire(disabled.value) };
  }
}
