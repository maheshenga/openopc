import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import {
  capabilityRequirementsFromChat,
  evaluateUpstreamCapabilities,
  requiredCapabilityNames,
} from './capability-profile';

const descriptor = (capabilities?: unknown): UpstreamDescriptor =>
  ({
    provider: 'test',
    kind: 'openai-responses',
    baseUrl: 'https://provider.invalid/v1',
    apiKey: 'private-test-key',
    billingMode: 'none',
    markup: 0,
    ...(capabilities === undefined ? {} : { capabilities }),
  }) as UpstreamDescriptor;

describe('provider capability profiles', () => {
  test('extracts only approved Chat request requirements', () => {
    const requirements = capabilityRequirementsFromChat({
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
      tools: [{ type: 'function', function: { name: 'lookup' } }],
      reasoning_effort: 'medium',
      metadata: { background: true, stateContinuation: true },
    });

    expect(requirements).toEqual({
      imageInput: true,
      streaming: true,
      functionTools: true,
      reasoning: true,
      stateContinuation: false,
      background: false,
    });
    expect(requiredCapabilityNames(requirements)).toEqual([
      'streaming',
      'image_input',
      'function_tools',
      'reasoning',
    ]);
  });

  test('keeps a missing profile legacy-compatible', () => {
    expect(
      evaluateUpstreamCapabilities(descriptor(), {
        imageInput: true,
        functionTools: true,
      }),
    ).toEqual({ eligible: true, profile: null });
  });

  test('excludes only explicitly unsupported capabilities', () => {
    expect(
      evaluateUpstreamCapabilities(
        descriptor({
          transport: 'responses',
          imageInput: true,
          functionTools: false,
        }),
        {
          imageInput: true,
          functionTools: true,
        },
      ),
    ).toEqual({
      eligible: false,
      reason: 'CAPABILITY_UNSUPPORTED',
      capabilities: ['function_tools'],
    });
  });

  test('rejects a mismatched transport and unknown profile fields', () => {
    expect(
      evaluateUpstreamCapabilities(
        descriptor({
          transport: 'chat-completions',
        }),
        { imageInput: false },
      ),
    ).toEqual({
      eligible: false,
      reason: 'PROFILE_INVALID',
      capabilities: [],
    });
    expect(
      evaluateUpstreamCapabilities(
        descriptor({
          transport: 'responses',
          provider_url: 'https://private.invalid',
        }),
        { imageInput: false },
      ),
    ).toEqual({
      eligible: false,
      reason: 'PROFILE_INVALID',
      capabilities: [],
    });
  });
});
