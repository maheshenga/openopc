import {
  CAPABILITY_CATALOG_MAX_CURSOR,
  CapabilityCatalogItemSchema,
  CapabilityCatalogRefSchema,
  CapabilityCatalogSearchInputSchema,
  CapabilityDescriptorSchema,
  hasUnsafeCatalogCredentialLiteral,
  type CapabilityCatalogItem,
  type CapabilityCatalogRef,
  type CapabilityCatalogSearchInput,
  type CapabilityDescriptor,
} from '@kortix/intelligence-contracts';
import type { AgentGrant } from '@kortix/db';
import { z } from 'zod';

export interface CatalogActor {
  accountId: string;
  userId: string;
  actorType: 'user' | 'agent' | 'system';
  actingTokenId: string | null;
  /** Project execution session only. Never copy an IdP login session here. */
  sessionId?: string | null;
  /** Preserves the Executor connector allowlist for agent-session tokens. */
  agentGrant?: AgentGrant | null;
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
  source: 'mcp' | 'executor';
  action: CatalogExecutorAction | null;
}

export interface CatalogExecutorSource {
  list(
    projectId: string,
    actor: CatalogActor,
    requestContext?: unknown,
  ): Promise<CatalogExecutorEntry[]>;
}

interface ExecutorCatalogPrincipal {
  accountId: string;
  userId: string;
  projectId: string;
}

interface ExecutorCatalogAction {
  path: string;
  name: string;
  description?: string | null;
  inputSchema?: unknown;
  risk: string;
}

interface ExecutorCatalogConnector {
  slug: string;
  provider: string;
  actions: readonly ExecutorCatalogAction[];
}

export interface ExecutorCatalogSourceDeps<TPrincipal extends ExecutorCatalogPrincipal> {
  resolveProjectPrincipal(actor: CatalogActor, projectId: string): Promise<TPrincipal | null>;
  listCatalog(principal: TPrincipal): Promise<readonly ExecutorCatalogConnector[]>;
}

/** Adapts the governed Executor catalog without bypassing its principal filters. */
export function createExecutorCatalogSource<TPrincipal extends ExecutorCatalogPrincipal>(
  deps: ExecutorCatalogSourceDeps<TPrincipal>,
): CatalogExecutorSource {
  return {
    async list(projectId, actor, _requestContext) {
      let principal: TPrincipal | null;
      try {
        principal = await deps.resolveProjectPrincipal(actor, projectId);
      } catch {
        return [];
      }
      if (
        !principal ||
        principal.projectId !== projectId ||
        principal.accountId !== actor.accountId ||
        principal.userId !== actor.userId
      ) {
        return [];
      }
      try {
        const connectors = await deps.listCatalog(principal);
        return connectors.flatMap((connector) =>
          connector.actions.flatMap((action): CatalogExecutorEntry[] => {
            if (!isSafeCatalogId(connector.slug) || !isSafeCatalogId(action.path)) return [];
            if (!isCatalogRisk(action.risk)) return [];
            return [
              {
                projectId,
                connectorSlug: connector.slug,
                source: connector.provider === 'mcp' ? 'mcp' : 'executor',
                action: {
                  path: action.path,
                  name: action.name,
                  ...(typeof action.description === 'string' || action.description === null
                    ? { description: action.description }
                    : {}),
                  ...(isJsonObject(action.inputSchema) ? { inputSchema: action.inputSchema } : {}),
                  risk: action.risk,
                },
              },
            ];
          }),
        );
      } catch {
        return [];
      }
    },
  };
}

export interface ProjectCapabilityCatalogDeps {
  capabilityRegistry: {
    list(projectId: string, actor: CatalogActor): Promise<CapabilityDescriptor[]>;
  };
  executorSource?: CatalogExecutorSource;
}

export interface ProjectCapabilityCatalogPort {
  search(input: CapabilityCatalogSearchInput & {
    actor: CatalogActor;
    requestContext?: unknown;
  }): Promise<{ items: CapabilityCatalogItem[]; next_cursor: number | null }>;
  describe(input: {
    projectId: string;
    ref: CapabilityCatalogRef;
    actor: CatalogActor;
    requestContext?: unknown;
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
const SENSITIVE_PUBLIC_KEY_PATTERN =
  /(?:^|[._-])(?:api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz|(?:raw(?:[_-](?:provider|request|response))*|provider(?:[_-](?:request|response))?)[_-](?:body|payload)|headers?)(?:[._-]|$)/i;

export function createProjectCapabilityCatalog(
  deps: ProjectCapabilityCatalogDeps,
): ProjectCapabilityCatalogPort {
  async function collect(
    projectId: string,
    actor: CatalogActor,
    requestContext?: unknown,
  ): Promise<CatalogEntry[]> {
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
        const actions = await deps.executorSource.list(projectId, actor, requestContext);
        for (const rawEntry of actions as unknown[]) {
          try {
            const entry = asCatalogExecutorEntry(rawEntry);
            if (!entry || entry.projectId !== projectId || !entry.action) continue;
            const item = executorItem(entry);
            if (item) {
              entries.push({
                item,
                detail: isJsonObject(entry.action.inputSchema)
                  ? projectExternalInputSchema(entry.action.inputSchema)
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

    const ordered = entries.sort(compareEntries);
    const deduped = new Map<string, CatalogEntry>();
    for (const entry of ordered) {
      const ref = formatRef(entry.item.ref);
      if (!deduped.has(ref)) deduped.set(ref, entry);
    }
    return [...deduped.values()];
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
      const actor = requireActor(input.actor);
      const entries = await collect(parsed.projectId, actor, input.requestContext);
      const query = parsed.query.toLocaleLowerCase();
      const filtered = query
        ? entries.filter(({ item }) => {
            const haystack = `${item.title} ${item.summary} ${item.ref.id}`.toLocaleLowerCase();
            return query.split(/\s+/).every((token) => haystack.includes(token));
          })
        : entries;
      const start = parsed.cursor ?? 0;
      const items = filtered.slice(start, start + parsed.limit).map(({ item }) => item);
      const nextOffset = start + items.length;
      const next =
        nextOffset < filtered.length && nextOffset <= CAPABILITY_CATALOG_MAX_CURSOR
          ? nextOffset
          : null;
      return { items, next_cursor: next };
    },

    async describe(input) {
      const projectId = z.string().uuid().parse(input.projectId);
      const ref = CapabilityCatalogRefSchema.parse(input.ref);
      const entries = await collect(projectId, requireActor(input.actor), input.requestContext);
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
  const title = titleForTool(entry.connectorSlug, action.path);
  const summary = `Run the ${entry.connectorSlug}.${action.path} tool.`;
  const parsed = CapabilityCatalogItemSchema.safeParse({
    ref: { kind: 'tool', id: `${entry.connectorSlug}.${action.path}`, version: '1.0.0' },
    title,
    summary,
    risk: action.risk,
    availability: 'available',
    capability_id: null,
    executable: true,
    source: entry.source,
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

function formatRef(ref: CapabilityCatalogRef): string {
  return `${ref.kind}:${ref.id}@${ref.version}`;
}

function requireActor(actor: CatalogActor | undefined): CatalogActor {
  if (
    !actor ||
    !z.string().uuid().safeParse(actor.accountId).success ||
    !z.string().uuid().safeParse(actor.userId).success ||
    !['user', 'agent', 'system'].includes(actor.actorType) ||
    (actor.actingTokenId !== null && !z.string().uuid().safeParse(actor.actingTokenId).success) ||
    (actor.actorType === 'agent' && !isCatalogAgentGrant(actor.agentGrant))
  ) {
    throw new TypeError('catalog actor is required');
  }
  return actor;
}

function isCatalogAgentGrant(value: unknown): value is AgentGrant {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.agent === 'string' &&
    value.agent.length > 0 &&
    isCatalogGrantSet(value.kortixCli) &&
    isCatalogGrantSet(value.connectors) &&
    (value.env === undefined || isCatalogGrantSet(value.env))
  );
}

function isCatalogGrantSet(value: unknown): value is string[] | 'all' {
  return value === 'all' || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
}

function isSafeCatalogId(value: string): boolean {
  return CapabilityCatalogRefSchema.safeParse({
    kind: 'tool',
    id: value,
    version: '1.0.0',
  }).success;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asCatalogExecutorEntry(value: unknown): CatalogExecutorEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<CatalogExecutorEntry>;
  if (
    typeof entry.projectId !== 'string' ||
    typeof entry.connectorSlug !== 'string' ||
    (entry.source !== 'mcp' && entry.source !== 'executor')
  ) {
    return null;
  }
  if (entry.action === null) {
    return { projectId: entry.projectId, connectorSlug: entry.connectorSlug, source: entry.source, action: null };
  }
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
    source: entry.source,
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

function titleForTool(connectorSlug: string, actionPath: string): string {
  return `${connectorSlug}.${actionPath}`
    .split(/[._-]/)
    .filter(Boolean)
    .map(capitalize)
    .join(' ');
}

function isCatalogRisk(value: unknown): value is CatalogExecutorAction['risk'] {
  return value === 'read' || value === 'write' || value === 'destructive';
}

function publicDetail(value: unknown): unknown {
  return isSafePublicJson(value) ? value : { type: 'object' };
}

/**
 * Connector catalogs originate outside the trust boundary. Publish only the
 * form shape required to invoke a tool, never values such as examples/defaults
 * or vendor extensions that can embed credentials.
 */
function projectExternalInputSchema(value: Record<string, unknown>): Record<string, unknown> {
  return projectExternalSchemaNode(value, 0) ?? { type: 'object' };
}

function projectExternalSchemaNode(
  value: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (!isJsonObject(value) || depth > 8) return null;

  const projected: Record<string, unknown> = {};
  if (isPublicSchemaType(value.type)) projected.type = value.type;

  const properties = value.properties;
  if (isJsonObject(properties)) {
    const publicProperties: Record<string, Record<string, unknown>> = {};
    for (const [name, child] of Object.entries(properties).slice(0, 50)) {
      if (!isSafeSchemaPropertyName(name)) continue;
      const publicChild = projectExternalSchemaNode(child, depth + 1);
      if (publicChild) publicProperties[name] = publicChild;
    }
    if (Object.keys(publicProperties).length > 0) {
      projected.properties = publicProperties;
      if (Array.isArray(value.required)) {
        const required: string[] = [];
        const seen = new Set<string>();
        for (const name of value.required) {
          if (required.length >= 50) break;
          if (
            typeof name === 'string' &&
            Object.prototype.hasOwnProperty.call(publicProperties, name) &&
            !seen.has(name)
          ) {
            seen.add(name);
            required.push(name);
          }
        }
        if (required.length > 0) projected.required = required;
      }
    }
  }

  const items = projectExternalSchemaNode(value.items, depth + 1);
  if (items) projected.items = items;
  if (isPublicInputLocation(value['x-in'])) projected['x-in'] = value['x-in'];
  if (typeof value.additionalProperties === 'boolean') {
    projected.additionalProperties = value.additionalProperties;
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    const constraint = value[key];
    if (typeof constraint === 'number' && Number.isFinite(constraint)) projected[key] = constraint;
  }

  return Object.keys(projected).length > 0 ? projected : { type: 'object' };
}

function isPublicSchemaType(value: unknown): value is string {
  return (
    value === 'object' ||
    value === 'array' ||
    value === 'string' ||
    value === 'number' ||
    value === 'integer' ||
    value === 'boolean' ||
    value === 'null'
  );
}

function isPublicInputLocation(value: unknown): value is 'path' | 'query' | 'header' {
  return value === 'path' || value === 'query' || value === 'header';
}

function isSafeSchemaPropertyName(value: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    !isSensitivePublicKey(value) &&
    !hasUnsafeCatalogCredentialLiteral(value)
  );
}

function isSafePublicJson(value: unknown): boolean {
  if (typeof value === 'string') {
    return !PRIVATE_TEXT.test(value) && !hasUnsafeCatalogCredentialLiteral(value);
  }
  if (Array.isArray(value)) return value.every(isSafePublicJson);
  if (!value || typeof value !== 'object') return true;
  return Object.entries(value as Record<string, unknown>).every(([key, child]) => {
    if (isSensitivePublicKey(key)) return false;
    return isSafePublicJson(child);
  });
}

function isSensitivePublicKey(key: string): boolean {
  const separated = key.replace(/([a-z\d])([A-Z])/g, '$1_$2');
  if (SENSITIVE_PUBLIC_KEY_PATTERN.test(separated)) return true;
  return isRawProviderMetadataKey(separated.replace(/[^a-z\d]/gi, '').toLowerCase());
}

function isRawProviderMetadataKey(normalized: string): boolean {
  return (
    normalized === 'raw' ||
    normalized === 'rawdata' ||
    /^raw(?:provider|request|response)?(?:body|payload|request|response)$/.test(normalized) ||
    /^provider(?:request|response)(?:body|payload)?$/.test(normalized) ||
    /^(?:request|response)(?:body|payload)$/.test(normalized)
  );
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}
