import { describe, expect, test } from 'bun:test';
import { type WorkflowEvent, WorkflowEventSchema } from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createIntelligenceWorkflowProjectRoutes } from '../workflows/project-routes';
import type { WorkflowService } from '../workflows/service';
import {
  createIntelligenceAgUiConnectionPool,
  createIntelligenceAgUiWorkflowStream,
} from './stream';

const ACCOUNT_ID = '81000000-0000-4000-a000-000000000001';
const PROJECT_ID = '82000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '82000000-0000-4000-a000-000000000002';
const USER_ID = '83000000-0000-4000-a000-000000000001';
const RUN_ID = '84000000-0000-4000-a000-000000000001';
const EVENT_ID = '85000000-0000-4000-a000-000000000001';
const NOW = '2026-07-21T12:00:00.000Z';

function workflowEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return WorkflowEventSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    event_id: EVENT_ID,
    run_id: RUN_ID,
    sequence: 1,
    type: 'run_succeeded',
    status: 'succeeded',
    graph_version: 1,
    node_id: null,
    task_id: null,
    progress: null,
    reason_code: null,
    asset_ids: [],
    route_reason_codes: [],
    evaluation_version: null,
    created_at: NOW,
    ...overrides,
  });
}

type RouteOptions = {
  enabled?: boolean;
  projectMissing?: boolean;
  deny?: boolean;
  runMissing?: boolean;
  readEvents?: (input: { afterSequence: number }) => Promise<{
    items: WorkflowEvent[];
    nextCursor: string | null;
  }>;
};

function createRouteApp(options: RouteOptions = {}) {
  const readCalls: Array<{ afterSequence: number }> = [];
  const service = {
    getRun: async (input: { projectId: string; runId: string }) =>
      options.runMissing || input.projectId !== PROJECT_ID || input.runId !== RUN_ID
        ? null
        : { run_id: RUN_ID },
    readEvents: async (input: {
      accountId: string;
      projectId: string;
      runId: string;
      afterSequence: number;
      limit: number;
    }) => {
      readCalls.push({ afterSequence: input.afterSequence });
      return (
        (await options.readEvents?.({ afterSequence: input.afterSequence })) ?? {
          items:
            readCalls.length === 1
              ? [
                  workflowEvent({
                    sequence: input.afterSequence + 1,
                    event_id: `${EVENT_ID.slice(0, -1)}${input.afterSequence + 1}`,
                  }),
                ]
              : [],
          nextCursor: null,
        }
      );
    },
  } as unknown as WorkflowService;

  const routes = createIntelligenceWorkflowProjectRoutes({
    service,
    loadProjectForUser: async (_context, projectId) =>
      options.projectMissing || projectId !== PROJECT_ID
        ? null
        : { row: { accountId: ACCOUNT_ID, projectId }, userId: USER_ID },
    assertProjectCapability: async () => {
      if (options.deny) throw new HTTPException(403, { message: 'Forbidden' });
    },
    isAgentCardTrusted: async () => false,
    agUi: { enabled: options.enabled ?? true },
  });
  const app = new Hono();
  app.route('/v1/projects', routes);
  app.onError((error, context) => {
    if (error instanceof HTTPException) return context.json({ error: error.message }, error.status);
    return context.json({ error: 'Internal error' }, 500);
  });
  return { app, readCalls };
}

describe('Intelligence AG-UI SSE stream', () => {
  test('returns a stable disabled response without changing workflow replay routes', async () => {
    const { app, readCalls } = createRouteApp({ enabled: false });
    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'INTELLIGENCE_AG_UI_DISABLED' });
    expect(readCalls).toEqual([]);
  });

  test('enforces project and run fences before starting a stream', async () => {
    const missingProject = createRouteApp({ projectMissing: true });
    const missingProjectResponse = await missingProject.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
    );
    expect(missingProjectResponse.status).toBe(404);

    const foreignProject = createRouteApp();
    const foreignProjectResponse = await foreignProject.app.request(
      `/v1/projects/${OTHER_PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
    );
    expect(foreignProjectResponse.status).toBe(404);

    const denied = createRouteApp({ deny: true });
    const deniedResponse = await denied.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
    );
    expect(deniedResponse.status).toBe(403);

    const missingRun = createRouteApp({ runMissing: true });
    const missingRunResponse = await missingRun.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
    );
    expect(missingRunResponse.status).toBe(404);
  });

  test('uses the query cursor before Last-Event-ID and validates both values', async () => {
    const queryFirst = createRouteApp();
    const queryResponse = await queryFirst.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream?cursor=4`,
      { headers: { 'Last-Event-ID': '9' } },
    );
    await queryResponse.text();
    expect(queryFirst.readCalls.map((call) => call.afterSequence)).toEqual([4, 5]);

    const headerFallback = createRouteApp();
    const headerResponse = await headerFallback.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
      { headers: { 'Last-Event-ID': '7' } },
    );
    await headerResponse.text();
    expect(headerFallback.readCalls.map((call) => call.afterSequence)).toEqual([7, 8]);

    for (const path of ['?cursor=-1', '?cursor=abc', '?cursor=9007199254740992']) {
      const invalid = createRouteApp();
      const response = await invalid.app.request(
        `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream${path}`,
      );
      expect(response.status).toBe(400);
      expect(invalid.readCalls).toEqual([]);
    }

    for (const header of ['-1', 'abc', '9007199254740992']) {
      const invalid = createRouteApp();
      const response = await invalid.app.request(
        `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
        { headers: { 'Last-Event-ID': header } },
      );
      expect(response.status).toBe(400);
      expect(invalid.readCalls).toEqual([]);
    }
  });

  test('commits the durable resume cursor only after every projected frame', async () => {
    const routeSelected = workflowEvent({
      event_id: '85000000-0000-4000-a000-000000000002',
      sequence: 2,
      type: 'route_selected',
      status: 'running',
    });
    const terminal = workflowEvent({ sequence: 3 });
    const options = {
      readEvents: async ({ afterSequence }: { afterSequence: number }) => ({
        items: [routeSelected, terminal].filter((event) => event.sequence > afterSequence),
        nextCursor: null,
      }),
    };
    const initial = createRouteApp(options);
    const initialResponse = await initial.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream?cursor=1`,
    );
    const initialFrames = (await initialResponse.text()).trim().split('\n\n');

    expect(initialFrames[0]).toContain('event: TOOL_CALL_START');
    expect(initialFrames[0]).toContain('id: 1\nevent: TOOL_CALL_START');
    expect(initialFrames[1]).toContain('id: 2\nevent: TOOL_CALL_RESULT');

    // A disconnect after the first frame retains the prior durable cursor.
    const resumed = createRouteApp(options);
    const resumedResponse = await resumed.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream`,
      { headers: { 'Last-Event-ID': '1' } },
    );
    const resumedBody = await resumedResponse.text();
    expect(resumedBody).toContain('event: TOOL_CALL_START');
    expect(resumedBody).toContain('id: 2\nevent: TOOL_CALL_RESULT');
  });

  test('replays durable events as bounded AG-UI SSE frames and closes after a final flush', async () => {
    const privateEvent = {
      ...workflowEvent({ sequence: 1, type: 'run_started', status: 'running' }),
      prompt: 'private prompt must never cross the stream boundary',
      provider_url: 'https://provider.example.test',
    } as unknown as WorkflowEvent;
    const terminalEvent = workflowEvent({ sequence: 2, event_id: EVENT_ID, asset_ids: [] });
    const { app, readCalls } = createRouteApp({
      readEvents: async ({ afterSequence }) =>
        afterSequence === 0
          ? { items: [privateEvent, terminalEvent], nextCursor: null }
          : { items: [], nextCursor: null },
    });

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/ag-ui/workflows/${RUN_ID}/stream?cursor=0`,
      { headers: { accept: 'text/event-stream' } },
    );
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain('id: 2\nevent: RUN_FINISHED\ndata:');
    expect(body).toContain(`"threadId":"${RUN_ID}"`);
    expect(body).not.toMatch(/private prompt|provider\.example|payload|credential/i);
    expect(readCalls.map((call) => call.afterSequence)).toEqual([0, 2]);
  });

  test('keeps polling bounded, sends keepalives, and cleans up on disconnect', async () => {
    const controller = new AbortController();
    const pool = createIntelligenceAgUiConnectionPool(1);
    let readCount = 0;
    const keepalive = { emit: null as (() => void) | null };
    let cleared = 0;
    const response = createIntelligenceAgUiWorkflowStream({
      scope: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, runId: RUN_ID },
      afterSequence: 0,
      signal: controller.signal,
      connections: pool,
      readEvents: async () => {
        readCount += 1;
        return { items: [], nextCursor: null };
      },
      sleep: async () => {
        controller.abort();
      },
      setInterval: (callback) => {
        keepalive.emit = callback;
        return 1 as never;
      },
      clearInterval: () => {
        cleared += 1;
      },
    });

    expect(response).not.toBeNull();
    if (response === null || response.body === null)
      throw new Error('expected an SSE response body');
    const reader = response.body.getReader();
    if (keepalive.emit === null) throw new Error('expected a keepalive callback');
    keepalive.emit();
    const keepaliveFrame = await reader.read();
    expect(new TextDecoder().decode(keepaliveFrame.value)).toBe(': keep-alive\n\n');
    const closed = await reader.read();
    expect(closed.done).toBeTrue();
    expect(readCount).toBe(1);
    expect(cleared).toBe(1);
    expect(pool.active()).toBe(0);
  });

  test('rejects a connection over the process cap and releases the slot on cancellation', async () => {
    const controller = new AbortController();
    const pool = createIntelligenceAgUiConnectionPool(1);
    const first = createIntelligenceAgUiWorkflowStream({
      scope: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, runId: RUN_ID },
      afterSequence: 0,
      signal: controller.signal,
      connections: pool,
      readEvents: async () => ({ items: [], nextCursor: null }),
      sleep: async () => {
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });
    const second = createIntelligenceAgUiWorkflowStream({
      scope: { accountId: ACCOUNT_ID, projectId: PROJECT_ID, runId: RUN_ID },
      afterSequence: 0,
      signal: new AbortController().signal,
      connections: pool,
      readEvents: async () => ({ items: [], nextCursor: null }),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    controller.abort();
    if (first === null) throw new Error('expected the first stream connection');
    await first.text();
    expect(pool.active()).toBe(0);
  });
});
