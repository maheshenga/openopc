import { z } from 'zod';

const CatalogIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/);

const CatalogVersionSchema = z
  .string()
  .trim()
  .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/)
  .max(64);

const UnsafePublicTextPattern =
  /(?:https?:\/\/|["']?\s*(?:api[_-]?key|secret|token|access[_-]?token|password|credential|authorization|cookie|signed[_-]?url|provider[_-]?url|base[_-]?url|signature|x[_-]?amz)\s*["']?\s*[:=]|\bbearer\s+[A-Za-z0-9._-]{8,})/i;

const PublicCatalogTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !UnsafePublicTextPattern.test(value), {
    message: 'catalog text contains a private value',
  });

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
    cursor: z.number().int().nonnegative().max(1_000_000).nullable().default(null),
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
    next_cursor: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type CapabilityCatalogSearchResponse = z.infer<
  typeof CapabilityCatalogSearchResponseSchema
>;

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
