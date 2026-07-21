import { z } from 'zod';

const AutomationControlEnvironmentSchema = z
  .object({
    AUTOMATION_CONTROL_ENABLED: z.enum(['true', 'false']).default('false'),
    AUTOMATION_CONTROL_PORT: z.coerce.number().int().min(1).max(65_535).default(4011),
    DATABASE_URL: z.string().trim().default(''),
    REDIS_URL: z.string().trim().default(''),
    AUTOMATION_SERVICE_ID: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/)
      .default('automation-control'),
    AUTOMATION_CONTROL_SHARED_SECRET: z.string().max(4_096).default(''),
    AUTOMATION_LEASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .default(30_000),
  })
  .superRefine((environment, context) => {
    if (environment.AUTOMATION_CONTROL_ENABLED !== 'true') return;

    if (!/^postgres(?:ql)?:\/\//.test(environment.DATABASE_URL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must be a PostgreSQL URL when automation control is enabled',
      });
    }
    if (!/^rediss?:\/\//.test(environment.REDIS_URL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL must be a Redis URL when automation control is enabled',
      });
    }
    if (environment.AUTOMATION_CONTROL_SHARED_SECRET.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.too_small,
        type: 'string',
        minimum: 32,
        inclusive: true,
        path: ['AUTOMATION_CONTROL_SHARED_SECRET'],
        message: 'AUTOMATION_CONTROL_SHARED_SECRET must contain at least 32 characters',
      });
    }
  });

export type AutomationControlConfig = Readonly<{
  enabled: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  serviceId: string;
  sharedSecret: string;
  leaseMs: number;
}>;

export function loadAutomationControlConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AutomationControlConfig {
  const parsed = AutomationControlEnvironmentSchema.parse(environment);
  return Object.freeze({
    enabled: parsed.AUTOMATION_CONTROL_ENABLED === 'true',
    port: parsed.AUTOMATION_CONTROL_PORT,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    serviceId: parsed.AUTOMATION_SERVICE_ID,
    sharedSecret: parsed.AUTOMATION_CONTROL_SHARED_SECRET,
    leaseMs: parsed.AUTOMATION_LEASE_MS,
  });
}
