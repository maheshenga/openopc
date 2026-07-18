import { createHash } from 'node:crypto';

export class WorkflowCanonicalizationError extends Error {
  readonly code = 'WORKFLOW_CANONICAL_VALUE_INVALID' as const;

  constructor() {
    super('invalid workflow canonical value');
    this.name = 'WorkflowCanonicalizationError';
  }
}

function canonicalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowCanonicalizationError();
    return value;
  }
  if (!value || typeof value !== 'object') throw new WorkflowCanonicalizationError();
  if (seen.has(value)) throw new WorkflowCanonicalizationError();
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => canonicalize(entry, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowCanonicalizationError();
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

export function canonicalWorkflowJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, new WeakSet()));
}

export function canonicalWorkflowHash(value: unknown): string {
  const digest = createHash('sha256').update(canonicalWorkflowJson(value), 'utf8').digest('hex');
  return `sha256:${digest}`;
}
