import { type Database, automationJobEvents, automationJobs } from '@kortix/db';
import { type AutomationEvent, AutomationEventSchema } from '@kortix/intelligence-contracts';
import { and, asc, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { InternalAutomationEnv } from '../internal-auth';
import type { AutomationRepository } from '../repository';
import { toPublicAutomationValue } from './public-value';

export interface AutomationEventReader {
  listAfter(input: {
    accountId: string;
    projectId: string;
    jobId: string;
    cursor: number;
    limit: number;
  }): Promise<readonly AutomationEvent[]>;
}

export type AutomationEventStreamOptions = Readonly<{
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxStreamMs?: number;
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}>;

export function createPostgresAutomationEventReader(db: Database): AutomationEventReader {
  return {
    async listAfter(input) {
      const rows = await db
        .select({ event: automationJobEvents })
        .from(automationJobEvents)
        .innerJoin(automationJobs, eq(automationJobs.jobId, automationJobEvents.jobId))
        .where(
          and(
            eq(automationJobs.accountId, input.accountId),
            eq(automationJobs.projectId, input.projectId),
            eq(automationJobEvents.jobId, input.jobId),
            gt(automationJobEvents.sequence, input.cursor),
          ),
        )
        .orderBy(asc(automationJobEvents.sequence))
        .limit(input.limit);
      return rows.map(({ event }) =>
        AutomationEventSchema.parse({
          protocol_version: 'automation.v1',
          event_id: event.eventId,
          job_id: event.jobId,
          sequence: event.sequence,
          type: event.type,
          status: event.status,
          payload: event.payload,
          trace_id: event.traceId,
          created_at: event.createdAt,
        }),
      );
    },
  };
}

function cursorValue(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export function createEventsRouter(input: {
  repository: AutomationRepository;
  eventReader: AutomationEventReader;
  stream?: AutomationEventStreamOptions;
}): Hono<InternalAutomationEnv> {
  const router = new Hono<InternalAutomationEnv>();
  router.get('/:jobId/events', async (context) => {
    const actor = context.get('automationActor');
    const jobId = context.req.param('jobId');
    const job = await input.repository.getJobForProject(actor.accountId, actor.projectId, jobId);
    if (!job) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_NOT_FOUND',
          message: 'Automation job was not found',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        404,
      );
    }
    const cursor = cursorValue(context.req.query('cursor'));
    if (cursor === null) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Event cursor is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const pollIntervalMs = input.stream?.pollIntervalMs ?? 500;
    const heartbeatIntervalMs = input.stream?.heartbeatIntervalMs ?? 15_000;
    const maxStreamMs = input.stream?.maxStreamMs ?? 55_000;
    const now = input.stream?.now ?? Date.now;
    const sleep = input.stream?.sleep ?? ((durationMs) => Bun.sleep(durationMs));
    const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'expired']);

    return streamSSE(context, async (stream) => {
      let nextCursor = cursor;
      const startedAt = now();
      let lastHeartbeatAt = startedAt;
      await stream.write(': heartbeat\n\n');

      while (!stream.closed && now() - startedAt < maxStreamMs) {
        const events = (
          await input.eventReader.listAfter({
            accountId: actor.accountId,
            projectId: actor.projectId,
            jobId,
            cursor: nextCursor,
            limit: 256,
          })
        )
          .map((event) =>
            AutomationEventSchema.parse({
              ...event,
              payload: toPublicAutomationValue(event.payload),
            }),
          )
          .filter((event) => event.sequence > nextCursor)
          .sort((left, right) => left.sequence - right.sequence);

        let terminal = terminalStatuses.has(job.status);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: 'automation',
            data: JSON.stringify(event),
          });
          nextCursor = event.sequence;
          terminal ||= event.status !== null && terminalStatuses.has(event.status);
        }
        if (terminal) return;

        if (now() - lastHeartbeatAt >= heartbeatIntervalMs) {
          await stream.write(': heartbeat\n\n');
          lastHeartbeatAt = now();
        }
        await sleep(pollIntervalMs);
      }
    });
  });
  return router;
}
