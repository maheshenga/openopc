import { createHmac, randomUUID } from 'node:crypto';
import { type Database, automationJobEvents, automationJobs } from '@kortix/db';
import {
  type AutomationExecutionDomain,
  type AutomationJobStatus,
  type AutomationLease,
  AutomationLeaseSchema,
} from '@kortix/intelligence-contracts';
import { and, eq, gt, inArray, isNull, lte, max, or, sql } from 'drizzle-orm';

export interface LeaseManager {
  claim(jobId: string, owner: string, now: Date, ttlMs: number): Promise<AutomationLease | null>;
  heartbeat(jobId: string, owner: string, now: Date, ttlMs: number): Promise<boolean>;
  release(jobId: string, owner: string, now: Date): Promise<void>;
  isCurrent(jobId: string, owner: string, now: Date): Promise<boolean>;
}

export type MemoryLeaseJob = Readonly<{
  jobId: string;
  projectId: string;
  executionDomain: AutomationExecutionDomain;
  requestHash: string;
  killSwitchGeneration: number;
  status: AutomationJobStatus;
}>;

type MemoryLease = {
  owner: string;
  expiresAt: Date;
};

function signLease(lease: Omit<AutomationLease, 'signature'>, sharedSecret: string): string {
  const payload = [
    lease.lease_id,
    lease.job_id,
    lease.project_id,
    lease.execution_domain,
    lease.owner,
    lease.permission_id ?? '',
    lease.request_hash,
    lease.kill_switch_generation,
    lease.issued_at,
    lease.expires_at,
  ].join('\n');
  return `hmac-sha256:${createHmac('sha256', sharedSecret).update(payload).digest('hex')}`;
}

type LeasableJob = Readonly<{
  jobId: string;
  projectId: string;
  executionDomain: AutomationExecutionDomain;
  requestHash: string;
  killSwitchGeneration: number;
}>;

function issueLease(
  job: LeasableJob,
  owner: string,
  issuedAt: Date,
  expiresAt: Date,
  sharedSecret: string,
): AutomationLease {
  const unsignedLease: Omit<AutomationLease, 'signature'> = {
    lease_id: randomUUID(),
    job_id: job.jobId,
    project_id: job.projectId,
    execution_domain: job.executionDomain,
    owner,
    permission_id: null,
    request_hash: job.requestHash,
    kill_switch_generation: job.killSwitchGeneration,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  return AutomationLeaseSchema.parse({
    ...unsignedLease,
    signature: signLease(unsignedLease, sharedSecret),
  });
}

export function createMemoryLeaseManager(input: {
  sharedSecret: string;
  jobs: readonly MemoryLeaseJob[];
}): LeaseManager {
  const jobs = new Map(input.jobs.map((job) => [job.jobId, { ...job }]));
  const leases = new Map<string, MemoryLease>();

  return {
    async claim(jobId, owner, now, ttlMs) {
      const job = jobs.get(jobId);
      const existing = leases.get(jobId);
      if (
        !job ||
        job.status !== 'queued' ||
        (existing !== undefined && existing.expiresAt.getTime() > now.getTime())
      ) {
        return null;
      }

      const expiresAt = new Date(now.getTime() + ttlMs);
      leases.set(jobId, { owner, expiresAt });
      job.status = 'dispatched';
      return issueLease(job, owner, now, expiresAt, input.sharedSecret);
    },
    async heartbeat(jobId, owner, now, ttlMs) {
      const job = jobs.get(jobId);
      const lease = leases.get(jobId);
      if (
        !job ||
        !['dispatched', 'running'].includes(job.status) ||
        lease === undefined ||
        lease.owner !== owner ||
        lease.expiresAt.getTime() <= now.getTime()
      ) {
        return false;
      }
      lease.expiresAt = new Date(now.getTime() + ttlMs);
      return true;
    },
    async release(jobId, owner, now) {
      const lease = leases.get(jobId);
      if (
        lease !== undefined &&
        lease.owner === owner &&
        lease.expiresAt.getTime() > now.getTime()
      ) {
        leases.delete(jobId);
      }
    },
    async isCurrent(jobId, owner, now) {
      const lease = leases.get(jobId);
      return (
        lease !== undefined && lease.owner === owner && lease.expiresAt.getTime() > now.getTime()
      );
    },
  };
}

export function createPostgresLeaseManager(db: Database, sharedSecret: string): LeaseManager {
  return {
    async claim(jobId, owner, now, ttlMs) {
      const nowIso = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs);
      const expiresAtIso = expiresAt.toISOString();

      return db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(automationJobs)
          .where(
            and(
              eq(automationJobs.jobId, jobId),
              inArray(automationJobs.status, ['queued', 'dispatched']),
              or(
                isNull(automationJobs.leaseExpiresAt),
                lte(automationJobs.leaseExpiresAt, sql`clock_timestamp()`),
              ),
              gt(
                automationJobs.deadlineAt,
                sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
              ),
            ),
          )
          .limit(1)
          .for('update');
        if (!job) return null;

        const [updated] = await tx
          .update(automationJobs)
          .set({
            status: 'dispatched',
            leaseOwner: owner,
            leaseExpiresAt: expiresAtIso,
            updatedAt: nowIso,
          })
          .where(eq(automationJobs.jobId, jobId))
          .returning();
        if (!updated) return null;

        const [maximum] = await tx
          .select({ value: max(automationJobEvents.sequence) })
          .from(automationJobEvents)
          .where(eq(automationJobEvents.jobId, jobId));
        await tx.insert(automationJobEvents).values({
          jobId,
          sequence: Number(maximum?.value ?? 0) + 1,
          type: 'job_dispatched',
          status: 'dispatched',
          payload: { lease_owner: owner },
          traceId: null,
          createdAt: nowIso,
        });

        return issueLease(updated, owner, now, expiresAt, sharedSecret);
      });
    },

    async heartbeat(jobId, owner, now, ttlMs) {
      const nowIso = now.toISOString();
      const [updated] = await db
        .update(automationJobs)
        .set({
          leaseExpiresAt: new Date(now.getTime() + ttlMs).toISOString(),
          updatedAt: nowIso,
        })
        .where(
          and(
            eq(automationJobs.jobId, jobId),
            eq(automationJobs.leaseOwner, owner),
            gt(
              automationJobs.leaseExpiresAt,
              sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
            ),
            inArray(automationJobs.status, ['dispatched', 'running']),
          ),
        )
        .returning({ jobId: automationJobs.jobId });
      return updated !== undefined;
    },

    async release(jobId, owner, now) {
      const nowIso = now.toISOString();
      await db
        .update(automationJobs)
        .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: nowIso })
        .where(
          and(
            eq(automationJobs.jobId, jobId),
            eq(automationJobs.leaseOwner, owner),
            gt(
              automationJobs.leaseExpiresAt,
              sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
            ),
          ),
        );
    },

    async isCurrent(jobId, owner, now) {
      const nowIso = now.toISOString();
      const [current] = await db
        .select({ jobId: automationJobs.jobId })
        .from(automationJobs)
        .where(
          and(
            eq(automationJobs.jobId, jobId),
            eq(automationJobs.leaseOwner, owner),
            gt(
              automationJobs.leaseExpiresAt,
              sql`GREATEST(clock_timestamp(), ${nowIso}::timestamptz)`,
            ),
            inArray(automationJobs.status, ['dispatched', 'running']),
          ),
        )
        .limit(1);
      return current !== undefined;
    },
  };
}
