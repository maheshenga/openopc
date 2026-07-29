import { createHash } from 'node:crypto';

export type PublicBetaSha256Digest = `sha256:${string}`;
export type PublicBetaJson =
  | null
  | boolean
  | number
  | string
  | PublicBetaJson[]
  | { [key: string]: PublicBetaJson };

const INVALID_CANONICAL_JSON = 'PUBLIC_BETA_CANONICAL_JSON_INVALID';

function fail(): never {
  throw new Error(INVALID_CANONICAL_JSON);
}

function validUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function serializeString(value: string): string {
  if (!validUnicode(value)) fail();
  return JSON.stringify(value);
}

function serializeArray(value: unknown[], active: Set<object>): string {
  const ownNames = Object.getOwnPropertyNames(value);
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    ownNames.length !== value.length + 1 ||
    ownNames.some((name) => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(name)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail();
  }

  const items: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
    items.push(serialize(descriptor.value, active));
  }
  return `[${items.join(',')}]`;
}

function serializeObject(value: object, active: Set<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    fail();
  }

  const entries = Object.getOwnPropertyNames(value)
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) fail();
      return [key, descriptor.value] as const;
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries
    .map(([key, entry]) => `${serializeString(key)}:${serialize(entry, active)}`)
    .join(',')}}`;
}

function serialize(value: unknown, active: Set<object>): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return serializeString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object' || active.has(value)) fail();

  active.add(value);
  try {
    return Array.isArray(value) ? serializeArray(value, active) : serializeObject(value, active);
  } finally {
    active.delete(value);
  }
}

export function canonicalPublicBetaJson(value: unknown): string {
  try {
    return serialize(value, new Set());
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_CANONICAL_JSON) throw error;
    fail();
  }
}

export function encodeCanonicalPublicBetaJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalPublicBetaJson(value));
}

export function computePublicBetaSha256(value: string | Uint8Array): PublicBetaSha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function computeCanonicalPublicBetaDigest(value: unknown): PublicBetaSha256Digest {
  return computePublicBetaSha256(encodeCanonicalPublicBetaJson(value));
}
