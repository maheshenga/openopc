import { createHash, randomUUID } from 'node:crypto';
import {
  DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
  type RegistryItem,
  type RegistryModuleArtifactEnvelope,
  type RegistryModuleLockGraph,
  type RegistryModuleSourceProvenance,
  type ResolvedRegistryModuleFile,
  createRegistryModuleArtifactEnvelope,
  validateRegistryItem,
} from '@kortix/registry';

export const DEVELOPER_ARTIFACT_MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
export const DEVELOPER_ARTIFACT_UPLOAD_TTL_MS = 5 * 60_000;

export type DeveloperArtifactUploadState =
  | 'created'
  | 'uploaded'
  | 'finalized'
  | 'cancelled'
  | 'expired';

export interface DeveloperModuleArtifact {
  artifact_id: string;
  account_id: string;
  publisher_id: string;
  artifact_digest: `sha256:${string}`;
  envelope_digest: `sha256:${string}`;
  media_type: typeof DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE;
  size_bytes: number;
  item_snapshot: RegistryItem;
  source_provenance: RegistryModuleSourceProvenance | null;
  created_by: string;
  created_at: string;
}

export interface DeveloperModuleArtifactRecord extends DeveloperModuleArtifact {
  storage_key: string;
}

export interface DeveloperModuleArtifactUploadRecord {
  upload_id: string;
  account_id: string;
  publisher_id: string;
  state: DeveloperArtifactUploadState;
  expected_digest: `sha256:${string}`;
  expected_size: number;
  staging_storage_key: string;
  artifact_id: string | null;
  expires_at: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeveloperModuleArtifactUploadTicket {
  upload_id: string;
  state: 'created';
  expected_digest: `sha256:${string}`;
  expected_size: number;
  upload_url: string;
  headers: Record<string, string>;
  expires_at: string;
}

export interface DeveloperModuleArtifactFinalization {
  artifact: DeveloperModuleArtifact;
  created: boolean;
}

export interface ArtifactReadLimits {
  maxBytes: number;
}

export interface DeveloperArtifactStore {
  createUpload(input: {
    accountId: string;
    uploadId: string;
    expectedSize: number;
    expectedDigest: `sha256:${string}`;
    expiresAt: Date;
  }): Promise<{ storageKey: string; uploadUrl: string; headers: Record<string, string> }>;
  headStaging(storageKey: string): Promise<{ size: number; digest: `sha256:${string}` }>;
  readStaging(storageKey: string, limits: ArtifactReadLimits): AsyncIterable<Uint8Array>;
  commit(input: {
    stagingKey: string;
    accountId: string;
    artifactDigest: `sha256:${string}`;
  }): Promise<string>;
  writeCanonical(input: {
    accountId: string;
    artifactDigest: `sha256:${string}`;
    bytes: Uint8Array;
    digest: `sha256:${string}`;
  }): Promise<string>;
  deleteStaging(storageKey: string): Promise<void>;
}

export function createUnavailableDeveloperArtifactStore(): DeveloperArtifactStore {
  const unavailable = async (): Promise<never> => {
    throw new Error('Developer artifact object store is unavailable');
  };
  return {
    createUpload: unavailable,
    headStaging: unavailable,
    readStaging() {
      return {
        [Symbol.asyncIterator]() {
          return { next: unavailable };
        },
      };
    },
    commit: unavailable,
    writeCanonical: unavailable,
    deleteStaging: unavailable,
  };
}

export interface DeveloperModuleArtifactRepository {
  claimPublisher(input: {
    accountId: string;
    publisherId: string;
    displayName: string;
    actorUserId: string;
  }): Promise<void>;
  createUpload(input: DeveloperModuleArtifactUploadRecord): Promise<void>;
  getUpload(
    accountId: string,
    uploadId: string,
  ): Promise<DeveloperModuleArtifactUploadRecord | null>;
  setUploadState(input: {
    accountId: string;
    uploadId: string;
    from: readonly DeveloperArtifactUploadState[];
    to: DeveloperArtifactUploadState;
    updatedAt: string;
  }): Promise<boolean>;
  createArtifact(input: DeveloperModuleArtifactRecord): Promise<DeveloperModuleArtifactRecord>;
  finalizeUpload(input: {
    accountId: string;
    uploadId: string;
    artifact: DeveloperModuleArtifactRecord;
    updatedAt: string;
  }): Promise<DeveloperModuleArtifactRecord>;
  getArtifact(accountId: string, artifactId: string): Promise<DeveloperModuleArtifactRecord | null>;
  listArtifacts(accountId: string): Promise<readonly DeveloperModuleArtifactRecord[]>;
}

export class DeveloperModuleArtifactError extends Error {
  constructor(
    readonly code:
      | 'DEVELOPER_ARTIFACT_INVALID'
      | 'DEVELOPER_ARTIFACT_PUBLISHER_MISMATCH'
      | 'DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT'
      | 'DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND'
      | 'DEVELOPER_ARTIFACT_UPLOAD_EXPIRED'
      | 'DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID'
      | 'DEVELOPER_ARTIFACT_SIZE_MISMATCH'
      | 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH'
      | 'DEVELOPER_ARTIFACT_NOT_FOUND'
      | 'DEVELOPER_ARTIFACT_STORE_UNAVAILABLE'
      | 'DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED',
    readonly status: 400 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'DeveloperModuleArtifactError';
  }
}

export interface DeveloperModuleArtifactPackageInput {
  item: RegistryItem;
  files?: ResolvedRegistryModuleFile[];
  lockGraph?: RegistryModuleLockGraph | null;
  source?: RegistryModuleSourceProvenance | null;
}

interface DeveloperModuleArtifactPackageV2 {
  formatVersion: 2;
  mediaType: typeof DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE;
  item: RegistryItem;
  files: Array<{
    path: string;
    target: string;
    mediaType: string;
    bytes: `base64:${string}`;
    kind?: ResolvedRegistryModuleFile['kind'];
  }>;
  lockGraph: RegistryModuleLockGraph | null;
  source: RegistryModuleSourceProvenance | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PUBLISHER_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite package number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry);
    }
    return result;
  }
  throw new TypeError('Unsupported package value');
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function serializeDeveloperModuleArtifactPackage(
  input: DeveloperModuleArtifactPackageInput,
): Uint8Array {
  const payload: DeveloperModuleArtifactPackageV2 = {
    formatVersion: 2,
    mediaType: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
    item: structuredClone(input.item),
    files: (input.files ?? []).map((file) => ({
      path: file.path,
      target: file.target,
      mediaType: file.mediaType,
      bytes: `base64:${Buffer.from(file.bytes).toString('base64')}`,
      ...(file.kind === undefined ? {} : { kind: file.kind }),
    })),
    lockGraph: structuredClone(input.lockGraph ?? null),
    source: structuredClone(input.source ?? null),
  };
  return canonicalBytes(payload);
}

function parsePackage(bytes: Uint8Array): DeveloperModuleArtifactPackageInput {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
  }
  const object = value as Record<string, unknown>;
  if (
    !exactKeys(object, ['files', 'formatVersion', 'item', 'lockGraph', 'mediaType', 'source']) ||
    object.formatVersion !== 2 ||
    object.mediaType !== DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE ||
    !object.item ||
    typeof object.item !== 'object' ||
    Array.isArray(object.item) ||
    !Array.isArray(object.files) ||
    object.files.length > 2_048
  ) {
    throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
  }

  let expandedBytes = 0;
  const files = object.files.map((entry): ResolvedRegistryModuleFile => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    const file = entry as Record<string, unknown>;
    const expectedKeys =
      file.kind === undefined
        ? ['bytes', 'mediaType', 'path', 'target']
        : ['bytes', 'kind', 'mediaType', 'path', 'target'];
    if (
      !exactKeys(file, expectedKeys) ||
      typeof file.path !== 'string' ||
      typeof file.target !== 'string' ||
      typeof file.mediaType !== 'string' ||
      typeof file.bytes !== 'string' ||
      !file.bytes.startsWith('base64:')
    ) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    const encoded = file.bytes.slice('base64:'.length);
    if (!BASE64.test(encoded)) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (Buffer.from(decoded).toString('base64') !== encoded) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    expandedBytes += decoded.byteLength;
    if (expandedBytes > DEVELOPER_ARTIFACT_MAX_UPLOAD_BYTES) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    return {
      path: file.path,
      target: file.target,
      mediaType: file.mediaType,
      bytes: decoded,
      ...(file.kind === undefined ? {} : { kind: file.kind as ResolvedRegistryModuleFile['kind'] }),
    };
  });

  return {
    item: structuredClone(object.item) as RegistryItem,
    files,
    lockGraph: structuredClone(object.lockGraph) as RegistryModuleLockGraph | null,
    source: structuredClone(object.source) as RegistryModuleSourceProvenance | null,
  };
}

async function readAll(
  source: AsyncIterable<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > expectedSize || size > DEVELOPER_ARTIFACT_MAX_UPLOAD_BYTES) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_SIZE_MISMATCH', 400);
    }
    chunks.push(chunk);
  }
  if (size !== expectedSize) {
    throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_SIZE_MISMATCH', 400);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function publicArtifact(record: DeveloperModuleArtifactRecord): DeveloperModuleArtifact {
  const { storage_key: _storageKey, ...artifact } = record;
  return structuredClone(artifact);
}

function artifactRecord(input: {
  accountId: string;
  actorUserId: string;
  storageKey: string;
  size: number;
  envelope: RegistryModuleArtifactEnvelope;
  now: Date;
}): DeveloperModuleArtifactRecord {
  return {
    artifact_id: randomUUID(),
    account_id: input.accountId,
    publisher_id: input.envelope.descriptor.module.publisherId,
    artifact_digest: input.envelope.artifactDigest,
    envelope_digest: input.envelope.descriptorDigest,
    storage_key: input.storageKey,
    media_type: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
    size_bytes: input.size,
    item_snapshot: structuredClone(input.envelope.descriptor.item),
    source_provenance: structuredClone(input.envelope.descriptor.source),
    created_by: input.actorUserId,
    created_at: input.now.toISOString(),
  };
}

function storeUnavailable(): DeveloperModuleArtifactError {
  return new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_STORE_UNAVAILABLE', 503);
}

export class DeveloperModuleArtifactService {
  private readonly now: () => Date;
  private readonly codeModulesEnabled: boolean;
  private readonly trustInfrastructureReady: () => boolean | Promise<boolean>;

  constructor(
    private readonly input: {
      repository: DeveloperModuleArtifactRepository;
      store: DeveloperArtifactStore;
      now?: () => Date;
      codeModulesEnabled?: boolean;
      trustInfrastructureReady?: () => boolean | Promise<boolean>;
    },
  ) {
    this.now = input.now ?? (() => new Date());
    this.codeModulesEnabled = input.codeModulesEnabled ?? false;
    this.trustInfrastructureReady = input.trustInfrastructureReady ?? (() => false);
  }

  private async assertCodeModuleSubmissionEnabled(): Promise<void> {
    if (!this.codeModulesEnabled) {
      throw new DeveloperModuleArtifactError('DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED', 503);
    }
    try {
      if (await this.trustInfrastructureReady()) return;
    } catch {
      // Readiness failures are intentionally indistinguishable from disabled infrastructure.
    }
    throw new DeveloperModuleArtifactError('DEVELOPER_TRUST_INFRASTRUCTURE_DISABLED', 503);
  }

  async createDeclarative(input: {
    accountId: string;
    actorUserId: string;
    item: unknown;
  }): Promise<DeveloperModuleArtifact> {
    let envelope: RegistryModuleArtifactEnvelope;
    try {
      const validation = validateRegistryItem(input.item);
      if (!validation.valid) {
        throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
      }
      envelope = createRegistryModuleArtifactEnvelope({ item: input.item as RegistryItem });
    } catch {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    if (
      envelope.descriptor.module.executionMode !== 'declarative' ||
      envelope.descriptor.blobs.length !== 0
    ) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    await this.input.repository.claimPublisher({
      accountId: input.accountId,
      publisherId: envelope.descriptor.module.publisherId,
      displayName:
        envelope.descriptor.item.module?.publisher.displayName?.trim() ||
        envelope.descriptor.module.publisherId,
      actorUserId: input.actorUserId,
    });
    const bytes = serializeDeveloperModuleArtifactPackage({ item: envelope.descriptor.item });
    let storageKey: string;
    try {
      storageKey = await this.input.store.writeCanonical({
        accountId: input.accountId,
        artifactDigest: envelope.artifactDigest,
        bytes,
        digest: sha256(bytes),
      });
    } catch {
      throw storeUnavailable();
    }
    const record = artifactRecord({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      storageKey,
      size: bytes.byteLength,
      envelope,
      now: this.now(),
    });
    return publicArtifact(await this.input.repository.createArtifact(record));
  }

  async createUpload(input: {
    accountId: string;
    publisherId: string;
    expectedSize: number;
    expectedDigest: `sha256:${string}`;
    actorUserId: string;
  }): Promise<DeveloperModuleArtifactUploadTicket> {
    await this.assertCodeModuleSubmissionEnabled();
    if (
      !PUBLISHER_ID.test(input.publisherId) ||
      !DIGEST.test(input.expectedDigest) ||
      !Number.isSafeInteger(input.expectedSize) ||
      input.expectedSize < 1 ||
      input.expectedSize > DEVELOPER_ARTIFACT_MAX_UPLOAD_BYTES
    ) {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_INVALID', 400);
    }
    await this.input.repository.claimPublisher({
      accountId: input.accountId,
      publisherId: input.publisherId,
      displayName: input.publisherId,
      actorUserId: input.actorUserId,
    });
    const now = this.now();
    const expiresAt = new Date(now.getTime() + DEVELOPER_ARTIFACT_UPLOAD_TTL_MS);
    const uploadId = randomUUID();
    let target: Awaited<ReturnType<DeveloperArtifactStore['createUpload']>>;
    try {
      target = await this.input.store.createUpload({
        accountId: input.accountId,
        uploadId,
        expectedSize: input.expectedSize,
        expectedDigest: input.expectedDigest,
        expiresAt,
      });
    } catch {
      throw storeUnavailable();
    }
    try {
      await this.input.repository.createUpload({
        upload_id: uploadId,
        account_id: input.accountId,
        publisher_id: input.publisherId,
        state: 'created',
        expected_digest: input.expectedDigest,
        expected_size: input.expectedSize,
        staging_storage_key: target.storageKey,
        artifact_id: null,
        expires_at: expiresAt.toISOString(),
        created_by: input.actorUserId,
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      });
    } catch (error) {
      await this.input.store.deleteStaging(target.storageKey).catch(() => undefined);
      throw error;
    }
    return {
      upload_id: uploadId,
      state: 'created',
      expected_digest: input.expectedDigest,
      expected_size: input.expectedSize,
      upload_url: target.uploadUrl,
      headers: { ...target.headers },
      expires_at: expiresAt.toISOString(),
    };
  }

  async finalizeUpload(input: {
    accountId: string;
    uploadId: string;
    actorUserId: string;
  }): Promise<DeveloperModuleArtifact> {
    return (await this.finalizeUploadResult(input)).artifact;
  }

  async finalizeUploadResult(input: {
    accountId: string;
    uploadId: string;
    actorUserId: string;
  }): Promise<DeveloperModuleArtifactFinalization> {
    await this.assertCodeModuleSubmissionEnabled();
    const upload = await this.input.repository.getUpload(input.accountId, input.uploadId);
    if (!upload) throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND', 404);
    if (upload.state === 'finalized' && upload.artifact_id) {
      const existing = await this.input.repository.getArtifact(input.accountId, upload.artifact_id);
      if (existing) return { artifact: publicArtifact(existing), created: false };
    }
    if (upload.state !== 'created' && upload.state !== 'uploaded') {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID', 409);
    }
    const now = this.now();
    if (new Date(upload.expires_at).getTime() <= now.getTime()) {
      await this.input.repository.setUploadState({
        accountId: input.accountId,
        uploadId: input.uploadId,
        from: ['created', 'uploaded'],
        to: 'expired',
        updatedAt: now.toISOString(),
      });
      await this.input.store.deleteStaging(upload.staging_storage_key).catch(() => undefined);
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_EXPIRED', 409);
    }

    let head: { size: number; digest: `sha256:${string}` };
    try {
      head = await this.input.store.headStaging(upload.staging_storage_key);
    } catch {
      throw storeUnavailable();
    }
    if (head.size !== upload.expected_size) {
      return await this.rejectUpload(upload, 'DEVELOPER_ARTIFACT_SIZE_MISMATCH', now);
    }
    if (head.digest !== upload.expected_digest) {
      return await this.rejectUpload(upload, 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH', now);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readAll(
        this.input.store.readStaging(upload.staging_storage_key, {
          maxBytes: upload.expected_size,
        }),
        upload.expected_size,
      );
    } catch (error) {
      if (
        error instanceof DeveloperModuleArtifactError &&
        error.code === 'DEVELOPER_ARTIFACT_SIZE_MISMATCH'
      ) {
        return await this.rejectUpload(upload, error.code, now);
      }
      throw storeUnavailable();
    }
    if (sha256(bytes) !== upload.expected_digest) {
      return await this.rejectUpload(upload, 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH', now);
    }
    let envelope: RegistryModuleArtifactEnvelope;
    try {
      envelope = createRegistryModuleArtifactEnvelope(parsePackage(bytes));
    } catch {
      return await this.rejectUpload(upload, 'DEVELOPER_ARTIFACT_INVALID', now);
    }
    if (envelope.descriptor.module.publisherId !== upload.publisher_id) {
      return await this.rejectUpload(upload, 'DEVELOPER_ARTIFACT_PUBLISHER_MISMATCH', now);
    }

    let storageKey: string;
    try {
      storageKey = await this.input.store.commit({
        stagingKey: upload.staging_storage_key,
        accountId: input.accountId,
        artifactDigest: envelope.artifactDigest,
      });
    } catch {
      throw storeUnavailable();
    }
    const record = artifactRecord({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      storageKey,
      size: bytes.byteLength,
      envelope,
      now,
    });
    const stored = await this.input.repository.finalizeUpload({
      accountId: input.accountId,
      uploadId: input.uploadId,
      artifact: record,
      updatedAt: now.toISOString(),
    });
    await this.input.store.deleteStaging(upload.staging_storage_key).catch(() => undefined);
    return { artifact: publicArtifact(stored), created: true };
  }

  async cancelUpload(input: { accountId: string; uploadId: string }): Promise<void> {
    const upload = await this.input.repository.getUpload(input.accountId, input.uploadId);
    if (!upload) throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND', 404);
    if (upload.state === 'cancelled') return;
    if (upload.state === 'finalized') {
      throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID', 409);
    }
    await this.input.repository.setUploadState({
      accountId: input.accountId,
      uploadId: input.uploadId,
      from: ['created', 'uploaded', 'expired'],
      to: 'cancelled',
      updatedAt: this.now().toISOString(),
    });
    await this.input.store.deleteStaging(upload.staging_storage_key).catch(() => undefined);
  }

  async getArtifact(input: {
    accountId: string;
    artifactId: string;
  }): Promise<DeveloperModuleArtifact> {
    const artifact = await this.input.repository.getArtifact(input.accountId, input.artifactId);
    if (!artifact) throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_NOT_FOUND', 404);
    return publicArtifact(artifact);
  }

  private async rejectUpload(
    upload: DeveloperModuleArtifactUploadRecord,
    code:
      | 'DEVELOPER_ARTIFACT_INVALID'
      | 'DEVELOPER_ARTIFACT_PUBLISHER_MISMATCH'
      | 'DEVELOPER_ARTIFACT_SIZE_MISMATCH'
      | 'DEVELOPER_ARTIFACT_CHECKSUM_MISMATCH',
    now: Date,
  ): Promise<never> {
    await this.input.repository.setUploadState({
      accountId: upload.account_id,
      uploadId: upload.upload_id,
      from: ['created', 'uploaded'],
      to: 'cancelled',
      updatedAt: now.toISOString(),
    });
    await this.input.store.deleteStaging(upload.staging_storage_key).catch(() => undefined);
    throw new DeveloperModuleArtifactError(code, 400);
  }
}

export function createMemoryDeveloperModuleArtifactRepository(input?: {
  now?: () => Date;
}): DeveloperModuleArtifactRepository {
  const uploads = new Map<string, DeveloperModuleArtifactUploadRecord>();
  const artifacts = new Map<string, DeveloperModuleArtifactRecord>();
  const accountDigests = new Map<string, string>();
  const publisherAccounts = new Map<string, string>();
  const now = input?.now ?? (() => new Date());

  return {
    async claimPublisher(input) {
      const existingAccountId = publisherAccounts.get(input.publisherId);
      if (existingAccountId && existingAccountId !== input.accountId) {
        throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_PUBLISHER_CONFLICT', 409);
      }
      publisherAccounts.set(input.publisherId, input.accountId);
    },
    async createUpload(upload) {
      if (uploads.has(upload.upload_id)) throw new Error('duplicate upload');
      uploads.set(upload.upload_id, structuredClone(upload));
    },
    async getUpload(accountId, uploadId) {
      const upload = uploads.get(uploadId);
      return upload?.account_id === accountId ? structuredClone(upload) : null;
    },
    async setUploadState(input) {
      const upload = uploads.get(input.uploadId);
      if (!upload || upload.account_id !== input.accountId || !input.from.includes(upload.state)) {
        return false;
      }
      upload.state = input.to;
      upload.updated_at = input.updatedAt;
      return true;
    },
    async createArtifact(artifact) {
      const key = `${artifact.account_id}\0${artifact.artifact_digest}`;
      const existingId = accountDigests.get(key);
      if (existingId)
        return structuredClone(artifacts.get(existingId) as DeveloperModuleArtifactRecord);
      const copy = { ...structuredClone(artifact), created_at: now().toISOString() };
      artifacts.set(copy.artifact_id, copy);
      accountDigests.set(key, copy.artifact_id);
      return structuredClone(copy);
    },
    async finalizeUpload(input) {
      const upload = uploads.get(input.uploadId);
      if (!upload || upload.account_id !== input.accountId) {
        throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_NOT_FOUND', 404);
      }
      if (upload.state === 'finalized' && upload.artifact_id) {
        const existing = artifacts.get(upload.artifact_id);
        if (existing) return structuredClone(existing);
      }
      if (upload.state !== 'created' && upload.state !== 'uploaded') {
        throw new DeveloperModuleArtifactError('DEVELOPER_ARTIFACT_UPLOAD_STATE_INVALID', 409);
      }
      const artifact = await this.createArtifact(input.artifact);
      upload.state = 'finalized';
      upload.artifact_id = artifact.artifact_id;
      upload.updated_at = input.updatedAt;
      return artifact;
    },
    async getArtifact(accountId, artifactId) {
      const artifact = artifacts.get(artifactId);
      return artifact?.account_id === accountId ? structuredClone(artifact) : null;
    },
    async listArtifacts(accountId) {
      return [...artifacts.values()]
        .filter((artifact) => artifact.account_id === accountId)
        .map((artifact) => structuredClone(artifact));
    },
  };
}

export function createMemoryDeveloperArtifactStore() {
  const uploads = new Map<
    string,
    {
      storageKey: string;
      expectedSize: number;
      expectedDigest: `sha256:${string}`;
      headers: Record<string, string>;
      bytes: Uint8Array | null;
    }
  >();
  const storageKeys = new Map<string, string>();
  const artifacts = new Map<string, Uint8Array>();

  const store: DeveloperArtifactStore = {
    async createUpload(input) {
      const url = `memory://developer-artifacts/${input.uploadId}`;
      const storageKey = `staging/${input.uploadId}`;
      const headers = {
        'content-length': String(input.expectedSize),
        'x-openopc-content-sha256': input.expectedDigest,
      };
      uploads.set(url, {
        storageKey,
        expectedSize: input.expectedSize,
        expectedDigest: input.expectedDigest,
        headers,
        bytes: null,
      });
      storageKeys.set(storageKey, url);
      return { storageKey, uploadUrl: url, headers: { ...headers } };
    },
    async headStaging(storageKey) {
      const url = storageKeys.get(storageKey);
      const entry = url ? uploads.get(url) : null;
      if (!entry?.bytes) throw new Error('missing staging object');
      return { size: entry.bytes.byteLength, digest: sha256(entry.bytes) };
    },
    async *readStaging(storageKey, limits) {
      const url = storageKeys.get(storageKey);
      const entry = url ? uploads.get(url) : null;
      if (!entry?.bytes || entry.bytes.byteLength > limits.maxBytes) {
        throw new Error('missing or oversized staging object');
      }
      yield entry.bytes.slice();
    },
    async commit(input) {
      const url = storageKeys.get(input.stagingKey);
      const entry = url ? uploads.get(url) : null;
      if (!entry?.bytes) throw new Error('missing staging object');
      const key = `artifacts/${input.accountId}/${input.artifactDigest.slice('sha256:'.length)}`;
      artifacts.set(key, entry.bytes.slice());
      return key;
    },
    async writeCanonical(input) {
      if (sha256(input.bytes) !== input.digest) throw new Error('checksum mismatch');
      const key = `artifacts/${input.accountId}/${input.artifactDigest.slice('sha256:'.length)}`;
      artifacts.set(key, input.bytes.slice());
      return key;
    },
    async deleteStaging(storageKey) {
      const url = storageKeys.get(storageKey);
      if (!url) return;
      storageKeys.delete(storageKey);
      uploads.delete(url);
    },
  };

  return {
    store,
    async upload(
      url: string,
      bytes: Uint8Array,
      headers: Record<string, string>,
      options?: { skipChecksum?: boolean },
    ) {
      const entry = uploads.get(url);
      if (!entry) throw new Error('unknown upload url');
      if (JSON.stringify(headers) !== JSON.stringify(entry.headers))
        throw new Error('header mismatch');
      if (bytes.byteLength !== entry.expectedSize) throw new Error('size mismatch');
      if (!options?.skipChecksum && sha256(bytes) !== entry.expectedDigest) {
        throw new Error('checksum mismatch');
      }
      entry.bytes = bytes.slice();
    },
    hasUpload(url: string) {
      return uploads.has(url);
    },
  };
}
