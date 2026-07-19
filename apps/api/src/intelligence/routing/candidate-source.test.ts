import { describe, expect, test } from 'bun:test';
import type { IntelligenceModelEvaluationSnapshot } from '@kortix/intelligence-contracts';
import { canonicalWorkflowHash } from '@kortix/intelligence-orchestration';
import { createIntelligenceRouteCandidateSource } from './candidate-source';

const ACCOUNT_ID = '61000000-0000-4000-a000-000000000001';
const PROJECT_ID = '62000000-0000-4000-a000-000000000001';
const USER_ID = '63000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '64000000-0000-4000-a000-000000000001';
const PRICING_CATALOG_ID = '65000000-0000-4000-a000-000000000001';
const MODEL_ID = 'images/pro-v1';

function evaluationSnapshot(candidateHash: string): IntelligenceModelEvaluationSnapshot {
  return {
    protocol_version: 'intelligence.workflow.v1',
    snapshot_id: '66000000-0000-4000-a000-000000000001',
    snapshot_version: 'image-route-eval-v1',
    evaluation_run_id: '67000000-0000-4000-a000-000000000001',
    suite_id: '68000000-0000-4000-a000-000000000001',
    suite_version: 'image-suite-v1',
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    candidate_hash: candidateHash,
    capability_id: 'studio.image.generate',
    capability_version: '1.0.0',
    sample_count: 100,
    minimum_sample_count: 30,
    meets_minimum_samples: true,
    confidence: {
      method: 'wilson',
      level_bps: 9_500,
      lower_bound_ppm: 900_000,
      upper_bound_ppm: 990_000,
    },
    metrics: {
      schema_valid_rate_ppm: 990_000,
      integrity_rate_ppm: 980_000,
      safety_rate_ppm: 1_000_000,
      availability_rate_ppm: 970_000,
      failure_rate_ppm: 30_000,
      retry_rate_ppm: 40_000,
      human_approval_rate_ppm: 920_000,
      latency_p50_ms: 800,
      latency_p95_ms: 1_500,
      mean_cost_micredits: 2_000_000,
      total_cost_micredits: 200_000_000,
    },
    scorer_versions: [{ scorer_id: 'image.schema_validity', version: '1.0.0' }],
    published_at: '2026-07-19T00:00:00.000Z',
  };
}

function imageInput() {
  return {
    capability: 'image.generate' as const,
    image: {
      prompt: 'private prompt that must not enter the candidate',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      width: 1024,
      height: 1024,
      quality: 'standard' as const,
      output_count: 1,
    },
  };
}

describe('intelligence routing candidate source', () => {
  test('reuses the existing gateway route and retains at most one text fallback', async () => {
    const calls: unknown[] = [];
    const source = createIntelligenceRouteCandidateSource({
      resolveGatewayRoute: async (principal, input) => {
        calls.push({ principal, input });
        return {
          policyId: 'project:default',
          primaryModel: 'anthropic/claude-sonnet-4.6',
          fallbackModels: ['openai/gpt-5.4', 'google/gemini-3.1-pro'],
          fallbackOn: 'transient',
        };
      },
    });

    const result = await source.resolveTextPlanningCandidates({
      principal: {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        userId: USER_ID,
        defaultModel: 'anthropic/claude-sonnet-4.6',
      },
      requestedModel: 'auto',
      requiresImageInput: false,
    });

    expect(calls).toEqual([
      {
        principal: {
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          userId: USER_ID,
          defaultModel: 'anthropic/claude-sonnet-4.6',
        },
        input: { requestedModel: 'auto', requires: { imageInput: false } },
      },
    ]);
    expect(result).toEqual({
      policyId: 'project:default',
      primaryModel: 'anthropic/claude-sonnet-4.6',
      fallbackModel: 'openai/gpt-5.4',
      fallbackOn: 'transient',
    });
  });

  test('normalizes discovered Studio image targets without leaking provider or prompt data', async () => {
    const candidateHash = canonicalWorkflowHash({
      provider_definition_id: 'openai-compatible',
      provider_config_id: PROVIDER_CONFIG_ID,
      model_id: MODEL_ID,
      capability_id: 'studio.image.generate',
      capability_version: '1.0.0',
    });
    const evaluationReads: unknown[] = [];
    const source = createIntelligenceRouteCandidateSource({
      resolveGatewayRoute: async () => {
        throw new Error('not used');
      },
      capabilityRegistry: {
        async discover() {
          return {
            capabilities: [],
            executionTargets: [
              {
                capability_id: 'studio.image.generate',
                provider_config_id: PROVIDER_CONFIG_ID,
                model: MODEL_ID,
              },
            ],
          };
        },
      },
      async resolveImageEstimate(input) {
        expect(input.request.input).toEqual(imageInput());
        return {
          ok: true,
          value: {
            provider: {
              provider_config_id: PROVIDER_CONFIG_ID,
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              provider: 'openai-compatible',
              display_name: 'Private image provider',
              base_url: 'https://private-provider.example/v1',
              region: 'cn-east-1',
              credential_binding: { kind: 'secret', identifier: 'provider-key' },
              capabilities: ['image.generate'],
              enabled: true,
              created_at: '2026-07-18T00:00:00.000Z',
              updated_at: '2026-07-18T00:00:00.000Z',
            },
            versionBinding: {
              providerConfigVersion: 'provider-config-v3',
              pricingCatalogId: PRICING_CATALOG_ID,
              pricingVersion: 7,
            },
            costs: {
              provider_cost_credits: 1.5,
              platform_cost_credits: 0.5,
              max_approved_credits: 2,
              line_items: [],
            },
          },
        };
      },
      evaluationSource: {
        async findPublishedSnapshot(input) {
          evaluationReads.push(input);
          return evaluationSnapshot(candidateHash);
        },
      },
    });

    const candidates = await source.listImageCandidates({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actor: { accountId: ACCOUNT_ID, userId: USER_ID, actorType: 'user' },
      input: imageInput(),
      iamAllowed: true,
      agentAllowed: true,
      projectPolicy: 'allow',
    });

    expect(evaluationReads).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        candidateHash,
        capabilityId: 'studio.image.generate',
        capabilityVersion: '1.0.0',
      },
    ]);
    expect(candidates).toEqual([
      {
        candidateId: candidateHash,
        providerDefinitionId: 'openai-compatible',
        providerConfigId: PROVIDER_CONFIG_ID,
        modelId: MODEL_ID,
        capabilityId: 'studio.image.generate',
        capabilityVersion: '1.0.0',
        schemaVersion: 'studio.image.generate.request.v1',
        region: 'cn-east-1',
        safetyClass: 'standard',
        supportedInputKinds: ['text', 'image'],
        outputKind: 'image',
        ready: true,
        iamAllowed: true,
        agentAllowed: true,
        projectPolicy: 'allow',
        estimatedCostMicredits: 2_000_000,
        estimatedLatencyMs: 1_500,
        riskPenaltyPpm: 0,
        evaluation: {
          snapshotVersion: 'image-route-eval-v1',
          publishedAt: '2026-07-19T00:00:00.000Z',
          sampleCount: 100,
          minimumSampleCount: 30,
          meetsMinimumSamples: true,
          confidenceLowerBoundPpm: 900_000,
          qualityRatePpm: 920_000,
          availabilityRatePpm: 970_000,
          failureRatePpm: 30_000,
        },
      },
    ]);
    expect(JSON.stringify(candidates)).not.toContain('private-provider.example');
    expect(JSON.stringify(candidates)).not.toContain('provider-key');
    expect(JSON.stringify(candidates)).not.toContain('private prompt');
  });

  test('fails closed per unavailable image target and keeps healthy target ordering stable', async () => {
    const secondProviderConfigId = '64000000-0000-4000-a000-000000000002';
    const source = createIntelligenceRouteCandidateSource({
      resolveGatewayRoute: async () => {
        throw new Error('not used');
      },
      capabilityRegistry: {
        async discover() {
          return {
            capabilities: [],
            executionTargets: [
              {
                capability_id: 'studio.image.generate',
                provider_config_id: secondProviderConfigId,
                model: 'model-z',
              },
              {
                capability_id: 'studio.image.generate',
                provider_config_id: PROVIDER_CONFIG_ID,
                model: 'model-a',
              },
            ],
          };
        },
      },
      async resolveImageEstimate(input) {
        if (input.request.provider_config_id === secondProviderConfigId) {
          return {
            ok: false,
            status: 409,
            code: 'STUDIO_PRICING_STALE',
            message: 'sensitive provider failure',
          };
        }
        return {
          ok: true,
          value: {
            provider: {
              provider_config_id: PROVIDER_CONFIG_ID,
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              provider: 'fake',
              display_name: 'Fake',
              base_url: null,
              region: null,
              credential_binding: { kind: 'none' },
              capabilities: ['image.generate'],
              enabled: true,
              created_at: '2026-07-18T00:00:00.000Z',
              updated_at: '2026-07-18T00:00:00.000Z',
            },
            versionBinding: {
              providerConfigVersion: 'fake-provider-v1',
              pricingCatalogId: PRICING_CATALOG_ID,
              pricingVersion: 1,
            },
            costs: {
              provider_cost_credits: 1,
              platform_cost_credits: 0,
              max_approved_credits: 1,
              line_items: [],
            },
          },
        };
      },
      evaluationSource: {
        async findPublishedSnapshot() {
          return null;
        },
      },
    });

    const candidates = await source.listImageCandidates({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actor: { accountId: ACCOUNT_ID, userId: USER_ID, actorType: 'user' },
      input: imageInput(),
      iamAllowed: true,
      agentAllowed: true,
      projectPolicy: 'allow',
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      providerDefinitionId: 'fake',
      providerConfigId: PROVIDER_CONFIG_ID,
      modelId: 'model-a',
      region: 'global',
      evaluation: null,
    });
  });
});
