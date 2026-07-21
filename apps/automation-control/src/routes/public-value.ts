const PrivateKeyPattern =
  /^(?:worker[_-]?url|credential(?:[_-]?(?:ref|reference))?|internal[_-]?(?:error|payload)|provider[_-]?(?:request|response|payload)|screenshot|headers?|authorization|cookie|password|token|secret|api[_-]?key|signature|stack)$/i;
const CredentialReferencePattern = /credential-ref:[0-9a-f-]{36}/i;
const SignedQueryKeyPattern =
  /(?:credential|signature|token|secret|api[-_]?key|password|session|authorization|cookie)/i;

function publicString(value: string): string | null {
  if (CredentialReferencePattern.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      [...url.searchParams.keys()].some((key) => SignedQueryKeyPattern.test(key))
    ) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    return value;
  }
  return value;
}

export function toPublicAutomationValue(value: unknown): unknown {
  if (typeof value === 'string') return publicString(value);
  if (Array.isArray(value)) {
    return value
      .map((entry) => toPublicAutomationValue(entry))
      .filter((entry) => entry !== null && entry !== undefined);
  }
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (PrivateKeyPattern.test(key)) continue;
    const safe = toPublicAutomationValue(entry);
    if (safe !== null && safe !== undefined) output[key] = safe;
  }
  return output;
}
