import {
  type StudioCreateProviderConfigRequest,
  StudioCreateProviderConfigRequestSchema,
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
  StudioCreateProviderConfigInput,
  StudioProviderConfigRecord,
  StudioProviderConfigRepository,
  StudioProviderConfigWire,
  StudioProviderPricingReference,
} from './types';

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
  const capabilities = openAiCompatibleImageDefinition
    .capabilities(record)
    .map((descriptor) => descriptor.capability)
    .filter((capability): capability is 'image.generate' => capability === 'image.generate');
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
