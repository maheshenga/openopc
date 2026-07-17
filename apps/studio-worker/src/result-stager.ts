import {
  StudioObjectStoreError,
  StudioProviderCallError,
  parseStudioStagingManifest,
  studioStagingManifestKey,
  studioStagingPrefix,
  studioSubmissionKeyHash,
  type StudioObjectMetadata,
  type StudioObjectStore,
  type StudioStagingManifest,
} from '@kortix/studio-runtime';
import type { StudioProviderAsset } from '@kortix/studio-runtime';
import { validateStudioImage, StudioImageValidationError } from '@kortix/studio-adapters';

const MAX_ASSET_REPLAYS = 3;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

export type StudioResultStageIdentity = {
  accountId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  submissionKey: string;
  providerConfigId: string;
  providerConfigVersion: string;
  pricingCatalogId: string;
  pricingVersion: number;
};

export type StudioResultStageInput = StudioResultStageIdentity & {
  assets: readonly StudioProviderAsset[];
  usage: Record<string, number>;
};

export type StudioStagedResult = {
  manifest: StudioStagingManifest;
  manifestKey: string;
  manifestChecksum: string;
  assets: Array<{
    kind: 'image';
    bucket: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    checksumSha256: string;
    filename: string;
  }>;
};

export class StudioResultStager {
  constructor(
    private readonly store: StudioObjectStore,
    private readonly options: { maxAssetReplays?: number } = {},
  ) {}

  async stage(input: StudioResultStageInput): Promise<StudioStagedResult> {
    await this.store.assertReady();
    const identity = normalizeIdentity(input);
    const prefix = stagingPrefix(identity);
    const manifestKey = `${prefix}manifest.json`;

    const existing = await this.loadManifest(identity);
    if (existing) return existing;

    const assets: StudioStagingManifest['assets'] = [];
    for (const [index, asset] of input.assets.entries()) {
      assets.push(await this.stageAsset({ prefix, index, asset }));
    }
    if (assets.length === 0) {
      throw new StudioProviderCallError('terminal', 'Studio provider returned no assets');
    }

    const manifest = parseStudioStagingManifest({
      version: 1,
      account_id: identity.accountId,
      project_id: identity.projectId,
      job_id: identity.jobId,
      attempt_id: identity.attemptId,
      submission_key_hash: studioSubmissionKeyHash(identity.submissionKey),
      provider_config_id: identity.providerConfigId,
      provider_config_version: identity.providerConfigVersion,
      pricing_catalog_id: identity.pricingCatalogId,
      pricing_version: identity.pricingVersion,
      assets,
      usage: input.usage,
    });
    const manifestBytes = encodeManifest(manifest);
    const manifestChecksum = checksum(manifestBytes);
    await this.store.putObject({
      key: manifestKey,
      body: byteStream(manifestBytes),
      content_type: 'application/json',
      size_bytes: manifestBytes.byteLength,
      checksum_sha256: manifestChecksum,
      metadata: {
        project_id: identity.projectId,
        job_id: identity.jobId,
        attempt_id: identity.attemptId,
        kind: 'studio-staging-manifest',
      },
    });
    return toStagedResult(
      { manifest, manifestKey, manifestChecksum },
      this.store.namespace,
    );
  }

  async loadManifest(
    identity: StudioResultStageIdentity,
  ): Promise<StudioStagedResult | null> {
    await this.store.assertReady();
    const normalized = normalizeIdentity(identity);
    const prefix = stagingPrefix(normalized);
    const manifestKey = `${prefix}manifest.json`;
    let metadata: StudioObjectMetadata;
    try {
      metadata = await this.store.headObject({ key: manifestKey });
    } catch (error) {
      if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
    assertBoundObject(metadata, manifestKey, this.store);
    if (metadata.content_type !== 'application/json') {
      throw new StudioProviderCallError('terminal', 'Studio staging manifest MIME is invalid');
    }
    const object = await this.store.getObject({ key: manifestKey });
    const bytes = await readBytes(object.body, MAX_MANIFEST_BYTES);
    const manifestChecksum = checksum(bytes);
    if (metadata.checksum_sha256 !== manifestChecksum || metadata.size_bytes !== bytes.byteLength) {
      throw new StudioProviderCallError('terminal', 'Studio staging manifest checksum is invalid');
    }
    let manifest: StudioStagingManifest;
    try {
      manifest = parseStudioStagingManifest(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      throw new StudioProviderCallError('terminal', 'Studio staging manifest is invalid');
    }
    assertManifestIdentity(manifest, normalized);
    const expectedPrefix = prefix;
    for (const asset of manifest.assets) {
      if (!asset.key.startsWith(expectedPrefix) || asset.key === manifestKey) {
        throw new StudioProviderCallError('terminal', 'Studio staging asset key escaped its prefix');
      }
      let assetMetadata: StudioObjectMetadata;
      try {
        assetMetadata = await this.store.headObject({ key: asset.key });
      } catch {
        throw new StudioProviderCallError('unknown_outcome', 'Studio staging asset is unavailable');
      }
      assertBoundObject(assetMetadata, asset.key, this.store);
      if (
        assetMetadata.content_type !== asset.mime_type ||
        assetMetadata.size_bytes !== asset.size_bytes ||
        assetMetadata.checksum_sha256 !== asset.checksum_sha256
      ) {
        throw new StudioProviderCallError('terminal', 'Studio staging asset identity is invalid');
      }
    }
    return toStagedResult(
      { manifest, manifestKey, manifestChecksum },
      this.store.namespace,
    );
  }

  private async stageAsset(input: {
    prefix: string;
    index: number;
    asset: StudioProviderAsset;
  }): Promise<StudioStagingManifest['assets'][number]> {
    const maxReplays = input.asset.replayable_within_attempt
      ? Math.max(
          1,
          Math.min(MAX_ASSET_REPLAYS, this.options.maxAssetReplays ?? MAX_ASSET_REPLAYS),
        )
      : 1;
    const filename = safeFilename(input.asset.filename, input.index);
    const key = `${input.prefix}assets/${String(input.index).padStart(3, '0')}-${filename}`;
    let lastError: unknown;
    for (let replay = 0; replay < maxReplays; replay += 1) {
      let bytes: Uint8Array;
      try {
        bytes = await readBytes(await input.asset.openBody(), MAX_ASSET_BYTES);
      } catch (error) {
        lastError = error;
        continue;
      }
      if (bytes.byteLength !== input.asset.size_bytes) {
        throw new StudioProviderCallError(
          'terminal',
          `Studio provider asset size mismatch: expected ${input.asset.size_bytes}, got ${bytes.byteLength}`,
        );
      }
      let validated: Awaited<ReturnType<typeof validateStudioImage>>;
      try {
        validated = await validateStudioImage({ bytes, mimeType: input.asset.mime_type });
      } catch (error) {
        if (error instanceof StudioImageValidationError) {
          throw new StudioProviderCallError('terminal', error.code);
        }
        throw new StudioProviderCallError('terminal', 'Studio provider asset validation failed');
      }
      const checksumSha256 = checksum(bytes);
      try {
        await this.store.putObject({
          key,
          body: byteStream(bytes),
          content_type: validated.mimeType,
          size_bytes: bytes.byteLength,
          checksum_sha256: checksumSha256,
          metadata: {
            project_id: input.prefix.split('/')[3] ?? '',
            kind: 'studio-staging-asset',
          },
        });
      } catch (error) {
        lastError = error;
        if (
          !(error instanceof StudioObjectStoreError) ||
          (error.code !== 'CHECKSUM_MISMATCH' && error.code !== 'SIZE_MISMATCH')
        ) {
          throw error;
        }
        continue;
      }
      return {
        kind: 'image',
        key,
        filename,
        mime_type: validated.mimeType,
        size_bytes: bytes.byteLength,
        checksum_sha256: checksumSha256,
      };
    }
    if (lastError instanceof StudioProviderCallError) throw lastError;
    throw new StudioProviderCallError(
      'unknown_outcome',
      'Studio provider result asset could not be staged after replay attempts',
    );
  }
}

function normalizeIdentity(input: StudioResultStageIdentity): StudioResultStageIdentity {
  if (!Number.isInteger(input.pricingVersion) || input.pricingVersion < 1) {
    throw new StudioProviderCallError('terminal', 'Studio pricing version is invalid');
  }
  return {
    accountId: input.accountId,
    projectId: input.projectId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    submissionKey: input.submissionKey,
    providerConfigId: input.providerConfigId,
    providerConfigVersion: input.providerConfigVersion,
    pricingCatalogId: input.pricingCatalogId,
    pricingVersion: input.pricingVersion,
  };
}

function stagingPrefix(identity: StudioResultStageIdentity): string {
  try {
    return studioStagingPrefix({
      accountId: identity.accountId,
      projectId: identity.projectId,
      jobId: identity.jobId,
      attemptId: identity.attemptId,
      submissionKeyHash: studioSubmissionKeyHash(identity.submissionKey),
    });
  } catch {
    throw new StudioProviderCallError('terminal', 'Studio staging identity is invalid');
  }
}

function assertManifestIdentity(
  manifest: StudioStagingManifest,
  identity: StudioResultStageIdentity,
): void {
  if (
    manifest.account_id !== identity.accountId ||
    manifest.project_id !== identity.projectId ||
    manifest.job_id !== identity.jobId ||
    manifest.attempt_id !== identity.attemptId ||
    manifest.submission_key_hash !== studioSubmissionKeyHash(identity.submissionKey) ||
    manifest.provider_config_id !== identity.providerConfigId ||
    manifest.provider_config_version !== identity.providerConfigVersion ||
    manifest.pricing_catalog_id !== identity.pricingCatalogId ||
    manifest.pricing_version !== identity.pricingVersion
  ) {
    throw new StudioProviderCallError('terminal', 'Studio staging manifest identity does not match');
  }
}

function assertBoundObject(
  metadata: StudioObjectMetadata,
  key: string,
  store: StudioObjectStore,
): void {
  if (
    metadata.namespace !== store.namespace ||
    metadata.key !== key ||
    (store.required_server_side_encryption &&
      metadata.server_side_encryption !== store.required_server_side_encryption) ||
    (store.required_server_side_encryption === 'aws:kms' &&
      store.required_sse_kms_key_id &&
      metadata.sse_kms_key_id !== store.required_sse_kms_key_id)
  ) {
    throw new StudioProviderCallError('terminal', 'Studio object metadata is not trusted');
  }
}

function toStagedResult(
  input: { manifest: StudioStagingManifest; manifestKey: string; manifestChecksum: string },
  namespace: string,
): StudioStagedResult {
  return {
    ...input,
    assets: input.manifest.assets.map((asset) => ({
      kind: asset.kind,
      bucket: namespace,
      objectKey: asset.key,
      mimeType: asset.mime_type,
      sizeBytes: asset.size_bytes,
      checksumSha256: asset.checksum_sha256,
      filename: asset.filename,
    })),
  };
}

function encodeManifest(manifest: StudioStagingManifest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new StudioProviderCallError('terminal', 'Studio staging manifest is too large');
  }
  return bytes;
}

function checksum(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function readBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new StudioProviderCallError('terminal', 'Studio object is too large');
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
}

function safeFilename(value: string, index: number): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `asset-${index}.bin`;
}
