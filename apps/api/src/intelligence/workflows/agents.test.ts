import { expect, test } from 'bun:test';
import type { IntelligenceCreateTaskRequest } from '@kortix/api-contract';
import type { AgentCard } from '@kortix/intelligence-contracts';
import { workflowNodeFixture } from '@kortix/intelligence-orchestration/fixtures';
import {
  createProjectWorkflowAgentList,
  createWorkflowAgentInvoker,
  createWorkflowAgentRegistry,
  createWorkflowExecutor,
} from './agents';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const CARD_HASH = 'a'.repeat(64);
const PROVIDER_CONFIG_ID = '55555555-5555-4555-8555-555555555555';

const plannerCard: AgentCard = {
  id: 'content-planner',
  version: '1.0.0',
  display_name: 'Content Planner',
  capabilities: ['studio.image.generate'],
  protocols: ['a2a', 'mcp'],
  auth: { kind: 'kortix-project-token' },
  trust_tier: 'project',
  limits: { concurrency: 1, max_task_seconds: 120 },
  card_hash: CARD_HASH,
};

test('resolves an installed enabled Agent with the exact role-bound card hash', async () => {
  const calls: unknown[] = [];
  const registry = createWorkflowAgentRegistry({
    listInstalled: async (scope) => {
      calls.push(scope);
      return [{ name: 'content-planner', enabled: true, card: plannerCard }];
    },
  });

  const resolved = await registry.resolve({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    expectedRole: 'planner',
    binding: {
      role: 'planner',
      agentName: 'content-planner',
      cardHash: CARD_HASH,
    },
  });

  expect(calls).toEqual([{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }]);
  expect(resolved).toEqual({
    role: 'planner',
    agentName: 'content-planner',
    card: plannerCard,
  });
});

test('adapts only enabled project manifest Agents into the workflow registry source', async () => {
  const cardLoads: string[] = [];
  const listInstalled = createProjectWorkflowAgentList({
    loadProjectAgents: async () => ({
      specs: [
        {
          name: 'content-planner',
          path: 'kortix.yaml#agents.content-planner',
          enabled: true,
          connectors: [],
          kortixCli: [],
          env: [],
          file: null,
          model: null,
        },
        {
          name: 'disabled-reviewer',
          path: 'kortix.yaml#agents.disabled-reviewer',
          enabled: false,
          connectors: [],
          kortixCli: [],
          env: [],
          file: null,
          model: null,
        },
      ],
      errors: [],
      defaultAgent: 'content-planner',
    }),
    loadAgentCard: async ({ agentName }) => {
      cardLoads.push(agentName);
      return plannerCard;
    },
  });

  const installed = await listInstalled({ accountId: ACCOUNT_ID, projectId: PROJECT_ID });

  expect(cardLoads).toEqual(['content-planner']);
  expect(installed).toEqual([{ name: 'content-planner', enabled: true, card: plannerCard }]);
});

test('rejects a cross-role binding before installed Agent lookup', async () => {
  let lookups = 0;
  const registry = createWorkflowAgentRegistry({
    listInstalled: async () => {
      lookups += 1;
      return [];
    },
  });

  let thrown: unknown;
  try {
    await registry.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      expectedRole: 'planner',
      binding: { role: 'executor', agentName: 'image-executor', cardHash: CARD_HASH },
    });
  } catch (error) {
    thrown = error;
  }

  expect(lookups).toBe(0);
  expect(thrown).toMatchObject({ code: 'WORKFLOW_AGENT_ROLE_MISMATCH' });
});

test('redacts installed Agent lookup failures behind a stable error', async () => {
  const registry = createWorkflowAgentRegistry({
    listInstalled: async () => {
      throw new Error('Bearer private-token at https://provider.example.test');
    },
  });

  let thrown: unknown;
  try {
    await registry.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      expectedRole: 'planner',
      binding: { role: 'planner', agentName: 'content-planner', cardHash: CARD_HASH },
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code: 'WORKFLOW_AGENT_UNAVAILABLE' });
  expect(String(thrown)).not.toMatch(/private-token|provider\.example/i);
});

test('propagates caller cancellation into the Kortix Agent session', async () => {
  const registry = createWorkflowAgentRegistry({
    listInstalled: async () => [{ name: 'content-planner', enabled: true, card: plannerCard }],
  });
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let sessionSignal: AbortSignal | null = null;
  const invoker = createWorkflowAgentInvoker({
    registry,
    invokeSession: async (input) => {
      sessionSignal = input.signal;
      markStarted?.();
      return new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('raw abort detail')), {
          once: true,
        });
      });
    },
  });
  const controller = new AbortController();
  const pending = invoker.invoke({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    expectedRole: 'planner',
    binding: { role: 'planner', agentName: 'content-planner', cardHash: CARD_HASH },
    context: { run_id: 'run-1' },
    signal: controller.signal,
  });

  await started;
  controller.abort();
  let thrown: unknown;
  try {
    await pending;
  } catch (error) {
    thrown = error;
  }

  expect((sessionSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(thrown).toMatchObject({ code: 'WORKFLOW_AGENT_CANCELLED' });
  expect(String(thrown)).not.toContain('raw abort detail');
});

test('aborts the Agent session at the bounded invocation timeout', async () => {
  const registry = createWorkflowAgentRegistry({
    listInstalled: async () => [{ name: 'content-planner', enabled: true, card: plannerCard }],
  });
  let sessionSignal: AbortSignal | null = null;
  const invoker = createWorkflowAgentInvoker({
    registry,
    invokeSession: async (input) => {
      sessionSignal = input.signal;
      return new Promise((_, reject) => {
        input.signal.addEventListener('abort', () => reject(new Error('internal abort')), {
          once: true,
        });
        setTimeout(() => reject(new Error('raw provider timeout detail')), 10);
      });
    },
  });

  let thrown: unknown;
  try {
    await invoker.invoke({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      expectedRole: 'planner',
      binding: { role: 'planner', agentName: 'content-planner', cardHash: CARD_HASH },
      context: { run_id: 'run-1' },
      timeoutMs: 1,
    });
  } catch (error) {
    thrown = error;
  }

  expect((sessionSignal as AbortSignal | null)?.aborted).toBe(true);
  expect(thrown).toMatchObject({ code: 'WORKFLOW_AGENT_TIMEOUT' });
  expect(String(thrown)).not.toMatch(/provider|timeout detail/i);
});

test('times out even when the Agent session ignores the abort signal', async () => {
  const registry = createWorkflowAgentRegistry({
    listInstalled: async () => [{ name: 'content-planner', enabled: true, card: plannerCard }],
  });
  const invoker = createWorkflowAgentInvoker({
    registry,
    invokeSession: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { late: true };
    },
  });

  let thrown: unknown;
  try {
    await invoker.invoke({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      expectedRole: 'planner',
      binding: { role: 'planner', agentName: 'content-planner', cardHash: CARD_HASH },
      context: { run_id: 'run-1' },
      timeoutMs: 1,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code: 'WORKFLOW_AGENT_TIMEOUT' });
});

test('resolves an executor proposal only after target discovery and IAM validation', async () => {
  const calls: string[] = [];
  const request: IntelligenceCreateTaskRequest = {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: CARD_HASH,
    provider_config_id: PROVIDER_CONFIG_ID,
    model: 'fake/image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'A private workflow image prompt',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    idempotency_key: 'untrusted-executor-proposal',
    parent_task_id: null,
    deadline_at: null,
  };
  const executor = createWorkflowExecutor({
    invokeAgent: {
      invoke: async () => {
        calls.push('invoke');
        return request;
      },
    },
    listExecutionTargets: async () => {
      calls.push('targets');
      return [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ];
    },
    authorizeRequest: async () => {
      calls.push('authorize');
      return true;
    },
  });

  const result = await executor.resolve({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    binding: { role: 'executor', agentName: 'image-executor', cardHash: CARD_HASH },
    node: workflowNodeFixture({
      role: 'executor',
      kind: 'capability',
      agent_name: 'image-executor',
      agent_card_hash: CARD_HASH,
    }),
    context: { private_input: { prompt_ref: 'sealed:workflow-node-input-1' } },
  });

  expect(calls).toEqual(['invoke', 'targets', 'authorize']);
  expect(result).toEqual(request);
});
