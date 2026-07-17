import { createHash } from 'node:crypto';
import {
  type AgentCard,
  AgentCardSchema,
  type CapabilityDescriptor,
} from '@kortix/intelligence-contracts';

export interface ProjectAgentCardInput {
  projectId: string;
  agentId: string;
  displayName: string;
  capabilities: readonly CapabilityDescriptor[];
  protocols?: readonly ('mcp' | 'a2a')[];
  authKind?: 'kortix-project-token' | 'service-token';
  trustTier?: AgentCard['trust_tier'];
  version?: string;
  limits?: {
    concurrency?: number;
    maxTaskSeconds?: number;
    max_task_seconds?: number;
  };
}

/** Build a public, descriptive Agent Card without serializing capability schemas. */
export function buildProjectAgentCard(input: ProjectAgentCardInput): AgentCard {
  const version = input.version ?? '1.0.0';
  const protocols = [...new Set(input.protocols ?? ['mcp', 'a2a'])].sort(compareStrings);
  const trustTier = input.trustTier ?? 'project';
  const limits = {
    concurrency: input.limits?.concurrency ?? 1,
    max_task_seconds: input.limits?.max_task_seconds ?? input.limits?.maxTaskSeconds ?? 900,
  };
  const fingerprints = input.capabilities
    .map((capability) => ({
      id: capability.id,
      version: capability.version,
      modality: capability.modality,
      operation: capability.operation,
      execution: capability.execution,
      risk: capability.risk,
      provenance_required: capability.provenance_required,
    }))
    .sort((left, right) =>
      compareStrings(`${left.id}\u0000${left.version}`, `${right.id}\u0000${right.version}`),
    );
  const capabilityIds = [...new Set(fingerprints.map((capability) => capability.id))].sort(
    compareStrings,
  );

  const canonical = stableStringify({
    project_id: input.projectId.trim(),
    agent_id: input.agentId.trim(),
    display_name: input.displayName.trim(),
    version,
    capabilities: fingerprints,
    protocols,
    auth_kind: input.authKind ?? 'kortix-project-token',
    trust_tier: trustTier,
    limits,
  });
  const cardHash = createHash('sha256').update(canonical, 'utf8').digest('hex');

  return AgentCardSchema.parse({
    id: input.agentId.trim(),
    version,
    display_name: input.displayName.trim(),
    capabilities: capabilityIds,
    protocols,
    auth: { kind: input.authKind ?? 'kortix-project-token' },
    trust_tier: trustTier,
    limits,
    card_hash: cardHash,
  });
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortValue(record[key])]),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
