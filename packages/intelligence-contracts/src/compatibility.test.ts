import { describe, expect, test } from 'bun:test';
import {
  INTELLIGENCE_PROTOCOL_VERSION,
  UnsupportedIntelligenceProtocolError,
  WORKFLOW_PROTOCOL_VERSION,
  assertSupportedProtocolVersion,
  assertSupportedWorkflowProtocolVersion,
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

  test('accepts the first workflow protocol revision', () => {
    expect(assertSupportedWorkflowProtocolVersion(WORKFLOW_PROTOCOL_VERSION)).toBe(
      'intelligence.workflow.v1',
    );
  });
});
