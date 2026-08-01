import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from 'bun:test';

import { OPENOPC_RELEASE_PROFILE_DIGESTS } from '../../packages/api-contract/src/release-profile';
import {
  MODULE_BETA_ACCEPTANCE_FLOW_IDS,
  validateDeveloperModuleBetaEvidence,
} from '../../scripts/release/module-beta-targets';

const PROFILE_ID = 'openopc-web-desktop-developer-beta-v2';
const PROFILE_DIGEST = OPENOPC_RELEASE_PROFILE_DIGESTS[PROFILE_ID];
const CANDIDATE_COMMIT = 'a'.repeat(40);
const RECORDED_AT = '2026-08-01T00:00:00.000Z';
const REFERENCE_DIGEST = `sha256:${'c'.repeat(64)}`;

function validEvidence() {
  return {
    schemaVersion: 2,
    records: MODULE_BETA_ACCEPTANCE_FLOW_IDS.map((id) => ({
      id,
      releaseProfileId: PROFILE_ID,
      releaseProfileDigest: PROFILE_DIGEST,
      candidateCommit: CANDIDATE_COMMIT,
      recordedAt: RECORDED_AT,
      referenceDigest: REFERENCE_DIGEST,
      outcome: 'not-run',
      claims: [],
    })),
  };
}

test('acceptance evidence requires every public-beta flow on one candidate identity', () => {
  const evidence = validateDeveloperModuleBetaEvidence(validEvidence());
  expect(evidence.records.map((record) => record.id)).toEqual([...MODULE_BETA_ACCEPTANCE_FLOW_IDS]);

  const splitCommit = validEvidence();
  splitCommit.records[1].candidateCommit = 'b'.repeat(40);
  expect(() => validateDeveloperModuleBetaEvidence(splitCommit)).toThrow(
    'MODULE_BETA_EVIDENCE_CANDIDATE_MISMATCH',
  );

  const missingFlow = validEvidence();
  missingFlow.records.pop();
  expect(() => validateDeveloperModuleBetaEvidence(missingFlow)).toThrow(
    'MODULE_BETA_EVIDENCE_FLOWS_INCOMPLETE',
  );
});

test('acceptance evidence rejects claims that bypass platform boundaries', () => {
  for (const claim of [
    'missing NewAPI credential rotation identifier',
    'missing AI stream audit record',
    'invalid callback signature accepted',
    'duplicate callback created two state transitions',
    'provider close operation claimed',
    'late payment was auto-fulfilled after expiry',
    'cross-tenant capability call accepted',
    'custom domain active without DNS/TLS proof',
    'desktop policy containing a provider origin',
    'orders.close returned success',
    'provider raw credentials were included in the module response',
    'commerce.settlement paid a developer balance',
    'a browser module called NewAPI directly',
    'the desktop module called Z-Pay directly',
  ]) {
    const evidence = validEvidence();
    evidence.records[0].claims = [claim];
    expect(() => validateDeveloperModuleBetaEvidence(evidence)).toThrow(
      'MODULE_BETA_EVIDENCE_UNSAFE_CLAIM',
    );
  }
});

test('checked evidence fixture uses the versioned developer beta contract', () => {
  const fixture = JSON.parse(
    readFileSync(resolve(import.meta.dir, 'evidence.json'), 'utf8'),
  ) as unknown;
  const evidence = validateDeveloperModuleBetaEvidence(
    (fixture as { developerBetaAcceptance?: unknown }).developerBetaAcceptance,
  );
  expect(evidence.records).toHaveLength(MODULE_BETA_ACCEPTANCE_FLOW_IDS.length);
  expect(new Set(evidence.records.map((record) => record.releaseProfileId))).toEqual(
    new Set([PROFILE_ID]),
  );
});
