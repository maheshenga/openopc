import {
  type ModuleServiceCapabilityClaimsV1,
  type OpenOpcServiceName,
  type OpenOpcServiceOperation,
  parseModuleServiceCapabilityClaims,
} from '@kortix/api-contract';

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

export async function requireModuleServiceOperation(
  authorization: string | undefined,
  input: { service: OpenOpcServiceName; operation: OpenOpcServiceOperation },
): Promise<ModuleServiceCapabilityClaimsV1> {
  if (!runtimeBroker) {
    throw new ModuleServiceCapabilityError('MODULE_SERVICE_UNAVAILABLE', 503);
  }
  const token = bearerToken(authorization);
  let claims: ModuleServiceCapabilityClaimsV1;
  try {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v4' || parts[1] !== 'public') {
      throw new Error('invalid token envelope');
    }
    const signedPayload = Buffer.from(parts[2] ?? '', 'base64url');
    if (signedPayload.length <= 64) throw new Error('invalid signed payload');
    claims = parseModuleServiceCapabilityClaims(
      JSON.parse(signedPayload.subarray(0, -64).toString('utf8')) as unknown,
    );
  } catch {
    throw new ModuleServiceCapabilityError('MODULE_SERVICE_CAPABILITY_INVALID', 401);
  }
  return runtimeBroker.verify(token, {
    accountId: claims.accountId,
    projectId: claims.projectId,
    installationId: claims.installationId,
    installRevision: claims.installRevision,
    releaseId: claims.releaseId,
    service: input.service,
    operation: input.operation,
  });
}
