import { describe, expect, test } from 'bun:test';
import {
  INTELLIGENCE_PROTOCOL_VERSION,
  UnsupportedIntelligenceProtocolError,
  assertSupportedProtocolVersion,
} from './compatibility';

describe('intelligence protocol compatibility', () => {
  test('accepts the first supported protocol revision', () => {
    expect(assertSupportedProtocolVersion(INTELLIGENCE_PROTOCOL_VERSION)).toBe(
      INTELLIGENCE_PROTOCOL_VERSION,
    );
  });

  test('rejects an unknown protocol revision with a typed redacted error', () => {
    let thrown: unknown;
    try {
      assertSupportedProtocolVersion('intelligence.9-secret-token');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedIntelligenceProtocolError);
    expect(String(thrown)).toContain('unsupported');
    expect(String(thrown)).not.toContain('secret-token');
  });
});
