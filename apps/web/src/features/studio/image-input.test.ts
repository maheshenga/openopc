import { expect, test } from 'bun:test';
import {
  buildImageEstimateRequest,
  buildImageTaskRequest,
  createImageEstimateController,
  createImageEstimateState,
  createImageIdempotencyKey,
  estimateApprovalForCurrentForm,
  selectImageExecutionTarget,
} from './image-input';

const form = {
  prompt: '  A precise product photograph  ',
  negativePrompt: '  blur  ',
  referenceAssetIds: ['27000000-0000-4000-a000-000000000001'],
  aspectRatio: '1:1' as const,
  quality: 'standard' as const,
  outputCount: 2,
  providerConfigId: '14000000-0000-4000-a000-000000000001',
  model: 'fake/image-v1',
  agentCardHash: 'a'.repeat(64),
  idempotencyKey: 'image-studio-submission-0001',
};

const estimate = {
  estimate_id: '21000000-0000-4000-a000-000000000001',
  estimate_token: 'studio-estimate-v2.payload.signature',
  expires_at: '2026-07-20T12:15:00.000Z',
  currency: 'credits' as const,
  provider_cost_credits: 2,
  platform_cost_credits: 0.5,
  max_approved_credits: 2.5,
  input_hash: `sha256:${'b'.repeat(64)}`,
  line_items: [],
};

test('builds a normalized Intelligence task only from the current signed estimate', () => {
  const state = createImageEstimateState(form, estimate);
  const approval = estimateApprovalForCurrentForm(form, state);
  expect(approval).toEqual({
    estimate_id: estimate.estimate_id,
    estimate_token: estimate.estimate_token,
    max_approved_credits: estimate.max_approved_credits,
  });
  if (!approval) throw new Error('expected current estimate approval');

  const request = buildImageTaskRequest(form, approval);
  expect(request).toMatchObject({
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: 'a'.repeat(64),
    provider_config_id: form.providerConfigId,
    model: form.model,
    idempotency_key: form.idempotencyKey,
    estimate_approval: approval,
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'A precise product photograph',
        negative_prompt: 'blur',
        reference_asset_ids: form.referenceAssetIds,
        output_count: 2,
      },
    },
  });

  expect(estimateApprovalForCurrentForm({ ...form, outputCount: 3 }, state)).toBeNull();
});

test('clears only stale estimate approvals when estimate-relevant form state changes', () => {
  const controller = createImageEstimateController(form);
  controller.storeEstimate(estimate);
  expect(controller.getApproval()).toMatchObject({ estimate_id: estimate.estimate_id });

  controller.updateForm({ ...form, prompt: 'A precise product photograph' });
  expect(controller.getApproval()).toMatchObject({ estimate_id: estimate.estimate_id });

  controller.updateForm({ ...form, idempotencyKey: 'image-studio-submission-0002' });
  expect(controller.getApproval()).toMatchObject({ estimate_id: estimate.estimate_id });

  controller.updateForm({ ...form, outputCount: 3 });
  expect(controller.getApproval()).toBeNull();
});

test('normalizes estimate fields, reuses idempotency, and bounds output count', () => {
  expect(buildImageEstimateRequest(form)).toMatchObject({
    input: {
      image: {
        prompt: 'A precise product photograph',
        negative_prompt: 'blur',
        output_count: 2,
      },
    },
  });
  expect(
    buildImageTaskRequest(form, {
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      max_approved_credits: estimate.max_approved_credits,
    }).idempotency_key,
  ).toBe(form.idempotencyKey);
  expect(createImageIdempotencyKey(() => 'fixed-uuid')).toBe('image-studio:fixed-uuid');
  expect(() => buildImageEstimateRequest({ ...form, outputCount: 0 })).toThrow(
    'INVALID_OUTPUT_COUNT',
  );
  expect(() => buildImageEstimateRequest({ ...form, outputCount: 9 })).toThrow(
    'INVALID_OUTPUT_COUNT',
  );
});

test('selects only an executable image target matching provider and model', () => {
  const target = {
    capability_id: 'studio.image.generate' as const,
    provider_config_id: form.providerConfigId,
    model: form.model,
  };
  const discovery = {
    protocol_version: 'intelligence.v1' as const,
    items: [],
    execution_targets: [target],
    next_cursor: null,
  };
  expect(selectImageExecutionTarget(discovery, null)).toEqual(target);
  expect(
    selectImageExecutionTarget(discovery, {
      providerConfigId: form.providerConfigId,
      model: form.model,
    }),
  ).toEqual(target);
  expect(
    selectImageExecutionTarget(discovery, {
      providerConfigId: form.providerConfigId,
      model: 'other/image-v1',
    }),
  ).toBeNull();
});
