import { z } from 'zod';
import { AutomationProtocolVersionSchema } from './compatibility.js';

export const AUTOMATION_MAX_STEPS = 128 as const;

const UuidSchema = z.string().uuid();
const DateTimeSchema = z.string().datetime({ offset: true });
const Sha256HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const TraceParentSchema = z
  .string()
  .regex(/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/)
  .refine((value) => {
    const [, traceId, parentId] = value.split('-');
    return traceId !== '0'.repeat(32) && parentId !== '0'.repeat(16);
  }, 'traceparent identifiers cannot be all zeroes');
const IdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$/);
const PublicTextSchema = z.string().trim().min(1).max(256);

const AutomationJsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string().max(32_768),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(AutomationJsonValueSchema).max(256),
    AutomationJsonObjectSchema,
  ]),
);
const AutomationJsonObjectSchema: z.ZodType<Record<string, unknown>> = z
  .record(z.string().min(1).max(128), AutomationJsonValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 256) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'array',
        maximum: 256,
        inclusive: true,
        message: 'automation object has too many keys',
      });
    }
  });

function isFutureDateTime(value: string): boolean {
  return Date.parse(value) > Date.now();
}

function hasUniqueValues(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length;
}

const OriginSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
        parsed.username === '' &&
        parsed.password === '' &&
        parsed.pathname === '/' &&
        parsed.search === '' &&
        parsed.hash === ''
      );
    } catch {
      return false;
    }
  }, 'allowed origin must contain only scheme, host, and optional port');

export const AutomationExecutionDomainSchema = z.enum(['browser', 'desktop']);
export type AutomationExecutionDomain = z.infer<typeof AutomationExecutionDomainSchema>;

export const AutomationRiskSchema = z.enum(['observe', 'operate', 'external_effect']);
export type AutomationRisk = z.infer<typeof AutomationRiskSchema>;

export const AutomationJobStatusSchema = z.enum([
  'queued',
  'awaiting_approval',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'retryable',
]);
export type AutomationJobStatus = z.infer<typeof AutomationJobStatusSchema>;

export const AutomationStepSchema = z
  .object({
    step_id: UuidSchema,
    sequence: z.number().int().positive().max(1_000_000),
    action: IdentifierSchema,
    args: AutomationJsonObjectSchema,
    risk: AutomationRiskSchema,
    action_hash: Sha256HashSchema,
  })
  .strict();
export type AutomationStep = z.infer<typeof AutomationStepSchema>;

export const AutomationCapabilityRequirementSchema = z
  .object({
    capability: IdentifierSchema,
    methods: z
      .array(IdentifierSchema)
      .min(1)
      .max(64)
      .refine(hasUniqueValues, 'capability methods must be unique'),
    scope: AutomationJsonObjectSchema,
  })
  .strict();
export type AutomationCapabilityRequirement = z.infer<typeof AutomationCapabilityRequirementSchema>;

const BrowserContextPolicySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('temporary'), profile_id: z.null() }).strict(),
  z.object({ mode: z.literal('persistent'), profile_id: UuidSchema }).strict(),
]);

const StoredBrowserPolicySchema = z
  .object({
    allowed_origins: z
      .array(OriginSchema)
      .min(1)
      .max(64)
      .refine(hasUniqueValues, 'allowed origins must be unique'),
    network_mode: z.enum(['allowlist', 'open']),
    open_network_expires_at: DateTimeSchema.nullable(),
    context: BrowserContextPolicySchema,
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.network_mode === 'open' && policy.open_network_expires_at === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['open_network_expires_at'],
        message: 'open network mode requires an expiry',
      });
    }
    if (policy.network_mode === 'allowlist' && policy.open_network_expires_at !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['open_network_expires_at'],
        message: 'allowlist mode cannot carry an open network expiry',
      });
    }
  });

export const BrowserPolicySchema = StoredBrowserPolicySchema.superRefine((policy, context) => {
  if (
    policy.network_mode === 'open' &&
    policy.open_network_expires_at !== null &&
    !isFutureDateTime(policy.open_network_expires_at)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['open_network_expires_at'],
      message: 'open network expiry must be in the future',
    });
  }
});
export type BrowserPolicy = z.infer<typeof BrowserPolicySchema>;

const StoredDesktopPolicySchema = z
  .object({
    device_id: UuidSchema,
    allowed_applications: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
      )
      .min(1)
      .max(128)
      .refine(hasUniqueValues, 'allowed applications must be unique'),
    full_access_expires_at: DateTimeSchema.nullable(),
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const DesktopPolicySchema = StoredDesktopPolicySchema.superRefine((policy, context) => {
  if (policy.full_access_expires_at !== null && !isFutureDateTime(policy.full_access_expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['full_access_expires_at'],
      message: 'full access expiry must be in the future',
    });
  }
});
export type DesktopPolicy = z.infer<typeof DesktopPolicySchema>;

const AutomationJobRequestCommonShape = {
  protocol_version: AutomationProtocolVersionSchema,
  tenant_id: UuidSchema,
  project_id: UuidSchema,
  source_run_id: UuidSchema.nullable(),
  execution_domain: AutomationExecutionDomainSchema,
  steps: z.array(AutomationStepSchema).min(1).max(AUTOMATION_MAX_STEPS),
  capability_requirements: z.array(AutomationCapabilityRequirementSchema).min(1).max(128),
  approval_policy: z.enum(['project-default', 'full-access']),
  idempotency_key: z.string().trim().min(16).max(255),
  deadline_at: DateTimeSchema,
  traceparent: TraceParentSchema.nullable(),
} as const;

const AutomationJobRequestBaseSchema = z
  .object({
    ...AutomationJobRequestCommonShape,
    browser_policy: BrowserPolicySchema.nullable(),
    desktop_policy: DesktopPolicySchema.nullable(),
  })
  .strict();

const StoredAutomationJobRequestBaseSchema = z
  .object({
    ...AutomationJobRequestCommonShape,
    browser_policy: StoredBrowserPolicySchema.nullable(),
    desktop_policy: StoredDesktopPolicySchema.nullable(),
  })
  .strict();

function validateAutomationRequest(
  request: z.infer<typeof StoredAutomationJobRequestBaseSchema>,
  context: z.RefinementCtx,
  requireFutureDeadline: boolean,
): void {
  if (!hasUniqueValues(request.steps.map((step) => step.sequence))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: 'automation step sequences must be unique',
    });
  }
  if (!hasUniqueValues(request.steps.map((step) => step.step_id))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['steps'],
      message: 'automation step ids must be unique',
    });
  }
  if (requireFutureDeadline && !isFutureDateTime(request.deadline_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['deadline_at'],
      message: 'automation deadline must be in the future',
    });
  }
  const hasBrowserPolicy = request.browser_policy !== null;
  const hasDesktopPolicy = request.desktop_policy !== null;
  if (
    (request.execution_domain === 'browser' && (!hasBrowserPolicy || hasDesktopPolicy)) ||
    (request.execution_domain === 'desktop' && (!hasDesktopPolicy || hasBrowserPolicy))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['execution_domain'],
      message: 'execution domain must have exactly one matching policy',
    });
  }
}

export const AutomationJobRequestSchema = AutomationJobRequestBaseSchema.superRefine(
  (request, context) => validateAutomationRequest(request, context, true),
);
const StoredAutomationJobRequestSchema = StoredAutomationJobRequestBaseSchema.superRefine(
  (request, context) => validateAutomationRequest(request, context, false),
);
export type AutomationJobRequest = z.infer<typeof AutomationJobRequestSchema>;

export const AutomationEventTypeSchema = z.enum([
  'job_queued',
  'approval_required',
  'job_dispatched',
  'job_started',
  'step_started',
  'step_completed',
  'job_succeeded',
  'job_failed',
  'job_cancelled',
  'job_expired',
  'kill_switch_activated',
  'heartbeat',
]);
export type AutomationEventType = z.infer<typeof AutomationEventTypeSchema>;

export const AutomationEventSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    event_id: UuidSchema,
    job_id: UuidSchema,
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    type: AutomationEventTypeSchema,
    status: AutomationJobStatusSchema.nullable(),
    payload: AutomationJsonObjectSchema,
    trace_id: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .nullable(),
    created_at: DateTimeSchema,
  })
  .strict();
export type AutomationEvent = z.infer<typeof AutomationEventSchema>;

export const AutomationJobSchema = z
  .object({
    job_id: UuidSchema,
    account_id: UuidSchema,
    actor_user_id: UuidSchema,
    request: StoredAutomationJobRequestSchema,
    request_hash: Sha256HashSchema,
    status: AutomationJobStatusSchema,
    policy_version: z.string().trim().min(1).max(128),
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    created_at: DateTimeSchema,
    updated_at: DateTimeSchema,
    terminal_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.account_id !== job.request.tenant_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['account_id'],
        message: 'job account does not match request tenant',
      });
    }
    if (Date.parse(job.updated_at) < Date.parse(job.created_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updated_at'],
        message: 'job update cannot precede creation',
      });
    }
  });
export type AutomationJob = z.infer<typeof AutomationJobSchema>;

export const AutomationApprovalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'consumed',
]);
export type AutomationApprovalStatus = z.infer<typeof AutomationApprovalStatusSchema>;

export const AutomationApprovalSchema = z
  .object({
    approval_id: UuidSchema,
    job_id: UuidSchema,
    step_id: UuidSchema,
    project_id: UuidSchema,
    action_hash: Sha256HashSchema,
    status: AutomationApprovalStatusSchema,
    acting_user_id: UuidSchema.nullable(),
    expires_at: DateTimeSchema,
    resolved_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((approval, context) => {
    const pendingIsUnresolved =
      approval.status === 'pending' &&
      approval.acting_user_id === null &&
      approval.resolved_at === null;
    const terminalIsResolved = approval.status !== 'pending' && approval.resolved_at !== null;
    if (!pendingIsUnresolved && !terminalIsResolved) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'approval lifecycle is inconsistent',
      });
    }
    if (
      (approval.status === 'approved' ||
        approval.status === 'rejected' ||
        approval.status === 'consumed') &&
      approval.acting_user_id === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acting_user_id'],
        message: 'resolved approval requires an acting user',
      });
    }
  });
export type AutomationApproval = z.infer<typeof AutomationApprovalSchema>;

export const AutomationLeaseSchema = z
  .object({
    lease_id: UuidSchema,
    job_id: UuidSchema,
    project_id: UuidSchema,
    execution_domain: AutomationExecutionDomainSchema,
    owner: z.string().trim().min(1).max(128),
    permission_id: UuidSchema.nullable(),
    request_hash: Sha256HashSchema,
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    issued_at: DateTimeSchema,
    expires_at: DateTimeSchema,
    signature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((lease, context) => {
    if (Date.parse(lease.expires_at) <= Date.parse(lease.issued_at)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expires_at'],
        message: 'lease expiry must follow issuance',
      });
    }
  });
export type AutomationLease = z.infer<typeof AutomationLeaseSchema>;

export const KillSwitchScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), account_id: UuidSchema }).strict(),
  z.object({ kind: z.literal('project'), account_id: UuidSchema, project_id: UuidSchema }).strict(),
  z
    .object({
      kind: z.literal('device'),
      account_id: UuidSchema,
      project_id: UuidSchema,
      device_id: UuidSchema,
    })
    .strict(),
]);
export type KillSwitchScope = z.infer<typeof KillSwitchScopeSchema>;

export const KillSwitchSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    scope: KillSwitchScopeSchema,
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    active: z.boolean(),
    actor_user_id: UuidSchema,
    audit_event_id: UuidSchema,
    activated_at: DateTimeSchema,
    released_at: DateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((killSwitch, context) => {
    if (killSwitch.active === (killSwitch.released_at !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['released_at'],
        message: 'kill-switch lifecycle is inconsistent',
      });
    }
  });
export type KillSwitch = z.infer<typeof KillSwitchSchema>;

export const AutomationErrorCodeSchema = z.enum([
  'AUTOMATION_UNAVAILABLE',
  'AUTOMATION_INVALID_REQUEST',
  'AUTOMATION_UNAUTHORIZED',
  'AUTOMATION_FORBIDDEN',
  'AUTOMATION_NOT_FOUND',
  'AUTOMATION_CONFLICT',
  'AUTOMATION_APPROVAL_REQUIRED',
  'AUTOMATION_LEASE_EXPIRED',
  'AUTOMATION_KILLED',
  'AUTOMATION_INTERNAL',
]);
export type AutomationErrorCode = z.infer<typeof AutomationErrorCodeSchema>;

export const AutomationErrorSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    code: AutomationErrorCodeSchema,
    message: PublicTextSchema,
    retryable: z.boolean(),
    approval_status: AutomationApprovalStatusSchema.nullable(),
    audit_event_id: UuidSchema.nullable(),
  })
  .strict();
export type AutomationError = z.infer<typeof AutomationErrorSchema>;
