export type IntelligenceRouteCapabilityId = 'llm.text.plan' | 'studio.image.generate';
export type IntelligenceRouteSafetyClass = 'standard' | 'restricted';
export type IntelligenceRouteInputKind = 'text' | 'image';
export type IntelligenceRouteOutputKind = 'text' | 'image';

export type IntelligenceRouteEvaluation = {
  snapshotVersion: string;
  publishedAt: string;
  sampleCount: number;
  minimumSampleCount: number;
  meetsMinimumSamples: boolean;
  confidenceLowerBoundPpm: number;
  qualityRatePpm: number;
  availabilityRatePpm: number;
  failureRatePpm: number;
};

export type IntelligenceRouteCandidate = {
  candidateId: string;
  providerDefinitionId: string;
  providerConfigId: string;
  modelId: string;
  capabilityId: IntelligenceRouteCapabilityId;
  capabilityVersion: string;
  schemaVersion: string;
  region: string;
  safetyClass: IntelligenceRouteSafetyClass;
  supportedInputKinds: IntelligenceRouteInputKind[];
  outputKind: IntelligenceRouteOutputKind;
  ready: boolean;
  iamAllowed: boolean;
  agentAllowed: boolean;
  projectPolicy: 'allow' | 'deny';
  estimatedCostMicredits: number;
  estimatedLatencyMs: number;
  riskPenaltyPpm: number;
  evaluation: IntelligenceRouteEvaluation | null;
};

export type IntelligenceRoutePolicySnapshot = {
  policyVersion: string;
  policyHash: string;
  allowedRegions: string[];
  allowedSafetyClasses: IntelligenceRouteSafetyClass[];
  maximumCandidateRiskPpm: number;
  maximumCostMicredits: number;
  maximumLatencyMs: number;
  maximumEvaluationAgeMs: number;
  minimumSampleCount: number;
  minimumConfidenceLowerBoundPpm: number;
  minimumQualityRatePpm: number;
  minimumAvailabilityRatePpm: number;
  maximumFailureRatePpm: number;
  weightsBps: {
    quality: number;
    availability: number;
    latency: number;
    cost: number;
    risk: number;
  };
  normalization: { latencyMs: number; costMicredits: number };
};

export type IntelligenceRouteRequest = {
  decisionId: string;
  accountId: string;
  projectId: string;
  capabilityId: IntelligenceRouteCapabilityId;
  capabilityVersion: string;
  schemaVersion: string;
  inputKinds: IntelligenceRouteInputKind[];
  outputKind: IntelligenceRouteOutputKind;
  requiredRegion: string;
  maximumSafetyClass: IntelligenceRouteSafetyClass;
  remainingBudgetMicredits: number;
  deadlineAt: string;
  now: string;
  proposedCandidateId: string | null;
  requestHash: string;
};

export type IntelligenceRouteScoreComponents = {
  qualityPpm: number;
  availabilityPpm: number;
  latencyPenaltyPpm: number;
  costPenaltyPpm: number;
  riskPenaltyPpm: number;
};

export type IntelligenceScoredRouteCandidate = {
  candidateId: string;
  providerDefinitionId: string;
  providerConfigId: string;
  modelId: string;
  evaluationVersion: string;
  scorePpm: number;
  components: IntelligenceRouteScoreComponents;
};

export type IntelligenceRouteReasonCode =
  | 'ROUTE_PRIMARY_SELECTED'
  | 'ROUTE_FALLBACK_SELECTED'
  | 'ROUTE_NO_ELIGIBLE_CANDIDATE'
  | 'ROUTE_IAM_DENIED'
  | 'ROUTE_AGENT_DENIED'
  | 'ROUTE_PROJECT_POLICY_DENIED'
  | 'ROUTE_CAPABILITY_MISMATCH'
  | 'ROUTE_SCHEMA_MISMATCH'
  | 'ROUTE_REGION_DENIED'
  | 'ROUTE_SAFETY_DENIED'
  | 'ROUTE_INPUT_UNSUPPORTED'
  | 'ROUTE_OUTPUT_UNSUPPORTED'
  | 'ROUTE_NOT_READY'
  | 'ROUTE_BUDGET_EXCEEDED'
  | 'ROUTE_DEADLINE_UNSATISFIABLE'
  | 'ROUTE_EVALUATION_MISSING'
  | 'ROUTE_EVALUATION_STALE'
  | 'ROUTE_EVALUATION_THRESHOLD_FAILED'
  | 'ROUTE_RISK_EXCEEDED'
  | 'ROUTE_PROPOSED_TARGET_REJECTED';

export type IntelligenceRouteDecision = {
  protocolVersion: 'intelligence.route.v1';
  decisionId: string;
  accountId: string;
  projectId: string;
  requestHash: string;
  policyVersion: string;
  policyHash: string;
  primary: IntelligenceScoredRouteCandidate | null;
  fallback: IntelligenceScoredRouteCandidate | null;
  rejected: Array<{ candidateId: string; reasonCodes: IntelligenceRouteReasonCode[] }>;
  reasonCodes: IntelligenceRouteReasonCode[];
  createdAt: string;
};

function firstHardFilterReason(
  candidate: IntelligenceRouteCandidate,
  request: IntelligenceRouteRequest,
  policy: IntelligenceRoutePolicySnapshot,
): IntelligenceRouteReasonCode | null {
  if (!candidate.iamAllowed) return 'ROUTE_IAM_DENIED';
  if (!candidate.agentAllowed) return 'ROUTE_AGENT_DENIED';
  if (candidate.projectPolicy === 'deny') return 'ROUTE_PROJECT_POLICY_DENIED';
  if (
    candidate.capabilityId !== request.capabilityId ||
    candidate.capabilityVersion !== request.capabilityVersion
  ) {
    return 'ROUTE_CAPABILITY_MISMATCH';
  }
  if (candidate.schemaVersion !== request.schemaVersion) return 'ROUTE_SCHEMA_MISMATCH';
  if (
    candidate.region !== request.requiredRegion ||
    !policy.allowedRegions.includes(candidate.region)
  ) {
    return 'ROUTE_REGION_DENIED';
  }
  if (
    !policy.allowedSafetyClasses.includes(candidate.safetyClass) ||
    !inputPolicyAllowsSafety(candidate.safetyClass, request.maximumSafetyClass)
  ) {
    return 'ROUTE_SAFETY_DENIED';
  }
  if (!request.inputKinds.every((kind) => candidate.supportedInputKinds.includes(kind))) {
    return 'ROUTE_INPUT_UNSUPPORTED';
  }
  if (candidate.outputKind !== request.outputKind) return 'ROUTE_OUTPUT_UNSUPPORTED';
  if (!candidate.ready) return 'ROUTE_NOT_READY';
  if (candidate.riskPenaltyPpm > policy.maximumCandidateRiskPpm) {
    return 'ROUTE_RISK_EXCEEDED';
  }
  if (
    candidate.estimatedCostMicredits >
    Math.min(request.remainingBudgetMicredits, policy.maximumCostMicredits)
  ) {
    return 'ROUTE_BUDGET_EXCEEDED';
  }
  const remainingDeadlineMs = Date.parse(request.deadlineAt) - Date.parse(request.now);
  if (
    !Number.isFinite(remainingDeadlineMs) ||
    candidate.estimatedLatencyMs > Math.min(policy.maximumLatencyMs, remainingDeadlineMs)
  ) {
    return 'ROUTE_DEADLINE_UNSATISFIABLE';
  }
  const evaluation = candidate.evaluation;
  if (!evaluation) return 'ROUTE_EVALUATION_MISSING';
  const publishedAtMs = Date.parse(evaluation.publishedAt);
  const nowMs = Date.parse(request.now);
  if (
    !Number.isFinite(publishedAtMs) ||
    !Number.isFinite(nowMs) ||
    publishedAtMs > nowMs ||
    nowMs - publishedAtMs > policy.maximumEvaluationAgeMs
  ) {
    return 'ROUTE_EVALUATION_STALE';
  }
  if (
    !evaluation.meetsMinimumSamples ||
    evaluation.sampleCount < Math.max(evaluation.minimumSampleCount, policy.minimumSampleCount) ||
    evaluation.confidenceLowerBoundPpm < policy.minimumConfidenceLowerBoundPpm ||
    evaluation.qualityRatePpm < policy.minimumQualityRatePpm ||
    evaluation.availabilityRatePpm < policy.minimumAvailabilityRatePpm ||
    evaluation.failureRatePpm > policy.maximumFailureRatePpm
  ) {
    return 'ROUTE_EVALUATION_THRESHOLD_FAILED';
  }
  return null;
}

function inputPolicyAllowsSafety(
  candidateSafety: IntelligenceRouteSafetyClass,
  maximumSafety: IntelligenceRouteSafetyClass,
): boolean {
  const rank = (value: IntelligenceRouteSafetyClass) => (value === 'standard' ? 0 : 1);
  return rank(candidateSafety) <= rank(maximumSafety);
}

function roundedRatio(value: number, numerator: number, denominator: number): number {
  return Number(
    (BigInt(value) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator),
  );
}

function normalizedPenalty(value: number, maximum: number): number {
  return roundedRatio(Math.min(value, maximum), 1_000_000, maximum);
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scoreCandidate(
  candidate: IntelligenceRouteCandidate,
  policy: IntelligenceRoutePolicySnapshot,
): IntelligenceScoredRouteCandidate {
  if (!candidate.evaluation) throw new Error('route candidate evaluation is required');
  const components: IntelligenceRouteScoreComponents = {
    qualityPpm: roundedRatio(
      candidate.evaluation.qualityRatePpm,
      policy.weightsBps.quality,
      10_000,
    ),
    availabilityPpm: roundedRatio(
      candidate.evaluation.availabilityRatePpm,
      policy.weightsBps.availability,
      10_000,
    ),
    latencyPenaltyPpm: roundedRatio(
      normalizedPenalty(candidate.estimatedLatencyMs, policy.normalization.latencyMs),
      policy.weightsBps.latency,
      10_000,
    ),
    costPenaltyPpm: roundedRatio(
      normalizedPenalty(candidate.estimatedCostMicredits, policy.normalization.costMicredits),
      policy.weightsBps.cost,
      10_000,
    ),
    riskPenaltyPpm: roundedRatio(
      candidate.riskPenaltyPpm,
      policy.weightsBps.risk,
      10_000,
    ),
  };
  return {
    candidateId: candidate.candidateId,
    providerDefinitionId: candidate.providerDefinitionId,
    providerConfigId: candidate.providerConfigId,
    modelId: candidate.modelId,
    evaluationVersion: candidate.evaluation.snapshotVersion,
    scorePpm:
      components.qualityPpm +
      components.availabilityPpm -
      components.latencyPenaltyPpm -
      components.costPenaltyPpm -
      components.riskPenaltyPpm,
    components,
  };
}

export function routeIntelligenceCandidates(input: {
  request: IntelligenceRouteRequest;
  policy: IntelligenceRoutePolicySnapshot;
  candidates: readonly IntelligenceRouteCandidate[];
}): IntelligenceRouteDecision {
  const eligible: IntelligenceRouteCandidate[] = [];
  const rejected: IntelligenceRouteDecision['rejected'] = [];
  const seenCandidateIds = new Set<string>();
  for (const candidate of input.candidates) {
    seenCandidateIds.add(candidate.candidateId);
    const reasonCode = firstHardFilterReason(candidate, input.request, input.policy);
    if (reasonCode) {
      const reasonCodes: IntelligenceRouteReasonCode[] = [reasonCode];
      if (candidate.candidateId === input.request.proposedCandidateId) {
        reasonCodes.push('ROUTE_PROPOSED_TARGET_REJECTED');
      }
      rejected.push({ candidateId: candidate.candidateId, reasonCodes });
    } else {
      eligible.push(candidate);
    }
  }
  const unknownProposedTarget =
    input.request.proposedCandidateId !== null &&
    !seenCandidateIds.has(input.request.proposedCandidateId);
  rejected.sort(
    (left, right) =>
      compareAscii(left.candidateId, right.candidateId) ||
      compareAscii(left.reasonCodes.join('\u0000'), right.reasonCodes.join('\u0000')),
  );
  const scored = eligible
    .map((candidate) => scoreCandidate(candidate, input.policy))
    .sort(
      (left, right) =>
        right.scorePpm - left.scorePpm ||
        compareAscii(left.providerDefinitionId, right.providerDefinitionId) ||
        compareAscii(left.providerConfigId, right.providerConfigId) ||
        compareAscii(left.modelId, right.modelId) ||
        compareAscii(left.candidateId, right.candidateId),
    );
  const primary = scored[0] ?? null;
  const fallback = scored[1] ?? null;
  const selectionReasonCodes: IntelligenceRouteReasonCode[] = primary
    ? fallback
      ? ['ROUTE_PRIMARY_SELECTED', 'ROUTE_FALLBACK_SELECTED']
      : ['ROUTE_PRIMARY_SELECTED']
    : ['ROUTE_NO_ELIGIBLE_CANDIDATE'];
  const reasonCodes: IntelligenceRouteReasonCode[] = unknownProposedTarget
    ? [...selectionReasonCodes, 'ROUTE_PROPOSED_TARGET_REJECTED']
    : selectionReasonCodes;
  return {
    protocolVersion: 'intelligence.route.v1',
    decisionId: input.request.decisionId,
    accountId: input.request.accountId,
    projectId: input.request.projectId,
    requestHash: input.request.requestHash,
    policyVersion: input.policy.policyVersion,
    policyHash: input.policy.policyHash,
    primary,
    fallback,
    rejected,
    reasonCodes,
    createdAt: input.request.now,
  };
}
