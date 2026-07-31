import { describe, expect, test } from 'bun:test';

import { newApiConnectorConfigured, normalizeNewApiBaseUrl } from './new-api-connector';

describe('NewAPI connector configuration', () => {
  test('normalizes one OpenAI-compatible v1 base without changing the operator path', () => {
    expect(normalizeNewApiBaseUrl('https://new-api.example.com/gateway///', 'prod')).toBe(
      'https://new-api.example.com/gateway/v1',
    );
    expect(normalizeNewApiBaseUrl('https://new-api.example.com/gateway/v1/', 'staging')).toBe(
      'https://new-api.example.com/gateway/v1',
    );
  });

  test('allows local HTTP only in dev and rejects credential-bearing or ambiguous URLs', () => {
    expect(normalizeNewApiBaseUrl('http://127.0.0.1:3000/', 'dev')).toBe(
      'http://127.0.0.1:3000/v1',
    );

    for (const [url, environment] of [
      ['http://new-api.example.com', 'prod'],
      ['https://user:secret@new-api.example.com', 'prod'],
      ['https://new-api.example.com?token=secret', 'prod'],
      ['https://new-api.example.com#credential', 'prod'],
      ['ftp://new-api.example.com', 'dev'],
    ] as const) {
      expect(() => normalizeNewApiBaseUrl(url, environment)).toThrow('NEWAPI_BASE_URL is invalid');
    }
  });

  test('is configured only when the normalized URL and service credential both exist', () => {
    const configured = {
      NEWAPI_BASE_URL: 'https://new-api.example.com',
      NEWAPI_SERVICE_API_KEY: 'server-only-key',
      NEWAPI_API_COMPATIBILITY: 'openai-v1' as const,
      INTERNAL_KORTIX_ENV: 'prod' as const,
    };

    expect(newApiConnectorConfigured(configured)).toBe(true);
    expect(newApiConnectorConfigured({ ...configured, NEWAPI_BASE_URL: '' })).toBe(false);
    expect(newApiConnectorConfigured({ ...configured, NEWAPI_SERVICE_API_KEY: '' })).toBe(false);
  });
});
