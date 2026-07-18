import type {
  WorkflowApproval,
  WorkflowDependency,
  WorkflowEvent,
  WorkflowEventType,
  WorkflowNode,
  WorkflowRun,
} from '@kortix/intelligence-contracts';
import {
  type WorkflowPort,
  assertWorkflowNodeTransition,
  assertWorkflowRunTransition,
  readyWorkflowNodeKeys,
  validateWorkflowGraph,
} from '@kortix/intelligence-orchestration';
import { WorkflowStoreError } from './errors';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryWorkflowStore(): WorkflowPort {
  const runs = new Map<string, WorkflowRun>();
  const runIdsByIdempotency = new Map<string, string>();
  const nodesByRun = new Map<string, Map<string, WorkflowNode>>();
  const nodeIdempotency = new Map<string, { nodeId: string; requestHash: string }>();
  const dependenciesByRun = new Map<string, Map<string, WorkflowDependency>>();
  const approvalsByRun = new Map<string, Map<string, WorkflowApproval>>();
  const eventsByRun = new Map<string, WorkflowEvent[]>();
  const leases = new Map<string, { owner: string; expiresAtMs: number }>();

  function appendEvent(
    run: WorkflowRun,
    type: WorkflowEventType,
    createdAt: string,
    overrides: Partial<
      Pick<
        WorkflowEvent,
        | 'node_id'
        | 'task_id'
        | 'progress'
        | 'reason_code'
        | 'asset_ids'
        | 'route_reason_codes'
        | 'evaluation_version'
      >
    > = {},
  ): WorkflowEvent {
    const events = eventsByRun.get(run.run_id) ?? [];
    const event: WorkflowEvent = {
      protocol_version: 'intelligence.workflow.v1',
      event_id: crypto.randomUUID(),
      run_id: run.run_id,
      sequence: events.length + 1,
      type,
      status: run.status,
      graph_version: run.graph_version,
      node_id: null,
      task_id: null,
      progress: null,
      reason_code: null,
      asset_ids: [],
      route_reason_codes: [],
      evaluation_version: run.evaluation_version,
      created_at: createdAt,
      ...overrides,
    };
    events.push(event);
    eventsByRun.set(run.run_id, events);
    return event;
  }

  function refreshReadyNodes(runId: string, updatedAt: string): WorkflowNode[] {
    const nodes = nodesByRun.get(runId) ?? new Map<string, WorkflowNode>();
    const dependencies = dependenciesByRun.get(runId) ?? new Map<string, WorkflowDependency>();
    const byId = new Map([...nodes.values()].map((node) => [node.node_id, node]));
    const readyKeys = new Set(
      readyWorkflowNodeKeys(
        [...nodes.values()].map((node) => ({ nodeKey: node.node_key, status: node.status })),
        [...dependencies.values()].map((dependency) => {
          const node = byId.get(dependency.node_id);
          const parent = byId.get(dependency.depends_on_node_id);
          if (!node || !parent) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
          return {
            nodeKey: node.node_key,
            dependsOnNodeKey: parent.node_key,
            condition: dependency.condition,
          };
        }),
      ),
    );
    const readied: WorkflowNode[] = [];
    for (const node of nodes.values()) {
      if (readyKeys.has(node.node_key)) {
        node.status = 'ready';
        node.updated_at = updatedAt;
        readied.push(node);
      }
    }
    return readied;
  }

  function nodeDepths(runId: string): Map<string, number> {
    const nodes = nodesByRun.get(runId) ?? new Map<string, WorkflowNode>();
    const dependencies = dependenciesByRun.get(runId) ?? new Map<string, WorkflowDependency>();
    const depths = new Map([...nodes.keys()].map((nodeId) => [nodeId, 1]));
    for (let pass = 0; pass < nodes.size; pass += 1) {
      let changed = false;
      for (const dependency of dependencies.values()) {
        const next = Math.max(
          depths.get(dependency.node_id) ?? 1,
          (depths.get(dependency.depends_on_node_id) ?? 1) + 1,
        );
        if (next !== depths.get(dependency.node_id)) {
          depths.set(dependency.node_id, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return depths;
  }

  return {
    async startRun({ run }) {
      const idempotencyScope = `${run.project_id}\u0000${run.idempotency_key}`;
      const existingRunId = runIdsByIdempotency.get(idempotencyScope);
      const existing = existingRunId ? runs.get(existingRunId) : undefined;
      if (existing) {
        if (
          existing.account_id !== run.account_id ||
          existing.project_id !== run.project_id ||
          existing.request_hash !== run.request_hash
        ) {
          throw new WorkflowStoreError('WORKFLOW_IDEMPOTENCY_MISMATCH');
        }
        return { run: clone(existing), created: false };
      }

      const stored = clone(run);
      runs.set(stored.run_id, stored);
      runIdsByIdempotency.set(idempotencyScope, stored.run_id);
      appendEvent(stored, 'run_created', stored.created_at);
      return { run: clone(stored), created: true };
    },
    async appendNode(input) {
      const run = runs.get(input.runId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        input.node.run_id !== input.runId
      ) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      }

      const idempotencyScope = `${input.runId}\u0000${input.idempotencyKey}`;
      const replay = nodeIdempotency.get(idempotencyScope);
      const nodes = nodesByRun.get(input.runId) ?? new Map<string, WorkflowNode>();
      if (replay) {
        const stored = nodes.get(replay.nodeId);
        if (!stored || replay.requestHash !== input.requestHash) {
          throw new WorkflowStoreError('WORKFLOW_IDEMPOTENCY_MISMATCH');
        }
        return { node: clone(stored), created: false, graphVersion: run.graph_version };
      }
      if (run.graph_version !== input.expectedGraphVersion) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_VERSION_CONFLICT');
      }
      if (
        nodes.has(input.node.node_id) ||
        [...nodes.values()].some((stored) => stored.node_key === input.node.node_key)
      ) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      }

      const stored = clone(input.node);
      nodes.set(stored.node_id, stored);
      nodesByRun.set(input.runId, nodes);
      nodeIdempotency.set(idempotencyScope, {
        nodeId: stored.node_id,
        requestHash: input.requestHash,
      });
      run.graph_version += 1;
      run.updated_at = stored.updated_at;
      appendEvent(run, 'node_appended', stored.created_at, { node_id: stored.node_id });
      return { node: clone(stored), created: true, graphVersion: run.graph_version };
    },
    async addDependency(input) {
      const run = runs.get(input.runId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        input.dependency.run_id !== input.runId
      ) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      }
      const dependencies =
        dependenciesByRun.get(input.runId) ?? new Map<string, WorkflowDependency>();
      const replay = [...dependencies.values()].find(
        (stored) =>
          stored.node_id === input.dependency.node_id &&
          stored.depends_on_node_id === input.dependency.depends_on_node_id,
      );
      if (replay) {
        if (replay.condition !== input.dependency.condition) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        }
        return {
          dependency: clone(replay),
          created: false,
          graphVersion: run.graph_version,
        };
      }
      if (run.graph_version !== input.expectedGraphVersion) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_VERSION_CONFLICT');
      }
      if (dependencies.has(input.dependency.dependency_id)) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      }
      const nodes = nodesByRun.get(input.runId) ?? new Map<string, WorkflowNode>();
      const nodeById = (nodeId: string) => nodes.get(nodeId);
      const prospective = [...dependencies.values(), input.dependency];
      validateWorkflowGraph(
        [...nodes.values()].map((node) => ({ nodeKey: node.node_key })),
        prospective.map((dependency) => {
          const node = nodeById(dependency.node_id);
          const parent = nodeById(dependency.depends_on_node_id);
          if (!node || !parent) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
          return { nodeKey: node.node_key, dependsOnNodeKey: parent.node_key };
        }),
      );

      const stored = clone(input.dependency);
      dependencies.set(stored.dependency_id, stored);
      dependenciesByRun.set(input.runId, dependencies);
      run.graph_version += 1;
      run.updated_at = stored.created_at;
      appendEvent(run, 'dependency_added', stored.created_at, { node_id: stored.node_id });
      return {
        dependency: clone(stored),
        created: true,
        graphVersion: run.graph_version,
      };
    },
    async sealGraph(input) {
      const run = runs.get(input.runId);
      if (!run || run.account_id !== input.accountId || run.project_id !== input.projectId) {
        return null;
      }
      if (run.status !== 'draft') return clone(run);
      if (run.graph_version !== input.expectedGraphVersion) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_VERSION_CONFLICT');
      }
      const nodes = nodesByRun.get(input.runId) ?? new Map<string, WorkflowNode>();
      const dependencies =
        dependenciesByRun.get(input.runId) ?? new Map<string, WorkflowDependency>();
      const byId = new Map([...nodes.values()].map((node) => [node.node_id, node]));
      validateWorkflowGraph(
        [...nodes.values()].map((node) => ({ nodeKey: node.node_key })),
        [...dependencies.values()].map((dependency) => {
          const node = byId.get(dependency.node_id);
          const parent = byId.get(dependency.depends_on_node_id);
          if (!node || !parent) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
          return { nodeKey: node.node_key, dependsOnNodeKey: parent.node_key };
        }),
      );
      run.status = assertWorkflowRunTransition(run.status, 'running');
      run.updated_at = input.updatedAt;
      const readied = refreshReadyNodes(input.runId, input.updatedAt);
      appendEvent(run, 'graph_sealed', input.updatedAt);
      appendEvent(run, 'run_started', input.updatedAt);
      for (const node of readied) {
        appendEvent(run, 'node_ready', input.updatedAt, { node_id: node.node_id });
      }
      return clone(run);
    },
    async claimReadyNode(input) {
      const nowMs = Date.parse(input.now);
      if (
        !Number.isFinite(nowMs) ||
        input.leaseMs < 1_000 ||
        input.leaseMs > 10 * 60 * 1_000 ||
        input.workerId.trim() === ''
      ) {
        throw new WorkflowStoreError('WORKFLOW_LEASE_CONFLICT');
      }
      const candidates: Array<{
        run: WorkflowRun;
        node: WorkflowNode;
        depth: number;
      }> = [];
      for (const run of runs.values()) {
        if (
          run.account_id !== input.accountId ||
          run.project_id !== input.projectId ||
          run.status !== 'running' ||
          (run.deadline_at !== null && Date.parse(run.deadline_at) <= nowMs)
        ) {
          continue;
        }
        const depths = nodeDepths(run.run_id);
        for (const node of nodesByRun.get(run.run_id)?.values() ?? []) {
          const lease = leases.get(node.node_id);
          const claimable =
            node.status === 'ready' ||
            (node.status === 'running' && (!lease || lease.expiresAtMs <= nowMs));
          if (claimable && (node.deadline_at === null || Date.parse(node.deadline_at) > nowMs)) {
            candidates.push({ run, node, depth: depths.get(node.node_id) ?? 1 });
          }
        }
      }
      candidates.sort(
        (left, right) =>
          left.depth - right.depth ||
          left.node.node_key.localeCompare(right.node.node_key) ||
          left.node.node_id.localeCompare(right.node.node_id),
      );
      const selected = candidates[0];
      if (!selected) return null;
      selected.node.status = assertWorkflowNodeTransition(selected.node.status, 'running');
      selected.node.attempt_count += 1;
      selected.node.updated_at = input.now;
      leases.set(selected.node.node_id, {
        owner: input.workerId,
        expiresAtMs: nowMs + input.leaseMs,
      });
      appendEvent(selected.run, 'node_started', input.now, {
        node_id: selected.node.node_id,
        task_id: selected.node.task_id,
        evaluation_version: selected.node.evaluation_version,
      });
      return { run: clone(selected.run), node: clone(selected.node) };
    },
    async heartbeatNode(input) {
      const nowMs = Date.parse(input.now);
      if (
        !Number.isFinite(nowMs) ||
        input.leaseMs < 1_000 ||
        input.leaseMs > 10 * 60 * 1_000 ||
        input.workerId.trim() === ''
      ) {
        throw new WorkflowStoreError('WORKFLOW_LEASE_CONFLICT');
      }
      const run = runs.get(input.runId);
      const node = nodesByRun.get(input.runId)?.get(input.nodeId);
      const lease = leases.get(input.nodeId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        run.status !== 'running' ||
        !node ||
        node.status !== 'running' ||
        !lease ||
        lease.owner !== input.workerId ||
        lease.expiresAtMs <= nowMs
      ) {
        return false;
      }
      lease.expiresAtMs = nowMs + input.leaseMs;
      node.updated_at = input.now;
      return true;
    },
    async attachTask(input) {
      const run = runs.get(input.runId);
      const node = nodesByRun.get(input.runId)?.get(input.nodeId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        !node
      ) {
        return null;
      }
      if (node.task_id === input.taskId) return clone(node);
      if (node.task_id !== null) {
        throw new WorkflowStoreError('WORKFLOW_TASK_ATTACHMENT_CONFLICT');
      }
      const nowMs = Date.parse(input.updatedAt);
      const lease = leases.get(input.nodeId);
      if (
        node.kind !== 'capability' ||
        node.status !== 'running' ||
        !lease ||
        lease.owner !== input.workerId ||
        !Number.isFinite(nowMs) ||
        lease.expiresAtMs <= nowMs
      ) {
        return null;
      }
      for (const storedNodes of nodesByRun.values()) {
        if ([...storedNodes.values()].some((stored) => stored.task_id === input.taskId)) {
          throw new WorkflowStoreError('WORKFLOW_TASK_ATTACHMENT_CONFLICT');
        }
      }
      node.task_id = input.taskId;
      node.updated_at = input.updatedAt;
      appendEvent(run, 'task_attached', input.updatedAt, {
        node_id: node.node_id,
        task_id: input.taskId,
        evaluation_version: node.evaluation_version,
      });
      return clone(node);
    },
    async completeNode(input) {
      const run = runs.get(input.runId);
      const node = nodesByRun.get(input.runId)?.get(input.nodeId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        !node
      ) {
        return null;
      }
      if (node.status === 'succeeded') {
        return { run: clone(run), node: clone(node) };
      }
      const completedAtMs = Date.parse(input.completedAt);
      const lease = leases.get(input.nodeId);
      if (
        node.status !== 'running' ||
        !lease ||
        lease.owner !== input.workerId ||
        !Number.isFinite(completedAtMs) ||
        lease.expiresAtMs <= completedAtMs
      ) {
        return null;
      }
      node.status = assertWorkflowNodeTransition(node.status, 'succeeded');
      node.evaluation_version = input.evaluationVersion;
      node.updated_at = input.completedAt;
      node.terminal_at = input.completedAt;
      leases.delete(input.nodeId);
      run.updated_at = input.completedAt;
      appendEvent(run, 'node_succeeded', input.completedAt, {
        node_id: node.node_id,
        task_id: node.task_id,
        asset_ids: input.assetIds,
        evaluation_version: input.evaluationVersion,
      });
      const readied = refreshReadyNodes(input.runId, input.completedAt);
      for (const readyNode of readied) {
        appendEvent(run, 'node_ready', input.completedAt, { node_id: readyNode.node_id });
      }
      const nodes = [...(nodesByRun.get(input.runId)?.values() ?? [])];
      if (
        nodes.length > 0 &&
        nodes.every((stored) => ['succeeded', 'skipped'].includes(stored.status))
      ) {
        run.status = assertWorkflowRunTransition(run.status, 'succeeded');
        run.terminal_at = input.completedAt;
        appendEvent(run, 'run_succeeded', input.completedAt);
      }
      return { run: clone(run), node: clone(node) };
    },
    async failNode(input) {
      const run = runs.get(input.runId);
      const node = nodesByRun.get(input.runId)?.get(input.nodeId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        !node
      ) {
        return null;
      }
      if (node.status === 'failed') return { run: clone(run), node: clone(node) };
      const failedAtMs = Date.parse(input.failedAt);
      const lease = leases.get(input.nodeId);
      if (
        node.status !== 'running' ||
        !lease ||
        lease.owner !== input.workerId ||
        !Number.isFinite(failedAtMs) ||
        lease.expiresAtMs <= failedAtMs
      ) {
        return null;
      }
      leases.delete(input.nodeId);
      node.updated_at = input.failedAt;
      run.updated_at = input.failedAt;
      if (input.retryable) {
        node.status = assertWorkflowNodeTransition(node.status, 'ready');
        node.terminal_at = null;
        appendEvent(run, 'node_failed', input.failedAt, {
          node_id: node.node_id,
          task_id: node.task_id,
          reason_code: input.reasonCode,
          evaluation_version: node.evaluation_version,
        });
        appendEvent(run, 'node_ready', input.failedAt, { node_id: node.node_id });
      } else {
        node.status = assertWorkflowNodeTransition(node.status, 'failed');
        node.terminal_at = input.failedAt;
        run.status = assertWorkflowRunTransition(run.status, 'failed');
        run.terminal_at = input.failedAt;
        appendEvent(run, 'node_failed', input.failedAt, {
          node_id: node.node_id,
          task_id: node.task_id,
          reason_code: input.reasonCode,
          evaluation_version: node.evaluation_version,
        });
        appendEvent(run, 'run_failed', input.failedAt, { reason_code: input.reasonCode });
      }
      return { run: clone(run), node: clone(node) };
    },
    async pauseForApproval(input) {
      const run = runs.get(input.runId);
      const node = nodesByRun.get(input.runId)?.get(input.nodeId);
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        !node
      ) {
        return null;
      }
      const approvals = approvalsByRun.get(input.runId) ?? new Map<string, WorkflowApproval>();
      const existing = approvals.get(input.approval.approval_id);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(input.approval)) {
          throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        }
        return { run: clone(run), node: clone(node), approval: clone(existing) };
      }
      if (
        input.approval.run_id !== input.runId ||
        input.approval.node_id !== input.nodeId ||
        input.approval.status !== 'pending' ||
        [...approvals.values()].some(
          (approval) => approval.node_id === input.nodeId && approval.status === 'pending',
        )
      ) {
        throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
      }
      const requestedAtMs = Date.parse(input.approval.requested_at);
      const lease = leases.get(input.nodeId);
      if (
        run.status !== 'running' ||
        node.status !== 'running' ||
        !lease ||
        lease.owner !== input.workerId ||
        !Number.isFinite(requestedAtMs) ||
        lease.expiresAtMs <= requestedAtMs
      ) {
        return null;
      }
      run.status = assertWorkflowRunTransition(run.status, 'waiting_approval');
      run.updated_at = input.approval.requested_at;
      node.status = assertWorkflowNodeTransition(node.status, 'waiting_approval');
      node.updated_at = input.approval.requested_at;
      leases.delete(input.nodeId);
      const stored = clone(input.approval);
      approvals.set(stored.approval_id, stored);
      approvalsByRun.set(input.runId, approvals);
      appendEvent(run, 'node_waiting_approval', stored.requested_at, {
        node_id: node.node_id,
        task_id: node.task_id,
        reason_code: stored.reason_code,
        evaluation_version: node.evaluation_version,
      });
      return { run: clone(run), node: clone(node), approval: clone(stored) };
    },
    async resolveApproval(input) {
      const run = runs.get(input.runId);
      const nodeApproval = approvalsByRun.get(input.runId)?.get(input.approvalId);
      const node = nodeApproval
        ? nodesByRun.get(input.runId)?.get(nodeApproval.node_id)
        : undefined;
      if (
        !run ||
        run.account_id !== input.accountId ||
        run.project_id !== input.projectId ||
        !nodeApproval ||
        !node
      ) {
        return null;
      }
      const expectedStatus = input.decision === 'approve' ? 'approved' : 'rejected';
      if (nodeApproval.status !== 'pending') {
        if (
          nodeApproval.status !== expectedStatus ||
          nodeApproval.acting_user_id !== input.actingUserId ||
          nodeApproval.decision !== input.decision ||
          nodeApproval.feedback_hash !== input.feedbackHash ||
          nodeApproval.resolved_at !== input.resolvedAt
        ) {
          throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        }
        return { run: clone(run), node: clone(node), approval: clone(nodeApproval) };
      }
      if (
        run.status !== 'waiting_approval' ||
        node.status !== 'waiting_approval' ||
        !Number.isFinite(Date.parse(input.resolvedAt))
      ) {
        throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
      }
      nodeApproval.status = expectedStatus;
      nodeApproval.acting_user_id = input.actingUserId;
      nodeApproval.decision = input.decision;
      nodeApproval.feedback_hash = input.feedbackHash;
      nodeApproval.resolved_at = input.resolvedAt;
      node.updated_at = input.resolvedAt;
      run.updated_at = input.resolvedAt;
      if (input.decision === 'approve') {
        node.status = assertWorkflowNodeTransition(node.status, 'running');
      } else {
        node.status = assertWorkflowNodeTransition(node.status, 'failed');
        node.terminal_at = input.resolvedAt;
        run.status = assertWorkflowRunTransition(run.status, 'failed');
        run.terminal_at = input.resolvedAt;
      }
      appendEvent(run, 'approval_resolved', input.resolvedAt, {
        node_id: node.node_id,
        task_id: node.task_id,
        reason_code: nodeApproval.reason_code,
        evaluation_version: node.evaluation_version,
      });
      if (input.decision !== 'approve') {
        appendEvent(run, 'node_failed', input.resolvedAt, {
          node_id: node.node_id,
          task_id: node.task_id,
          reason_code: nodeApproval.reason_code,
          evaluation_version: node.evaluation_version,
        });
        appendEvent(run, 'run_failed', input.resolvedAt, {
          reason_code: nodeApproval.reason_code,
        });
      }
      return { run: clone(run), node: clone(node), approval: clone(nodeApproval) };
    },
    async resumeRun(input) {
      const run = runs.get(input.runId);
      if (!run || run.account_id !== input.accountId || run.project_id !== input.projectId) {
        return null;
      }
      if (run.status === 'running' || ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
        return clone(run);
      }
      const hasPendingApproval = [...(approvalsByRun.get(input.runId)?.values() ?? [])].some(
        (approval) => approval.status === 'pending',
      );
      if (run.status !== 'waiting_approval' || hasPendingApproval) {
        throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
      }
      run.status = assertWorkflowRunTransition(run.status, 'running');
      run.updated_at = input.updatedAt;
      appendEvent(run, 'run_started', input.updatedAt);
      return clone(run);
    },
    async cancelRun(input) {
      const run = runs.get(input.runId);
      if (!run || run.account_id !== input.accountId || run.project_id !== input.projectId) {
        return null;
      }
      if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return clone(run);
      if (!Number.isFinite(Date.parse(input.cancelledAt))) {
        throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      }
      run.status = assertWorkflowRunTransition(run.status, 'cancelled');
      run.updated_at = input.cancelledAt;
      run.terminal_at = input.cancelledAt;
      for (const node of nodesByRun.get(input.runId)?.values() ?? []) {
        if (!['succeeded', 'failed', 'skipped', 'cancelled'].includes(node.status)) {
          node.status = assertWorkflowNodeTransition(node.status, 'cancelled');
          node.updated_at = input.cancelledAt;
          node.terminal_at = input.cancelledAt;
        }
        leases.delete(node.node_id);
      }
      for (const approval of approvalsByRun.get(input.runId)?.values() ?? []) {
        if (approval.status === 'pending') {
          approval.status = 'cancelled';
          approval.resolved_at = input.cancelledAt;
        }
      }
      appendEvent(run, 'run_cancelled', input.cancelledAt, {
        reason_code: input.reasonCode,
      });
      return clone(run);
    },
    async getRun(input) {
      const run = runs.get(input.runId);
      if (!run || run.account_id !== input.accountId || run.project_id !== input.projectId) {
        return null;
      }
      return clone(run);
    },
    async readEvents(input) {
      if (
        !Number.isSafeInteger(input.afterSequence) ||
        input.afterSequence < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      ) {
        throw new WorkflowStoreError('WORKFLOW_EVENT_CURSOR_CONFLICT');
      }
      const run = runs.get(input.runId);
      if (!run || run.account_id !== input.accountId || run.project_id !== input.projectId) {
        return { items: [], nextCursor: null };
      }
      const remaining = (eventsByRun.get(input.runId) ?? []).filter(
        (event) => event.sequence > input.afterSequence,
      );
      const items = remaining.slice(0, input.limit);
      return {
        items: clone(items),
        nextCursor:
          remaining.length > input.limit && items.length > 0
            ? String(items[items.length - 1]?.sequence)
            : null,
      };
    },
  };
}
