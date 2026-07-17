import { describe, expect, test } from 'bun:test';
import { readRegistryCapabilities } from './index';
import type { RegistryItem } from './schema';

const item = (capabilities: unknown, extraMeta: Record<string, unknown> = {}): RegistryItem =>
  ({
    name: 'image-agent',
    type: 'registry:agent',
    meta: { ...extraMeta, capabilities },
  }) as RegistryItem;

describe('registry capability metadata', () => {
  test('normalizes the declared capability arrays and ignores unrelated metadata', () => {
    expect(
      readRegistryCapabilities(
        item(
          {
            secrets: [' OPENAI_API_KEY ', 'OPENAI_API_KEY'],
            connectors: ['image-provider'],
            network: ['*.example.com'],
            tools: ['web_search'],
            writes: ['@skills/*'],
            required_runtime: [' node >= 20 ', 'node >= 20'],
          },
          { icon: 'image', api_key: 'must-not-be-read' },
        ),
      ),
    ).toEqual({
      secrets: ['OPENAI_API_KEY'],
      connectors: ['image-provider'],
      network: ['*.example.com'],
      tools: ['web_search'],
      writes: ['@skills/*'],
      required_runtime: ['node >= 20'],
    });
  });

  test('returns null when capabilities metadata is absent or malformed', () => {
    expect(readRegistryCapabilities(null as unknown as RegistryItem)).toBeNull();
    expect(readRegistryCapabilities({ name: 'plain', type: 'registry:skill' })).toBeNull();
    expect(readRegistryCapabilities(item({ secrets: 'OPENAI_API_KEY' }))).toBeNull();
    expect(readRegistryCapabilities(item({ tools: [''] }))).toBeNull();
  });

  test('rejects embedded environment values and URL credentials', () => {
    expect(readRegistryCapabilities(item({ secrets: ['OPENAI_API_KEY=raw-secret'] }))).toBeNull();
    expect(
      readRegistryCapabilities(item({ network: ['https://user:password@example.com'] })),
    ).toBeNull();
  });

  test('rejects unknown capability keys instead of silently widening the contract', () => {
    expect(readRegistryCapabilities(item({ writes: ['@skills/'], hidden: ['secret'] }))).toBeNull();
  });
});
