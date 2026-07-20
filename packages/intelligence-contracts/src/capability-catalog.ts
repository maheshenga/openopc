import { z } from 'zod';

const UnsafeCatalogIdentifierPattern =
  /(?:^|[._-])(?:api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz|bearer|(?:raw(?:[_-](?:provider|request|response))*|provider(?:[_-](?:request|response))?)[_-](?:body|payload)|headers?)(?:[._-]|$)/i;
const UnsafeCredentialLiteralPattern =
  /(?:\bsk[-_](?:(?:proj|live|test)[-_])?[A-Za-z0-9_-]{20,}\b|\bAIza[0-9A-Za-z_-]{30,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/;

const CatalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/)
  .refine((value) => !hasUnsafeCatalogIdentifier(value), {
    message: 'catalog identifier contains private metadata',
  });

const CatalogVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
  .max(64);

const UnsafePublicTextPattern =
  /(?:https?:\/\/|["']?\s*(?:api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz)\s*["']?\s*[:=]|\bbearer\s+[A-Za-z0-9._-]{8,})/i;

export const CAPABILITY_CATALOG_MAX_CURSOR = 1_000_000;

function hasUnsafeCatalogIdentifier(value: string): boolean {
  if (hasUnsafeCatalogCredentialLiteral(value)) return true;
  const separated = value.replace(/([a-z\d])([A-Z])/g, '$1_$2');
  if (UnsafeCatalogIdentifierPattern.test(separated)) return true;
  const segments = separated.split(/[._-]/).filter(Boolean);
  for (let start = 0; start < segments.length; start += 1) {
    for (let end = start + 1; end <= Math.min(start + 4, segments.length); end += 1) {
      if (isRawProviderMetadataKey(segments.slice(start, end).join('').toLowerCase())) return true;
    }
  }
  return false;
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

const PublicCatalogTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) => !UnsafePublicTextPattern.test(value) && !hasUnsafeCatalogCredentialLiteral(value),
    {
    message: 'catalog text contains a private value',
    },
  );

export function hasUnsafeCatalogCredentialLiteral(value: string): boolean {
  return UnsafeCredentialLiteralPattern.test(value);
}

export const CapabilityCatalogRefSchema = z
  .object({
    kind: z.enum(['capability', 'tool', 'module']),
    id: CatalogIdSchema,
    version: CatalogVersionSchema,
  })
  .strict();
export type CapabilityCatalogRef = z.infer<typeof CapabilityCatalogRefSchema>;

export function formatCapabilityCatalogRef(ref: CapabilityCatalogRef): string {
  return `${ref.kind}:${ref.id}@${ref.version}`;
}

export const CapabilityCatalogSearchInputSchema = z
  .object({
    projectId: z.string().uuid(),
    query: z.string().trim().max(512).default(''),
    limit: z.number().int().positive().max(50).default(20),
    cursor: z.number().int().nonnegative().max(CAPABILITY_CATALOG_MAX_CURSOR).nullable().default(null),
  })
  .strict();
export type CapabilityCatalogSearchInput = z.infer<typeof CapabilityCatalogSearchInputSchema>;

export const CapabilityCatalogItemSchema = z
  .object({
    ref: CapabilityCatalogRefSchema,
    title: PublicCatalogTextSchema,
    summary: PublicCatalogTextSchema,
    risk: z.enum(['read', 'write', 'destructive']),
    availability: z.enum(['available', 'requires_setup', 'unavailable']),
    capability_id: CatalogIdSchema.nullable(),
    executable: z.boolean(),
    source: z.enum(['studio', 'executor', 'mcp', 'module']),
  })
  .strict();
export type CapabilityCatalogItem = z.infer<typeof CapabilityCatalogItemSchema>;

export const CapabilityCatalogSearchResponseSchema = z
  .object({
    protocol_version: z.literal('intelligence.v1'),
    items: z.array(CapabilityCatalogItemSchema).max(50),
    next_cursor: z.number().int().nonnegative().max(CAPABILITY_CATALOG_MAX_CURSOR).nullable(),
  })
  .strict();
export type CapabilityCatalogSearchResponse = z.infer<
  typeof CapabilityCatalogSearchResponseSchema
>;

const PUBLIC_CATALOG_SCHEMA_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);
const PUBLIC_CATALOG_SCHEMA_KEYS = new Set([
  'type',
  'name',
  'properties',
  'required',
  'items',
  'x-in',
  'additionalProperties',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);
const PUBLIC_CATALOG_SCHEMA_CONSTRAINTS = new Set([
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
]);

/**
 * Catalog descriptions are a form-schema projection, not a transport for
 * provider metadata. Restrict the wire shape so arbitrary literals in
 * defaults, examples, descriptions, or vendor extensions cannot escape.
 */
export function isPublicCatalogInputSchema(value: unknown): value is Record<string, unknown> {
  return isPublicCatalogInputSchemaNode(value, 0);
}

function isPublicCatalogInputSchemaNode(value: unknown, depth: number): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PUBLIC_CATALOG_SCHEMA_KEYS.has(key))) return false;

  if (record.type !== undefined && (!isPublicCatalogSchemaType(record.type))) return false;
  if (record.name !== undefined && !isSafeCatalogSchemaName(record.name)) return false;
  if (record['x-in'] !== undefined && !isPublicCatalogInputLocation(record['x-in'])) {
    return false;
  }
  if (
    record.additionalProperties !== undefined &&
    typeof record.additionalProperties !== 'boolean'
  ) {
    return false;
  }
  for (const key of PUBLIC_CATALOG_SCHEMA_CONSTRAINTS) {
    if (record[key] !== undefined && !isFiniteSchemaConstraint(record[key])) return false;
  }

  const properties = record.properties;
  if (properties !== undefined) {
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
    const propertyEntries = Object.entries(properties as Record<string, unknown>);
    if (
      propertyEntries.length > 50 ||
      propertyEntries.some(
        ([name, schema]) =>
          !isSafeCatalogSchemaPropertyName(name) ||
          !isPublicCatalogInputSchemaNode(schema, depth + 1),
      )
    ) {
      return false;
    }
  }

  const required = record.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.length > 50 || !properties || typeof properties !== 'object') {
      return false;
    }
    const propertyNames = new Set(Object.keys(properties as Record<string, unknown>));
    const requiredNames = new Set<string>();
    for (const name of required) {
      if (typeof name !== 'string' || !propertyNames.has(name) || requiredNames.has(name)) return false;
      requiredNames.add(name);
    }
  }

  if (record.items !== undefined && !isPublicCatalogInputSchemaNode(record.items, depth + 1)) {
    return false;
  }
  return true;
}

function isPublicCatalogSchemaType(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_CATALOG_SCHEMA_TYPES.has(value);
}

function isPublicCatalogInputLocation(value: unknown): value is 'path' | 'query' | 'header' {
  return value === 'path' || value === 'query' || value === 'header';
}

function isSafeCatalogSchemaName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    !hasUnsafeCatalogIdentifier(value)
  );
}

function isSafeCatalogSchemaPropertyName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value) &&
    !hasUnsafeCatalogIdentifier(value)
  );
}

function isFiniteSchemaConstraint(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Framework-neutral catalog boundary. Project/actor authorization is supplied
 * by the API adapter rather than becoming part of the public catalog wire
 * contract.
 */
export interface CapabilityCatalogPort {
  search(input: CapabilityCatalogSearchInput): Promise<{
    items: CapabilityCatalogItem[];
    next_cursor: number | null;
  }>;
  describe(input: {
    projectId: string;
    ref: CapabilityCatalogRef;
  }): Promise<unknown | null>;
}
