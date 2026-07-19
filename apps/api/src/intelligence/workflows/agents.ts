import type {
  IntelligenceCreateTaskRequest,
  IntelligenceExecutionTarget,
} from '@kortix/api-contract';
import { IntelligenceCreateTaskRequestSchema } from '@kortix/api-contract';
import { type AgentCard, AgentCardSchema } from '@kortix/intelligence-contracts';
import type { WorkflowNode } from '@kortix/intelligence-contracts';
import type { LoadedAgents } from '../../projects/agents';

export type WorkflowAgentRole = 'planner' | 'executor' | 'reviewer';

export type WorkflowAgentBinding = {
  role: WorkflowAgentRole;
  agentName: string;
  cardHash: string;
};

export type InstalledWorkflowAgent = {
  name: string;
  enabled: boolean;
  card: AgentCard;
};

export type WorkflowAgentRegistry = ReturnType<typeof createWorkflowAgentRegistry>;

export function createProjectWorkflowAgentList(input: {
  loadProjectAgents(scope: { accountId: string; projectId: string }): Promise<LoadedAgents>;
  loadAgentCard(scope: {
    accountId: string;
    projectId: string;
    agentName: string;
  }): Promise<AgentCard>;
}) {
  return async (scope: {
    accountId: string;
    projectId: string;
  }): Promise<readonly InstalledWorkflowAgent[]> => {
    const loaded = await input.loadProjectAgents(scope);
    if (loaded.errors.length > 0) {
      throw new WorkflowAgentError('WORKFLOW_AGENT_UNAVAILABLE');
    }
    return Promise.all(
      loaded.specs
        .filter((spec) => spec.enabled)
        .map(async (spec) => ({
          name: spec.name,
          enabled: true,
          card: await input.loadAgentCard({ ...scope, agentName: spec.name }),
        })),
    );
  };
}

export type WorkflowAgentSessionInput = {
  accountId: string;
  projectId: string;
  role: WorkflowAgentRole;
  agentName: string;
  card: AgentCard;
  context: unknown;
  signal: AbortSignal;
};

export class WorkflowAgentError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_AGENT_BINDING_INVALID'
      | 'WORKFLOW_AGENT_ROLE_MISMATCH'
      | 'WORKFLOW_AGENT_UNAVAILABLE'
      | 'WORKFLOW_AGENT_CANCELLED'
      | 'WORKFLOW_AGENT_TIMEOUT',
  ) {
    super(code);
    this.name = 'WorkflowAgentError';
  }
}

export function createWorkflowAgentInvoker(input: {
  registry: WorkflowAgentRegistry;
  invokeSession(command: WorkflowAgentSessionInput): Promise<unknown>;
}) {
  return {
    async invoke(command: {
      accountId: string;
      projectId: string;
      expectedRole: WorkflowAgentRole;
      binding: WorkflowAgentBinding;
      context: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<unknown> {
      if (command.signal?.aborted) {
        throw new WorkflowAgentError('WORKFLOW_AGENT_CANCELLED');
      }
      const resolved = await input.registry.resolve(command);
      if (command.signal?.aborted) {
        throw new WorkflowAgentError('WORKFLOW_AGENT_CANCELLED');
      }
      const sessionController = new AbortController();
      const maximumTimeoutMs = resolved.card.limits.max_task_seconds * 1_000;
      const timeoutMs = Math.max(
        1,
        Math.min(command.timeoutMs ?? maximumTimeoutMs, maximumTimeoutMs),
      );
      let timedOut = false;
      let rejectInterruption: (reason?: unknown) => void = () => {};
      const interruption = new Promise<never>((_resolve, reject) => {
        rejectInterruption = reject;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        sessionController.abort();
        rejectInterruption(new Error('interrupted'));
      }, timeoutMs);
      const cancelSession = () => {
        sessionController.abort();
        rejectInterruption(new Error('interrupted'));
      };
      command.signal?.addEventListener('abort', cancelSession, { once: true });
      try {
        return await Promise.race([
          input.invokeSession({
            accountId: command.accountId,
            projectId: command.projectId,
            role: resolved.role,
            agentName: resolved.agentName,
            card: resolved.card,
            context: command.context,
            signal: sessionController.signal,
          }),
          interruption,
        ]);
      } catch {
        if (command.signal?.aborted) {
          throw new WorkflowAgentError('WORKFLOW_AGENT_CANCELLED');
        }
        if (timedOut) {
          throw new WorkflowAgentError('WORKFLOW_AGENT_TIMEOUT');
        }
        throw new WorkflowAgentError('WORKFLOW_AGENT_UNAVAILABLE');
      } finally {
        clearTimeout(timeout);
        command.signal?.removeEventListener('abort', cancelSession);
      }
    },
  };
}

export function createWorkflowAgentRegistry(input: {
  listInstalled(scope: {
    accountId: string;
    projectId: string;
  }): Promise<readonly InstalledWorkflowAgent[]>;
}) {
  return {
    async resolve(command: {
      accountId: string;
      projectId: string;
      expectedRole: WorkflowAgentRole;
      binding: WorkflowAgentBinding;
    }) {
      if (command.binding.role !== command.expectedRole) {
        throw new WorkflowAgentError('WORKFLOW_AGENT_ROLE_MISMATCH');
      }
      let installed: readonly InstalledWorkflowAgent[];
      try {
        installed = await input.listInstalled({
          accountId: command.accountId,
          projectId: command.projectId,
        });
      } catch {
        throw new WorkflowAgentError('WORKFLOW_AGENT_UNAVAILABLE');
      }
      const candidate = installed.find(
        (agent) => agent.name === command.binding.agentName && agent.enabled,
      );
      const parsed = AgentCardSchema.safeParse(candidate?.card);
      if (
        !candidate ||
        !parsed.success ||
        parsed.data.id !== candidate.name ||
        parsed.data.id !== command.binding.agentName ||
        parsed.data.card_hash !== command.binding.cardHash
      ) {
        throw new WorkflowAgentError('WORKFLOW_AGENT_BINDING_INVALID');
      }
      return {
        role: command.expectedRole,
        agentName: candidate.name,
        card: parsed.data,
      };
    },
  };
}

export interface WorkflowExecutorPort {
  resolve(command: {
    accountId: string;
    projectId: string;
    binding: WorkflowAgentBinding;
    node: WorkflowNode;
    context: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<IntelligenceCreateTaskRequest>;
}

export class WorkflowExecutorError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_EXECUTOR_INPUT_INVALID'
      | 'WORKFLOW_EXECUTOR_TARGET_UNAVAILABLE'
      | 'WORKFLOW_EXECUTOR_AUTHORIZATION_DENIED',
  ) {
    super(code);
    this.name = 'WorkflowExecutorError';
  }
}

export function createWorkflowExecutor(input: {
  invokeAgent: {
    invoke(command: {
      accountId: string;
      projectId: string;
      expectedRole: 'executor';
      binding: WorkflowAgentBinding;
      context: unknown;
      signal?: AbortSignal;
      timeoutMs?: number;
    }): Promise<unknown>;
  };
  listExecutionTargets(scope: {
    accountId: string;
    projectId: string;
    capabilityId: 'studio.image.generate';
  }): Promise<readonly IntelligenceExecutionTarget[]>;
  authorizeRequest(command: {
    accountId: string;
    projectId: string;
    node: WorkflowNode;
    request: IntelligenceCreateTaskRequest;
  }): Promise<boolean>;
}): WorkflowExecutorPort {
  return {
    async resolve(command) {
      if (!validExecutorCommand(command) || !boundedJson(command.context, 1024 * 1024)) {
        throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INPUT_INVALID');
      }
      const output = await input.invokeAgent.invoke({
        accountId: command.accountId,
        projectId: command.projectId,
        expectedRole: 'executor',
        binding: command.binding,
        context: command.context,
        signal: command.signal,
        timeoutMs: command.timeoutMs,
      });
      const request = parseExecutorRequest(output);
      if (
        request.capability_id !== command.node.capability_id ||
        request.agent_card_hash !== command.binding.cardHash
      ) {
        throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INPUT_INVALID');
      }
      let targets: readonly IntelligenceExecutionTarget[];
      try {
        targets = await input.listExecutionTargets({
          accountId: command.accountId,
          projectId: command.projectId,
          capabilityId: 'studio.image.generate',
        });
      } catch {
        throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_TARGET_UNAVAILABLE');
      }
      if (
        !targets.some(
          (target) =>
            target.capability_id === request.capability_id &&
            target.provider_config_id === request.provider_config_id &&
            target.model === request.model,
        )
      ) {
        throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_TARGET_UNAVAILABLE');
      }
      let authorized = false;
      try {
        authorized = await input.authorizeRequest({
          accountId: command.accountId,
          projectId: command.projectId,
          node: command.node,
          request,
        });
      } catch {
        authorized = false;
      }
      if (!authorized) {
        throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_AUTHORIZATION_DENIED');
      }
      return request;
    },
  };
}

function validExecutorCommand(command: {
  binding: WorkflowAgentBinding;
  node: WorkflowNode;
}): boolean {
  return (
    command.binding.role === 'executor' &&
    command.node.role === 'executor' &&
    command.node.kind === 'capability' &&
    command.node.capability_id === 'studio.image.generate' &&
    command.node.capability_version === '1.0.0' &&
    command.node.agent_name === command.binding.agentName &&
    command.node.agent_card_hash === command.binding.cardHash
  );
}

function parseExecutorRequest(output: unknown): IntelligenceCreateTaskRequest {
  let value = output;
  if (typeof output === 'string') {
    if (output.length > 1024 * 1024) {
      throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INPUT_INVALID');
    }
    try {
      value = JSON.parse(output);
    } catch {
      throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INPUT_INVALID');
    }
  }
  const parsed = IntelligenceCreateTaskRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new WorkflowExecutorError('WORKFLOW_EXECUTOR_INPUT_INVALID');
  }
  return parsed.data;
}

function boundedJson(value: unknown, maxBytes: number): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes;
  } catch {
    return false;
  }
}
