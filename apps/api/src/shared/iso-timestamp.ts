export function isoTimestamp(value: unknown, fieldName = 'timestamp'): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (value === null || value === undefined || Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid ${fieldName}`);
  }
  return date.toISOString();
}

export function nullableIsoTimestamp(value: unknown, fieldName = 'timestamp'): string | null {
  if (value === null || value === undefined) return null;
  return isoTimestamp(value, fieldName);
}
