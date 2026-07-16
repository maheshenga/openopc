import { lookup as dnsLookup } from 'node:dns/promises';
import { type StudioJobInput, StudioJobInputSchema } from '@kortix/api-contract';
import {
  type StudioProviderAdapter,
  StudioProviderCallError,
  type StudioResolvedCredential,
} from '@kortix/studio-runtime';
import {
  type SafeStudioFetchInput,
  StudioSafeFetchError,
  type safeStudioFetch,
} from '../../network/safe-fetch';
import { StudioNetworkPolicyError, type StudioResolvedAddress } from '../../network/ssrf';
import {
  OPENAI_COMPATIBLE_DEFINITION_ID,
  type OpenAiCompatibleModelConfig,
  parseOpenAiCompatibleCapabilityMap,
} from './config';
import { openAiCompatibleImageDefinition } from './definition';
import { buildOpenAiCompatibleImageRequest } from './request';
import {
  OPENAI_COMPATIBLE_MAX_IMAGE_BYTES,
  OPENAI_COMPATIBLE_MAX_JSON_BYTES,
  parseOpenAiCompatibleImageResponse,
} from './response';

export interface OpenAiCompatibleRuntime {
  baseUrl: URL;
  model: OpenAiCompatibleModelConfig;
  credential: StudioResolvedCredential;
  fetch: typeof safeStudioFetch;
}

export function createOpenAiCompatibleImageAdapter(
  runtime: OpenAiCompatibleRuntime,
): StudioProviderAdapter {
  const model = snapshotRuntimeModel(runtime.model);
  const baseUrl = new URL(runtime.baseUrl);
  const credential = { ...runtime.credential };
  const fetch = runtime.fetch;

  return {
    id: OPENAI_COMPATIBLE_DEFINITION_ID,

    async submit(context, input) {
      const normalizedInput = normalizeValidInput(model, input);

      let request: ReturnType<typeof buildOpenAiCompatibleImageRequest>;
      try {
        request = buildOpenAiCompatibleImageRequest({
          baseUrl,
          model,
          credential,
          input: normalizedInput,
        });
      } catch {
        throw new StudioProviderCallError('terminal', 'STUDIO_PROVIDER_CONFIGURATION_INVALID');
      }

      let response: Awaited<ReturnType<typeof safeStudioFetch>>;
      try {
        response = await fetch(
          safeFetchInput({
            url: request.url,
            init: request.init,
            redirectPolicy: 'error',
            maxRedirects: 0,
            maxResponseBytes: OPENAI_COMPATIBLE_MAX_JSON_BYTES,
            authorizationOrigin: request.url.origin,
          }),
        );
      } catch (error) {
        if (error instanceof StudioNetworkPolicyError) {
          throw new StudioProviderCallError('terminal', 'STUDIO_NETWORK_POLICY');
        }
        if (error instanceof StudioSafeFetchError) {
          if (error.responseStatus !== undefined) {
            if (error.responseStatus >= 200 && error.responseStatus < 300) {
              if (error.code === 'STUDIO_RESPONSE_TOO_LARGE') {
                throw new StudioProviderCallError('terminal', 'STUDIO_ASSET_TOO_LARGE');
              }
              throw new StudioProviderCallError(
                'unknown_outcome',
                'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
              );
            }
            classifySubmitStatus(error.responseStatus);
          }
          if (error.dispatchState === 'not-dispatched') {
            throw new StudioProviderCallError('retryable', 'STUDIO_PROVIDER_UNAVAILABLE');
          }
        }
        throw new StudioProviderCallError('unknown_outcome', 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN');
      }

      classifySubmitStatus(response.status);
      const result = await parseOpenAiCompatibleImageResponse({
        response,
        expectedOutputCount: normalizedInput.image.output_count,
        fetchOutput: (url) =>
          fetch(
            safeFetchInput({
              url,
              init: { method: 'GET' },
              redirectPolicy: 'output-get',
              maxRedirects: 3,
              maxResponseBytes: OPENAI_COMPATIBLE_MAX_IMAGE_BYTES,
            }),
          ),
      });
      return {
        kind: 'completed',
        provider: OPENAI_COMPATIBLE_DEFINITION_ID,
        submission_key: context.submissionKey,
        result,
      };
    },

    async poll() {
      throw new StudioProviderCallError('terminal', 'STUDIO_PROVIDER_OPERATION_UNSUPPORTED');
    },

    async cancel() {
      // The generic synchronous profile has no upstream cancellation protocol.
    },

    async fetchResult() {
      throw new StudioProviderCallError('terminal', 'STUDIO_PROVIDER_OPERATION_UNSUPPORTED');
    },
  };
}

function snapshotRuntimeModel(model: OpenAiCompatibleModelConfig): OpenAiCompatibleModelConfig {
  const parsed = parseOpenAiCompatibleCapabilityMap({
    definition_id: OPENAI_COMPATIBLE_DEFINITION_ID,
    capabilities: { 'image.generate': { models: [model] } },
  });
  const snapshot = parsed.capabilities['image.generate'].models[0];
  if (!snapshot) throw new Error('Invalid OpenAI-compatible capability map');
  Object.freeze(snapshot.allowed_advanced_fields);
  Object.freeze(snapshot.size_map);
  return Object.freeze(snapshot);
}

function normalizeValidInput(
  model: OpenAiCompatibleModelConfig,
  input: StudioJobInput,
): StudioJobInput {
  const parsed = StudioJobInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new StudioProviderCallError('terminal', 'STUDIO_VALIDATION_ERROR');
  }
  const validation = openAiCompatibleImageDefinition.validate(
    {
      provider_config_id: 'invocation',
      provider: OPENAI_COMPATIBLE_DEFINITION_ID,
      base_url: null,
      region: null,
      capability_map: {
        definition_id: OPENAI_COMPATIBLE_DEFINITION_ID,
        capabilities: { 'image.generate': { models: [model] } },
      },
      version_token: 'invocation',
    },
    model.model,
    parsed.data,
  );
  if (!validation.ok) {
    throw new StudioProviderCallError('terminal', validation.code);
  }
  return parsed.data;
}

function safeFetchInput(input: {
  url: URL;
  init: SafeStudioFetchInput['init'];
  redirectPolicy: 'error' | 'output-get';
  maxRedirects: number;
  maxResponseBytes: number;
  authorizationOrigin?: string;
}): SafeStudioFetchInput {
  return {
    url: input.url,
    init: input.init,
    resolve: resolveSystemAddresses,
    allowPrivateOrigins: new Set(),
    allowInsecureLocalEndpoints: false,
    options: {
      redirectPolicy: input.redirectPolicy,
      maxRedirects: input.maxRedirects,
      connectTimeoutMs: 10_000,
      totalTimeoutMs: 120_000,
      maxResponseBytes: input.maxResponseBytes,
      ...(input.authorizationOrigin ? { authorizationOrigin: input.authorizationOrigin } : {}),
    },
  };
}

async function resolveSystemAddresses(hostname: string): Promise<readonly StudioResolvedAddress[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
}

function classifySubmitStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (
    (status >= 300 && status < 400) ||
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status >= 500 ||
    status < 200
  ) {
    throw new StudioProviderCallError('unknown_outcome', 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN');
  }
  throw new StudioProviderCallError('terminal', 'STUDIO_PROVIDER_REJECTED');
}
