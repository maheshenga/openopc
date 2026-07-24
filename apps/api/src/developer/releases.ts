import { createHash, randomUUID } from 'node:crypto';
import {
  type RegistryModuleManifest,
  readRegistryModuleManifest,
  validateRegistryItem,
} from '@kortix/registry';

export const DEVELOPER_MODULE_RELEASE_STATUSES = [
  'validated',
  'review_pending',
  'changes_requested',
  'approved',
  'signed',
  'published',
  'revoked',
  'deprecated',
] as const;

export type DeveloperModuleReleaseStatus = (typeof DEVELOPER_MODULE_RELEASE_STATUSES)[number];

export const DEVELOPER_MODULE_REVIEW_REQUIREMENTS = [
  'manifest_review',
  'source_scan',
  'sandbox_test',
  'permission_review',
  'desktop_security_review',
  'human_review',
] as const;

export type DeveloperModuleReviewRequirement =
  (typeof DEVELOPER_MODULE_REVIEW_REQUIREMENTS)[number];

export interface DeveloperModuleRelease {
  release_id: string;
  account_id: string;
  item_name: string;
  publisher_id: string;
  module_id: string;
  module_version: string;
  manifest: RegistryModuleManifest;
  manifest_digest: `sha256:${string}`;
  review_requirements: DeveloperModuleReviewRequirement[];
  status: DeveloperModuleReleaseStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface DeveloperModuleReleaseInsert {
  accountId: string;
  actorUserId: string;
  itemName: string;
  manifest: RegistryModuleManifest;
  manifestDigest: `sha256:${string}`;
  reviewRequirements: DeveloperModuleReviewRequirement[];
}

export interface DeveloperModuleReleaseRepository {
  submit(
    input: DeveloperModuleReleaseInsert,
  ): Promise<{ release: DeveloperModuleRelease; created: boolean }>;
  list(accountId: string, limit: number): Promise<readonly DeveloperModuleRelease[]>;
  get(accountId: string, releaseId: string): Promise<DeveloperModuleRelease | null>;
}

export class DeveloperModuleReleaseError extends Error {
  constructor(
    readonly code:
      | 'DEVELOPER_MODULE_INVALID'
      | 'DEVELOPER_PUBLISHER_MISMATCH'
      | 'DEVELOPER_PUBLISHER_CONFLICT'
      | 'DEVELOPER_MODULE_VERSION_CONFLICT'
      | 'DEVELOPER_RELEASE_NOT_FOUND',
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = 'DeveloperModuleReleaseError';
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON only supports finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('Canonical JSON only supports JSON values');
}

export function canonicalDeveloperModuleManifestDigest(
  manifest: RegistryModuleManifest,
): `sha256:${string}` {
  const digest = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
  return `sha256:${digest}`;
}

function reviewRequirements(manifest: RegistryModuleManifest): DeveloperModuleReviewRequirement[] {
  const requirements: DeveloperModuleReviewRequirement[] = ['manifest_review', 'source_scan'];
  if (manifest.execution.mode !== 'declarative' || (manifest.ui?.length ?? 0) > 0) {
    requirements.push('sandbox_test');
  }
  const hasPermissions = Object.values(manifest.permissions ?? {}).some(
    (values) => values !== undefined && values.length > 0,
  );
  if (hasPermissions) requirements.push('permission_review');
  if (
    manifest.execution.mode === 'desktop-native' ||
    (manifest.permissions?.desktop?.length ?? 0) > 0
  ) {
    requirements.push('desktop_security_review');
  }
  requirements.push('human_review');
  return requirements;
}

export class DeveloperModuleReleaseService {
  constructor(
    private readonly input: {
      repository: DeveloperModuleReleaseRepository;
    },
  ) {}

  async submit(input: {
    accountId: string;
    actorUserId: string;
    item: unknown;
  }): Promise<{ release: DeveloperModuleRelease; created: boolean }> {
    const validation = validateRegistryItem(input.item);
    const manifest = readRegistryModuleManifest(input.item);
    const itemName =
      typeof input.item === 'object' && input.item !== null && !Array.isArray(input.item)
        ? (input.item as Record<string, unknown>).name
        : null;
    if (!validation.valid || !manifest || typeof itemName !== 'string') {
      throw new DeveloperModuleReleaseError('DEVELOPER_MODULE_INVALID', 400);
    }
    if (!manifest.id.startsWith(`${manifest.publisher.id}.`)) {
      throw new DeveloperModuleReleaseError('DEVELOPER_PUBLISHER_MISMATCH', 400);
    }

    return await this.input.repository.submit({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      itemName,
      manifest,
      manifestDigest: canonicalDeveloperModuleManifestDigest(manifest),
      reviewRequirements: reviewRequirements(manifest),
    });
  }

  list(input: {
    accountId: string;
    limit?: number;
  }): Promise<readonly DeveloperModuleRelease[]> {
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100);
    return this.input.repository.list(input.accountId, limit);
  }

  async get(input: { accountId: string; releaseId: string }): Promise<DeveloperModuleRelease> {
    const release = await this.input.repository.get(input.accountId, input.releaseId);
    if (!release) throw new DeveloperModuleReleaseError('DEVELOPER_RELEASE_NOT_FOUND', 404);
    return release;
  }
}

export function createMemoryDeveloperModuleReleaseRepository(input?: {
  now?: () => Date;
}): DeveloperModuleReleaseRepository {
  const now = input?.now ?? (() => new Date());
  const releases = new Map<string, DeveloperModuleRelease>();
  const publisherAccounts = new Map<string, string>();
  const releaseVersions = new Map<string, string>();

  return {
    async submit(submission) {
      const publisherId = submission.manifest.publisher.id;
      const publisherAccountId = publisherAccounts.get(publisherId);
      if (publisherAccountId && publisherAccountId !== submission.accountId) {
        throw new DeveloperModuleReleaseError('DEVELOPER_PUBLISHER_CONFLICT', 409);
      }

      const versionKey = `${submission.manifest.id}\0${submission.manifest.version}`;
      const existingReleaseId = releaseVersions.get(versionKey);
      if (existingReleaseId) {
        const existing = releases.get(existingReleaseId);
        if (
          !existing ||
          existing.account_id !== submission.accountId ||
          existing.manifest_digest !== submission.manifestDigest
        ) {
          throw new DeveloperModuleReleaseError('DEVELOPER_MODULE_VERSION_CONFLICT', 409);
        }
        return { release: structuredClone(existing), created: false };
      }

      const createdAt = now().toISOString();
      const release: DeveloperModuleRelease = {
        release_id: randomUUID(),
        account_id: submission.accountId,
        item_name: submission.itemName,
        publisher_id: submission.manifest.publisher.id,
        module_id: submission.manifest.id,
        module_version: submission.manifest.version,
        manifest: structuredClone(submission.manifest),
        manifest_digest: submission.manifestDigest,
        review_requirements: [...submission.reviewRequirements],
        status: 'validated',
        created_by: submission.actorUserId,
        created_at: createdAt,
        updated_at: createdAt,
      };
      publisherAccounts.set(publisherId, submission.accountId);
      releases.set(release.release_id, structuredClone(release));
      releaseVersions.set(versionKey, release.release_id);
      return { release: structuredClone(release), created: true };
    },
    async list(accountId, limit) {
      return [...releases.values()]
        .filter((release) => release.account_id === accountId)
        .sort(
          (left, right) =>
            right.created_at.localeCompare(left.created_at) ||
            right.release_id.localeCompare(left.release_id),
        )
        .slice(0, limit)
        .map((release) => structuredClone(release));
    },
    async get(accountId, releaseId) {
      const release = releases.get(releaseId);
      return release?.account_id === accountId ? structuredClone(release) : null;
    },
  };
}
