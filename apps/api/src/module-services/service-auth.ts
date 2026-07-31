import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

import {
  type ModuleServiceCapabilityBroker,
  ModuleServiceCapabilityError,
  type RequireModuleServiceCapabilityInput,
} from './capability-grants';

type ModuleServiceCapabilityVerifier = Pick<ModuleServiceCapabilityBroker, 'verify'>;

let runtimeBroker: ModuleServiceCapabilityVerifier | null = null;

function bearerToken(authorization: string | undefined): string {
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._-]{1,16384})$/);
  if (!match?.[1]) {
    throw new ModuleServiceCapabilityError('MODULE_SERVICE_CAPABILITY_INVALID', 401);
  }
  return match[1];
}

export function createModuleServiceCapabilityRequirement(
  broker: ModuleServiceCapabilityVerifier,
): (
  authorization: string | undefined,
  input: RequireModuleServiceCapabilityInput,
) => Promise<ModuleServiceCapabilityClaimsV1> {
  return async (authorization, input) => broker.verify(bearerToken(authorization), input);
}

export function configureModuleServiceCapabilityBroker(
  broker: ModuleServiceCapabilityVerifier | null,
): void {
  runtimeBroker = broker;
}

export async function requireModuleServiceCapability(
  authorization: string | undefined,
  input: RequireModuleServiceCapabilityInput,
): Promise<ModuleServiceCapabilityClaimsV1> {
  if (!runtimeBroker) {
    throw new ModuleServiceCapabilityError('MODULE_SERVICE_UNAVAILABLE', 503);
  }
  return createModuleServiceCapabilityRequirement(runtimeBroker)(authorization, input);
}
