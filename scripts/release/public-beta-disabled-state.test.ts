import { expect, test } from 'bun:test';

import {
  type DisabledCapabilityRecordV1,
  RESTRICTED_DISABLED_CAPABILITIES,
} from '../../packages/api-contract/src/release-profile';
import {
  createDisabledStateAssessment,
  parseDisabledStateAssessment,
} from './public-beta-disabled-state';

const record = (capability: DisabledCapabilityRecordV1['capability']) => ({
  capability,
  artifactAbsent: true,
  deployedServiceAbsent: true,
  serverFlag: false as const,
  apiCliRejected: true,
  iamCapabilityAbsent: true,
  legacyDirectRouteRejected: true,
  uiAdvertised: false as const,
});

test('binds disabled-state assessment to the protected profile', () => {
  const assessment = createDisabledStateAssessment({
    commit: 'a'.repeat(40),
    controlSha: 'b'.repeat(40),
    records: RESTRICTED_DISABLED_CAPABILITIES.map(record),
  });
  expect(assessment.releaseProfileId).toBe('openopc-restricted-public-beta-v1');
  expect(assessment.assessmentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(parseDisabledStateAssessment(structuredClone(assessment))).toEqual(assessment);
});

test('rejects incomplete, reordered, reachable, and digest-tampered assessments', () => {
  const valid = createDisabledStateAssessment({
    commit: 'a'.repeat(40),
    controlSha: 'b'.repeat(40),
    records: RESTRICTED_DISABLED_CAPABILITIES.map(record),
  });
  const cases = [
    { ...valid, records: valid.records.slice(1) },
    { ...valid, records: [...valid.records].reverse() },
    {
      ...valid,
      records: valid.records.map((entry, index) =>
        index === 0 ? { ...entry, apiCliRejected: false } : entry,
      ),
    },
    { ...valid, assessmentDigest: `sha256:${'0'.repeat(64)}` },
  ];
  for (const invalid of cases) {
    expect(() => parseDisabledStateAssessment(invalid)).toThrow(
      'OPENOPC_DISABLED_STATE_ASSESSMENT_INVALID',
    );
  }
});
