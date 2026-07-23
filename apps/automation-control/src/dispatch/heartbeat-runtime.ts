import type { AutomationControlConfig } from '../config';
import type { LeaseManager } from '../lease-manager';
import { type HeartbeatEventSink, createHeartbeatProcessor } from './heartbeat';
import { createBrowserWorkerHeartbeatRoute } from './heartbeat-route';
import type { WorkerRedisCommandClient, WorkerServiceAuthenticator } from './worker-auth';

export type BrowserWorkerHeartbeatRuntimeDependencies = Readonly<{
  config: AutomationControlConfig;
  authenticator: WorkerServiceAuthenticator;
  leaseManager: Pick<LeaseManager, 'isCurrent'>;
  eventSink: HeartbeatEventSink;
  now?: () => Date;
}>;

type PrecomposedHeartbeatRuntimeDependencies = Readonly<
  Omit<BrowserWorkerHeartbeatRuntimeDependencies, 'authenticator'> & {
    redis: WorkerRedisCommandClient;
    authenticator?: never;
  }
>;

export function createBrowserWorkerHeartbeatRuntime(
  dependencies: BrowserWorkerHeartbeatRuntimeDependencies | PrecomposedHeartbeatRuntimeDependencies,
) {
  if (!dependencies.config.enabled || !dependencies.config.browserHeartbeatEnabled) {
    throw new Error('Browser Worker heartbeat runtime is not enabled');
  }
  if (dependencies.authenticator === undefined) {
    throw new Error('Shared Browser Worker authenticator is not configured');
  }
  const now = dependencies.now ?? (() => new Date());
  const processor = createHeartbeatProcessor({
    authenticator: dependencies.authenticator,
    now,
    maxObservedSkewMs: dependencies.config.workerProofSkewMs,
    isLeaseBindingCurrent: (binding) =>
      dependencies.leaseManager.isCurrent(binding.jobId, binding.owner, now()),
    eventSink: dependencies.eventSink,
  });
  return createBrowserWorkerHeartbeatRoute({
    tlsAttestationSecret: dependencies.config.workerTlsAttestationSecret,
    authenticator: dependencies.authenticator,
    processor,
    now,
    maxSkewMs: dependencies.config.workerProofSkewMs,
    maxBodyBytes: dependencies.config.workerHeartbeatMaxBodyBytes,
    bodyReadTimeoutMs: dependencies.config.workerHeartbeatBodyReadTimeoutMs,
  });
}
