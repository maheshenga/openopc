import type { RegistryItem } from './schema';

export const REGISTRY_CAPABILITY_KEYS = [
  'secrets',
  'connectors',
  'network',
  'tools',
  'writes',
  'required_runtime',
] as const;

export type RegistryCapabilityKey = (typeof REGISTRY_CAPABILITY_KEYS)[number];

export interface RegistryCapabilityDeclaration {
  secrets: string[];
  connectors: string[];
  network: string[];
  tools: string[];
  writes: string[];
  required_runtime: string[];
}

const capabilityKeySet = new Set<string>(REGISTRY_CAPABILITY_KEYS);

/**
 * Read only the optional `meta.capabilities` declaration from an item.
 * External registry metadata is untrusted, so malformed declarations fail
 * closed and are never merged with envVars or inferred marketplace hints.
 */
export function readRegistryCapabilities(item: RegistryItem): RegistryCapabilityDeclaration | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const meta = item.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  if (!Object.prototype.hasOwnProperty.call(meta, 'capabilities')) return null;

  const raw = meta.capabilities;
  if (!isRecord(raw)) return null;
  if (Object.keys(raw).some((key) => !capabilityKeySet.has(key))) return null;

  const result: RegistryCapabilityDeclaration = {
    secrets: [],
    connectors: [],
    network: [],
    tools: [],
    writes: [],
    required_runtime: [],
  };

  for (const key of REGISTRY_CAPABILITY_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return null;

    const normalized: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string') return null;
      const token = entry.trim();
      if (!isSafeCapabilityToken(token, key)) return null;
      normalized.push(token);
    }
    result[key] = [...new Set(normalized)].sort(compareStrings);
  }

  return result;
}

function isSafeCapabilityToken(value: string, key: RegistryCapabilityKey): boolean {
  if (
    !value ||
    value.length > 256 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return false;
  }
  if (key === 'secrets' && (/\s/.test(value) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(value))) {
    return false;
  }

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) return false;
      if (key === 'network' && (parsed.search || parsed.hash)) return false;
    } catch {
      return false;
    }
  }

  if (/:([^/\s]*)@/.test(value)) return false;

  return true;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
