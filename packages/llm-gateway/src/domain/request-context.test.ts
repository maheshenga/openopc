import { describe, expect, test } from 'bun:test';
import { gatewayRequestContext } from './request-context';

const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

describe('gateway request context', () => {
  test('normalizes a bounded W3C trace context', () => {
    expect(
      gatewayRequestContext('req_1', {
        traceparent: TRACEPARENT.toUpperCase(),
        tracestate: ' vendor=value ',
      }),
    ).toEqual({
      requestId: 'req_1',
      traceparent: TRACEPARENT,
      tracestate: 'vendor=value',
    });
  });

  test('drops invalid or unsafe external trace values', () => {
    expect(
      gatewayRequestContext('req_2', {
        traceparent: '00-00000000000000000000000000000000-2222222222222222-01',
        tracestate: 'vendor=value',
      }),
    ).toEqual({ requestId: 'req_2' });
    expect(
      gatewayRequestContext('req_3', {
        traceparent: TRACEPARENT,
        tracestate: 'vendor=value\r\nx-private: secret',
      }),
    ).toEqual({ requestId: 'req_3', traceparent: TRACEPARENT });
  });
});
