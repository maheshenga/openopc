import { describe, expect, test } from 'bun:test';

import {
  buildMobileImageEstimateRequest,
  buildMobileImageTaskRequest,
  emptyMobileImageTaskState,
  hasMobileImageTarget,
  mergeMobileImageTaskEvents,
  parseMobileImageTaskState,
  reconcileMobileImageTaskWithJob,
  selectMobileImageTarget,
  serializeMobileImageTaskState,
  shouldRefreshMobileImageEstimate,
} from './mobile-image-studio';

const PROVIDER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const ASSET_ID = '55555555-5555-4555-8555-555555555555';
const ESTIMATE_ID = '66666666-6666-4666-8666-666666666666';

const targets = [
  {
    capability_id: 'studio.image.generate' as const,
    provider_config_id: PROVIDER_ID,
    model: 'openai-compatible/image-v1',
  },
];

describe('mobile Image Studio contract helpers', () => {
  test('shows the route only when an executable image target exists', () => {
    expect(hasMobileImageTarget([])).toBe(false);
    expect(hasMobileImageTarget(targets)).toBe(true);
    expect(selectMobileImageTarget(targets)).toEqual(targets[0]);
  });

  test('builds the bounded prompt-only mobile estimate request', () => {
    expect(
      buildMobileImageEstimateRequest({
        prompt: '  editorial product portrait  ',
        target: targets[0],
      }),
    ).toEqual({
      capability: 'image.generate',
      provider_config_id: PROVIDER_ID,
      model: 'openai-compatible/image-v1',
      input: {
        capability: 'image.generate',
        image: {
          prompt: 'editorial product portrait',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      },
    });

    expect(() => buildMobileImageEstimateRequest({ prompt: '   ', target: targets[0] })).toThrow(
      'INVALID_PROMPT',
    );
  });

  test('binds the approved estimate to the exact provider, model, and input', () => {
    const estimateRequest = buildMobileImageEstimateRequest({
      prompt: 'studio lighting',
      target: targets[0],
      aspectRatio: '4:3',
      quality: 'high',
      outputCount: 2,
    });

    expect(
      buildMobileImageTaskRequest(estimateRequest, {
        agentCardHash: 'a'.repeat(64),
        idempotencyKey: 'mobile-image:request-0001',
        estimate: {
          estimate_id: ESTIMATE_ID,
          estimate_token: 'estimate-token-value',
          expires_at: '2026-07-20T12:00:00.000Z',
          currency: 'credits',
          provider_cost_credits: 3,
          platform_cost_credits: 1,
          max_approved_credits: 4,
          input_hash: 'b'.repeat(64),
          line_items: [],
        },
      }),
    ).toEqual({
      protocol_version: 'intelligence.v1',
      capability_id: 'studio.image.generate',
      agent_card_hash: 'a'.repeat(64),
      provider_config_id: PROVIDER_ID,
      model: 'openai-compatible/image-v1',
      input: estimateRequest.input,
      idempotency_key: 'mobile-image:request-0001',
      parent_task_id: null,
      deadline_at: null,
      estimate_approval: {
        estimate_id: ESTIMATE_ID,
        estimate_token: 'estimate-token-value',
        max_approved_credits: 4,
      },
    });
  });

  test('merges durable cursor pages and stops after a terminal event', () => {
    const initial = emptyMobileImageTaskState(TASK_ID, JOB_ID);
    const running = mergeMobileImageTaskEvents(initial, {
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      next_cursor: 'cursor-2',
      items: [
        {
          protocol_version: 'intelligence.v1',
          event_id: '77777777-7777-4777-8777-777777777777',
          task_id: TASK_ID,
          job_id: JOB_ID,
          sequence: 2,
          type: 'progress',
          status: 'running',
          progress: 0.6,
          asset_ids: [ASSET_ID],
          created_at: '2026-07-20T11:01:00.000Z',
        },
        {
          protocol_version: 'intelligence.v1',
          event_id: '88888888-8888-4888-8888-888888888888',
          task_id: TASK_ID,
          job_id: JOB_ID,
          sequence: 1,
          type: 'queued',
          status: 'queued',
          progress: 0,
          created_at: '2026-07-20T11:00:00.000Z',
        },
      ],
    });

    expect(running).toMatchObject({
      taskId: TASK_ID,
      jobId: JOB_ID,
      cursor: 'cursor-2',
      status: 'running',
      progress: 0.6,
      assetIds: [ASSET_ID],
      terminal: false,
      lastSequence: 2,
    });

    const completed = mergeMobileImageTaskEvents(running, {
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      next_cursor: 'cursor-3',
      items: [
        {
          protocol_version: 'intelligence.v1',
          event_id: '99999999-9999-4999-8999-999999999999',
          task_id: TASK_ID,
          job_id: JOB_ID,
          sequence: 3,
          type: 'succeeded',
          status: 'succeeded',
          progress: 1,
          asset_ids: [ASSET_ID],
          created_at: '2026-07-20T11:02:00.000Z',
        },
      ],
    });

    expect(completed).toMatchObject({
      cursor: 'cursor-3',
      status: 'succeeded',
      progress: 1,
      assetIds: [ASSET_ID],
      terminal: true,
      lastSequence: 3,
    });
    expect(
      mergeMobileImageTaskEvents(completed, {
        protocol_version: 'intelligence.v1',
        task_id: TASK_ID,
        next_cursor: 'cursor-4',
        items: [],
      }),
    ).toEqual(completed);
  });

  test('persists only a validated project-scoped task snapshot', () => {
    const state = {
      ...emptyMobileImageTaskState(TASK_ID, JOB_ID),
      cursor: 'cursor-7',
      status: 'running' as const,
      progress: 0.4,
      lastSequence: 7,
    };
    expect(parseMobileImageTaskState(serializeMobileImageTaskState(state))).toEqual(state);
    expect(parseMobileImageTaskState('{"taskId":"https://unsafe.example"}')).toBeNull();
    expect(parseMobileImageTaskState('not-json')).toBeNull();
  });

  test('recovers terminal status from the SDK job snapshot after a cursor failure', () => {
    const state = {
      ...emptyMobileImageTaskState(TASK_ID, JOB_ID),
      cursor: 'expired-cursor',
      status: 'running' as const,
      progress: 0.5,
    };
    expect(
      reconcileMobileImageTaskWithJob(state, {
        job_id: JOB_ID,
        status: 'failed',
        error_code: 'STUDIO_PROVIDER_UNAVAILABLE',
        updated_at: '2026-07-20T11:05:00.000Z',
      }),
    ).toMatchObject({
      status: 'failed',
      progress: 0.5,
      terminal: true,
      errorCode: 'STUDIO_PROVIDER_UNAVAILABLE',
      lastUpdatedAt: '2026-07-20T11:05:00.000Z',
    });
  });

  test('refreshes only stale estimate failures and preserves unknown-outcome retries', () => {
    expect(shouldRefreshMobileImageEstimate('STUDIO_ESTIMATE_EXPIRED')).toBe(true);
    expect(shouldRefreshMobileImageEstimate('STUDIO_PRICING_STALE')).toBe(true);
    expect(shouldRefreshMobileImageEstimate('STUDIO_PROVIDER_CONFIG_STALE')).toBe(true);
    expect(shouldRefreshMobileImageEstimate('INTELLIGENCE_ESTIMATE_INVALID')).toBe(true);
    expect(shouldRefreshMobileImageEstimate('NETWORK_ERROR')).toBe(false);
    expect(shouldRefreshMobileImageEstimate(null)).toBe(false);
  });
});
