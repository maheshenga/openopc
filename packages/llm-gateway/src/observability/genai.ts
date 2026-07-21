import type { BillingMode, GatewayTrace } from '../domain';
import { gatewayRequestContext } from '../domain';

export interface GatewayGenAiAttributes {
  'gen_ai.operation.name': 'chat';
  'gen_ai.provider.name': string;
  'gen_ai.request.model': string;
  'gen_ai.response.model': string;
  'gen_ai.usage.input_tokens': number;
  'gen_ai.usage.output_tokens': number;
  'openopc.gateway.cache_read_input_tokens': number;
  'openopc.gateway.status_code': number;
  'openopc.gateway.streaming': boolean;
  'openopc.gateway.attempts': number;
  'openopc.gateway.billing_mode': BillingMode;
  'openopc.gateway.upstream_cost_usd': number;
  'openopc.gateway.final_cost_usd': number;
  'error.type'?: string;
}

export interface GatewayGenAiObservation {
  name: 'gen_ai.chat';
  traceparent?: string;
  attributes: GatewayGenAiAttributes;
}

function identifier(value: string, fallback = 'unknown'): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : fallback;
}

function count(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

function cost(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : 'gateway_error';
}

export function gatewayTraceToGenAiObservation(trace: GatewayTrace): GatewayGenAiObservation {
  const error = trace.ok ? undefined : (errorType(trace.errorCode) ?? 'gateway_error');
  const traceparent = gatewayRequestContext(trace.requestId, {
    traceparent: trace.traceparent,
  }).traceparent;
  return {
    name: 'gen_ai.chat',
    ...(traceparent ? { traceparent } : {}),
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': identifier(trace.provider),
      'gen_ai.request.model': identifier(trace.requestedModel),
      'gen_ai.response.model': identifier(trace.resolvedModel || trace.requestedModel),
      'gen_ai.usage.input_tokens': count(trace.usage.promptTokens),
      'gen_ai.usage.output_tokens': count(trace.usage.completionTokens),
      'openopc.gateway.cache_read_input_tokens': count(trace.usage.cachedTokens),
      'openopc.gateway.status_code': count(trace.status, 599),
      'openopc.gateway.streaming': trace.streaming,
      'openopc.gateway.attempts': count(trace.attempts, 100),
      'openopc.gateway.billing_mode': trace.billingMode,
      'openopc.gateway.upstream_cost_usd': cost(trace.upstreamCost),
      'openopc.gateway.final_cost_usd': cost(trace.finalCost),
      ...(error ? { 'error.type': error } : {}),
    },
  };
}
