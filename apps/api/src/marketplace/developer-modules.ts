import { moduleCatalogLabels } from '@kortix/registry';
import {
  assertReleaseRuntimeAllowed,
  type DeveloperModuleDistributionService,
} from '../developer/distribution';
import type { DeveloperModuleRelease } from '../developer/releases';
import { loadRuntimeReleaseProfile } from '../release-profile/runtime';

export const OPENOPC_MODULE_MARKETPLACE_ID = 'openopc-modules';
export const OPENOPC_MODULE_MARKETPLACE_LABEL = 'OpenOPC Modules';
export const OPENOPC_MODULE_ITEM_PREFIX = 'openopc-module:';

export interface DeveloperModuleMarketplaceItem {
  id: string;
  registry: typeof OPENOPC_MODULE_MARKETPLACE_ID;
  name: string;
  type: 'registry:module';
  title: string;
  description: string | null;
  categories: string[];
  capabilities: {
    secrets: string[];
    connectors: string[];
    tools: string[];
    network: string[];
  };
  dependencies: string[];
  fileCount: 0;
  external: false;
  marketplaceId: typeof OPENOPC_MODULE_MARKETPLACE_ID;
  marketplaceLabel: typeof OPENOPC_MODULE_MARKETPLACE_LABEL;
  owner: string;
  release_id: string;
  module_id: string;
  module_version: string;
  publisher_id: string;
}

export interface DeveloperModuleMarketplaceDetail extends DeveloperModuleMarketplaceItem {
  files: [];
  readme: null;
  dependencyItems: [];
  manifest: DeveloperModuleRelease['manifest'];
  permissions: NonNullable<DeveloperModuleRelease['manifest']['permissions']>;
  signature: {
    algorithm: 'ed25519';
    key_id: string;
    payload_digest: `sha256:${string}`;
    signed_at: string;
  };
}

export interface DeveloperModuleMarketplaceSource {
  listPublished(input: {
    query?: string;
    limit: number;
    offset: number;
  }): Promise<{ releases: readonly DeveloperModuleRelease[]; total: number }>;
  getPublished(input: { releaseId: string }): Promise<DeveloperModuleRelease>;
}

export interface DeveloperModuleMarketplaceAdapter {
  list(input: {
    query?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: DeveloperModuleMarketplaceItem[]; total: number }>;
  get(id: string): Promise<DeveloperModuleMarketplaceDetail | null>;
  getFile(id: string, path: string): Promise<null>;
}

let registeredAdapter: DeveloperModuleMarketplaceAdapter | null = null;

type DistributionSource = Pick<
  DeveloperModuleDistributionService,
  'listPublished' | 'getPublished'
>;

type PublicDeveloperModuleRelease = DeveloperModuleRelease & {
  signature_algorithm: 'ed25519';
  signature_key_id: string;
  signature: `base64url:${string}`;
  signature_payload_digest: `sha256:${string}`;
  signed_at: string;
};

function isPublicMarketplaceRelease(
  release: DeveloperModuleRelease,
): release is PublicDeveloperModuleRelease {
  if (
    release.status === 'published' &&
    release.signature_algorithm === 'ed25519' &&
    release.signature_key_id !== null &&
    release.signature !== null &&
    release.signature_payload_digest !== null &&
    release.signed_at !== null &&
    ['declarative', 'sandboxed-web', 'server-adapter'].includes(release.manifest.execution.mode)
  ) {
    try {
      assertReleaseRuntimeAllowed(release, loadRuntimeReleaseProfile());
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function itemId(releaseId: string): string {
  return `${OPENOPC_MODULE_ITEM_PREFIX}${releaseId}`;
}

function releaseIdFromItemId(id: string): string | null {
  return id.startsWith(OPENOPC_MODULE_ITEM_PREFIX)
    ? id.slice(OPENOPC_MODULE_ITEM_PREFIX.length) || null
    : null;
}

function capabilitiesOf(
  release: DeveloperModuleRelease,
): DeveloperModuleMarketplaceItem['capabilities'] {
  const permissions = release.manifest.permissions ?? {};
  return {
    secrets: [...(permissions.secrets ?? [])],
    connectors: [...(permissions.connectors ?? [])],
    tools: [...(permissions.tools ?? [])],
    network: [...(permissions.network ?? [])],
  };
}

function itemOf(release: DeveloperModuleRelease): DeveloperModuleMarketplaceItem {
  return {
    id: itemId(release.release_id),
    registry: OPENOPC_MODULE_MARKETPLACE_ID,
    name: release.item_name,
    type: 'registry:module',
    title: release.item_name,
    description: null,
    categories: moduleCatalogLabels(release.manifest),
    capabilities: capabilitiesOf(release),
    dependencies: [],
    fileCount: 0,
    external: false,
    marketplaceId: OPENOPC_MODULE_MARKETPLACE_ID,
    marketplaceLabel: OPENOPC_MODULE_MARKETPLACE_LABEL,
    owner: release.publisher_id,
    release_id: release.release_id,
    module_id: release.module_id,
    module_version: release.module_version,
    publisher_id: release.publisher_id,
  };
}

function matchesQuery(item: DeveloperModuleMarketplaceItem, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return true;
  return `${item.name} ${item.title} ${item.module_id} ${item.publisher_id} ${item.categories.join(' ')}`
    .toLowerCase()
    .includes(normalized);
}

function detailOf(release: PublicDeveloperModuleRelease): DeveloperModuleMarketplaceDetail {
  return {
    ...itemOf(release),
    files: [],
    readme: null,
    dependencyItems: [],
    manifest: structuredClone(release.manifest),
    permissions: structuredClone(release.manifest.permissions ?? {}),
    signature: {
      algorithm: 'ed25519',
      key_id: release.signature_key_id,
      payload_digest: release.signature_payload_digest,
      signed_at: release.signed_at,
    },
  };
}

export function createDeveloperModuleMarketplaceAdapter(
  source: DistributionSource | null,
): DeveloperModuleMarketplaceAdapter {
  return {
    async list(input) {
      if (!source) return { items: [], total: 0 };
      const page = await source.listPublished({
        query: input.query,
        limit: Math.min(Math.max(Math.trunc(input.limit), 1), 200),
        offset: Math.max(Math.trunc(input.offset), 0),
      });
      const items = page.releases
        .filter(isPublicMarketplaceRelease)
        .map(itemOf)
        .filter((item) => matchesQuery(item, input.query))
        .sort((left, right) => left.id.localeCompare(right.id));
      return { items, total: items.length };
    },

    async get(id) {
      if (!source) return null;
      const releaseId = releaseIdFromItemId(id);
      if (!releaseId) return null;
      try {
        const release = await source.getPublished({ releaseId });
        return isPublicMarketplaceRelease(release) ? detailOf(release) : null;
      } catch {
        return null;
      }
    },

    async getFile(id, _path) {
      if (!source || !releaseIdFromItemId(id)) return null;
      return null;
    },
  };
}

export function registerDeveloperModuleMarketplaceSource(source: DistributionSource | null): void {
  registeredAdapter = createDeveloperModuleMarketplaceAdapter(source);
}

export function getDeveloperModuleMarketplaceAdapter(): DeveloperModuleMarketplaceAdapter {
  return registeredAdapter ?? createDeveloperModuleMarketplaceAdapter(null);
}
