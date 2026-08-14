import { z } from 'zod';

export const OPENOPC_MODULE_DOCUMENT_MAX_BYTES = 2_000_000;
export const OPENOPC_MODULE_ASSET_MAX_BYTES = 100 * 1024 * 1024;
export const OPENOPC_MODULE_ASSET_MIME_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
] as const;

export const OpenOpcModuleDocumentKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes('//') &&
      value.split('/').every((segment) => segment !== '.' && segment !== '..'),
    'document key must be a safe relative key',
  );
export type OpenOpcModuleDocumentKey = z.infer<typeof OpenOpcModuleDocumentKeySchema>;

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(OPENOPC_MODULE_DOCUMENT_MAX_BYTES),
    z.array(JsonValueSchema).max(100_000),
    z.record(z.string().min(1).max(256), JsonValueSchema),
  ]),
);

export const OpenOpcModuleDocumentValueSchema = JsonValueSchema.superRefine((value, context) => {
  let encoded: Uint8Array;
  try {
    encoded = new TextEncoder().encode(JSON.stringify(value));
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'document value must be JSON' });
    return;
  }
  if (encoded.byteLength > OPENOPC_MODULE_DOCUMENT_MAX_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `document value must be at most ${OPENOPC_MODULE_DOCUMENT_MAX_BYTES} UTF-8 bytes`,
    });
  }
});
export type OpenOpcModuleDocumentValue = z.infer<typeof OpenOpcModuleDocumentValueSchema>;

export const OpenOpcModuleDocumentWriteInputSchema = z
  .object({
    key: OpenOpcModuleDocumentKeySchema,
    expected_revision: z.number().int().positive().nullable(),
    value: OpenOpcModuleDocumentValueSchema,
  })
  .strict();
export type OpenOpcModuleDocumentWriteInput = z.infer<typeof OpenOpcModuleDocumentWriteInputSchema>;

export const OpenOpcModuleDocumentSchema = z
  .object({
    key: OpenOpcModuleDocumentKeySchema,
    revision: z.number().int().positive(),
    etag: z.string().regex(/^"rev-[1-9][0-9]*"$/),
    value: OpenOpcModuleDocumentValueSchema,
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcModuleDocument = z.infer<typeof OpenOpcModuleDocumentSchema>;

export const OpenOpcModuleDocumentListInputSchema = z
  .object({
    cursor: z.string().min(1).max(512).nullable().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict();
export type OpenOpcModuleDocumentListInput = z.infer<typeof OpenOpcModuleDocumentListInputSchema>;

export const OpenOpcModuleDocumentPageSchema = z
  .object({
    data: z.array(OpenOpcModuleDocumentSchema).max(100),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();
export type OpenOpcModuleDocumentPage = z.infer<typeof OpenOpcModuleDocumentPageSchema>;

export const OpenOpcModuleDocumentDeleteInputSchema = z
  .object({
    key: OpenOpcModuleDocumentKeySchema,
    expected_revision: z.number().int().positive(),
  })
  .strict();
export type OpenOpcModuleDocumentDeleteInput = z.infer<
  typeof OpenOpcModuleDocumentDeleteInputSchema
>;

export const OpenOpcModuleAssetMimeTypeSchema = z.enum(OPENOPC_MODULE_ASSET_MIME_TYPES);
export type OpenOpcModuleAssetMimeType = z.infer<typeof OpenOpcModuleAssetMimeTypeSchema>;

function isSafeAssetFilename(value: string): boolean {
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return character === '/' || character === '\\' || code < 32 || code === 127;
  });
}

const ModuleAssetFilenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeAssetFilename, 'filename contains unsafe characters');

export const OpenOpcModuleAssetCreateInputSchema = z
  .object({
    filename: ModuleAssetFilenameSchema,
    mime_type: OpenOpcModuleAssetMimeTypeSchema,
    size_bytes: z.number().int().positive().max(OPENOPC_MODULE_ASSET_MAX_BYTES),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type OpenOpcModuleAssetCreateInput = z.infer<typeof OpenOpcModuleAssetCreateInputSchema>;

export const OpenOpcModuleAssetSchema = z
  .object({
    asset_id: z.string().uuid(),
    filename: ModuleAssetFilenameSchema,
    mime_type: OpenOpcModuleAssetMimeTypeSchema,
    size_bytes: z.number().int().positive().max(OPENOPC_MODULE_ASSET_MAX_BYTES),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcModuleAsset = z.infer<typeof OpenOpcModuleAssetSchema>;
