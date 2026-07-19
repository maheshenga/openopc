import { type Database, intelligenceRouteDecisions } from '@kortix/db';
import {
  type IntelligenceRouteDecision,
  canonicalWorkflowJson,
} from '@kortix/intelligence-orchestration';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const VersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const ReasonCodeSchema = z.enum([
  'ROUTE_PRIMARY_SELECTED',
  'ROUTE_FALLBACK_SELECTED',
  'ROUTE_NO_ELIGIBLE_CANDIDATE',
  'ROUTE_IAM_DENIED',
  'ROUTE_AGENT_DENIED',
  'ROUTE_PROJECT_POLICY_DENIED',
  'ROUTE_CAPABILITY_MISMATCH',
  'ROUTE_SCHEMA_MISMATCH',
  'ROUTE_REGION_DENIED',
  'ROUTE_SAFETY_DENIED',
  'ROUTE_INPUT_UNSUPPORTED',
  'ROUTE_OUTPUT_UNSUPPORTED',
  'ROUTE_NOT_READY',
  'ROUTE_BUDGET_EXCEEDED',
  'ROUTE_DEADLINE_UNSATISFIABLE',
  'ROUTE_EVALUATION_MISSING',
  'ROUTE_EVALUATION_STALE',
  'ROUTE_EVALUATION_THRESHOLD_FAILED',
  'ROUTE_RISK_EXCEEDED',
  'ROUTE_PROPOSED_TARGET_REJECTED',
]);
const PpmSchema = z.number().int().min(0).max(1_000_000);
const RouteCandidateSchema = z
  .object({
    candidateId: HashSchema,
    providerDefinitionId: z.string().trim().min(1).max(128),
    providerConfigId: z.string().trim().min(1).max(256),
    modelId: z.string().trim().min(1).max(255),
    evaluationVersion: VersionSchema,
    scorePpm: z.number().int().min(-5_000_000).max(5_000_000),
    components: z
      .object({
        qualityPpm: PpmSchema,
        availabilityPpm: PpmSchema,
        latencyPenaltyPpm: PpmSchema,
        costPenaltyPpm: PpmSchema,
        riskPenaltyPpm: PpmSchema,
      })
      .strict(),
  })
  .strict();
const RouteDecisionSchema = z
  .object({
    protocolVersion: z.literal('intelligence.route.v1'),
    decisionId: z.string().uuid(),
    accountId: z.string().uuid(),
    projectId: z.string().uuid(),
    requestHash: HashSchema,
    policyVersion: VersionSchema,
    policyHash: HashSchema,
    primary: RouteCandidateSchema.nullable(),
    fallback: RouteCandidateSchema.nullable(),
    rejected: z
      .array(
        z
          .object({
            candidateId: HashSchema,
            reasonCodes: z.array(ReasonCodeSchema).min(1).max(2),
          })
          .strict(),
      )
      .max(128),
    reasonCodes: z.array(ReasonCodeSchema).min(1).max(32),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.fallback && !decision.primary) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'route fallback requires a primary candidate',
        path: ['fallback'],
      });
    }
    if (decision.primary && !decision.reasonCodes.includes('ROUTE_PRIMARY_SELECTED')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'selected primary reason is required',
        path: ['reasonCodes'],
      });
    }
    if (!decision.primary && !decision.reasonCodes.includes('ROUTE_NO_ELIGIBLE_CANDIDATE')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'no eligible candidate reason is required',
        path: ['reasonCodes'],
      });
    }
    if (
      Boolean(decision.fallback) !== decision.reasonCodes.includes('ROUTE_FALLBACK_SELECTED')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fallback reason must match fallback presence',
        path: ['reasonCodes'],
      });
    }
    if (decision.primary?.candidateId === decision.fallback?.candidateId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'primary and fallback candidates must differ',
        path: ['fallback'],
      });
    }
  });

export type IntelligenceRouteDecisionStoreErrorCode =
  | 'ROUTE_DECISION_INVALID'
  | 'ROUTE_DECISION_SCOPE_DENIED'
  | 'ROUTE_DECISION_CONFLICT';

export class IntelligenceRouteDecisionStoreError extends Error {
  constructor(readonly code: IntelligenceRouteDecisionStoreErrorCode) {
    super(code);
    this.name = 'IntelligenceRouteDecisionStoreError';
  }
}

export type PutIntelligenceRouteDecisionInput = {
  accountId: string;
  projectId: string;
  runId: string;
  nodeId: string;
  decision: IntelligenceRouteDecision;
};

export type GetIntelligenceRouteDecisionInput = Omit<
  PutIntelligenceRouteDecisionInput,
  'decision'
>;

export interface IntelligenceRouteDecisionStore {
  put(input: PutIntelligenceRouteDecisionInput): Promise<{
    decision: IntelligenceRouteDecision;
    created: boolean;
  }>;
  get(input: GetIntelligenceRouteDecisionInput): Promise<IntelligenceRouteDecision | null>;
}

export function createMemoryIntelligenceRouteDecisionStore(): IntelligenceRouteDecisionStore {
  const records = new Map<
    string,
    GetIntelligenceRouteDecisionInput & { decision: IntelligenceRouteDecision }
  >();
  const locationsByDecisionId = new Map<string, string>();

  return {
    async put(input) {
      const parsed = parsePutInput(input);
      const key = locationKey(parsed);
      const priorLocation = locationsByDecisionId.get(parsed.decision.decisionId);
      const existing = records.get(key);
      if (existing) {
        if (!sameDecision(existing.decision, parsed.decision)) {
          throw new IntelligenceRouteDecisionStoreError('ROUTE_DECISION_CONFLICT');
        }
        return { decision: clone(existing.decision), created: false };
      }
      if (priorLocation && priorLocation !== key) {
        throw new IntelligenceRouteDecisionStoreError('ROUTE_DECISION_CONFLICT');
      }
      records.set(key, clone(parsed));
      locationsByDecisionId.set(parsed.decision.decisionId, key);
      return { decision: clone(parsed.decision), created: true };
    },

    async get(input) {
      const existing = records.get(locationKey(input));
      if (
        !existing ||
        existing.accountId !== input.accountId ||
        existing.projectId !== input.projectId
      ) {
        return null;
      }
      return clone(existing.decision);
    },
  };
}

type RouteDecisionRow = typeof intelligenceRouteDecisions.$inferSelect;

export function createDrizzleIntelligenceRouteDecisionStore(
  database: Database,
): IntelligenceRouteDecisionStore {
  return {
    async put(input) {
      const parsed = parsePutInput(input);
      const decision = parsed.decision;
      const [inserted] = await database
        .insert(intelligenceRouteDecisions)
        .values({
          decisionId: decision.decisionId,
          accountId: parsed.accountId,
          projectId: parsed.projectId,
          runId: parsed.runId,
          nodeId: parsed.nodeId,
          protocolVersion: decision.protocolVersion,
          requestHash: decision.requestHash,
          policyVersion: decision.policyVersion,
          policyHash: decision.policyHash,
          primaryCandidate: decision.primary,
          fallbackCandidate: decision.fallback,
          rejectedCandidates: decision.rejected,
          reasonCodes: decision.reasonCodes,
          createdAt: decision.createdAt,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) return { decision: toDecision(inserted), created: true };

      const existing = await readRow(database, parsed);
      if (!existing || !sameDecision(existing, decision)) {
        throw new IntelligenceRouteDecisionStoreError('ROUTE_DECISION_CONFLICT');
      }
      return { decision: existing, created: false };
    },

    async get(input) {
      return readRow(database, input);
    },
  };
}

async function readRow(
  database: Database,
  input: GetIntelligenceRouteDecisionInput,
): Promise<IntelligenceRouteDecision | null> {
  const [row] = await database
    .select()
    .from(intelligenceRouteDecisions)
    .where(
      and(
        eq(intelligenceRouteDecisions.accountId, input.accountId),
        eq(intelligenceRouteDecisions.projectId, input.projectId),
        eq(intelligenceRouteDecisions.runId, input.runId),
        eq(intelligenceRouteDecisions.nodeId, input.nodeId),
      ),
    )
    .limit(1);
  return row ? toDecision(row) : null;
}

function toDecision(row: RouteDecisionRow): IntelligenceRouteDecision {
  return parseDecision({
    protocolVersion: row.protocolVersion,
    decisionId: row.decisionId,
    accountId: row.accountId,
    projectId: row.projectId,
    requestHash: row.requestHash,
    policyVersion: row.policyVersion,
    policyHash: row.policyHash,
    primary: row.primaryCandidate,
    fallback: row.fallbackCandidate,
    rejected: row.rejectedCandidates,
    reasonCodes: row.reasonCodes,
    createdAt: row.createdAt,
  });
}

function parsePutInput(
  input: PutIntelligenceRouteDecisionInput,
): PutIntelligenceRouteDecisionInput {
  const decision = parseDecision(input.decision);
  if (
    decision.accountId !== input.accountId ||
    decision.projectId !== input.projectId ||
    !z.string().uuid().safeParse(input.runId).success ||
    !z.string().uuid().safeParse(input.nodeId).success
  ) {
    throw new IntelligenceRouteDecisionStoreError('ROUTE_DECISION_SCOPE_DENIED');
  }
  return { ...input, decision };
}

function parseDecision(input: unknown): IntelligenceRouteDecision {
  const parsed = RouteDecisionSchema.safeParse(input);
  if (!parsed.success) {
    throw new IntelligenceRouteDecisionStoreError('ROUTE_DECISION_INVALID');
  }
  return parsed.data;
}

function sameDecision(
  left: IntelligenceRouteDecision,
  right: IntelligenceRouteDecision,
): boolean {
  return canonicalWorkflowJson(left) === canonicalWorkflowJson(right);
}

function locationKey(input: GetIntelligenceRouteDecisionInput): string {
  return `${input.accountId}\u0000${input.projectId}\u0000${input.runId}\u0000${input.nodeId}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
