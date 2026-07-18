import {
  WORKFLOW_MAX_DEPENDENCIES,
  WORKFLOW_MAX_NODES,
  type WorkflowNodeStatus,
} from '@kortix/intelligence-contracts';

export const WORKFLOW_MAX_DEPTH = 16 as const;
export const WORKFLOW_MAX_FAN_OUT = 16 as const;

export type WorkflowGraphNode = {
  nodeKey: string;
};

export type WorkflowGraphDependency = {
  nodeKey: string;
  dependsOnNodeKey: string;
};

export type SchedulableWorkflowNode = WorkflowGraphNode & {
  status: WorkflowNodeStatus;
};

export type ConditionalWorkflowDependency = WorkflowGraphDependency & {
  condition: 'on_success' | 'on_completion';
};

export type WorkflowGraphErrorCode =
  | 'WORKFLOW_GRAPH_CYCLE'
  | 'WORKFLOW_GRAPH_DUPLICATE'
  | 'WORKFLOW_GRAPH_INVALID_REFERENCE'
  | 'WORKFLOW_GRAPH_LIMIT_EXCEEDED';

export class WorkflowGraphValidationError extends Error {
  constructor(readonly code: WorkflowGraphErrorCode) {
    super('invalid workflow graph');
    this.name = 'WorkflowGraphValidationError';
  }
}

export function validateWorkflowGraph(
  nodes: readonly WorkflowGraphNode[],
  dependencies: readonly WorkflowGraphDependency[],
): { orderedNodeKeys: string[] } {
  if (nodes.length > WORKFLOW_MAX_NODES || dependencies.length > WORKFLOW_MAX_DEPENDENCIES) {
    throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_LIMIT_EXCEEDED');
  }
  const nodeKeys = new Set<string>();
  for (const node of nodes) {
    if (nodeKeys.has(node.nodeKey)) {
      throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_DUPLICATE');
    }
    nodeKeys.add(node.nodeKey);
  }

  const indegree = new Map([...nodeKeys].map((nodeKey) => [nodeKey, 0]));
  const outgoing = new Map([...nodeKeys].map((nodeKey) => [nodeKey, new Set<string>()]));
  const edges = new Set<string>();
  for (const dependency of dependencies) {
    if (!nodeKeys.has(dependency.nodeKey) || !nodeKeys.has(dependency.dependsOnNodeKey)) {
      throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_INVALID_REFERENCE');
    }
    const edgeKey = `${dependency.dependsOnNodeKey}\u0000${dependency.nodeKey}`;
    if (edges.has(edgeKey)) {
      throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_DUPLICATE');
    }
    edges.add(edgeKey);
    const children = outgoing.get(dependency.dependsOnNodeKey);
    children?.add(dependency.nodeKey);
    if ((children?.size ?? 0) > WORKFLOW_MAX_FAN_OUT) {
      throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_LIMIT_EXCEEDED');
    }
    indegree.set(dependency.nodeKey, (indegree.get(dependency.nodeKey) ?? 0) + 1);
  }

  const ready = [...nodeKeys].filter((nodeKey) => indegree.get(nodeKey) === 0).sort();
  const orderedNodeKeys: string[] = [];
  const depth = new Map([...nodeKeys].map((nodeKey) => [nodeKey, 1]));
  while (ready.length > 0) {
    const nodeKey = ready.shift();
    if (nodeKey === undefined) break;
    orderedNodeKeys.push(nodeKey);
    for (const child of [...(outgoing.get(nodeKey) ?? [])].sort()) {
      const childDepth = Math.max(depth.get(child) ?? 1, (depth.get(nodeKey) ?? 1) + 1);
      if (childDepth > WORKFLOW_MAX_DEPTH) {
        throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_LIMIT_EXCEEDED');
      }
      depth.set(child, childDepth);
      const remaining = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, remaining);
      if (remaining === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (orderedNodeKeys.length !== nodeKeys.size) {
    throw new WorkflowGraphValidationError('WORKFLOW_GRAPH_CYCLE');
  }
  return { orderedNodeKeys };
}

const TERMINAL_NODE_STATUSES: ReadonlySet<WorkflowNodeStatus> = new Set([
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

export function readyWorkflowNodeKeys(
  nodes: readonly SchedulableWorkflowNode[],
  dependencies: readonly ConditionalWorkflowDependency[],
): string[] {
  validateWorkflowGraph(nodes, dependencies);
  const statusByNode = new Map(nodes.map((node) => [node.nodeKey, node.status]));
  const dependenciesByNode = new Map<string, ConditionalWorkflowDependency[]>();
  for (const dependency of dependencies) {
    const items = dependenciesByNode.get(dependency.nodeKey) ?? [];
    items.push(dependency);
    dependenciesByNode.set(dependency.nodeKey, items);
  }

  return nodes
    .filter((node) => {
      if (node.status !== 'pending') return false;
      return (dependenciesByNode.get(node.nodeKey) ?? []).every((dependency) => {
        const status = statusByNode.get(dependency.dependsOnNodeKey);
        return dependency.condition === 'on_success'
          ? status === 'succeeded'
          : status !== undefined && TERMINAL_NODE_STATUSES.has(status);
      });
    })
    .map((node) => node.nodeKey)
    .sort();
}
