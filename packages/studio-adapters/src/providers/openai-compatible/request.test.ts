import { describe, expect, test } from 'bun:test';
import type { StudioJobInput } from '@kortix/api-contract';
import type { StudioResolvedCredential } from '@kortix/studio-runtime';
import { Headers } from 'undici/index.js';
import type { OpenAiCompatibleModelConfig } from './config';
import { buildOpenAiCompatibleImageRequest } from './request';

const model: OpenAiCompatibleModelConfig = {
  model: 'image-model-v1',
  pricing_catalog_id: 'pricing-image-v1',
  dialect_profile_id: 'openai-images-v1-generic',
  supports_reference_images: false,
  allowed_advanced_fields: [
    'negative_prompt',
    'seed',
    'style',
    'guidance_scale',
    'supports_submit_replay',
  ],
  size_map: {
    '1:1': '1024x1024',
    '4:3': '1024x768',
    '3:4': '768x1024',
    '16:9': '1536x864',
    '9:16': '864x1536',
  },
};
const credential: StudioResolvedCredential = {
  source: 'secret',
  value: 'test-only-provider-key',
  version_token: 'credential-version-1',
};

function input(overrides: Partial<StudioJobInput['image']> = {}): StudioJobInput {
  return {
    capability: 'image.generate',
    image: {
      prompt: 'A cinematic mountain observatory',
      reference_asset_ids: [],
      aspect_ratio: '16:9',
      quality: 'high',
      output_count: 2,
      ...overrides,
    },
  };
}

describe('OpenAI-compatible image request', () => {
  test('builds the fixed generic POST without an idempotency declaration', () => {
    const request = buildOpenAiCompatibleImageRequest({
      baseUrl: new URL('https://provider.example.test/v1'),
      model,
      credential,
      input: input(),
    });
    const headers = new Headers(request.init.headers);

    expect(request.url.href).toBe('https://provider.example.test/v1/images/generations');
    expect(request.init.method).toBe('POST');
    expect(headers.get('authorization')).toBe('Bearer test-only-provider-key');
    expect(headers.get('content-type')).toBe('application/json');
    expect([...headers.keys()].some((name) => name.includes('idempotency'))).toBe(false);
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: 'image-model-v1',
      prompt: 'A cinematic mountain observatory',
      n: 2,
      size: '1536x864',
      quality: 'high',
      response_format: 'b64_json',
    });
  });

  test('maps only explicit model-allowlisted advanced fields', () => {
    const request = buildOpenAiCompatibleImageRequest({
      baseUrl: new URL('https://provider.example.test/v1/'),
      model,
      credential,
      input: input({
        negative_prompt: 'fog',
        seed: 7,
        advanced: {
          style: 'photographic',
          guidance_scale: 8,
          undocumented: 'never-send',
          prompt: 'never-overwrite',
          supports_submit_replay: true,
        },
      }),
    });

    expect(JSON.parse(String(request.init.body))).toEqual({
      model: 'image-model-v1',
      prompt: 'A cinematic mountain observatory',
      n: 2,
      size: '1536x864',
      quality: 'high',
      response_format: 'b64_json',
      negative_prompt: 'fog',
      seed: 7,
      style: 'photographic',
      guidance_scale: 8,
    });
    expect(String(request.init.body)).not.toContain(credential.value);
  });

  test('fails closed on an empty credential without exposing its version token', () => {
    expect(() =>
      buildOpenAiCompatibleImageRequest({
        baseUrl: new URL('https://provider.example.test/v1'),
        model,
        credential: { ...credential, value: '', version_token: 'must-not-leak' },
        input: input(),
      }),
    ).toThrow('OpenAI-compatible credential is unavailable');
  });
});
