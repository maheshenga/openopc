import {
  type Capability,
  CapabilityRegistry,
  type TunnelConfig,
  createDesktopCapability,
  createFilesystemCapability,
  createShellCapability,
} from 'agent-tunnel';

import { type ConsentRuntimeContext, wrapCapabilityWithConsent } from './consent-guard';

export type DesktopCapabilitySelection =
  | 'filesystem'
  | 'local_execution'
  | 'desktop_automation'
  | 'full_access';

export type TunnelCapabilityName = 'filesystem' | 'shell' | 'desktop';

const CAPABILITY_SELECTIONS: Readonly<
  Record<DesktopCapabilitySelection, readonly TunnelCapabilityName[]>
> = {
  filesystem: ['filesystem'],
  local_execution: ['shell'],
  desktop_automation: ['desktop'],
  full_access: ['filesystem', 'shell', 'desktop'],
};

export function expandDesktopCapabilitySelection(
  selection: DesktopCapabilitySelection,
): TunnelCapabilityName[] {
  return [...CAPABILITY_SELECTIONS[selection]];
}

export interface GuardedCapabilityRegistryOptions extends ConsentRuntimeContext {
  capabilities: readonly Capability[];
}

export function createConsentGuardedRegistry(
  options: GuardedCapabilityRegistryOptions,
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const capability of options.capabilities) {
    registry.register(wrapCapabilityWithConsent(capability, options));
  }
  return registry;
}

export interface OpenOpcCapabilityRegistryOptions extends ConsentRuntimeContext {
  config: TunnelConfig;
  desktop?: Capability;
}

/** Build the real three-capability registry without introducing full_access. */
export function createOpenOpcCapabilityRegistry(
  options: OpenOpcCapabilityRegistryOptions,
): CapabilityRegistry {
  return createConsentGuardedRegistry({
    ...options,
    capabilities: [
      createFilesystemCapability(options.config),
      createShellCapability(options.config),
      options.desktop ?? createDesktopCapability(),
    ],
  });
}
