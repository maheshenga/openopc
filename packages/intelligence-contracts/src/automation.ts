import { z } from 'zod';
import { AutomationProtocolVersionSchema } from './compatibility.js';

export const AUTOMATION_MAX_STEPS = 128 as const;
export const AUTOMATION_BROWSER_HEARTBEAT_PATH = '/internal/automation/browser/heartbeat' as const;
export const AUTOMATION_BROWSER_DISPATCH_PATH = '/internal/automation/browser/dispatch' as const;
export const AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH =
  '/internal/automation/browser/approvals/consume' as const;

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
const BrowserUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  }, 'browser URL must use HTTP(S) without embedded credentials');

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

function canonicalizeAutomationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeAutomationValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalizeAutomationValue(entry)]),
    );
  }
  return value;
}

export function canonicalAutomationRequestJson(value: unknown): string {
  return JSON.stringify(canonicalizeAutomationValue(value));
}

export function canonicalAutomationWorkerProof(input: {
  timestamp: string;
  serviceId: string;
  certificateFingerprint256: string;
  nonce: number;
  bodySha256: string;
}): string {
  return [
    input.timestamp,
    input.serviceId,
    input.certificateFingerprint256,
    input.nonce,
    input.bodySha256,
  ].join('\n');
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

const BrowserSelectorSchema = z.string().trim().min(1).max(4_096);
const BrowserSelectorArgsSchema = z.object({ selector: BrowserSelectorSchema }).strict();
const BrowserPointArgsSchema = z
  .object({
    x: z.number().finite().min(0).max(100_000),
    y: z.number().finite().min(0).max(100_000),
  })
  .strict();

export const BrowserAutomationStepSchema = z.discriminatedUnion('action', [
  AutomationStepSchema.extend({
    action: z.literal('browser.navigate'),
    args: z.object({ url: BrowserUrlSchema }).strict(),
    risk: z.literal('operate'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.click'),
    args: z.union([BrowserSelectorArgsSchema, BrowserPointArgsSchema]),
    risk: z.literal('operate'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.type'),
    args: z.object({ selector: BrowserSelectorSchema, value: z.string().max(32_768) }).strict(),
    risk: z.literal('operate'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.read'),
    args: BrowserSelectorArgsSchema,
    risk: z.literal('observe'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.screenshot'),
    args: z.object({}).strict(),
    risk: z.literal('observe'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.wait'),
    args: z.object({ milliseconds: z.number().int().positive().max(30_000) }).strict(),
    risk: z.literal('observe'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.submit'),
    args: BrowserSelectorArgsSchema,
    risk: z.literal('external_effect'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.payment'),
    args: BrowserSelectorArgsSchema,
    risk: z.literal('external_effect'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.delete'),
    args: BrowserSelectorArgsSchema,
    risk: z.literal('external_effect'),
  }),
  AutomationStepSchema.extend({
    action: z.literal('browser.send'),
    args: BrowserSelectorArgsSchema,
    risk: z.literal('external_effect'),
  }),
]);
export type BrowserAutomationStep = z.infer<typeof BrowserAutomationStepSchema>;

export const BROWSER_AUTOMATION_ACTION_RISKS = Object.freeze({
  'browser.navigate': 'operate',
  'browser.click': 'operate',
  'browser.type': 'operate',
  'browser.read': 'observe',
  'browser.screenshot': 'observe',
  'browser.wait': 'observe',
  'browser.submit': 'external_effect',
  'browser.payment': 'external_effect',
  'browser.delete': 'external_effect',
  'browser.send': 'external_effect',
} satisfies Readonly<Record<BrowserAutomationStep['action'], AutomationRisk>>);

export function browserAutomationRiskForAction(action: string): AutomationRisk | null {
  if (!Object.hasOwn(BROWSER_AUTOMATION_ACTION_RISKS, action)) return null;
  return BROWSER_AUTOMATION_ACTION_RISKS[action as keyof typeof BROWSER_AUTOMATION_ACTION_RISKS];
}

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

export const AutomationWorkerServiceProofSchema = z
  .object({
    service_id: z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/),
    timestamp: DateTimeSchema,
    nonce: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    signature: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type AutomationWorkerServiceProof = z.infer<typeof AutomationWorkerServiceProofSchema>;

const AutomationWorkerTraceIdSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/)
  .nullable();
const AutomationWorkerUnvalidatedEventIntentSchema = z
  .object({
    type: z.string().trim().min(1).max(128),
    payload: z.record(z.unknown()),
    trace_id: AutomationWorkerTraceIdSchema,
  })
  .strict();

export const AutomationWorkerHeartbeatEventIntentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('heartbeat'),
      payload: z
        .object({
          last_completed_step: z.number().int().nonnegative().max(AUTOMATION_MAX_STEPS),
        })
        .strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('approval_required'),
      payload: z.object({ step_id: UuidSchema, action_hash: Sha256HashSchema }).strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('job_started'),
      payload: z.object({}).strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('step_started'),
      payload: z.object({ step_id: UuidSchema }).strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('step_completed'),
      payload: z
        .object({
          step_id: UuidSchema,
          evidence_reference: z
            .string()
            .refine(
              (value) =>
                value.startsWith('evidence:') &&
                UuidSchema.safeParse(value.slice('evidence:'.length)).success,
              'evidence reference must be an evidence UUID',
            ),
        })
        .strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('job_succeeded'),
      payload: z.object({}).strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('job_failed'),
      payload: z
        .object({ cleanup_error_count: z.number().int().nonnegative(), project_id: UuidSchema })
        .strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('kill_switch_activated'),
      payload: z
        .object({
          project_id: UuidSchema,
          reason: z.enum(['generation_changed', 'signal_abort']),
        })
        .strict(),
      trace_id: AutomationWorkerTraceIdSchema,
    })
    .strict(),
]);
export type AutomationWorkerHeartbeatEventIntent = z.infer<
  typeof AutomationWorkerHeartbeatEventIntentSchema
>;

export const AutomationWorkerHeartbeatEnvelopeSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    account_id: UuidSchema,
    project_id: UuidSchema,
    job_id: UuidSchema,
    lease_id: UuidSchema,
    lease_owner: z.string().trim().min(1).max(128),
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    worker_id: z.string().trim().min(1).max(128),
    ordinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observed_at: DateTimeSchema,
    event: AutomationWorkerUnvalidatedEventIntentSchema,
  })
  .strict();

export const AutomationWorkerHeartbeatSchema = AutomationWorkerHeartbeatEnvelopeSchema.extend({
  event: AutomationWorkerHeartbeatEventIntentSchema,
}).strict();
export type AutomationWorkerHeartbeat = z.infer<typeof AutomationWorkerHeartbeatSchema>;

export const AutomationWorkerHeartbeatAcceptedSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    accepted: z.literal(true),
    event: AutomationEventSchema,
  })
  .strict();
export type AutomationWorkerHeartbeatAccepted = z.infer<
  typeof AutomationWorkerHeartbeatAcceptedSchema
>;

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

const AutomationBrowserDispatchCommonShape = {
  protocol_version: AutomationProtocolVersionSchema,
  request: AutomationJobRequestSchema,
  lease: AutomationLeaseSchema,
  policy_version: z.string().trim().min(1).max(128),
  resume_after_sequence: z.number().int().nonnegative().max(AUTOMATION_MAX_STEPS),
  dispatched_at: DateTimeSchema,
} as const;

type AutomationBrowserDispatchCommon = {
  request: AutomationJobRequest;
  lease: AutomationLease;
  resume_after_sequence: number;
  dispatched_at: string;
};

function validateBrowserDispatchEnvelope(
  envelope: AutomationBrowserDispatchCommon,
  context: z.RefinementCtx,
): void {
  if (
    envelope.request.execution_domain !== 'browser' ||
    envelope.request.browser_policy === null ||
    envelope.lease.execution_domain !== 'browser' ||
    envelope.lease.project_id !== envelope.request.project_id
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lease'],
      message: 'browser dispatch authority is inconsistent',
    });
  }
  const dispatchedAt = Date.parse(envelope.dispatched_at);
  if (
    Date.parse(envelope.lease.issued_at) > dispatchedAt ||
    Date.parse(envelope.lease.expires_at) <= dispatchedAt ||
    Date.parse(envelope.request.deadline_at) <= dispatchedAt
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['dispatched_at'],
      message: 'browser dispatch is outside its authority window',
    });
  }
  if (
    envelope.resume_after_sequence !== 0 &&
    !envelope.request.steps.some((step) => step.sequence === envelope.resume_after_sequence)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resume_after_sequence'],
      message: 'browser dispatch resume cursor is invalid',
    });
  }
}

export const AutomationBrowserStandardDispatchEnvelopeSchema = z
  .object(AutomationBrowserDispatchCommonShape)
  .strict()
  .superRefine(validateBrowserDispatchEnvelope);
export type AutomationBrowserStandardDispatchEnvelope = z.infer<
  typeof AutomationBrowserStandardDispatchEnvelopeSchema
>;

export const AutomationBrowserApprovalResumeBindingSchema = z
  .object({
    approval_id: UuidSchema,
    attempt_id: UuidSchema,
    step_id: UuidSchema,
    action_hash: Sha256HashSchema,
    token: z.string().regex(/^approval-resume\.v1\.[A-Za-z0-9_-]{43}$/),
    expires_at: DateTimeSchema,
  })
  .strict();
export type AutomationBrowserApprovalResumeBinding = z.infer<
  typeof AutomationBrowserApprovalResumeBindingSchema
>;

export const AutomationBrowserCapabilitySchema = z.enum(['browser.approval-resume.v1']);
export type AutomationBrowserCapability = z.infer<typeof AutomationBrowserCapabilitySchema>;

export const AutomationBrowserApprovalResumeDispatchEnvelopeSchema = z
  .object({
    ...AutomationBrowserDispatchCommonShape,
    dispatch_kind: z.literal('browser.approval-resume.v1'),
    approval_resume: AutomationBrowserApprovalResumeBindingSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    validateBrowserDispatchEnvelope(envelope, context);
    const step = envelope.request.steps.find(
      (candidate) => candidate.step_id === envelope.approval_resume.step_id,
    );
    if (
      step === undefined ||
      step.action_hash !== envelope.approval_resume.action_hash ||
      step.sequence <= envelope.resume_after_sequence ||
      Date.parse(envelope.approval_resume.expires_at) > Date.parse(envelope.lease.expires_at)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['approval_resume'],
        message: 'browser approval resume binding is inconsistent',
      });
    }
  });
export type AutomationBrowserApprovalResumeDispatchEnvelope = z.infer<
  typeof AutomationBrowserApprovalResumeDispatchEnvelopeSchema
>;

export const AutomationBrowserDispatchEnvelopeSchema = z.union([
  AutomationBrowserStandardDispatchEnvelopeSchema,
  AutomationBrowserApprovalResumeDispatchEnvelopeSchema,
]);
export type AutomationBrowserDispatchEnvelope = z.infer<
  typeof AutomationBrowserDispatchEnvelopeSchema
>;

export const AutomationBrowserApprovalConsumeInputSchema = z
  .object({
    account_id: UuidSchema,
    project_id: UuidSchema,
    job_id: UuidSchema,
    approval_id: UuidSchema,
    attempt_id: UuidSchema,
    step_id: UuidSchema,
    action_hash: Sha256HashSchema,
    lease_id: UuidSchema,
    lease_owner: z.string().trim().min(1).max(128),
    kill_switch_generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resume_after_sequence: z.number().int().nonnegative().max(AUTOMATION_MAX_STEPS),
    token: z.string().regex(/^approval-resume\.v1\.[A-Za-z0-9_-]{43}$/),
    requested_at: DateTimeSchema,
  })
  .strict();
export type AutomationBrowserApprovalConsumeInput = z.infer<
  typeof AutomationBrowserApprovalConsumeInputSchema
>;

export const AutomationBrowserApprovalConsumeRequestSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    proof: AutomationWorkerServiceProofSchema,
    consume: AutomationBrowserApprovalConsumeInputSchema,
  })
  .strict();
export type AutomationBrowserApprovalConsumeRequest = z.infer<
  typeof AutomationBrowserApprovalConsumeRequestSchema
>;

export const AutomationBrowserApprovalConsumeAcceptedSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    consumed: z.literal(true),
    idempotent: z.boolean(),
    approval_id: UuidSchema,
    attempt_id: UuidSchema,
    job_id: UuidSchema,
    step_id: UuidSchema,
    started_at: DateTimeSchema,
  })
  .strict();
export type AutomationBrowserApprovalConsumeAccepted = z.infer<
  typeof AutomationBrowserApprovalConsumeAcceptedSchema
>;

export const AutomationBrowserDispatchRequestSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    envelope: AutomationBrowserDispatchEnvelopeSchema,
    proof: AutomationWorkerServiceProofSchema,
  })
  .strict();
export type AutomationBrowserDispatchRequest = z.infer<
  typeof AutomationBrowserDispatchRequestSchema
>;

export const AutomationBrowserDispatchReceiptSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    accepted: z.boolean(),
    job_id: UuidSchema,
    lease_id: UuidSchema,
    worker_id: IdentifierSchema,
    dispatch_envelope_hash: Sha256HashSchema,
    dispatch_proof_nonce: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    received_at: DateTimeSchema,
    capabilities: z.array(AutomationBrowserCapabilitySchema).max(16).optional(),
  })
  .strict();
export type AutomationBrowserDispatchReceipt = z.infer<
  typeof AutomationBrowserDispatchReceiptSchema
>;

export const AutomationBrowserDispatchAcceptedSchema = z
  .object({
    protocol_version: AutomationProtocolVersionSchema,
    receipt: AutomationBrowserDispatchReceiptSchema,
    proof: AutomationWorkerServiceProofSchema,
  })
  .strict();
export type AutomationBrowserDispatchAccepted = z.infer<
  typeof AutomationBrowserDispatchAcceptedSchema
>;

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
