import { describe, expect, test } from 'bun:test';
import type { IntelligenceRouteDecision } from '@kortix/intelligence-orchestration';
import {
  IntelligenceRouteDecisionStoreError,
  createDrizzleIntelligenceRouteDecisionStore,
  createMemoryIntelligenceRouteDecisionStore,
} from './decision-store';

const ACCOUNT_ID = '81000000-0000-4000-a000-000000000001';
const PROJECT_ID = '82000000-0000-4000-a000-000000000001';
const RUN_ID = '83000000-0000-4000-a000-000000000001';
const NODE_ID = '84000000-0000-4000-a000-000000000001';
const DECISION_ID = '85000000-0000-4000-a000-000000000001';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function decision(overrides: Partial<IntelligenceRouteDecision> = {}): IntelligenceRouteDecision {
  return {
    protocolVersion: 'intelligence.route.v1',
    decisionId: DECISION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    requestHash: HASH_A,
    policyVersion: 'image-route-policy-v1',
    policyHash: HASH_B,
    primary: {
      candidateId: HASH_B,
      providerDefinitionId: 'openai-compatible',
      providerConfigId: '86000000-0000-4000-a000-000000000001',
      modelId: 'images/pro-v1',
      evaluationVersion: 'image-route-eval-v1',
      scorePpm: 1_540_000,
      components: {
        qualityPpm: 920_000,
        availabilityPpm: 970_000,
        latencyPenaltyPpm: 150_000,
        costPenaltyPpm: 200_000,
        riskPenaltyPpm: 0,
      },
    },
    fallback: null,
    rejected: [],
    reasonCodes: ['ROUTE_PRIMARY_SELECTED'],
    createdAt: '2026-07-19T08:00:00.000Z',
    ...overrides,
  };
}

describe('intelligence route decision store', () => {
  test('inserts once, replays the exact decision, and returns project-fenced reads', async () => {
    const store = createMemoryIntelligenceRouteDecisionStore();
    const input = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeId: NODE_ID,
      decision: decision(),
    };

    expect(await store.put(input)).toEqual({ decision: decision(), created: true });
    expect(await store.put(input)).toEqual({ decision: decision(), created: false });
    expect(
      await store.get({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: NODE_ID,
      }),
    ).toEqual(decision());
    expect(
      await store.get({
        accountId: ACCOUNT_ID,
        projectId: '82000000-0000-4000-a000-000000000002',
        runId: RUN_ID,
        nodeId: NODE_ID,
      }),
    ).toBeNull();
  });

  test('rejects scope mismatches and a different immutable decision for the same node', async () => {
    const store = createMemoryIntelligenceRouteDecisionStore();
    await expect(
      store.put({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: NODE_ID,
        decision: decision({ projectId: '82000000-0000-4000-a000-000000000002' }),
      }),
    ).rejects.toBeInstanceOf(IntelligenceRouteDecisionStoreError);

    await store.put({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      nodeId: NODE_ID,
      decision: decision(),
    });
    await expect(
      store.put({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: NODE_ID,
        decision: decision({ decisionId: '85000000-0000-4000-a000-000000000002' }),
      }),
    ).rejects.toMatchObject({ code: 'ROUTE_DECISION_CONFLICT' });
  });

  test('strictly rejects extra provider, credential, prompt, and raw response fields', async () => {
    const store = createMemoryIntelligenceRouteDecisionStore();
    const unsafe = {
      ...decision(),
      primary: {
        ...decision().primary,
        providerUrl: 'https://provider.example/v1',
        apiKey: 'secret',
      },
      prompt: 'private prompt',
      rawResponse: { output: 'private response' },
    } as unknown as IntelligenceRouteDecision;

    await expect(
      store.put({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: RUN_ID,
        nodeId: NODE_ID,
        decision: unsafe,
      }),
    ).rejects.toMatchObject({ code: 'ROUTE_DECISION_INVALID' });
  });

  test('constructs the Drizzle adapter without opening a connection', () => {
    const store = createDrizzleIntelligenceRouteDecisionStore({} as never);
    expect(Object.keys(store).sort()).toEqual(['get', 'put']);
  });
});
