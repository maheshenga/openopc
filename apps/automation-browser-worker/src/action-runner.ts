import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_MAX_STEPS,
  type AutomationEvent,
  type AutomationLease,
  type AutomationStep,
  type BrowserPolicy,
} from '@kortix/intelligence-contracts';

export interface BrowserPageAdapter {
  goto(url: string): Promise<string>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  screenshot(): Promise<Uint8Array>;
}

export interface BrowserActionRunner {
  run(input: {
    lease: AutomationLease;
    steps: readonly AutomationStep[];
    policy: BrowserPolicy;
    signal: AbortSignal;
  }): Promise<ReadonlyArray<AutomationEvent>>;
}

type RunnerDependencies = Readonly<{
  page: BrowserPageAdapter;
  now?: () => Date;
  isSignedLeaseValid: (lease: AutomationLease) => Promise<boolean>;
  isLeaseCurrent: (lease: AutomationLease) => Promise<boolean>;
  currentKillSwitchGeneration: (lease: AutomationLease) => Promise<number>;
  isActionHashCurrent: (step: AutomationStep, lease: AutomationLease) => Promise<boolean>;
  isAllowedUrl: (url: string, policy: BrowserPolicy) => Promise<boolean>;
}>;

const executableActions = new Set(['navigate', 'click', 'fill', 'read', 'screenshot']);
const approvalActions = new Set(['submit', 'delete', 'send']);

function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`invalid ${name}`);
  return value;
}

function event(
  lease: AutomationLease,
  type: AutomationEvent['type'],
  payload: Record<string, unknown>,
): AutomationEvent {
  return {
    protocol_version: 'automation.v1',
    event_id: randomUUID(),
    job_id: lease.job_id,
    sequence: 1,
    type,
    status: null,
    payload,
    trace_id: null,
    created_at: new Date().toISOString(),
  };
}

async function checkStep(
  dependencies: RunnerDependencies,
  lease: AutomationLease,
  step: AutomationStep,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error('browser execution aborted');
  if (lease.execution_domain !== 'browser') throw new Error('browser execution domain required');
  if (!(await dependencies.isSignedLeaseValid(lease)))
    throw new Error('lease signature is invalid');
  const now = dependencies.now ?? (() => new Date());
  if (Date.parse(lease.expires_at) <= now().getTime()) throw new Error('lease expired');
  if (!(await dependencies.isLeaseCurrent(lease))) throw new Error('lease is no longer current');
  if ((await dependencies.currentKillSwitchGeneration(lease)) !== lease.kill_switch_generation) {
    throw new Error('kill-switch generation changed');
  }
  if (!(await dependencies.isActionHashCurrent(step, lease)))
    throw new Error('action hash is no longer current');
}

export function createBrowserActionRunner(dependencies: RunnerDependencies): BrowserActionRunner {
  return {
    async run({ lease, steps, policy, signal }) {
      if (steps.length > AUTOMATION_MAX_STEPS) throw new Error('automation step limit exceeded');
      const events: AutomationEvent[] = [];
      for (const step of steps) {
        await checkStep(dependencies, lease, step, signal);
        if (approvalActions.has(step.action)) {
          events.push(
            event(lease, 'approval_required', {
              step_id: step.step_id,
              action_hash: step.action_hash,
            }),
          );
          break;
        }
        if (!executableActions.has(step.action))
          throw new Error(`unsupported browser action: ${step.action}`);
        events.push(event(lease, 'step_started', { step_id: step.step_id }));
        switch (step.action) {
          case 'navigate': {
            const url = requiredString(step.args, 'url');
            if (!(await dependencies.isAllowedUrl(url, policy)))
              throw new Error('navigation origin is not allowed');
            const finalUrl = await dependencies.page.goto(url);
            if (!(await dependencies.isAllowedUrl(finalUrl, policy)))
              throw new Error('redirect origin is not allowed');
            break;
          }
          case 'click':
            await dependencies.page.click(requiredString(step.args, 'selector'));
            break;
          case 'fill':
            await dependencies.page.fill(
              requiredString(step.args, 'selector'),
              requiredString(step.args, 'value'),
            );
            break;
          case 'read':
            await dependencies.page.textContent(requiredString(step.args, 'selector'));
            break;
          case 'screenshot':
            await dependencies.page.screenshot();
            break;
        }
        events.push(event(lease, 'step_completed', { step_id: step.step_id }));
      }
      return events;
    },
  };
}
