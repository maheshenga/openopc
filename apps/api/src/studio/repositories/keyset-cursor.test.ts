import { describe, expect, test } from 'bun:test';

import { decodeStudioKeysetCursor, encodeStudioKeysetCursor } from './keyset-cursor';

const CREATED_AT = '2026-08-08T08:00:00.000Z';
const JOB_ID = '80000000-0000-4000-a000-000000000001';

describe('Studio keyset cursors', () => {
  test('round-trips a versioned created_at and id tuple without exposing its JSON wire form', () => {
    const cursor = encodeStudioKeysetCursor({ createdAt: CREATED_AT, id: JOB_ID });

    expect(cursor).not.toContain(CREATED_AT);
    expect(cursor).not.toContain(JOB_ID);
    expect(decodeStudioKeysetCursor(cursor)).toEqual({
      createdAt: CREATED_AT,
      id: JOB_ID,
    });
  });

  test('accepts a legacy timestamp cursor during rollout', () => {
    expect(decodeStudioKeysetCursor(CREATED_AT)).toEqual({
      createdAt: CREATED_AT,
      id: null,
    });
  });

  test('rejects malformed or oversized cursors before they reach SQL', () => {
    for (const cursor of ['', 'not-a-timestamp', 'e30', 'x'.repeat(2049)]) {
      expect(() => decodeStudioKeysetCursor(cursor)).toThrow('Studio keyset cursor is invalid');
    }
  });
});
