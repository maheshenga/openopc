import type { AutomationControlConfig } from '../config';
import type { LeaseManager } from '../lease-manager';
import {
  type BrowserApprovalResumeCoordinator,
  createBrowserApprovalResumeCoordinator,
} from './browser-approval-resume-coordinator';
import type {
  BrowserApprovalResumeObservation,
  BrowserApprovalResumeStore,
} from './browser-approval-resume-store';
import type { BrowserWorkerConnection } from './browser-dispatcher';

export type BrowserApprovalResumeRuntimeDependencies = Readonly<{
  config: AutomationControlConfig;
  store: Pick<BrowserApprovalResumeStore, 'listCandidates' | 'issue'>;
  leaseManager: Pick<LeaseManager, 'claim' | 'release'>;
  dispatcher: Parameters<typeof createBrowserApprovalResumeCoordinator>[0]['dispatcher'];
  connection: BrowserWorkerConnection;
  now?: () => Date;
  observe?: (event: BrowserApprovalResumeObservation) => void;
}>;

export function createBrowserApprovalResumeRuntime(
  input: BrowserApprovalResumeRuntimeDependencies,
): BrowserApprovalResumeCoordinator | null {
  if (
    !input.config.enabled ||
    !input.config.browserApprovalResumeEnabled ||
    !input.config.browserDispatch.enabled
  ) {
    return null;
  }
  return createBrowserApprovalResumeCoordinator({
    store: input.store,
    leaseManager: input.leaseManager,
    dispatcher: input.dispatcher,
    connection: input.connection,
    owner: input.config.serviceId,
    leaseMs: input.config.leaseMs,
    maxClaimsPerRun: input.config.coordinatorBatchSize,
    now: input.now,
    observe: input.observe,
  });
}
