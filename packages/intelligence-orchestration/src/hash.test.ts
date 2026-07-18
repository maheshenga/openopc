import { describe, expect, test } from 'bun:test';
import { WorkflowCanonicalizationError, canonicalWorkflowHash } from './hash';

describe('workflow canonical hash', () => {
  test('is stable across object key order', () => {
    const left = canonicalWorkflowHash({
      project_id: 'project-a',
      graph: { nodes: ['plan', 'render'], version: 1 },
    });
    const right = canonicalWorkflowHash({
      graph: { version: 1, nodes: ['plan', 'render'] },
      project_id: 'project-a',
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('rejects non-JSON values instead of creating hash collisions', () => {
    for (const value of [{ value: Number.NaN }, new Date('2026-07-18T10:00:00.000Z')]) {
      expect(() => canonicalWorkflowHash(value)).toThrow(WorkflowCanonicalizationError);
    }
  });
});
