import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type {
  IntelligenceAgentCardResponse,
  IntelligenceCapabilitiesResponse,
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCreateTaskRequest,
} from '@kortix/api-contract';
import type { ExecutorClient } from '@kortix/executor-sdk';
import { IntelligenceClientError } from '../executor/intelligence.ts';
import { type IntelligenceMcpDependencies, handleExecutorMcpRequest } from '../executor/mcp.ts';

const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const TASK_ID = '15000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);

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

function createDeps(
  overrides: Partial<IntelligenceMcpDependencies> = {},
): IntelligenceMcpDependencies {
  return {
    discoverCapabilities: async () => discovery,
    getAgentCard: async () => agentCard,
    createTask: async (_request: IntelligenceCreateTaskRequest) => TASK_ID,
    canCreateTask: () => true,
    ...overrides,
  };
}

const executor = {} as ExecutorClient;

describe('Executor Intelligence MCP tools', () => {
  test('adds two stable tools without changing the existing meta-tool order', async () => {
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
