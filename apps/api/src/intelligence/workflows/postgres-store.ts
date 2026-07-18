import {
  type Database,
  intelligenceTasks,
  intelligenceWorkflowApprovals,
  intelligenceWorkflowDependencies,
  intelligenceWorkflowEvents,
  intelligenceWorkflowNodes,
  intelligenceWorkflowRuns,
} from '@kortix/db';
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
import { and, asc, eq, gt, isNull, max, or, sql } from 'drizzle-orm';
import { WorkflowStoreError } from './errors';

type RunRow = typeof intelligenceWorkflowRuns.$inferSelect;
type NodeRow = typeof intelligenceWorkflowNodes.$inferSelect;
type DependencyRow = typeof intelligenceWorkflowDependencies.$inferSelect;
type ApprovalRow = typeof intelligenceWorkflowApprovals.$inferSelect;
type EventRow = typeof intelligenceWorkflowEvents.$inferSelect;
type WorkflowTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function toTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function toNullableTimestamp(value: string | null): string | null {
  return value === null ? null : toTimestamp(value);
}

async function runWorkflowTransaction<T>(
  database: Database,
  operation: (transaction: WorkflowTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await database.transaction(operation);
  } finally {
    // Under Bun, postgres.js can settle BEGIN before the socket delivers ReadyForQuery.
    // Yield once so a back-to-back transaction cannot strand its BEGIN on the same connection.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function toRun(row: RunRow): WorkflowRun {
  return {
    protocol_version: row.protocolVersion as WorkflowRun['protocol_version'],
    run_id: row.runId,
    account_id: row.accountId,
    project_id: row.projectId,
    actor_type: row.actorType as WorkflowRun['actor_type'],
    actor_id: row.actorId,
    agent_name: row.agentName,
    idempotency_key: row.idempotencyKey,
    request_hash: row.requestHash,
    status: row.status as WorkflowRun['status'],
    graph_version: row.graphVersion,
    policy_snapshot_hash: row.policySnapshotHash,
    evaluation_version: row.evaluationVersion,
    max_nodes: row.maxNodes,
    max_dependencies: row.maxDependencies,
    max_approved_credits: Number(row.maxApprovedCredits),
    deadline_at: toNullableTimestamp(row.deadlineAt),
    created_at: toTimestamp(row.createdAt),
    updated_at: toTimestamp(row.updatedAt),
    terminal_at: toNullableTimestamp(row.terminalAt),
  };
}

function toNode(row: NodeRow): WorkflowNode {
  return {
    protocol_version: 'intelligence.workflow.v1',
    node_id: row.nodeId,
    run_id: row.runId,
    node_key: row.nodeKey,
    role: row.role as WorkflowNode['role'],
    kind: row.kind as WorkflowNode['kind'],
    agent_name: row.agentName,
    agent_card_hash: row.agentCardHash,
    capability_id: row.capabilityId as WorkflowNode['capability_id'],
    capability_version: row.capabilityVersion as WorkflowNode['capability_version'],
    input_hash: row.inputHash,
    policy_snapshot_hash: row.policySnapshotHash,
    evaluation_version: row.evaluationVersion,
    task_id: row.taskId,
    status: row.status as WorkflowNode['status'],
    attempt_count: row.attemptCount,
    deadline_at: toNullableTimestamp(row.deadlineAt),
    created_at: toTimestamp(row.createdAt),
    updated_at: toTimestamp(row.updatedAt),
    terminal_at: toNullableTimestamp(row.terminalAt),
  };
}

function toDependency(row: DependencyRow): WorkflowDependency {
  return {
    protocol_version: 'intelligence.workflow.v1',
    dependency_id: row.dependencyId,
    run_id: row.runId,
    node_id: row.nodeId,
    depends_on_node_id: row.dependsOnNodeId,
    condition: row.condition as WorkflowDependency['condition'],
    created_at: toTimestamp(row.createdAt),
  };
}

function toApproval(row: ApprovalRow): WorkflowApproval {
  return {
    protocol_version: 'intelligence.workflow.v1',
    approval_id: row.approvalId,
    run_id: row.runId,
    node_id: row.nodeId,
    risk: row.risk as WorkflowApproval['risk'],
    reason_code: row.reasonCode,
    action_summary: row.actionSummary,
    status: row.status as WorkflowApproval['status'],
    review_item_id: row.reviewItemId,
    acting_user_id: row.actingUserId,
    decision: row.decision as WorkflowApproval['decision'],
    feedback_hash: row.feedbackHash,
    requested_at: toTimestamp(row.requestedAt),
    resolved_at: toNullableTimestamp(row.resolvedAt),
  };
}

function toEvent(row: EventRow): WorkflowEvent {
  return {
    protocol_version: 'intelligence.workflow.v1',
    event_id: row.eventId,
    run_id: row.runId,
    sequence: row.sequence,
    type: row.eventType as WorkflowEvent['type'],
    status: row.status as WorkflowEvent['status'],
    graph_version: row.graphVersion,
    node_id: row.nodeId,
    task_id: row.taskId,
    progress: row.progress === null ? null : Number(row.progress),
    reason_code: row.reasonCode,
    asset_ids: row.assetIds,
    route_reason_codes: row.routeReasonCodes,
    evaluation_version: row.evaluationVersion,
    created_at: toTimestamp(row.createdAt),
  };
}

function runScope(accountId: string, projectId: string, runId: string) {
  return and(
    eq(intelligenceWorkflowRuns.accountId, accountId),
    eq(intelligenceWorkflowRuns.projectId, projectId),
    eq(intelligenceWorkflowRuns.runId, runId),
  );
}

async function lockRun(
  tx: WorkflowTransaction,
  input: { accountId: string; projectId: string; runId: string },
): Promise<RunRow | null> {
  const [run] = await tx
    .select()
    .from(intelligenceWorkflowRuns)
    .where(runScope(input.accountId, input.projectId, input.runId))
    .for('update');
  return run ?? null;
}

type EventOverrides = Partial<
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
>;

async function appendEvent(
  tx: WorkflowTransaction,
  run: RunRow,
  type: WorkflowEventType,
  createdAt: string,
  overrides: EventOverrides = {},
): Promise<void> {
  const [maximum] = await tx
    .select({ value: max(intelligenceWorkflowEvents.sequence) })
    .from(intelligenceWorkflowEvents)
    .where(eq(intelligenceWorkflowEvents.runId, run.runId));
  await tx.insert(intelligenceWorkflowEvents).values({
    runId: run.runId,
    sequence: Number(maximum?.value ?? 0) + 1,
    eventType: type,
    status: run.status,
    graphVersion: run.graphVersion,
    nodeId: overrides.node_id ?? null,
    taskId: overrides.task_id ?? null,
    progress:
      overrides.progress === undefined || overrides.progress === null
        ? null
        : String(overrides.progress),
    reasonCode: overrides.reason_code ?? null,
    assetIds: overrides.asset_ids ?? [],
    routeReasonCodes: overrides.route_reason_codes ?? [],
    evaluationVersion: overrides.evaluation_version ?? run.evaluationVersion,
    createdAt,
  });
}

async function loadGraph(tx: WorkflowTransaction, runId: string) {
  const [nodes, dependencies] = await Promise.all([
    tx.select().from(intelligenceWorkflowNodes).where(eq(intelligenceWorkflowNodes.runId, runId)),
    tx
      .select()
      .from(intelligenceWorkflowDependencies)
      .where(eq(intelligenceWorkflowDependencies.runId, runId)),
  ]);
  return { nodes, dependencies };
}

function validateGraphRows(nodes: NodeRow[], dependencies: DependencyRow[]): void {
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  validateWorkflowGraph(
    nodes.map((node) => ({ nodeKey: node.nodeKey })),
    dependencies.map((dependency) => {
      const node = nodeById.get(dependency.nodeId);
      const parent = nodeById.get(dependency.dependsOnNodeId);
      if (!node || !parent) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      return { nodeKey: node.nodeKey, dependsOnNodeKey: parent.nodeKey };
    }),
  );
}

async function refreshReadyNodes(
  tx: WorkflowTransaction,
  run: RunRow,
  updatedAt: string,
): Promise<NodeRow[]> {
  const { nodes, dependencies } = await loadGraph(tx, run.runId);
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const readyKeys = readyWorkflowNodeKeys(
    nodes.map((node) => ({ nodeKey: node.nodeKey, status: node.status as WorkflowNode['status'] })),
    dependencies.map((dependency) => {
      const node = nodeById.get(dependency.nodeId);
      const parent = nodeById.get(dependency.dependsOnNodeId);
      if (!node || !parent) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
      return {
        nodeKey: node.nodeKey,
        dependsOnNodeKey: parent.nodeKey,
        condition: dependency.condition as WorkflowDependency['condition'],
      };
    }),
  );
  const readied: NodeRow[] = [];
  for (const nodeKey of readyKeys) {
    const [node] = await tx
      .update(intelligenceWorkflowNodes)
      .set({ status: 'ready', updatedAt })
      .where(
        and(
          eq(intelligenceWorkflowNodes.runId, run.runId),
          eq(intelligenceWorkflowNodes.nodeKey, nodeKey),
          eq(intelligenceWorkflowNodes.status, 'pending'),
        ),
      )
      .returning();
    if (!node) continue;
    readied.push(node);
  }
  return readied;
}

function validateLeaseInput(input: { workerId: string; now: string; leaseMs: number }): void {
  if (
    input.workerId.trim() === '' ||
    !Number.isFinite(Date.parse(input.now)) ||
    input.leaseMs < 1_000 ||
    input.leaseMs > 10 * 60 * 1_000
  ) {
    throw new WorkflowStoreError('WORKFLOW_LEASE_CONFLICT');
  }
}

function sameApproval(left: WorkflowApproval, right: WorkflowApproval): boolean {
  return (
    left.approval_id === right.approval_id &&
    left.run_id === right.run_id &&
    left.node_id === right.node_id &&
    left.risk === right.risk &&
    left.reason_code === right.reason_code &&
    left.action_summary === right.action_summary &&
    left.status === right.status &&
    left.review_item_id === right.review_item_id &&
    left.acting_user_id === right.acting_user_id &&
    left.decision === right.decision &&
    left.feedback_hash === right.feedback_hash &&
    left.requested_at === right.requested_at &&
    left.resolved_at === right.resolved_at
  );
}

export function createPostgresWorkflowStore(database: Database): WorkflowPort {
  return {
    async startRun({ run }) {
      const result = await runWorkflowTransaction(database, async (tx) => {
        const inserted = await tx
          .insert(intelligenceWorkflowRuns)
          .values({
            runId: run.run_id,
            accountId: run.account_id,
            projectId: run.project_id,
            protocolVersion: run.protocol_version,
            actorType: run.actor_type,
            actorId: run.actor_id,
            agentName: run.agent_name,
            idempotencyKey: run.idempotency_key,
            requestHash: run.request_hash,
            status: run.status,
            graphVersion: run.graph_version,
            policySnapshotHash: run.policy_snapshot_hash,
            evaluationVersion: run.evaluation_version,
            maxNodes: run.max_nodes,
            maxDependencies: run.max_dependencies,
            maxApprovedCredits: String(run.max_approved_credits),
            deadlineAt: run.deadline_at,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            terminalAt: run.terminal_at,
          })
          .onConflictDoNothing({
            target: [intelligenceWorkflowRuns.projectId, intelligenceWorkflowRuns.idempotencyKey],
          })
          .returning();
        const row =
          inserted[0] ??
          (
            await tx
              .select()
              .from(intelligenceWorkflowRuns)
              .where(
                and(
                  eq(intelligenceWorkflowRuns.projectId, run.project_id),
                  eq(intelligenceWorkflowRuns.idempotencyKey, run.idempotency_key),
                ),
              )
              .limit(1)
          )[0];
        if (!row) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        if (
          row.accountId !== run.account_id ||
          row.projectId !== run.project_id ||
          row.requestHash !== run.request_hash
        ) {
          throw new WorkflowStoreError('WORKFLOW_IDEMPOTENCY_MISMATCH');
        }
        if (inserted[0]) {
          await appendEvent(tx, row, 'run_created', row.createdAt);
        }
        return {
          run: toRun(row),
          created: inserted.length === 1,
        };
      });
      return result;
    },
    async appendNode(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run || input.node.run_id !== input.runId) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        }

        const [replay] = await tx
          .select()
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (replay) {
          if (replay.requestHash !== input.requestHash) {
            throw new WorkflowStoreError('WORKFLOW_IDEMPOTENCY_MISMATCH');
          }
          return { node: toNode(replay), created: false, graphVersion: run.graphVersion };
        }
        if (run.graphVersion !== input.expectedGraphVersion) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_VERSION_CONFLICT');
        }

        const [conflict] = await tx
          .select({ nodeId: intelligenceWorkflowNodes.nodeId })
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              or(
                eq(intelligenceWorkflowNodes.nodeId, input.node.node_id),
                eq(intelligenceWorkflowNodes.nodeKey, input.node.node_key),
              ),
            ),
          )
          .limit(1);
        if (conflict) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');

        const [node] = await tx
          .insert(intelligenceWorkflowNodes)
          .values({
            nodeId: input.node.node_id,
            runId: input.node.run_id,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            nodeKey: input.node.node_key,
            role: input.node.role,
            kind: input.node.kind,
            agentName: input.node.agent_name,
            agentCardHash: input.node.agent_card_hash,
            capabilityId: input.node.capability_id,
            capabilityVersion: input.node.capability_version,
            inputHash: input.node.input_hash,
            policySnapshotHash: input.node.policy_snapshot_hash,
            evaluationVersion: input.node.evaluation_version,
            taskId: input.node.task_id,
            status: input.node.status,
            attemptCount: input.node.attempt_count,
            deadlineAt: input.node.deadline_at,
            createdAt: input.node.created_at,
            updatedAt: input.node.updated_at,
            terminalAt: input.node.terminal_at,
          })
          .returning();
        const [updatedRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({ graphVersion: run.graphVersion + 1, updatedAt: input.node.updated_at })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!node || !updatedRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        await appendEvent(tx, updatedRun, 'node_appended', input.node.created_at, {
          node_id: node.nodeId,
        });
        return { node: toNode(node), created: true, graphVersion: updatedRun.graphVersion };
      });
    },
    async addDependency(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run || input.dependency.run_id !== input.runId) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        }

        const [replay] = await tx
          .select()
          .from(intelligenceWorkflowDependencies)
          .where(
            and(
              eq(intelligenceWorkflowDependencies.runId, input.runId),
              eq(intelligenceWorkflowDependencies.nodeId, input.dependency.node_id),
              eq(
                intelligenceWorkflowDependencies.dependsOnNodeId,
                input.dependency.depends_on_node_id,
              ),
            ),
          )
          .limit(1);
        if (replay) {
          if (replay.condition !== input.dependency.condition) {
            throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
          }
          return {
            dependency: toDependency(replay),
            created: false,
            graphVersion: run.graphVersion,
          };
        }
        if (run.graphVersion !== input.expectedGraphVersion) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_VERSION_CONFLICT');
        }

        const [dependencyIdConflict] = await tx
          .select({ dependencyId: intelligenceWorkflowDependencies.dependencyId })
          .from(intelligenceWorkflowDependencies)
          .where(eq(intelligenceWorkflowDependencies.dependencyId, input.dependency.dependency_id))
          .limit(1);
        if (dependencyIdConflict) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');

        const graph = await loadGraph(tx, input.runId);
        const candidate: DependencyRow = {
          dependencyId: input.dependency.dependency_id,
          runId: input.dependency.run_id,
          nodeId: input.dependency.node_id,
          dependsOnNodeId: input.dependency.depends_on_node_id,
          condition: input.dependency.condition,
          createdAt: input.dependency.created_at,
        };
        validateGraphRows(graph.nodes, [...graph.dependencies, candidate]);

        const [dependency] = await tx
          .insert(intelligenceWorkflowDependencies)
          .values(candidate)
          .returning();
        const [updatedRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            graphVersion: run.graphVersion + 1,
            updatedAt: input.dependency.created_at,
          })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!dependency || !updatedRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        await appendEvent(tx, updatedRun, 'dependency_added', input.dependency.created_at, {
          node_id: dependency.nodeId,
        });
        return {
          dependency: toDependency(dependency),
          created: true,
          graphVersion: updatedRun.graphVersion,
        };
      });
    },
    async sealGraph(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        if (run.status !== 'draft') return toRun(run);
        if (run.graphVersion !== input.expectedGraphVersion) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_VERSION_CONFLICT');
        }

        const graph = await loadGraph(tx, input.runId);
        validateGraphRows(graph.nodes, graph.dependencies);
        const [updatedRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            status: assertWorkflowRunTransition(run.status as WorkflowRun['status'], 'running'),
            updatedAt: input.updatedAt,
          })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!updatedRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');

        const readied = await refreshReadyNodes(tx, updatedRun, input.updatedAt);
        await appendEvent(tx, updatedRun, 'graph_sealed', input.updatedAt);
        await appendEvent(tx, updatedRun, 'run_started', input.updatedAt);
        for (const node of readied) {
          await appendEvent(tx, updatedRun, 'node_ready', input.updatedAt, {
            node_id: node.nodeId,
          });
        }
        return toRun(updatedRun);
      });
    },
    async claimReadyNode(input) {
      validateLeaseInput(input);
      return runWorkflowTransaction(database, async (tx) => {
        const candidates = await tx.execute(
          sql<{ runId: string; nodeId: string }>`
            WITH RECURSIVE node_depths AS (
              SELECT node.run_id, node.node_id, 1 AS depth
              FROM kortix.intelligence_workflow_nodes AS node
              WHERE NOT EXISTS (
                SELECT 1
                FROM kortix.intelligence_workflow_dependencies AS dependency
                WHERE dependency.run_id = node.run_id
                  AND dependency.node_id = node.node_id
              )
              UNION ALL
              SELECT dependency.run_id, dependency.node_id, parent.depth + 1
              FROM node_depths AS parent
              JOIN kortix.intelligence_workflow_dependencies AS dependency
                ON dependency.run_id = parent.run_id
               AND dependency.depends_on_node_id = parent.node_id
            ),
            maximum_depths AS (
              SELECT run_id, node_id, MAX(depth) AS depth
              FROM node_depths
              GROUP BY run_id, node_id
            )
            SELECT run.run_id AS "runId", node.node_id AS "nodeId"
            FROM kortix.intelligence_workflow_nodes AS node
            JOIN kortix.intelligence_workflow_runs AS run
              ON run.run_id = node.run_id
            LEFT JOIN maximum_depths AS node_depth
              ON node_depth.run_id = node.run_id
             AND node_depth.node_id = node.node_id
            WHERE run.account_id = ${input.accountId}::uuid
              AND run.project_id = ${input.projectId}::uuid
              AND run.status = 'running'
              AND (run.deadline_at IS NULL OR run.deadline_at > ${input.now}::timestamptz)
              AND (node.deadline_at IS NULL OR node.deadline_at > ${input.now}::timestamptz)
              AND (
                node.status = 'ready'
                OR (
                  node.status = 'running'
                  AND (
                    node.lease_expires_at IS NULL
                    OR node.lease_expires_at <= ${input.now}::timestamptz
                  )
                )
              )
            ORDER BY COALESCE(node_depth.depth, 1), node.node_key, node.node_id
            FOR UPDATE OF run, node SKIP LOCKED
            LIMIT 1
          `,
        );
        const candidate = candidates[0] as { runId: string; nodeId: string } | undefined;
        if (!candidate) return null;

        const [[run], [node]] = await Promise.all([
          tx
            .select()
            .from(intelligenceWorkflowRuns)
            .where(eq(intelligenceWorkflowRuns.runId, candidate.runId))
            .limit(1),
          tx
            .select()
            .from(intelligenceWorkflowNodes)
            .where(eq(intelligenceWorkflowNodes.nodeId, candidate.nodeId))
            .limit(1),
        ]);
        if (!run || !node) throw new WorkflowStoreError('WORKFLOW_LEASE_CONFLICT');

        const [claimed] = await tx
          .update(intelligenceWorkflowNodes)
          .set({
            status: assertWorkflowNodeTransition(node.status as WorkflowNode['status'], 'running'),
            leaseOwner: input.workerId,
            leaseExpiresAt: sql`${input.now}::timestamptz
              + (${input.leaseMs} * interval '1 millisecond')`,
            attemptCount: sql`${intelligenceWorkflowNodes.attemptCount} + 1`,
            updatedAt: input.now,
          })
          .where(eq(intelligenceWorkflowNodes.nodeId, node.nodeId))
          .returning();
        if (!claimed) throw new WorkflowStoreError('WORKFLOW_LEASE_CONFLICT');
        await appendEvent(tx, run, 'node_started', input.now, {
          node_id: claimed.nodeId,
          task_id: claimed.taskId,
          evaluation_version: claimed.evaluationVersion,
        });
        return { run: toRun(run), node: toNode(claimed) };
      });
    },
    async heartbeatNode(input) {
      validateLeaseInput(input);
      return runWorkflowTransaction(database, async (tx) => {
        const [run] = await tx
          .select({ status: intelligenceWorkflowRuns.status })
          .from(intelligenceWorkflowRuns)
          .where(runScope(input.accountId, input.projectId, input.runId))
          .limit(1);
        if (!run || run.status !== 'running') return false;

        const [node] = await tx
          .update(intelligenceWorkflowNodes)
          .set({
            leaseExpiresAt: sql`${input.now}::timestamptz
              + (${input.leaseMs} * interval '1 millisecond')`,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
              eq(intelligenceWorkflowNodes.status, 'running'),
              eq(intelligenceWorkflowNodes.leaseOwner, input.workerId),
              sql`${intelligenceWorkflowNodes.leaseExpiresAt} > ${input.now}::timestamptz`,
            ),
          )
          .returning({ nodeId: intelligenceWorkflowNodes.nodeId });
        return Boolean(node);
      });
    },
    async attachTask(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        const [node] = await tx
          .select()
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
            ),
          )
          .for('update')
          .limit(1);
        if (!node) return null;
        if (node.taskId === input.taskId) return toNode(node);
        if (node.taskId !== null) {
          throw new WorkflowStoreError('WORKFLOW_TASK_ATTACHMENT_CONFLICT');
        }
        if (
          node.kind !== 'capability' ||
          node.status !== 'running' ||
          !Number.isFinite(Date.parse(input.updatedAt))
        ) {
          return null;
        }

        const [task] = await tx
          .select({ taskId: intelligenceTasks.taskId })
          .from(intelligenceTasks)
          .where(
            and(
              eq(intelligenceTasks.taskId, input.taskId),
              eq(intelligenceTasks.accountId, input.accountId),
              eq(intelligenceTasks.projectId, input.projectId),
            ),
          )
          .for('update')
          .limit(1);
        if (!task) return null;
        const [taskConflict] = await tx
          .select({ nodeId: intelligenceWorkflowNodes.nodeId })
          .from(intelligenceWorkflowNodes)
          .where(eq(intelligenceWorkflowNodes.taskId, input.taskId))
          .limit(1);
        if (taskConflict) {
          throw new WorkflowStoreError('WORKFLOW_TASK_ATTACHMENT_CONFLICT');
        }

        const [attached] = await tx
          .update(intelligenceWorkflowNodes)
          .set({ taskId: input.taskId, updatedAt: input.updatedAt })
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
              eq(intelligenceWorkflowNodes.status, 'running'),
              eq(intelligenceWorkflowNodes.leaseOwner, input.workerId),
              isNull(intelligenceWorkflowNodes.taskId),
              sql`${intelligenceWorkflowNodes.leaseExpiresAt}
                > ${input.updatedAt}::timestamptz`,
            ),
          )
          .returning();
        if (!attached) return null;
        await appendEvent(tx, run, 'task_attached', input.updatedAt, {
          node_id: attached.nodeId,
          task_id: attached.taskId,
          evaluation_version: attached.evaluationVersion,
        });
        return toNode(attached);
      });
    },
    async completeNode(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        const [node] = await tx
          .select()
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
            ),
          )
          .for('update')
          .limit(1);
        if (!node) return null;
        if (node.status === 'succeeded') {
          return { run: toRun(run), node: toNode(node) };
        }
        if (node.status !== 'running' || !Number.isFinite(Date.parse(input.completedAt))) {
          return null;
        }

        const [completed] = await tx
          .update(intelligenceWorkflowNodes)
          .set({
            status: assertWorkflowNodeTransition(
              node.status as WorkflowNode['status'],
              'succeeded',
            ),
            evaluationVersion: input.evaluationVersion,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: input.completedAt,
            terminalAt: input.completedAt,
          })
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
              eq(intelligenceWorkflowNodes.status, 'running'),
              eq(intelligenceWorkflowNodes.leaseOwner, input.workerId),
              sql`${intelligenceWorkflowNodes.leaseExpiresAt}
                > ${input.completedAt}::timestamptz`,
            ),
          )
          .returning();
        if (!completed) return null;

        const [updatedRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({ updatedAt: input.completedAt })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!updatedRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        await appendEvent(tx, updatedRun, 'node_succeeded', input.completedAt, {
          node_id: completed.nodeId,
          task_id: completed.taskId,
          asset_ids: input.assetIds,
          evaluation_version: input.evaluationVersion,
        });

        const readied = await refreshReadyNodes(tx, updatedRun, input.completedAt);
        for (const readyNode of readied) {
          await appendEvent(tx, updatedRun, 'node_ready', input.completedAt, {
            node_id: readyNode.nodeId,
          });
        }
        const [unfinished] = await tx
          .select({ nodeId: intelligenceWorkflowNodes.nodeId })
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              sql`${intelligenceWorkflowNodes.status} NOT IN ('succeeded', 'skipped')`,
            ),
          )
          .limit(1);
        if (unfinished) return { run: toRun(updatedRun), node: toNode(completed) };

        const [terminalRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            status: assertWorkflowRunTransition(
              updatedRun.status as WorkflowRun['status'],
              'succeeded',
            ),
            updatedAt: input.completedAt,
            terminalAt: input.completedAt,
          })
          .where(eq(intelligenceWorkflowRuns.runId, updatedRun.runId))
          .returning();
        if (!terminalRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        await appendEvent(tx, terminalRun, 'run_succeeded', input.completedAt);
        return { run: toRun(terminalRun), node: toNode(completed) };
      });
    },
    async failNode(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        const [node] = await tx
          .select()
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
            ),
          )
          .for('update')
          .limit(1);
        if (!node) return null;
        if (node.status === 'failed') {
          return { run: toRun(run), node: toNode(node) };
        }
        if (node.status !== 'running' || !Number.isFinite(Date.parse(input.failedAt))) {
          return null;
        }

        const nextNodeStatus = input.retryable ? 'ready' : 'failed';
        const [failed] = await tx
          .update(intelligenceWorkflowNodes)
          .set({
            status: assertWorkflowNodeTransition(
              node.status as WorkflowNode['status'],
              nextNodeStatus,
            ),
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: input.failedAt,
            terminalAt: input.retryable ? null : input.failedAt,
          })
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
              eq(intelligenceWorkflowNodes.status, 'running'),
              eq(intelligenceWorkflowNodes.leaseOwner, input.workerId),
              sql`${intelligenceWorkflowNodes.leaseExpiresAt}
                > ${input.failedAt}::timestamptz`,
            ),
          )
          .returning();
        if (!failed) return null;

        if (input.retryable) {
          const [updatedRun] = await tx
            .update(intelligenceWorkflowRuns)
            .set({ updatedAt: input.failedAt })
            .where(eq(intelligenceWorkflowRuns.runId, run.runId))
            .returning();
          if (!updatedRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
          await appendEvent(tx, updatedRun, 'node_failed', input.failedAt, {
            node_id: failed.nodeId,
            task_id: failed.taskId,
            reason_code: input.reasonCode,
            evaluation_version: failed.evaluationVersion,
          });
          await appendEvent(tx, updatedRun, 'node_ready', input.failedAt, {
            node_id: failed.nodeId,
          });
          return { run: toRun(updatedRun), node: toNode(failed) };
        }

        const [terminalRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            status: assertWorkflowRunTransition(run.status as WorkflowRun['status'], 'failed'),
            updatedAt: input.failedAt,
            terminalAt: input.failedAt,
          })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!terminalRun) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        await appendEvent(tx, terminalRun, 'node_failed', input.failedAt, {
          node_id: failed.nodeId,
          task_id: failed.taskId,
          reason_code: input.reasonCode,
          evaluation_version: failed.evaluationVersion,
        });
        await appendEvent(tx, terminalRun, 'run_failed', input.failedAt, {
          reason_code: input.reasonCode,
        });
        return { run: toRun(terminalRun), node: toNode(failed) };
      });
    },
    async pauseForApproval(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        const [node] = await tx
          .select()
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
            ),
          )
          .for('update')
          .limit(1);
        if (!node) return null;

        const [existing] = await tx
          .select()
          .from(intelligenceWorkflowApprovals)
          .where(eq(intelligenceWorkflowApprovals.approvalId, input.approval.approval_id))
          .limit(1);
        if (existing) {
          const approval = toApproval(existing);
          if (!sameApproval(approval, input.approval)) {
            throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
          }
          return { run: toRun(run), node: toNode(node), approval };
        }
        if (
          input.approval.run_id !== input.runId ||
          input.approval.node_id !== input.nodeId ||
          input.approval.status !== 'pending'
        ) {
          throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        }
        const [pending] = await tx
          .select({ approvalId: intelligenceWorkflowApprovals.approvalId })
          .from(intelligenceWorkflowApprovals)
          .where(
            and(
              eq(intelligenceWorkflowApprovals.runId, input.runId),
              eq(intelligenceWorkflowApprovals.nodeId, input.nodeId),
              eq(intelligenceWorkflowApprovals.status, 'pending'),
            ),
          )
          .limit(1);
        if (pending) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        if (
          run.status !== 'running' ||
          node.status !== 'running' ||
          !Number.isFinite(Date.parse(input.approval.requested_at))
        ) {
          return null;
        }

        const [pausedNode] = await tx
          .update(intelligenceWorkflowNodes)
          .set({
            status: assertWorkflowNodeTransition(
              node.status as WorkflowNode['status'],
              'waiting_approval',
            ),
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: input.approval.requested_at,
          })
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, input.nodeId),
              eq(intelligenceWorkflowNodes.status, 'running'),
              eq(intelligenceWorkflowNodes.leaseOwner, input.workerId),
              sql`${intelligenceWorkflowNodes.leaseExpiresAt}
                > ${input.approval.requested_at}::timestamptz`,
            ),
          )
          .returning();
        if (!pausedNode) return null;
        const [pausedRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            status: assertWorkflowRunTransition(
              run.status as WorkflowRun['status'],
              'waiting_approval',
            ),
            updatedAt: input.approval.requested_at,
          })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!pausedRun) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');

        const [approval] = await tx
          .insert(intelligenceWorkflowApprovals)
          .values({
            approvalId: input.approval.approval_id,
            runId: input.approval.run_id,
            nodeId: input.approval.node_id,
            risk: input.approval.risk,
            reasonCode: input.approval.reason_code,
            actionSummary: input.approval.action_summary,
            status: input.approval.status,
            reviewItemId: input.approval.review_item_id,
            actingUserId: input.approval.acting_user_id,
            decision: input.approval.decision,
            feedbackHash: input.approval.feedback_hash,
            requestedAt: input.approval.requested_at,
            resolvedAt: input.approval.resolved_at,
            createdAt: input.approval.requested_at,
            updatedAt: input.approval.requested_at,
          })
          .returning();
        if (!approval) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        await appendEvent(tx, pausedRun, 'node_waiting_approval', input.approval.requested_at, {
          node_id: pausedNode.nodeId,
          task_id: pausedNode.taskId,
          reason_code: approval.reasonCode,
          evaluation_version: pausedNode.evaluationVersion,
        });
        return {
          run: toRun(pausedRun),
          node: toNode(pausedNode),
          approval: toApproval(approval),
        };
      });
    },
    async resolveApproval(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        const [approvalRow] = await tx
          .select()
          .from(intelligenceWorkflowApprovals)
          .where(
            and(
              eq(intelligenceWorkflowApprovals.runId, input.runId),
              eq(intelligenceWorkflowApprovals.approvalId, input.approvalId),
            ),
          )
          .for('update')
          .limit(1);
        if (!approvalRow) return null;
        const [node] = await tx
          .select()
          .from(intelligenceWorkflowNodes)
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              eq(intelligenceWorkflowNodes.nodeId, approvalRow.nodeId),
            ),
          )
          .for('update')
          .limit(1);
        if (!node) return null;

        const expectedStatus = input.decision === 'approve' ? 'approved' : 'rejected';
        if (approvalRow.status !== 'pending') {
          const approval = toApproval(approvalRow);
          if (
            approval.status !== expectedStatus ||
            approval.acting_user_id !== input.actingUserId ||
            approval.decision !== input.decision ||
            approval.feedback_hash !== input.feedbackHash ||
            approval.resolved_at !== input.resolvedAt
          ) {
            throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
          }
          return { run: toRun(run), node: toNode(node), approval };
        }
        if (
          run.status !== 'waiting_approval' ||
          node.status !== 'waiting_approval' ||
          !Number.isFinite(Date.parse(input.resolvedAt))
        ) {
          throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        }

        const [approval] = await tx
          .update(intelligenceWorkflowApprovals)
          .set({
            status: expectedStatus,
            actingUserId: input.actingUserId,
            decision: input.decision,
            feedbackHash: input.feedbackHash,
            resolvedAt: input.resolvedAt,
            updatedAt: input.resolvedAt,
          })
          .where(eq(intelligenceWorkflowApprovals.approvalId, input.approvalId))
          .returning();
        if (!approval) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');

        const approved = input.decision === 'approve';
        const [resolvedNode] = await tx
          .update(intelligenceWorkflowNodes)
          .set({
            status: assertWorkflowNodeTransition(
              node.status as WorkflowNode['status'],
              approved ? 'running' : 'failed',
            ),
            updatedAt: input.resolvedAt,
            terminalAt: approved ? null : input.resolvedAt,
          })
          .where(eq(intelligenceWorkflowNodes.nodeId, node.nodeId))
          .returning();
        if (!resolvedNode) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');

        const [resolvedRun] = await tx
          .update(intelligenceWorkflowRuns)
          .set(
            approved
              ? { updatedAt: input.resolvedAt }
              : {
                  status: assertWorkflowRunTransition(
                    run.status as WorkflowRun['status'],
                    'failed',
                  ),
                  updatedAt: input.resolvedAt,
                  terminalAt: input.resolvedAt,
                },
          )
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!resolvedRun) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');

        await appendEvent(tx, resolvedRun, 'approval_resolved', input.resolvedAt, {
          node_id: resolvedNode.nodeId,
          task_id: resolvedNode.taskId,
          reason_code: approval.reasonCode,
          evaluation_version: resolvedNode.evaluationVersion,
        });
        if (!approved) {
          await appendEvent(tx, resolvedRun, 'node_failed', input.resolvedAt, {
            node_id: resolvedNode.nodeId,
            task_id: resolvedNode.taskId,
            reason_code: approval.reasonCode,
            evaluation_version: resolvedNode.evaluationVersion,
          });
          await appendEvent(tx, resolvedRun, 'run_failed', input.resolvedAt, {
            reason_code: approval.reasonCode,
          });
        }
        return {
          run: toRun(resolvedRun),
          node: toNode(resolvedNode),
          approval: toApproval(approval),
        };
      });
    },
    async resumeRun(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        if (run.status === 'running' || ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          return toRun(run);
        }

        const [pendingApproval] = await tx
          .select({ approvalId: intelligenceWorkflowApprovals.approvalId })
          .from(intelligenceWorkflowApprovals)
          .where(
            and(
              eq(intelligenceWorkflowApprovals.runId, input.runId),
              eq(intelligenceWorkflowApprovals.status, 'pending'),
            ),
          )
          .limit(1);
        if (
          run.status !== 'waiting_approval' ||
          pendingApproval ||
          !Number.isFinite(Date.parse(input.updatedAt))
        ) {
          throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        }
        const [resumed] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            status: assertWorkflowRunTransition(run.status as WorkflowRun['status'], 'running'),
            updatedAt: input.updatedAt,
          })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!resumed) throw new WorkflowStoreError('WORKFLOW_APPROVAL_CONFLICT');
        await appendEvent(tx, resumed, 'run_started', input.updatedAt);
        return toRun(resumed);
      });
    },
    async cancelRun(input) {
      return runWorkflowTransaction(database, async (tx) => {
        const run = await lockRun(tx, input);
        if (!run) return null;
        if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
          return toRun(run);
        }
        if (!Number.isFinite(Date.parse(input.cancelledAt))) {
          throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        }

        await tx
          .update(intelligenceWorkflowNodes)
          .set({
            status: 'cancelled',
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: input.cancelledAt,
            terminalAt: input.cancelledAt,
          })
          .where(
            and(
              eq(intelligenceWorkflowNodes.runId, input.runId),
              sql`${intelligenceWorkflowNodes.status}
                NOT IN ('succeeded', 'failed', 'skipped', 'cancelled')`,
            ),
          );
        await tx
          .update(intelligenceWorkflowApprovals)
          .set({
            status: 'cancelled',
            resolvedAt: input.cancelledAt,
            updatedAt: input.cancelledAt,
          })
          .where(
            and(
              eq(intelligenceWorkflowApprovals.runId, input.runId),
              eq(intelligenceWorkflowApprovals.status, 'pending'),
            ),
          );
        const [cancelled] = await tx
          .update(intelligenceWorkflowRuns)
          .set({
            status: assertWorkflowRunTransition(run.status as WorkflowRun['status'], 'cancelled'),
            updatedAt: input.cancelledAt,
            terminalAt: input.cancelledAt,
          })
          .where(eq(intelligenceWorkflowRuns.runId, run.runId))
          .returning();
        if (!cancelled) throw new WorkflowStoreError('WORKFLOW_GRAPH_CONFLICT');
        await appendEvent(tx, cancelled, 'run_cancelled', input.cancelledAt, {
          reason_code: input.reasonCode,
        });
        return toRun(cancelled);
      });
    },
    async getRun(input) {
      const [run] = await database
        .select()
        .from(intelligenceWorkflowRuns)
        .where(runScope(input.accountId, input.projectId, input.runId))
        .limit(1);
      return run ? toRun(run) : null;
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
      const [run] = await database
        .select({ runId: intelligenceWorkflowRuns.runId })
        .from(intelligenceWorkflowRuns)
        .where(runScope(input.accountId, input.projectId, input.runId))
        .limit(1);
      if (!run) return { items: [], nextCursor: null };

      const rows = await database
        .select()
        .from(intelligenceWorkflowEvents)
        .where(
          and(
            eq(intelligenceWorkflowEvents.runId, input.runId),
            gt(intelligenceWorkflowEvents.sequence, input.afterSequence),
          ),
        )
        .orderBy(asc(intelligenceWorkflowEvents.sequence))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      return {
        items: page.map(toEvent),
        nextCursor:
          rows.length > input.limit && page.length > 0
            ? String(page[page.length - 1]?.sequence)
            : null,
      };
    },
  };
}
