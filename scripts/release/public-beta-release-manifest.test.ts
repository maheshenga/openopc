import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE,
  PUBLIC_BETA_ARTIFACT_MEDIA_TYPES,
  PUBLIC_BETA_ARTIFACT_NAMES,
  PUBLIC_BETA_ARTIFACT_ROLE_POLICIES,
  PUBLIC_BETA_CYCLONEDX_MEDIA_TYPE,
  PUBLIC_BETA_DSSE_MEDIA_TYPE,
  computePublicBetaArtifactManifestDigest,
} from './public-beta-artifacts';
import type { PublicBetaEvidenceLedgerV2 } from './public-beta-evidence-v2';
import {
  PUBLIC_BETA_RELEASE_ARTIFACT_NAMES,
  type PublicBetaReleaseArtifactName,
  computePublicBetaEvidenceDigest,
  computePublicBetaEvidenceSchemaDigest,
  computePublicBetaManifestDigest,
  evaluatePublicBetaReadiness,
  parsePublicBetaReleaseManifest,
  verifyPublicBetaArtifactProvenanceFromLedger,
  verifyPublicBetaArtifactSbomFromLedger,
} from './public-beta-release-manifest';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
} from './public-beta-release-profile';

const COMMIT = 'a'.repeat(40);
const ROLLBACK_COMMIT = 'b'.repeat(40);
const NOW = new Date('2026-07-28T12:00:00.000Z');
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;

interface ApprovalWorkflowStep {
  id?: string;
  name?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  run?: string;
}

interface ApprovalWorkflowJob {
  if?: string;
  environment?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: ApprovalWorkflowStep[];
}

interface ApprovalWorkflow {
  jobs: Record<string, ApprovalWorkflowJob>;
}

async function approvalWorkflow(): Promise<{
  source: string;
  workflow: ApprovalWorkflow;
}> {
  const source = await Bun.file('.github/workflows/openopc-public-beta-approval.yml').text();
  return {
    source,
    workflow: Bun.YAML.parse(source) as ApprovalWorkflow,
  };
}

function workflowStep(job: ApprovalWorkflowJob, id: string): ApprovalWorkflowStep {
  const step = job.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`Missing workflow step: ${id}`);
  return step;
}

const LANES = {
  G1: 'public-beta-g1-migration',
  G2: 'public-beta-g2-artifact-storage',
  G3: 'public-beta-g3-trust-pipeline',
  G4: 'public-beta-g4-malicious-fixtures',
  G5: 'public-beta-g5-wasi',
  G8: 'public-beta-g8-tenant-authority',
  G10: 'public-beta-g10-release-lifecycle',
  G11: 'public-beta-g11-web-desktop',
  G12: 'public-beta-g12-upstream-compatibility',
  B1: 'public-beta-b1-registration',
  B2: 'public-beta-b2-web-independence',
  B3: 'public-beta-b3-admin-isolation',
  B4: 'public-beta-b4-module-workflow',
  B5: 'public-beta-b5-runtime-isolation',
  B7: 'public-beta-b7-backup-recovery',
  B8: 'public-beta-b8-telemetry-incident',
  B9: 'public-beta-b9-brand-upstream',
  B10: 'public-beta-b10-two-node-deployment',
} as const;

type Gate = keyof typeof LANES;

function plusHours(value: string, hours: number): string {
  return new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
}

function evidenceRecord(gate: Gate, index = 1) {
  const id = `${gate.toLowerCase()}-${index}`;
  const finishedAt = '2026-07-28T11:00:00.000Z';
  const expiryHours = gate === 'B10' ? 24 : gate === 'B7' ? 168 : 72;
  const path = `artifacts/public-beta/raw/${id}.json`;
  return {
    id,
    gate,
    lane: LANES[gate],
    attempt: index,
    environment: 'openopc-public-beta-staging' as const,
    commit: COMMIT,
    command: `pnpm.cmd test:${LANES[gate]}`,
    workflow: {
      repository: 'maheshenga/openopc',
      workflow: 'openopc-public-beta-gates.yml',
      runId: String(1_000 + index),
      runAttempt: 1,
    },
    startedAt: plusHours(finishedAt, -1),
    finishedAt,
    expiresAt: plusHours(finishedAt, expiryHours),
    outcome: 'passed' as const,
    stagingUrls: ['https://staging.openopc.example'],
    dependencyIdentities: ['postgresql:16.4', 'openopc-api:sha256:abc'],
    artifacts: [
      {
        path,
        digest: DIGEST_A,
        sizeBytes: 128,
        mediaType: 'application/json',
      },
    ],
    rawEvidencePaths: [path],
    resolvesFailureIds: [],
    companionEvidenceIds: [],
  };
}

function completeEvidence(): PublicBetaEvidenceLedgerV2 {
  const records = (Object.keys(LANES) as Gate[])
    .filter((gate) => gate !== 'B7')
    .map((gate) => evidenceRecord(gate));
  const smoke = evidenceRecord('B7', 2);
  smoke.id = 'b7-post-restore-smoke';
  smoke.finishedAt = '2026-07-28T11:00:00.000Z';
  smoke.startedAt = '2026-07-28T10:00:00.000Z';
  smoke.expiresAt = '2026-07-29T11:00:00.000Z';
  const restore = evidenceRecord('B7', 1);
  restore.id = 'b7-isolated-restore';
  restore.finishedAt = '2026-07-26T11:00:00.000Z';
  restore.startedAt = '2026-07-26T10:00:00.000Z';
  restore.expiresAt = '2026-08-02T11:00:00.000Z';
  restore.companionEvidenceIds = [smoke.id];
  records.push(restore, smoke);
  const artifactManifestRawBytes = JSON.stringify(releaseArtifactManifest());
  const trustRecord = records.find((record) => record.gate === 'G3');
  if (!trustRecord) throw new Error('G3_EVIDENCE_MISSING');
  trustRecord.artifacts.push({
    path: 'artifacts/public-beta/release-artifacts.json',
    digest: computePublicBetaEvidenceDigest(artifactManifestRawBytes),
    sizeBytes: new TextEncoder().encode(artifactManifestRawBytes).byteLength,
    mediaType: PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE,
  });
  return {
    schemaVersion: 2,
    candidateCommit: COMMIT,
    environment: 'openopc-public-beta-staging',
    releaseProfileId: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.id,
    releaseProfileDigest: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
    schemaDigest: computePublicBetaEvidenceSchemaDigest(),
    artifactSetDigest: releaseArtifactManifest().manifestDigest,
    records,
  };
}

function rawEvidence(evidence: PublicBetaEvidenceLedgerV2): string {
  return JSON.stringify(evidence);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('NON_JSON_VALUE');
}

function artifact(name: PublicBetaReleaseArtifactName, index: number) {
  const digest = `sha256:${String(index).padStart(64, '0')}` as const;
  const policy = PUBLIC_BETA_ARTIFACT_ROLE_POLICIES[name];
  return {
    name,
    digest,
    imageOrPath:
      policy.locatorKind === 'oci'
        ? `oci://registry.openopc.example/${policy.repository}@${digest}`
        : `artifacts/public-beta/${name}/${name}-${COMMIT}${policy.pathSuffix}`,
  };
}

function releaseArtifactManifest(commit = COMMIT) {
  const artifacts = PUBLIC_BETA_ARTIFACT_NAMES.map((name, index) => ({
    name,
    digest: artifact(name, index + 1).digest as `sha256:${string}`,
    sbomDigest: artifact(name, index + 101).digest as `sha256:${string}`,
    provenanceDigest: artifact(name, index + 201).digest as `sha256:${string}`,
    mediaType: PUBLIC_BETA_ARTIFACT_MEDIA_TYPES[name],
  }));
  const value = { schemaVersion: 1 as const, commit, artifacts, manifestDigest: DIGEST_A };
  return { ...value, manifestDigest: computePublicBetaArtifactManifestDigest(value) };
}

function baseManifest() {
  return {
    schemaVersion: 1,
    candidateId: 'openopc-public-beta-2026-07-28',
    commit: COMMIT,
    environment: 'openopc-public-beta-staging',
    artifacts: PUBLIC_BETA_RELEASE_ARTIFACT_NAMES.map((name, index) => artifact(name, index + 1)),
    artifactManifestPath: 'artifacts/public-beta/release-artifacts.json',
    artifactManifestDigest: releaseArtifactManifest().manifestDigest,
    evidencePath: 'artifacts/public-beta/evidence.v2.json',
    evidenceDigest: computePublicBetaEvidenceDigest(rawEvidence(completeEvidence())),
    rollbackTarget: {
      commit: ROLLBACK_COMMIT,
      manifestDigest: DIGEST_C,
    },
    policyVersions: {
      terms: '2026.07.28',
      privacy: '2026.07.28',
      acceptableUse: '2026.07.28',
      moduleRules: '2026.07.28',
    },
    regionalEvidence: [
      {
        id: 'mainland-cn-icp',
        status: 'satisfied' as const,
        artifactDigest: DIGEST_A,
      },
    ],
    approval: null,
  };
}

function validInput() {
  const evidence = completeEvidence();
  const raw = rawEvidence(evidence);
  const manifest = baseManifest();
  manifest.evidenceDigest = computePublicBetaEvidenceDigest(raw);
  return { manifest: parsePublicBetaReleaseManifest(manifest), evidence, raw };
}

function verifiedEvidenceInput(evidence: PublicBetaEvidenceLedgerV2, raw: string) {
  return {
    ledger: evidence,
    rawBytes: raw,
    artifactManifest: releaseArtifactManifest(),
    artifactManifestRawBytes: JSON.stringify(releaseArtifactManifest()),
    verifyArtifact: () => true,
    verifyReleaseArtifact: () => true,
    verifyArtifactSbom: () => true,
    verifyArtifactProvenance: () => true,
    verifyProvenance: () => true,
  };
}

function withApproval(manifest: ReturnType<typeof baseManifest>) {
  const preApproval = parsePublicBetaReleaseManifest(manifest);
  return {
    ...manifest,
    approval: {
      environment: 'production' as const,
      actor: 'release-approver',
      approvedAt: '2026-07-28T11:30:00.000Z',
      manifestDigest: computePublicBetaManifestDigest(preApproval),
    },
  };
}

describe('public beta release candidate manifest', () => {
  test('requires the bundle artifact manifest path and digest', () => {
    const artifactManifest = releaseArtifactManifest();
    const candidate = {
      ...baseManifest(),
      artifactManifestPath: 'artifacts/public-beta/release-artifacts.json',
      artifactManifestDigest: artifactManifest.manifestDigest,
    };

    expect(parsePublicBetaReleaseManifest(candidate).artifactManifestPath).toBe(
      candidate.artifactManifestPath,
    );

    const missingPath = { ...candidate } as Partial<typeof candidate>;
    delete missingPath.artifactManifestPath;
    expect(() => parsePublicBetaReleaseManifest(missingPath)).toThrow(
      'PUBLIC_BETA_RELEASE_MANIFEST_KEYS_INVALID',
    );
  });

  test('rejects unknown top-level keys and non-SHA artifact digests', () => {
    const unknown = { ...baseManifest(), extra: true };
    expect(() => parsePublicBetaReleaseManifest(unknown)).toThrow(
      'PUBLIC_BETA_RELEASE_MANIFEST_KEYS_INVALID',
    );

    const invalidDigest = baseManifest();
    invalidDigest.artifacts[0].digest = 'latest';
    expect(() => parsePublicBetaReleaseManifest(invalidDigest)).toThrow(
      'PUBLIC_BETA_RELEASE_ARTIFACT_INVALID',
    );
  });

  test('rejects missing required artifacts, policies, regional evidence, and rollback target', () => {
    const missingArtifact = baseManifest();
    missingArtifact.artifacts = missingArtifact.artifacts.filter((item) => item.name !== 'web');
    expect(() => parsePublicBetaReleaseManifest(missingArtifact)).toThrow(
      'PUBLIC_BETA_RELEASE_ARTIFACTS_INCOMPLETE',
    );

    const missingPolicy = baseManifest();
    missingPolicy.policyVersions.terms = '';
    expect(() => parsePublicBetaReleaseManifest(missingPolicy)).toThrow(
      'PUBLIC_BETA_RELEASE_POLICY_INVALID',
    );

    const nonCanonicalPolicy = baseManifest();
    nonCanonicalPolicy.policyVersions.terms = '\ud800';
    expect(() => parsePublicBetaReleaseManifest(nonCanonicalPolicy)).toThrow(
      'PUBLIC_BETA_RELEASE_POLICY_INVALID',
    );

    const missingRegion = baseManifest();
    missingRegion.regionalEvidence = [];
    expect(() => parsePublicBetaReleaseManifest(missingRegion)).toThrow(
      'PUBLIC_BETA_RELEASE_REGIONAL_EVIDENCE_INVALID',
    );

    const missingRollback = baseManifest();
    (missingRollback as { rollbackTarget: unknown }).rollbackTarget = null;
    expect(() => parsePublicBetaReleaseManifest(missingRollback)).toThrow(
      'PUBLIC_BETA_RELEASE_ROLLBACK_INVALID',
    );
  });

  test('rejects mixed-commit evidence and evidence digest mismatch', () => {
    const { manifest, evidence, raw } = validInput();
    evidence.records[0].commit = ROLLBACK_COMMIT;
    const result = evaluatePublicBetaReadiness(manifest, verifiedEvidenceInput(evidence, raw), NOW);
    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_EVIDENCE_COMMIT_MISMATCH');

    const wrongDigest = parsePublicBetaReleaseManifest({ ...manifest, evidenceDigest: DIGEST_C });
    const digestResult = evaluatePublicBetaReadiness(
      wrongDigest,
      verifiedEvidenceInput(completeEvidence(), raw),
      NOW,
    );
    expect(digestResult.reasons).toContain('PUBLIC_BETA_EVIDENCE_DIGEST_MISMATCH');
  });

  test('remains not ready before a matching human approval', () => {
    const { manifest, evidence, raw } = validInput();
    expect(evaluatePublicBetaReadiness(manifest, verifiedEvidenceInput(evidence, raw), NOW)).toEqual(
      {
        status: 'not_ready',
        reasons: ['PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED'],
      },
    );
  });

  test('accepts a candidate after a production approval binds the pre-approval manifest', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    expect(evaluatePublicBetaReadiness(approved, verifiedEvidenceInput(evidence, raw), NOW)).toEqual(
      {
        status: 'ready',
        reasons: [],
      },
    );
  });

  test('keeps readiness typed when an approved manifest contains invalid canonical JSON', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    approved.policyVersions.terms = '\ud800';

    expect(evaluatePublicBetaReadiness(approved, verifiedEvidenceInput(evidence, raw), NOW)).toEqual({
      status: 'not_ready',
      reasons: ['PUBLIC_BETA_APPROVAL_BINDING_INVALID'],
    });
  });

  test('rejects stale evidence and an approval bound to a different manifest', () => {
    const { manifest, evidence, raw } = validInput();
    const stale = structuredClone(evidence);
    const g1 = stale.records.find((record) => record.gate === 'G1');
    if (!g1) throw new Error('G1_EVIDENCE_MISSING');
    g1.finishedAt = '2026-07-20T11:00:00.000Z';
    g1.startedAt = '2026-07-20T10:00:00.000Z';
    g1.expiresAt = '2026-07-23T11:00:00.000Z';
    const staleResult = evaluatePublicBetaReadiness(
      manifest,
      verifiedEvidenceInput(stale, JSON.stringify(stale)),
      NOW,
    );
    expect(staleResult.reasons).toContain('PUBLIC_BETA_EVIDENCE_STALE');

    const wrongApproval = withApproval(baseManifest());
    wrongApproval.policyVersions.terms = '2026.07.29';
    const parsed = parsePublicBetaReleaseManifest(wrongApproval);
    const approvalResult = evaluatePublicBetaReadiness(
      parsed,
      verifiedEvidenceInput(evidence, raw),
      NOW,
    );
    expect(approvalResult.reasons).toContain('PUBLIC_BETA_APPROVAL_BINDING_INVALID');
  });

  test('keeps digest helpers deterministic', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    expect(computePublicBetaEvidenceDigest(raw)).toBe(
      `sha256:${createHash('sha256').update(raw).digest('hex')}`,
    );
    expect(computePublicBetaManifestDigest(parsePublicBetaReleaseManifest(baseManifest()))).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  test('keeps malformed runtime input inside the release manifest digest boundary', () => {
    const manifest = parsePublicBetaReleaseManifest(baseManifest());
    manifest.policyVersions.terms = '\ud800';

    expect(() => computePublicBetaManifestDigest(manifest)).toThrow(
      'PUBLIC_BETA_RELEASE_MANIFEST_INVALID',
    );
  });

  test('fails closed without raw bytes and required verifiers', () => {
    const evidence = completeEvidence();
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    const result = evaluatePublicBetaReadiness(
      approved,
      { ledger: evidence } as never,
      NOW,
    );
    expect(result).toEqual({
      status: 'not_ready',
      reasons: [
        'PUBLIC_BETA_EVIDENCE_RAW_BYTES_REQUIRED',
        'PUBLIC_BETA_ARTIFACT_MANIFEST_REQUIRED',
        'PUBLIC_BETA_ARTIFACT_MANIFEST_RAW_BYTES_REQUIRED',
        'PUBLIC_BETA_EVIDENCE_ARTIFACT_VERIFIER_REQUIRED',
        'PUBLIC_BETA_RELEASE_ARTIFACT_VERIFIER_REQUIRED',
        'PUBLIC_BETA_SBOM_VERIFIER_REQUIRED',
        'PUBLIC_BETA_PROVENANCE_VERIFIER_REQUIRED',
        'PUBLIC_BETA_RELEASE_PROVENANCE_VERIFIER_REQUIRED',
      ],
    });
  });

  test('fails closed until a trusted provenance verifier binds the candidate evidence', () => {
    const { manifest, evidence, raw } = validInput();
    const approved = parsePublicBetaReleaseManifest(withApproval(manifest));
    const withoutProvenance = verifiedEvidenceInput(evidence, raw);
    delete (withoutProvenance as { verifyProvenance?: unknown }).verifyProvenance;

    const missing = evaluatePublicBetaReadiness(approved, withoutProvenance, NOW);
    expect(missing.status).toBe('not_ready');
    expect(missing.reasons).toContain('PUBLIC_BETA_RELEASE_PROVENANCE_VERIFIER_REQUIRED');

    const rejected = evaluatePublicBetaReadiness(
      approved,
      { ...verifiedEvidenceInput(evidence, raw), verifyProvenance: () => false },
      NOW,
    );
    expect(rejected.status).toBe('not_ready');
    expect(rejected.reasons).toContain('PUBLIC_BETA_RELEASE_PROVENANCE_UNVERIFIED');
  });

  test('fails closed without an artifact SBOM verifier', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    const withoutSbomVerifier = {
      ...verifiedEvidenceInput(evidence, raw),
    } as Omit<ReturnType<typeof verifiedEvidenceInput>, 'verifyArtifactSbom'> & {
      verifyArtifactSbom?: unknown;
    };
    delete withoutSbomVerifier.verifyArtifactSbom;

    const result = evaluatePublicBetaReadiness(approved, withoutSbomVerifier, NOW);

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_SBOM_VERIFIER_REQUIRED');
  });

  test('fails closed when the artifact manifest is absent', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    const withoutArtifactManifest = {
      ...verifiedEvidenceInput(evidence, raw),
    } as Omit<ReturnType<typeof verifiedEvidenceInput>, 'artifactManifest'> & {
      artifactManifest?: unknown;
    };
    delete withoutArtifactManifest.artifactManifest;

    const result = evaluatePublicBetaReadiness(approved, withoutArtifactManifest, NOW);

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_REQUIRED');
  });

  test('fails closed without the original artifact manifest bytes', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    const withoutRawBytes = {
      ...verifiedEvidenceInput(evidence, raw),
    } as Omit<ReturnType<typeof verifiedEvidenceInput>, 'artifactManifestRawBytes'> & {
      artifactManifestRawBytes?: unknown;
    };
    delete withoutRawBytes.artifactManifestRawBytes;

    const result = evaluatePublicBetaReadiness(approved, withoutRawBytes, NOW);

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_RAW_BYTES_REQUIRED');
  });

  test('rejects artifact manifest bytes that do not match the parsed object', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));

    const result = evaluatePublicBetaReadiness(
      approved,
      {
        ...verifiedEvidenceInput(evidence, raw),
        artifactManifestRawBytes: JSON.stringify(releaseArtifactManifest(ROLLBACK_COMMIT)),
      },
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_BYTES_MISMATCH');
  });

  test('requires the evidence ledger to identify the artifact manifest file', () => {
    const evidence = completeEvidence();
    for (const record of evidence.records) {
      record.artifacts = record.artifacts.filter(
        (artifact) =>
          artifact.mediaType !== PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE,
      );
    }
    const raw = rawEvidence(evidence);
    const candidate = baseManifest();
    candidate.evidenceDigest = computePublicBetaEvidenceDigest(raw);
    const approved = parsePublicBetaReleaseManifest(withApproval(candidate));

    const result = evaluatePublicBetaReadiness(
      approved,
      verifiedEvidenceInput(evidence, raw),
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_EVIDENCE_MISSING');
  });

  test('fails closed when the artifact manifest is malformed', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    let provenanceChecks = 0;

    const result = evaluatePublicBetaReadiness(
      approved,
      {
        ...verifiedEvidenceInput(evidence, raw),
        artifactManifest: {},
        verifyProvenance: () => {
          provenanceChecks += 1;
          return true;
        },
      },
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_INVALID');
    expect(provenanceChecks).toBe(0);
  });

  test('binds the release candidate to the canonical artifact manifest digest', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const mismatched = baseManifest();
    mismatched.artifactManifestDigest = DIGEST_A;
    const approved = parsePublicBetaReleaseManifest(withApproval(mismatched));

    const result = evaluatePublicBetaReadiness(
      approved,
      verifiedEvidenceInput(evidence, raw),
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_DIGEST_MISMATCH');
  });

  test('rejects an artifact manifest from another commit', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const oldArtifactManifest = releaseArtifactManifest(ROLLBACK_COMMIT);
    const candidate = baseManifest();
    candidate.artifactManifestDigest = oldArtifactManifest.manifestDigest;
    const approved = parsePublicBetaReleaseManifest(withApproval(candidate));

    const result = evaluatePublicBetaReadiness(
      approved,
      {
        ...verifiedEvidenceInput(evidence, raw),
        artifactManifest: oldArtifactManifest,
      },
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_ARTIFACT_COMMIT_MISMATCH');
  });

  test('binds the evidence ledger to the canonical artifact set digest', () => {
    const evidence = completeEvidence();
    evidence.artifactSetDigest = DIGEST_C;
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));

    const result = evaluatePublicBetaReadiness(
      approved,
      verifiedEvidenceInput(evidence, raw),
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_EVIDENCE_ARTIFACT_SET_MISMATCH');
  });

  test('binds the evidence ledger to the controlled schema digest', () => {
    const evidence = completeEvidence();
    evidence.schemaDigest = DIGEST_B;
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));

    const result = evaluatePublicBetaReadiness(
      approved,
      verifiedEvidenceInput(evidence, raw),
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_EVIDENCE_SCHEMA_DIGEST_MISMATCH');
  });

  test('binds every release artifact to the artifact manifest entry with the same name', () => {
    const artifactManifest = releaseArtifactManifest();
    artifactManifest.artifacts[0].digest = DIGEST_A;
    artifactManifest.manifestDigest = computePublicBetaArtifactManifestDigest(artifactManifest);
    const artifactManifestRawBytes = JSON.stringify(artifactManifest);
    const evidence = completeEvidence();
    evidence.artifactSetDigest = artifactManifest.manifestDigest;
    const artifactManifestEvidence = evidence.records
      .flatMap((record) => record.artifacts)
      .find((artifact) => artifact.mediaType === PUBLIC_BETA_ARTIFACT_MANIFEST_MEDIA_TYPE);
    if (!artifactManifestEvidence) throw new Error('ARTIFACT_MANIFEST_EVIDENCE_MISSING');
    artifactManifestEvidence.digest = computePublicBetaEvidenceDigest(artifactManifestRawBytes);
    artifactManifestEvidence.sizeBytes = new TextEncoder().encode(artifactManifestRawBytes).byteLength;
    const raw = rawEvidence(evidence);
    const candidate = baseManifest();
    candidate.artifactManifestDigest = artifactManifest.manifestDigest;
    candidate.evidenceDigest = computePublicBetaEvidenceDigest(raw);
    const approved = parsePublicBetaReleaseManifest(withApproval(candidate));

    const result = evaluatePublicBetaReadiness(
      approved,
      {
        ...verifiedEvidenceInput(evidence, raw),
        artifactManifest,
        artifactManifestRawBytes,
      },
      NOW,
    );

    expect(result.status).toBe('not_ready');
    expect(result.reasons).toContain('PUBLIC_BETA_RELEASE_ARTIFACT_SET_MISMATCH');
  });

  test('passes the validated artifact manifest to the overall provenance verifier', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const artifactManifest = releaseArtifactManifest();
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    let receivedArtifactManifest: unknown;

    const result = evaluatePublicBetaReadiness(
      approved,
      {
        ...verifiedEvidenceInput(evidence, raw),
        verifyProvenance: (_release, _ledger, received) => {
          receivedArtifactManifest = received;
          return true;
        },
      },
      NOW,
    );

    expect(result).toEqual({ status: 'ready', reasons: [] });
    expect(receivedArtifactManifest).toEqual(artifactManifest);
  });

  test('requires every release artifact to be verified', () => {
    const evidence = completeEvidence();
    const raw = rawEvidence(evidence);
    const approved = parsePublicBetaReleaseManifest(withApproval(baseManifest()));
    const checked: string[] = [];
    const result = evaluatePublicBetaReadiness(
      approved,
      {
        ...verifiedEvidenceInput(evidence, raw),
        verifyReleaseArtifact: (artifact) => {
          checked.push(artifact.name);
          return artifact.name !== 'desktop';
        },
      },
      NOW,
    );
    expect(checked.sort()).toEqual([...PUBLIC_BETA_RELEASE_ARTIFACT_NAMES].sort());
    expect(result.reasons).toContain('PUBLIC_BETA_RELEASE_ARTIFACT_UNVERIFIED');
  });

  test('loads and verifies CycloneDX SBOM bytes referenced by the evidence ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-public-beta-sbom-'));
    try {
      const artifactEntry = releaseArtifactManifest().artifacts[0];
      if (!artifactEntry) throw new Error('TEST_ARTIFACT_MISSING');
      const sbom = {
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        version: 1,
        metadata: {
          component: {
            type: 'container',
            name: artifactEntry.name,
            version: COMMIT,
            'bom-ref': `urn:openopc:artifact:${artifactEntry.name}@${artifactEntry.digest}`,
            hashes: [
              { alg: 'SHA-256', content: artifactEntry.digest.slice('sha256:'.length) },
            ],
          },
        },
        components: [],
        dependencies: [],
      };
      const raw = JSON.stringify(sbom);
      const path = 'evidence/web.cdx.json';
      mkdirSync(join(root, 'evidence'));
      writeFileSync(join(root, path), raw);
      const digest = computePublicBetaEvidenceDigest(raw);
      const ledger = completeEvidence();
      const record = ledger.records[0];
      if (!record) throw new Error('TEST_EVIDENCE_RECORD_MISSING');
      record.artifacts.push({
        path,
        digest,
        sizeBytes: Buffer.byteLength(raw),
        mediaType: PUBLIC_BETA_CYCLONEDX_MEDIA_TYPE,
      });

      expect(
        verifyPublicBetaArtifactSbomFromLedger(root, ledger, {
          ...artifactEntry,
          sbomDigest: digest,
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loads and verifies DSSE provenance bytes referenced by the evidence ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-public-beta-provenance-'));
    try {
      const artifactEntry = releaseArtifactManifest().artifacts[0];
      if (!artifactEntry) throw new Error('TEST_ARTIFACT_MISSING');
      const ledger = completeEvidence();
      const record = ledger.records.find((entry) => entry.gate === 'G3');
      if (!record) throw new Error('TEST_EVIDENCE_RECORD_MISSING');
      const statement = {
        _type: 'https://in-toto.io/Statement/v1',
        subject: [
          {
            name: artifactEntry.name,
            digest: { sha256: artifactEntry.digest.slice('sha256:'.length) },
          },
        ],
        predicateType: 'https://slsa.dev/provenance/v1',
        predicate: {
          buildDefinition: {
            buildType: 'https://openopc.dev/buildtypes/public-beta/v1',
            externalParameters: {
              artifactName: artifactEntry.name,
              commit: COMMIT,
              sbomDigest: artifactEntry.sbomDigest,
            },
            internalParameters: {},
            resolvedDependencies: [
              {
                uri: `git+https://github.com/${record.workflow.repository}@${COMMIT}`,
                digest: { gitCommit: COMMIT },
              },
            ],
          },
          runDetails: {
            builder: {
              id:
                `https://github.com/${record.workflow.repository}/.github/workflows/${record.workflow.workflow}@refs/heads/staging`,
            },
            metadata: {
              invocationId:
                `https://github.com/${record.workflow.repository}/actions/runs/${record.workflow.runId}/attempts/${record.workflow.runAttempt}`,
              startedOn: record.startedAt,
              finishedOn: record.finishedAt,
            },
          },
        },
      };
      const envelope = {
        payloadType: 'application/vnd.in-toto+json',
        payload: Buffer.from(canonicalJson(statement), 'utf8').toString('base64'),
        signatures: [
          {
            keyid: 'openopc-public-beta-sigstore',
            sig: Buffer.from('signature', 'utf8').toString('base64'),
          },
        ],
      };
      const raw = JSON.stringify(envelope);
      const path = 'evidence/web.provenance.dsse.json';
      mkdirSync(join(root, 'evidence'));
      writeFileSync(join(root, path), raw);
      const digest = computePublicBetaEvidenceDigest(raw);
      record.artifacts.push({
        path,
        digest,
        sizeBytes: Buffer.byteLength(raw),
        mediaType: PUBLIC_BETA_DSSE_MEDIA_TYPE,
      });
      record.rawEvidencePaths.push(path);
      let signatureVerified = false;
      const boundArtifact = { ...artifactEntry, provenanceDigest: digest };

      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(
          root,
          ledger,
          boundArtifact,
          (_value, preAuthEncoding) => {
            signatureVerified = new TextDecoder().decode(preAuthEncoding).startsWith('DSSEv1 ');
            return true;
          },
        ),
      ).toBe(true);
      expect(signatureVerified).toBe(true);
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact),
      ).toBe(false);
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => false),
      ).toBe(false);
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => {
          throw new Error('SIGNATURE_BACKEND_UNAVAILABLE');
        }),
      ).toBe(false);

      const gate = record.gate;
      record.gate = 'G4';
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.gate = gate;

      const outcome = record.outcome;
      record.outcome = 'failed';
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.outcome = outcome;

      const recordCommit = record.commit;
      record.commit = ROLLBACK_COMMIT;
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.commit = recordCommit;

      const runtimeRecord = record as unknown as { environment: string };
      const recordEnvironment = runtimeRecord.environment;
      runtimeRecord.environment = 'openopc-public-beta-other';
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      runtimeRecord.environment = recordEnvironment;

      const workflow = record.workflow.workflow;
      record.workflow.workflow = 'untrusted-build.yml';
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.workflow.workflow = workflow;

      const runId = record.workflow.runId;
      record.workflow.runId = '9999';
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.workflow.runId = runId;

      const startedAt = record.startedAt;
      record.startedAt = '2026-07-28T09:00:00.000Z';
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.startedAt = startedAt;

      record.rawEvidencePaths = record.rawEvidencePaths.filter((entry) => entry !== path);
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      record.rawEvidencePaths.push(path);

      const evidenceArtifact = record.artifacts.find((entry) => entry.path === path);
      if (!evidenceArtifact) throw new Error('TEST_PROVENANCE_ARTIFACT_MISSING');
      const sizeBytes = evidenceArtifact.sizeBytes;
      evidenceArtifact.sizeBytes += 1;
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      evidenceArtifact.sizeBytes = sizeBytes;

      writeFileSync(join(root, path), `${raw.slice(0, -1)} `);
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
      writeFileSync(join(root, path), raw);

      const duplicateRecord = ledger.records.find((entry) => entry.gate === 'G4');
      if (!duplicateRecord) throw new Error('TEST_DUPLICATE_EVIDENCE_RECORD_MISSING');
      duplicateRecord.artifacts.push({
        path,
        digest,
        sizeBytes: Buffer.byteLength(raw),
        mediaType: PUBLIC_BETA_DSSE_MEDIA_TYPE,
      });
      duplicateRecord.rawEvidencePaths.push(path);
      expect(
        verifyPublicBetaArtifactProvenanceFromLedger(root, ledger, boundArtifact, () => true),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed for malformed provenance evidence owner metadata', () => {
    const artifactEntry = releaseArtifactManifest().artifacts[0];
    if (!artifactEntry) throw new Error('TEST_ARTIFACT_MISSING');
    const ledger = {
      candidateCommit: COMMIT,
      environment: 'openopc-public-beta-staging',
      records: [
        {
          gate: 'G3',
          outcome: 'passed',
          commit: COMMIT,
          environment: 'openopc-public-beta-staging',
          workflow: null,
          rawEvidencePaths: [],
          artifacts: [
            {
              path: 'evidence/malformed.dsse.json',
              digest: artifactEntry.provenanceDigest,
              sizeBytes: 1,
              mediaType: PUBLIC_BETA_DSSE_MEDIA_TYPE,
            },
          ],
        },
      ],
    } as unknown as PublicBetaEvidenceLedgerV2;
    let result: boolean | undefined;

    expect(() => {
      result = verifyPublicBetaArtifactProvenanceFromLedger(
        process.cwd(),
        ledger,
        artifactEntry,
        () => true,
      );
    }).not.toThrow();
    expect(result).toBe(false);
  });

  test('rejects mutable, absolute, traversal, and malformed release references', () => {
    for (const reference of [
      'repo:Latest',
      'repo:latest/',
      'repo:latest?tag=x',
      '../outside/image@sha256:abc',
      '/etc/passwd',
      'C:/Windows/secret.exe',
    ]) {
      const manifest = baseManifest();
      manifest.artifacts[0].imageOrPath = reference;
      expect(() => parsePublicBetaReleaseManifest(manifest)).toThrow(
        'PUBLIC_BETA_RELEASE_ARTIFACT_INVALID',
      );
    }
  });

  test('rejects an OCI service locator relabeled as the Desktop artifact', () => {
    const manifest = baseManifest();
    const desktop = manifest.artifacts.find((entry) => entry.name === 'desktop');
    if (!desktop) throw new Error('TEST_DESKTOP_ARTIFACT_MISSING');
    desktop.imageOrPath = `oci://registry.openopc.example/openopc/web@${desktop.digest}`;

    expect(() => parsePublicBetaReleaseManifest(manifest)).toThrow(
      'PUBLIC_BETA_RELEASE_ARTIFACT_INVALID',
    );
  });

  test('rejects a bundle locator relabeled as an OCI service artifact', () => {
    const manifest = baseManifest();
    const web = manifest.artifacts.find((entry) => entry.name === 'web');
    if (!web) throw new Error('TEST_WEB_ARTIFACT_MISSING');
    web.imageOrPath = `artifacts/public-beta/web/web-${COMMIT}.tar.zst`;

    expect(() => parsePublicBetaReleaseManifest(manifest)).toThrow(
      'PUBLIC_BETA_RELEASE_ARTIFACT_INVALID',
    );
  });

  test('rejects an OCI locator whose repository belongs to another role', () => {
    const manifest = baseManifest();
    const web = manifest.artifacts.find((entry) => entry.name === 'web');
    if (!web) throw new Error('TEST_WEB_ARTIFACT_MISSING');
    web.imageOrPath = `oci://registry.openopc.example/openopc/api@${web.digest}`;

    expect(() => parsePublicBetaReleaseManifest(manifest)).toThrow(
      'PUBLIC_BETA_RELEASE_ARTIFACT_INVALID',
    );
  });

  test('rejects a bundle whose filename belongs to another role', () => {
    const manifest = baseManifest();
    const wasi = manifest.artifacts.find((entry) => entry.name === 'wasi-runner');
    if (!wasi) throw new Error('TEST_WASI_ARTIFACT_MISSING');
    wasi.imageOrPath = `artifacts/public-beta/wasi-runner/oci-runner-${COMMIT}.tar.zst`;

    expect(() => parsePublicBetaReleaseManifest(manifest)).toThrow(
      'PUBLIC_BETA_RELEASE_ARTIFACT_INVALID',
    );
  });

  test('verifies actual HTTPS bytes and OCI registry identity for remote artifacts', async () => {
    const module = (await import('./public-beta-release-manifest')) as unknown as {
      verifyRemotePublicBetaReleaseArtifact?: (
        artifact: {
          name: PublicBetaReleaseArtifactName;
          digest: `sha256:${string}`;
          imageOrPath: string;
        },
        fetcher?: typeof fetch,
        resolveHostname?: (hostname: string) => Promise<readonly string[]>,
      ) => Promise<boolean>;
    };
    const verify = module.verifyRemotePublicBetaReleaseArtifact;
    expect(typeof verify).toBe('function');
    if (!verify) return;

    const bytes = new TextEncoder().encode('verified public beta artifact');
    const digest = computePublicBetaEvidenceDigest(bytes);
    const resolvePublicHost = async () => ['93.184.216.34'];
    const httpsArtifact = {
      name: 'desktop' as const,
      digest,
      imageOrPath: `https://artifacts.openopc.example/releases/desktop-${COMMIT}.tar.zst@${digest}`,
    };
    const httpsFetch = (async () =>
      new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.byteLength) },
      })) as typeof fetch;
    expect(await verify(httpsArtifact, httpsFetch, resolvePublicHost)).toBe(true);
    expect(
      await verify(
        httpsArtifact,
        (async () => new Response('different bytes', { status: 200 })) as typeof fetch,
        resolvePublicHost,
      ),
    ).toBe(false);
    expect(
      await verify(
        httpsArtifact,
        (async () => new Response('missing', { status: 404 })) as typeof fetch,
        resolvePublicHost,
      ),
    ).toBe(false);

    let redirectFollowed = false;
    const redirectingFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect === 'follow') {
        redirectFollowed = true;
        return new Response(bytes, { status: 200 });
      }
      return new Response(null, {
        status: 302,
        headers: { location: 'https://127.0.0.1/private-artifact' },
      });
    }) as typeof fetch;
    expect(await verify(httpsArtifact, redirectingFetch, resolvePublicHost)).toBe(false);
    expect(redirectFollowed).toBe(false);

    const ociArtifact = {
      name: 'web' as const,
      digest,
      imageOrPath: `oci://registry.openopc.example/openopc/web@${digest}`,
    };
    const requested: string[] = [];
    let ociRedirectMode: RequestRedirect | undefined;
    let ociMethod: string | undefined;
    const ociFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(input));
      ociRedirectMode = init?.redirect;
      ociMethod = init?.method;
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-length': String(bytes.byteLength),
          'docker-content-digest': digest,
        },
      });
    }) as typeof fetch;
    expect(await verify(ociArtifact, ociFetch, resolvePublicHost)).toBe(true);
    expect(requested).toEqual([
      `https://registry.openopc.example/v2/openopc/web/manifests/${digest}`,
    ]);
    expect(ociRedirectMode).toBe('error');
    expect(ociMethod).toBe('GET');
    expect(
      await verify(
        ociArtifact,
        (async () =>
          new Response('different manifest', {
            status: 200,
            headers: { 'docker-content-digest': digest },
          })) as typeof fetch,
        resolvePublicHost,
      ),
    ).toBe(false);

    let privateFetchCalled = false;
    expect(
      await verify(
        {
          ...httpsArtifact,
          imageOrPath: `https://127.0.0.1/releases/desktop-${COMMIT}.tar.zst@${digest}`,
        },
        (async () => {
          privateFetchCalled = true;
          return new Response(bytes, { status: 200 });
        }) as typeof fetch,
        resolvePublicHost,
      ),
    ).toBe(false);
    expect(privateFetchCalled).toBe(false);

    let reboundFetchCalled = false;
    expect(
      await verify(
        httpsArtifact,
        (async () => {
          reboundFetchCalled = true;
          return new Response(bytes, { status: 200 });
        }) as typeof fetch,
        async () => ['127.0.0.1'],
      ),
    ).toBe(false);
    expect(reboundFetchCalled).toBe(false);
  });

  test('rejects every non-public DNS answer before remote artifact fetch', async () => {
    const module = (await import('./public-beta-release-manifest')) as unknown as {
      verifyRemotePublicBetaReleaseArtifact?: (
        artifact: {
          name: PublicBetaReleaseArtifactName;
          digest: `sha256:${string}`;
          imageOrPath: string;
        },
        fetcher?: typeof fetch,
        resolveHostname?: (hostname: string) => Promise<readonly string[]>,
      ) => Promise<boolean>;
    };
    const verify = module.verifyRemotePublicBetaReleaseArtifact;
    expect(typeof verify).toBe('function');
    if (!verify) return;

    const bytes = new TextEncoder().encode('verified public beta artifact');
    const digest = computePublicBetaEvidenceDigest(bytes);
    const artifact = {
      name: 'desktop' as const,
      digest,
      imageOrPath: `https://artifacts.openopc.example/releases/desktop-${COMMIT}.tar.zst@${digest}`,
    };
    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '169.254.169.254',
      '224.0.0.1',
      '::',
      '::1',
      'fc00::1',
      'fe80::1',
      'ff02::1',
    ]) {
      let fetchCalled = false;
      expect(
        await verify(
          artifact,
          (async () => {
            fetchCalled = true;
            return new Response(bytes, { status: 200 });
          }) as typeof fetch,
          async () => [address],
        ),
      ).toBe(false);
      expect(fetchCalled).toBe(false);
    }

    let mixedFetchCalled = false;
    expect(
      await verify(
        artifact,
        (async () => {
          mixedFetchCalled = true;
          return new Response(bytes, { status: 200 });
        }) as typeof fetch,
        async () => ['93.184.216.34', '10.0.0.1'],
      ),
    ).toBe(false);
    expect(mixedFetchCalled).toBe(false);
  });

  test('rejects a private OCI bearer realm before requesting a token', async () => {
    const module = (await import('./public-beta-release-manifest')) as unknown as {
      verifyRemotePublicBetaReleaseArtifact?: (
        artifact: {
          name: 'web';
          digest: `sha256:${string}`;
          imageOrPath: string;
        },
        fetcher?: typeof fetch,
        resolveHostname?: (hostname: string) => Promise<readonly string[]>,
      ) => Promise<boolean>;
    };
    const verify = module.verifyRemotePublicBetaReleaseArtifact;
    expect(typeof verify).toBe('function');
    if (!verify) return;

    const digest = computePublicBetaEvidenceDigest('verified public beta artifact');
    const artifact = {
      name: 'web' as const,
      digest,
      imageOrPath: `oci://registry.openopc.example/openopc/web@${digest}`,
    };
    let registryRequests = 0;
    let tokenFetchCalled = false;
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://auth.openopc.example/')) {
        tokenFetchCalled = true;
        return Response.json({ token: 'private-realm-token' });
      }
      registryRequests += 1;
      if (registryRequests === 1) {
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://auth.openopc.example/token",service="registry.openopc.example",scope="repository:openopc/web:pull"',
          },
        });
      }
      return new Response(null, {
        status: 200,
        headers: { 'docker-content-digest': digest },
      });
    }) as typeof fetch;
    const resolveHostname = async (hostname: string) =>
      hostname === 'auth.openopc.example' ? ['10.0.0.1'] : ['93.184.216.34'];

    expect(await verify(artifact, fetcher, resolveHostname)).toBe(false);
    expect(tokenFetchCalled).toBe(false);
  });

  test('bounds OCI bearer tokens and hashes the authenticated manifest body', async () => {
    const module = (await import('./public-beta-release-manifest')) as unknown as {
      verifyRemotePublicBetaReleaseArtifact?: (
        artifact: {
          name: 'web';
          digest: `sha256:${string}`;
          imageOrPath: string;
        },
        fetcher?: typeof fetch,
        resolveHostname?: (hostname: string) => Promise<readonly string[]>,
      ) => Promise<boolean>;
    };
    const verify = module.verifyRemotePublicBetaReleaseArtifact;
    expect(typeof verify).toBe('function');
    if (!verify) return;

    const bytes = new TextEncoder().encode('authenticated OCI manifest');
    const digest = computePublicBetaEvidenceDigest(bytes);
    const artifact = {
      name: 'web' as const,
      digest,
      imageOrPath: `oci://registry.openopc.example/openopc/web@${digest}`,
    };
    const challenge =
      'Bearer realm="https://auth.openopc.example/token",service="registry.openopc.example",scope="repository:openopc/web:pull"';
    let registryRequests = 0;
    let tokenSignal: AbortSignal | null | undefined;
    const authenticatedFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).startsWith('https://auth.openopc.example/')) {
        tokenSignal = init?.signal;
        return Response.json({ token: 'bounded-token' });
      }
      registryRequests += 1;
      if (registryRequests === 1) {
        return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'docker-content-digest': digest },
      });
    }) as typeof fetch;
    const resolvePublicHost = async () => ['93.184.216.34'];

    expect(await verify(artifact, authenticatedFetch, resolvePublicHost)).toBe(true);
    expect(tokenSignal).toBeInstanceOf(AbortSignal);
    expect(registryRequests).toBe(2);

    let oversizedRegistryRequests = 0;
    const oversizedTokenFetch = (async (input: string | URL | Request) => {
      if (String(input).startsWith('https://auth.openopc.example/')) {
        return Response.json(
          { token: 'oversized-token' },
          { headers: { 'content-length': String(1024 * 1024 + 1) } },
        );
      }
      oversizedRegistryRequests += 1;
      if (oversizedRegistryRequests === 1) {
        return new Response(null, { status: 401, headers: { 'www-authenticate': challenge } });
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'docker-content-digest': digest },
      });
    }) as typeof fetch;
    expect(await verify(artifact, oversizedTokenFetch, resolvePublicHost)).toBe(false);
    expect(oversizedRegistryRequests).toBe(1);
  });

  test('uses strict identifiers, paths, and RFC3339 calendar dates', () => {
    const candidate = baseManifest();
    candidate.candidateId = 'candidate id';
    expect(() => parsePublicBetaReleaseManifest(candidate)).toThrow(
      'PUBLIC_BETA_RELEASE_MANIFEST_INVALID',
    );

    const path = baseManifest();
    path.evidencePath = 'C:/Windows/secret.json';
    expect(() => parsePublicBetaReleaseManifest(path)).toThrow(
      'PUBLIC_BETA_RELEASE_MANIFEST_INVALID',
    );

    const approval = withApproval(baseManifest());
    approval.approval.approvedAt = '2026-02-30T00:00:00.000Z';
    expect(() => parsePublicBetaReleaseManifest(approval)).toThrow(
      'PUBLIC_BETA_RELEASE_APPROVAL_INVALID',
    );
  });

  test('runs the workflow validator command with a stable not-ready exit', async () => {
    const child = Bun.spawn(
      [
        'pnpm.cmd',
        'exec',
        'bun',
        'scripts/release/public-beta-release-manifest.ts',
        '--manifest',
        'tests/public-beta/release-candidate.fixture.json',
        '--evidence',
        'tests/public-beta/evidence.fixture.json',
        '--now',
        '2026-07-28T00:00:00.000Z',
      ],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
    );
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(2);
    const result = JSON.parse(stdout) as { status: string; reasons: string[] };
    expect(result).toMatchObject({ status: 'not_ready' });
    expect(result.reasons).toContain('PUBLIC_BETA_RELEASE_ARTIFACT_UNVERIFIED');
    expect(result.reasons).not.toContain('PUBLIC_BETA_ARTIFACT_MANIFEST_REQUIRED');
    expect(result.reasons).not.toContain('PUBLIC_BETA_SBOM_VERIFIER_REQUIRED');
    expect(result.reasons).not.toContain('PUBLIC_BETA_PROVENANCE_VERIFIER_REQUIRED');
    expect(result.reasons).toContain('PUBLIC_BETA_RELEASE_PROVENANCE_VERIFIER_REQUIRED');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expect(stderr.length).toBeGreaterThan(0);
  });

  test('accepts the plan RFC3339 timestamp without fractional seconds', async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        'scripts/release/public-beta-release-manifest.ts',
        '--manifest',
        'tests/public-beta/release-candidate.fixture.json',
        '--evidence',
        'tests/public-beta/evidence.fixture.json',
        '--now',
        '2026-07-28T00:00:00Z',
      ],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
    );
    const [exit, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'not_ready' });
  });

  test('uses an explicit isolated bundle root when the workflow sets one', async () => {
    const repositoryRoot = process.cwd();
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(repositoryRoot, 'scripts/release/public-beta-release-manifest.ts'),
        '--manifest',
        'tests/public-beta/release-candidate.fixture.json',
        '--evidence',
        'tests/public-beta/evidence.fixture.json',
        '--now',
        '2026-07-28T00:00:00Z',
      ],
      {
        cwd: dirname(repositoryRoot),
        env: { ...process.env, OPENOPC_PUBLIC_BETA_BUNDLE_ROOT: repositoryRoot },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exit, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(2);
    expect(JSON.parse(stdout)).toMatchObject({ status: 'not_ready' });
  });

  test('locks artifact names and strict scalar formats in the JSON Schema', async () => {
    const schema = (await Bun.file('tests/public-beta/release-candidate.schema.json').json()) as {
      $comment?: string;
      properties: { artifacts: { allOf?: Array<Record<string, unknown>> } };
      $defs: Record<string, { pattern?: string }>;
    };
    const artifactRules = schema.properties.artifacts.allOf ?? [];
    const lockedNames = artifactRules.flatMap((rule) => {
      const contains = rule.contains as { properties?: { name?: { const?: string } } } | undefined;
      return contains?.properties?.name?.const ? [contains.properties.name.const] : [];
    });
    expect(lockedNames.sort()).toEqual([...PUBLIC_BETA_RELEASE_ARTIFACT_NAMES].sort());
    expect(artifactRules.every((rule) => rule.minContains === 1 && rule.maxContains === 1)).toBe(
      true,
    );

    const relativePath = new RegExp(schema.$defs.relativePath?.pattern ?? 'a^');
    const timestamp = new RegExp(schema.$defs.timestamp?.pattern ?? 'a^');
    const policyVersion = new RegExp(schema.$defs.policyVersion?.pattern ?? 'a^');
    expect(relativePath.test('artifacts/public-beta/evidence.v2.json')).toBe(true);
    expect(relativePath.test('artifacts//evidence.json')).toBe(false);
    expect(relativePath.test('C:/Windows/secret.json')).toBe(false);
    expect(timestamp.test('2026-07-28T00:00:00Z')).toBe(true);
    expect(timestamp.test('2026-07-28T00:00:00.000Z')).toBe(true);
    expect(policyVersion.test('v1 beta')).toBe(true);
    expect(policyVersion.test('v1\tbeta')).toBe(false);
    expect(policyVersion.test('v1\u007fbeta')).toBe(false);
    expect(schema.$comment).toContain('regionalEvidence.id');
    expect(schema.$comment).toContain('rollbackTarget.commit');
    expect(schema.$comment).toContain('content-addressed reference');
    expect(schema.$comment).toContain('artifact.digest');
    expect(schema.$comment).toContain('CLI verifier');
  });

  test('locks every artifact role to its locator policy in the JSON Schema', async () => {
    const schema = (await Bun.file('tests/public-beta/release-candidate.schema.json').json()) as {
      properties: {
        artifacts: {
          allOf?: Array<{
            contains?: {
              required?: string[];
              properties?: {
                name?: { const?: PublicBetaReleaseArtifactName };
                imageOrPath?: { pattern?: string };
              };
            };
          }>;
        };
      };
    };
    const rules = schema.properties.artifacts.allOf ?? [];
    const patterns = Object.fromEntries(
      rules.map((rule) => [
        rule.contains?.properties?.name?.const,
        rule.contains?.properties?.imageOrPath?.pattern,
      ]),
    ) as Partial<Record<PublicBetaReleaseArtifactName, string>>;

    for (const [index, name] of PUBLIC_BETA_RELEASE_ARTIFACT_NAMES.entries()) {
      const pattern = patterns[name];
      expect(pattern).toBeDefined();
      expect(new RegExp(pattern ?? 'a^').test(artifact(name, index + 1).imageOrPath)).toBe(true);
    }
    expect(
      new RegExp(patterns.desktop ?? 'a^').test(
        `oci://registry.openopc.example/openopc/web@${DIGEST_A}`,
      ),
    ).toBe(false);
    expect(
      new RegExp(patterns.web ?? 'a^').test(`artifacts/public-beta/web/web-${COMMIT}.tar.zst`),
    ).toBe(false);
    expect(
      rules.every(
        (rule) =>
          rule.contains?.required?.includes('name') === true &&
          rule.contains.required.includes('imageOrPath'),
      ),
    ).toBe(true);
  });

  test('locks the protected production approval workflow contract', async () => {
    const workflow = await Bun.file('.github/workflows/openopc-public-beta-approval.yml').text();
    const runbook = await Bun.file('docs/runbooks/openopc-public-beta-release.md').text();

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('candidate_run_id:');
    expect(workflow).toContain('expected_commit:');
    expect(workflow).toContain('validate:');
    expect(workflow).toContain('needs: validate');
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('actions/download-artifact@');
    expect(workflow).toContain('run-id: ${{ inputs.candidate_run_id }}');
    expect(workflow).toContain('path: _public-beta-candidate');
    expect(workflow).toContain('OPENOPC_PUBLIC_BETA_BUNDLE_ROOT');
    expect(workflow).toContain('Get-FileHash');
    expect(workflow).toContain('PUBLIC_BETA_PRE_APPROVAL_REASONS_INVALID');
    expect(workflow).toContain('$validatorExit');
    expect(workflow).toContain('PUBLIC_BETA_PRE_APPROVAL_VALIDATOR_EXIT');
    expect(workflow).toContain('ReparsePoint');
    expect(workflow).toContain('PUBLIC_BETA_BUNDLE_PATH_INVALID');
    expect(workflow).toContain('computePublicBetaManifestDigest');
    expect(workflow).toContain(
      'pnpm.cmd exec bun scripts/release/public-beta-release-manifest.ts',
    );
    expect(workflow).not.toContain('pnpm.cmd public-beta:validate');
    expect(workflow).toContain('approval-attestation.json');
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).not.toContain('ConvertTo-Json');
    expect(workflow).not.toMatch(/uses:\s+[^\s@]+@(v\d+|main|master)\b/);
    expect(workflow).not.toMatch(/echo\s+.*secrets\./i);

    for (const required of [
      'preflight',
      'backup',
      'rollback',
      'regional',
      'approval',
      'smoke',
      'PUBLIC_BETA_HUMAN_APPROVAL_REQUIRED',
    ]) {
      expect(runbook.toLowerCase()).toContain(required.toLowerCase());
    }
  });

  test('revalidates artifact manifest bytes in both protected approval jobs', async () => {
    const workflow = await Bun.file('.github/workflows/openopc-public-beta-approval.yml').text();

    expect(workflow.match(/\$manifest\.artifactManifestPath/g)).toHaveLength(2);
    expect(workflow.match(/PUBLIC_BETA_ARTIFACT_MANIFEST_DIGEST_MISMATCH/g)).toHaveLength(2);
    expect(workflow.match(/\$artifactManifestPath = Get-SafeBundleFile/g)).toHaveLength(2);
  });

  test('keeps evidence resolution under the workflow reparse-safe bundle checks', async () => {
    const { workflow } = await approvalWorkflow();
    const validate = workflow.jobs.validate;
    const approve = workflow.jobs.approve;
    const validateDigestStep = validate.steps.find(
      (step) => step.name === 'Verify commit and candidate artifact digests',
    );
    const approveDigestStep = approve.steps.find(
      (step) => step.name === 'Recheck bundle containment and digests before attestation',
    );
    const preapprovalStep = validate.steps.find(
      (step) => step.name === 'Verify the pre-approval candidate is not ready',
    );
    const approvedStep = approve.steps.find(
      (step) => step.name === 'Revalidate the human-approved candidate',
    );

    expect(validateDigestStep?.run).toContain(
      '$evidencePath = Get-SafeBundleFile ([string]$manifest.evidencePath)',
    );
    expect(approveDigestStep?.run).toContain(
      '$evidencePath = Get-SafeBundleFile ([string]$manifest.evidencePath)',
    );
    expect(preapprovalStep?.run).not.toMatch(/\$evidencePath\s*=\s*Join-Path/);
    expect(approvedStep?.run).not.toMatch(/\$evidencePath\s*=\s*Join-Path/);
  });

  test('runs approval logic from one protected control revision', async () => {
    const { source, workflow } = await approvalWorkflow();
    const expectedJobGuard =
      "${{ github.ref == 'refs/heads/main' && github.sha == github.workflow_sha }}";

    for (const jobName of ['validate', 'approve']) {
      const job = workflow.jobs[jobName];
      expect(job?.if).toBe(expectedJobGuard);
      const checkout = job?.steps.find(
        (step) => step.name === 'Checkout the trusted approval control source',
      );
      expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
      expect(checkout?.with).toMatchObject({
        ref: '${{ github.workflow_sha }}',
        'fetch-depth': 1,
      });
    }

    expect(source).not.toContain('ref: ${{ inputs.expected_commit }}');
    expect(source).toContain('$actualCommit -cne $env:APPROVAL_CONTROL_SHA');
    const candidate = workflowStep(workflow.jobs.validate, 'candidate');
    expect(candidate.env).toMatchObject({
      APPROVAL_CONTROL_REF: '${{ github.ref }}',
      APPROVAL_CONTROL_SHA: '${{ github.workflow_sha }}',
    });
    expect(candidate.with?.script).toContain("approvalControlRef !== 'refs/heads/main'");
    expect(candidate.with?.script).toContain('approvalControlSha !== context.sha');

    const attestation = workflowStep(workflow.jobs.approve, 'create-attestation');
    expect(attestation.env).toMatchObject({
      APPROVAL_CONTROL_REF: '${{ github.ref }}',
      APPROVAL_CONTROL_SHA: '${{ github.workflow_sha }}',
      APPROVAL_WORKFLOW_REF: '${{ github.workflow_ref }}',
      APPROVAL_RUN_ATTEMPT: '${{ github.run_attempt }}',
    });
    expect(attestation.run).toContain('approvalControl');
  });

  test('requires a fresh protected-environment review on the first approval attempt', async () => {
    const { workflow } = await approvalWorkflow();
    const approve = workflow.jobs.approve;
    const review = workflowStep(approve, 'environment-review');

    expect(review.env).toMatchObject({
      APPROVAL_RUN_ATTEMPT: '${{ github.run_attempt }}',
    });
    expect(review.with?.script).toContain('approvalRunAttempt !== 1');
    const attestation = workflowStep(approve, 'create-attestation');
    expect(attestation.run).toContain('runAttempt: Number(approvalRunAttempt)');
  });

  test('authenticates candidate provenance and pins one artifact identity across jobs', async () => {
    const { workflow } = await approvalWorkflow();
    const validate = workflow.jobs.validate;
    const approve = workflow.jobs.approve;

    expect(validate.outputs).toEqual({
      candidate_artifact_id: '${{ steps.candidate.outputs.artifact_id }}',
      candidate_artifact_digest: '${{ steps.candidate.outputs.artifact_digest }}',
      candidate_run_attempt: '${{ steps.candidate.outputs.run_attempt }}',
    });

    const candidate = workflowStep(validate, 'candidate');
    expect(candidate.uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/);
    expect(candidate.with?.script).toContain(".github/workflows/openopc-public-beta-gates.yml");
    expect(candidate.with?.script).toContain("run.name !== 'OpenOPC Public Beta Gates'");
    expect(candidate.with?.script).toContain("run.event !== 'workflow_dispatch'");
    expect(candidate.with?.script).toContain("run.head_branch !== 'staging'");
    expect(candidate.with?.script).toContain('getWorkflowRun');
    expect(candidate.with?.script).toContain('head_sha');
    expect(candidate.with?.script).toContain("status !== 'completed'");
    expect(candidate.with?.script).toContain("conclusion !== 'success'");
    expect(candidate.with?.script).toContain('listWorkflowRunArtifacts');
    expect(candidate.with?.script).toContain('artifacts.length !== 1');
    expect(candidate.with?.script).toContain('!artifact.expired');
    expect(candidate.with?.script).toContain('artifact.expires_at');
    expect(candidate.with?.script).toContain('artifact.size_in_bytes');
    expect(candidate.with?.script).toContain('artifact.workflow_run');
    expect(candidate.with?.script).toContain('artifact.digest');
    expect(candidate.with?.script).toContain("core.setOutput('artifact_id'");
    expect(candidate.with?.script).toContain("core.setOutput('artifact_digest'");
    expect(candidate.with?.script).toContain("core.setOutput('run_attempt'");

    const validateDownload = workflowStep(validate, 'download-candidate');
    expect(validateDownload.with).toMatchObject({
      'artifact-ids': '${{ steps.candidate.outputs.artifact_id }}',
      'merge-multiple': true,
      repository: '${{ github.repository }}',
      'run-id': '${{ inputs.candidate_run_id }}',
    });
    expect(validateDownload.with).not.toHaveProperty('name');

    const candidateRecheck = workflowStep(approve, 'candidate-recheck');
    expect(candidateRecheck.uses).toBe(candidate.uses);
    expect(candidateRecheck.env).toMatchObject({
      EXPECTED_ARTIFACT_ID: '${{ needs.validate.outputs.candidate_artifact_id }}',
      EXPECTED_ARTIFACT_DIGEST: '${{ needs.validate.outputs.candidate_artifact_digest }}',
      EXPECTED_RUN_ATTEMPT: '${{ needs.validate.outputs.candidate_run_attempt }}',
    });
    expect(candidateRecheck.with?.script).toContain('PUBLIC_BETA_CANDIDATE_IDENTITY_CHANGED');

    const approveDownload = workflowStep(approve, 'download-candidate');
    expect(approveDownload.with).toMatchObject({
      'artifact-ids': '${{ needs.validate.outputs.candidate_artifact_id }}',
      'merge-multiple': true,
      repository: '${{ github.repository }}',
      'run-id': '${{ inputs.candidate_run_id }}',
    });
    expect(approveDownload.with).not.toHaveProperty('name');

    const attestation = workflowStep(approve, 'create-attestation');
    expect(attestation.env).toMatchObject({
      CANDIDATE_ARTIFACT_ID: '${{ needs.validate.outputs.candidate_artifact_id }}',
      CANDIDATE_ARTIFACT_DIGEST: '${{ needs.validate.outputs.candidate_artifact_digest }}',
      CANDIDATE_RUN_ATTEMPT: '${{ needs.validate.outputs.candidate_run_attempt }}',
    });
    expect(attestation.run).toContain('candidateArtifactId');
    expect(attestation.run).toContain('candidateArtifactDigest');
    expect(attestation.run).toContain('candidateRunAttempt');
  });

  test('binds the attestation to a real non-dispatching production reviewer', async () => {
    const { source, workflow } = await approvalWorkflow();
    const approve = workflow.jobs.approve;
    const review = workflowStep(approve, 'environment-review');

    expect(approve.environment).toBe('production');
    expect(approve.permissions).toEqual({ contents: 'read', actions: 'read' });
    expect(review.uses).toMatch(/^actions\/github-script@[0-9a-f]{40}$/);
    expect(review.env).toEqual({
      APPROVAL_RUN_ID: '${{ github.run_id }}',
      APPROVAL_RUN_ATTEMPT: '${{ github.run_attempt }}',
      DISPATCHER: '${{ github.actor }}',
      TRIGGERING_ACTOR: '${{ github.triggering_actor }}',
    });
    expect(review.with?.script).toContain(
      'GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals',
    );
    expect(review.with?.script).toContain("toLowerCase() === 'approved'");
    expect(review.with?.script).toContain("environment.name?.toLowerCase() === 'production'");
    expect(review.with?.script).toContain("review.user?.type === 'User'");
    expect(review.with?.script).toContain('dispatchers.has(reviewer.toLowerCase())');
    expect(review.with?.script).toContain("core.setOutput('reviewer'");

    const attestation = workflowStep(approve, 'create-attestation');
    expect(attestation.env?.APPROVER).toBe('${{ steps.environment-review.outputs.reviewer }}');
    expect(source).not.toContain('APPROVER: ${{ github.actor }}');

    const runbook = (
      await Bun.file('docs/runbooks/openopc-public-beta-release.md').text()
    ).toLowerCase();
    expect(runbook).toContain('required reviewers');
    expect(runbook).toContain('prevent self-review');
  });

  test('provisions one pinned Bun runtime in each Windows approval job', async () => {
    const { workflow } = await approvalWorkflow();

    for (const jobName of ['validate', 'approve']) {
      const setupSteps = workflow.jobs[jobName].steps.filter((step) =>
        step.uses?.startsWith('oven-sh/setup-bun@'),
      );
      expect(setupSteps).toHaveLength(1);
      expect(setupSteps[0]).toMatchObject({
        uses: 'oven-sh/setup-bun@735343b667d3e6f658f44d0eca948eb6282f2b76',
        with: { 'bun-version': '1.3.14' },
      });
    }
  });
});
