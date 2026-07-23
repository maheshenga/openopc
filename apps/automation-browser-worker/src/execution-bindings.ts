import type {
  AutomationBrowserAuthorityCheckInput,
  AutomationEvent,
  AutomationStep,
  AutomationWorkerHeartbeat,
} from '@kortix/intelligence-contracts';
import { createDispatchApprovalConsumer } from './approval-resume';
import type { BrowserApprovalResumeClient } from './approval-resume-client';
import type { BrowserAuthorityClient, BrowserAuthorityInput } from './authority-client';
import type { EvidenceStore } from './evidence-writer';
import type { BrowserDispatchWorkItem } from './dispatch-source';
import type { BrowserWorkerAuthenticatedEventEmitter } from './heartbeat-client';
import type { RuntimeIsolationAttestor } from './runtime-isolation';
import {
  runIsolatedBrowserRequest,
  type AutomationAuditIntent,
  type BrowserWorkerInput,
} from './worker';

type EventChannelState = { usable: boolean; terminalWritten: boolean };
type AuthorityCheck = AutomationBrowserAuthorityCheckInput['check'];

export type BrowserExecutionBindingInput = Readonly<{
  workItem: BrowserDispatchWorkItem;
  authority: BrowserAuthorityClient;
  isolation: RuntimeIsolationAttestor;
  approvalClient: BrowserApprovalResumeClient;
  evidenceStore: EvidenceStore;
  eventEmitter: BrowserWorkerAuthenticatedEventEmitter;
  launchBrowser?: BrowserWorkerInput['launchBrowser'];
  startProxy?: BrowserWorkerInput['startProxy'];
  heartbeat?: BrowserWorkerInput['heartbeat'];
}>;

type BrowserExecutionBindings = Readonly<{
  isSignedLeaseValid: BrowserWorkerInput['isSignedLeaseValid'];
  isLeaseCurrent: BrowserWorkerInput['isLeaseCurrent'];
  currentKillSwitchGeneration: BrowserWorkerInput['currentKillSwitchGeneration'];
  isActionHashCurrent: BrowserWorkerInput['isActionHashCurrent'];
  isFullAccessGrantCurrent: BrowserWorkerInput['isFullAccessGrantCurrent'];
  isResumeCursorCurrent: BrowserWorkerInput['isResumeCursorCurrent'];
  isRuntimeIsolationAttested: BrowserWorkerInput['isRuntimeIsolationAttested'];
  consumeApproval: BrowserWorkerInput['consumeApproval'];
  evidenceStore: EvidenceStore;
  auditSink: BrowserWorkerInput['auditSink'];
  actionEventSink: BrowserWorkerInput['actionEventSink'];
  waitForApproval: undefined;
  eventChannel: EventChannelState;
}>;

export type BrowserExecutionResult = Readonly<{
  terminal: 'awaiting_approval' | 'succeeded';
}>;

function authorityInputFromWorkItem(
  workItem: BrowserDispatchWorkItem,
  check: AuthorityCheck,
): BrowserAuthorityInput {
  const { lease, request } = workItem.envelope;
  return {
    account_id: request.tenant_id,
    project_id: request.project_id,
    job_id: lease.job_id,
    lease_id: lease.lease_id,
    lease_owner: lease.owner,
    request_hash: lease.request_hash,
    kill_switch_generation: lease.kill_switch_generation,
    check,
  };
}

function eventSinkFor(
  input: BrowserExecutionBindingInput,
  workItem: BrowserDispatchWorkItem,
  eventChannel: EventChannelState,
): {
  write(intent: {
    type: AutomationEvent['type'];
    payload: Record<string, unknown>;
    trace_id: string | null;
  }): Promise<void>;
} {
  return Object.freeze({
    async write(intent) {
      try {
        await input.eventEmitter.emit({
          lease: workItem.envelope.lease,
          request: workItem.envelope.request,
          event: {
            type: intent.type,
            payload: intent.payload,
            trace_id: intent.trace_id,
          } as AutomationWorkerHeartbeat['event'],
          signal: workItem.signal,
        });
        if (intent.type === 'job_failed' || intent.type === 'job_succeeded') {
          eventChannel.terminalWritten = true;
        }
      } catch (error) {
        eventChannel.usable = false;
        throw error;
      }
    },
  });
}

export function createBrowserExecutionBindings(
  input: BrowserExecutionBindingInput,
): BrowserExecutionBindings {
  const eventChannel: EventChannelState = { usable: true, terminalWritten: false };
  const authorityFor = (check: AuthorityCheck) =>
    input.authority.check(authorityInputFromWorkItem(input.workItem, check));
  return Object.freeze({
    isSignedLeaseValid: async () => (await authorityFor({ kind: 'lease' })).authorized,
    isLeaseCurrent: async () => (await authorityFor({ kind: 'lease' })).authorized,
    currentKillSwitchGeneration: async () =>
      (await authorityFor({ kind: 'generation' })).kill_switch_generation,
    isActionHashCurrent: async (step: AutomationStep) =>
      (
        await authorityFor({
          kind: 'action',
          step_id: step.step_id,
          action_hash: step.action_hash,
        })
      ).authorized,
    isFullAccessGrantCurrent: async () =>
      (await authorityFor({ kind: 'full_access' })).full_access_grant_current,
    isResumeCursorCurrent: async ({ resumeAfterSequence }) =>
      (await authorityFor({ kind: 'cursor', resume_after_sequence: resumeAfterSequence }))
        .authorized,
    isRuntimeIsolationAttested: async () => input.isolation.attest(),
    consumeApproval: createDispatchApprovalConsumer({
      workItem: input.workItem,
      client: input.approvalClient,
    }),
    evidenceStore: input.evidenceStore,
    auditSink: eventSinkFor(input, input.workItem, eventChannel),
    actionEventSink: eventSinkFor(input, input.workItem, eventChannel),
    waitForApproval: undefined,
    eventChannel,
  });
}

function terminalIntent(workItem: BrowserDispatchWorkItem, type: 'job_succeeded' | 'job_failed') {
  const lease = workItem.envelope.lease;
  const payload =
    type === 'job_succeeded' ? {} : { cleanup_error_count: 0, project_id: lease.project_id };
  return {
    protocol_version: 'automation.v1' as const,
    job_id: lease.job_id,
    project_id: lease.project_id,
    lease_id: lease.lease_id,
    kill_switch_generation: lease.kill_switch_generation,
    type,
    payload,
    trace_id: null,
  } satisfies AutomationAuditIntent;
}

export async function executeBrowserDispatchWorkItem(
  input: BrowserExecutionBindingInput,
): Promise<BrowserExecutionResult> {
  const { workItem } = input;
  if (workItem.envelope.request.browser_policy?.context.mode === 'persistent') {
    throw new Error('persistent browser profiles require a one-time profile broker');
  }
  const bindings = createBrowserExecutionBindings(input);
  try {
    const events = await runIsolatedBrowserRequest({
      lease: workItem.envelope.lease,
      request: workItem.envelope.request,
      resumeAfterSequence: workItem.envelope.resume_after_sequence,
      signal: workItem.signal,
      launchBrowser: input.launchBrowser,
      startProxy: input.startProxy,
      heartbeat: input.heartbeat,
      ...bindings,
      // The runner already treats this callback as optional; its older input type is narrower.
      waitForApproval: undefined as never,
    });
    if (events.at(-1)?.type === 'approval_required') {
      return { terminal: 'awaiting_approval' };
    }
    await bindings.auditSink.write(terminalIntent(workItem, 'job_succeeded'));
    return { terminal: 'succeeded' };
  } catch (error) {
    if (bindings.eventChannel.usable && !bindings.eventChannel.terminalWritten) {
      try {
        await bindings.auditSink.write(terminalIntent(workItem, 'job_failed'));
      } catch {
        // Event transport has become unusable; preserve the original execution error.
      }
    }
    throw error;
  }
}
