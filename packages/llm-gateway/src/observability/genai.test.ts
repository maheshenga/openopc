import { describe, expect, test } from 'bun:test';
import type { GatewayTrace } from '../domain';
import { gatewayTraceToGenAiObservation } from './genai';

const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

function trace(over: Partial<GatewayTrace> = {}): GatewayTrace {
  return {
    requestId: 'req_1',
    startedAt: '2026-01-01T00:00:00.000Z',
    accountId: 'private-account',
    actorUserId: 'private-user',
    projectId: 'private-project',
    requestedModel: 'kortix/x',
    resolvedModel: 'anthropic/x',
    provider: 'openrouter',
    billingMode: 'credits',
    streaming: false,
    status: 200,
    ok: true,
    latencyMs: 12,
    attempts: 2,
    candidatesTried: ['private-candidate'],
    usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
    upstreamCost: 0.01,
    finalCost: 0.02,
    request: { prompt: 'private prompt' },
    response: { output: 'private response' },
    metadata: { signed_url: 'https://private.invalid' },
    traceparent: TRACEPARENT,
    ...over,
  };
}

describe('gateway GenAI observation', () => {
  test('maps a trace to bounded semantic and OpenOPC attributes', () => {
    expect(gatewayTraceToGenAiObservation(trace())).toEqual({
      name: 'gen_ai.chat',
      traceparent: TRACEPARENT,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openrouter',
        'gen_ai.request.model': 'kortix/x',
        'gen_ai.response.model': 'anthropic/x',
        'gen_ai.usage.input_tokens': 10,
        'gen_ai.usage.output_tokens': 5,
        'openopc.gateway.cache_read_input_tokens': 2,
        'openopc.gateway.status_code': 200,
        'openopc.gateway.streaming': false,
        'openopc.gateway.attempts': 2,
        'openopc.gateway.billing_mode': 'credits',
        'openopc.gateway.upstream_cost_usd': 0.01,
        'openopc.gateway.final_cost_usd': 0.02,
      },
    });
  });

  test('never projects bodies, identities, URLs, candidate lists, or arbitrary errors', () => {
    const observation = gatewayTraceToGenAiObservation(
      trace({
        ok: false,
        errorCode: 'private secret value',
        traceparent: 'private trace value',
      }),
    );
    expect(observation.attributes['error.type']).toBe('gateway_error');
    expect(observation.traceparent).toBeUndefined();
    expect(JSON.stringify(observation)).not.toMatch(
      /private-account|private-user|private-project|private prompt|private response|private\.invalid|private-candidate|private secret value/i,
    );
  });
});
