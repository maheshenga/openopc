import { z } from 'zod';
import { AutomationLeaseSchema } from './automation.js';

export const AUTOMATION_DESKTOP_EXECUTOR_BASE_PATH = '/internal/automation/desktop';
export const AUTOMATION_DESKTOP_EXECUTOR_PATH = `${AUTOMATION_DESKTOP_EXECUTOR_BASE_PATH}/execute`;
export const AUTOMATION_DESKTOP_EXECUTOR_AUDIENCE = 'kortix-api';

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const AutomationDesktopExecutorParamsSchema = z
  .object({
    permissionId: UuidSchema,
    automation: z
      .object({
        lease: AutomationLeaseSchema,
        job_id: UuidSchema,
        project_id: UuidSchema,
        lease_id: UuidSchema,
        lease_owner: z.string().min(1).max(256),
        action_hash: Sha256Schema,
        policy_version: Sha256Schema,
        kill_switch_generation: z.number().int().nonnegative(),
        traceparent: z.string().min(1).max(256).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((params, context) => {
    const automation = params.automation;
    const lease = automation.lease;
    if (
      params.permissionId !== lease.permission_id ||
      lease.execution_domain !== 'desktop' ||
      lease.job_id !== automation.job_id ||
      lease.project_id !== automation.project_id ||
      lease.lease_id !== automation.lease_id ||
      lease.owner !== automation.lease_owner ||
      lease.kill_switch_generation !== automation.kill_switch_generation
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['automation'],
        message: 'desktop execution bindings do not match',
      });
    }
  });

export const AutomationDesktopExecutorRequestSchema = z
  .object({
    protocol_version: z.literal('automation.v1'),
    request_id: UuidSchema,
    tunnel_id: UuidSchema,
    account_id: UuidSchema,
    method: z.literal('desktop.cua.get_screen_size'),
    required_permission_id: UuidSchema,
    params: AutomationDesktopExecutorParamsSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (request.params.permissionId !== request.required_permission_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required_permission_id'],
        message: 'required permission does not match the execution bindings',
      });
    }
  });

export type AutomationDesktopExecutorRequest = z.infer<
  typeof AutomationDesktopExecutorRequestSchema
>;

export function canonicalAutomationDesktopExecutorProof(input: {
  timestamp: string;
  serviceId: string;
  audience: string;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
  accountId: string;
  projectId: string;
}): string {
  return [
    'automation-desktop-executor.v1',
    input.timestamp,
    input.serviceId,
    input.audience,
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
    input.accountId,
    input.projectId,
  ].join('\n');
}
