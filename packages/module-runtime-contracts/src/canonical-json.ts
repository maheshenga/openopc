import type { Sha256Digest } from './work-envelope';

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error('CANONICAL_JSON_INVALID');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('CANONICAL_JSON_INVALID');
    }
  }
}

function encodeCanonicalJson(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_JSON_INVALID');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('CANONICAL_JSON_INVALID');
  if (ancestors.has(value)) throw new Error('CANONICAL_JSON_INVALID');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error('CANONICAL_JSON_INVALID');
        items.push(encodeCanonicalJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('CANONICAL_JSON_INVALID');
    }
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        assertValidUnicode(key);
        return `${JSON.stringify(key)}:${encodeCanonicalJson(record[key], ancestors)}`;
      });
    return `{${entries.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function canonicalDigest(value: unknown): Promise<Sha256Digest> {
  const bytes = new TextEncoder().encode(encodeCanonicalJson(value, new WeakSet()));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `sha256:${hex}`;
}
