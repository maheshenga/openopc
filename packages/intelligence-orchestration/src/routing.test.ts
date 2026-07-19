import { describe, expect, test } from 'bun:test';
import {
  type IntelligenceRouteCandidate,
  type IntelligenceRouteEvaluation,
  type IntelligenceRoutePolicySnapshot,
  type IntelligenceRouteRequest,
  routeIntelligenceCandidates,
} from './routing';

const HASH = `sha256:${'a'.repeat(64)}`;

function policy(
  overrides: Partial<IntelligenceRoutePolicySnapshot> = {},
): IntelligenceRoutePolicySnapshot {
  return {
    policyVersion: 'image-route-v1',
    policyHash: HASH,
    allowedRegions: ['cn-east-1'],
    allowedSafetyClasses: ['standard'],
    maximumCandidateRiskPpm: 1_000_000,
    maximumCostMicredits: 1_000,
    maximumLatencyMs: 1_000,
    maximumEvaluationAgeMs: 24 * 60 * 60 * 1_000,
    minimumSampleCount: 30,
    minimumConfidenceLowerBoundPpm: 800_000,
    minimumQualityRatePpm: 800_000,
    minimumAvailabilityRatePpm: 800_000,
    maximumFailureRatePpm: 200_000,
    weightsBps: {
      quality: 10_000,
      availability: 10_000,
      latency: 10_000,
      cost: 10_000,
      risk: 10_000,
    },
    normalization: { latencyMs: 1_000, costMicredits: 1_000 },
    ...overrides,
  };
}

function request(overrides: Partial<IntelligenceRouteRequest> = {}): IntelligenceRouteRequest {
  return {
    decisionId: '51000000-0000-4000-a000-000000000001',
    accountId: '52000000-0000-4000-a000-000000000001',
    projectId: '53000000-0000-4000-a000-000000000001',
    capabilityId: 'studio.image.generate',
    capabilityVersion: '1.0.0',
    schemaVersion: 'studio.image.generate.request.v1',
    inputKinds: ['text'],
    outputKind: 'image',
    requiredRegion: 'cn-east-1',
    maximumSafetyClass: 'standard',
    remainingBudgetMicredits: 1_000,
    deadlineAt: '2026-07-20T00:00:01.000Z',
    now: '2026-07-20T00:00:00.000Z',
    proposedCandidateId: null,
    requestHash: HASH,
    ...overrides,
  };
}

function candidate(
  candidateId: string,
  overrides: Partial<IntelligenceRouteCandidate> = {},
): IntelligenceRouteCandidate {
  return {
    candidateId,
    providerDefinitionId: `definition-${candidateId}`,
    providerConfigId: `54000000-0000-4000-a000-${candidateId.padStart(12, '0')}`,
    modelId: `image-model-${candidateId}`,
    capabilityId: 'studio.image.generate',
    capabilityVersion: '1.0.0',
    schemaVersion: 'studio.image.generate.request.v1',
    region: 'cn-east-1',
    safetyClass: 'standard',
    supportedInputKinds: ['text'],
    outputKind: 'image',
    ready: true,
    iamAllowed: true,
    agentAllowed: true,
    projectPolicy: 'allow',
    estimatedCostMicredits: 100,
    estimatedLatencyMs: 500,
    riskPenaltyPpm: 50_000,
    evaluation: evaluation(candidateId),
    ...overrides,
  };
}

function evaluation(
  candidateId: string,
  overrides: Partial<IntelligenceRouteEvaluation> = {},
): IntelligenceRouteEvaluation {
  return {
    snapshotVersion: `evaluation-${candidateId}`,
    publishedAt: '2026-07-19T23:00:00.000Z',
    sampleCount: 100,
    minimumSampleCount: 30,
    meetsMinimumSamples: true,
    confidenceLowerBoundPpm: 900_000,
    qualityRatePpm: 900_000,
    availabilityRatePpm: 950_000,
    failureRatePpm: 50_000,
    ...overrides,
  };
}

describe('deterministic intelligence routing', () => {
  test('selects one primary and at most one fallback by fixed-point score', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1'),
        candidate('2', {
          estimatedCostMicredits: 200,
          estimatedLatencyMs: 600,
          riskPenaltyPpm: 100_000,
          evaluation: evaluation('2', {
            qualityRatePpm: 850_000,
            availabilityRatePpm: 900_000,
          }),
        }),
        candidate('3', {
          estimatedCostMicredits: 300,
          estimatedLatencyMs: 700,
          riskPenaltyPpm: 150_000,
          evaluation: evaluation('3', {
            qualityRatePpm: 820_000,
            availabilityRatePpm: 850_000,
          }),
        }),
      ],
    });

    expect(decision.primary).toMatchObject({
      candidateId: '1',
      scorePpm: 1_200_000,
      evaluationVersion: 'evaluation-1',
    });
    expect(decision.fallback).toMatchObject({ candidateId: '2', scorePpm: 850_000 });
    expect(decision.reasonCodes).toEqual([
      'ROUTE_PRIMARY_SELECTED',
      'ROUTE_FALLBACK_SELECTED',
    ]);
  });

  test('filters IAM and Agent denied candidates before scoring', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { iamAllowed: false, projectPolicy: 'deny' }),
        candidate('2', { agentAllowed: false }),
        candidate('3'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('3');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_IAM_DENIED'] },
      { candidateId: '2', reasonCodes: ['ROUTE_AGENT_DENIED'] },
    ]);
  });

  test('applies project policy before capability and schema compatibility', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { projectPolicy: 'deny', capabilityVersion: '9.0.0' }),
        candidate('2', { capabilityVersion: '9.0.0' }),
        candidate('3', { schemaVersion: 'studio.image.generate.request.v2' }),
        candidate('4'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('4');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_PROJECT_POLICY_DENIED'] },
      { candidateId: '2', reasonCodes: ['ROUTE_CAPABILITY_MISMATCH'] },
      { candidateId: '3', reasonCodes: ['ROUTE_SCHEMA_MISMATCH'] },
    ]);
  });

  test('rejects region and safety violations before input/output checks', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { region: 'us-east-1', safetyClass: 'restricted' }),
        candidate('2', { safetyClass: 'restricted' }),
        candidate('3'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('3');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_REGION_DENIED'] },
      { candidateId: '2', reasonCodes: ['ROUTE_SAFETY_DENIED'] },
    ]);
  });

  test('rejects candidates that cannot satisfy requested input or output kinds', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { supportedInputKinds: ['image'] }),
        candidate('2', { outputKind: 'text' }),
        candidate('3'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('3');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_INPUT_UNSUPPORTED'] },
      { candidateId: '2', reasonCodes: ['ROUTE_OUTPUT_UNSUPPORTED'] },
    ]);
  });

  test('rejects candidates whose provider or storage readiness is false', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [candidate('1', { ready: false }), candidate('2')],
    });

    expect(decision.primary?.candidateId).toBe('2');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_NOT_READY'] },
    ]);
  });

  test('rejects candidates that exceed remaining budget or deadline', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { estimatedCostMicredits: 1_001 }),
        candidate('2', { estimatedLatencyMs: 1_001 }),
        candidate('3'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('3');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_BUDGET_EXCEEDED'] },
      { candidateId: '2', reasonCodes: ['ROUTE_DEADLINE_UNSATISFIABLE'] },
    ]);
  });

  test('requires a fresh evaluation snapshot that meets policy thresholds', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { evaluation: null }),
        candidate('2', {
          evaluation: evaluation('2', {
            publishedAt: '2026-07-18T00:00:00.000Z',
          }),
        }),
        candidate('3', {
          evaluation: evaluation('3', {
            qualityRatePpm: 700_000,
          }),
        }),
        candidate('4'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('4');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_EVALUATION_MISSING'] },
      { candidateId: '2', reasonCodes: ['ROUTE_EVALUATION_STALE'] },
      { candidateId: '3', reasonCodes: ['ROUTE_EVALUATION_THRESHOLD_FAILED'] },
    ]);
  });

  test('rejects candidates above the policy risk ceiling before scoring', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy({ maximumCandidateRiskPpm: 100_000 }),
      candidates: [candidate('1', { riskPenaltyPpm: 100_001 }), candidate('2')],
    });

    expect(decision.primary?.candidateId).toBe('2');
    expect(decision.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_RISK_EXCEEDED'] },
    ]);
  });

  test('refuses an LLM-proposed unauthorized target instead of forcing it', () => {
    const decision = routeIntelligenceCandidates({
      request: request({ proposedCandidateId: '1' }),
      policy: policy(),
      candidates: [
        candidate('1', { iamAllowed: false }),
        candidate('2'),
      ],
    });

    expect(decision.primary?.candidateId).toBe('2');
    expect(decision.rejected).toEqual([
      {
        candidateId: '1',
        reasonCodes: ['ROUTE_IAM_DENIED', 'ROUTE_PROPOSED_TARGET_REJECTED'],
      },
    ]);
  });

  test('records an unknown proposed target and orders rejections independently of source order', () => {
    const route = (candidates: IntelligenceRouteCandidate[]) =>
      routeIntelligenceCandidates({
        request: request({ proposedCandidateId: '0' }),
        policy: policy(),
        candidates,
      });
    const left = route([
      candidate('2', { agentAllowed: false }),
      candidate('1', { iamAllowed: false }),
      candidate('3'),
    ]);
    const right = route([
      candidate('3'),
      candidate('1', { iamAllowed: false }),
      candidate('2', { agentAllowed: false }),
    ]);

    expect(left.rejected).toEqual([
      { candidateId: '1', reasonCodes: ['ROUTE_IAM_DENIED'] },
      { candidateId: '2', reasonCodes: ['ROUTE_AGENT_DENIED'] },
    ]);
    expect(right.rejected).toEqual(left.rejected);
    expect(left.reasonCodes).toEqual([
      'ROUTE_PRIMARY_SELECTED',
      'ROUTE_PROPOSED_TARGET_REJECTED',
    ]);
  });

  test('breaks equal-score ties by stable ASCII provider and model identities', () => {
    const decision = routeIntelligenceCandidates({
      request: request(),
      policy: policy(),
      candidates: [
        candidate('1', { providerDefinitionId: 'provider-a' }),
        candidate('2', { providerDefinitionId: 'provider-Z' }),
      ],
    });

    expect(decision.primary?.candidateId).toBe('2');
    expect(decision.fallback?.candidateId).toBe('1');
  });
});
