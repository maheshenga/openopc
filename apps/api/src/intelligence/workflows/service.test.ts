import { describe, expect, test } from 'bun:test';
import type { WorkflowNode } from '@kortix/intelligence-contracts';
import type {
  IntelligenceRouteCandidate,
  IntelligenceRoutePolicySnapshot,
  IntelligenceRouteRequest,
  WorkflowPayloadStore,
} from '@kortix/intelligence-orchestration';
import {
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { createMemoryWorkflowStore } from './memory-store';
import { createStudioWorkflowPayloadStore } from './payload-store';
import { createMemoryIntelligenceRouteDecisionStore } from '../routing/decision-store';
import { createWorkflowService } from './service';

const NOW = '2026-07-18T10:00:00.000Z';

class RecordingPayloadStore implements WorkflowPayloadStore {
  private tokenCounter = 10;
  readonly inner = createStudioWorkflowPayloadStore(
    new InMemoryStudioObjectStore({ namespace: 'private-studio', ready: true }),
    {
      randomUUID: () => `71000000-0000-4000-a000-${String(this.tokenCounter++).padStart(12, '0')}`,
    },
  );
  sealed: string[] = [];
  deleted: string[] = [];
  reads = 0;

  async seal(input: Parameters<WorkflowPayloadStore['seal']>[0]) {
    const result = await this.inner.seal(input);
    this.sealed.push(result.payloadRef);
    return result;
  }

  async read(input: Parameters<WorkflowPayloadStore['read']>[0]) {
    this.reads += 1;
    return this.inner.read(input);
  }

  async delete(input: Parameters<WorkflowPayloadStore['delete']>[0]) {
    this.deleted.push(input.payloadRef);
    return this.inner.delete(input);
  }
}

function serviceFixture(
  options: {
    payloads?: WorkflowPayloadStore;
    authorizePayloadRead?: Parameters<typeof createWorkflowService>[0]['authorizePayloadRead'];
    routing?: Parameters<typeof createWorkflowService>[0]['routing'];
  } = {},
) {
  return createWorkflowService({
    port: createMemoryWorkflowStore(),
    payloads: options.payloads ?? new RecordingPayloadStore(),
    now: () => NOW,
    authorizePayloadRead: options.authorizePayloadRead,
    routing: options.routing,
  });
}

describe('workflow service', () => {
  test('computes canonical run hashes without exposing private payload references', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({ payloads });
    const run = workflowRunFixture();

    const started = await service.startRunFromRequest({
      run,
      request: { z: 1, a: 'same' },
    });
    const node = workflowNodeFixture({ run_id: run.run_id });
    const appended = await service.appendNodeWithPayload({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-render-primary-0001',
      node,
      payload: { prompt: 'private', order: 1 },
    });

    expect(started.run.request_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(appended.node.input_hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify({ started, appended })).not.toContain('sealed:');
    expect(payloads.sealed).toHaveLength(1);
  });

  test('writes payload before graph mutation and cleans it after a failed or replayed append', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({ payloads });
    const run = workflowRunFixture();
    await service.startRun({ run });
    const node = workflowNodeFixture({ run_id: run.run_id });

    await service.appendNodeWithPayload({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-render-primary-0001',
      node,
      payload: { prompt: 'first' },
    });
    await expect(
      service.appendNodeWithPayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        node,
        payload: { prompt: 'replay' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_IDEMPOTENCY_MISMATCH' });
    expect(payloads.sealed).toHaveLength(2);
    expect(payloads.deleted).toHaveLength(1);
  });

  test('authorizes project and Agent context before reading private payload bytes', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({
      payloads,
      authorizePayloadRead: async () => false,
    });
    const run = workflowRunFixture();
    await service.startRun({ run });
    const node = workflowNodeFixture({ run_id: run.run_id });
    await service.appendNodeWithPayload({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-node-render-primary-0001',
      node,
      payload: { prompt: 'private' },
    });

    await expect(
      service.readNodePayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        nodeId: node.node_id,
        payloadRef: payloads.sealed[0] ?? 'sealed:missing',
        expectedHash: node.input_hash,
        workerId: 'workflow-worker-a',
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_PAYLOAD_AUTHORIZATION_REQUIRED' });
    expect(payloads.reads).toBe(0);
  });

  test('rejects expired or terminal graph side effects before writing a payload', async () => {
    const payloads = new RecordingPayloadStore();
    const service = serviceFixture({ payloads });
    const run = workflowRunFixture();
    await service.startRun({ run });
    const expiredNode: WorkflowNode = workflowNodeFixture({
      run_id: run.run_id,
      deadline_at: '2026-07-18T09:59:00.000Z',
    });

    await expect(
      service.appendNodeWithPayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        node: expiredNode,
        payload: { prompt: 'expired' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_DEADLINE_EXCEEDED' });
    expect(payloads.sealed).toHaveLength(0);

    await service.cancelRun({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
      cancelledAt: NOW,
    });
    await expect(
      service.appendNodeWithPayload({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        expectedGraphVersion: 0,
        idempotencyKey: 'workflow-node-render-primary-0001',
        node: workflowNodeFixture({ run_id: run.run_id }),
        payload: { prompt: 'terminal' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_TERMINAL' });
    expect(payloads.sealed).toHaveLength(0);
  });

  test('delegates event cursors, resume, cancel, and immutable task behavior to the port', async () => {
    const service = serviceFixture();
    const run = workflowRunFixture();
    await service.startRun({ run });
    await service.cancelRun({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
      cancelledAt: NOW,
    });
    const events = await service.readEvents({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      afterSequence: 0,
      limit: 100,
    });
    expect(events.items.map((event) => event.type)).toEqual(['run_created', 'run_cancelled']);
    expect(JSON.stringify(events)).not.toMatch(/payload_ref|input_hash|credential|provider/i);
    await expect(
      service.resumeRun({
        accountId: run.account_id,
        projectId: run.project_id,
        runId: run.run_id,
        updatedAt: NOW,
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  test('keeps deterministic routing unavailable unless its optional adapters are injected', async () => {
    const service = serviceFixture();
    const run = workflowRunFixture();
    await service.startRun({ run });

    await expect(
      service.routeImageNode(routeInput(run.account_id, run.project_id, run.run_id)),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ROUTING_UNAVAILABLE' });
  });

  test('routes an in-scope image node once and rejects a foreign scope before discovery', async () => {
    const calls: unknown[] = [];
    const decisionStore = createMemoryIntelligenceRouteDecisionStore();
    const service = serviceFixture({
      routing: {
        candidateSource: {
          async listImageCandidates(input) {
            calls.push(input);
            return [routeCandidate()];
          },
        },
        decisionStore,
      },
    });
    const run = workflowRunFixture();
    const node = workflowNodeFixture({ run_id: run.run_id });
    await service.startRun({ run });
    await service.appendNode({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-route-node-0001',
      requestHash: HASH_A,
      node,
    });

    const input = routeInput(run.account_id, run.project_id, run.run_id, node.node_id);
    expect(await service.routeImageNode(input)).toMatchObject({
      created: true,
      decision: {
        primary: { candidateId: HASH_B },
        fallback: null,
        reasonCodes: ['ROUTE_PRIMARY_SELECTED'],
      },
    });
    expect(await service.routeImageNode(input)).toMatchObject({ created: false });
    expect(calls).toHaveLength(1);
    await expect(
      service.routeImageNode({
        ...input,
        request: { ...input.request, requestHash: HASH_A },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ROUTE_CONFLICT' });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(await decisionStore.get(input))).not.toMatch(
      /private route prompt|provider_url|api_key|credential|raw_response/i,
    );

    await expect(
      service.routeImageNode({
        ...input,
        projectId: '22000000-0000-4000-a000-000000000099',
        request: {
          ...input.request,
          projectId: '22000000-0000-4000-a000-000000000099',
        },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_ROUTE_SCOPE_DENIED' });
    expect(calls).toHaveLength(1);

    await service.cancelRun({
      accountId: run.account_id,
      projectId: run.project_id,
      runId: run.run_id,
      reasonCode: 'WORKFLOW_CANCELLED_BY_USER',
      cancelledAt: NOW,
    });
    expect(await service.routeImageNode(input)).toMatchObject({ created: false });
    expect(calls).toHaveLength(1);
  });
});

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function routeCandidate(): IntelligenceRouteCandidate {
  return {
    candidateId: HASH_B,
    providerDefinitionId: 'openai-compatible',
    providerConfigId: '26000000-0000-4000-a000-000000000001',
    modelId: 'images/pro-v1',
    capabilityId: 'studio.image.generate',
    capabilityVersion: '1.0.0',
    schemaVersion: 'studio.image.generate.request.v1',
    region: 'cn-east-1',
    safetyClass: 'standard',
    supportedInputKinds: ['text', 'image'],
    outputKind: 'image',
    ready: true,
    iamAllowed: true,
    agentAllowed: true,
    projectPolicy: 'allow',
    estimatedCostMicredits: 2_000_000,
    estimatedLatencyMs: 1_500,
    riskPenaltyPpm: 0,
    evaluation: {
      snapshotVersion: 'image-route-eval-v1',
      publishedAt: '2026-07-18T09:00:00.000Z',
      sampleCount: 100,
      minimumSampleCount: 30,
      meetsMinimumSamples: true,
      confidenceLowerBoundPpm: 900_000,
      qualityRatePpm: 920_000,
      availabilityRatePpm: 970_000,
      failureRatePpm: 30_000,
    },
  };
}

function routePolicy(): IntelligenceRoutePolicySnapshot {
  return {
    policyVersion: 'image-route-policy-v1',
    policyHash: HASH_A,
    allowedRegions: ['cn-east-1'],
    allowedSafetyClasses: ['standard'],
    maximumCandidateRiskPpm: 1_000_000,
    maximumCostMicredits: 5_000_000,
    maximumLatencyMs: 10_000,
    maximumEvaluationAgeMs: 24 * 60 * 60 * 1_000,
    minimumSampleCount: 30,
    minimumConfidenceLowerBoundPpm: 800_000,
    minimumQualityRatePpm: 800_000,
    minimumAvailabilityRatePpm: 800_000,
    maximumFailureRatePpm: 200_000,
    weightsBps: {
      quality: 10_000,
      availability: 10_000,
      latency: 10_000,
      cost: 10_000,
      risk: 10_000,
    },
    normalization: { latencyMs: 10_000, costMicredits: 10_000_000 },
  };
}

function routeInput(
  accountId: string,
  projectId: string,
  runId: string,
  nodeId = '24000000-0000-4000-a000-000000000001',
) {
  const request: IntelligenceRouteRequest = {
    decisionId: '25000000-0000-4000-a000-000000000001',
    accountId,
    projectId,
    capabilityId: 'studio.image.generate',
    capabilityVersion: '1.0.0',
    schemaVersion: 'studio.image.generate.request.v1',
    inputKinds: ['text'],
    outputKind: 'image',
    requiredRegion: 'cn-east-1',
    maximumSafetyClass: 'standard',
    remainingBudgetMicredits: 5_000_000,
    deadlineAt: '2026-07-18T10:00:10.000Z',
    now: NOW,
    proposedCandidateId: null,
    requestHash: HASH_B,
  };
  return {
    accountId,
    projectId,
    runId,
    nodeId,
    request,
    policy: routePolicy(),
    actor: { accountId, actorType: 'system' as const },
    imageInput: {
      capability: 'image.generate' as const,
      image: {
        prompt: 'private route prompt',
        reference_asset_ids: [],
        aspect_ratio: '1:1' as const,
        width: 1024,
        height: 1024,
        quality: 'standard' as const,
        output_count: 1,
      },
    },
    iamAllowed: true,
    agentAllowed: true,
    projectPolicy: 'allow' as const,
  };
}
