import { expect, test } from 'bun:test';

import {
  assertNonProductionBetaTargets,
  buildReleaseQaEnvironment,
  formatGithubEnvironment,
  normalizeBetaTarget,
  validateEvidenceLedger,
} from './module-beta-targets';

function pendingEvidenceLedger() {
  return {
    schemaVersion: 1,
    records: Array.from({ length: 12 }, (_, index) => ({
      id: `G${index + 1}-pending`,
      gate: `G${index + 1}`,
      lane: 'integration',
      command: null,
      environment: 'staging',
      dependencyIdentities: [],
      commit: null,
      startedAt: null,
      finishedAt: null,
      outcome: 'not-run',
      artifactPaths: [],
    })),
  };
}

function passedG3EvidenceLedger() {
  const ledger = pendingEvidenceLedger();
  ledger.records[2] = {
    ...ledger.records[2],
    id: 'G3-staging-trust',
    command: 'bun tests/module-beta/trust/run.ts',
    dependencyIdentities: ['gitleaks@8.24.3'],
    commit: 'f7a038863',
    startedAt: '2026-07-25T10:00:00.000Z',
    finishedAt: '2026-07-25T10:01:00.000Z',
    outcome: 'passed',
    artifactPaths: ['tests/module-beta/out/G3-trust.json'],
  };
  return ledger;
}

test('normalizes CRLF and trailing slashes from workflow targets', () => {
  expect(normalizeBetaTarget('  https://staging-api.openopc.example/v1///\r\n')).toBe(
    'https://staging-api.openopc.example/v1',
  );
});

test('rejects production and loopback targets for staging evidence', () => {
  for (const target of [
    'https://api.openopc.com/v1',
    'https://kortix.com',
    'https://api.prod.openopc.example/v1',
    'http://127.0.0.1:8008/v1',
    'http://[::1]:8008/v1',
  ]) {
    expect(() =>
      assertNonProductionBetaTargets({
        api: target,
        web: 'https://staging-web.openopc.example',
        runner: 'https://staging-runner.openopc.example',
      }),
    ).toThrow('MODULE_BETA_TARGET_FORBIDDEN');
  }
});

test('rejects production-looking target names conservatively', () => {
  expect(() =>
    assertNonProductionBetaTargets({
      api: 'https://production-api.openopc.example/v1',
      web: 'https://staging-web.openopc.example',
      runner: 'https://staging-runner.openopc.example',
    }),
  ).toThrow('MODULE_BETA_TARGET_FORBIDDEN');
});

test('rejects passed evidence without real dependency identities', () => {
  const { records } = pendingEvidenceLedger();
  records[2] = {
    ...records[2],
    id: 'G3-staging-trust',
    command: 'bun tests/module-beta/trust/run.ts',
    commit: 'f7a038863',
    startedAt: '2026-07-25T10:00:00.000Z',
    finishedAt: '2026-07-25T10:01:00.000Z',
    outcome: 'passed',
    artifactPaths: ['tests/module-beta/out/G3-trust.json'],
  };

  expect(() => validateEvidenceLedger({ schemaVersion: 1, records })).toThrow(
    'EVIDENCE_DEPENDENCY_IDENTITY_REQUIRED',
  );
});

test('requires one uniquely identified record for every G1 through G12 gate', () => {
  const missingGate = pendingEvidenceLedger();
  missingGate.records.pop();
  expect(() => validateEvidenceLedger(missingGate)).toThrow('EVIDENCE_GATES_INCOMPLETE');

  const duplicateId = pendingEvidenceLedger();
  duplicateId.records[1].id = duplicateId.records[0].id;
  expect(() => validateEvidenceLedger(duplicateId)).toThrow('EVIDENCE_ID_DUPLICATE');
});

test('rejects unknown ledger and evidence-record fields', () => {
  expect(() => validateEvidenceLedger({ ...pendingEvidenceLedger(), unexpected: true })).toThrow(
    'EVIDENCE_LEDGER_INVALID',
  );

  const recordWithUnknownField = pendingEvidenceLedger();
  Object.assign(recordWithUnknownField.records[0], { unexpected: true });
  expect(() => validateEvidenceLedger(recordWithUnknownField)).toThrow('EVIDENCE_RECORD_INVALID');
});

test('rejects unsupported evidence lanes', () => {
  const ledger = pendingEvidenceLedger();
  ledger.records[0].lane = 'mock';
  expect(() => validateEvidenceLedger(ledger)).toThrow('EVIDENCE_RECORD_INVALID');
});

test('rejects passed evidence without artifact paths', () => {
  const ledger = pendingEvidenceLedger();
  ledger.records[2] = {
    ...ledger.records[2],
    id: 'G3-staging-trust',
    command: 'bun tests/module-beta/trust/run.ts',
    dependencyIdentities: ['gitleaks@8.24.3'],
    commit: 'f7a038863',
    startedAt: '2026-07-25T10:00:00.000Z',
    finishedAt: '2026-07-25T10:01:00.000Z',
    outcome: 'passed',
  };

  expect(() => validateEvidenceLedger(ledger)).toThrow('EVIDENCE_ARTIFACT_REQUIRED');
});

test('requires complete and chronologically ordered metadata for passed evidence', () => {
  const missingCommand = passedG3EvidenceLedger();
  missingCommand.records[2].command = null;
  expect(() => validateEvidenceLedger(missingCommand)).toThrow('EVIDENCE_RUN_METADATA_REQUIRED');

  const invalidCommit = passedG3EvidenceLedger();
  invalidCommit.records[2].commit = 'not-a-git-sha';
  expect(() => validateEvidenceLedger(invalidCommit)).toThrow('EVIDENCE_RUN_METADATA_REQUIRED');

  const reversedTimes = passedG3EvidenceLedger();
  reversedTimes.records[2].finishedAt = '2026-07-25T09:59:00.000Z';
  expect(() => validateEvidenceLedger(reversedTimes)).toThrow('EVIDENCE_RUN_METADATA_REQUIRED');
});

test('rejects unsupported evidence outcomes', () => {
  const ledger = pendingEvidenceLedger();
  ledger.records[0].outcome = 'skipped';
  expect(() => validateEvidenceLedger(ledger)).toThrow('EVIDENCE_RECORD_INVALID');
});

test('rejects wrong schema versions and malformed record field types', () => {
  expect(() => validateEvidenceLedger({ ...pendingEvidenceLedger(), schemaVersion: 2 })).toThrow(
    'EVIDENCE_LEDGER_INVALID',
  );

  for (const malformed of [
    { dependencyIdentities: 'scanner@1' },
    { artifactPaths: null },
    { command: 42 },
    { environment: 'qa' },
  ]) {
    const ledger = pendingEvidenceLedger();
    Object.assign(ledger.records[0], malformed);
    expect(() => validateEvidenceLedger(ledger)).toThrow('EVIDENCE_RECORD_INVALID');
  }
});

test('builds normalized GitHub release variables and derives scan origins', () => {
  const environment = buildReleaseQaEnvironment({
    api: 'https://staging-api.openopc.example/v1/\r\n',
    web: 'https://staging.openopc.example/\r\n',
    runner: 'https://runner.staging.openopc.example/\r\n',
    moduleBetaGatesRequired: true,
  });
  expect(environment).toEqual({
    API_BASE_URL: 'https://staging-api.openopc.example/v1',
    KE2E_API_URL: 'https://staging-api.openopc.example/v1',
    BASE_URL: 'https://staging-api.openopc.example/v1',
    E2E_BASE_URL: 'https://staging.openopc.example',
    TARGET_URL: 'https://staging-api.openopc.example',
    PENTEST_TARGET_URL: 'https://staging-api.openopc.example',
    MODULE_BETA_RUNNER_URL: 'https://runner.staging.openopc.example',
    PENTEST_LIVE_CONFIRM: 'ci',
    KE2E_LIVE_CONFIRM: 'ci',
  });
  const githubEnvironment = formatGithubEnvironment(environment);
  expect(githubEnvironment).not.toContain('\r');
  expect(githubEnvironment).toContain(
    'MODULE_BETA_RUNNER_URL=https://runner.staging.openopc.example\n',
  );
});
