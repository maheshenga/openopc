import { describe, expect, test } from 'bun:test';
import {
  IntelligenceCapabilitiesResponseSchema,
  IntelligenceCapabilityDiscoveryResponseSchema,
  IntelligenceCreateTaskRequestSchema,
  IntelligenceErrorCodeSchema,
  IntelligenceExecutionTargetSchema,
  IntelligenceWorkflowAddDependencyRequestSchema,
  IntelligenceWorkflowAppendNodeRequestSchema,
  IntelligenceWorkflowCancelRequestSchema,
  IntelligenceWorkflowEventsResponseSchema,
  IntelligenceWorkflowNodeResponseSchema,
  IntelligenceWorkflowSealRequestSchema,
  IntelligenceWorkflowStartRequestSchema,
  IntelligenceWorkflowStartResponseSchema,
} from './intelligence';

const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const RUN_ID = '61000000-0000-4000-a000-000000000001';
const NODE_ID = '62000000-0000-4000-a000-000000000001';
const DEPENDENCY_ID = '65000000-0000-4000-a000-000000000001';
const SHA256_HASH = `sha256:${'a'.repeat(64)}`;
const CARD_HASH = 'b'.repeat(64);

describe('Intelligence API contract', () => {
  test('exposes only stable Intelligence error codes', () => {
    expect(IntelligenceErrorCodeSchema.parse('INTELLIGENCE_IDEMPOTENCY_MISMATCH')).toBe(
      'INTELLIGENCE_IDEMPOTENCY_MISMATCH',
    );
    expect(
      IntelligenceErrorCodeSchema.safeParse('provider=https://secret.example.test').success,
    ).toBe(false);
  });

  test('accepts only redaction-safe execution options', () => {
    const option = {
      capability_id: 'studio.image.generate' as const,
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
    };

    expect(IntelligenceExecutionTargetSchema.parse(option)).toEqual(option);
    expect(
      IntelligenceExecutionTargetSchema.safeParse({
        ...option,
        provider_url: 'https://secret.example.test/v1',
      }).success,
    ).toBe(false);
    expect(
      IntelligenceExecutionTargetSchema.safeParse({
        ...option,
        credential_binding: { kind: 'secret', identifier: 'IMAGE_API_KEY' },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceExecutionTargetSchema.safeParse({
        ...option,
        model: 'https://secret.example.test/v1?api_key=raw',
      }).success,
    ).toBe(false);
    for (const model of [
      'data:text/plain,secret',
      'file:///tmp/key',
      'mailto:secret@example.test',
    ]) {
      expect(IntelligenceExecutionTargetSchema.safeParse({ ...option, model }).success).toBe(false);
    }
  });

  test('keeps the default capabilities view strict and validates the explicit discovery view', () => {
    const capabilities = {
      protocol_version: 'intelligence.v1' as const,
      items: [],
      next_cursor: null,
    };
    expect(IntelligenceCapabilitiesResponseSchema.parse(capabilities)).toEqual({
      protocol_version: 'intelligence.v1',
      items: [],
      next_cursor: null,
    });
    expect(
      IntelligenceCapabilitiesResponseSchema.safeParse({
        ...capabilities,
        execution_targets: [],
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCapabilityDiscoveryResponseSchema.parse({
        protocol_version: 'intelligence.v1',
        items: [],
        execution_targets: [
          {
            capability_id: 'studio.image.generate',
            provider_config_id: PROVIDER_CONFIG_ID,
            model: 'fake/image-v1',
          },
        ],
        next_cursor: null,
      }).execution_targets,
    ).toHaveLength(1);
    expect(
      IntelligenceCapabilitiesResponseSchema.safeParse({
        protocol_version: 'intelligence.v1',
        items: [
          {
            id: 'studio.image.generate',
            version: '1.0.0',
            modality: 'image',
            operation: 'generate',
            input_schema: { type: 'object', provider_url: 'https://secret.example.test' },
            output_schema: { type: 'array', asset_kinds: ['image'] },
            execution: 'async',
            risk: 'write',
            provenance_required: true,
          },
        ],
        next_cursor: null,
      }).success,
    ).toBe(false);
  });

  test('does not accept a provider URL as a task model identifier', () => {
    const valid = {
      protocol_version: 'intelligence.v1' as const,
      capability_id: 'studio.image.generate' as const,
      agent_card_hash: 'a'.repeat(64),
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'fake/image-v1',
      input: {
        capability: 'image.generate' as const,
        image: {
          prompt: 'safe prompt',
          aspect_ratio: '1:1' as const,
          quality: 'standard' as const,
          output_count: 1,
        },
      },
      idempotency_key: 'intelligence-contract-task-0001',
    };
    expect(IntelligenceCreateTaskRequestSchema.safeParse(valid).success).toBe(true);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: {
            ...valid.input.image,
            advanced: { provider_url: 'https://secret.example.test/v1' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: {
            ...valid.input.image,
            advanced: { accessToken: 'secret-value' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: {
            ...valid.input.image,
            advanced: { endpoint: 'endpoint=https://secret.example.test/v1' },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        input: {
          ...valid.input,
          image: { ...valid.input.image, advanced: { value: '//secret.example.test/key' } },
        },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceCreateTaskRequestSchema.safeParse({
        ...valid,
        model: 'https://secret.example.test/v1?api_key=raw',
      }).success,
    ).toBe(false);
  });

  test('accepts only a strict bounded workflow start request', () => {
    const request = {
      protocol_version: 'intelligence.workflow.v1' as const,
      idempotency_key: 'workflow-contract-run-0001',
      goal: 'Create a governed image workflow',
      context_asset_ids: [],
      policy_snapshot_hash: SHA256_HASH,
      evaluation_version: null,
      max_nodes: 16,
      max_dependencies: 32,
      max_approved_credits: 100,
      deadline_at: null,
    };

    expect(IntelligenceWorkflowStartRequestSchema.parse(request)).toEqual(request);
    expect(
      IntelligenceWorkflowStartRequestSchema.safeParse({ ...request, provider_url: 'hidden' })
        .success,
    ).toBe(false);
    expect(
      IntelligenceWorkflowStartRequestSchema.safeParse({
        ...request,
        goal: 'Use https://provider.example.test/v1?api_key=raw',
      }).success,
    ).toBe(false);
    expect(
      IntelligenceWorkflowStartRequestSchema.safeParse({
        ...request,
        goal: 'Use API_KEY=raw-secret-value',
      }).success,
    ).toBe(false);
    expect(
      IntelligenceWorkflowStartRequestSchema.safeParse({ ...request, max_nodes: 129 }).success,
    ).toBe(false);
  });

  test('validates strict trusted-Agent graph commands and bounded private payloads', () => {
    const append = {
      protocol_version: 'intelligence.workflow.v1' as const,
      sender_card_hash: CARD_HASH,
      expected_graph_version: 0,
      idempotency_key: 'workflow-contract-node-0001',
      node: {
        node_id: NODE_ID,
        node_key: 'render-primary',
        role: 'executor' as const,
        kind: 'capability' as const,
        agent_name: null,
        agent_card_hash: null,
        capability_id: 'studio.image.generate' as const,
        capability_version: '1.0.0' as const,
        policy_snapshot_hash: SHA256_HASH,
        evaluation_version: null,
        deadline_at: null,
      },
      payload: { prompt: 'private input', asset_ids: [] },
    };

    expect(IntelligenceWorkflowAppendNodeRequestSchema.parse(append)).toEqual(append);
    expect(
      IntelligenceWorkflowAppendNodeRequestSchema.safeParse({
        ...append,
        payload: { credential: 'raw' },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceWorkflowAppendNodeRequestSchema.safeParse({
        ...append,
        payload: { note: 'authorization: Bearer raw-secret-value' },
      }).success,
    ).toBe(false);
    expect(
      IntelligenceWorkflowAppendNodeRequestSchema.safeParse({
        ...append,
        payload: { value: 'x'.repeat(1024 * 1024 + 1) },
      }).success,
    ).toBe(false);

    expect(
      IntelligenceWorkflowAddDependencyRequestSchema.parse({
        protocol_version: 'intelligence.workflow.v1',
        sender_card_hash: CARD_HASH,
        expected_graph_version: 1,
        dependency_id: DEPENDENCY_ID,
        node_id: NODE_ID,
        depends_on_node_id: '62000000-0000-4000-a000-000000000002',
        condition: 'on_success',
      }).dependency_id,
    ).toBe(DEPENDENCY_ID);
    expect(
      IntelligenceWorkflowSealRequestSchema.parse({
        protocol_version: 'intelligence.workflow.v1',
        sender_card_hash: CARD_HASH,
        expected_graph_version: 2,
      }).expected_graph_version,
    ).toBe(2);
    expect(
      IntelligenceWorkflowCancelRequestSchema.safeParse({
        protocol_version: 'intelligence.workflow.v1',
        reason_code: 'WORKFLOW_CANCELLED_BY_USER',
        raw_error: 'provider=https://secret.example.test',
      }).success,
    ).toBe(false);
  });

  test('keeps workflow responses strict and free of private payload references', () => {
    const run = {
      protocol_version: 'intelligence.workflow.v1' as const,
      run_id: RUN_ID,
      account_id: '63000000-0000-4000-a000-000000000001',
      project_id: '64000000-0000-4000-a000-000000000001',
      actor_type: 'user' as const,
      actor_id: '66000000-0000-4000-a000-000000000001',
      agent_name: null,
      idempotency_key: 'workflow-contract-run-0001',
      request_hash: SHA256_HASH,
      status: 'draft' as const,
      graph_version: 0,
      policy_snapshot_hash: SHA256_HASH,
      evaluation_version: null,
      max_nodes: 16,
      max_dependencies: 32,
      max_approved_credits: 100,
      deadline_at: null,
      created_at: '2026-07-18T10:00:00.000Z',
      updated_at: '2026-07-18T10:00:00.000Z',
      terminal_at: null,
    };
    const response = IntelligenceWorkflowStartResponseSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      run,
      created: true,
    });
    expect(response.created).toBe(true);
    expect(
      IntelligenceWorkflowStartResponseSchema.safeParse({
        protocol_version: 'intelligence.workflow.v1',
        run,
        created: true,
        payload_ref: 'sealed:private',
      }).success,
    ).toBe(false);

    expect(
      IntelligenceWorkflowNodeResponseSchema.safeParse({
        protocol_version: 'intelligence.workflow.v1',
        node: { payload_ref: 'sealed:private' },
        created: true,
        graph_version: 1,
      }).success,
    ).toBe(false);
    expect(
      IntelligenceWorkflowEventsResponseSchema.parse({
        protocol_version: 'intelligence.workflow.v1',
        run_id: RUN_ID,
        items: [],
        next_cursor: null,
      }).items,
    ).toEqual([]);
  });
});
