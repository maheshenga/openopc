import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type {
  IntelligenceAgentCardResponse,
  IntelligenceCapabilitiesResponse,
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCreateTaskRequest,
  IntelligenceWorkflowRunResponse,
  IntelligenceWorkflowStartRequest,
  IntelligenceWorkflowStartResponse,
} from '@kortix/api-contract';
import type { ExecutorClient } from '@kortix/executor-sdk';
import { IntelligenceClientError } from '../executor/intelligence.ts';
import { type IntelligenceMcpDependencies, handleExecutorMcpRequest } from '../executor/mcp.ts';

const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const TASK_ID = '15000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const RUN_ID = '16000000-0000-4000-a000-000000000001';
const SHA256_HASH = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-07-19T10:00:00.000Z';

const capabilities: IntelligenceCapabilitiesResponse = {
  protocol_version: 'intelligence.v1' as const,
  items: [
    {
      id: 'studio.image.generate',
      version: '1.0.0',
      modality: 'image' as const,
      operation: 'generate',
      input_schema: { type: 'object', name: 'StudioImageGenerateInput' },
      output_schema: { type: 'array', asset_kinds: ['image'] },
      execution: 'async' as const,
      risk: 'write' as const,
      provenance_required: true,
    },
  ],
  next_cursor: null,
};

const executionTarget = {
  capability_id: 'studio.image.generate' as const,
  provider_config_id: PROVIDER_CONFIG_ID,
  model: 'fake/image-v1',
};

const discovery: IntelligenceCapabilityDiscoveryResponse = {
  ...capabilities,
  execution_targets: [executionTarget],
};

const agentCard: IntelligenceAgentCardResponse = {
  id: 'kortix-studio',
  version: '1.0.0',
  display_name: 'Kortix Studio',
  capabilities: ['studio.image.generate'],
  protocols: ['a2a', 'mcp'],
  auth: { kind: 'kortix-project-token' },
  trust_tier: 'project',
  limits: { concurrency: 1, max_task_seconds: 900 },
  card_hash: CARD_HASH,
};

const workflowRun = {
  protocol_version: 'intelligence.workflow.v1' as const,
  run_id: RUN_ID,
  account_id: '19000000-0000-4000-a000-000000000001',
  project_id: PROJECT_ID,
  actor_type: 'agent' as const,
  actor_id: '1a000000-0000-4000-a000-000000000001',
  agent_name: 'content-planner',
  idempotency_key: 'mcp-workflow-run-0001',
  request_hash: SHA256_HASH,
  status: 'draft' as const,
  graph_version: 0,
  policy_snapshot_hash: SHA256_HASH,
  evaluation_version: null,
  max_nodes: 16,
  max_dependencies: 32,
  max_approved_credits: 100,
  deadline_at: null,
  created_at: NOW,
  updated_at: NOW,
  terminal_at: null,
};

const workflowStartResponse: IntelligenceWorkflowStartResponse = {
  protocol_version: 'intelligence.workflow.v1',
  run: workflowRun,
  created: true,
};

const workflowRunResponse: IntelligenceWorkflowRunResponse = {
  protocol_version: 'intelligence.workflow.v1',
  run: workflowRun,
};

function createDeps(
  overrides: Partial<IntelligenceMcpDependencies> = {},
): IntelligenceMcpDependencies {
  return {
    discoverCapabilities: async () => discovery,
    getAgentCard: async () => agentCard,
    createTask: async (_request: IntelligenceCreateTaskRequest) => TASK_ID,
    startWorkflow: async (_request: IntelligenceWorkflowStartRequest) => workflowStartResponse,
    getWorkflow: async () => workflowRunResponse,
    canCreateTask: () => true,
    ...overrides,
  };
}

const executor = {} as ExecutorClient;

describe('Executor Intelligence MCP tools', () => {
  test('appends workflow meta-tools without changing the existing tool order', async () => {
    const result = (await handleExecutorMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      executor,
      createDeps(),
    )) as { tools: Array<Record<string, unknown>> };

    expect(result.tools.slice(0, 4).map((tool) => tool.name)).toEqual([
      'connectors',
      'discover',
      'describe',
      'call',
    ]);
    expect(result.tools.slice(0, 8).map((tool) => tool.name)).toEqual([
      'connectors',
      'discover',
      'describe',
      'call',
      'connect',
      'request_secret',
      'add_connector',
      'remove_connector',
    ]);
    expect(result.tools.find((tool) => tool.name === 'studio_capabilities')).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: { additionalProperties: false },
    });
    const createTool = result.tools.find((tool) => tool.name === 'studio_create_task');
    expect(createTool).toMatchObject({
      annotations: { readOnlyHint: false },
      inputSchema: { additionalProperties: false },
    });
    const createSchema = createTool?.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(createSchema.properties)).toEqual([
      'capability_id',
      'agent_card_hash',
      'provider_config_id',
      'model',
      'input',
      'idempotency_key',
      'parent_task_id',
      'deadline_at',
    ]);
    expect(createSchema.required).not.toContain('protocol_version');
    expect(Object.keys(createSchema.properties)).not.toContain('provider_url');
    expect(Object.keys(createSchema.properties)).not.toContain('credential');
    expect(Object.keys(createSchema.properties)).not.toContain('secret');
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'connectors',
      'discover',
      'describe',
      'call',
      'connect',
      'request_secret',
      'add_connector',
      'remove_connector',
      'studio_capabilities',
      'studio_create_task',
      'workflow_capabilities',
      'workflow_start',
      'workflow_status',
    ]);
    const workflowStart = result.tools.find((tool) => tool.name === 'workflow_start');
    expect(workflowStart).toMatchObject({
      annotations: { readOnlyHint: false },
      inputSchema: { additionalProperties: false },
    });
    expect(Object.keys((workflowStart?.inputSchema as { properties: object }).properties)).not.toContain(
      'protocol_version',
    );
    expect(JSON.stringify(workflowStart)).not.toMatch(/provider_url|credential|secret/i);
  });

  test('negotiates only supported MCP revisions and falls back to the latest revision', async () => {
    const initialize = async (protocolVersion?: string) =>
      (await handleExecutorMcpRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: protocolVersion === undefined ? {} : { protocolVersion },
        },
        executor,
        createDeps(),
      )) as { protocolVersion: string };

    expect((await initialize('2025-11-25')).protocolVersion).toBe('2025-11-25');
    expect((await initialize('2025-06-18')).protocolVersion).toBe('2025-06-18');
    expect((await initialize('2099-01-01')).protocolVersion).toBe('2025-11-25');
    expect((await initialize()).protocolVersion).toBe('2025-11-25');
  });

  test('exposes strict redacted workflow capability, start, and status tools', async () => {
    let startCalls = 0;
    const deps = createDeps({
      getProjectId: () => PROJECT_ID,
      startWorkflow: async (request, projectOverride) => {
        startCalls += 1;
        expect(projectOverride).toBe(PROJECT_ID);
        expect(request.protocol_version).toBe('intelligence.workflow.v1');
        return workflowStartResponse;
      },
      getWorkflow: async (runId, projectOverride) => {
        expect(runId).toBe(RUN_ID);
        expect(projectOverride).toBe(PROJECT_ID);
        return workflowRunResponse;
      },
    });

    const capabilityResult = await callTool('workflow_capabilities', {}, deps);
    expect(capabilityResult.isError).toBe(false);
    expect(JSON.parse(capabilityResult.content[0]?.text ?? '{}')).toEqual({
      protocol_version: 'intelligence.workflow.v1',
      capabilities: [{ capability_id: 'studio.image.generate', capability_version: '1.0.0' }],
      limits: { max_nodes: 128, max_dependencies: 256, max_depth: 16, max_fan_out: 16 },
    });

    const args = workflowStartArgs();
    const started = await callTool('workflow_start', args, deps);
    expect(started.isError).toBe(false);
    expect(JSON.parse(started.content[0]?.text ?? '{}')).toEqual({
      ok: true,
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      status: 'draft',
      created: true,
    });

    const invalid = await callTool(
      'workflow_start',
      { ...args, provider_url: 'https://forbidden.example.test' },
      deps,
    );
    expect(invalid.isError).toBe(true);
    expect(startCalls).toBe(1);

    const status = await callTool('workflow_status', { run_id: RUN_ID }, deps);
    expect(status.isError).toBe(false);
    const statusPayload = JSON.parse(status.content[0]?.text ?? '{}');
    expect(statusPayload).toEqual({
      ok: true,
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      status: 'draft',
      graph_version: 0,
      updated_at: NOW,
      terminal_at: null,
    });
    expect(JSON.stringify(statusPayload)).not.toMatch(/prompt|payload_ref|provider|credential/i);
  });

  test('revalidates injected workflow responses before writing MCP stdout', async () => {
    const malformed = {
      ...workflowStartResponse,
      provider_url: 'https://forbidden.example.test',
    } as unknown as IntelligenceWorkflowStartResponse;
    const result = await callTool(
      'workflow_start',
      workflowStartArgs(),
      createDeps({
        getProjectId: () => PROJECT_ID,
        startWorkflow: async () => malformed,
      }),
    );

    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('forbidden.example.test');
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: 'INTELLIGENCE_PROTOCOL_ERROR' });
  });

  test('rejects an injected workflow response from another project scope', async () => {
    const result = await callTool(
      'workflow_status',
      { run_id: RUN_ID },
      createDeps({
        getProjectId: () => PROJECT_ID,
        getWorkflow: async () => ({
          ...workflowRunResponse,
          run: {
            ...workflowRunResponse.run,
            project_id: '12000000-0000-4000-a000-000000000099',
          },
        }),
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_PROTOCOL_ERROR',
    });
  });

  test('keeps the advertised model schema aligned with request validation', async () => {
    const listed = (await handleExecutorMcpRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      executor,
      createDeps(),
    )) as { tools: Array<Record<string, unknown>> };
    const createTool = listed.tools.find((tool) => tool.name === 'studio_create_task');
    const createSchema = createTool?.inputSchema as {
      properties: { model: { pattern: string } };
    };
    const modelPattern = new RegExp(createSchema.properties.model.pattern);

    for (const model of ['data:text/plain,hello', 'mailto:user@example.test', '//host/path']) {
      expect(modelPattern.test(model)).toBe(false);
      const result = await callTool(
        'studio_create_task',
        { ...validToolArgs(), model },
        createDeps(),
      );
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
        code: 'INTELLIGENCE_VALIDATION_ERROR',
      });
    }

    expect(modelPattern.test('fake/image-v1')).toBe(true);
    const valid = await callTool('studio_create_task', validToolArgs(), createDeps());
    expect(valid.isError).toBe(false);
  });

  test('returns capability descriptors with the public local Agent Card hash', async () => {
    const result = await callTool('studio_capabilities', {}, createDeps());
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.content[0]?.text ?? '{}');
    expect(payload).toMatchObject({
      protocol_version: 'intelligence.v1',
      items: [{ id: 'studio.image.generate' }],
      execution_targets: [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      agent_card: { card_hash: CARD_HASH },
    });
    expect(JSON.stringify(payload)).not.toContain('credential');
  });

  test('returns empty discovery without requesting an unavailable Agent Card', async () => {
    let cardCalls = 0;
    const result = await callTool(
      'studio_capabilities',
      {},
      createDeps({
        discoverCapabilities: async () => ({
          protocol_version: 'intelligence.v1',
          items: [],
          next_cursor: null,
          execution_targets: [],
        }),
        getAgentCard: async () => {
          cardCalls += 1;
          throw new Error('card unavailable');
        },
      }),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
      execution_targets: [],
      agent_card: null,
    });
    expect(cardCalls).toBe(0);
  });

  test('rejects capability discovery arguments before calling dependencies', async () => {
    let capabilityCalls = 0;
    const result = await callTool(
      'studio_capabilities',
      { provider_url: 'https://secret.example.test/v1' },
      createDeps({
        discoverCapabilities: async () => {
          capabilityCalls += 1;
          return discovery;
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_VALIDATION_ERROR',
    });
    expect(result.content[0]?.text).not.toContain('secret.example.test');
    expect(capabilityCalls).toBe(0);
  });

  test('adds the protocol version and forwards only a strict task request', async () => {
    const calls: IntelligenceCreateTaskRequest[] = [];
    const deps = createDeps({
      createTask: async (request: IntelligenceCreateTaskRequest) => {
        calls.push(request);
        return TASK_ID;
      },
    });
    const result = await callTool('studio_create_task', validToolArgs(), deps);

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toEqual({ ok: true, task_id: TASK_ID });
    expect(calls).toEqual([
      {
        protocol_version: 'intelligence.v1',
        ...validToolArgs(),
      },
    ]);
  });

  test('fails closed when the MCP session has no current discovery view', async () => {
    let createCalls = 0;
    const result = await callTool(
      'studio_create_task',
      validToolArgs(),
      createDeps({
        canCreateTask: () => false,
        createTask: async () => {
          createCalls += 1;
          return TASK_ID;
        },
      }),
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(createCalls).toBe(0);
  });

  test('fails closed for legacy dependency injection without an explicit write gate', async () => {
    let createCalls = 0;
    const legacyDeps: IntelligenceMcpDependencies = {
      discoverCapabilities: async () => discovery,
      getAgentCard: async () => agentCard,
      createTask: async () => {
        createCalls += 1;
        return TASK_ID;
      },
    };
    const result = await callTool('studio_create_task', validToolArgs(), legacyDeps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(createCalls).toBe(0);
  });

  test('keeps legacy discovery read-only for task creation', async () => {
    let createCalls = 0;
    const deps = createDeps({
      discoverCapabilitiesWithStatus: async () => ({
        response: { ...capabilities, execution_targets: [] },
        legacy: true,
      }),
      createTask: async () => {
        createCalls += 1;
        return TASK_ID;
      },
    });

    const discovered = await callTool('studio_capabilities', {}, deps);
    expect(discovered.isError).toBe(false);

    const result = await callTool('studio_create_task', validToolArgs(), deps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(createCalls).toBe(0);
  });

  test('fails closed when a status-aware discovery dependency returns a malformed view', async () => {
    let createCalls = 0;
    const deps = createDeps({
      discoverCapabilitiesWithStatus: async () => ({
        response: capabilities as unknown as IntelligenceCapabilityDiscoveryResponse,
        legacy: false,
      }),
      createTask: async () => {
        createCalls += 1;
        return TASK_ID;
      },
    });

    const discoveryResult = await callTool('studio_capabilities', {}, deps);
    expect(discoveryResult.isError).toBe(true);
    expect(JSON.parse(discoveryResult.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_PROTOCOL_ERROR',
    });
    const taskResult = await callTool('studio_create_task', validToolArgs(), deps);
    expect(taskResult.isError).toBe(true);
    expect(JSON.parse(taskResult.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(createCalls).toBe(0);
  });

  test('does not emit a malformed or sensitive Agent Card from an injected dependency', async () => {
    const deps = createDeps({
      getAgentCard: async () =>
        ({
          ...agentCard,
          provider_url: 'https://secret.example.test/v1',
        }) as IntelligenceAgentCardResponse,
    });
    const result = await callTool('studio_capabilities', {}, deps);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('secret.example.test');
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_PROTOCOL_ERROR',
    });
  });

  test('fails closed when the project resolver throws during discovery', async () => {
    let createCalls = 0;
    const deps = createDeps({
      getProjectId: () => {
        throw new Error('project resolver unavailable');
      },
      discoverCapabilitiesWithStatus: async () => ({ response: discovery, legacy: false }),
      createTask: async () => {
        createCalls += 1;
        return TASK_ID;
      },
    });

    const discoveryResult = await callTool('studio_capabilities', {}, deps);
    expect(discoveryResult.isError).toBe(true);
    expect(JSON.parse(discoveryResult.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    const taskResult = await callTool('studio_create_task', validToolArgs(), deps);
    expect(taskResult.isError).toBe(true);
    expect(JSON.parse(taskResult.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(createCalls).toBe(0);
  });

  test('invalidates an enhanced discovery view when the project changes', async () => {
    let projectId = 'project-a';
    let createCalls = 0;
    const deps = createDeps({
      getProjectId: () => projectId,
      discoverCapabilitiesWithStatus: async () => ({ response: discovery, legacy: false }),
      createTask: async () => {
        createCalls += 1;
        return TASK_ID;
      },
    });

    const discovered = await callTool('studio_capabilities', {}, deps);
    expect(discovered.isError).toBe(false);
    projectId = 'project-b';

    const result = await callTool('studio_create_task', validToolArgs(), deps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(createCalls).toBe(0);
  });

  test('forwards the discovered project snapshot to task creation', async () => {
    const forwardedProjectIds: Array<string | undefined> = [];
    const deps = createDeps({
      getProjectId: () => 'project-a',
      discoverCapabilitiesWithStatus: async () => ({ response: discovery, legacy: false }),
      createTask: async (_request, projectOverride) => {
        forwardedProjectIds.push(projectOverride);
        return TASK_ID;
      },
    });

    expect((await callTool('studio_capabilities', {}, deps)).isError).toBe(false);
    expect((await callTool('studio_create_task', validToolArgs(), deps)).isError).toBe(false);
    expect(forwardedProjectIds).toEqual(['project-a']);
  });

  test('does not combine discovery and Agent Card data across a project switch', async () => {
    let projectId = 'project-a';
    const discoveryProjectIds: Array<string | undefined> = [];
    const cardProjectIds: Array<string | undefined> = [];
    const deps = createDeps({
      getProjectId: () => projectId,
      discoverCapabilitiesWithStatus: async (projectOverride) => {
        discoveryProjectIds.push(projectOverride);
        projectId = 'project-b';
        return { response: discovery, legacy: false };
      },
      getAgentCard: async (projectOverride) => {
        cardProjectIds.push(projectOverride);
        return agentCard;
      },
    });

    const result = await callTool('studio_capabilities', {}, deps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
    expect(discoveryProjectIds).toEqual(['project-a']);
    expect(cardProjectIds).toEqual(['project-a']);
  });

  test('clears the discovery gate when a new MCP session initializes', async () => {
    const deps = createDeps({
      discoverCapabilitiesWithStatus: async () => ({ response: discovery, legacy: false }),
    });
    expect((await callTool('studio_capabilities', {}, deps)).isError).toBe(false);
    expect(
      (
        (await handleExecutorMcpRequest(
          { jsonrpc: '2.0', id: 2, method: 'initialize' },
          executor,
          deps,
        )) as { serverInfo: { name: string } }
      ).serverInfo.name,
    ).toBe('kortix-executor');

    const result = await callTool('studio_create_task', validToolArgs(), deps);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_DISCOVERY_UNAVAILABLE',
    });
  });

  test('maps malformed arguments and provider errors to redacted structured results', async () => {
    let createCalls = 0;
    const invalid = await callTool(
      'studio_create_task',
      { ...validToolArgs(), provider_url: 'https://secret.example.test/v1' },
      createDeps({
        createTask: async () => {
          createCalls += 1;
          return TASK_ID;
        },
      }),
    );
    expect(invalid.isError).toBe(true);
    expect(JSON.parse(invalid.content[0]?.text ?? '{}')).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_VALIDATION_ERROR',
    });
    expect(createCalls).toBe(0);

    const failed = await callTool(
      'studio_create_task',
      validToolArgs(),
      createDeps({
        createTask: async () => {
          throw new Error('provider https://secret.example.test/v1 failed');
        },
      }),
    );
    expect(failed.isError).toBe(true);
    const text = failed.content[0]?.text ?? '';
    expect(text).not.toContain('secret.example.test');
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_REQUEST_FAILED',
    });
  });

  test('revalidates client error codes at the final stdout boundary', async () => {
    const failed = await callTool(
      'studio_create_task',
      validToolArgs(),
      createDeps({
        createTask: async () => {
          throw new IntelligenceClientError('INTELLIGENCE_SECRET_HTTPS://SECRET.EXAMPLE.TEST', 503);
        },
      }),
    );

    expect(failed.isError).toBe(true);
    const text = failed.content[0]?.text ?? '';
    expect(text).not.toContain('SECRET.EXAMPLE.TEST');
    expect(JSON.parse(text)).toMatchObject({
      ok: false,
      code: 'INTELLIGENCE_REQUEST_FAILED',
    });
  });

  test('runs the real stdio server with default auth, HTTP, and JSON-RPC wiring', async () => {
    const httpCalls: Array<{
      path: string;
      method: string;
      authorization: string | null;
      body: unknown;
    }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        const body = request.method === 'POST' ? await request.json() : null;
        httpCalls.push({
          path: `${url.pathname}${url.search}`,
          method: request.method,
          authorization: request.headers.get('Authorization'),
          body,
        });
        if (
          url.pathname.endsWith('/intelligence/capabilities') &&
          url.searchParams.get('include') === 'execution_targets'
        ) {
          return jsonResponse(discovery);
        }
        if (url.pathname.endsWith('/intelligence/agent-card')) {
          return jsonResponse(agentCard);
        }
        if (url.pathname.endsWith('/intelligence/tasks')) {
          return jsonResponse({
            protocol_version: 'intelligence.v1',
            task_id: TASK_ID,
            job_id: '16000000-0000-4000-a000-000000000001',
            created: true,
          });
        }
        return jsonResponse({ error: 'Not found' }, 404);
      },
    });

    try {
      const env: Record<string, string | undefined> = {
        ...process.env,
        KORTIX_CLI_TOKEN: 'kortix_pat_blackbox',
        KORTIX_API_URL: `http://127.0.0.1:${server.port}/v1`,
        KORTIX_PROJECT_ID: '12000000-0000-4000-a000-000000000001',
        KORTIX_CONFIG_FILE: '/nonexistent/kortix-intelligence-blackbox.json',
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
      type JsonRpcTestResponse = {
        id: number;
        result: {
          protocolVersion?: string;
          serverInfo?: Record<string, unknown>;
          tools?: Array<{ name: string }>;
          content?: Array<{ text: string }>;
        };
      };
      const readResponse = async () => {
        for (;;) {
          const newline = stdoutBuffer.indexOf('\n');
          if (newline >= 0) {
            const line = stdoutBuffer.slice(0, newline).trim();
            stdoutBuffer = stdoutBuffer.slice(newline + 1);
            if (line) return JSON.parse(line) as JsonRpcTestResponse;
            continue;
          }
          const next = await reader.read();
          if (next.done) throw new Error('MCP server closed stdout before a response');
          stdoutBuffer += decoder.decode(next.value, { stream: true });
        }
      };
      const send = (request: Record<string, unknown>) => {
        child.stdin.write(`${JSON.stringify(request)}\n`);
      };

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      });
      const initializeResponse = await readResponse();
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const toolsResponse = await readResponse();
      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'studio_capabilities', arguments: {} },
      });
      const capabilitiesResponse = await readResponse();
      const capabilityText = capabilitiesResponse.result.content?.[0]?.text;
      if (!capabilityText) throw new Error('missing capability discovery response');
      const discovered = JSON.parse(capabilityText) as {
        execution_targets: typeof discovery.execution_targets;
        agent_card: { card_hash: string };
      };
      expect(discovered.agent_card.card_hash).toBe(CARD_HASH);
      expect(discovered.execution_targets).toEqual([executionTarget]);
      const selectedTarget = discovered.execution_targets[0];
      send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'studio_create_task', arguments: validToolArgs(selectedTarget) },
      });
      const taskResponse = await readResponse();
      child.stdin.end();

      const [exitCode, stderr] = await Promise.all([child.exited, stderrPromise]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(initializeResponse).toMatchObject({
        id: 1,
        result: { protocolVersion: '2025-11-25', serverInfo: { name: 'kortix-executor' } },
      });
      const listedTools = toolsResponse.result.tools;
      if (!listedTools) throw new Error('missing MCP tools/list response');
      expect(listedTools.map((tool) => tool.name)).toContain('studio_create_task');
      const taskText = taskResponse.result.content?.[0]?.text;
      if (!taskText) throw new Error('missing MCP task response');
      expect(JSON.parse(taskText)).toEqual({
        ok: true,
        task_id: TASK_ID,
      });

      expect(httpCalls).toHaveLength(3);
      expect(
        httpCalls
          .slice(0, 2)
          .map((call) => call.path)
          .sort(),
      ).toEqual([
        '/v1/projects/12000000-0000-4000-a000-000000000001/intelligence/agent-card',
        '/v1/projects/12000000-0000-4000-a000-000000000001/intelligence/capabilities?include=execution_targets',
      ]);
      expect(httpCalls[2]).toMatchObject({
        path: '/v1/projects/12000000-0000-4000-a000-000000000001/intelligence/tasks',
        method: 'POST',
        authorization: 'Bearer kortix_pat_blackbox',
        body: { protocol_version: 'intelligence.v1', ...validToolArgs(selectedTarget) },
      });
      expect(httpCalls.every((call) => call.authorization === 'Bearer kortix_pat_blackbox')).toBe(
        true,
      );
    } finally {
      server.stop(true);
    }
  }, 20_000);
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
  deps: ReturnType<typeof createDeps>,
) {
  return (await handleExecutorMcpRequest(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    executor,
    deps,
  )) as { content: Array<{ type: string; text: string }>; isError: boolean };
}

function workflowStartArgs(): Omit<IntelligenceWorkflowStartRequest, 'protocol_version'> {
  return {
    idempotency_key: 'mcp-workflow-run-0001',
    goal: 'Create a governed image workflow',
    context_asset_ids: [],
    policy_snapshot_hash: SHA256_HASH,
    evaluation_version: null,
    max_nodes: 16,
    max_dependencies: 32,
    max_approved_credits: 100,
    deadline_at: null,
  };
}

function validToolArgs(target = executionTarget) {
  return {
    capability_id: target.capability_id,
    agent_card_hash: CARD_HASH,
    provider_config_id: target.provider_config_id,
    model: target.model,
    input: {
      capability: 'image.generate' as const,
      image: {
        prompt: 'A governed MCP image',
        reference_asset_ids: [],
        aspect_ratio: '1:1' as const,
        quality: 'standard' as const,
        output_count: 1,
      },
    },
    idempotency_key: 'mcp-intelligence-task-0001',
    parent_task_id: null,
    deadline_at: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
