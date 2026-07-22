import {
  type AutomationEvent,
  AutomationEventSchema,
  type AutomationWorkerHeartbeat,
  AutomationWorkerHeartbeatEnvelopeSchema,
  AutomationWorkerHeartbeatSchema,
} from '@kortix/intelligence-contracts';
import type { DispatchLeaseBinding } from './browser-dispatcher';
import type {
  VerifiedWorkerPeer,
  WorkerServiceAuthenticator,
  WorkerServiceProof,
} from './worker-auth';

export type WorkerHeartbeat = AutomationWorkerHeartbeat;

export type HeartbeatEventAppendResult =
  | Readonly<{ accepted: true; event: AutomationEvent }>
  | Readonly<{
      accepted: false;
      reason: 'stale_lease' | 'replayed_ordinal' | 'semantic_mismatch';
    }>;

export interface HeartbeatEventSink {
  /**
   * In one durable transaction, verify the exact account/project/job/lease/owner/generation
   * binding, worker ordinal, and event semantics; then allocate sequence and persist the event.
   * A rejected result must leave both the ordinal and event store unchanged.
   */
  append(input: {
    binding: DispatchLeaseBinding;
    workerId: string;
    workerOrdinal: number;
    observedAt: Date;
    event: WorkerHeartbeat['event'];
  }): Promise<HeartbeatEventAppendResult>;
}

export type WorkerHeartbeatFailureReason =
  | 'identity_mismatch'
  | 'sensitive_payload'
  | 'invalid_payload'
  | 'stale_observation'
  | 'stale_lease'
  | 'replayed_ordinal'
  | 'semantic_mismatch';

export class WorkerHeartbeatError extends Error {
  override readonly name = 'WorkerHeartbeatError';

  constructor(
    readonly reason: WorkerHeartbeatFailureReason,
    message: string,
  ) {
    super(message);
  }
}

const SENSITIVE_KEY =
  /authorization|cookies?|credentials?|passwords?|secrets?|tokens?|apikeys?|clientsecret|sessioncookie|(?:pre)?signedurls?/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => isSensitiveKey(key) || containsSensitiveKey(entry),
  );
}

export function createHeartbeatProcessor(input: {
  authenticator: WorkerServiceAuthenticator;
  now?: () => Date;
  maxObservedSkewMs?: number;
  isLeaseBindingCurrent: (binding: DispatchLeaseBinding) => Promise<boolean>;
  eventSink: HeartbeatEventSink;
}) {
  const now = input.now ?? (() => new Date());
  const maxObservedSkewMs = input.maxObservedSkewMs ?? 60_000;
  return {
    async handle(raw: {
      peer: VerifiedWorkerPeer;
      proof: WorkerServiceProof;
      heartbeat: WorkerHeartbeat;
    }): Promise<AutomationEvent> {
      const envelope = AutomationWorkerHeartbeatEnvelopeSchema.safeParse(raw.heartbeat);
      if (!envelope.success) {
        throw new WorkerHeartbeatError(
          'invalid_payload',
          'heartbeat envelope is not a valid worker payload',
        );
      }
      const unvalidatedHeartbeat = envelope.data;
      input.authenticator.assertPeer(raw.peer, 'browser-worker');
      if (unvalidatedHeartbeat.worker_id !== raw.peer.serviceId) {
        throw new WorkerHeartbeatError(
          'identity_mismatch',
          'heartbeat worker identity does not match its TLS peer',
        );
      }
      await input.authenticator.verify({
        peer: raw.peer,
        expectedRole: 'browser-worker',
        proof: raw.proof,
        body: unvalidatedHeartbeat,
      });
      if (containsSensitiveKey(unvalidatedHeartbeat.event.payload)) {
        throw new WorkerHeartbeatError(
          'sensitive_payload',
          'heartbeat payload contains a forbidden sensitive field',
        );
      }
      const heartbeat = AutomationWorkerHeartbeatSchema.safeParse(unvalidatedHeartbeat);
      if (!heartbeat.success) {
        throw new WorkerHeartbeatError(
          'invalid_payload',
          'heartbeat event is not a valid worker payload',
        );
      }
      const observedAt = new Date(heartbeat.data.observed_at);
      if (
        !Number.isSafeInteger(maxObservedSkewMs) ||
        maxObservedSkewMs < 1 ||
        Math.abs(now().getTime() - observedAt.getTime()) > maxObservedSkewMs
      ) {
        throw new WorkerHeartbeatError(
          'stale_observation',
          'heartbeat observation timestamp is stale',
        );
      }
      const binding: DispatchLeaseBinding = {
        accountId: heartbeat.data.account_id,
        projectId: heartbeat.data.project_id,
        jobId: heartbeat.data.job_id,
        leaseId: heartbeat.data.lease_id,
        owner: heartbeat.data.lease_owner,
        killSwitchGeneration: heartbeat.data.kill_switch_generation,
      };
      if (!(await input.isLeaseBindingCurrent(binding))) {
        throw new WorkerHeartbeatError('stale_lease', 'heartbeat lease is not current');
      }
      const appendResult = await input.eventSink.append({
        binding,
        workerId: heartbeat.data.worker_id,
        workerOrdinal: heartbeat.data.ordinal,
        observedAt,
        event: heartbeat.data.event,
      });
      if (!appendResult.accepted) {
        if (appendResult.reason === 'stale_lease') {
          throw new WorkerHeartbeatError(
            'stale_lease',
            'heartbeat lease is not current at the durable event boundary',
          );
        }
        if (appendResult.reason === 'replayed_ordinal') {
          throw new WorkerHeartbeatError(
            'replayed_ordinal',
            'heartbeat worker ordinal was replayed at durable append',
          );
        }
        throw new WorkerHeartbeatError(
          'semantic_mismatch',
          'heartbeat event does not match the current job semantics',
        );
      }
      return AutomationEventSchema.parse(appendResult.event);
    },
  };
}
