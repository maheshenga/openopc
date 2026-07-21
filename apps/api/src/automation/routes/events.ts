import { createRoute, z } from '@hono/zod-openapi';
import { AutomationErrorSchema, AutomationEventSchema } from '@kortix/intelligence-contracts';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { projectAutomationEvent } from '../ag-ui/projector';
import { automationActorFromProject } from '../auth-context';
import type { AutomationApiDependencies } from '../index';
import { loadAutomationProject } from './shared';

function cursorValue(value: string | undefined): number | null {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function projectSse(upstream: Response, initialCursor: number): Response {
  if (!upstream.body) return new Response(null, { status: 502 });
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let cursor = initialCursor;
  let buffer = '';
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const frameEnd = buffer.indexOf('\n\n');
        if (frameEnd >= 0) {
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          if (frame.startsWith(':')) {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
            return;
          }
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          let value: unknown = null;
          try {
            value = JSON.parse(data || 'null');
          } catch {
            continue;
          }
          const parsed = AutomationEventSchema.safeParse(value);
          if (!parsed.success) continue;
          const projected = projectAutomationEvent(parsed.data);
          const priorCursor = cursor;
          const frames = projected.map((event, index) => {
            const id = index === projected.length - 1 ? parsed.data.sequence : priorCursor;
            return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          });
          cursor = parsed.data.sequence;
          if (frames.length > 0) {
            controller.enqueue(encoder.encode(frames.join('')));
            return;
          }
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
      }
    },
    cancel() {
      return reader.cancel();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export function createAutomationEventsRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'get',
      path: '/{jobId}/events',
      tags: ['automation'],
      summary: 'Stream automation AG-UI events',
      ...auth,
      request: {
        params: z.object({ jobId: z.string().uuid() }),
        query: z.object({ project_id: z.string().uuid(), cursor: z.string().optional() }),
      },
      responses: {
        200: {
          description: 'AG-UI event stream',
          content: { 'text/event-stream': { schema: z.string() } },
        },
        ...errors(400, 401, 403, 404, 503),
      },
    }),
    async (context) => {
      const { project_id: projectId, cursor: queryCursor } = context.req.valid('query');
      const { jobId } = context.req.valid('param');
      const cursor = cursorValue(queryCursor ?? context.req.header('last-event-id'));
      if (cursor === null)
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
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'read');
      const upstream = await dependencies.controlClient.stream({
        method: 'GET',
        path: `/v1/automation/jobs/${jobId}/events?cursor=${cursor}`,
        actor: automationActorFromProject(loaded),
      });
      if (!upstream.ok) {
        const parsed = AutomationErrorSchema.safeParse(await upstream.json().catch(() => null));
        return parsed.success
          ? (context.json(parsed.data, upstream.status as never) as never)
          : (context.json(
              {
                protocol_version: 'automation.v1',
                code: 'AUTOMATION_INTERNAL',
                message: 'Automation event stream failed',
                retryable: true,
                approval_status: null,
                audit_event_id: null,
              },
              502,
            ) as never);
      }
      return projectSse(upstream, cursor) as never;
    },
  );
  return router;
}
