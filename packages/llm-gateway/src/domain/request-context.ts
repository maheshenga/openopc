const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/;

export interface GatewayRequestContext {
  requestId: string;
  traceparent?: string;
  tracestate?: string;
}

export interface GatewayTraceHeaders {
  traceparent?: string;
  tracestate?: string;
}

function normalizedTraceparent(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  const match = TRACEPARENT.exec(normalized);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return undefined;
  return normalized;
}

function normalizedTracestate(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 512) return undefined;
  if (!/^[\x20-\x7e]+$/.test(normalized)) return undefined;
  const members = normalized.split(',');
  if (members.length > 32 || members.some((member) => !member.trim() || !member.includes('='))) {
    return undefined;
  }
  return normalized;
}

export function gatewayRequestContext(
  requestId: string,
  headers: GatewayTraceHeaders,
): GatewayRequestContext {
  const traceparent = normalizedTraceparent(headers.traceparent);
  if (!traceparent) return { requestId };
  const tracestate = normalizedTracestate(headers.tracestate);
  return {
    requestId,
    traceparent,
    ...(tracestate ? { tracestate } : {}),
  };
}
