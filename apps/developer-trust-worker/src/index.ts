import type {
  DeveloperTrustPipeline,
  DeveloperTrustPipelineResult,
  DeveloperTrustWorkItem,
} from './pipeline';

export { createDeveloperTrustHealthHandler } from './health';
export { startDeveloperTrustWorkerServer } from './main';
export {
  createDeveloperTrustReadiness,
  DEVELOPER_TRUST_READINESS_COMPONENTS,
  type DeveloperTrustReadiness,
  type DeveloperTrustReadinessComponent,
  type DeveloperTrustReadinessComponentName,
  type DeveloperTrustReadinessInput,
  type DeveloperTrustReadinessReason,
} from './readiness';

export interface DeveloperTrustWorkerControlPort {
  claim(input: { workerId: string; leaseMs: number }): Promise<DeveloperTrustWorkItem | null>;
  heartbeat(input: {
    runId: string;
    workerId: string;
    leaseToken: string;
    leaseGeneration?: number;
    leaseMs: number;
  }): Promise<void>;
  finalize(input: {
    runId: string;
    workerId: string;
    leaseToken: string;
    leaseGeneration?: number;
    artifactDigest: `sha256:${string}`;
    policyDigest: `sha256:${string}`;
    scannerSetDigest: `sha256:${string}`;
    state: DeveloperTrustPipelineResult['state'];
    terminalReason: string;
    sbomDigest: `sha256:${string}`;
    resourceSummary: Record<string, unknown>;
    findings: DeveloperTrustPipelineResult['findings'];
    attestation: DeveloperTrustPipelineResult['attestationRecord'];
  }): Promise<void>;
}

export class DeveloperTrustWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeveloperTrustWorkerError';
  }
}

function sameClaimIdentity(left: DeveloperTrustWorkItem, right: DeveloperTrustWorkItem): boolean {
  return (
    left.runId === right.runId &&
    left.releaseId === right.releaseId &&
    left.accountId === right.accountId &&
    left.artifactId === right.artifactId &&
    left.artifactDigest === right.artifactDigest &&
    left.artifactStorageKey === right.artifactStorageKey &&
    left.artifactSizeBytes === right.artifactSizeBytes &&
    left.runtimeDescriptorPath === right.runtimeDescriptorPath &&
    left.runtimeKind === right.runtimeKind &&
    left.policyDigest === right.policyDigest &&
    left.scannerSetDigest === right.scannerSetDigest &&
    left.sandboxProfileDigest === right.sandboxProfileDigest &&
    left.attempt === right.attempt &&
    left.leaseToken === right.leaseToken &&
    left.leaseGeneration === right.leaseGeneration &&
    left.verificationProfile === right.verificationProfile &&
    left.moduleId === right.moduleId &&
    left.moduleVersion === right.moduleVersion
  );
}

export function createDeveloperTrustWorker(input: {
  workerId: string;
  leaseMs: number;
  control: DeveloperTrustWorkerControlPort;
  artifactProvider: {
    prepare(claim: DeveloperTrustWorkItem): Promise<DeveloperTrustWorkItem>;
    release?(item: DeveloperTrustWorkItem): Promise<void>;
  };
  pipeline: Pick<DeveloperTrustPipeline, 'run'>;
}): { runOnce(): Promise<{ kind: 'idle' } | { kind: 'processed'; runId: string }> } {
  let running = false;
  return {
    async runOnce() {
      if (running) throw new DeveloperTrustWorkerError('DEVELOPER_TRUST_WORKER_BUSY');
      running = true;
      try {
        const claim = await input.control.claim({
          workerId: input.workerId,
          leaseMs: input.leaseMs,
        });
        if (!claim) return { kind: 'idle' };
        const heartbeatInput = {
          runId: claim.runId,
          workerId: input.workerId,
          leaseToken: claim.leaseToken,
          leaseGeneration: claim.leaseGeneration ?? 1,
          leaseMs: input.leaseMs,
        };
        try {
          await input.control.heartbeat(heartbeatInput);
        } catch {
          throw new DeveloperTrustWorkerError('DEVELOPER_TRUST_WORKER_LEASE_LOST');
        }

        let heartbeatFailed = false;
        let heartbeatInFlight: Promise<void> | null = null;
        const heartbeat = (): void => {
          if (heartbeatInFlight) return;
          heartbeatInFlight = input.control
            .heartbeat(heartbeatInput)
            .catch(() => {
              heartbeatFailed = true;
            })
            .finally(() => {
              heartbeatInFlight = null;
            });
        };
        const interval = setInterval(heartbeat, Math.max(1_000, Math.floor(input.leaseMs / 3)));
        interval.unref?.();
        let prepared: DeveloperTrustWorkItem | null = null;
        try {
          prepared = await input.artifactProvider.prepare(claim);
          if (!sameClaimIdentity(claim, prepared)) {
            throw new DeveloperTrustWorkerError('DEVELOPER_TRUST_WORK_ITEM_IDENTITY_MISMATCH');
          }
          const result = await input.pipeline.run(prepared);
          clearInterval(interval);
          if (heartbeatInFlight) await heartbeatInFlight;
          if (heartbeatFailed) {
            throw new DeveloperTrustWorkerError('DEVELOPER_TRUST_WORKER_LEASE_LOST');
          }
          await input.control.finalize({
            runId: claim.runId,
            workerId: input.workerId,
            leaseToken: claim.leaseToken,
            leaseGeneration: claim.leaseGeneration ?? 1,
            artifactDigest: claim.artifactDigest,
            policyDigest: claim.policyDigest,
            scannerSetDigest: claim.scannerSetDigest,
            state: result.state,
            terminalReason: result.terminalReason,
            sbomDigest: result.sbomDigest,
            resourceSummary: result.resourceSummary,
            findings: result.findings,
            attestation: result.attestationRecord,
          });
          return { kind: 'processed', runId: claim.runId };
        } finally {
          clearInterval(interval);
          if (prepared) await input.artifactProvider.release?.(prepared);
        }
      } catch (error) {
        if (error instanceof DeveloperTrustWorkerError) throw error;
        throw new DeveloperTrustWorkerError('DEVELOPER_TRUST_WORKER_OPERATION_FAILED');
      } finally {
        running = false;
      }
    },
  };
}
