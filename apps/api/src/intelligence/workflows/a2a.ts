import {
  type IntelligenceA2ATaskState,
  IntelligenceWorkflowA2AMessageSendRequestSchema,
  type IntelligenceWorkflowA2ATaskResponse,
  IntelligenceWorkflowA2ATaskResponseSchema,
  type IntelligenceWorkflowStartRequest,
} from '@kortix/api-contract';
import type { WorkflowRun, WorkflowRunStatus } from '@kortix/intelligence-contracts';
import { A2AProtocolError } from '../a2a';

type A2AWorkflowResult = {
  run: WorkflowRun;
  created: boolean;
  parentTaskId: string | null;
};

type A2AWorkflowTrustInput = {
  accountId: string;
  projectId: string;
  agentName: string;
  actingTokenId: string;
  senderCardHash: string;
};

export interface A2AWorkflowService {
  isAgentCardTrusted(input: A2AWorkflowTrustInput): Promise<boolean>;
  replay?(input: A2AWorkflowStartCommand): Promise<A2AWorkflowResult | null>;
  start(input: A2AWorkflowStartCommand): Promise<A2AWorkflowResult>;
  get(input: A2AWorkflowStatusCommand): Promise<{
    run: WorkflowRun;
    parentTaskId: string | null;
  } | null>;
}

type A2AWorkflowActor = {
  accountId: string;
  projectId: string;
  actorUserId: string;
  actorType: 'user' | 'agent' | 'system';
  actingTokenId: string | null;
  agentName: string | null;
};

export type A2AWorkflowStartCommand = A2AWorkflowActor & {
  request: IntelligenceWorkflowStartRequest;
  parentTaskId: string | null;
  senderCardHash: string;
};

export type A2AWorkflowStatusCommand = A2AWorkflowActor & {
  runId: string;
  senderCardHash: string;
};

export function parseA2AWorkflowRequest(body: unknown): {
  request: IntelligenceWorkflowStartRequest;
  parentTaskId: string | null;
  senderCardHash: string;
} {
  const envelope = IntelligenceWorkflowA2AMessageSendRequestSchema.safeParse(body);
  if (!envelope.success) throw new A2AProtocolError('A2A_INVALID_REQUEST', 400);
  const { parent_task_id: parentTaskId, ...request } = envelope.data.params.task;
  if (request.deadline_at !== null && Date.parse(request.deadline_at) <= Date.now()) {
    throw new A2AProtocolError('A2A_DEADLINE_EXPIRED', 409);
  }
  return {
    request,
    parentTaskId,
    senderCardHash: envelope.data.params.sender_card_hash,
  };
}

export function createA2AWorkflowAdapter(service: A2AWorkflowService) {
  return {
    async start(input: A2AWorkflowActor & { body: unknown }): Promise<IntelligenceWorkflowA2ATaskResponse> {
      const parsed = parseA2AWorkflowRequest(input.body);
      await assertTrustedAgent(service, input, parsed.senderCardHash);
      const command: A2AWorkflowStartCommand = {
        ...input,
        request: parsed.request,
        parentTaskId: parsed.parentTaskId,
        senderCardHash: parsed.senderCardHash,
      };
      if (service.replay) {
        const replay = await service.replay(command);
        if (replay) {
          assertRunScope(replay.run, command);
          return workflowResponse(replay.run, replay.parentTaskId);
        }
      }
      const result = await service.start(command);
      assertRunScope(result.run, command);
      return workflowResponse(result.run, result.parentTaskId);
    },

    async status(input: A2AWorkflowStatusCommand): Promise<IntelligenceWorkflowA2ATaskResponse | null> {
      await assertTrustedAgent(service, input, input.senderCardHash);
      const result = await service.get(input);
      if (!result) return null;
      assertRunScope(result.run, input, input.runId);
      return workflowResponse(result.run, result.parentTaskId);
    },
  };
}

export function mapA2AWorkflowState(status: WorkflowRunStatus): IntelligenceA2ATaskState {
  switch (status) {
    case 'running':
      return 'working';
    case 'waiting_approval':
      return 'input-required';
    case 'succeeded':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'submitted';
  }
}

async function assertTrustedAgent(
  service: Pick<A2AWorkflowService, 'isAgentCardTrusted'>,
  actor: A2AWorkflowActor,
  senderCardHash: string,
): Promise<void> {
  if (actor.actorType !== 'agent' || !actor.agentName || !actor.actingTokenId) {
    throw new A2AProtocolError('A2A_AGENT_UNTRUSTED', 403);
  }
  try {
    const trusted = await service.isAgentCardTrusted({
      accountId: actor.accountId,
      projectId: actor.projectId,
      agentName: actor.agentName,
      actingTokenId: actor.actingTokenId,
      senderCardHash,
    });
    if (!trusted) throw new A2AProtocolError('A2A_AGENT_UNTRUSTED', 403);
  } catch (error) {
    if (error instanceof A2AProtocolError) throw error;
    throw new A2AProtocolError('A2A_AGENT_UNTRUSTED', 403);
  }
}

function assertRunScope(
  run: WorkflowRun,
  scope: Pick<A2AWorkflowActor, 'accountId' | 'projectId'>,
  runId?: string,
): void {
  if (
    run.account_id !== scope.accountId ||
    run.project_id !== scope.projectId ||
    (runId !== undefined && run.run_id !== runId)
  ) {
    throw new A2AProtocolError('A2A_INVALID_REQUEST', 400);
  }
}

function workflowResponse(
  run: WorkflowRun,
  parentTaskId: string | null,
): IntelligenceWorkflowA2ATaskResponse {
  return IntelligenceWorkflowA2ATaskResponseSchema.parse({
    id: run.run_id,
    contextId: run.run_id,
    status: { state: mapA2AWorkflowState(run.status), timestamp: run.updated_at },
    metadata: { parent_task_id: parentTaskId, graph_version: run.graph_version },
  });
}
