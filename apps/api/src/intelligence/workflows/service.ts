import type { StudioJobInput } from '@kortix/api-contract';
import type { WorkflowNode, WorkflowRun } from '@kortix/intelligence-contracts';
import {
  type IntelligenceRouteDecision,
  type IntelligenceRoutePolicySnapshot,
  type IntelligenceRouteRequest,
  type WorkflowNodeRef,
  type WorkflowPayloadStore,
  type WorkflowPort,
  canonicalWorkflowHash,
  canonicalWorkflowJson,
  routeIntelligenceCandidates,
} from '@kortix/intelligence-orchestration';
import type { CapabilityRegistryActor } from '../capability-registry';
import type { IntelligenceRouteCandidateSource } from '../routing/candidate-source';
import type { IntelligenceRouteDecisionStore } from '../routing/decision-store';
import type { WorkflowPayloadRepository } from './payload-repository';
import { WorkflowPayloadStoreError } from './payload-store';

export type WorkflowServiceErrorCode =
  | 'WORKFLOW_DEADLINE_EXCEEDED'
  | 'WORKFLOW_PAYLOAD_AUTHORIZATION_REQUIRED'
  | 'WORKFLOW_PAYLOAD_INVALID'
  | 'WORKFLOW_ROUTING_UNAVAILABLE'
  | 'WORKFLOW_ROUTE_CONFLICT'
  | 'WORKFLOW_ROUTE_SCOPE_DENIED'
  | 'WORKFLOW_TERMINAL';

export class WorkflowServiceError extends Error {
  constructor(readonly code: WorkflowServiceErrorCode) {
    super(code);
    this.name = 'WorkflowServiceError';
  }
}

export type WorkflowPayloadReadAuthorization = WorkflowNodeRef & {
  workerId: string;
  now: string;
};

export type WorkflowServiceOptions = {
  port: WorkflowPort;
  payloads: WorkflowPayloadStore;
  now?: () => string;
  authorizePayloadRead?: (input: WorkflowPayloadReadAuthorization) => Promise<boolean>;
  payloadRepository?: WorkflowPayloadRepository;
  routing?: {
    candidateSource: Pick<IntelligenceRouteCandidateSource, 'listImageCandidates'>;
    decisionStore: IntelligenceRouteDecisionStore;
    router?: typeof routeIntelligenceCandidates;
  };
};

export type WorkflowImageRouteInput = WorkflowNodeRef & {
  request: IntelligenceRouteRequest;
  policy: IntelligenceRoutePolicySnapshot;
  actor: CapabilityRegistryActor;
  imageInput: StudioJobInput;
  iamAllowed: boolean;
  agentAllowed: boolean;
  projectPolicy: 'allow' | 'deny';
};

export interface WorkflowService extends WorkflowPort {
  startRunFromRequest(input: { run: WorkflowRun; request: unknown }): Promise<{
    run: WorkflowRun;
    created: boolean;
  }>;
  appendNodeWithPayload(input: {
    accountId: string;
    projectId: string;
    runId: string;
    expectedGraphVersion: number;
    idempotencyKey: string;
    node: WorkflowNode;
    payload: unknown;
  }): Promise<{ node: WorkflowNode; created: boolean; graphVersion: number }>;
  readNodePayload(
    input: WorkflowPayloadReadAuthorization & {
      payloadRef: string;
      expectedHash: string;
    },
  ): Promise<unknown | null>;
  readNodePayloadForExecution(input: WorkflowPayloadReadAuthorization): Promise<unknown | null>;
  routeImageNode(input: WorkflowImageRouteInput): Promise<{
    decision: IntelligenceRouteDecision;
    created: boolean;
  }>;
}

export function createWorkflowService(options: WorkflowServiceOptions): WorkflowService {
  const now = options.now ?? (() => new Date().toISOString());

  const readNodePayload: WorkflowService['readNodePayload'] = async (input) => {
    const run = await options.port.getRun(input);
    if (!run) return null;
    if (!options.authorizePayloadRead) {
      throw new WorkflowServiceError('WORKFLOW_PAYLOAD_AUTHORIZATION_REQUIRED');
    }
    if (!(await options.authorizePayloadRead(input))) {
      throw new WorkflowServiceError('WORKFLOW_PAYLOAD_AUTHORIZATION_REQUIRED');
    }
    let bytes: Uint8Array | null;
    try {
      bytes = await options.payloads.read(input);
    } catch (error) {
      if (error instanceof WorkflowPayloadStoreError) {
        throw new WorkflowServiceError('WORKFLOW_PAYLOAD_INVALID');
      }
      throw error;
    }
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new WorkflowServiceError('WORKFLOW_PAYLOAD_INVALID');
    }
  };

  return {
    ...options.port,

    async startRunFromRequest(input) {
      return options.port.startRun({
        run: { ...input.run, request_hash: canonicalWorkflowHash(input.request) },
      });
    },

    async appendNodeWithPayload(input) {
      const currentRun = await options.port.getRun(input);
      if (currentRun && isTerminal(currentRun.status)) {
        throw new WorkflowServiceError('WORKFLOW_TERMINAL');
      }
      if (
        input.node.deadline_at !== null &&
        Date.parse(input.node.deadline_at) <= Date.parse(now())
      ) {
        throw new WorkflowServiceError('WORKFLOW_DEADLINE_EXCEEDED');
      }

      const content = new TextEncoder().encode(canonicalWorkflowJson(input.payload));
      const contentHash = canonicalWorkflowHash(input.payload);
      const sealed = await options.payloads.seal({
        accountId: input.accountId,
        projectId: input.projectId,
        runId: input.runId,
        nodeKey: input.node.node_key,
        content,
        contentHash,
      });
      const requestHash = canonicalWorkflowHash({
        idempotency_key: input.idempotencyKey,
        node_id: input.node.node_id,
        node_key: input.node.node_key,
        role: input.node.role,
        kind: input.node.kind,
        payload_hash: contentHash,
      });
      try {
        const result = await options.port.appendNode({
          accountId: input.accountId,
          projectId: input.projectId,
          runId: input.runId,
          expectedGraphVersion: input.expectedGraphVersion,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          node: { ...input.node, input_hash: contentHash },
        });
        if (options.payloadRepository) {
          let indexed: Awaited<ReturnType<WorkflowPayloadRepository['putNodeInput']>>;
          try {
            indexed = await options.payloadRepository.putNodeInput({
              accountId: input.accountId,
              projectId: input.projectId,
              runId: input.runId,
              nodeId: result.node.node_id,
              payload: sealed,
              createdAt: now(),
            });
          } catch (error) {
            await cleanupPayload(options.payloads, input, sealed.payloadRef, contentHash);
            throw error;
          }
          if (!indexed.created) {
            await cleanupPayload(options.payloads, input, sealed.payloadRef, contentHash);
          }
        } else if (!result.created) {
          await cleanupPayload(options.payloads, input, sealed.payloadRef, contentHash);
        }
        return result;
      } catch (error) {
        await cleanupPayload(options.payloads, input, sealed.payloadRef, contentHash);
        throw error;
      }
    },

    readNodePayload,

    async readNodePayloadForExecution(input) {
      const indexed = await options.payloadRepository?.getNodeInput(input);
      if (!indexed) return null;
      return readNodePayload({
        ...input,
        payloadRef: indexed.payloadRef,
        expectedHash: indexed.contentHash,
      });
    },

    async routeImageNode(input) {
      const routing = options.routing;
      if (!routing) throw new WorkflowServiceError('WORKFLOW_ROUTING_UNAVAILABLE');
      if (
        input.request.accountId !== input.accountId ||
        input.request.projectId !== input.projectId ||
        input.actor.accountId !== input.accountId ||
        input.request.capabilityId !== 'studio.image.generate' ||
        input.request.capabilityVersion !== '1.0.0'
      ) {
        throw new WorkflowServiceError('WORKFLOW_ROUTE_SCOPE_DENIED');
      }
      const run = await options.port.getRun(input);
      if (!run) throw new WorkflowServiceError('WORKFLOW_ROUTE_SCOPE_DENIED');

      const existing = await routing.decisionStore.get({
        accountId: input.accountId,
        projectId: input.projectId,
        runId: input.runId,
        nodeId: input.nodeId,
      });
      if (existing) {
        if (
          existing.decisionId !== input.request.decisionId ||
          existing.requestHash !== input.request.requestHash ||
          existing.policyVersion !== input.policy.policyVersion ||
          existing.policyHash !== input.policy.policyHash
        ) {
          throw new WorkflowServiceError('WORKFLOW_ROUTE_CONFLICT');
        }
        return { decision: existing, created: false };
      }
      if (isTerminal(run.status)) throw new WorkflowServiceError('WORKFLOW_TERMINAL');

      const candidates = await routing.candidateSource.listImageCandidates({
        accountId: input.accountId,
        projectId: input.projectId,
        actor: input.actor,
        input: input.imageInput,
        iamAllowed: input.iamAllowed,
        agentAllowed: input.agentAllowed,
        projectPolicy: input.projectPolicy,
      });
      const decision = (routing.router ?? routeIntelligenceCandidates)({
        request: input.request,
        policy: input.policy,
        candidates,
      });
      return routing.decisionStore.put({
        accountId: input.accountId,
        projectId: input.projectId,
        runId: input.runId,
        nodeId: input.nodeId,
        decision,
      });
    },
  };
}

function isTerminal(status: WorkflowRun['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

async function cleanupPayload(
  payloads: WorkflowPayloadStore,
  input: { accountId: string; projectId: string; runId: string },
  payloadRef: string,
  expectedHash: string,
): Promise<void> {
  try {
    await payloads.delete({ ...input, payloadRef, expectedHash });
  } catch {
    // Preserve the workflow error; maintenance can remove a bounded orphan later.
  }
}
