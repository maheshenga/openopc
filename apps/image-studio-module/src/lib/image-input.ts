export function parseOptionalSeed(value: string): number | undefined | null {
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
