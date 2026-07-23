import { Hono } from 'hono';
import type { AutomationControlConfig } from '../config';
import type { LeaseManager } from '../lease-manager';
import { createBrowserApprovalResumeRoute } from './browser-approval-resume-route';
import type { BrowserApprovalResumeStore } from './browser-approval-resume-store';
import { createBrowserAuthorityRoute } from './browser-authority-route';
import type { BrowserAuthorityStore } from './browser-authority-store';
import type { HeartbeatEventSink } from './heartbeat';
import { createBrowserWorkerHeartbeatRuntime } from './heartbeat-runtime';
import type { WorkerSecurityRuntime } from './worker-security-runtime';

export type BrowserWorkerRoutesInput = Readonly<{
  config: AutomationControlConfig;
  security: WorkerSecurityRuntime;
  leaseManager: Pick<LeaseManager, 'isCurrent'>;
  heartbeatEventSink: HeartbeatEventSink;
  authorityStore: Pick<BrowserAuthorityStore, 'check'>;
  approvalResumeStore: Pick<BrowserApprovalResumeStore, 'consumeAndStart'>;
  now?: () => Date;
}>;

function assertConsistentFeatureGates(config: AutomationControlConfig): void {
  if (
    (config.browserHeartbeatEnabled && !config.enabled) ||
    (config.browserDispatch.enabled && (!config.enabled || !config.browserHeartbeatEnabled)) ||
    (config.browserApprovalResumeEnabled &&
      (!config.enabled || !config.browserHeartbeatEnabled || !config.browserDispatch.enabled))
  ) {
    throw new Error('Browser Worker route feature gates are inconsistent');
  }
}

export function createBrowserWorkerRoutes(input: BrowserWorkerRoutesInput): Hono {
  const routes = new Hono();
  assertConsistentFeatureGates(input.config);
  if (!input.config.enabled || !input.config.browserHeartbeatEnabled) return routes;

  routes.route(
    '/',
    createBrowserWorkerHeartbeatRuntime({
      config: input.config,
      authenticator: input.security.authenticator,
      leaseManager: input.leaseManager,
      eventSink: input.heartbeatEventSink,
      now: input.now,
    }),
  );

  if (input.config.browserDispatch.enabled) {
    routes.route(
      '/',
      createBrowserAuthorityRoute({
        tlsAttestationSecret: input.config.workerTlsAttestationSecret,
        authenticator: input.security.authenticator,
        store: input.authorityStore,
        now: input.now,
        maxSkewMs: input.config.workerProofSkewMs,
        maxBodyBytes: input.config.workerHeartbeatMaxBodyBytes,
        bodyReadTimeoutMs: input.config.workerHeartbeatBodyReadTimeoutMs,
      }),
    );
  }

  if (input.config.browserApprovalResumeEnabled) {
    routes.route(
      '/',
      createBrowserApprovalResumeRoute({
        tlsAttestationSecret: input.config.workerTlsAttestationSecret,
        authenticator: input.security.authenticator,
        store: input.approvalResumeStore,
        now: input.now,
        maxSkewMs: input.config.workerProofSkewMs,
        maxBodyBytes: input.config.workerHeartbeatMaxBodyBytes,
        bodyReadTimeoutMs: input.config.workerHeartbeatBodyReadTimeoutMs,
      }),
    );
  }

  return routes;
}
