import type {
  IntelligenceCreateTaskRequest,
  IntelligenceExecutionTarget,
  IntelligenceImageEstimate,
  IntelligenceImageEstimateRequest,
  IntelligenceStudioJobStatus,
  IntelligenceTaskEventsResponse,
  TaskEvent,
} from '@kortix/sdk';

export type MobileImageAspectRatio = '1:1' | '4:3' | '3:4' | '16:9' | '9:16';

export interface MobileImageDraft {
  prompt: string;
  target: IntelligenceExecutionTarget;
  aspectRatio?: MobileImageAspectRatio;
  quality?: 'standard' | 'high';
  outputCount?: number;
}

export interface MobileImageTaskBinding {
  agentCardHash: string;
  idempotencyKey: string;
  estimate: IntelligenceImageEstimate;
}

export interface MobileImageTaskState {
  taskId: string;
  jobId: string | null;
  cursor: string | null;
  status: TaskEvent['status'];
  progress: number;
  assetIds: string[];
  errorCode: string | null;
  terminal: boolean;
  lastSequence: number;
  lastUpdatedAt: string | null;
}

const TERMINAL_STATUSES = new Set<TaskEvent['status']>(['succeeded', 'failed', 'cancelled']);
const TASK_STATUSES = new Set<TaskEvent['status']>([
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'failed',
  'cancelled',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ESTIMATE_REFRESH_CODES = new Set([
  'INTELLIGENCE_ESTIMATE_INVALID',
  'INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED',
  'STUDIO_ESTIMATE_EXPIRED',
  'STUDIO_PRICING_STALE',
  'STUDIO_PROVIDER_CONFIG_STALE',
]);

export function hasMobileImageTarget(targets: readonly IntelligenceExecutionTarget[]): boolean {
  return targets.some((target) => target.capability_id === 'studio.image.generate');
}

export function shouldRefreshMobileImageEstimate(errorCode: string | null): boolean {
  return errorCode !== null && ESTIMATE_REFRESH_CODES.has(errorCode);
}

export function selectMobileImageTarget(
  targets: readonly IntelligenceExecutionTarget[],
  selected?: Pick<IntelligenceExecutionTarget, 'provider_config_id' | 'model'> | null,
): IntelligenceExecutionTarget | null {
  const imageTargets = targets.filter((target) => target.capability_id === 'studio.image.generate');
  if (!selected) return imageTargets[0] ?? null;
  return (
    imageTargets.find(
      (target) =>
        target.provider_config_id === selected.provider_config_id &&
        target.model === selected.model,
    ) ?? null
  );
}

export function buildMobileImageEstimateRequest(
  draft: MobileImageDraft,
): IntelligenceImageEstimateRequest {
  const prompt = draft.prompt.trim();
  const outputCount = draft.outputCount ?? 1;
  if (prompt.length < 1 || prompt.length > 8000) throw new Error('INVALID_PROMPT');
  if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > 8) {
    throw new Error('INVALID_OUTPUT_COUNT');
  }

  return {
    capability: 'image.generate',
    provider_config_id: draft.target.provider_config_id,
    model: draft.target.model,
    input: {
      capability: 'image.generate',
      image: {
        prompt,
        reference_asset_ids: [],
        aspect_ratio: draft.aspectRatio ?? '1:1',
        quality: draft.quality ?? 'standard',
        output_count: outputCount,
      },
    },
  };
}

export function buildMobileImageTaskRequest(
  estimateRequest: IntelligenceImageEstimateRequest,
  binding: MobileImageTaskBinding,
): IntelligenceCreateTaskRequest {
  if (!/^[a-f0-9]{64}$/i.test(binding.agentCardHash)) {
    throw new Error('INVALID_AGENT_CARD');
  }
  const idempotencyKey = binding.idempotencyKey.trim();
  if (idempotencyKey.length < 16 || idempotencyKey.length > 255) {
    throw new Error('INVALID_IDEMPOTENCY_KEY');
  }

  return {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: binding.agentCardHash,
    provider_config_id: estimateRequest.provider_config_id,
    model: estimateRequest.model,
    input: estimateRequest.input,
    idempotency_key: idempotencyKey,
    parent_task_id: null,
    deadline_at: null,
    estimate_approval: {
      estimate_id: binding.estimate.estimate_id,
      estimate_token: binding.estimate.estimate_token,
      max_approved_credits: binding.estimate.max_approved_credits,
    },
  };
}

export function emptyMobileImageTaskState(
  taskId: string,
  jobId: string | null = null,
): MobileImageTaskState {
  return {
    taskId,
    jobId,
    cursor: null,
    status: 'queued',
    progress: 0,
    assetIds: [],
    errorCode: null,
    terminal: false,
    lastSequence: 0,
    lastUpdatedAt: null,
  };
}

export function mergeMobileImageTaskEvents(
  current: MobileImageTaskState,
  response: IntelligenceTaskEventsResponse,
): MobileImageTaskState {
  if (current.terminal) return current;
  if (response.task_id !== current.taskId) {
    throw new Error('INTELLIGENCE_TASK_SCOPE_MISMATCH');
  }

  const assetIds = new Set(current.assetIds);
  let next = { ...current, assetIds: [...current.assetIds] };
  const ordered = [...response.items].sort((left, right) => left.sequence - right.sequence);

  for (const event of ordered) {
    if (next.terminal || event.sequence <= next.lastSequence) continue;
    if (event.task_id !== current.taskId) {
      throw new Error('INTELLIGENCE_TASK_SCOPE_MISMATCH');
    }
    if (next.jobId && event.job_id && event.job_id !== next.jobId) {
      throw new Error('INTELLIGENCE_TASK_JOB_SCOPE_MISMATCH');
    }
    for (const assetId of event.asset_ids ?? []) assetIds.add(assetId);
    const terminal = TERMINAL_STATUSES.has(event.status);
    next = {
      taskId: current.taskId,
      jobId: event.job_id ?? next.jobId,
      cursor: next.cursor,
      status: event.status,
      progress:
        event.status === 'succeeded' ? 1 : Math.max(next.progress, event.progress ?? next.progress),
      assetIds: [...assetIds],
      errorCode: event.error_code ?? next.errorCode,
      terminal,
      lastSequence: event.sequence,
      lastUpdatedAt: event.created_at,
    };
  }

  return {
    ...next,
    cursor: response.next_cursor ?? next.cursor,
  };
}

export function serializeMobileImageTaskState(state: MobileImageTaskState): string {
  return JSON.stringify(state);
}

export function parseMobileImageTaskState(value: string | null): MobileImageTaskState | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<MobileImageTaskState>;
    if (
      !UUID_PATTERN.test(candidate.taskId ?? '') ||
      (candidate.jobId !== null && !UUID_PATTERN.test(candidate.jobId ?? '')) ||
      (candidate.cursor !== null &&
        (typeof candidate.cursor !== 'string' || candidate.cursor.length > 2048)) ||
      !TASK_STATUSES.has(candidate.status as TaskEvent['status']) ||
      typeof candidate.progress !== 'number' ||
      !Number.isFinite(candidate.progress) ||
      candidate.progress < 0 ||
      candidate.progress > 1 ||
      !Array.isArray(candidate.assetIds) ||
      candidate.assetIds.some((assetId) => !UUID_PATTERN.test(String(assetId))) ||
      typeof candidate.terminal !== 'boolean' ||
      !Number.isSafeInteger(candidate.lastSequence) ||
      (candidate.lastSequence ?? -1) < 0 ||
      (candidate.errorCode !== null &&
        (typeof candidate.errorCode !== 'string' ||
          !/^[A-Z][A-Z0-9_.-]{0,127}$/.test(candidate.errorCode))) ||
      (candidate.lastUpdatedAt !== null &&
        (typeof candidate.lastUpdatedAt !== 'string' ||
          !Number.isFinite(Date.parse(candidate.lastUpdatedAt))))
    ) {
      return null;
    }
    return {
      taskId: candidate.taskId as string,
      jobId: candidate.jobId as string | null,
      cursor: candidate.cursor as string | null,
      status: candidate.status as TaskEvent['status'],
      progress: candidate.progress,
      assetIds: [...new Set(candidate.assetIds as string[])],
      errorCode: candidate.errorCode as string | null,
      terminal: candidate.terminal,
      lastSequence: candidate.lastSequence as number,
      lastUpdatedAt: candidate.lastUpdatedAt as string | null,
    };
  } catch {
    return null;
  }
}

export function reconcileMobileImageTaskWithJob(
  current: MobileImageTaskState,
  job: {
    job_id: string;
    status: IntelligenceStudioJobStatus;
    error_code: string | null;
    updated_at: string;
  },
): MobileImageTaskState {
  if (job.job_id !== current.jobId) {
    throw new Error('INTELLIGENCE_TASK_JOB_SCOPE_MISMATCH');
  }
  const terminal = TERMINAL_STATUSES.has(job.status);
  return {
    ...current,
    status: job.status,
    progress: job.status === 'succeeded' ? 1 : current.progress,
    errorCode: job.error_code ?? current.errorCode,
    terminal,
    lastUpdatedAt: job.updated_at,
  };
}
