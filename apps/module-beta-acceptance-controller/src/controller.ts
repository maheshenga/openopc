import {
  type ModuleBetaArtifactRegistrationResponseV1,
  type ModuleBetaCleanupResponseV1,
  type ModuleBetaDsseEnvelopeV1,
  type ModuleBetaInspectorEvidenceV1,
  parseModuleBetaArtifactRegistrationResponse,
  parseModuleBetaCleanupResponse,
  parseModuleBetaInspectorEvidence,
} from '@openopc/module-runtime-contracts';

import type { ModuleBetaAcceptancePort, ModuleBetaCleanupPendingResponseV1 } from './http';
import type {
  ModuleBetaAcceptanceRetentionRunStatus,
  PostgresModuleBetaAcceptanceRepository,
} from './postgres';
import { type S3ModuleBetaAcceptanceStore, moduleBetaCleanupProbeCoordinates } from './s3';

const DEPENDENCY_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;
const FAULT_SCENARIOS = new Set(['invalid-signature', 'stale-policy', 'scanner-crash']);

export interface ModuleBetaAcceptanceController extends ModuleBetaAcceptancePort {
  assertReady(): Promise<void>;
}

export class ModuleBetaAcceptanceControllerError extends Error {
  override readonly name = 'ModuleBetaAcceptanceControllerError';

  constructor(readonly code: string) {
    super(code);
  }
}

export function createModuleBetaAcceptanceController(input: {
  controllerIdentity: string;
  repository: PostgresModuleBetaAcceptanceRepository;
  store: S3ModuleBetaAcceptanceStore;
  retentionProbeGraceMs?: number;
  now?: () => Date;
}): ModuleBetaAcceptanceController {
  const retentionProbeGraceMs = input.retentionProbeGraceMs ?? 5_000;
  if (
    !DEPENDENCY_IDENTITY.test(input.controllerIdentity) ||
    !Number.isSafeInteger(retentionProbeGraceMs) ||
    retentionProbeGraceMs < 1_000 ||
    retentionProbeGraceMs > 5 * 60_000
  ) {
    fail('MODULE_BETA_ACCEPTANCE_CONTROLLER_CONFIG_INVALID');
  }
  const now = input.now ?? (() => new Date());

  return {
    async assertReady() {
      await Promise.all([input.repository.assertReady(), input.store.assertReady()]);
    },

    async registerArtifact(request) {
      const artifact = await input.repository.getArtifact({
        accountId: request.accountId,
        artifactId: request.artifactId,
        artifactDigest: request.artifactDigest,
      });
      if (!artifact) fail('MODULE_BETA_ACCEPTANCE_ARTIFACT_BINDING_INVALID');
      const plan = await input.store.registerPlan(request);
      if (
        plan.acceptanceRunId !== request.acceptanceRunId ||
        plan.scenario !== request.scenario ||
        plan.accountId !== request.accountId ||
        plan.artifactId !== request.artifactId ||
        plan.artifactDigest !== request.artifactDigest ||
        plan.controllerIdentity !== input.controllerIdentity
      ) {
        fail('MODULE_BETA_ACCEPTANCE_PLAN_BINDING_INVALID');
      }
      return parseModuleBetaArtifactRegistrationResponse({
        schemaVersion: 1,
        acceptanceRunId: plan.acceptanceRunId,
        scenario: plan.scenario,
        registered: true,
        faultArmed: FAULT_SCENARIOS.has(plan.scenario),
        registrationId: plan.registrationId,
        artifactId: plan.artifactId,
        artifactDigest: plan.artifactDigest,
        expiresAt: plan.expiresAt,
        dependencyIdentity: input.controllerIdentity,
      } satisfies ModuleBetaArtifactRegistrationResponseV1);
    },

    async inspect(request) {
      const evidence = await input.repository.getRunEvidence(request);
      if (!evidence) return null;
      const plan = await input.store.verifyConsumption({
        acceptanceRunId: request.acceptanceRunId,
        accountId: evidence.accountId,
        artifactId: evidence.artifactId,
        artifactDigest: evidence.artifactDigest,
        runId: evidence.runId,
      });
      if (plan.acceptanceRunId !== evidence.acceptanceRunId) {
        fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
      }
      const [artifactUrl, sbomUrl] = await Promise.all([
        input.store.verifyAndPresignGet({
          storageKey: evidence.artifactStorageKey,
          expectedDigest: evidence.artifactContentDigest,
          expectedSizeBytes: evidence.artifactSizeBytes,
          expectedContentType: 'application/vnd.openopc.developer-module.v2+json',
        }),
        input.store.verifyAndPresignGet({
          storageKey: evidence.sbomStorageKey,
          expectedDigest: evidence.sbomDigest,
          expectedSizeBytes: evidence.sbomSizeBytes,
          expectedContentType: 'application/vnd.cyclonedx+json',
        }),
      ]);
      const envelope = dsseEnvelope(evidence.dsseEnvelope);
      if (!envelope) fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
      const keyId = envelope.signatures[0]?.keyid;
      if (!keyId) fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
      const scannerIdentities = scannerIdentitiesFromEnvelope(envelope);
      return parseModuleBetaInspectorEvidence({
        schemaVersion: 1,
        acceptanceRunId: evidence.acceptanceRunId,
        controllerIdentity: input.controllerIdentity,
        runId: evidence.runId,
        artifact: {
          storage: 'minio',
          url: artifactUrl,
          contentDigest: evidence.artifactContentDigest,
          sizeBytes: evidence.artifactSizeBytes,
          artifactDigest: evidence.artifactDigest,
        },
        sbom: {
          storage: 'minio',
          url: sbomUrl,
          contentDigest: evidence.sbomDigest,
          sizeBytes: evidence.sbomSizeBytes,
        },
        attestation: {
          digest: evidence.attestationDigest,
          keyId,
          envelope,
        },
        scannerIdentities,
      } satisfies ModuleBetaInspectorEvidenceV1);
    },

    async cleanup(request) {
      const binding = await input.repository.getCleanupBinding(request);
      let retentionRun = await input.repository.readRetentionRun({
        acceptanceRunId: request.acceptanceRunId,
      });
      if (!retentionRun) {
        await input.store.assertObjectAbsent(binding.cancelledUploadStorageKey);
        for (const run of binding.verificationRuns) {
          await input.store.verifyConsumption({
            acceptanceRunId: request.acceptanceRunId,
            accountId: request.accountId,
            artifactId: run.artifactId,
            artifactDigest: run.artifactDigest,
            runId: run.runId,
          });
        }
        await input.store.deleteAcceptanceObjects({
          accountId: request.accountId,
          artifactIds: request.artifactIds,
        });
        const probes = await input.store.prepareCleanupProbes({
          acceptanceRunId: request.acceptanceRunId,
        });
        const preparedAt = now();
        if (!Number.isFinite(preparedAt.valueOf())) {
          fail('MODULE_BETA_ACCEPTANCE_CLOCK_INVALID');
        }
        await input.repository.prepareExpiredRetentionProbe({
          acceptanceRunId: request.acceptanceRunId,
          accountId: request.accountId,
          cancelledUploadId: request.cancelledUploadId,
          uploadId: probes.expiredRetention.uploadId,
          storageKey: probes.expiredRetention.storageKey,
          contentDigest: probes.expiredRetention.contentDigest,
          sizeBytes: probes.expiredRetention.sizeBytes,
          createdAt: preparedAt.toISOString(),
          expiresAt: new Date(preparedAt.valueOf() + 1_000).toISOString(),
        });
        retentionRun = await input.repository.enqueueRetentionRun({
          acceptanceRunId: request.acceptanceRunId,
          // Give the orphan object a complete grace window after its S3
          // LastModified; the database clock anchors the actual availability.
          delayMs: retentionProbeGraceMs + 1_000,
        });
      }
      assertRetentionRunBinding(retentionRun, request.acceptanceRunId);
      if (retentionRun.state === 'queued' || retentionRun.state === 'running') {
        return {
          schemaVersion: 1,
          acceptanceRunId: request.acceptanceRunId,
          dependencyIdentity: input.controllerIdentity,
          retentionRunId: retentionRun.runId,
          state: retentionRun.state,
        } satisfies ModuleBetaCleanupPendingResponseV1;
      }
      if (retentionRun.state !== 'succeeded') {
        fail('MODULE_BETA_ACCEPTANCE_RETENTION_FAILED');
      }
      const probes = moduleBetaCleanupProbeCoordinates(request.acceptanceRunId);
      await input.repository.assertExpiredRetentionProbeDeleted({
        accountId: request.accountId,
        uploadId: probes.expiredRetention.uploadId,
        storageKey: probes.expiredRetention.storageKey,
      });
      await input.store.assertCleanupProbesAbsent({
        acceptanceRunId: request.acceptanceRunId,
      });
      await input.repository.assertAttemptsPreserved(request);
      return parseModuleBetaCleanupResponse({
        schemaVersion: 1,
        acceptanceRunId: request.acceptanceRunId,
        dependencyIdentity: input.controllerIdentity,
        retention: {
          expiredProbeDeleted: true,
          immutableAttemptsPreserved: true,
        },
        orphanCleanup: {
          cancelledUploadAbsent: true,
          orphanProbeDeleted: true,
        },
      } satisfies ModuleBetaCleanupResponseV1);
    },
  };
}

function assertRetentionRunBinding(
  run: ModuleBetaAcceptanceRetentionRunStatus,
  acceptanceRunId: string,
): void {
  if (
    run.acceptanceRunId !== acceptanceRunId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(run.runId) ||
    !Number.isSafeInteger(run.attempts) ||
    run.attempts < 0 ||
    !Number.isFinite(Date.parse(run.availableAt)) ||
    !Number.isFinite(Date.parse(run.createdAt)) ||
    !Number.isFinite(Date.parse(run.updatedAt)) ||
    (run.cursor !== null &&
      (Buffer.byteLength(run.cursor, 'utf8') < 1 ||
        Buffer.byteLength(run.cursor, 'utf8') > 2_048 ||
        /[\0\r\n]/.test(run.cursor)))
  ) {
    fail('MODULE_BETA_ACCEPTANCE_RETENTION_INVALID');
  }
}

function scannerIdentitiesFromEnvelope(envelope: ModuleBetaDsseEnvelopeV1): string[] {
  let bytes: Buffer;
  let statement: unknown;
  try {
    bytes = Buffer.from(envelope.payload, 'base64');
    if (
      bytes.byteLength < 1 ||
      bytes.byteLength > 64 * 1024 ||
      bytes.toString('base64') !== envelope.payload
    ) {
      fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
    }
    statement = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
  }
  if (
    !isRecord(statement) ||
    statement._type !== 'https://in-toto.io/Statement/v1' ||
    statement.predicateType !==
      'https://openopc.dev/attestations/developer-module-verification/v1' ||
    !isRecord(statement.predicate)
  ) {
    fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
  }
  const identities = statement.predicate.scannerIdentities;
  if (
    !Array.isArray(identities) ||
    identities.length < 1 ||
    identities.length > 32 ||
    identities.some(
      (identity) => typeof identity !== 'string' || !DEPENDENCY_IDENTITY.test(identity),
    ) ||
    new Set(identities).size !== identities.length ||
    (statement.predicate.scannerIdentityVerified !== true &&
      statement.predicate.scannerIdentityVerified !== false)
  ) {
    fail('MODULE_BETA_ACCEPTANCE_EVIDENCE_BINDING_INVALID');
  }
  return [...(identities as string[])];
}

function dsseEnvelope(value: unknown): ModuleBetaDsseEnvelopeV1 | null {
  if (
    !isRecord(value) ||
    typeof value.payloadType !== 'string' ||
    typeof value.payload !== 'string' ||
    !Array.isArray(value.signatures) ||
    value.signatures.length !== 1
  ) {
    return null;
  }
  const signature = value.signatures[0];
  return isRecord(signature) &&
    typeof signature.keyid === 'string' &&
    typeof signature.sig === 'string'
    ? (structuredClone(value) as unknown as ModuleBetaDsseEnvelopeV1)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: string): never {
  throw new ModuleBetaAcceptanceControllerError(code);
}
