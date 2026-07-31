import type {
  DisabledCapabilityRecordV1,
  DisabledStateAssessmentV1,
} from '../../packages/api-contract/src/release-profile';
import {
  DisabledCapabilityRecordV1Schema,
  DisabledStateAssessmentV1Schema,
  RESTRICTED_DISABLED_CAPABILITIES,
} from '../../packages/api-contract/src/release-profile';
import { computeCanonicalPublicBetaDigest } from './public-beta-canonical-json';
import {
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE,
  OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
} from './public-beta-release-profile';

export function createDisabledStateAssessment(input: {
  commit: string;
  controlSha: string;
  records: DisabledCapabilityRecordV1[];
}): DisabledStateAssessmentV1 {
  return finalizeAssessment({
    schemaVersion: 1 as const,
    releaseProfileId: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE.id,
    releaseProfileDigest: OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST,
    commit: input.commit,
    controlSha: input.controlSha,
    records: input.records,
  });
}

export function parseDisabledStateAssessment(value: unknown): DisabledStateAssessmentV1 {
  try {
    const parsed = DisabledStateAssessmentV1Schema.parse(value);
    const { assessmentDigest, ...unsigned } = parsed;
    if (
      assessmentDigest !== computeCanonicalPublicBetaDigest(unsigned) ||
      parsed.releaseProfileDigest !== OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST
    ) {
      invalidAssessment();
    }
    validateRecords(parsed.records);
    return freezeAssessment(parsed);
  } catch (error) {
    if (error instanceof Error && error.message === 'OPENOPC_DISABLED_STATE_ASSESSMENT_INVALID') {
      throw error;
    }
    invalidAssessment();
  }
}

function finalizeAssessment(
  input: Omit<DisabledStateAssessmentV1, 'assessmentDigest'>,
): DisabledStateAssessmentV1 {
  try {
    if (!/^[a-f0-9]{40}$/.test(input.commit) || !/^[a-f0-9]{40}$/.test(input.controlSha)) {
      invalidAssessment();
    }
    validateRecords(input.records);
    const unsigned = {
      ...input,
      records: input.records.map((record) => DisabledCapabilityRecordV1Schema.parse(record)),
    };
    return freezeAssessment({
      ...unsigned,
      assessmentDigest: computeCanonicalPublicBetaDigest(unsigned),
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'OPENOPC_DISABLED_STATE_ASSESSMENT_INVALID') {
      throw error;
    }
    invalidAssessment();
  }
}

function validateRecords(records: readonly DisabledCapabilityRecordV1[]): void {
  if (
    records.length !== RESTRICTED_DISABLED_CAPABILITIES.length ||
    records.some((record, index) => record.capability !== RESTRICTED_DISABLED_CAPABILITIES[index])
  ) {
    invalidAssessment();
  }
}

function freezeAssessment(assessment: DisabledStateAssessmentV1): DisabledStateAssessmentV1 {
  const records = Object.freeze(
    assessment.records.map((record) => Object.freeze({ ...record })),
  ) as DisabledCapabilityRecordV1[];
  return Object.freeze({ ...assessment, records });
}

function invalidAssessment(): never {
  throw new Error('OPENOPC_DISABLED_STATE_ASSESSMENT_INVALID');
}
