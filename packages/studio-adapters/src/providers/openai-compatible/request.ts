import type { StudioJobInput } from '@kortix/api-contract';
import type { StudioResolvedCredential } from '@kortix/studio-runtime';
import type { RequestInit } from 'undici/index.js';
import { type OpenAiCompatibleModelConfig, isOpenAiCompatibleReservedRequestField } from './config';

export interface OpenAiCompatibleImageRequest {
  url: URL;
  init: RequestInit;
}

const DEDICATED_OPTIONAL_FIELDS = new Set(['negative_prompt', 'seed']);

export function buildOpenAiCompatibleImageRequest(input: {
  baseUrl: URL;
  model: OpenAiCompatibleModelConfig;
  credential: StudioResolvedCredential;
  input: StudioJobInput;
}): OpenAiCompatibleImageRequest {
  assertBaseUrl(input.baseUrl);
  assertCredential(input.credential);

  const image = input.input.image;
  const body: Record<string, unknown> = {
    model: input.model.model,
    prompt: image.prompt,
    n: image.output_count,
    size: input.model.size_map[image.aspect_ratio],
    quality: image.quality,
    response_format: 'b64_json',
  };
  const allowed = new Set(input.model.allowed_advanced_fields);
  if (image.negative_prompt !== undefined && allowed.has('negative_prompt')) {
    body.negative_prompt = image.negative_prompt;
  }
  if (image.seed !== undefined && allowed.has('seed')) body.seed = image.seed;

  for (const field of input.model.allowed_advanced_fields) {
    if (
      DEDICATED_OPTIONAL_FIELDS.has(field) ||
      isOpenAiCompatibleReservedRequestField(field) ||
      !image.advanced ||
      !Object.prototype.hasOwnProperty.call(image.advanced, field)
    ) {
      continue;
    }
    const value = image.advanced[field];
    if (value !== undefined) body[field] = value;
  }

  let encodedBody: string;
  try {
    encodedBody = JSON.stringify(body);
  } catch {
    throw new Error('OpenAI-compatible request contains an invalid advanced value');
  }
  return {
    url: generationsUrl(input.baseUrl),
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.credential.value}`,
        'content-type': 'application/json',
      },
      body: encodedBody,
    },
  };
}

function generationsUrl(baseUrl: URL): URL {
  const base = new URL(baseUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  return new URL('images/generations', base);
}

function assertBaseUrl(url: URL): void {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('OpenAI-compatible base URL is invalid');
  }
}

function assertCredential(credential: StudioResolvedCredential): void {
  if (credential.value.trim().length === 0 || containsControlCharacter(credential.value)) {
    throw new Error('OpenAI-compatible credential is unavailable');
  }
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
