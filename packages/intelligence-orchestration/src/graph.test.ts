import { describe, expect, test } from 'bun:test';
import { readyWorkflowNodeKeys, validateWorkflowGraph } from './graph';

describe('workflow graph', () => {
  test('orders a DAG deterministically and rejects a cycle', () => {
    const nodes = [{ nodeKey: 'review' }, { nodeKey: 'plan' }, { nodeKey: 'render' }];
    const dependencies = [
      { nodeKey: 'render', dependsOnNodeKey: 'plan' },
      { nodeKey: 'review', dependsOnNodeKey: 'render' },
    ];

    expect(validateWorkflowGraph(nodes, dependencies).orderedNodeKeys).toEqual([
      'plan',
      'render',
      'review',
    ]);

    expect(() =>
      validateWorkflowGraph(nodes, [
        ...dependencies,
        { nodeKey: 'plan', dependsOnNodeKey: 'review' },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: 'WORKFLOW_GRAPH_CYCLE',
      }),
    );
  });

  test('enforces the fixed node, depth, and fan-out limits', () => {
    const tooManyNodes = Array.from({ length: 129 }, (_, index) => ({
      nodeKey: `node-${index}`,
    }));
    expect(() => validateWorkflowGraph(tooManyNodes, [])).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_GRAPH_LIMIT_EXCEEDED' }),
    );

    const wideNodes = [
      { nodeKey: 'root' },
      ...Array.from({ length: 17 }, (_, index) => ({ nodeKey: `child-${index}` })),
    ];
    const wideDependencies = wideNodes.slice(1).map((node) => ({
      nodeKey: node.nodeKey,
      dependsOnNodeKey: 'root',
    }));
    expect(() => validateWorkflowGraph(wideNodes, wideDependencies)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_GRAPH_LIMIT_EXCEEDED' }),
    );

    const deepNodes = Array.from({ length: 17 }, (_, index) => ({ nodeKey: `step-${index}` }));
    const deepDependencies = deepNodes.slice(1).map((node, index) => ({
      nodeKey: node.nodeKey,
      dependsOnNodeKey: `step-${index}`,
    }));
    expect(() => validateWorkflowGraph(deepNodes, deepDependencies)).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_GRAPH_LIMIT_EXCEEDED' }),
    );
  });

  test('selects only dependency-satisfied pending nodes in stable order', () => {
    const nodes = [
      { nodeKey: 'review', status: 'pending' as const },
      { nodeKey: 'plan', status: 'succeeded' as const },
      { nodeKey: 'render', status: 'pending' as const },
      { nodeKey: 'cleanup', status: 'pending' as const },
    ];
    const dependencies = [
      { nodeKey: 'render', dependsOnNodeKey: 'plan', condition: 'on_success' as const },
      { nodeKey: 'cleanup', dependsOnNodeKey: 'plan', condition: 'on_completion' as const },
      { nodeKey: 'review', dependsOnNodeKey: 'render', condition: 'on_success' as const },
    ];

    expect(readyWorkflowNodeKeys(nodes, dependencies)).toEqual(['cleanup', 'render']);
  });
});
