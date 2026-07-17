import type {
  StudioCreatePricingCatalogRequest,
  StudioPricingCatalogEntry,
} from '@kortix/api-contract';
import type { StudioPricingRepository } from './types';

const NUMERIC_12_4_MAX = 99_999_999.9999;

function decimalPlaces(value: number): number {
  const [coefficient, exponentText] = value.toString().toLowerCase().split('e');
  const fractionLength = coefficient?.split('.')[1]?.length ?? 0;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  return Math.max(0, fractionLength - exponent);
}

function isNumeric12_4(value: number): boolean {
  return (
    Number.isFinite(value) && value >= 0 && value <= NUMERIC_12_4_MAX && decimalPlaces(value) <= 4
  );
}

function validPricing(request: StudioCreatePricingCatalogRequest): boolean {
  return [
    request.rate_data.rate_credits,
    request.maximum_cost_rule.max_provider_credits,
    request.markup_rule.markup_credits,
  ].every(isNumeric12_4);
}

export type StudioPricingServiceResult =
  | { ok: true; value: StudioPricingCatalogEntry }
  | { ok: false; code: 'invalid_pricing' | 'not_found' };

export class StudioPricingService {
  constructor(private readonly repository: StudioPricingRepository) {}

  async list(accountId: string): Promise<StudioPricingCatalogEntry[]> {
    return this.repository.listPricing(accountId);
  }

  async create(input: {
    accountId: string;
    actorUserId: string;
    request: StudioCreatePricingCatalogRequest;
  }): Promise<StudioPricingServiceResult> {
    if (!validPricing(input.request)) return { ok: false, code: 'invalid_pricing' };
    return {
      ok: true,
      value: await this.repository.createPricingVersion({
        account_id: input.accountId,
        created_by_user_id: input.actorUserId,
        request: input.request,
      }),
    };
  }

  async deactivate(input: {
    accountId: string;
    pricingCatalogId: string;
  }): Promise<StudioPricingServiceResult> {
    const value = await this.repository.deactivatePricing(input.accountId, input.pricingCatalogId);
    return value ? { ok: true, value } : { ok: false, code: 'not_found' };
  }
}
