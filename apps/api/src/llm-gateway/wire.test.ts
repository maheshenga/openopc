import { describe, expect, test } from 'bun:test';

import { config } from '../config';

const wireModule = await import('./wire');

describe('in-process LLM gateway lifetime', () => {
  test('is unavailable when disabled and returns one shared instance when enabled', () => {
    const getGateway = (
      wireModule as typeof wireModule & {
        getInProcessLlmGateway?: () => unknown;
      }
    ).getInProcessLlmGateway;
    expect(typeof getGateway).toBe('function');
    if (!getGateway) return;

    const original = config.LLM_GATEWAY_ENABLED;
    try {
      config.LLM_GATEWAY_ENABLED = false;
      expect(getGateway()).toBeNull();
      config.LLM_GATEWAY_ENABLED = true;
      const first = getGateway();
      expect(first).toBeDefined();
      expect(getGateway()).toBe(first);
    } finally {
      config.LLM_GATEWAY_ENABLED = original;
    }
  });
});
