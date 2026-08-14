import { z } from 'zod';

export const OPENOPC_MODULE_SETTING_MAX_VALUE_BYTES = 65_536;
export const OPENOPC_MODULE_SETTING_MAX_ENTRIES = 128;

const SENSITIVE_SETTING_KEY =
  /(^|[._-])(api[_-]?key|token|secret|password|credential|authorization|cookie|provider|base[_-]?url|endpoint)([._-]|$)/i;

export const OpenOpcModuleSettingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_.-]*$/)
  .refine((value) => !SENSITIVE_SETTING_KEY.test(value), 'setting key must be non-sensitive');
export type OpenOpcModuleSettingKey = z.infer<typeof OpenOpcModuleSettingKeySchema>;

export const OpenOpcModuleSettingValueSchema = z.union([
  z.string().max(OPENOPC_MODULE_SETTING_MAX_VALUE_BYTES),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type OpenOpcModuleSettingValue = z.infer<typeof OpenOpcModuleSettingValueSchema>;

export const OpenOpcModuleSettingValuesSchema = z
  .record(OpenOpcModuleSettingKeySchema, OpenOpcModuleSettingValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > OPENOPC_MODULE_SETTING_MAX_ENTRIES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `settings may contain at most ${OPENOPC_MODULE_SETTING_MAX_ENTRIES} entries`,
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 128 * 1024) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'settings must be at most 131072 UTF-8 bytes',
      });
    }
  });
export type OpenOpcModuleSettingValues = z.infer<typeof OpenOpcModuleSettingValuesSchema>;

export const OpenOpcModuleSettingsPutInputSchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    values: OpenOpcModuleSettingValuesSchema,
  })
  .strict();
export type OpenOpcModuleSettingsPutInput = z.infer<typeof OpenOpcModuleSettingsPutInputSchema>;

export const OpenOpcEffectiveModuleSettingsSchema = z
  .object({
    schema_version: z.literal(1),
    revision: z.number().int().nonnegative(),
    values: OpenOpcModuleSettingValuesSchema,
    loaded_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type OpenOpcEffectiveModuleSettings = z.infer<typeof OpenOpcEffectiveModuleSettingsSchema>;
