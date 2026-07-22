import {
  type AutomationJob,
  AutomationJobSchema,
  type AutomationLease,
  type AutomationStep,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';
import type { LeaseManager } from '../lease-manager';
import type { AppendAutomationEventInput, AutomationRepository } from '../repository';
import type { StepApprovalCredential } from './desktop-dispatcher';

const DesktopObserveArgsSchema = z
  .object({
    method: z.literal('desktop.cua.get_screen_size'),
    params: z.record(z.unknown()).default({}),
  })
  .strict();
const DeclaredDesktopPermissionScopeSchema = z
  .object({
    device_id: z.string().uuid(),
    permission_id: z.string().uuid(),
  })
  .passthrough();

const DispatchDesktopStepInputSchema = z
  .object({
    accountId: z.string().uuid(),
    projectId: z.string().uuid(),
    jobId: z.string().uuid(),
    stepId: z.string().uuid(),
    owner: z.string().trim().min(1).max(128),
    approvalCredential: z
      .object({
        approvalId: z.string().uuid(),
        token: z.string().regex(/^approval\.v1\.[A-Za-z0-9_-]{43}$/),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DesktopPermissionResolution = Readonly<{
  tunnelId: string;
  permissionId: string;
}>;

export type DesktopPermissionResolver = (input: {
  accountId: string;
  projectId: string;
  deviceId: string;
  method: 'desktop.cua.get_screen_size';
  job: AutomationJob;
  now: Date;
}) => Promise<DesktopPermissionResolution | null>;

export const resolveDeclaredDesktopPermission: DesktopPermissionResolver = async (input) => {
  if (
    input.job.account_id !== input.accountId ||
    input.job.request.project_id !== input.projectId ||
    input.job.request.execution_domain !== 'desktop' ||
    input.job.request.desktop_policy?.device_id !== input.deviceId ||
    input.method !== 'desktop.cua.get_screen_size'
  ) {
    return null;
  }
  for (const requirement of input.job.request.capability_requirements) {
    if (requirement.capability !== 'desktop' || !requirement.methods.includes('read_screen')) {
      continue;
    }
    const scope = DeclaredDesktopPermissionScopeSchema.safeParse(requirement.scope);
    if (scope.success && scope.data.device_id === input.deviceId) {
      return { tunnelId: scope.data.device_id, permissionId: scope.data.permission_id };
    }
  }
  return null;
};

export type DesktopCoordinatorDispatcher = Readonly<{
  dispatchStep(input: {
    job: AutomationJob;
    lease: AutomationLease;
    stepId: string;
    tunnelId: string;
    permissionId: string;
    approvalCredential?: StepApprovalCredential;
    signal?: AbortSignal;
  }): Promise<unknown>;
}>;

export type DispatchDesktopStepInput = z.input<typeof DispatchDesktopStepInputSchema>;

export type DispatchDesktopStepResult = Readonly<{
  job_id: string;
  lease_id: string;
  status: 'succeeded';
  result: unknown;
}>;

export class AutomationCoordinatorError extends Error {
  readonly code:
    | 'AUTOMATION_INVALID_REQUEST'
    | 'AUTOMATION_FORBIDDEN'
    | 'AUTOMATION_CONFLICT'
    | 'AUTOMATION_LEASE_EXPIRED' = 'AUTOMATION_CONFLICT';
  readonly retryable: boolean;

  constructor(
    message: string,
    options?: {
      code?: AutomationCoordinatorError['code'];
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AutomationCoordinatorError';
    this.code = options?.code ?? 'AUTOMATION_CONFLICT';
    this.retryable = options?.retryable ?? false;
  }
}

export type AutomationDispatchCoordinator = Readonly<{
  dispatchDesktopStep(
    input: DispatchDesktopStepInput,
    options?: AutomationDispatchOptions,
  ): Promise<DispatchDesktopStepResult>;
  runOnce(options?: AutomationDispatchOptions): Promise<AutomationDispatchCoordinatorStats>;
}>;

export type AutomationDispatchOptions = Readonly<{
  signal?: AbortSignal;
}>;

export type AutomationDispatchCoordinatorStats = {
  candidates: number;
  claimed: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

export type DesktopDispatchCandidateReader = (input: {
  now: Date;
  limit: number;
}) => Promise<readonly AutomationJob[]>;

type CoordinatorDependencies = Readonly<{
  repository: AutomationRepository;
  leaseManager: LeaseManager;
  resolveDesktopPermission: DesktopPermissionResolver;
  desktopDispatcher: DesktopCoordinatorDispatcher;
  leaseMs: number;
  now?: () => Date;
  owner?: string;
  maxClaimsPerRun?: number;
  listDesktopCandidates?: DesktopDispatchCandidateReader;
}>;

function traceIdFor(job: AutomationJob): string | null {
  return job.request.traceparent?.split('-')[1] ?? null;
}

function observeStepFor(job: AutomationJob, stepId: string): AutomationStep {
  if (job.request.execution_domain !== 'desktop' || job.request.desktop_policy === null) {
    throw new AutomationCoordinatorError('desktop execution policy is required', {
      code: 'AUTOMATION_FORBIDDEN',
    });
  }
  if (job.request.steps.length !== 1) {
    throw new AutomationCoordinatorError(
      'the bounded desktop coordinator accepts exactly one step',
      { code: 'AUTOMATION_INVALID_REQUEST' },
    );
  }
  const step = job.request.steps[0];
  if (step === undefined || step.step_id !== stepId) {
    throw new AutomationCoordinatorError('desktop step is absent from the job', {
      code: 'AUTOMATION_INVALID_REQUEST',
    });
  }
  if (step.action !== 'desktop.read_screen' || step.risk !== 'observe') {
    throw new AutomationCoordinatorError(
      'the bounded desktop coordinator only permits an observe screen step',
      { code: 'AUTOMATION_FORBIDDEN' },
    );
  }
  try {
    DesktopObserveArgsSchema.parse(step.args);
  } catch (error) {
    throw new AutomationCoordinatorError(
      'the bounded desktop coordinator only permits get_screen_size',
      { code: 'AUTOMATION_INVALID_REQUEST', cause: error },
    );
  }
  return step;
}

function eventInput(
  job: AutomationJob,
  lease: AutomationLease,
  event: AppendAutomationEventInput['event'],
  transition: AppendAutomationEventInput['transition'],
  occurredAt: Date,
): AppendAutomationEventInput {
  return {
    accountId: job.account_id,
    projectId: job.request.project_id,
    jobId: job.job_id,
    leaseOwner: lease.owner,
    killSwitchGeneration: lease.kill_switch_generation,
    event,
    transition,
    occurredAt,
  };
}

function errorCodeFor(error: unknown): string {
  if (error instanceof AutomationCoordinatorError) return error.code;
  if (error instanceof Error && error.name === 'DesktopDispatchError') {
    return 'DESKTOP_DISPATCH_FAILED';
  }
  return 'DESKTOP_DISPATCH_FAILED';
}

function ensureCoordinatorActive(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AutomationCoordinatorError('automation coordinator is stopping', {
      code: 'AUTOMATION_CONFLICT',
      retryable: true,
    });
  }
}

export function createAutomationDispatchCoordinator(
  dependencies: CoordinatorDependencies,
): AutomationDispatchCoordinator {
  if (!Number.isInteger(dependencies.leaseMs) || dependencies.leaseMs <= 0) {
    throw new Error('automation coordinator leaseMs must be a positive integer');
  }
  const maxClaimsPerRun = dependencies.maxClaimsPerRun ?? 1;
  if (
    !Number.isSafeInteger(maxClaimsPerRun) ||
    maxClaimsPerRun < 1 ||
    maxClaimsPerRun > 100 ||
    (dependencies.owner !== undefined && dependencies.owner.trim() === '')
  ) {
    throw new Error('automation coordinator candidate polling is not configured');
  }
  const now = dependencies.now ?? (() => new Date());

  const coordinator: AutomationDispatchCoordinator = {
    async dispatchDesktopStep(rawInput, options) {
      ensureCoordinatorActive(options?.signal);
      const input = DispatchDesktopStepInputSchema.parse(rawInput);
      const initialJob = await dependencies.repository.getJobForProject(
        input.accountId,
        input.projectId,
        input.jobId,
      );
      if (initialJob === null) {
        throw new AutomationCoordinatorError('automation job was not found', {
          code: 'AUTOMATION_CONFLICT',
        });
      }
      const step = observeStepFor(initialJob, input.stepId);
      const stepArgs = DesktopObserveArgsSchema.parse(step.args);
      const deviceId = initialJob.request.desktop_policy?.device_id;
      if (deviceId === undefined) {
        throw new AutomationCoordinatorError('desktop target device is required', {
          code: 'AUTOMATION_FORBIDDEN',
        });
      }

      const claimedAt = now();
      const permission = await dependencies.resolveDesktopPermission({
        accountId: initialJob.account_id,
        projectId: initialJob.request.project_id,
        deviceId,
        method: stepArgs.method,
        job: initialJob,
        now: claimedAt,
      });
      if (permission === null) {
        throw new AutomationCoordinatorError('no active desktop permission matches the target', {
          code: 'AUTOMATION_FORBIDDEN',
          retryable: false,
        });
      }
      if (permission.tunnelId !== deviceId) {
        throw new AutomationCoordinatorError('desktop permission tunnel does not match target', {
          code: 'AUTOMATION_FORBIDDEN',
        });
      }

      const lease = await dependencies.leaseManager.claim(
        initialJob.job_id,
        input.owner,
        claimedAt,
        dependencies.leaseMs,
        permission.permissionId,
      );
      if (lease === null) {
        throw new AutomationCoordinatorError('automation job lease is unavailable', {
          code: 'AUTOMATION_CONFLICT',
          retryable: true,
        });
      }
      if (
        lease.job_id !== initialJob.job_id ||
        lease.project_id !== initialJob.request.project_id ||
        lease.execution_domain !== 'desktop' ||
        lease.permission_id !== permission.permissionId
      ) {
        await dependencies.leaseManager.release(initialJob.job_id, lease.owner, now());
        throw new AutomationCoordinatorError('claimed desktop lease does not match authority', {
          code: 'AUTOMATION_LEASE_EXPIRED',
        });
      }

      let started = false;
      let settled = false;
      let dispatchAttempted = false;
      try {
        const leasedJob = await dependencies.repository.getJobForProject(
          input.accountId,
          input.projectId,
          input.jobId,
        );
        if (leasedJob === null) {
          throw new AutomationCoordinatorError('automation job disappeared after claim', {
            code: 'AUTOMATION_CONFLICT',
          });
        }
        if (leasedJob.status !== 'dispatched') {
          throw new AutomationCoordinatorError('claimed automation job is not dispatched', {
            code: 'AUTOMATION_CONFLICT',
          });
        }
        if (!(await dependencies.leaseManager.isCurrent(lease.job_id, lease.owner, now()))) {
          throw new AutomationCoordinatorError('desktop lease is no longer current', {
            code: 'AUTOMATION_LEASE_EXPIRED',
            retryable: true,
          });
        }
        ensureCoordinatorActive(options?.signal);

        await dependencies.repository.appendEvent(
          eventInput(
            leasedJob,
            lease,
            {
              protocol_version: 'automation.v1',
              type: 'job_started',
              status: 'running',
              payload: { execution_domain: 'desktop' },
              trace_id: traceIdFor(leasedJob),
            },
            { type: 'started' },
            now(),
          ),
        );
        started = true;

        await dependencies.repository.appendEvent(
          eventInput(
            leasedJob,
            lease,
            {
              protocol_version: 'automation.v1',
              type: 'step_started',
              status: 'running',
              payload: { step_id: step.step_id, action: step.action },
              trace_id: traceIdFor(leasedJob),
            },
            null,
            now(),
          ),
        );

        const runningJob = await dependencies.repository.getJobForProject(
          input.accountId,
          input.projectId,
          input.jobId,
        );
        if (runningJob === null || runningJob.status !== 'running') {
          throw new AutomationCoordinatorError('automation job did not enter running state', {
            code: 'AUTOMATION_CONFLICT',
          });
        }
        if (!(await dependencies.leaseManager.isCurrent(lease.job_id, lease.owner, now()))) {
          throw new AutomationCoordinatorError('desktop lease is no longer current', {
            code: 'AUTOMATION_LEASE_EXPIRED',
            retryable: true,
          });
        }
        ensureCoordinatorActive(options?.signal);

        dispatchAttempted = true;
        const result = await dependencies.desktopDispatcher.dispatchStep({
          job: runningJob,
          lease,
          stepId: step.step_id,
          tunnelId: permission.tunnelId,
          permissionId: permission.permissionId,
          approvalCredential: input.approvalCredential,
          signal: options?.signal,
        });
        if (!(await dependencies.leaseManager.isCurrent(lease.job_id, lease.owner, now()))) {
          throw new AutomationCoordinatorError(
            'desktop lease is no longer current after dispatch',
            {
              code: 'AUTOMATION_LEASE_EXPIRED',
              retryable: true,
            },
          );
        }

        await dependencies.repository.appendEvent(
          eventInput(
            runningJob,
            lease,
            {
              protocol_version: 'automation.v1',
              type: 'step_completed',
              status: 'running',
              payload: {
                step_id: step.step_id,
                result_available: true,
                result_type: result === null ? 'null' : typeof result,
              },
              trace_id: traceIdFor(runningJob),
            },
            null,
            now(),
          ),
        );
        await dependencies.repository.appendEvent(
          eventInput(
            runningJob,
            lease,
            {
              protocol_version: 'automation.v1',
              type: 'job_succeeded',
              status: 'succeeded',
              payload: { step_id: step.step_id },
              trace_id: traceIdFor(runningJob),
            },
            { type: 'succeeded' },
            now(),
          ),
        );
        settled = true;
        return {
          job_id: runningJob.job_id,
          lease_id: lease.lease_id,
          status: 'succeeded',
          result,
        };
      } catch (error) {
        if (started && !settled) {
          const leaseCurrent = await dependencies.leaseManager
            .isCurrent(lease.job_id, lease.owner, now())
            .catch(() => false);
          if (leaseCurrent) {
            const failedJob = await dependencies.repository
              .getJobForProject(input.accountId, input.projectId, input.jobId)
              .catch(() => null);
            if (failedJob?.status === 'running') {
              await dependencies.repository
                .appendEvent(
                  eventInput(
                    failedJob,
                    lease,
                    {
                      protocol_version: 'automation.v1',
                      type: 'job_failed',
                      status: 'retryable',
                      payload: {
                        step_id: step.step_id,
                        error_code: errorCodeFor(error),
                        result_unknown: dispatchAttempted,
                        retryable: true,
                        external_effect_committed: false,
                      },
                      trace_id: traceIdFor(failedJob),
                    },
                    { type: 'failed', retryable: true, externalEffectCommitted: false },
                    now(),
                  ),
                )
                .catch(() => undefined);
            }
          }
        }
        throw error;
      } finally {
        // Terminal events clear the lease in Postgres; an explicit release is
        // still issued so memory/alternate stores cannot retain a fencing token.
        await dependencies.leaseManager
          .release(initialJob.job_id, lease.owner, now())
          .catch(() => undefined);
      }
    },
    async runOnce(options) {
      if (dependencies.owner === undefined) {
        throw new Error('automation coordinator candidate polling is not configured');
      }
      const stats: AutomationDispatchCoordinatorStats = {
        candidates: 0,
        claimed: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
      };
      if (options?.signal?.aborted) return stats;
      const listDesktopCandidates =
        dependencies.listDesktopCandidates ??
        ((query: { now: Date; limit: number }) =>
          dependencies.repository.listDispatchCandidates({
            executionDomain: 'desktop',
            onlyStep: {
              action: 'desktop.read_screen',
              risk: 'observe',
              method: 'desktop.cua.get_screen_size',
              capability: 'desktop',
              capabilityMethod: 'read_screen',
            },
            ...query,
          }));
      const candidates = await listDesktopCandidates({
        now: now(),
        limit: maxClaimsPerRun,
      });
      for (const rawCandidate of candidates.slice(0, maxClaimsPerRun)) {
        if (options?.signal?.aborted) break;
        stats.candidates += 1;
        let candidate: AutomationJob;
        try {
          candidate = AutomationJobSchema.parse(rawCandidate);
          observeStepFor(candidate, candidate.request.steps[0]?.step_id ?? '');
        } catch {
          stats.skipped += 1;
          continue;
        }
        if (
          !['queued', 'dispatched'].includes(candidate.status) ||
          Date.parse(candidate.request.deadline_at) <= now().getTime()
        ) {
          stats.skipped += 1;
          continue;
        }
        try {
          await coordinator.dispatchDesktopStep(
            {
              accountId: candidate.account_id,
              projectId: candidate.request.project_id,
              jobId: candidate.job_id,
              stepId: candidate.request.steps[0]?.step_id ?? '',
              owner: dependencies.owner,
            },
            options,
          );
          stats.claimed += 1;
          stats.succeeded += 1;
        } catch (error) {
          if (
            error instanceof AutomationCoordinatorError &&
            (error.code === 'AUTOMATION_INVALID_REQUEST' ||
              error.code === 'AUTOMATION_FORBIDDEN' ||
              (error.code === 'AUTOMATION_CONFLICT' && /lease is unavailable/i.test(error.message)))
          ) {
            stats.skipped += 1;
            continue;
          }
          stats.claimed += 1;
          stats.failed += 1;
        }
      }
      return stats;
    },
  };
  return coordinator;
}
