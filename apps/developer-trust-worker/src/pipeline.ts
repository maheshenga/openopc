import type { RegistryModuleVerificationProfile } from '@kortix/registry';

import {
  type DsseEnvelope,
  type EvidenceSigner,
  OPENOPC_TRUST_PREDICATE_TYPE,
  createDeveloperTrustAttestation,
} from './attestation';
import { type DeveloperTrustPolicyV1, assertDeveloperTrustPolicyClaim } from './policy';
import type {
  DeveloperScannerAdapter,
  ScannerFinding,
  ScannerInput,
  ScannerResult,
} from './scanners/types';
import { compareText, evidenceDigest } from './scanners/types';

export interface DeveloperTrustWorkItem extends ScannerInput {
  runId: string;
  releaseId: string;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
  sandboxProfileDigest: `sha256:${string}`;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  verificationProfile: RegistryModuleVerificationProfile;
}

export interface DeveloperTrustPipelineResult {
  state: 'passed' | 'failed' | 'inconclusive';
  terminalReason: string;
  sbomDigest: `sha256:${string}`;
  attestationDigest: `sha256:${string}`;
  resourceSummary: Record<string, unknown>;
  findings: ScannerFinding[];
  evidenceDigests: `sha256:${string}`[];
  attestation: DsseEnvelope;
  attestationRecord: {
    attestationDigest: `sha256:${string}`;
    subjectArtifactDigest: `sha256:${string}`;
    predicateType: string;
    policyDigest: `sha256:${string}`;
    result: 'passed' | 'failed' | 'inconclusive';
    sbomDigest: `sha256:${string}`;
    dsseEnvelope: DsseEnvelope;
    issuer: string;
  };
}

export class DeveloperTrustPipeline {
  readonly #policy: DeveloperTrustPolicyV1;
  readonly #scanners: DeveloperScannerAdapter[];
  readonly #signer: EvidenceSigner;
  readonly #now: () => Date;

  constructor(input: {
    policy: DeveloperTrustPolicyV1;
    scanners: DeveloperScannerAdapter[];
    signer: EvidenceSigner;
    now?: () => Date;
  }) {
    this.#policy = input.policy;
    this.#scanners = [...input.scanners];
    this.#signer = input.signer;
    this.#now = input.now ?? (() => new Date());
  }

  async run(item: DeveloperTrustWorkItem): Promise<DeveloperTrustPipelineResult> {
    const startedAt = this.#now().toISOString();
    try {
      assertDeveloperTrustPolicyClaim(this.#policy, item);
    } catch {
      return this.#finalize(item, {
        state: 'inconclusive',
        terminalReason: 'policy_mismatch',
        findings: [],
        evidenceDigests: [],
        sbom: null,
        startedAt,
      });
    }

    const expectedNames = this.#policy.scanners.map((scanner) => scanner.name).sort();
    const actualNames = this.#scanners.map((scanner) => scanner.name).sort();
    if (
      actualNames.length !== expectedNames.length ||
      actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      return this.#finalize(item, {
        state: 'inconclusive',
        terminalReason: 'scanner_set_invalid',
        findings: [],
        evidenceDigests: [],
        sbom: null,
        startedAt,
      });
    }

    try {
      for (const scanner of this.#scanners) await scanner.verifyIdentity(this.#policy);
    } catch {
      return this.#finalize(item, {
        state: 'inconclusive',
        terminalReason: 'scanner_identity_mismatch',
        findings: [],
        evidenceDigests: [],
        sbom: null,
        startedAt,
      });
    }

    const controller = new AbortController();
    const settled = await Promise.allSettled(
      this.#scanners.map((scanner) => scanner.scan(item, controller.signal)),
    );
    const results: ScannerResult[] = [];
    let invalidResult = false;
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (
        result.status === 'rejected' ||
        !validScannerResult(result.value, this.#scanners[index].name)
      ) {
        invalidResult = true;
        continue;
      }
      results.push(result.value);
    }
    const syft = results.find((result) => result.scanner === 'syft');
    const sbom = syft?.state === 'passed' && validSbom(syft.sbom) ? syft.sbom : null;
    const findings = results
      .flatMap((result) => result.findings)
      .sort((left, right) => compareText(left.fingerprint, right.fingerprint));
    const evidenceDigests = results
      .sort((left, right) => compareText(left.scanner, right.scanner))
      .map((result) => result.evidenceDigest);

    let state: DeveloperTrustPipelineResult['state'];
    let terminalReason: string;
    if (invalidResult || results.some((result) => result.state === 'inconclusive')) {
      state = 'inconclusive';
      terminalReason = invalidResult ? 'scanner_result_invalid' : 'scanner_inconclusive';
    } else if (!sbom) {
      state = 'inconclusive';
      terminalReason = 'sbom_unavailable';
    } else if (results.some((result) => result.state === 'failed')) {
      state = 'failed';
      terminalReason = 'blocking_findings';
    } else {
      state = 'passed';
      terminalReason = 'verification_completed';
    }
    return this.#finalize(item, {
      state,
      terminalReason,
      findings,
      evidenceDigests,
      sbom,
      startedAt,
      scannerResults: results,
    });
  }

  async #finalize(
    item: DeveloperTrustWorkItem,
    input: {
      state: DeveloperTrustPipelineResult['state'];
      terminalReason: string;
      findings: ScannerFinding[];
      evidenceDigests: `sha256:${string}`[];
      sbom: ScannerResult['sbom'] | null;
      startedAt: string;
      scannerResults?: ScannerResult[];
    },
  ): Promise<DeveloperTrustPipelineResult> {
    const sbomDigest = evidenceDigest(
      input.sbom ?? { bomFormat: 'CycloneDX', specVersion: '1.6', unavailable: true },
    );
    const finishedAt = this.#now().toISOString();
    const attestation = await createDeveloperTrustAttestation({
      moduleId: item.moduleId,
      moduleVersion: item.moduleVersion,
      predicate: {
        artifactDigest: item.artifactDigest,
        policyDigest: item.policyDigest,
        scannerSetDigest: item.scannerSetDigest,
        sandboxProfileDigest: item.sandboxProfileDigest,
        sbomDigest,
        runId: item.runId,
        attempt: item.attempt,
        result: input.state,
        evidenceDigests: input.evidenceDigests,
        startedAt: input.startedAt,
        finishedAt,
      },
      signer: this.#signer,
    });
    const scannerResults = input.scannerResults ?? [];
    const resourceSummary = {
      scanner_count: scannerResults.length,
      passed_scanners: scannerResults.filter((result) => result.state === 'passed').length,
      failed_scanners: scannerResults.filter((result) => result.state === 'failed').length,
      inconclusive_scanners: scannerResults.filter((result) => result.state === 'inconclusive')
        .length,
      sbom_available: Boolean(input.sbom),
    };
    return {
      state: input.state,
      terminalReason: input.terminalReason,
      sbomDigest,
      attestationDigest: attestation.attestationDigest,
      resourceSummary,
      findings: input.findings,
      evidenceDigests: input.evidenceDigests,
      attestation: attestation.envelope,
      attestationRecord: {
        attestationDigest: attestation.attestationDigest,
        subjectArtifactDigest: item.artifactDigest,
        predicateType: OPENOPC_TRUST_PREDICATE_TYPE,
        policyDigest: item.policyDigest,
        result: input.state,
        sbomDigest,
        dsseEnvelope: attestation.envelope,
        issuer: this.#signer.issuer,
      },
    };
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CREDENTIAL_TEXT =
  /(?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*\S{4,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/i;

function validFinding(finding: ScannerFinding, scanner: DeveloperScannerAdapter['name']): boolean {
  return (
    finding.scanner === scanner &&
    DIGEST.test(finding.fingerprint) &&
    typeof finding.ruleId === 'string' &&
    finding.ruleId.length > 0 &&
    finding.ruleId.length <= 128 &&
    !CREDENTIAL_TEXT.test(finding.ruleId) &&
    (finding.path === null ||
      (typeof finding.path === 'string' &&
        finding.path.length <= 512 &&
        !finding.path.includes('\0') &&
        !finding.path.split(/[\\/]/).includes('..'))) &&
    typeof finding.summary === 'string' &&
    finding.summary.length > 0 &&
    finding.summary.length <= 240 &&
    !CREDENTIAL_TEXT.test(finding.summary) &&
    ['info', 'low', 'medium', 'high', 'critical'].includes(finding.severity) &&
    ['blocking', 'observed'].includes(finding.disposition)
  );
}

function validScannerResult(
  result: ScannerResult,
  scanner: DeveloperScannerAdapter['name'],
): boolean {
  return (
    result !== null &&
    typeof result === 'object' &&
    result.scanner === scanner &&
    ['passed', 'failed', 'inconclusive'].includes(result.state) &&
    Array.isArray(result.findings) &&
    result.findings.length <= 1_000 &&
    result.findings.every((finding) => validFinding(finding, scanner)) &&
    DIGEST.test(result.evidenceDigest) &&
    (result.terminalReason === null ||
      (typeof result.terminalReason === 'string' &&
        result.terminalReason.length <= 128 &&
        !CREDENTIAL_TEXT.test(result.terminalReason)))
  );
}

function validSbom(sbom: ScannerResult['sbom']): sbom is NonNullable<ScannerResult['sbom']> {
  if (
    !sbom ||
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.6' ||
    sbom.version !== 1 ||
    !Array.isArray(sbom.components) ||
    sbom.components.length > 10_000
  ) {
    return false;
  }
  const sbomRecord = sbom as unknown as Record<string, unknown>;
  if (
    !onlyKeys(sbomRecord, ['bomFormat', 'specVersion', 'version', 'components', 'dependencies'])
  ) {
    return false;
  }
  const references = new Set<string>();
  for (const value of sbom.components) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const component = value as Record<string, unknown>;
    if (!onlyKeys(component, ['type', 'name', 'version', 'purl', 'bom-ref', 'hashes']))
      return false;
    if (
      component.type !== 'library' ||
      !boundedText(component.name, 214) ||
      !boundedText(component.version, 128) ||
      !boundedText(component.purl, 512) ||
      !String(component.purl).startsWith('pkg:') ||
      component['bom-ref'] !== component.purl ||
      references.has(String(component.purl))
    ) {
      return false;
    }
    references.add(String(component.purl));
    if (component.hashes !== undefined) {
      if (
        !Array.isArray(component.hashes) ||
        component.hashes.length === 0 ||
        component.hashes.length > 3
      ) {
        return false;
      }
      for (const value of component.hashes) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const hash = value as Record<string, unknown>;
        if (!onlyKeys(hash, ['alg', 'content']) || typeof hash.content !== 'string') return false;
        const expectedLength = { 'SHA-256': 64, 'SHA-384': 96, 'SHA-512': 128 }[String(hash.alg)];
        if (
          !expectedLength ||
          hash.content.length !== expectedLength ||
          !/^[0-9a-f]+$/.test(hash.content)
        ) {
          return false;
        }
      }
    }
  }
  if (sbom.dependencies !== undefined) {
    if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length > 10_000) return false;
    for (const value of sbom.dependencies) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const dependency = value as Record<string, unknown>;
      if (
        !onlyKeys(dependency, ['ref', 'dependsOn']) ||
        typeof dependency.ref !== 'string' ||
        !references.has(dependency.ref) ||
        !Array.isArray(dependency.dependsOn) ||
        dependency.dependsOn.some(
          (reference) => typeof reference !== 'string' || !references.has(reference),
        )
      ) {
        return false;
      }
    }
  }
  try {
    const serialized = JSON.stringify(sbom);
    evidenceDigest(sbom);
    return (
      !serialized.includes('serialNumber') &&
      !serialized.includes('timestamp') &&
      !CREDENTIAL_TEXT.test(serialized)
    );
  } catch {
    return false;
  }
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(record);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  );
}
