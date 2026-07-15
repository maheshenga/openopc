export class StudioIdempotencyMismatchError extends Error {
  readonly code = 'STUDIO_IDEMPOTENCY_MISMATCH';

  constructor() {
    super('STUDIO_IDEMPOTENCY_MISMATCH');
    this.name = 'StudioIdempotencyMismatchError';
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalStudioRequestJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalStudioRequestHash(value: unknown): string {
  const json = canonicalStudioRequestJson(value);
  const digest = new Bun.CryptoHasher('sha256').update(json).digest('hex');
  return `sha256:${digest}`;
}

export function assertMatchingIdempotencyHash(expectedHash: string, value: unknown): void {
  if (canonicalStudioRequestHash(value) !== expectedHash) {
    throw new StudioIdempotencyMismatchError();
  }
}
