import type { AutomationControlConfig } from '../config';
import {
  type WorkerRedisCommandClient,
  createRedisWorkerNonceStore,
  createWorkerServiceAuthenticator,
  createWorkerServiceSigner,
} from './worker-auth';

export function createWorkerSecurityRuntime(input: {
  config: AutomationControlConfig;
  redis: WorkerRedisCommandClient;
  nextNonce: () => number;
  now?: () => Date;
}) {
  const now = input.now ?? (() => new Date());
  const nonceStore = createRedisWorkerNonceStore(input.redis, {
    ttlMs: Math.min(input.config.workerProofSkewMs * 2, 10 * 60_000),
  });
  return Object.freeze({
    authenticator: createWorkerServiceAuthenticator({
      trustedPeers: input.config.browserWorkerPeers,
      nonceStore,
      now,
      maxSkewMs: input.config.workerProofSkewMs,
    }),
    signer: createWorkerServiceSigner({
      serviceId: input.config.serviceId,
      certificateFingerprint256: input.config.controlCertificateFingerprint256 ?? '',
      sharedSecret: input.config.controlWorkerSharedSecret ?? '',
      nextNonce: input.nextNonce,
    }),
  });
}

export type WorkerSecurityRuntime = ReturnType<typeof createWorkerSecurityRuntime>;
