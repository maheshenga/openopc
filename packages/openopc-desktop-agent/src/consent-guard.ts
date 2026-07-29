import type { Capability, LocalPermission, RpcHandler } from 'agent-tunnel';

import type {
  DesktopConsentGrant,
  DesktopConsentStore,
  NativeConfirmationPort,
  NativeConfirmationRequest,
} from './consent-store';

export interface ConsentRuntimeContext {
  consentStore: DesktopConsentStore;
  tunnelId: string;
  userId: string;
  deviceId: string;
}

export interface ConfirmAndGrantInput {
  confirmation: NativeConfirmationPort;
  consentStore: DesktopConsentStore;
  request: NativeConfirmationRequest | readonly NativeConfirmationRequest[];
  userId: string;
  deviceId: string;
  consentKind?: 'capability' | 'full_access';
  bundleId?: string;
}

/**
 * Native confirmation is an explicit foreground action. The RPC wrapper never
 * calls this function, so a missing consent cannot cause a background prompt.
 */
export async function confirmAndGrantDesktopConsent(input: ConfirmAndGrantInput): Promise<boolean> {
  const requests = Array.isArray(input.request) ? input.request : [input.request];
  if (requests.length === 0) return false;
  for (const request of requests) {
    if (!(await input.confirmation.confirm({ ...request }))) return false;
  }
  const grants: DesktopConsentGrant[] = requests.map((request) => ({
    ...request,
    userId: input.userId,
    deviceId: input.deviceId,
    consentKind: input.consentKind,
    bundleId: input.bundleId,
  }));
  if (input.consentKind === 'full_access') input.consentStore.grantBundle(grants);
  else input.consentStore.grant(grants[0]);
  return true;
}

export function wrapCapabilityWithConsent(
  capability: Capability,
  context: ConsentRuntimeContext,
): Capability {
  const methods = new Map<string, RpcHandler>();
  for (const [method, handler] of capability.methods) {
    methods.set(method, async (params) => {
      const permission = params.__permission as LocalPermission | undefined;
      const authorization = {
        tunnelId: context.tunnelId,
        permission,
        userId: context.userId,
        deviceId: context.deviceId,
        method,
        params,
      };
      const permit = context.consentStore.issuePermit(authorization);
      await context.consentStore.consumePermit(permit, authorization);
      // Keep the exact server-injected object and all server fences intact.
      return handler(params);
    });
  }
  return { ...capability, methods };
}
