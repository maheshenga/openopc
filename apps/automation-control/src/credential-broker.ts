import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const UuidSchema = z.string().uuid();
const ActionHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const CredentialReferenceSchema = z
  .string()
  .regex(/^credential-ref:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
const MaxCredentialReferenceTtlMs = 5 * 60 * 1000;

const CredentialLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project_secret'), locatorId: UuidSchema }).strict(),
  z.object({ kind: z.literal('connector'), locatorId: UuidSchema }).strict(),
]);

export type CredentialLocator = z.infer<typeof CredentialLocatorSchema>;

export type CredentialReference = Readonly<{
  reference: `credential-ref:${string}`;
  expiresAt: string;
}>;

export type CredentialBrokerIssueInput = Readonly<{
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  locator: CredentialLocator;
  ttlMs: number;
}>;

export type CredentialBrokerResolveInput = Readonly<{
  reference: string;
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
}>;

export interface CredentialBroker {
  issue(input: CredentialBrokerIssueInput): Promise<CredentialReference>;
  resolve(input: CredentialBrokerResolveInput): Promise<CredentialLocator | null>;
}

export type CredentialBrokerErrorCode = 'AUTOMATION_INVALID_REQUEST';

export class AutomationCredentialBrokerError extends Error {
  constructor(
    readonly code: CredentialBrokerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationCredentialBrokerError';
  }
}

export type StoredCredentialReference = Readonly<{
  reference: `credential-ref:${string}`;
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  locator: CredentialLocator;
  expiresAt: string;
  consumedAt: string | null;
}>;

export class MemoryCredentialReferenceStore {
  readonly #records = new Map<string, StoredCredentialReference>();

  get(reference: string): StoredCredentialReference | undefined {
    return this.#records.get(reference);
  }

  set(record: StoredCredentialReference): void {
    this.#records.set(record.reference, record);
  }

  consume(reference: string, consumedAt: string): StoredCredentialReference | null {
    const record = this.#records.get(reference);
    if (!record || record.consumedAt !== null) return null;
    const consumed = { ...record, consumedAt };
    this.#records.set(reference, consumed);
    return consumed;
  }

  snapshot(): readonly Readonly<StoredCredentialReference>[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export function createMemoryCredentialReferenceStore(): MemoryCredentialReferenceStore {
  return new MemoryCredentialReferenceStore();
}

function validatedIssueInput(input: CredentialBrokerIssueInput): CredentialBrokerIssueInput {
  const parsed = z
    .object({
      accountId: UuidSchema,
      projectId: UuidSchema,
      jobId: UuidSchema,
      stepId: UuidSchema,
      actionHash: ActionHashSchema,
      locator: CredentialLocatorSchema,
      ttlMs: z.number().int().positive().max(MaxCredentialReferenceTtlMs),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success) {
    throw new AutomationCredentialBrokerError(
      'AUTOMATION_INVALID_REQUEST',
      'Credential reference request is invalid or exceeds the five-minute lifetime',
    );
  }
  return parsed.data as CredentialBrokerIssueInput;
}

function inputMatchesRecord(
  input: CredentialBrokerResolveInput,
  record: StoredCredentialReference,
): boolean {
  return (
    input.accountId === record.accountId &&
    input.projectId === record.projectId &&
    input.jobId === record.jobId &&
    input.stepId === record.stepId &&
    input.actionHash === record.actionHash
  );
}

export function createMemoryCredentialBroker(options?: {
  store?: MemoryCredentialReferenceStore;
  now?: () => Date;
}): CredentialBroker {
  const store = options?.store ?? createMemoryCredentialReferenceStore();
  const now = options?.now ?? (() => new Date());

  return {
    async issue(issueInput) {
      const input = validatedIssueInput(issueInput);
      const createdAt = now();
      const reference = `credential-ref:${randomUUID()}` as const;
      const expiresAt = new Date(createdAt.getTime() + input.ttlMs).toISOString();
      store.set({
        reference,
        accountId: input.accountId,
        projectId: input.projectId,
        jobId: input.jobId,
        stepId: input.stepId,
        actionHash: input.actionHash,
        locator: structuredClone(input.locator),
        expiresAt,
        consumedAt: null,
      });
      return { reference, expiresAt };
    },

    async resolve(input) {
      if (!CredentialReferenceSchema.safeParse(input.reference).success) return null;
      const record = store.get(input.reference);
      if (
        !record ||
        record.consumedAt !== null ||
        Date.parse(record.expiresAt) <= now().getTime() ||
        !inputMatchesRecord(input, record)
      ) {
        return null;
      }
      const consumed = store.consume(record.reference, now().toISOString());
      return consumed ? structuredClone(consumed.locator) : null;
    },
  };
}

const SensitiveKeyPattern =
  /(?:authorization|cookie|password|token|secret|api[-_]?key|credential|signature|session)/i;
const CredentialReferencePattern = /credential-ref:[0-9a-f-]{36}/i;
const InlineSecretPattern =
  /(?:bearer|basic)\s+\S+|(?:^|[?&\s])(?:token|secret|api[-_]?key|password|signature|credential)=[^&\s]+/i;
const SignedQueryKeyPattern =
  /(?:credential|signature|token|secret|api[-_]?key|password|session|authorization|cookie)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeString(value: string): string {
  if (CredentialReferencePattern.test(value) || InlineSecretPattern.test(value)) {
    return '[REDACTED]';
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      [...url.searchParams.keys()].some((key) => SignedQueryKeyPattern.test(key))
    ) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // An ordinary non-URL string has no query component to inspect.
  }
  return value;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (!isRecord(value)) return value;
  if (seen.has(value)) return '[REDACTED_CIRCULAR]';
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SensitiveKeyPattern.test(key)) continue;
    sanitized[key] = sanitizeValue(entry, seen);
  }
  seen.delete(value);
  return sanitized;
}

export function sanitizeAutomationAuditPayload(value: unknown): unknown {
  return sanitizeValue(value, new WeakSet());
}
