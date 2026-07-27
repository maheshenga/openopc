import type { Sha256Digest } from '@openopc/module-runtime-contracts';

export interface ModuleExecutionInput {
  executionId: string;
  accountId: string;
  projectId: string;
  payload: Uint8Array;
  digest: Sha256Digest;
  createdAt: string;
}

export interface ExecutionInputStore {
  get(
    accountId: string,
    projectId: string,
    executionId: string,
  ): Promise<ModuleExecutionInput | null>;
}

export interface MutableExecutionInputStore extends ExecutionInputStore {
  store(input: ModuleExecutionInput): Promise<void>;
}

function cloneInput(input: ModuleExecutionInput): ModuleExecutionInput {
  return { ...input, payload: new Uint8Array(input.payload) };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

export function createMemoryExecutionInputStore(input?: {
  inputs?: readonly ModuleExecutionInput[];
}): MutableExecutionInputStore {
  const inputs = new Map(
    (input?.inputs ?? []).map((executionInput) => [
      executionInput.executionId,
      cloneInput(executionInput),
    ]),
  );

  return {
    async get(accountId, projectId, executionId) {
      const stored = inputs.get(executionId);
      return stored?.accountId === accountId && stored.projectId === projectId
        ? cloneInput(stored)
        : null;
    },
    async store(executionInput) {
      const prior = inputs.get(executionInput.executionId);
      if (prior) {
        if (
          prior.accountId !== executionInput.accountId ||
          prior.projectId !== executionInput.projectId ||
          prior.digest !== executionInput.digest ||
          prior.createdAt !== executionInput.createdAt ||
          !sameBytes(prior.payload, executionInput.payload)
        ) {
          throw new Error('MODULE_EXECUTION_INPUT_IMMUTABLE');
        }
        return;
      }
      inputs.set(executionInput.executionId, cloneInput(executionInput));
    },
  };
}
