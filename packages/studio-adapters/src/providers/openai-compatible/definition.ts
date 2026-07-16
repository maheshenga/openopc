import { StudioJobInputSchema } from '@kortix/api-contract';
import type {
  StudioPricingSnapshot,
  StudioProviderDefinition,
  StudioProviderDefinitionConfig,
  StudioValidationResult,
} from '@kortix/studio-runtime';
import { OPENAI_COMPATIBLE_DEFINITION_ID, parseOpenAiCompatibleCapabilityMap } from './config';

const validationError = (): StudioValidationResult => ({
  ok: false,
  code: 'STUDIO_VALIDATION_ERROR',
  message: 'The image request is not supported by this provider model',
});

function assertDefinitionConfig(config: StudioProviderDefinitionConfig) {
  if (config.provider !== OPENAI_COMPATIBLE_DEFINITION_ID) {
    throw new Error('Studio provider definition does not match provider configuration');
  }
  return parseOpenAiCompatibleCapabilityMap(config.capability_map);
}

export const openAiCompatibleImageDefinition: StudioProviderDefinition = {
  id: OPENAI_COMPATIBLE_DEFINITION_ID,

  capabilities(config) {
    const capabilityMap = assertDefinitionConfig(config);
    const models = capabilityMap.capabilities['image.generate'].models;
    return [
      {
        capability: 'image.generate',
        version: 1,
        display_name: 'Image generation',
        input_schema: 'StudioImageGenerateInput',
        output_asset_kinds: ['image'],
        supported_models: models.map((entry) => entry.model),
        limits: { min_outputs: 1, max_outputs: 8, max_reference_images: 0 },
        async: true,
        cancellable: true,
        required_credential_type: 'secret',
        accepted_credential_types: ['secret', 'connector'],
      },
    ];
  },

  validate(config, requestedModel, input) {
    const capabilityMap = assertDefinitionConfig(config);
    const model = capabilityMap.capabilities['image.generate'].models.find(
      (entry) => entry.model === requestedModel,
    );
    if (!model) {
      return {
        ok: false,
        code: 'STUDIO_MODEL_UNSUPPORTED',
        message: 'The requested model is not enabled for this provider',
      };
    }

    const parsed = StudioJobInputSchema.safeParse(input);
    if (!parsed.success || parsed.data.capability !== 'image.generate') return validationError();
    const image = parsed.data.image;
    if (image.reference_asset_ids.length > 0) return validationError();

    const allowed = new Set(model.allowed_advanced_fields);
    if (image.negative_prompt !== undefined && !allowed.has('negative_prompt')) {
      return validationError();
    }
    if (image.seed !== undefined && !allowed.has('seed')) return validationError();
    if (
      image.advanced &&
      Object.keys(image.advanced).some(
        (field) => !allowed.has(field) || field === 'negative_prompt' || field === 'seed',
      )
    ) {
      return validationError();
    }
    return { ok: true };
  },

  estimate(config, pricing, input) {
    const capabilityMap = assertDefinitionConfig(config);
    const model = capabilityMap.capabilities['image.generate'].models.find(
      (entry) =>
        entry.model === pricing.model && entry.pricing_catalog_id === pricing.pricing_catalog_id,
    );
    if (
      !model ||
      pricing.provider !== config.provider ||
      pricing.unit !== 'image' ||
      !validPricing(pricing)
    ) {
      throw new Error('Studio pricing snapshot does not match provider configuration');
    }
    const validation = this.validate(config, pricing.model, input);
    if (!validation.ok) throw new Error(validation.code);

    const provider = pricing.rate_credits * input.image.output_count;
    const platform = pricing.markup_credits * input.image.output_count;
    if (!Number.isFinite(provider) || !Number.isFinite(platform)) {
      throw new Error('Studio pricing snapshot does not match provider configuration');
    }
    if (provider > pricing.max_provider_credits) {
      throw new Error('Studio pricing maximum is lower than calculated provider cost');
    }
    const maximum = pricing.max_provider_credits + platform;
    if (!Number.isFinite(maximum)) {
      throw new Error('Studio pricing snapshot does not match provider configuration');
    }
    return {
      provider_credits: provider,
      platform_credits: platform,
      max_credits: maximum,
    };
  },
};

function validPricing(pricing: StudioPricingSnapshot): boolean {
  return (
    Number.isInteger(pricing.version) &&
    pricing.version > 0 &&
    Number.isFinite(pricing.rate_credits) &&
    pricing.rate_credits >= 0 &&
    Number.isFinite(pricing.markup_credits) &&
    pricing.markup_credits >= 0 &&
    Number.isFinite(pricing.max_provider_credits) &&
    pricing.max_provider_credits >= 0
  );
}
