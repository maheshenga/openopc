import type { AutomationControlConfig } from '../config';
import type { LeaseManager } from '../lease-manager';
import { type HeartbeatEventSink, createHeartbeatProcessor } from './heartbeat';
import { createBrowserWorkerHeartbeatRoute } from './heartbeat-route';
import {
  type WorkerRedisCommandClient,
  createRedisWorkerNonceStore,
  createWorkerServiceAuthenticator,
} from './worker-auth';

export type BrowserWorkerHeartbeatRuntimeDependencies = Readonly<{
  config: AutomationControlConfig;
  redis: WorkerRedisCommandClient;
  leaseManager: Pick<LeaseManager, 'isCurrent'>;
  eventSink: HeartbeatEventSink;
  now?: () => Date;
}>;

export function createBrowserWorkerHeartbeatRuntime(
  dependencies: BrowserWorkerHeartbeatRuntimeDependencies,
) {
  if (!dependencies.config.enabled || !dependencies.config.browserHeartbeatEnabled) {
    throw new Error('Browser Worker heartbeat runtime is not enabled');
  }
  const now = dependencies.now ?? (() => new Date());
  const nonceStore = createRedisWorkerNonceStore(dependencies.redis, {
    ttlMs: Math.min(dependencies.config.workerProofSkewMs * 2, 10 * 60_000),
  });
  const authenticator = createWorkerServiceAuthenticator({
    trustedPeers: dependencies.config.browserWorkerPeers,
    nonceStore,
    now,
    maxSkewMs: dependencies.config.workerProofSkewMs,
  });
  const processor = createHeartbeatProcessor({
    authenticator,
    now,
    maxObservedSkewMs: dependencies.config.workerProofSkewMs,
    isLeaseBindingCurrent: (binding) =>
      dependencies.leaseManager.isCurrent(binding.jobId, binding.owner, now()),
    eventSink: dependencies.eventSink,
  });
  return createBrowserWorkerHeartbeatRoute({
    tlsAttestationSecret: dependencies.config.workerTlsAttestationSecret,
    authenticator,
    processor,
    now,
    maxSkewMs: dependencies.config.workerProofSkewMs,
    maxBodyBytes: dependencies.config.workerHeartbeatMaxBodyBytes,
    bodyReadTimeoutMs: dependencies.config.workerHeartbeatBodyReadTimeoutMs,
  });
}
