import { createHash } from 'node:crypto';
import {
  type AutomationJob,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  type AutomationRisk,
  type AutomationStep,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';
import type { DispatchLeaseBinding } from './browser-dispatcher';

type DesktopActionRule = Readonly<{
  risk: AutomationRisk;
  methods: ReadonlySet<string>;
}>;

const DESKTOP_ACTION_RULES: Readonly<Record<string, DesktopActionRule>> = Object.freeze({
  'desktop.read_screen': {
    risk: 'observe',
    methods: new Set(['desktop.cua.get_screen_size', 'desktop.cua.get_window_state']),
  },
  'desktop.list_windows': {
    risk: 'observe',
    methods: new Set(['desktop.cua.list_windows']),
  },
  'desktop.mouse': {
    risk: 'operate',
    methods: new Set([
      'desktop.cua.click',
      'desktop.cua.double_click',
      'desktop.cua.drag',
      'desktop.cua.move_cursor',
      'desktop.cua.right_click',
    ]),
  },
  'desktop.keyboard': {
    risk: 'operate',
    methods: new Set([
      'desktop.cua.hotkey',
      'desktop.cua.press_key',
      'desktop.cua.scroll',
      'desktop.cua.type_text',
    ]),
  },
  'desktop.window': {
    risk: 'operate',
    methods: new Set(['desktop.cua.bring_to_front', 'desktop.cua.zoom']),
  },
  'desktop.launch': {
    risk: 'operate',
    methods: new Set(['desktop.cua.launch_app']),
  },
  'desktop.submit': {
    risk: 'external_effect',
    methods: new Set(['desktop.cua.click']),
  },
});

const DesktopActionArgsSchema = z
  .object({
    method: z.string().min(1).max(128),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

const StepApprovalCredentialSchema = z
  .object({
    approvalId: z.string().uuid(),
    token: z.string().regex(/^approval\.v1\.[A-Za-z0-9_-]{43}$/),
  })
  .strict();

export type StepApprovalCredential = z.infer<typeof StepApprovalCredentialSchema>;

export type StepApprovalConsumption = Readonly<{
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: string;
  approvalId: string;
  token: string;
  leaseId: string;
  killSwitchGeneration: number;
  consumedAt: Date;
}>;

export type FullAccessGrantBinding = Readonly<{
  accountId: string;
  projectId: string;
  jobId: string;
  deviceId: string;
  permissionId: string;
  leaseId: string;
  killSwitchGeneration: number;
  checkedAt: Date;
}>;

export type TunnelRpcOutcome =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{
      ok: false;
      kind: string;
      message: string;
      code?: string;
      retryAfterMs?: number;
    }>;

export type TunnelRpcExecutor = (input: {
  tunnelId: string;
  accountId: string;
  method: string;
  requiredPermissionId: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<TunnelRpcOutcome>;

export class DesktopDispatchError extends Error {
  override readonly name = 'DesktopDispatchError';
}

function requestHash(job: AutomationJob): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(job.request))
    .digest('hex')}`;
}

function stepFor(job: AutomationJob, stepId: string): AutomationStep {
  const step = job.request.steps.find((candidate) => candidate.step_id === stepId);
  if (step === undefined) throw new DesktopDispatchError('desktop step is absent from the job');
  const rule = DESKTOP_ACTION_RULES[step.action];
  if (rule === undefined || rule.risk !== step.risk) {
    throw new DesktopDispatchError('desktop action or risk is absent from the server catalog');
  }
  return step;
}

export function createDesktopDispatcher(input: {
  now?: () => Date;
  isLeaseSignatureValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (binding: DispatchLeaseBinding) => Promise<boolean>;
  isFullAccessGrantCurrent: (binding: FullAccessGrantBinding) => Promise<boolean>;
  consumeStepApproval: (binding: StepApprovalConsumption) => Promise<boolean>;
  executeTunnelRpc: TunnelRpcExecutor;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async dispatchStep(raw: {
      job: AutomationJob;
      lease: AutomationLease;
      stepId: string;
      tunnelId: string;
      permissionId: string;
      approvalCredential?: StepApprovalCredential;
      signal?: AbortSignal;
    }): Promise<unknown> {
      const job = AutomationJobSchema.parse(raw.job);
      const lease = AutomationLeaseSchema.parse(raw.lease);
      const checkedAt = now();
      if (
        job.request.execution_domain !== 'desktop' ||
        lease.execution_domain !== 'desktop' ||
        job.request.desktop_policy === null
      ) {
        throw new DesktopDispatchError('desktop execution domain is required');
      }
      if (job.status !== 'dispatched' && job.status !== 'running') {
        throw new DesktopDispatchError('desktop job is not dispatchable');
      }
      if (
        requestHash(job) !== job.request_hash ||
        lease.request_hash !== job.request_hash ||
        lease.job_id !== job.job_id ||
        lease.project_id !== job.request.project_id ||
        lease.kill_switch_generation !== job.kill_switch_generation ||
        lease.kill_switch_generation !== job.request.desktop_policy.kill_switch_generation
      ) {
        throw new DesktopDispatchError('desktop lease does not match the job authority');
      }
      if (
        Date.parse(lease.expires_at) <= checkedAt.getTime() ||
        Date.parse(job.request.deadline_at) <= checkedAt.getTime()
      ) {
        throw new DesktopDispatchError('desktop lease or request deadline is expired');
      }
      if (job.request.desktop_policy.device_id !== raw.tunnelId) {
        throw new DesktopDispatchError('desktop tunnel does not match the target device');
      }
      if (lease.permission_id === null || lease.permission_id !== raw.permissionId) {
        throw new DesktopDispatchError('desktop permission does not match the signed lease');
      }
      if (!(await input.isLeaseSignatureValid(lease))) {
        throw new DesktopDispatchError('desktop lease signature is invalid');
      }
      const leaseBinding: DispatchLeaseBinding = {
        accountId: job.account_id,
        projectId: job.request.project_id,
        jobId: job.job_id,
        leaseId: lease.lease_id,
        owner: lease.owner,
        killSwitchGeneration: lease.kill_switch_generation,
      };
      if (!(await input.isLeaseCurrent(leaseBinding))) {
        throw new DesktopDispatchError('desktop lease is not current');
      }
      const step = stepFor(job, raw.stepId);
      const args = DesktopActionArgsSchema.parse(step.args);
      const rule = DESKTOP_ACTION_RULES[step.action];
      if (rule === undefined || !rule.methods.has(args.method)) {
        throw new DesktopDispatchError('desktop method is outside the action catalog');
      }
      const fullAccessExpiresAt = job.request.desktop_policy.full_access_expires_at;
      const fullAccessGrantBinding = {
        accountId: job.account_id,
        projectId: job.request.project_id,
        jobId: job.job_id,
        deviceId: job.request.desktop_policy.device_id,
        permissionId: raw.permissionId,
        leaseId: lease.lease_id,
        killSwitchGeneration: lease.kill_switch_generation,
      };
      const fullAccessGrantCurrent =
        step.risk === 'operate' &&
        job.request.approval_policy === 'full-access' &&
        fullAccessExpiresAt !== null &&
        Date.parse(fullAccessExpiresAt) > checkedAt.getTime() &&
        (await input.isFullAccessGrantCurrent({
          ...fullAccessGrantBinding,
          checkedAt,
        }));
      const requiresApproval =
        step.risk === 'external_effect' || (step.risk === 'operate' && !fullAccessGrantCurrent);
      if (!requiresApproval && raw.approvalCredential !== undefined) {
        throw new DesktopDispatchError('desktop approval is not required for this step');
      }
      if (requiresApproval) {
        const approvalCredential = StepApprovalCredentialSchema.safeParse(raw.approvalCredential);
        if (!approvalCredential.success) {
          throw new DesktopDispatchError('desktop step requires a valid approval credential');
        }
        if (
          !(await input.consumeStepApproval({
            accountId: job.account_id,
            projectId: job.request.project_id,
            jobId: job.job_id,
            stepId: step.step_id,
            actionHash: step.action_hash,
            approvalId: approvalCredential.data.approvalId,
            token: approvalCredential.data.token,
            leaseId: lease.lease_id,
            killSwitchGeneration: lease.kill_switch_generation,
            consumedAt: now(),
          }))
        ) {
          throw new DesktopDispatchError('desktop step requires a fresh consumed approval');
        }
      }
      if (fullAccessGrantCurrent) {
        const authorizationCheckedAt = now();
        if (
          fullAccessExpiresAt === null ||
          Date.parse(fullAccessExpiresAt) <= authorizationCheckedAt.getTime() ||
          !(await input.isFullAccessGrantCurrent({
            ...fullAccessGrantBinding,
            checkedAt: authorizationCheckedAt,
          }))
        ) {
          throw new DesktopDispatchError(
            'desktop full-access grant is not current before Tunnel RPC',
          );
        }
      }
      if (!(await input.isLeaseCurrent(leaseBinding))) {
        throw new DesktopDispatchError('desktop lease is not current before Tunnel RPC');
      }
      const transportCheckedAt = now();
      if (
        fullAccessGrantCurrent &&
        (fullAccessExpiresAt === null ||
          Date.parse(fullAccessExpiresAt) <= transportCheckedAt.getTime())
      ) {
        throw new DesktopDispatchError(
          'desktop full-access grant is not current before Tunnel RPC',
        );
      }
      if (
        Date.parse(lease.expires_at) <= transportCheckedAt.getTime() ||
        Date.parse(job.request.deadline_at) <= transportCheckedAt.getTime()
      ) {
        throw new DesktopDispatchError(
          'desktop lease or request deadline is expired before Tunnel RPC',
        );
      }
      const outcome = await input.executeTunnelRpc({
        tunnelId: raw.tunnelId,
        accountId: job.account_id,
        method: args.method,
        requiredPermissionId: raw.permissionId,
        signal: raw.signal,
        params: {
          ...args.params,
          permissionId: raw.permissionId,
          automation: {
            lease,
            job_id: job.job_id,
            project_id: job.request.project_id,
            lease_id: lease.lease_id,
            lease_owner: lease.owner,
            action_hash: step.action_hash,
            policy_version: job.policy_version,
            kill_switch_generation: lease.kill_switch_generation,
            traceparent: job.request.traceparent,
          },
        },
      });
      if (!(await input.isLeaseCurrent(leaseBinding))) {
        throw new DesktopDispatchError('desktop lease is not current after Tunnel RPC');
      }
      if (!outcome.ok) {
        throw new DesktopDispatchError(`desktop Tunnel RPC failed: ${outcome.message}`);
      }
      return outcome.result;
    },
  };
}
