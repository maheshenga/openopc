import { describe, expect, test } from 'bun:test';
import { parseOptionalSeed } from './image-input';

describe('parseOptionalSeed', () => {
  test('accepts blank and safe non-negative integers', () => {
    expect(parseOptionalSeed('')).toBeUndefined();
    expect(parseOptionalSeed(' 42 ')).toBe(42);
    expect(parseOptionalSeed(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects negative, fractional, and unsafe values', () => {
    expect(parseOptionalSeed('-1')).toBeNull();
    expect(parseOptionalSeed('1.5')).toBeNull();
    expect(parseOptionalSeed('9007199254740992')).toBeNull();
  });
});
