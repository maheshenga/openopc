import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  type IntelligenceWorkflowStartRequest,
  IntelligenceWorkflowStartRequestSchema,
} from '@kortix/api-contract';

const PROJECT_ID = '42000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '43000000-0000-4000-a000-000000000001';
const TASK_ID = '44000000-0000-4000-a000-000000000001';
const JOB_ID = '45000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);
const PRIVATE_PROMPT = 'PRIVATE_MCP_ACCEPTANCE_PROMPT';
const PRIVATE_WORKFLOW_GOAL = 'PRIVATE_MCP_WORKFLOW_GOAL';
const RUN_ID = '46000000-0000-4000-a000-000000000001';

const capability = {
  id: 'studio.image.generate' as const,
  version: '1.0.0',
  modality: 'image' as const,
  operation: 'generate',
  input_schema: { type: 'object', name: 'StudioImageGenerateInput' },
  output_schema: { type: 'array', asset_kinds: ['image'] },
  execution: 'async' as const,
  risk: 'write' as const,
  provenance_required: true,
};
const target = {
  capability_id: 'studio.image.generate' as const,
  provider_config_id: PROVIDER_CONFIG_ID,
  model: 'fake/image-v1',
};
const discovery = {
  protocol_version: 'intelligence.v1' as const,
  items: [capability],
  execution_targets: [target],
  next_cursor: null,
};
const agentCard = {
  id: 'kortix-studio',
  version: '1.0.0',
  display_name: 'Kortix Studio',
  capabilities: ['studio.image.generate'],
  protocols: ['a2a', 'mcp'] as const,
  auth: { kind: 'kortix-project-token' as const },
  trust_tier: 'project' as const,
  limits: { concurrency: 1, max_task_seconds: 900 },
  card_hash: CARD_HASH,
};

describe('Intelligence MCP acceptance', () => {
  test('runs the real stdio server through discovery, idempotent creation, and revocation', async () => {
    const httpCalls: Array<{
      path: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const taskRows = new Map<string, { taskId: string; jobId: string }>();
    const studioJobs = new Set<string>();
    const publicHttpBodies: unknown[] = [];
    let providerSubmissions = 0;
    let revoked = false;

    const respond = (body: unknown, status = 200) => {
      publicHttpBodies.push(body);
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === 'POST' ? await request.json() : null;
        httpCalls.push({
          path: `${url.pathname}${url.search}`,
          authorization: request.headers.get('Authorization'),
          body,
        });
        if (
          url.pathname.endsWith('/intelligence/capabilities') &&
          url.searchParams.get('include') === 'execution_targets'
        ) {
          return respond(discovery);
        }
        if (url.pathname.endsWith('/intelligence/agent-card')) return respond(agentCard);
        if (url.pathname.endsWith('/intelligence/workflows') && request.method === 'POST') {
          const parsed = IntelligenceWorkflowStartRequestSchema.safeParse(body);
          if (!parsed.success) {
            return respond(
              {
                error: 'Invalid Intelligence workflow request',
                code: 'INTELLIGENCE_WORKFLOW_VALIDATION_ERROR',
              },
              400,
            );
          }
          return respond({
            protocol_version: 'intelligence.workflow.v1',
            run: workflowRun(parsed.data),
            created: true,
          });
        }
        if (
          url.pathname.endsWith(`/intelligence/workflows/${RUN_ID}`) &&
          request.method === 'GET'
        ) {
          return respond({
            protocol_version: 'intelligence.workflow.v1',
            run: workflowRun({ protocol_version: 'intelligence.workflow.v1', ...workflowArguments() }),
          });
        }
        if (url.pathname.endsWith('/intelligence/tasks')) {
          const parsed = IntelligenceCreateTaskRequestSchema.safeParse(body);
          if (!parsed.success) {
            return respond(
              { error: 'Invalid Intelligence request', code: 'INTELLIGENCE_VALIDATION_ERROR' },
              400,
            );
          }
          if (revoked) {
            return respond(
              {
                error: 'Agent Card is not trusted for this project',
                code: 'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
              },
              403,
            );
          }
          const existing = taskRows.get(parsed.data.idempotency_key);
          if (existing) {
            return respond({
              protocol_version: 'intelligence.v1',
              task_id: existing.taskId,
              job_id: existing.jobId,
              created: false,
            });
          }
          taskRows.set(parsed.data.idempotency_key, { taskId: TASK_ID, jobId: JOB_ID });
          studioJobs.add(JOB_ID);
          providerSubmissions += 1;
          return respond({
            protocol_version: 'intelligence.v1',
            task_id: TASK_ID,
            job_id: JOB_ID,
            created: true,
          });
        }
        return respond({ error: 'Not found' }, 404);
      },
    });

    const env: Record<string, string | undefined> = {
      ...process.env,
      KORTIX_CLI_TOKEN: 'kortix_pat_mcp_acceptance',
      KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
      KORTIX_PROJECT_ID: PROJECT_ID,
      KORTIX_CONFIG_FILE: '/nonexistent/kortix-intelligence-acceptance.json',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    };
    delete env.KORTIX_EXECUTOR_TOKEN;
    delete env.KORTIX_TOKEN;
    delete env.BASH_ENV;

    const child = Bun.spawn([process.execPath, 'src/index.ts', 'executor', 'mcp'], {
      cwd: resolve(import.meta.dir, '../..'),
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderrPromise = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let stdoutBuffer = '';
    const stdoutLines: string[] = [];

    type JsonRpcResponse = {
      id: number;
      result: {
        protocolVersion?: string;
        tools?: Array<{ name: string }>;
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
    };
    const readResponse = async (): Promise<JsonRpcResponse> => {
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline >= 0) {
          const line = stdoutBuffer.slice(0, newline).trim();
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          stdoutLines.push(line);
          return JSON.parse(line) as JsonRpcResponse;
        }
        const next = await reader.read();
        if (next.done) throw new Error('MCP server closed before its response');
        stdoutBuffer += decoder.decode(next.value, { stream: true });
      }
    };
    const send = (request: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    };

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      });
      const initialized = await readResponse();
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const listed = await readResponse();
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'studio_capabilities', arguments: {} },
      });
      const discovered = await readResponse();
      const discoveryText = discovered.result.content?.[0]?.text;
      if (!discoveryText) throw new Error('missing MCP discovery payload');
      const discoveryPayload = JSON.parse(discoveryText) as {
        execution_targets: typeof discovery.execution_targets;
        agent_card: { card_hash: string };
      };
      const args = taskArguments(discoveryPayload.execution_targets[0]);

      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'workflow_capabilities', arguments: {} },
      });
      const workflowCapabilities = await readResponse();
      send({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'workflow_start', arguments: workflowArguments() },
      });
      const workflowStarted = await readResponse();
      send({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'workflow_status', arguments: { run_id: RUN_ID } },
      });
      const workflowStatus = await readResponse();

      send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'studio_create_task', arguments: args },
      });
      const created = await readResponse();
      send({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'studio_create_task', arguments: args },
      });
      const replayed = await readResponse();

      revoked = true;
      send({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: 'studio_create_task',
          arguments: { ...args, idempotency_key: 'mcp-revoked-acceptance-0001' },
        },
      });
      const denied = await readResponse();
      child.stdin.end();

      const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(initialized).toMatchObject({
        id: 1,
        result: { protocolVersion: '2025-11-25' },
      });
      const toolNames = listed.result.tools?.map((tool) => tool.name) ?? [];
      expect(toolNames).toContain('studio_capabilities');
      expect(toolNames).toContain('studio_create_task');
      expect(toolNames.slice(-3)).toEqual([
        'workflow_capabilities',
        'workflow_start',
        'workflow_status',
      ]);
      expect(toolNames.some((name) => /video|voice|3d|avatar|batch/i.test(name))).toBe(false);
      expect(discoveryPayload.agent_card.card_hash).toBe(CARD_HASH);
      expect(discoveryPayload.execution_targets).toEqual([target]);
      expect(toolPayload(workflowCapabilities)).toMatchObject({
        protocol_version: 'intelligence.workflow.v1',
        capabilities: [{ capability_id: 'studio.image.generate' }],
      });
      expect(toolPayload(workflowStarted)).toEqual({
        ok: true,
        protocol_version: 'intelligence.workflow.v1',
        run_id: RUN_ID,
        status: 'draft',
        created: true,
      });
      expect(toolPayload(workflowStatus)).toMatchObject({
        ok: true,
        run_id: RUN_ID,
        status: 'draft',
      });
      expect(toolPayload(created)).toEqual({ ok: true, task_id: TASK_ID });
      expect(toolPayload(replayed)).toEqual({ ok: true, task_id: TASK_ID });
      expect(denied.result.isError).toBe(true);
      expect(toolPayload(denied)).toMatchObject({
        ok: false,
        code: 'INTELLIGENCE_AGENT_CARD_UNTRUSTED',
      });

      expect(taskRows).toHaveLength(1);
      expect(studioJobs).toEqual(new Set([JOB_ID]));
      expect(providerSubmissions).toBe(1);
      expect(httpCalls).toHaveLength(8);
      expect(
        httpCalls.every((call) => call.authorization === 'Bearer kortix_pat_mcp_acceptance'),
      ).toBe(true);
      const posted = httpCalls.filter((call) => call.path.endsWith('/intelligence/tasks'));
      expect(posted).toHaveLength(3);
      expect(posted[0]?.body).toEqual({ protocol_version: 'intelligence.v1', ...args });

      const publicWire = `${stdoutLines.join('\n')}\n${JSON.stringify(publicHttpBodies)}`;
      expect(publicWire).not.toContain(PRIVATE_PROMPT);
      expect(publicWire).not.toContain(PRIVATE_WORKFLOW_GOAL);
      expect(publicWire).not.toContain('kortix_pat_mcp_acceptance');
      expect(publicWire).not.toMatch(/PRIVATE_(?:PROVIDER_BODY|SIGNED_URL|CREDENTIAL)/);
    } finally {
      child.stdin.end();
      child.kill();
      server.stop(true);
    }
  }, 20_000);
});

function taskArguments(selected = target): Omit<IntelligenceCreateTaskRequest, 'protocol_version'> {
  return {
    capability_id: selected.capability_id,
    agent_card_hash: CARD_HASH,
    provider_config_id: selected.provider_config_id,
    model: selected.model,
    input: {
      capability: 'image.generate',
      image: {
        prompt: PRIVATE_PROMPT,
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    idempotency_key: 'mcp-intelligence-acceptance-0001',
    parent_task_id: null,
    deadline_at: null,
  };
}

function workflowArguments(): Omit<IntelligenceWorkflowStartRequest, 'protocol_version'> {
  return {
    idempotency_key: 'mcp-workflow-acceptance-0001',
    goal: PRIVATE_WORKFLOW_GOAL,
    context_asset_ids: [],
    policy_snapshot_hash: `sha256:${'b'.repeat(64)}`,
    evaluation_version: null,
    max_nodes: 16,
    max_dependencies: 32,
    max_approved_credits: 100,
    deadline_at: null,
  };
}

function workflowRun(request: IntelligenceWorkflowStartRequest) {
  const now = '2026-07-19T10:00:00.000Z';
  return {
    protocol_version: 'intelligence.workflow.v1' as const,
    run_id: RUN_ID,
    account_id: '47000000-0000-4000-a000-000000000001',
    project_id: PROJECT_ID,
    actor_type: 'agent' as const,
    actor_id: '48000000-0000-4000-a000-000000000001',
    agent_name: 'content-planner',
    idempotency_key: request.idempotency_key,
    request_hash: `sha256:${'c'.repeat(64)}`,
    status: 'draft' as const,
    graph_version: 0,
    policy_snapshot_hash: request.policy_snapshot_hash,
    evaluation_version: request.evaluation_version,
    max_nodes: request.max_nodes,
    max_dependencies: request.max_dependencies,
    max_approved_credits: request.max_approved_credits,
    deadline_at: request.deadline_at,
    created_at: now,
    updated_at: now,
    terminal_at: null,
  };
}

function toolPayload(response: {
  result: { content?: Array<{ text: string }> };
}): Record<string, unknown> {
  const text = response.result.content?.[0]?.text;
  if (!text) throw new Error('missing MCP tool payload');
  return JSON.parse(text) as Record<string, unknown>;
}
