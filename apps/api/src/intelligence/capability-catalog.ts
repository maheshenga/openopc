import {
  CapabilityCatalogItemSchema,
  CapabilityCatalogRefSchema,
  CapabilityCatalogSearchInputSchema,
  CapabilityDescriptorSchema,
  type CapabilityCatalogPort as CapabilityCatalogContractPort,
  type CapabilityCatalogItem,
  type CapabilityCatalogRef,
  type CapabilityCatalogSearchInput,
  type CapabilityDescriptor,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';

export interface CatalogActor {
  accountId?: string;
  userId?: string;
  actorType?: 'user' | 'agent' | 'system';
  actingTokenId?: string | null;
}

export interface CatalogExecutorAction {
  path: string;
  name: string;
  description?: string | null;
  inputSchema?: unknown;
  outputSchema?: unknown;
  risk: 'read' | 'write' | 'destructive';
  binding?: unknown;
}

export interface CatalogExecutorEntry {
  projectId: string;
  connectorSlug: string;
  action: CatalogExecutorAction | null;
}

export interface ProjectCapabilityCatalogDeps {
  capabilityRegistry: {
    list(projectId: string, actor?: CatalogActor): Promise<CapabilityDescriptor[]>;
  };
  executorSource?: {
    list(projectId: string, actor?: CatalogActor): Promise<CatalogExecutorEntry[]>;
  };
}

export interface ProjectCapabilityCatalogPort extends CapabilityCatalogContractPort {
  search(input: CapabilityCatalogSearchInput & {
    actor?: CatalogActor;
  }): Promise<{ items: CapabilityCatalogItem[]; next_cursor: number | null }>;
  describe(input: {
    projectId: string;
    ref: CapabilityCatalogRef;
    actor?: CatalogActor;
  }): Promise<unknown | null>;
}

const SOURCE_ORDER: Record<CapabilityCatalogItem['source'], number> = {
  studio: 0,
  mcp: 1,
  executor: 2,
  module: 3,
};

const PRIVATE_TEXT =
  /(?:https?:\/\/|["']?\s*(?:api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz)\s*["']?\s*[:=]|\bbearer\s+[A-Za-z0-9._-]{8,})/i;

export function createProjectCapabilityCatalog(
  deps: ProjectCapabilityCatalogDeps,
): ProjectCapabilityCatalogPort {
  async function collect(projectId: string, actor?: CatalogActor): Promise<CatalogEntry[]> {
    const entries: CatalogEntry[] = [];

    try {
      const capabilities = await deps.capabilityRegistry.list(projectId, actor);
      for (const rawCapability of capabilities as unknown[]) {
        try {
          const capability = CapabilityDescriptorSchema.safeParse(rawCapability);
          if (!capability.success) continue;
          const item = capabilityItem(capability.data);
          if (item) entries.push({ item, detail: capability.data.input_schema });
        } catch {
          // One malformed entry must not hide healthy entries from this source.
        }
      }
    } catch {
      // A failed provider/catalog source must not expose or hide another source's data.
    }

    if (deps.executorSource) {
      try {
        const actions = await deps.executorSource.list(projectId, actor);
        for (const rawEntry of actions as unknown[]) {
          try {
            const entry = asCatalogExecutorEntry(rawEntry);
            if (!entry || entry.projectId !== projectId || !entry.action) continue;
            const item = executorItem(entry);
            if (item) {
              entries.push({
                item,
                detail: isJsonObject(entry.action.inputSchema)
                  ? entry.action.inputSchema
                  : { type: 'object' },
              });
            }
          } catch {
            // One malformed entry must not hide healthy entries from this source.
          }
        }
      } catch {
        // Executor discovery is optional; keep healthy Studio entries visible.
      }
    }

    return entries.sort(compareEntries);
  }

  return {
    async search(input) {
      // `actor` is an application-only value and is intentionally not part of
      // the public wire schema parsed here.
      const parsed = CapabilityCatalogSearchInputSchema.parse({
        projectId: input.projectId,
        query: input.query,
        limit: input.limit,
        cursor: input.cursor,
      });
      const entries = await collect(parsed.projectId, input.actor);
      const query = parsed.query.toLocaleLowerCase();
      const filtered = query
        ? entries.filter(({ item }) => {
            const haystack = `${item.title} ${item.summary} ${item.ref.id}`.toLocaleLowerCase();
            return query.split(/\s+/).every((token) => haystack.includes(token));
          })
        : entries;
      const start = parsed.cursor ?? 0;
      const items = filtered.slice(start, start + parsed.limit).map(({ item }) => item);
      const next = start + items.length < filtered.length ? start + items.length : null;
      return { items, next_cursor: next };
    },

    async describe(input) {
      const projectId = z.string().uuid().parse(input.projectId);
      const ref = CapabilityCatalogRefSchema.parse(input.ref);
      const entries = await collect(projectId, input.actor);
      const match = entries.find(({ item }) => sameRef(item.ref, ref));
      return match ? publicDetail(match.detail) : null;
    },
  };
}

interface CatalogEntry {
  item: CapabilityCatalogItem;
  detail: unknown;
}

function capabilityItem(capability: CapabilityDescriptor): CatalogEntry['item'] | null {
  const title = `${capitalize(capability.modality)} ${capability.operation}`;
  const summary = `${capitalize(capability.operation)} ${capability.modality} output.`;
  const parsed = CapabilityCatalogItemSchema.safeParse({
    ref: { kind: 'capability', id: capability.id, version: capability.version },
    title,
    summary,
    risk: capability.risk,
    availability: 'available',
    capability_id: capability.id,
    executable: true,
    source: 'studio',
  });
  return parsed.success ? parsed.data : null;
}

function executorItem(entry: CatalogExecutorEntry): CatalogEntry['item'] | null {
  const action = entry.action;
  if (!action || !isSafeCatalogId(entry.connectorSlug) || !isSafeCatalogId(action.path)) {
    return null;
  }
  const summary = (action.description ?? action.name).trim();
  if (!action.name.trim() || PRIVATE_TEXT.test(summary)) return null;
  const parsed = CapabilityCatalogItemSchema.safeParse({
    ref: { kind: 'tool', id: `${entry.connectorSlug}.${action.path}`, version: '1.0.0' },
    title: action.name,
    summary,
    risk: action.risk,
    availability: 'available',
    capability_id: null,
    executable: true,
    source: 'mcp',
  });
  return parsed.success ? parsed.data : null;
}

function compareEntries(left: CatalogEntry, right: CatalogEntry): number {
  const source = SOURCE_ORDER[left.item.source] - SOURCE_ORDER[right.item.source];
  if (source !== 0) return source;
  const leftKey = `${left.item.ref.kind}:${left.item.ref.id}@${left.item.ref.version}`;
  const rightKey = `${right.item.ref.kind}:${right.item.ref.id}@${right.item.ref.version}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function sameRef(left: CapabilityCatalogRef, right: CapabilityCatalogRef): boolean {
  return left.kind === right.kind && left.id === right.id && left.version === right.version;
}

function isSafeCatalogId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/.test(value.trim());
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asCatalogExecutorEntry(value: unknown): CatalogExecutorEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<CatalogExecutorEntry>;
  if (typeof entry.projectId !== 'string' || typeof entry.connectorSlug !== 'string') return null;
  if (entry.action === null) return { projectId: entry.projectId, connectorSlug: entry.connectorSlug, action: null };
  if (!entry.action || typeof entry.action !== 'object') return null;
  const action = entry.action as Partial<CatalogExecutorAction>;
  if (
    typeof action.path !== 'string' ||
    typeof action.name !== 'string' ||
    !isCatalogRisk(action.risk)
  ) {
    return null;
  }
  return {
    projectId: entry.projectId,
    connectorSlug: entry.connectorSlug,
    action: {
      path: action.path,
      name: action.name,
      ...(typeof action.description === 'string' || action.description === null
        ? { description: action.description }
        : {}),
      ...(isJsonObject(action.inputSchema) ? { inputSchema: action.inputSchema } : {}),
      ...(isJsonObject(action.outputSchema) ? { outputSchema: action.outputSchema } : {}),
      risk: action.risk,
      ...(action.binding === undefined ? {} : { binding: action.binding }),
    },
  };
}

function isCatalogRisk(value: unknown): value is CatalogExecutorAction['risk'] {
  return value === 'read' || value === 'write' || value === 'destructive';
}

function publicDetail(value: unknown): unknown {
  return isSafePublicJson(value) ? value : { type: 'object' };
}

function isSafePublicJson(value: unknown): boolean {
  if (typeof value === 'string') return !PRIVATE_TEXT.test(value);
  if (Array.isArray(value)) return value.every(isSafePublicJson);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value as Record<string, unknown>).every(([key, child]) => {
    if (/(?:secret|token|password|authorization|api[_-]?key)/i.test(key)) return false;
    return isSafePublicJson(child);
  });
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
