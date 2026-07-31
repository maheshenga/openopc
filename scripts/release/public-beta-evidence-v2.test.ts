import { describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PUBLIC_BETA_LANES } from './public-beta-lanes';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
} from './public-beta-release-profile';
import { OPENOPC_RESTRICTED_PUBLIC_BETA_LANES } from './public-beta-restricted-lanes';

type Subject = typeof import('./public-beta-evidence-v2');

let subject: Subject | undefined;
try {
  subject = await import('./public-beta-evidence-v2');
} catch {
  subject = undefined;
}

const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const NOW = new Date('2026-07-28T12:00:00.000Z');
const DIGEST_A = `sha256:${'a'.repeat(64)}` as const;
const DIGEST_B = `sha256:${'b'.repeat(64)}` as const;
const DIGEST_C = `sha256:${'c'.repeat(64)}` as const;

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
type EvidenceRecord = {
  id: string;
  gate: Gate;
  lane: string;
  attempt: number;
  environment: 'openopc-public-beta-staging';
  commit: string;
  command: string;
  workflow: { repository: string; workflow: string; runId: string; runAttempt: number };
  startedAt: string;
  finishedAt: string;
  expiresAt: string;
  outcome: 'passed' | 'failed' | 'blocked';
  stagingUrls: string[];
  dependencyIdentities: string[];
  artifacts: Array<{ path: string; digest: string; sizeBytes: number; mediaType: string }>;
  rawEvidencePaths: string[];
  resolvesFailureIds: string[];
  companionEvidenceIds: string[];
};

function plusHours(value: string, hours: number): string {
  return new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
}

function record(gate: Gate, options: Partial<EvidenceRecord> = {}): EvidenceRecord {
  const id = options.id ?? `${gate.toLowerCase()}-attempt-1`;
  const finishedAt = options.finishedAt ?? '2026-07-28T11:00:00.000Z';
  const expiryHours = gate === 'B10' ? 24 : 72;
  const artifactPath = `artifacts/public-beta/raw/${id}.json`;
  return {
    id,
    gate,
    lane: LANES[gate],
    attempt: 1,
    environment: 'openopc-public-beta-staging',
    commit: COMMIT,
    command: `pnpm.cmd test:${LANES[gate]}`,
    workflow: {
      repository: 'maheshenga/openopc',
      workflow: 'openopc-public-beta-gates.yml',
      runId: '123456789',
      runAttempt: 1,
    },
    startedAt: plusHours(finishedAt, -1),
    finishedAt,
    expiresAt: plusHours(finishedAt, expiryHours),
    outcome: 'passed',
    stagingUrls: ['https://staging.openopc.example'],
    dependencyIdentities: ['postgresql:16.4', 'openopc-api:sha256:abc'],
    artifacts: [
      {
        path: artifactPath,
        digest: DIGEST_A,
        sizeBytes: 128,
        mediaType: 'application/json',
      },
    ],
    rawEvidencePaths: [artifactPath],
    resolvesFailureIds: [],
    companionEvidenceIds: [],
    ...options,
  };
}

function completeLedger() {
  const records = (Object.keys(LANES) as Gate[])
    .filter((gate) => gate !== 'B7')
    .map((gate) => record(gate));
  const smoke = record('B7', {
    id: 'b7-post-restore-smoke',
    attempt: 2,
    finishedAt: '2026-07-28T11:00:00.000Z',
    expiresAt: '2026-07-29T11:00:00.000Z',
  });
  const restore = record('B7', {
    id: 'b7-isolated-restore',
    attempt: 1,
    finishedAt: '2026-07-26T11:00:00.000Z',
    expiresAt: '2026-08-02T11:00:00.000Z',
    companionEvidenceIds: [smoke.id],
  });
  records.push(restore, smoke);
  return {
    schemaVersion: 2,
    candidateCommit: COMMIT,
    environment: 'openopc-public-beta-staging',
    releaseProfileId: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.id,
    releaseProfileDigest: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
    schemaDigest: DIGEST_B,
    artifactSetDigest: DIGEST_C,
    records,
  };
}

function requireRecord(
  ledger: ReturnType<typeof completeLedger>,
  selector: number | ((value: EvidenceRecord) => boolean),
): EvidenceRecord {
  const value =
    typeof selector === 'number' ? ledger.records[selector] : ledger.records.find(selector);
  if (value === undefined) throw new Error('EXPECTED_EVIDENCE_TEST_RECORD');
  return value;
}

function validate(
  value: unknown,
  verifyArtifact = () => true,
  lanes = OPENOPC_RESTRICTED_PUBLIC_BETA_LANES,
) {
  if (!subject) throw new Error('PUBLIC_BETA_EVIDENCE_V2_SUBJECT_MISSING');
  return subject.validatePublicBetaEvidenceLedgerV2(value, {
    now: NOW,
    expectedCommit: COMMIT,
    verifyArtifact,
    profile: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
    lanes,
    expectedArtifactSetDigest: DIGEST_C,
  });
}

function materializeEvidenceArtifacts(
  root: string,
  ledger: ReturnType<typeof completeLedger>,
): void {
  for (const record of ledger.records) {
    for (const artifact of record.artifacts) {
      const bytes = Buffer.from(JSON.stringify({ path: artifact.path }));
      const absolute = join(root, artifact.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, bytes);
      artifact.sizeBytes = bytes.byteLength;
      artifact.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    }
  }
}

async function runEvidenceCli(cwd: string, ledgerPath: string) {
  if (!subject) throw new Error('PUBLIC_BETA_EVIDENCE_V2_SUBJECT_MISSING');
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await subject.runPublicBetaEvidenceCli(
    [
      '--ledger',
      ledgerPath,
      '--commit',
      COMMIT,
      '--now',
      '2026-07-28T12:00:00.000Z',
    ],
    {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      cwd,
    },
  );
  return { exit, stdout, stderr };
}

test('exports the public beta evidence v2 validator', () => {
  expect(typeof subject?.validatePublicBetaEvidenceLedgerV2).toBe('function');
});

describe.skipIf(!subject)('public beta evidence v2', () => {
  test('accepts a complete exact-commit ledger with a fresh B7 companion smoke', () => {
    const ledger = completeLedger();
    expect(validate(ledger)).toEqual(ledger);
  });

  test('binds the ledger to the protected profile, restricted lanes, and artifact set', () => {
    const missingProfile = completeLedger() as Partial<ReturnType<typeof completeLedger>>;
    delete missingProfile.releaseProfileId;
    expect(() => validate(missingProfile)).toThrow('PUBLIC_BETA_EVIDENCE_LEDGER_INVALID');

    const wrongId = completeLedger();
    (wrongId as { releaseProfileId: string }).releaseProfileId = 'openopc-public-beta-v1';
    expect(() => validate(wrongId)).toThrow('PUBLIC_BETA_EVIDENCE_PROFILE_ID_MISMATCH');

    const wrongDigest = completeLedger();
    wrongDigest.releaseProfileDigest = DIGEST_A;
    expect(() => validate(wrongDigest)).toThrow('PUBLIC_BETA_EVIDENCE_PROFILE_DIGEST_MISMATCH');

    const wrongArtifactSet = completeLedger();
    wrongArtifactSet.artifactSetDigest = DIGEST_B;
    expect(() => validate(wrongArtifactSet)).toThrow('PUBLIC_BETA_EVIDENCE_ARTIFACT_SET_MISMATCH');

    expect(() => validate(completeLedger(), () => true, PUBLIC_BETA_LANES)).toThrow(
      'PUBLIC_BETA_EVIDENCE_OPTIONS_INVALID',
    );

    const renamedLanes = structuredClone(OPENOPC_RESTRICTED_PUBLIC_BETA_LANES);
    const firstLane = renamedLanes[0];
    if (firstLane === undefined) throw new Error('EXPECTED_RESTRICTED_TEST_LANE');
    Reflect.set(firstLane, 'lane', 'candidate-renamed-lane');
    Reflect.set(firstLane, 'workflowJobId', 'candidate-renamed-lane');
    expect(() => validate(completeLedger(), () => true, renamedLanes)).toThrow(
      'PUBLIC_BETA_EVIDENCE_OPTIONS_INVALID',
    );
  });

  test('rejects deferred Gate records and non-evidence outcomes', () => {
    const deferred = completeLedger();
    deferred.records.push({ ...record('G5'), id: 'g6-deferred', gate: 'G6' as Gate });
    expect(() => validate(deferred)).toThrow('PUBLIC_BETA_EVIDENCE_GATE_NOT_IN_PROFILE');

    for (const outcome of ['skipped', 'not_applicable']) {
      const ledger = completeLedger();
      (ledger.records[0] as EvidenceRecord & { outcome: string }).outcome = outcome;
      expect(() => validate(ledger)).toThrow('PUBLIC_BETA_EVIDENCE_RECORD_INVALID');
    }
  });

  test('rejects unknown keys and not-run outcomes', () => {
    const withUnknown = completeLedger() as ReturnType<typeof completeLedger> & { extra?: boolean };
    withUnknown.extra = true;
    expect(() => validate(withUnknown)).toThrow('PUBLIC_BETA_EVIDENCE_LEDGER_INVALID');

    const notRun = completeLedger();
    (notRun.records[0] as EvidenceRecord & { outcome: string }).outcome = 'not-run';
    expect(() => validate(notRun)).toThrow('PUBLIC_BETA_EVIDENCE_RECORD_INVALID');
  });

  test('rejects a missing gate, duplicate id, and wrong canonical lane', () => {
    const missing = completeLedger();
    missing.records = missing.records.filter((item) => item.gate !== 'G4');
    expect(() => validate(missing)).toThrow('PUBLIC_BETA_EVIDENCE_GATES_INCOMPLETE');

    const duplicate = completeLedger();
    requireRecord(duplicate, 1).id = requireRecord(duplicate, 0).id;
    expect(() => validate(duplicate)).toThrow('PUBLIC_BETA_EVIDENCE_ID_DUPLICATE');

    const lane = completeLedger();
    requireRecord(lane, 0).lane = 'focused';
    expect(() => validate(lane)).toThrow('PUBLIC_BETA_EVIDENCE_LANE_INVALID');
  });

  test('rejects passed evidence from another commit or environment', () => {
    const commit = completeLedger();
    requireRecord(commit, 0).commit = OTHER_COMMIT;
    expect(() => validate(commit)).toThrow('PUBLIC_BETA_EVIDENCE_COMMIT_MISMATCH');

    const environment = completeLedger();
    (environment.records[0] as EvidenceRecord & { environment: string }).environment = 'staging';
    expect(() => validate(environment)).toThrow('PUBLIC_BETA_EVIDENCE_ENVIRONMENT_INVALID');
  });

  test('rejects timestamp inversion, future completion, and manually extended expiry', () => {
    const inverted = completeLedger();
    requireRecord(inverted, 0).startedAt = '2026-07-28T11:30:00.000Z';
    expect(() => validate(inverted)).toThrow('PUBLIC_BETA_EVIDENCE_TIME_INVALID');

    const future = completeLedger();
    requireRecord(future, 0).finishedAt = '2026-07-28T13:00:00.000Z';
    requireRecord(future, 0).expiresAt = '2026-07-31T13:00:00.000Z';
    expect(() => validate(future)).toThrow('PUBLIC_BETA_EVIDENCE_TIME_INVALID');

    const extended = completeLedger();
    requireRecord(extended, 0).expiresAt = '2026-08-01T11:00:00.000Z';
    expect(() => validate(extended)).toThrow('PUBLIC_BETA_EVIDENCE_EXPIRY_INVALID');
  });

  test('enforces default 72-hour and B10 24-hour freshness', () => {
    const staleDefault = completeLedger();
    const g1 = requireRecord(staleDefault, (item) => item.gate === 'G1');
    g1.finishedAt = '2026-07-24T11:00:00.000Z';
    g1.startedAt = '2026-07-24T10:00:00.000Z';
    g1.expiresAt = '2026-07-27T11:00:00.000Z';
    expect(() => validate(staleDefault)).toThrow('PUBLIC_BETA_EVIDENCE_STALE');

    const staleB10 = completeLedger();
    const b10 = requireRecord(staleB10, (item) => item.gate === 'B10');
    b10.finishedAt = '2026-07-27T10:00:00.000Z';
    b10.startedAt = '2026-07-27T09:00:00.000Z';
    b10.expiresAt = '2026-07-28T10:00:00.000Z';
    expect(() => validate(staleB10)).toThrow('PUBLIC_BETA_EVIDENCE_STALE');
  });

  test('requires B7 seven-day restore evidence to reference a fresh 24-hour smoke', () => {
    const missing = completeLedger();
    requireRecord(missing, (item) => item.id === 'b7-isolated-restore').companionEvidenceIds = [];
    expect(() => validate(missing)).toThrow('PUBLIC_BETA_EVIDENCE_B7_COMPANION_REQUIRED');

    const stale = completeLedger();
    const smoke = requireRecord(stale, (item) => item.id === 'b7-post-restore-smoke');
    smoke.finishedAt = '2026-07-27T10:00:00.000Z';
    smoke.startedAt = '2026-07-27T09:00:00.000Z';
    smoke.expiresAt = '2026-07-28T10:00:00.000Z';
    expect(() => validate(stale)).toThrow('PUBLIC_BETA_EVIDENCE_B7_COMPANION_INVALID');
  });

  test('verifies every retained artifact and requires raw paths to be retained artifacts', () => {
    const ledger = completeLedger();
    expect(() => validate(ledger, () => false)).toThrow('PUBLIC_BETA_EVIDENCE_ARTIFACT_INVALID');

    const raw = completeLedger();
    requireRecord(raw, 0).rawEvidencePaths = ['artifacts/public-beta/raw/missing.json'];
    expect(() => validate(raw)).toThrow('PUBLIC_BETA_EVIDENCE_RAW_ARTIFACT_MISSING');
  });

  test('rejects production, local, credentialed, and fixture-only dependencies', () => {
    for (const url of [
      'http://localhost:3000',
      'https://openopc.com',
      'https://user:pass@staging.openopc.example',
      'https://prod.openopc.example',
    ]) {
      const ledger = completeLedger();
      requireRecord(ledger, 0).stagingUrls = [url];
      expect(() => validate(ledger)).toThrow('PUBLIC_BETA_EVIDENCE_STAGING_URL_INVALID');
    }

    const fixture = completeLedger();
    requireRecord(fixture, 0).dependencyIdentities = ['fixture:self-created'];
    expect(() => validate(fixture)).toThrow('PUBLIC_BETA_EVIDENCE_DEPENDENCY_INVALID');
  });

  test('retains and resolves candidate failures instead of erasing them', () => {
    const unresolved = completeLedger();
    unresolved.records.push(
      record('G3', {
        id: 'g3-failed-attempt',
        attempt: 2,
        outcome: 'failed',
        finishedAt: '2026-07-28T09:00:00.000Z',
        expiresAt: '2026-07-31T09:00:00.000Z',
      }),
    );
    expect(() => validate(unresolved)).toThrow('PUBLIC_BETA_EVIDENCE_FAILURE_UNRESOLVED');

    const resolved = completeLedger();
    const failed = record('G3', {
      id: 'g3-failed-attempt',
      attempt: 1,
      outcome: 'failed',
      finishedAt: '2026-07-28T09:00:00.000Z',
      expiresAt: '2026-07-31T09:00:00.000Z',
    });
    const passing = requireRecord(resolved, (item) => item.gate === 'G3');
    passing.attempt = 2;
    passing.resolvesFailureIds = [failed.id];
    passing.artifacts.push({
      path: 'artifacts/public-beta/raw/g3-failure-resolution.json',
      digest: DIGEST_C,
      sizeBytes: 256,
      mediaType: 'application/vnd.openopc.failure-resolution+json',
    });
    passing.rawEvidencePaths.push('artifacts/public-beta/raw/g3-failure-resolution.json');
    resolved.records.push(failed);
    expect(validate(resolved)).toEqual(resolved);
  });

  test('returns stable CLI exits and one JSON result', async () => {
    if (!subject) throw new Error('PUBLIC_BETA_EVIDENCE_V2_SUBJECT_MISSING');
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await subject.runPublicBetaEvidenceCli(
      [
        '--ledger',
        'tests/public-beta/evidence.fixture.json',
        '--commit',
        '0'.repeat(40),
        '--now',
        '2026-07-28T00:00:00.000Z',
      ],
      {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
        cwd: process.cwd(),
      },
    );
    expect(exit).toBe(65);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({ valid: false });
    expect(stderr).toHaveLength(1);
  });

  test('accepts a materialized evidence bundle within the trusted root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-evidence-root-'));
    try {
      const ledger = completeLedger();
      materializeEvidenceArtifacts(root, ledger);
      writeFileSync(join(root, 'evidence.json'), JSON.stringify(ledger));

      const result = await runEvidenceCli(root, 'evidence.json');

      expect(result.exit).toBe(0);
      expect(JSON.parse(result.stdout[0] ?? '{}')).toMatchObject({
        valid: true,
        candidateCommit: COMMIT,
        records: ledger.records.length,
      });
      expect(result.stderr).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a ledger reached through a junction outside the trusted root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-evidence-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'openopc-evidence-outside-'));
    try {
      const ledger = completeLedger();
      materializeEvidenceArtifacts(root, ledger);
      writeFileSync(join(outside, 'evidence.json'), JSON.stringify(ledger));
      symlinkSync(outside, join(root, 'linked-ledger'), 'junction');

      const result = await runEvidenceCli(root, 'linked-ledger/evidence.json');

      expect(result.exit).toBe(65);
      expect(JSON.parse(result.stdout[0] ?? '{}')).toEqual({
        valid: false,
        error: 'PUBLIC_BETA_EVIDENCE_INPUT_INVALID',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('rejects evidence artifacts reached through a junction outside the trusted root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-evidence-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'openopc-evidence-outside-'));
    try {
      const ledger = completeLedger();
      materializeEvidenceArtifacts(outside, ledger);
      mkdirSync(join(root, 'artifacts/public-beta'), { recursive: true });
      symlinkSync(
        join(outside, 'artifacts/public-beta/raw'),
        join(root, 'artifacts/public-beta/raw'),
        'junction',
      );
      writeFileSync(join(root, 'evidence.json'), JSON.stringify(ledger));

      const result = await runEvidenceCli(root, 'evidence.json');

      expect(result.exit).toBe(65);
      expect(JSON.parse(result.stdout[0] ?? '{}')).toEqual({
        valid: false,
        error: 'PUBLIC_BETA_EVIDENCE_ARTIFACT_INVALID',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
