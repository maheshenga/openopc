import type {
  StudioEstimateRequest,
  StudioJobInput,
} from '@kortix/api-contract';
import type {
  IntelligenceModelEvaluationSnapshot,
} from '@kortix/intelligence-contracts';
import {
  type IntelligenceRouteCandidate,
  canonicalWorkflowHash,
} from '@kortix/intelligence-orchestration';
import type {
  AuthedPrincipal,
  ModelRouteInput,
  ModelRoutePlan,
} from '@kortix/llm-gateway';
import type { CapabilityRegistryActor } from '../capability-registry';
import { resolveStudioEstimate as defaultResolveStudioEstimate } from '../../studio/estimates';
import type { StudioRepository } from '../../studio/types';

const IMAGE_CAPABILITY_ID = 'studio.image.generate' as const;
const IMAGE_CAPABILITY_VERSION = '1.0.0';
const IMAGE_SCHEMA_VERSION = 'studio.image.generate.request.v1';
const MICREDITS_PER_CREDIT = 1_000_000;

type GatewayRouteResolver = (
  principal: AuthedPrincipal,
  input: ModelRouteInput,
) => Promise<ModelRoutePlan>;

type ImageDiscoverySource = {
  discover(
    projectId: string,
    actor: CapabilityRegistryActor,
  ): Promise<{
    executionTargets: Array<{
      capability_id: string;
      provider_config_id: string;
      model: string;
    }>;
  }>;
};

export type PublishedEvaluationSource = {
  findPublishedSnapshot(input: {
    accountId: string;
    projectId: string;
    candidateHash: string;
    capabilityId: typeof IMAGE_CAPABILITY_ID;
    capabilityVersion: typeof IMAGE_CAPABILITY_VERSION;
  }): Promise<IntelligenceModelEvaluationSnapshot | null>;
};

type ResolveImageEstimateInput = Omit<
  Parameters<typeof defaultResolveStudioEstimate>[0],
  'repository'
>;
type ResolveImageEstimate = (
  input: ResolveImageEstimateInput,
) => ReturnType<typeof defaultResolveStudioEstimate>;

export type IntelligenceRouteCandidateSourceOptions = {
  resolveGatewayRoute: GatewayRouteResolver;
  capabilityRegistry?: ImageDiscoverySource;
  repository?: StudioRepository;
  resolveImageEstimate?: ResolveImageEstimate;
  evaluationSource?: PublishedEvaluationSource;
  credentialBindingExists?: ResolveImageEstimateInput['credentialBindingExists'];
};

export type TextPlanningCandidates = {
  policyId: string;
  primaryModel: string;
  fallbackModel: string | null;
  fallbackOn: 'transient' | 'any-error';
};

export function createIntelligenceRouteCandidateSource(
  options: IntelligenceRouteCandidateSourceOptions,
) {
  const resolveGatewayRoute = options.resolveGatewayRoute;
  return {
    async resolveTextPlanningCandidates(input: {
      principal: AuthedPrincipal;
      requestedModel: string;
      requiresImageInput: boolean;
    }): Promise<TextPlanningCandidates> {
      const route = await resolveGatewayRoute(input.principal, {
        requestedModel: input.requestedModel,
        requires: { imageInput: input.requiresImageInput },
      });
      return {
        policyId: route.policyId,
        primaryModel: route.primaryModel,
        fallbackModel:
          route.fallbackModels?.find((model) => model !== route.primaryModel) ?? null,
        fallbackOn: route.fallbackOn ?? 'transient',
      };
    },

    async listImageCandidates(input: {
      accountId: string;
      projectId: string;
      actor: CapabilityRegistryActor;
      input: StudioJobInput;
      iamAllowed: boolean;
      agentAllowed: boolean;
      projectPolicy: 'allow' | 'deny';
    }): Promise<IntelligenceRouteCandidate[]> {
      if (
        !options.capabilityRegistry ||
        !options.evaluationSource ||
        (!options.repository && !options.resolveImageEstimate)
      ) {
        return [];
      }

      let discovery: Awaited<ReturnType<ImageDiscoverySource['discover']>>;
      try {
        discovery = await options.capabilityRegistry.discover(input.projectId, input.actor);
      } catch {
        return [];
      }

      const targets = discovery.executionTargets
        .filter((target) => target.capability_id === IMAGE_CAPABILITY_ID)
        .sort((left, right) =>
          compareAscii(
            `${left.provider_config_id}\u0000${left.model}`,
            `${right.provider_config_id}\u0000${right.model}`,
          ),
        );
      const candidates: IntelligenceRouteCandidate[] = [];

      for (const target of targets) {
        try {
          const request: StudioEstimateRequest = {
            capability: 'image.generate',
            provider_config_id: target.provider_config_id,
            model: target.model,
            input: input.input,
          };
          const estimateInput: ResolveImageEstimateInput = {
            accountId: input.accountId,
            projectId: input.projectId,
            request,
            ...(options.credentialBindingExists
              ? { credentialBindingExists: options.credentialBindingExists }
              : {}),
          };
          const estimate = options.resolveImageEstimate
            ? await options.resolveImageEstimate(estimateInput)
            : await defaultResolveStudioEstimate({
                ...estimateInput,
                repository: options.repository!,
              });
          if (!estimate.ok) continue;
          const provider = estimate.value.provider;
          if (
            provider.account_id !== input.accountId ||
            provider.project_id !== input.projectId ||
            provider.provider_config_id !== target.provider_config_id ||
            !provider.enabled ||
            !provider.capabilities.includes('image.generate')
          ) {
            continue;
          }
          const estimatedCostMicredits = creditsToMicredits(
            estimate.value.costs.max_approved_credits,
          );
          if (estimatedCostMicredits === null) continue;

          const identity = {
            provider_definition_id: provider.provider,
            provider_config_id: target.provider_config_id,
            model_id: target.model,
            capability_id: IMAGE_CAPABILITY_ID,
            capability_version: IMAGE_CAPABILITY_VERSION,
          };
          const candidateHash = canonicalWorkflowHash(identity);
          const snapshot = await options.evaluationSource.findPublishedSnapshot({
            accountId: input.accountId,
            projectId: input.projectId,
            candidateHash,
            capabilityId: IMAGE_CAPABILITY_ID,
            capabilityVersion: IMAGE_CAPABILITY_VERSION,
          });
          const evaluation = normalizeEvaluation(snapshot, {
            accountId: input.accountId,
            projectId: input.projectId,
            candidateHash,
          });

          candidates.push({
            candidateId: candidateHash,
            providerDefinitionId: provider.provider,
            providerConfigId: target.provider_config_id,
            modelId: target.model,
            capabilityId: IMAGE_CAPABILITY_ID,
            capabilityVersion: IMAGE_CAPABILITY_VERSION,
            schemaVersion: IMAGE_SCHEMA_VERSION,
            region: provider.region ?? 'global',
            safetyClass: 'standard',
            supportedInputKinds: ['text', 'image'],
            outputKind: 'image',
            ready: true,
            iamAllowed: input.iamAllowed,
            agentAllowed: input.agentAllowed,
            projectPolicy: input.projectPolicy,
            estimatedCostMicredits,
            estimatedLatencyMs: evaluation?.latencyP95Ms ?? 0,
            riskPenaltyPpm: 0,
            evaluation: evaluation
              ? {
                  snapshotVersion: evaluation.snapshotVersion,
                  publishedAt: evaluation.publishedAt,
                  sampleCount: evaluation.sampleCount,
                  minimumSampleCount: evaluation.minimumSampleCount,
                  meetsMinimumSamples: evaluation.meetsMinimumSamples,
                  confidenceLowerBoundPpm: evaluation.confidenceLowerBoundPpm,
                  qualityRatePpm: evaluation.qualityRatePpm,
                  availabilityRatePpm: evaluation.availabilityRatePpm,
                  failureRatePpm: evaluation.failureRatePpm,
                }
              : null,
          });
        } catch {
          // One malformed or stale target must not hide other discovered targets.
        }
      }

      return candidates;
    },
  };
}

export type IntelligenceRouteCandidateSource = ReturnType<
  typeof createIntelligenceRouteCandidateSource
>;

function normalizeEvaluation(
  snapshot: IntelligenceModelEvaluationSnapshot | null,
  expected: { accountId: string; projectId: string; candidateHash: string },
) {
  if (
    !snapshot ||
    snapshot.account_id !== expected.accountId ||
    snapshot.project_id !== expected.projectId ||
    snapshot.candidate_hash !== expected.candidateHash ||
    snapshot.capability_id !== IMAGE_CAPABILITY_ID ||
    snapshot.capability_version !== IMAGE_CAPABILITY_VERSION
  ) {
    return null;
  }
  return {
    snapshotVersion: snapshot.snapshot_version,
    publishedAt: snapshot.published_at,
    sampleCount: snapshot.sample_count,
    minimumSampleCount: snapshot.minimum_sample_count,
    meetsMinimumSamples: snapshot.meets_minimum_samples,
    confidenceLowerBoundPpm: snapshot.confidence.lower_bound_ppm,
    qualityRatePpm: snapshot.metrics.human_approval_rate_ppm,
    availabilityRatePpm: snapshot.metrics.availability_rate_ppm,
    failureRatePpm: snapshot.metrics.failure_rate_ppm,
    latencyP95Ms: snapshot.metrics.latency_p95_ms,
  };
}

function creditsToMicredits(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  const result = Math.round(value * MICREDITS_PER_CREDIT);
  return Number.isSafeInteger(result) ? result : null;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
