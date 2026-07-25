import type { DeveloperModuleRelease } from './releases';
import type {
  DeveloperModuleTrustView,
  DeveloperModuleVerificationRepository,
} from './verification';

export type DeveloperModuleTrustGateFailureCode =
  | 'DEVELOPER_TRUST_EVIDENCE_MISSING'
  | 'DEVELOPER_TRUST_PENDING'
  | 'DEVELOPER_TRUST_NOT_PASSED'
  | 'DEVELOPER_TRUST_POLICY_STALE'
  | 'DEVELOPER_TRUST_ARTIFACT_MISMATCH'
  | 'DEVELOPER_TRUST_EVIDENCE_MISMATCH'
  | 'DEVELOPER_TRUST_ATTESTATION_SUBJECT_MISMATCH'
  | 'DEVELOPER_TRUST_BLOCKING_FINDINGS'
  | 'DEVELOPER_TRUST_RUNTIME_DESCRIPTOR_MISMATCH'
  | 'DEVELOPER_TRUST_EXECUTION_MODE_UNSUPPORTED';

export type DeveloperModuleTrustGateResult =
  | {
      ok: true;
      evidence: {
        run_id: string;
        artifact_digest: `sha256:${string}`;
        sbom_digest: `sha256:${string}`;
        attestation_digest: `sha256:${string}`;
        policy_digest: `sha256:${string}`;
        runtime_descriptor_digest: `sha256:${string}` | null;
        runtime_kind: 'wasi-component' | 'oci-image' | null;
      };
    }
  | { ok: false; code: DeveloperModuleTrustGateFailureCode };

function failed(code: DeveloperModuleTrustGateFailureCode): DeveloperModuleTrustGateResult {
  return { ok: false, code };
}

export class DeveloperModuleTrustGate {
  constructor(
    private readonly input: {
      repository: Pick<DeveloperModuleVerificationRepository, 'getAdminView'>;
      currentPolicyDigest: `sha256:${string}`;
    },
  ) {}

  async evaluate(release: DeveloperModuleRelease): Promise<DeveloperModuleTrustGateResult> {
    if (release.manifest.execution.mode === 'desktop-native') {
      return failed('DEVELOPER_TRUST_EXECUTION_MODE_UNSUPPORTED');
    }
    const hasRuntimeDescriptor =
      release.runtime_descriptor_digest !== null ||
      release.runtime_descriptor_path !== null ||
      release.runtime_kind !== null;
    if (
      release.manifest.execution.mode === 'server-adapter'
        ? !release.runtime_descriptor_digest ||
          release.runtime_descriptor_path !== release.manifest.execution.entry ||
          !release.runtime_kind
        : hasRuntimeDescriptor
    ) {
      return failed('DEVELOPER_TRUST_RUNTIME_DESCRIPTOR_MISMATCH');
    }
    const view: DeveloperModuleTrustView | null = await this.input.repository.getAdminView(
      release.release_id,
    );
    if (!view || view.account_id !== release.account_id) {
      return failed('DEVELOPER_TRUST_EVIDENCE_MISSING');
    }
    if (
      release.artifact_id !== view.artifact.artifact_id ||
      release.artifact_digest !== view.artifact.artifact_digest
    ) {
      return failed('DEVELOPER_TRUST_ARTIFACT_MISMATCH');
    }
    const latest = view.attempts.at(-1);
    if (!latest) return failed('DEVELOPER_TRUST_EVIDENCE_MISSING');
    if (
      latest.policy_digest !== this.input.currentPolicyDigest ||
      release.verification_policy_digest !== this.input.currentPolicyDigest
    ) {
      return failed('DEVELOPER_TRUST_POLICY_STALE');
    }
    if (latest.state === 'queued' || latest.state === 'running') {
      return failed('DEVELOPER_TRUST_PENDING');
    }
    if (latest.state !== 'passed') return failed('DEVELOPER_TRUST_NOT_PASSED');
    if (!latest.attestation) return failed('DEVELOPER_TRUST_EVIDENCE_MISSING');
    if (latest.attestation.subject_artifact_digest !== view.artifact.artifact_digest) {
      return failed('DEVELOPER_TRUST_ATTESTATION_SUBJECT_MISMATCH');
    }
    if (
      !latest.sbom_digest ||
      !latest.attestation_digest ||
      latest.sbom_digest !== release.sbom_digest ||
      latest.attestation_digest !== release.trust_attestation_digest ||
      latest.attestation.attestation_digest !== latest.attestation_digest ||
      latest.attestation.sbom_digest !== latest.sbom_digest ||
      latest.attestation.policy_digest !== latest.policy_digest ||
      latest.attestation.result !== 'passed'
    ) {
      return failed('DEVELOPER_TRUST_EVIDENCE_MISMATCH');
    }
    if (
      latest.findings.some(
        (finding) =>
          finding.disposition === 'blocking' &&
          (finding.severity === 'high' || finding.severity === 'critical'),
      )
    ) {
      return failed('DEVELOPER_TRUST_BLOCKING_FINDINGS');
    }
    return {
      ok: true,
      evidence: {
        run_id: latest.run_id,
        artifact_digest: view.artifact.artifact_digest,
        sbom_digest: latest.sbom_digest,
        attestation_digest: latest.attestation_digest,
        policy_digest: latest.policy_digest,
        runtime_descriptor_digest: release.runtime_descriptor_digest,
        runtime_kind: release.runtime_kind,
      },
    };
  }
}
