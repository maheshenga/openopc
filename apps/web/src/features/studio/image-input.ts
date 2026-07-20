import type {
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCreateTaskRequest,
  IntelligenceEstimateApproval,
  IntelligenceExecutionTarget,
  IntelligenceImageEstimate,
  IntelligenceImageEstimateRequest,
} from '@kortix/sdk';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

export interface IntelligenceImageFormState {
  prompt: string;
  negativePrompt?: string;
  referenceAssetIds: string[];
  aspectRatio: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
  quality: 'standard' | 'high';
  outputCount: number;
  seed?: number;
  advanced?: Record<string, unknown>;
  providerConfigId: string;
  model: string;
  agentCardHash: string;
  idempotencyKey: string;
}

export interface ImageExecutionSelection {
  providerConfigId: string;
  model: string;
}

export interface ImageEstimateState {
  readonly formFingerprint: string;
  readonly estimate: IntelligenceImageEstimate;
}

export interface ImageEstimateController {
  updateForm(input: IntelligenceImageFormState): void;
  storeEstimate(estimate: IntelligenceImageEstimate): void;
  getApproval(): IntelligenceEstimateApproval | null;
  clearEstimate(): void;
}

export function buildImageEstimateRequest(
  input: IntelligenceImageFormState,
): IntelligenceImageEstimateRequest {
  const normalized = normalizeForm(input);
  return {
    capability: 'image.generate',
    provider_config_id: normalized.providerConfigId,
    model: normalized.model,
    input: {
      capability: 'image.generate',
      image: {
        prompt: normalized.prompt,
        ...(normalized.negativePrompt ? { negative_prompt: normalized.negativePrompt } : {}),
        reference_asset_ids: normalized.referenceAssetIds,
        aspect_ratio: normalized.aspectRatio,
        quality: normalized.quality,
        output_count: normalized.outputCount,
        ...(normalized.seed !== undefined ? { seed: normalized.seed } : {}),
        ...(normalized.advanced !== undefined ? { advanced: normalized.advanced } : {}),
      },
    },
  };
}

export function buildImageTaskRequest(
  input: IntelligenceImageFormState,
  approval: IntelligenceEstimateApproval,
): IntelligenceCreateTaskRequest {
  const normalized = normalizeForm(input);
  assertApproval(approval);
  return {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: normalized.agentCardHash,
    provider_config_id: normalized.providerConfigId,
    model: normalized.model,
    input: buildImageEstimateRequest(normalized).input,
    idempotency_key: normalized.idempotencyKey,
    parent_task_id: null,
    deadline_at: null,
    estimate_approval: { ...approval },
  };
}

export function createImageEstimateState(
  input: IntelligenceImageFormState,
  estimate: IntelligenceImageEstimate,
): ImageEstimateState {
  return Object.freeze({
    formFingerprint: imageEstimateFingerprint(input),
    estimate,
  });
}

export function estimateApprovalForCurrentForm(
  input: IntelligenceImageFormState,
  state: ImageEstimateState | null,
): IntelligenceEstimateApproval | null {
  if (!state || state.formFingerprint !== imageEstimateFingerprint(input)) return null;
  return {
    estimate_id: state.estimate.estimate_id,
    estimate_token: state.estimate.estimate_token,
    max_approved_credits: state.estimate.max_approved_credits,
  };
}

export function createImageEstimateController(
  initialForm: IntelligenceImageFormState,
): ImageEstimateController {
  let currentFingerprint = imageEstimateFingerprint(initialForm);
  let state: ImageEstimateState | null = null;
  return Object.freeze({
    updateForm(input: IntelligenceImageFormState) {
      const nextFingerprint = imageEstimateFingerprint(input);
      if (nextFingerprint !== currentFingerprint) state = null;
      currentFingerprint = nextFingerprint;
    },
    storeEstimate(estimate: IntelligenceImageEstimate) {
      state = Object.freeze({ formFingerprint: currentFingerprint, estimate });
    },
    getApproval() {
      if (!state || state.formFingerprint !== currentFingerprint) return null;
      return {
        estimate_id: state.estimate.estimate_id,
        estimate_token: state.estimate.estimate_token,
        max_approved_credits: state.estimate.max_approved_credits,
      };
    },
    clearEstimate() {
      state = null;
    },
  });
}

export function imageEstimateFingerprint(input: IntelligenceImageFormState): string {
  return JSON.stringify(buildImageEstimateRequest(input));
}

export function selectImageExecutionTarget(
  discovery: IntelligenceCapabilityDiscoveryResponse | null | undefined,
  selection: ImageExecutionSelection | null | undefined,
): IntelligenceExecutionTarget | null {
  const targets = discovery?.execution_targets ?? [];
  if (selection) {
    return (
      targets.find(
        (target) =>
          target.capability_id === 'studio.image.generate' &&
          target.provider_config_id === selection.providerConfigId &&
          target.model === selection.model,
      ) ?? null
    );
  }
  return targets.find((target) => target.capability_id === 'studio.image.generate') ?? null;
}

export function createImageIdempotencyKey(
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  return `image-studio:${randomUuid()}`;
}

function normalizeForm(input: IntelligenceImageFormState): IntelligenceImageFormState {
  const prompt = input.prompt.trim();
  const negativePrompt = input.negativePrompt?.trim() ?? '';
  const referenceAssetIds = [...new Set(input.referenceAssetIds)];
  if (prompt.length < 1 || prompt.length > 8000) throw new Error('INVALID_PROMPT');
  if (negativePrompt.length > 4000) throw new Error('INVALID_NEGATIVE_PROMPT');
  if (
    referenceAssetIds.length > 8 ||
    referenceAssetIds.some((assetId) => !UUID_PATTERN.test(assetId))
  ) {
    throw new Error('INVALID_REFERENCE_ASSETS');
  }
  if (!Number.isInteger(input.outputCount) || input.outputCount < 1 || input.outputCount > 8) {
    throw new Error('INVALID_OUTPUT_COUNT');
  }
  if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) {
    throw new Error('INVALID_SEED');
  }
  if (!UUID_PATTERN.test(input.providerConfigId)) throw new Error('INVALID_PROVIDER');
  if (input.model.trim().length < 1 || input.model.length > 255) throw new Error('INVALID_MODEL');
  if (!HASH_PATTERN.test(input.agentCardHash)) throw new Error('INVALID_AGENT_CARD');
  if (input.idempotencyKey.trim().length < 16 || input.idempotencyKey.length > 255) {
    throw new Error('INVALID_IDEMPOTENCY_KEY');
  }
  return {
    ...input,
    prompt,
    ...(negativePrompt ? { negativePrompt } : { negativePrompt: undefined }),
    referenceAssetIds,
    model: input.model.trim(),
    idempotencyKey: input.idempotencyKey.trim(),
  };
}

function assertApproval(approval: IntelligenceEstimateApproval): void {
  if (
    !UUID_PATTERN.test(approval.estimate_id) ||
    approval.estimate_token.trim().length < 1 ||
    approval.estimate_token.length > 8192 ||
    !Number.isFinite(approval.max_approved_credits) ||
    approval.max_approved_credits < 0 ||
    approval.max_approved_credits > 1_000_000
  ) {
    throw new Error('INVALID_ESTIMATE_APPROVAL');
  }
}
