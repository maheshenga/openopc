import type { ModelKey } from '@/hooks/opencode/use-opencode-local';
import { getModelAvailabilityMessage } from '@/lib/runtime-brand-copy';

export const NO_MODEL_AVAILABLE_MESSAGE = 'No models available for this session yet.';
export const NO_MODEL_AVAILABLE_ACTION_MESSAGE =
  getModelAvailabilityMessage();

export function isModelRequiredButUnavailable({
  modelRequired,
  selectedModel,
  lockForQuestion,
}: {
  modelRequired: boolean;
  selectedModel: ModelKey | null | undefined;
  lockForQuestion: boolean;
}): boolean {
  return modelRequired && !lockForQuestion && !selectedModel;
}
