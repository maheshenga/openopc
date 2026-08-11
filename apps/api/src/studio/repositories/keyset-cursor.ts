export type StudioKeysetCursor = { createdAt: string; id: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 2_048;

export class StudioKeysetCursorError extends Error {
  constructor() {
    super('Studio keyset cursor is invalid');
    this.name = 'StudioKeysetCursorError';
  }
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function encodeStudioKeysetCursor(input: { createdAt: string; id: string }): string {
  const createdAt = normalizedTimestamp(input.createdAt);
  if (!createdAt || !UUID_RE.test(input.id)) throw new StudioKeysetCursorError();
  const encoded = Buffer.from(
    JSON.stringify({ v: 1, created_at: createdAt, id: input.id }),
    'utf8',
  ).toString('base64url');
  if (encoded.length > MAX_CURSOR_LENGTH) throw new StudioKeysetCursorError();
  return encoded;
}

export function decodeStudioKeysetCursor(cursor: string): StudioKeysetCursor {
  if (typeof cursor !== 'string' || cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new StudioKeysetCursorError();
  }
  const legacy = normalizedTimestamp(cursor);
  if (legacy) return { createdAt: legacy, id: null };
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).sort().join(',') === 'created_at,id,v'
    ) {
      const record = parsed as Record<string, unknown>;
      const createdAt = normalizedTimestamp(record.created_at);
      if (record.v === 1 && createdAt && typeof record.id === 'string' && UUID_RE.test(record.id)) {
        return { createdAt, id: record.id };
      }
    }
  } catch {
    // Fall through to the stable protocol error.
  }
  throw new StudioKeysetCursorError();
}
