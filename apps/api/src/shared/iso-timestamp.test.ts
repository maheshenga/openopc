import { expect, test } from 'bun:test';

import { isoTimestamp, nullableIsoTimestamp } from './iso-timestamp';

test('normalizes PostgreSQL timestamp strings to strict ISO 8601', () => {
  expect(isoTimestamp('2026-08-01 00:00:00+00')).toBe('2026-08-01T00:00:00.000Z');
  expect(isoTimestamp('2026-08-01 08:00:00+08')).toBe('2026-08-01T00:00:00.000Z');
});

test('rejects invalid required timestamps and preserves nullable fields', () => {
  expect(() => isoTimestamp('not-a-timestamp')).toThrow('Invalid timestamp');
  expect(nullableIsoTimestamp(null)).toBeNull();
});
