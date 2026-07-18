import type {
  WorkflowApproval,
  WorkflowDependency,
  WorkflowEvent,
  WorkflowNode,
  WorkflowRun,
} from '@kortix/intelligence-contracts';

export type WorkflowScope = {
  accountId: string;
  projectId: string;
};

export type WorkflowRunRef = WorkflowScope & {
  runId: string;
};

export type WorkflowNodeRef = WorkflowRunRef & {
  nodeId: string;
};

export interface WorkflowPort {
  startRun(input: { run: WorkflowRun }): Promise<{ run: WorkflowRun; created: boolean }>;
  appendNode(
    input: WorkflowRunRef & {
      expectedGraphVersion: number;
      idempotencyKey: string;
      requestHash: string;
      node: WorkflowNode;
    },
  ): Promise<{ node: WorkflowNode; created: boolean; graphVersion: number }>;
  addDependency(
    input: WorkflowRunRef & {
      expectedGraphVersion: number;
      dependency: WorkflowDependency;
    },
  ): Promise<{ dependency: WorkflowDependency; created: boolean; graphVersion: number }>;
  sealGraph(
    input: WorkflowRunRef & { expectedGraphVersion: number; updatedAt: string },
  ): Promise<WorkflowRun | null>;
  claimReadyNode(
    input: WorkflowScope & {
      workerId: string;
      now: string;
      leaseMs: number;
    },
  ): Promise<{ run: WorkflowRun; node: WorkflowNode } | null>;
  heartbeatNode(
    input: WorkflowNodeRef & { workerId: string; now: string; leaseMs: number },
  ): Promise<boolean>;
  attachTask(
    input: WorkflowNodeRef & { workerId: string; taskId: string; updatedAt: string },
  ): Promise<WorkflowNode | null>;
  completeNode(
    input: WorkflowNodeRef & {
      workerId: string;
      assetIds: string[];
      evaluationVersion: string | null;
      completedAt: string;
    },
  ): Promise<{ run: WorkflowRun; node: WorkflowNode } | null>;
  failNode(
    input: WorkflowNodeRef & {
      workerId: string;
      reasonCode: string;
      retryable: boolean;
      failedAt: string;
    },
  ): Promise<{ run: WorkflowRun; node: WorkflowNode } | null>;
  pauseForApproval(
    input: WorkflowNodeRef & { workerId: string; approval: WorkflowApproval },
  ): Promise<{ run: WorkflowRun; node: WorkflowNode; approval: WorkflowApproval } | null>;
  resolveApproval(
    input: WorkflowRunRef & {
      approvalId: string;
      actingUserId: string;
      decision: 'approve' | 'reject' | 'changes_requested';
      feedbackHash: string | null;
      resolvedAt: string;
    },
  ): Promise<{ run: WorkflowRun; node: WorkflowNode; approval: WorkflowApproval } | null>;
  resumeRun(input: WorkflowRunRef & { updatedAt: string }): Promise<WorkflowRun | null>;
  cancelRun(
    input: WorkflowRunRef & { reasonCode: string; cancelledAt: string },
  ): Promise<WorkflowRun | null>;
  getRun(input: WorkflowRunRef): Promise<WorkflowRun | null>;
  readEvents(
    input: WorkflowRunRef & { afterSequence: number; limit: number },
  ): Promise<{ items: WorkflowEvent[]; nextCursor: string | null }>;
}

export const WORKFLOW_PORT_METHODS = [
  'startRun',
  'appendNode',
  'addDependency',
  'sealGraph',
  'claimReadyNode',
  'heartbeatNode',
  'attachTask',
  'completeNode',
  'failNode',
  'pauseForApproval',
  'resolveApproval',
  'resumeRun',
  'cancelRun',
  'getRun',
  'readEvents',
] as const satisfies readonly (keyof WorkflowPort)[];

export type SealedWorkflowPayload = {
  payloadRef: string;
  contentHash: string;
  byteLength: number;
  contentType: 'application/json';
};

export interface WorkflowPayloadStore {
  seal(
    input: WorkflowRunRef & {
      nodeKey: string;
      content: Uint8Array;
      contentHash: string;
    },
  ): Promise<SealedWorkflowPayload>;
  read(
    input: WorkflowNodeRef & { payloadRef: string; expectedHash: string },
  ): Promise<Uint8Array | null>;
  delete(input: WorkflowRunRef & { payloadRef: string; expectedHash: string }): Promise<void>;
}

export type WorkflowRouteCandidate = {
  candidateId: string;
  capabilityId: 'studio.image.generate';
  capabilityVersion: '1.0.0';
  providerConfigId: string;
  model: string;
  evaluationVersion: string | null;
};

export interface WorkflowRouteSource {
  listCandidates(
    input: WorkflowScope & { capabilityId: 'studio.image.generate' },
  ): Promise<WorkflowRouteCandidate[]>;
}

export type WorkflowEvaluationSnapshot = {
  evaluationVersion: string;
  capabilityId: 'studio.image.generate';
  model: string;
  sampleCount: number;
  qualityScore: number;
  availabilityScore: number;
  latencyScore: number;
  costScore: number;
};

export interface WorkflowEvaluationSource {
  getPublishedSnapshot(input: {
    evaluationVersion: string;
    capabilityId: 'studio.image.generate';
    model: string;
  }): Promise<WorkflowEvaluationSnapshot | null>;
}
