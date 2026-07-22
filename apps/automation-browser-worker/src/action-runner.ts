import {
  AUTOMATION_MAX_STEPS,
  type AutomationEvent,
  type AutomationLease,
  type AutomationStep,
  BrowserAutomationStepSchema,
  type BrowserPolicy,
  browserAutomationRiskForAction,
} from '@kortix/intelligence-contracts';

export interface BrowserPageAdapter {
  currentUrl(): string;
  goto(url: string): Promise<string>;
  click(selector: string): Promise<void>;
  clickPoint(x: number, y: number): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  screenshot(): Promise<Uint8Array>;
}

export interface BrowserActionRunner {
  run(input: {
    approvalPolicy?: 'project-default' | 'full-access';
    lease: AutomationLease;
    steps: readonly AutomationStep[];
    policy: BrowserPolicy;
    signal: AbortSignal;
  }): Promise<ReadonlyArray<BrowserActionEventIntent>>;
}

export type BrowserActionEventIntent = Readonly<{
  protocol_version: AutomationEvent['protocol_version'];
  job_id: string;
  ordinal: number;
  type: AutomationEvent['type'];
  payload: Record<string, unknown>;
  trace_id: string | null;
}>;

export class BrowserKillSwitchError extends Error {
  override readonly name = 'BrowserKillSwitchError';
}

type RunnerDependencies = Readonly<{
  page: BrowserPageAdapter;
  now?: () => Date;
  isSignedLeaseValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (lease: AutomationLease) => Promise<boolean>;
  currentKillSwitchGeneration: (lease: AutomationLease) => Promise<number>;
  isActionHashCurrent: (step: AutomationStep, lease: AutomationLease) => Promise<boolean>;
  consumeApproval: (
    input: ApprovalBinding,
  ) => Promise<ConsumedApprovalBinding | ApprovalBinding | null>;
  emitEvent?: (intent: BrowserActionEventIntent) => Promise<void>;
  onStepCompleted?: (completedStepCount: number) => void;
  isFullAccessGrantCurrent: (lease: AutomationLease) => Promise<boolean>;
  isAllowedUrl: (url: string, policy: BrowserPolicy) => Promise<boolean>;
  waitForApproval?: (input: ApprovalBinding, signal: AbortSignal) => Promise<void>;
  writeEvidence: (step: AutomationStep, contentType: string, body: Uint8Array) => Promise<string>;
}>;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(String(signal.reason ?? 'browser execution aborted'));
}

async function abortablePromise<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error(String(signal.reason ?? 'aborted'))));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export type ApprovalBinding = Readonly<{
  actionHash: string;
  jobId: string;
  projectId: string;
  stepId: string;
}>;

export type ConsumedApprovalBinding = ApprovalBinding &
  Readonly<{
    approvalId: string;
    attemptId: string;
    leaseId: string;
    killSwitchGeneration: number;
    resumeAfterSequence: number;
    stepStartedAtomically: true;
  }>;

const executableActions = new Set([
  'browser.navigate',
  'browser.click',
  'browser.type',
  'browser.read',
  'browser.screenshot',
  'browser.wait',
]);
const approvalActions = new Set([
  'browser.submit',
  'browser.payment',
  'browser.delete',
  'browser.send',
]);

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${name}`);
  return value;
}

function requiredNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`invalid ${name}`);
  return value;
}

async function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error(String(signal.reason ?? 'browser execution aborted'));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(new Error(String(signal.reason ?? 'browser execution aborted')));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function event(
  lease: AutomationLease,
  type: AutomationEvent['type'],
  payload: Record<string, unknown>,
  ordinal: number,
): BrowserActionEventIntent {
  return {
    protocol_version: 'automation.v1',
    job_id: lease.job_id,
    ordinal,
    type,
    payload,
    trace_id: null,
  };
}

async function checkStep(
  dependencies: RunnerDependencies,
  lease: AutomationLease,
  step: AutomationStep,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (lease.execution_domain !== 'browser') throw new Error('browser execution domain required');
  if (!(await dependencies.isSignedLeaseValid(lease)))
    throw new Error('lease signature is invalid');
  throwIfAborted(signal);
  const now = dependencies.now ?? (() => new Date());
  if (Date.parse(lease.expires_at) <= now().getTime()) throw new Error('lease expired');
  if (!(await dependencies.isLeaseCurrent(lease))) throw new Error('lease is no longer current');
  throwIfAborted(signal);
  if ((await dependencies.currentKillSwitchGeneration(lease)) !== lease.kill_switch_generation) {
    throw new BrowserKillSwitchError('kill-switch generation changed');
  }
  throwIfAborted(signal);
  if (!(await dependencies.isActionHashCurrent(step, lease)))
    throw new Error('action hash is no longer current');
  throwIfAborted(signal);
}

async function checkCurrentPageOrigin(
  dependencies: RunnerDependencies,
  step: AutomationStep,
  policy: BrowserPolicy,
  signal: AbortSignal,
): Promise<void> {
  if (step.action === 'browser.navigate') return;
  const currentUrl = dependencies.page.currentUrl();
  if (currentUrl === 'about:blank') return;
  if (!(await dependencies.isAllowedUrl(currentUrl, policy))) {
    throw new Error('current page origin is not allowed');
  }
  throwIfAborted(signal);
}

function approvalMatches(
  consumedApproval: ConsumedApprovalBinding | ApprovalBinding | null,
  expectedApproval: ApprovalBinding,
  lease: AutomationLease,
  currentStep: AutomationStep,
): boolean {
  const baseMatches =
    consumedApproval !== null &&
    consumedApproval.actionHash === expectedApproval.actionHash &&
    consumedApproval.jobId === expectedApproval.jobId &&
    consumedApproval.projectId === expectedApproval.projectId &&
    consumedApproval.stepId === expectedApproval.stepId;
  if (!baseMatches || consumedApproval === null) return false;
  if (
    !('stepStartedAtomically' in consumedApproval) ||
    consumedApproval.stepStartedAtomically !== true
  ) {
    return true;
  }
  return (
    consumedApproval.approvalId.length > 0 &&
    consumedApproval.attemptId.length > 0 &&
    consumedApproval.leaseId === lease.lease_id &&
    consumedApproval.killSwitchGeneration === lease.kill_switch_generation &&
    consumedApproval.resumeAfterSequence < currentStep.sequence
  );
}

export function createBrowserActionRunner(dependencies: RunnerDependencies): BrowserActionRunner {
  return {
    async run({ approvalPolicy = 'project-default', lease, steps, policy, signal }) {
      if (steps.length > AUTOMATION_MAX_STEPS) throw new Error('automation step limit exceeded');
      const events: BrowserActionEventIntent[] = [];
      let nextOrdinal = 1;
      let completedStepCount = 0;
      const pushEvent = async (
        type: AutomationEvent['type'],
        payload: Record<string, unknown>,
      ): Promise<void> => {
        const intent = event(lease, type, payload, nextOrdinal);
        events.push(intent);
        nextOrdinal += 1;
        await dependencies.emitEvent?.(intent);
      };
      for (const step of steps) {
        if (browserAutomationRiskForAction(step.action) === null) {
          throw new Error(`unsupported browser action: ${step.action}`);
        }
        const currentStep = BrowserAutomationStepSchema.parse(step);
        await checkStep(dependencies, lease, currentStep, signal);
        await checkCurrentPageOrigin(dependencies, currentStep, policy, signal);
        const fullAccessActive =
          approvalPolicy === 'full-access' && (await dependencies.isFullAccessGrantCurrent(lease));
        const requiresApproval =
          currentStep.risk === 'external_effect' ||
          (currentStep.risk === 'operate' && !fullAccessActive) ||
          approvalActions.has(currentStep.action);
        const expectedApproval: ApprovalBinding = {
          actionHash: currentStep.action_hash,
          jobId: lease.job_id,
          projectId: lease.project_id,
          stepId: currentStep.step_id,
        };
        let consumedApproval = requiresApproval
          ? await abortablePromise(dependencies.consumeApproval(expectedApproval), signal)
          : null;
        if (
          requiresApproval &&
          !approvalMatches(consumedApproval, expectedApproval, lease, currentStep)
        ) {
          await pushEvent('approval_required', {
            step_id: currentStep.step_id,
            action_hash: currentStep.action_hash,
          });
          if (dependencies.waitForApproval === undefined) break;
          await abortablePromise(dependencies.waitForApproval(expectedApproval, signal), signal);
          await checkStep(dependencies, lease, currentStep, signal);
          await checkCurrentPageOrigin(dependencies, currentStep, policy, signal);
          consumedApproval = await abortablePromise(
            dependencies.consumeApproval(expectedApproval),
            signal,
          );
          if (!approvalMatches(consumedApproval, expectedApproval, lease, currentStep)) {
            throw new Error('bound approval was not consumable after approval wait');
          }
        }
        await checkStep(dependencies, lease, currentStep, signal);
        await checkCurrentPageOrigin(dependencies, currentStep, policy, signal);
        if (!executableActions.has(currentStep.action) && !approvalActions.has(currentStep.action))
          throw new Error(`unsupported browser action: ${currentStep.action}`);
        const stepStartedAtomically =
          requiresApproval &&
          consumedApproval !== null &&
          'stepStartedAtomically' in consumedApproval &&
          consumedApproval.stepStartedAtomically === true;
        if (!stepStartedAtomically) {
          await pushEvent('step_started', { step_id: currentStep.step_id });
        }
        let evidenceReference: string | undefined;
        switch (currentStep.action) {
          case 'browser.navigate': {
            const url = requiredString(currentStep.args, 'url');
            if (!(await dependencies.isAllowedUrl(url, policy)))
              throw new Error('navigation origin is not allowed');
            throwIfAborted(signal);
            await checkStep(dependencies, lease, currentStep, signal);
            const finalUrl = await dependencies.page.goto(url);
            if (!(await dependencies.isAllowedUrl(finalUrl, policy)))
              throw new Error('redirect origin is not allowed');
            throwIfAborted(signal);
            break;
          }
          case 'browser.submit':
          case 'browser.payment':
          case 'browser.delete':
          case 'browser.send':
            await dependencies.page.click(requiredString(currentStep.args, 'selector'));
            break;
          case 'browser.click':
            if ('selector' in currentStep.args && typeof currentStep.args.selector === 'string') {
              await dependencies.page.click(requiredString(currentStep.args, 'selector'));
            } else {
              await dependencies.page.clickPoint(
                requiredNumber(currentStep.args, 'x'),
                requiredNumber(currentStep.args, 'y'),
              );
            }
            break;
          case 'browser.type':
            await dependencies.page.fill(
              requiredString(currentStep.args, 'selector'),
              requiredString(currentStep.args, 'value'),
            );
            break;
          case 'browser.read': {
            const text = await dependencies.page.textContent(
              requiredString(currentStep.args, 'selector'),
            );
            evidenceReference = await dependencies.writeEvidence(
              currentStep,
              'text/plain; charset=utf-8',
              new TextEncoder().encode(text ?? ''),
            );
            break;
          }
          case 'browser.screenshot': {
            const screenshot = await dependencies.page.screenshot();
            evidenceReference = await dependencies.writeEvidence(
              currentStep,
              'image/png',
              screenshot,
            );
            break;
          }
          case 'browser.wait':
            await waitFor(requiredNumber(currentStep.args, 'milliseconds'), signal);
            break;
        }
        throwIfAborted(signal);
        await pushEvent('step_completed', {
          step_id: currentStep.step_id,
          ...(evidenceReference === undefined ? {} : { evidence_reference: evidenceReference }),
        });
        completedStepCount += 1;
        dependencies.onStepCompleted?.(completedStepCount);
      }
      return events;
    },
  };
}
