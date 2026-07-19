import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  type IntelligenceCreateTaskRequest,
  type IntelligenceWorkflowApprovalDecisionRequest,
  type IntelligenceWorkflowCancelRequest,
  type IntelligenceWorkflowStartRequest,
  cancelIntelligenceWorkflow,
  createIntelligenceTask,
  decideIntelligenceWorkflowApproval,
  discoverIntelligenceCapabilities,
  getIntelligenceAgentCard,
  getIntelligenceTaskEvents,
  getIntelligenceWorkflow,
  getIntelligenceWorkflowEvents,
  listIntelligenceCapabilities,
  startIntelligenceWorkflow,
} from './intelligence';

const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const TASK_ID = '13000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);
const RUN_ID = '16000000-0000-4000-a000-000000000001';
const NODE_ID = '17000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '18000000-0000-4000-a000-000000000001';
const SHA256_HASH = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-07-19T10:00:00.000Z';

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

const card = {
  id: 'content-planner',
  version: '1.0.0',
  display_name: 'Content Planner',
  capabilities: ['studio.image.generate'],
  protocols: ['mcp', 'a2a'] as ('mcp' | 'a2a')[],
  auth: { kind: 'kortix-project-token' as const },
  trust_tier: 'project' as const,
  limits: { concurrency: 1, max_task_seconds: 900 },
  card_hash: CARD_HASH,
};

const taskRequest: IntelligenceCreateTaskRequest = {
  protocol_version: 'intelligence.v1',
  capability_id: 'studio.image.generate',
  agent_card_hash: CARD_HASH,
  provider_config_id: PROVIDER_CONFIG_ID,
  model: 'fake/image-v1',
  input: {
    capability: 'image.generate',
    image: {
      prompt: 'a private prompt',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    },
  },
  idempotency_key: 'sdk-intelligence-task-key',
  parent_task_id: null,
  deadline_at: null,
};

const workflowRun = {
  protocol_version: 'intelligence.workflow.v1' as const,
  run_id: RUN_ID,
  account_id: '19000000-0000-4000-a000-000000000001',
  project_id: PROJECT_ID,
  actor_type: 'user' as const,
  actor_id: '1a000000-0000-4000-a000-000000000001',
  agent_name: null,
  idempotency_key: 'sdk-workflow-run-0001',
  request_hash: SHA256_HASH,
  status: 'waiting_approval' as const,
  graph_version: 1,
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

const workflowNode = {
  protocol_version: 'intelligence.workflow.v1' as const,
  node_id: NODE_ID,
  run_id: RUN_ID,
  node_key: 'render-primary',
  role: 'executor' as const,
  kind: 'capability' as const,
  agent_name: null,
  agent_card_hash: null,
  capability_id: 'studio.image.generate' as const,
  capability_version: '1.0.0' as const,
  input_hash: SHA256_HASH,
  policy_snapshot_hash: SHA256_HASH,
  evaluation_version: null,
  task_id: null,
  status: 'running' as const,
  attempt_count: 1,
  deadline_at: null,
  created_at: NOW,
  updated_at: NOW,
  terminal_at: null,
};

const workflowApproval = {
  protocol_version: 'intelligence.workflow.v1' as const,
  approval_id: APPROVAL_ID,
  run_id: RUN_ID,
  node_id: NODE_ID,
  risk: 'high' as const,
  reason_code: 'WORKFLOW_POLICY_APPROVAL_REQUIRED',
  action_summary: 'Approve image generation',
  status: 'approved' as const,
  review_item_id: null,
  acting_user_id: '1a000000-0000-4000-a000-000000000001',
  decision: 'approve' as const,
  feedback_hash: null,
  requested_at: NOW,
  resolved_at: NOW,
};

let requests: Array<{ url: string; method: string; body?: unknown }> = [];
let observedErrors: unknown[] = [];
let nextBody: unknown = {};
let nextStatus = 200;

beforeEach(() => {
  requests = [];
  observedErrors = [];
  nextBody = {};
  nextStatus = 200;
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    requests.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body,
    });
    return new Response(JSON.stringify(nextBody), {
      status: nextStatus,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local/v1',
  getToken: async () => 'tok',
  onError: (error) => observedErrors.push(error),
});

test('lists project intelligence capabilities through the typed endpoint', async () => {
  nextBody = { protocol_version: 'intelligence.v1', items: [capability], next_cursor: null };

  const result = await listIntelligenceCapabilities(PROJECT_ID);

  expect(result.items).toEqual([capability]);
  expect(requests).toEqual([
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/capabilities`,
      method: 'GET',
      body: undefined,
    },
  ]);
});

test('discovers project execution targets only through the explicit opt-in view', async () => {
  nextBody = {
    protocol_version: 'intelligence.v1',
    items: [capability],
    execution_targets: [
      {
        capability_id: 'studio.image.generate',
        provider_config_id: PROVIDER_CONFIG_ID,
        model: 'fake/image-v1',
      },
    ],
    next_cursor: null,
  };

  const result = await discoverIntelligenceCapabilities(PROJECT_ID);

  expect(result.execution_targets[0]?.provider_config_id).toBe(PROVIDER_CONFIG_ID);
  expect(requests[0]?.url).toBe(
    `http://test.local/v1/projects/${PROJECT_ID}/intelligence/capabilities?include=execution_targets`,
  );
});

test('gets an Agent Card without adding credential-bearing fields', async () => {
  nextBody = card;

  const result = await getIntelligenceAgentCard(PROJECT_ID);

  expect(result).toEqual(card);
  expect(requests[0]?.url).toBe(
    `http://test.local/v1/projects/${PROJECT_ID}/intelligence/agent-card`,
  );
  expect(JSON.stringify(result)).not.toMatch(/signed_url|provider_url|api_key|secret/i);
});

test('creates a project intelligence task and forwards the strict request body', async () => {
  nextBody = {
    protocol_version: 'intelligence.v1',
    task_id: TASK_ID,
    job_id: '15000000-0000-4000-a000-000000000001',
    created: true,
  };

  const result = await createIntelligenceTask(PROJECT_ID, taskRequest);

  expect(result.task_id).toBe(TASK_ID);
  expect(requests[0]).toEqual({
    url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/tasks`,
    method: 'POST',
    body: taskRequest,
  });
});

test('forwards an event cursor only when supplied', async () => {
  nextBody = {
    protocol_version: 'intelligence.v1',
    task_id: TASK_ID,
    items: [],
    next_cursor: 'next-2',
  };

  await getIntelligenceTaskEvents(PROJECT_ID, TASK_ID, 'cursor-1');
  await getIntelligenceTaskEvents(PROJECT_ID, TASK_ID);

  expect(requests[0]?.url).toBe(
    `http://test.local/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events?cursor=cursor-1`,
  );
  expect(requests[1]?.url).toBe(
    `http://test.local/v1/projects/${PROJECT_ID}/intelligence/tasks/${TASK_ID}/events`,
  );
});

test('binds project workflow start, read, cancel, events, and approval endpoints', async () => {
  const startRequest: IntelligenceWorkflowStartRequest = {
    protocol_version: 'intelligence.workflow.v1',
    idempotency_key: 'sdk-workflow-run-0001',
    goal: 'Create a governed image workflow',
    context_asset_ids: [],
    policy_snapshot_hash: SHA256_HASH,
    evaluation_version: null,
    max_nodes: 16,
    max_dependencies: 32,
    max_approved_credits: 100,
    deadline_at: null,
  };
  nextBody = {
    protocol_version: 'intelligence.workflow.v1',
    run: workflowRun,
    created: true,
  };
  await startIntelligenceWorkflow(PROJECT_ID, startRequest);

  nextBody = { protocol_version: 'intelligence.workflow.v1', run: workflowRun };
  await getIntelligenceWorkflow(PROJECT_ID, RUN_ID);

  const cancelRequest: IntelligenceWorkflowCancelRequest = {
    protocol_version: 'intelligence.workflow.v1',
    reason_code: 'WORKFLOW_CANCELLED_BY_USER',
  };
  await cancelIntelligenceWorkflow(PROJECT_ID, RUN_ID, cancelRequest);

  nextBody = {
    protocol_version: 'intelligence.workflow.v1',
    run_id: RUN_ID,
    items: [],
    next_cursor: 'opaque cursor/2',
  };
  await getIntelligenceWorkflowEvents(PROJECT_ID, RUN_ID, 'opaque cursor/1', 25);

  const decision: IntelligenceWorkflowApprovalDecisionRequest = {
    protocol_version: 'intelligence.workflow.v1',
    decision: 'approve',
    feedback_hash: null,
  };
  nextBody = {
    protocol_version: 'intelligence.workflow.v1',
    run: workflowRun,
    node: workflowNode,
    approval: workflowApproval,
  };
  const approved = await decideIntelligenceWorkflowApproval(
    PROJECT_ID,
    RUN_ID,
    APPROVAL_ID,
    decision,
  );

  expect(approved.approval.approval_id).toBe(APPROVAL_ID);
  expect(requests).toEqual([
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/workflows`,
      method: 'POST',
      body: startRequest,
    },
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}`,
      method: 'GET',
      body: undefined,
    },
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/cancel`,
      method: 'POST',
      body: cancelRequest,
    },
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/events?cursor=opaque%20cursor%2F1&limit=25`,
      method: 'GET',
      body: undefined,
    },
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/approvals/${APPROVAL_ID}/decision`,
      method: 'POST',
      body: decision,
    },
  ]);
  expect(JSON.stringify(approved)).not.toMatch(/payload_ref|prompt|provider|credential/i);
});

test('rejects a structurally valid workflow response from another project scope', async () => {
  nextBody = {
    protocol_version: 'intelligence.workflow.v1',
    run: {
      ...workflowRun,
      project_id: '12000000-0000-4000-a000-000000000099',
    },
  };

  let thrown: unknown;
  try {
    await getIntelligenceWorkflow(PROJECT_ID, RUN_ID);
  } catch (error) {
    thrown = error;
  }

  expect((thrown as { code?: string } | undefined)?.code).toBe('INTELLIGENCE_PROTOCOL_ERROR');
});

test('redacts signed URLs and raw response bodies from intelligence errors', async () => {
  nextStatus = 503;
  nextBody = {
    code: 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE',
    detail: 'signed=https://private.example.test/object?token=secret',
  };

  let thrown: unknown;
  try {
    await getIntelligenceTaskEvents(PROJECT_ID, TASK_ID);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).not.toContain('private.example.test');
  expect(String(thrown)).not.toContain('token=secret');
  expect(JSON.stringify(thrown)).not.toContain('private.example.test');
  expect((thrown as { code?: string }).code).toBe('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE');
  expect((thrown as { status?: number }).status).toBe(503);
  expect(observedErrors).toEqual([]);

  nextBody = {
    code: 'INTELLIGENCE_SECRET_ABC123',
    detail: 'provider rejected the request',
  };
  thrown = undefined;
  try {
    await getIntelligenceTaskEvents(PROJECT_ID, TASK_ID);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as { code?: string }).code).toBe('INTELLIGENCE_REQUEST_FAILED');
});

test('redacts synchronous request serialization errors before they escape the client boundary', async () => {
  const leaked = 'signed=https://private.example.test/object?token=serialization-secret';
  const advanced = {
    toJSON() {
      throw new Error(leaked);
    },
  };
  const input = {
    ...taskRequest,
    input: {
      ...taskRequest.input,
      image: { ...taskRequest.input.image, advanced },
    },
  } as IntelligenceCreateTaskRequest;

  let thrown: unknown;
  try {
    await createIntelligenceTask(PROJECT_ID, input);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).not.toContain('private.example.test');
  expect(String(thrown)).not.toContain('serialization-secret');
  expect((thrown as { code?: string }).code).toBe('INTELLIGENCE_REQUEST_FAILED');
  expect(observedErrors).toEqual([]);
});

test('rejects credential-bearing fields in otherwise successful intelligence responses', async () => {
  nextBody = {
    protocol_version: 'intelligence.v1',
    items: [capability],
    next_cursor: null,
    provider_url: 'https://private.example.test/provider?token=response-secret',
  };

  let thrown: unknown;
  try {
    await listIntelligenceCapabilities(PROJECT_ID);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).not.toContain('private.example.test');
  expect(String(thrown)).not.toContain('response-secret');
  expect((thrown as { code?: string }).code).toBe('INTELLIGENCE_PROTOCOL_ERROR');
  expect(observedErrors).toEqual([]);
});

test('rejects raw provider bodies in otherwise successful intelligence responses', async () => {
  nextBody = {
    protocol_version: 'intelligence.v1',
    items: [capability],
    next_cursor: null,
    raw_provider_body: { untrusted: 'opaque provider response' },
  };

  let thrown: unknown;
  try {
    await listIntelligenceCapabilities(PROJECT_ID);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as { code?: string }).code).toBe('INTELLIGENCE_PROTOCOL_ERROR');
  expect(observedErrors).toEqual([]);
});

test('rejects nested camel-case raw provider fields in successful intelligence responses', async () => {
  const unsafeKeys = [
    'rawProviderBody',
    'rawResponseBody',
    'rawRequestPayload',
    'providerResponseBody',
    'providerRequestPayload',
  ];
  const codes: Array<string | undefined> = [];

  for (const key of unsafeKeys) {
    nextBody = {
      protocol_version: 'intelligence.v1',
      items: [
        {
          ...capability,
          input_schema: {
            type: 'object',
            [key]: { untrusted: 'opaque provider response' },
          },
        },
      ],
      next_cursor: null,
    };

    let thrown: unknown;
    try {
      await listIntelligenceCapabilities(PROJECT_ID);
    } catch (error) {
      thrown = error;
    }
    codes.push((thrown as { code?: string } | undefined)?.code);
  }

  expect(codes).toEqual(unsafeKeys.map(() => 'INTELLIGENCE_PROTOCOL_ERROR'));
  expect(observedErrors).toEqual([]);
});

test('rejects unknown fields and credential text in otherwise successful responses', async () => {
  nextBody = { ok: true };
  let malformed: unknown;
  try {
    await listIntelligenceCapabilities(PROJECT_ID);
  } catch (error) {
    malformed = error;
  }

  nextBody = {
    protocol_version: 'intelligence.v1',
    items: [
      {
        ...capability,
        input_schema: {
          type: 'object',
          debug: 'Authorization: Bearer private-credential-value',
        },
      },
    ],
    next_cursor: null,
  };
  let credentialText: unknown;
  try {
    await listIntelligenceCapabilities(PROJECT_ID);
  } catch (error) {
    credentialText = error;
  }

  expect((malformed as { code?: string } | undefined)?.code).toBe('INTELLIGENCE_PROTOCOL_ERROR');
  expect((credentialText as { code?: string } | undefined)?.code).toBe(
    'INTELLIGENCE_PROTOCOL_ERROR',
  );
  expect(String(credentialText)).not.toContain('private-credential-value');
  expect(observedErrors).toEqual([]);
});

test('redacts cursor coercion errors before they escape the intelligence boundary', async () => {
  const leaked = 'signed=https://private.example.test/object?token=cursor-secret';
  const cursor = {
    toString() {
      throw new Error(leaked);
    },
  } as unknown as string;

  let thrown: unknown;
  try {
    await getIntelligenceTaskEvents(PROJECT_ID, TASK_ID, cursor);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(String(thrown)).not.toContain('private.example.test');
  expect(String(thrown)).not.toContain('cursor-secret');
  expect((thrown as { code?: string }).code).toBe('INTELLIGENCE_REQUEST_FAILED');
  expect(observedErrors).toEqual([]);
});
