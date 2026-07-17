import type {
  StudioCredentialBinding,
  StudioErrorCode,
  StudioEstimateRequest,
  StudioEstimateResponse,
} from '@kortix/api-contract';
import type { StudioCostEstimate, StudioPricingSnapshot } from '@kortix/studio-runtime';
import type { StudioEstimateVersionBinding } from './estimate-token';
import {
  FAKE_STUDIO_PRICING_VERSION,
  FAKE_STUDIO_PROVIDER_CONFIG_VERSION,
  fakeStudioDefinitionConfig,
  fakeStudioPricingSnapshot,
  resolveStudioProviderDefinition,
  toStudioProviderConfigWire,
} from './providers';
import type {
  StudioProductionJobBinding,
  StudioProviderConfigRecord,
  StudioProviderConfigWire,
  StudioRepository,
} from './types';

export type StudioEstimateResolution = {
  provider: StudioProviderConfigWire;
  versionBinding: StudioEstimateVersionBinding;
  productionBinding?: StudioProductionJobBinding;
  costs: Pick<
    StudioEstimateResponse,
    'provider_cost_credits' | 'platform_cost_credits' | 'max_approved_credits' | 'line_items'
  >;
};

export type StudioEstimateResolutionError = {
  ok: false;
  status: 400 | 404 | 409;
  code: StudioErrorCode;
  message: string;
};

export type StudioEstimateResolutionResult =
  | { ok: true; value: StudioEstimateResolution }
  | StudioEstimateResolutionError;

const error = (
  status: StudioEstimateResolutionError['status'],
  code: StudioErrorCode,
  message: string,
): StudioEstimateResolutionError => ({ ok: false, status, code, message });

function pricingSnapshot(
  entry: NonNullable<Awaited<ReturnType<StudioRepository['getActivePricing']>>>,
): StudioPricingSnapshot {
  return {
    pricing_catalog_id: entry.pricing_catalog_id,
    version: entry.version,
    provider: entry.provider,
    model: entry.model,
    unit: entry.unit,
    rate_credits: entry.rate_data.rate_credits,
    max_provider_credits: entry.maximum_cost_rule.max_provider_credits,
    markup_credits: entry.markup_rule.markup_credits,
  };
}

function validCost(cost: {
  provider_credits: number;
  platform_credits: number;
  max_credits: number;
}): boolean {
  return (
    Number.isFinite(cost.provider_credits) &&
    cost.provider_credits >= 0 &&
    Number.isFinite(cost.platform_credits) &&
    cost.platform_credits >= 0 &&
    Number.isFinite(cost.max_credits) &&
    cost.max_credits >= 0
  );
}

export async function resolveStudioEstimate(input: {
  repository: StudioRepository;
  accountId: string;
  projectId: string;
  request: StudioEstimateRequest;
  expectedVersionBinding?: StudioEstimateVersionBinding;
  credentialBindingExists?: (input: {
    accountId: string;
    projectId: string;
    binding: StudioCredentialBinding;
  }) => Promise<boolean>;
}): Promise<StudioEstimateResolutionResult> {
  const [publicProvider, rawProvider] = await Promise.all([
    input.repository.getProvider(input.projectId, input.request.provider_config_id),
    input.repository.getProviderConfigRecord(
      input.accountId,
      input.projectId,
      input.request.provider_config_id,
    ),
  ]);
  const provider = rawProvider ? toStudioProviderConfigWire(rawProvider) : publicProvider;
  if (
    !provider ||
    provider.account_id !== input.accountId ||
    provider.project_id !== input.projectId
  ) {
    return error(404, 'STUDIO_PROVIDER_UNAVAILABLE', 'Studio provider unavailable');
  }

  if (
    input.expectedVersionBinding &&
    rawProvider &&
    rawProvider.version_token !== input.expectedVersionBinding.providerConfigVersion
  ) {
    return error(409, 'STUDIO_PROVIDER_CONFIG_STALE', 'Studio provider configuration is stale');
  }
  if (!provider.enabled) {
    return input.expectedVersionBinding && rawProvider
      ? error(409, 'STUDIO_PROVIDER_CONFIG_STALE', 'Studio provider configuration is stale')
      : error(404, 'STUDIO_PROVIDER_UNAVAILABLE', 'Studio provider unavailable');
  }
  if (!provider.capabilities.includes(input.request.capability)) {
    return rawProvider
      ? error(400, 'STUDIO_PROVIDER_CONFIG_INVALID', 'Invalid Studio provider configuration')
      : error(404, 'STUDIO_PROVIDER_UNAVAILABLE', 'Studio provider unavailable');
  }

  const registration = resolveStudioProviderDefinition(provider.provider);
  if (!registration) {
    return error(400, 'STUDIO_PROVIDER_CONFIG_INVALID', 'Invalid Studio provider configuration');
  }

  let config: StudioProviderConfigRecord | ReturnType<typeof fakeStudioDefinitionConfig>;
  let snapshot: StudioPricingSnapshot;
  let productionBinding: StudioProductionJobBinding | undefined;

  if (provider.provider === 'fake') {
    if (provider.credential_binding.kind !== 'none') {
      return error(400, 'STUDIO_PROVIDER_CONFIG_INVALID', 'Invalid Studio provider configuration');
    }
    config = fakeStudioDefinitionConfig({ providerConfigId: provider.provider_config_id });
    snapshot = fakeStudioPricingSnapshot();
  } else {
    const record = rawProvider;
    if (
      !record ||
      !record.enabled ||
      record.provider !== provider.provider ||
      record.credential_binding.kind === 'none'
    ) {
      return error(400, 'STUDIO_PROVIDER_CONFIG_INVALID', 'Invalid Studio provider configuration');
    }
    config = record;

    let credentialExists = false;
    try {
      credentialExists =
        (await input.credentialBindingExists?.({
          accountId: input.accountId,
          projectId: input.projectId,
          binding: record.credential_binding,
        })) ?? false;
    } catch {
      credentialExists = false;
    }
    if (!credentialExists) {
      return error(409, 'STUDIO_CREDENTIAL_UNAVAILABLE', 'Studio credential unavailable');
    }

    let pricingCatalogId: string | null;
    try {
      pricingCatalogId = registration.resolvePricingCatalogId(
        config,
        input.request.capability,
        input.request.model,
      );
    } catch {
      return error(400, 'STUDIO_PROVIDER_CONFIG_INVALID', 'Invalid Studio provider configuration');
    }
    if (!pricingCatalogId) {
      return error(400, 'STUDIO_MODEL_UNSUPPORTED', 'Studio model is not supported');
    }
    const pricing = await input.repository.getActivePricing(input.accountId, pricingCatalogId);
    if (
      !pricing ||
      pricing.account_id !== input.accountId ||
      pricing.provider !== record.provider ||
      pricing.model !== input.request.model ||
      pricing.unit !== 'image'
    ) {
      return error(409, 'STUDIO_PRICING_STALE', 'Studio pricing is stale');
    }
    if (
      input.expectedVersionBinding &&
      (pricing.pricing_catalog_id !== input.expectedVersionBinding.pricingCatalogId ||
        pricing.version !== input.expectedVersionBinding.pricingVersion)
    ) {
      return error(409, 'STUDIO_PRICING_STALE', 'Studio pricing is stale');
    }
    snapshot = pricingSnapshot(pricing);
    productionBinding = {
      provider_config_version: record.version_token,
      pricing_snapshot: snapshot,
    };
  }

  const pricingCatalogId = registration.resolvePricingCatalogId(
    config,
    input.request.capability,
    input.request.model,
  );
  if (!pricingCatalogId) {
    return error(400, 'STUDIO_MODEL_UNSUPPORTED', 'Studio model is not supported');
  }
  if (pricingCatalogId !== snapshot.pricing_catalog_id) {
    return error(409, 'STUDIO_PRICING_STALE', 'Studio pricing is stale');
  }
  const validation = registration.definition.validate(
    config,
    input.request.model,
    input.request.input,
  );
  if (!validation.ok) {
    const code =
      validation.code === 'STUDIO_MODEL_UNSUPPORTED'
        ? 'STUDIO_MODEL_UNSUPPORTED'
        : 'STUDIO_VALIDATION_ERROR';
    return error(400, code, validation.message);
  }

  let estimate: StudioCostEstimate;
  try {
    estimate = registration.definition.estimate(config, snapshot, input.request.input);
  } catch {
    return error(409, 'STUDIO_PRICING_STALE', 'Studio pricing is stale');
  }
  if (!validCost(estimate)) {
    return error(409, 'STUDIO_PRICING_STALE', 'Studio pricing is stale');
  }

  const versionBinding: StudioEstimateVersionBinding = {
    providerConfigVersion:
      provider.provider === 'fake'
        ? FAKE_STUDIO_PROVIDER_CONFIG_VERSION
        : (productionBinding?.provider_config_version ?? ''),
    pricingCatalogId: snapshot.pricing_catalog_id,
    pricingVersion: provider.provider === 'fake' ? FAKE_STUDIO_PRICING_VERSION : snapshot.version,
  };
  return {
    ok: true,
    value: {
      provider,
      versionBinding,
      ...(productionBinding ? { productionBinding } : {}),
      costs: {
        provider_cost_credits: estimate.provider_credits,
        platform_cost_credits: estimate.platform_credits,
        max_approved_credits: estimate.max_credits,
        line_items: registration.lineItems(estimate),
      },
    },
  };
}
