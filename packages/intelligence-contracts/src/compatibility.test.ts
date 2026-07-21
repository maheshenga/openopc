import { describe, expect, test } from 'bun:test';
import {
  AUTOMATION_PROTOCOL_VERSION,
  INTELLIGENCE_PROTOCOL_VERSION,
  UnsupportedAutomationProtocolError,
  UnsupportedIntelligenceProtocolError,
  WORKFLOW_PROTOCOL_VERSION,
  assertSupportedAutomationProtocolVersion,
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

  test('accepts the first automation protocol revision', () => {
    expect(assertSupportedAutomationProtocolVersion(AUTOMATION_PROTOCOL_VERSION)).toBe(
      'automation.v1',
    );
  });

  test('rejects an unknown automation revision without reflecting its value', () => {
    let thrown: unknown;
    try {
      assertSupportedAutomationProtocolVersion('automation.secret-token-v9');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnsupportedAutomationProtocolError);
    expect(String(thrown)).toContain('unsupported');
    expect(String(thrown)).not.toContain('secret-token');
  });
});
