import type { AutomationControlConfig } from '../config';
import { type LeaseManager, verifyAutomationLeaseSignature } from '../lease-manager';
import type { AutomationRepository } from '../repository';
import { createAutomationApiTunnelExecutor } from './api-tunnel-executor';
import {
  type AutomationDispatchCoordinator,
  createAutomationDispatchCoordinator,
  resolveDeclaredDesktopPermission,
} from './coordinator';
import { createDesktopDispatcher } from './desktop-dispatcher';

export function createAutomationDesktopDispatchRuntime(input: {
  config: AutomationControlConfig;
  repository: AutomationRepository;
  leaseManager: LeaseManager;
  fetch?: typeof fetch;
  now?: () => Date;
}): AutomationDispatchCoordinator | null {
  if (!input.config.enabled || !input.config.desktopCoordinatorEnabled) return null;
  const now = input.now ?? (() => new Date());
  const executeTunnelRpc = createAutomationApiTunnelExecutor({
    baseUrl: input.config.automationApiUrl,
    sharedSecret: input.config.sharedSecret,
    serviceId: input.config.serviceId,
    fetch: input.fetch,
    now,
  });
  const desktopDispatcher = createDesktopDispatcher({
    now,
    isLeaseSignatureValid: async (lease) =>
      verifyAutomationLeaseSignature(lease, input.config.sharedSecret),
    isLeaseCurrent: (binding) => input.leaseManager.isCurrent(binding.jobId, binding.owner, now()),
    // This runtime is deliberately restricted to the observe-only action below.
    // Operate and external-effect paths require separately wired durable grants.
    isFullAccessGrantCurrent: async () => false,
    consumeStepApproval: async () => false,
    executeTunnelRpc,
  });

  return createAutomationDispatchCoordinator({
    repository: input.repository,
    leaseManager: input.leaseManager,
    desktopDispatcher,
    resolveDesktopPermission: resolveDeclaredDesktopPermission,
    owner: input.config.serviceId,
    leaseMs: input.config.leaseMs,
    maxClaimsPerRun: input.config.coordinatorBatchSize,
    now,
  });
}
