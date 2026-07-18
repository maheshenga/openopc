import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  IntelligenceAgentCardResponse,
  IntelligenceCapabilitiesResponse,
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCreateTaskRequest,
} from '@kortix/api-contract';
import {
  IntelligenceClientError,
  createIntelligenceTask,
  discoverIntelligenceCapabilities,
  discoverIntelligenceCapabilitiesWithStatus,
  getIntelligenceAgentCard,
  intelligenceProjectContext,
  listIntelligenceCapabilities,
} from './intelligence.ts';

const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const OVERRIDE_PROJECT_ID = '12000000-0000-4000-a000-000000000002';
const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const TASK_ID = '15000000-0000-4000-a000-000000000001';
const JOB_ID = '16000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);

const capabilities: IntelligenceCapabilitiesResponse = {
  protocol_version: 'intelligence.v1',
  items: [
    {
      id: 'studio.image.generate',
      version: '1.0.0',
      modality: 'image',
      operation: 'generate',
      input_schema: { type: 'object', name: 'StudioImageGenerateInput' },
      output_schema: { type: 'array', asset_kinds: ['image'] },
      execution: 'async',
      risk: 'write',
      provenance_required: true,
    },
  ],
  next_cursor: null,
};

const discovery: IntelligenceCapabilityDiscoveryResponse = {
  ...capabilities,
  execution_targets: [
    {
      capability_id: 'studio.image.generate',
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
    },
  ],
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

function taskRequest(): IntelligenceCreateTaskRequest {
  return {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: CARD_HASH,
    provider_config_id: PROVIDER_CONFIG_ID,
    model: 'fake/image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'A governed MCP image',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    idempotency_key: 'cli-intelligence-task-0001',
    parent_task_id: null,
    deadline_at: null,
  };
}

const ENV_KEYS = [
  'KORTIX_CLI_TOKEN',
  'KORTIX_EXECUTOR_TOKEN',
  'KORTIX_API_URL',
  'KORTIX_PROJECT_ID',
  'KORTIX_CONFIG_FILE',
  'KORTIX_DISABLE_SANDBOX_ENV_FILE',
] as const;

const originalFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined>;
let requests: Array<{ url: string; method: string; headers: Headers; body: unknown }>;
let responseFor: (url: string, init: RequestInit) => Response;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.KORTIX_CLI_TOKEN = 'kortix_pat_intelligence';
  process.env.KORTIX_API_URL = 'https://api.example.test/v1';
  process.env.KORTIX_PROJECT_ID = PROJECT_ID;
  process.env.KORTIX_CONFIG_FILE = '/nonexistent/kortix-intelligence-test.json';
  process.env.KORTIX_DISABLE_SANDBOX_ENV_FILE = '1';
  requests = [];
  responseFor = (url) => {
    if (url.endsWith('/intelligence/capabilities?include=execution_targets')) {
      return jsonResponse(discovery);
    }
    if (url.endsWith('/intelligence/capabilities')) return jsonResponse(capabilities);
    if (url.endsWith('/intelligence/agent-card')) return jsonResponse(agentCard);
    if (url.endsWith('/intelligence/tasks')) {
      return jsonResponse({
        protocol_version: 'intelligence.v1',
        task_id: TASK_ID,
        job_id: JOB_ID,
        created: true,
      });
    }
    return jsonResponse({ error: 'Not found' }, 404);
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : null,
    });
    return responseFor(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('Intelligence project client', () => {
  test('reuses Executor auth and project resolution for capability discovery', async () => {
    expect(intelligenceProjectContext(OVERRIDE_PROJECT_ID).projectId).toBe(OVERRIDE_PROJECT_ID);

    expect(await listIntelligenceCapabilities()).toEqual(capabilities);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `https://api.example.test/v1/projects/${PROJECT_ID}/intelligence/capabilities`,
      method: 'GET',
    });
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer kortix_pat_intelligence');

    expect(await discoverIntelligenceCapabilities()).toEqual(discovery);
    expect(requests[1]?.url).toBe(
      `https://api.example.test/v1/projects/${PROJECT_ID}/intelligence/capabilities?include=execution_targets`,
    );
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer kortix_pat_intelligence');
  });

  test('loads the local Agent Card without exposing a credential surface', async () => {
    expect(await getIntelligenceAgentCard()).toEqual(agentCard);
    expect(requests[0]?.url).toBe(
      `https://api.example.test/v1/projects/${PROJECT_ID}/intelligence/agent-card`,
    );
  });

  test('degrades an older capabilities response to an empty target list', async () => {
    responseFor = (url) =>
      url.includes('/intelligence/capabilities')
        ? jsonResponse(capabilities)
        : jsonResponse({ error: 'Not found' }, 404);

    expect(await discoverIntelligenceCapabilities()).toEqual({
      ...capabilities,
      execution_targets: [],
    });
    expect(await discoverIntelligenceCapabilitiesWithStatus()).toMatchObject({
      legacy: true,
      response: { execution_targets: [] },
    });
  });

  test('validates and forwards the exact task contract, returning only the task id', async () => {
    const request = taskRequest();
    expect(await createIntelligenceTask(request)).toBe(TASK_ID);
    expect(requests[0]).toMatchObject({
      url: `https://api.example.test/v1/projects/${PROJECT_ID}/intelligence/tasks`,
      method: 'POST',
      body: request,
    });
  });

  test('rejects unknown task fields before any request is sent', async () => {
    const invalid = {
      ...taskRequest(),
      input: { ...taskRequest().input, provider_url: 'https://secret.example.test/v1' },
    };
    await expect(createIntelligenceTask(invalid)).rejects.toMatchObject({
      code: 'INTELLIGENCE_VALIDATION_ERROR',
    });
    expect(requests).toHaveLength(0);
  });

  test('redacts provider URLs from API failures while preserving a safe code', async () => {
    responseFor = () =>
      jsonResponse(
        {
          error: 'provider https://secret.example.test/v1 returned a raw body',
          code: 'INTELLIGENCE_TASK_EXECUTION_FAILED',
        },
        503,
      );

    let thrown: unknown;
    try {
      await createIntelligenceTask(taskRequest());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IntelligenceClientError);
    expect(thrown).toMatchObject({
      code: 'INTELLIGENCE_TASK_EXECUTION_FAILED',
      status: 503,
      message: 'Intelligence request failed',
    });
    expect(String(thrown)).not.toContain('secret.example.test');
    expect(JSON.stringify(thrown)).not.toContain('secret.example.test');
  });

  test('fails closed on malformed success bodies and unsafe API codes', async () => {
    responseFor = () =>
      jsonResponse({ task_id: 'not-a-uuid', provider_url: 'https://secret.test' });
    await expect(createIntelligenceTask(taskRequest())).rejects.toMatchObject({
      code: 'INTELLIGENCE_PROTOCOL_ERROR',
      status: 0,
    });

    responseFor = () =>
      jsonResponse(
        {
          error: 'https://secret.example.test/raw',
          code: 'INTELLIGENCE_SECRET_ABC123',
        },
        502,
      );
    await expect(createIntelligenceTask(taskRequest())).rejects.toMatchObject({
      code: 'INTELLIGENCE_REQUEST_FAILED',
      status: 502,
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
