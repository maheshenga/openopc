import {
  type Database,
  intelligenceEvaluationRuns,
  intelligenceEvaluationSuites,
  intelligenceModelEvaluationSnapshots,
} from '@kortix/db';
import {
  type IntelligenceEvaluationRun,
  IntelligenceEvaluationRunSchema,
  type IntelligenceEvaluationSuite,
  IntelligenceEvaluationSuiteSchema,
  type IntelligenceModelEvaluationSnapshot,
  IntelligenceModelEvaluationSnapshotSchema,
} from '@kortix/intelligence-contracts';
import { and, eq } from 'drizzle-orm';

export type IntelligenceEvaluationRepositoryErrorCode =
  | 'EVALUATION_SCOPE_DENIED'
  | 'EVALUATION_RUN_CONFLICT'
  | 'EVALUATION_RUN_IDEMPOTENCY_MISMATCH'
  | 'EVALUATION_RUN_IMMUTABLE'
  | 'EVALUATION_RUN_NOT_SUCCEEDED'
  | 'EVALUATION_RUN_TRANSITION_CONFLICT'
  | 'EVALUATION_SNAPSHOT_IMMUTABLE'
  | 'EVALUATION_SUITE_IMMUTABLE'
  | 'EVALUATION_SUITE_NOT_PUBLISHED'
  | 'EVALUATION_SUITE_VERSION_CONFLICT';

export class IntelligenceEvaluationRepositoryError extends Error {
  readonly code: IntelligenceEvaluationRepositoryErrorCode;

  constructor(code: IntelligenceEvaluationRepositoryErrorCode, message: string) {
    super(message);
    this.name = 'IntelligenceEvaluationRepositoryError';
    this.code = code;
  }
}

export interface IntelligenceEvaluationRepository {
  createSuite(suite: IntelligenceEvaluationSuite): Promise<IntelligenceEvaluationSuite>;
  createRun(run: IntelligenceEvaluationRun): Promise<{
    run: IntelligenceEvaluationRun;
    created: boolean;
  }>;
  insertSnapshot(
    snapshot: IntelligenceModelEvaluationSnapshot,
  ): Promise<IntelligenceModelEvaluationSnapshot>;
  updateRun(input: {
    run: IntelligenceEvaluationRun;
    updatedAt: string;
  }): Promise<IntelligenceEvaluationRun>;
  publishSuite(input: {
    accountId: string;
    projectId: string;
    suiteId: string;
    publishedAt: string;
  }): Promise<IntelligenceEvaluationSuite>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertRunUpdate(
  current: IntelligenceEvaluationRun,
  next: IntelligenceEvaluationRun,
): void {
  const identityMatches =
    current.protocol_version === next.protocol_version &&
    current.evaluation_run_id === next.evaluation_run_id &&
    current.suite_id === next.suite_id &&
    current.suite_version === next.suite_version &&
    current.account_id === next.account_id &&
    current.project_id === next.project_id &&
    current.idempotency_key === next.idempotency_key &&
    current.request_hash === next.request_hash &&
    current.budget_micredits === next.budget_micredits &&
    current.max_samples === next.max_samples &&
    current.created_at === next.created_at;
  if (!identityMatches) {
    throw new IntelligenceEvaluationRepositoryError(
      'EVALUATION_RUN_IMMUTABLE',
      'evaluation run identity and declared budgets are immutable',
    );
  }

  if (
    next.processed_samples < current.processed_samples ||
    next.spent_micredits < current.spent_micredits ||
    (current.started_at !== null && current.started_at !== next.started_at)
  ) {
    throw new IntelligenceEvaluationRepositoryError(
      'EVALUATION_RUN_TRANSITION_CONFLICT',
      'evaluation run progress must be monotonic',
    );
  }

  const transitions: Record<
    IntelligenceEvaluationRun['status'],
    IntelligenceEvaluationRun['status'][]
  > = {
    queued: ['queued', 'running', 'cancelled'],
    running: ['running', 'succeeded', 'failed', 'cancelled'],
    succeeded: ['succeeded'],
    failed: ['failed'],
    cancelled: ['cancelled'],
  };
  const isExactTerminalReplay =
    current.status === next.status &&
    current.processed_samples === next.processed_samples &&
    current.spent_micredits === next.spent_micredits &&
    current.failure_code === next.failure_code &&
    current.started_at === next.started_at &&
    current.completed_at === next.completed_at;
  if (
    !transitions[current.status].includes(next.status) ||
    (['succeeded', 'failed', 'cancelled'].includes(current.status) && !isExactTerminalReplay)
  ) {
    throw new IntelligenceEvaluationRepositoryError(
      'EVALUATION_RUN_TRANSITION_CONFLICT',
      'evaluation run lifecycle transition is not allowed',
    );
  }
}

export function createMemoryIntelligenceEvaluationRepository(): IntelligenceEvaluationRepository {
  const suites = new Map<string, IntelligenceEvaluationSuite>();
  const runs = new Map<string, IntelligenceEvaluationRun>();
  const runIdsByIdempotency = new Map<string, string>();
  const snapshots = new Map<string, IntelligenceModelEvaluationSnapshot>();
  const snapshotIdsByProjectVersion = new Map<string, string>();
  const snapshotIdsByRunCandidate = new Map<string, string>();

  return {
    async createSuite(input) {
      const suite = IntelligenceEvaluationSuiteSchema.parse(input);
      const existing = suites.get(suite.suite_id);
      if (existing) {
        if (existing.status !== 'draft') {
          throw new IntelligenceEvaluationRepositoryError(
            'EVALUATION_SUITE_IMMUTABLE',
            'published evaluation suite versions are immutable',
          );
        }
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_VERSION_CONFLICT',
          'evaluation suite id already exists',
        );
      }
      const sameVersion = [...suites.values()].find(
        (stored) =>
          stored.project_id === suite.project_id && stored.suite_version === suite.suite_version,
      );
      if (sameVersion) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_VERSION_CONFLICT',
          'evaluation suite version already exists in this project',
        );
      }
      suites.set(suite.suite_id, clone(suite));
      return clone(suite);
    },

    async createRun(input) {
      const run = IntelligenceEvaluationRunSchema.parse(input);
      const suite = suites.get(run.suite_id);
      if (
        !suite ||
        suite.account_id !== run.account_id ||
        suite.project_id !== run.project_id ||
        suite.suite_version !== run.suite_version
      ) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SCOPE_DENIED',
          'evaluation run is outside the suite project scope',
        );
      }
      if (suite.status !== 'published') {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_NOT_PUBLISHED',
          'evaluation runs require a published suite version',
        );
      }

      const idempotencyScope = `${run.project_id}\u0000${run.idempotency_key}`;
      const existingRunId = runIdsByIdempotency.get(idempotencyScope);
      const existing = existingRunId ? runs.get(existingRunId) : undefined;
      if (existing) {
        if (
          existing.request_hash !== run.request_hash ||
          existing.account_id !== run.account_id ||
          existing.suite_id !== run.suite_id ||
          existing.suite_version !== run.suite_version
        ) {
          throw new IntelligenceEvaluationRepositoryError(
            'EVALUATION_RUN_IDEMPOTENCY_MISMATCH',
            'evaluation run idempotency key was reused with a different request',
          );
        }
        return { run: clone(existing), created: false };
      }
      if (runs.has(run.evaluation_run_id)) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_RUN_CONFLICT',
          'evaluation run id already exists',
        );
      }
      runs.set(run.evaluation_run_id, clone(run));
      runIdsByIdempotency.set(idempotencyScope, run.evaluation_run_id);
      return { run: clone(run), created: true };
    },

    async insertSnapshot(input) {
      const snapshot = IntelligenceModelEvaluationSnapshotSchema.parse(input);
      const run = runs.get(snapshot.evaluation_run_id);
      if (
        !run ||
        run.account_id !== snapshot.account_id ||
        run.project_id !== snapshot.project_id ||
        run.suite_id !== snapshot.suite_id ||
        run.suite_version !== snapshot.suite_version
      ) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SCOPE_DENIED',
          'evaluation snapshot is outside the run project scope',
        );
      }
      if (run.status !== 'succeeded') {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_RUN_NOT_SUCCEEDED',
          'evaluation snapshots require a succeeded run',
        );
      }

      const projectVersion = `${snapshot.project_id}\u0000${snapshot.snapshot_version}`;
      const runCandidate = `${snapshot.evaluation_run_id}\u0000${snapshot.candidate_hash}`;
      if (
        snapshots.has(snapshot.snapshot_id) ||
        snapshotIdsByProjectVersion.has(projectVersion) ||
        snapshotIdsByRunCandidate.has(runCandidate)
      ) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SNAPSHOT_IMMUTABLE',
          'evaluation snapshots are insert-only',
        );
      }
      snapshots.set(snapshot.snapshot_id, clone(snapshot));
      snapshotIdsByProjectVersion.set(projectVersion, snapshot.snapshot_id);
      snapshotIdsByRunCandidate.set(runCandidate, snapshot.snapshot_id);
      return clone(snapshot);
    },

    async updateRun(input) {
      const next = IntelligenceEvaluationRunSchema.parse(input.run);
      const current = runs.get(next.evaluation_run_id);
      if (
        !current ||
        current.account_id !== next.account_id ||
        current.project_id !== next.project_id
      ) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SCOPE_DENIED',
          'evaluation run is outside the requested project scope',
        );
      }
      assertRunUpdate(current, next);
      runs.set(next.evaluation_run_id, clone(next));
      return clone(next);
    },

    async publishSuite(input) {
      const existing = suites.get(input.suiteId);
      if (
        !existing ||
        existing.account_id !== input.accountId ||
        existing.project_id !== input.projectId
      ) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SCOPE_DENIED',
          'evaluation suite is outside the requested project scope',
        );
      }
      if (existing.status === 'published') return clone(existing);
      if (existing.status !== 'draft') {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_IMMUTABLE',
          'published evaluation suite versions are immutable',
        );
      }
      const published = IntelligenceEvaluationSuiteSchema.parse({
        ...existing,
        status: 'published',
        published_at: input.publishedAt,
      });
      suites.set(published.suite_id, clone(published));
      return clone(published);
    },
  };
}

type EvaluationSuiteRow = typeof intelligenceEvaluationSuites.$inferSelect;
type EvaluationRunRow = typeof intelligenceEvaluationRuns.$inferSelect;
type EvaluationSnapshotRow = typeof intelligenceModelEvaluationSnapshots.$inferSelect;

function toSuite(row: EvaluationSuiteRow): IntelligenceEvaluationSuite {
  return IntelligenceEvaluationSuiteSchema.parse({
    protocol_version: row.protocolVersion,
    suite_id: row.suiteId,
    suite_version: row.suiteVersion,
    account_id: row.accountId,
    project_id: row.projectId,
    capability_id: row.capabilityId,
    capability_version: row.capabilityVersion,
    dataset_manifest_hash: row.datasetManifestHash,
    dataset_ref: row.datasetRef,
    scorer_versions: row.scorerVersions,
    thresholds: row.thresholds,
    minimum_sample_count: row.minimumSampleCount,
    confidence_level_bps: row.confidenceLevelBps,
    status: row.status,
    created_at: row.createdAt,
    published_at: row.publishedAt,
  });
}

function toRun(row: EvaluationRunRow): IntelligenceEvaluationRun {
  return IntelligenceEvaluationRunSchema.parse({
    protocol_version: row.protocolVersion,
    evaluation_run_id: row.evaluationRunId,
    suite_id: row.suiteId,
    suite_version: row.suiteVersion,
    account_id: row.accountId,
    project_id: row.projectId,
    idempotency_key: row.idempotencyKey,
    request_hash: row.requestHash,
    status: row.status,
    budget_micredits: row.budgetMicredits,
    max_samples: row.maxSamples,
    processed_samples: row.processedSamples,
    spent_micredits: row.spentMicredits,
    failure_code: row.failureCode,
    started_at: row.startedAt,
    completed_at: row.completedAt,
    created_at: row.createdAt,
  });
}

function toSnapshot(row: EvaluationSnapshotRow): IntelligenceModelEvaluationSnapshot {
  return IntelligenceModelEvaluationSnapshotSchema.parse({
    protocol_version: 'intelligence.workflow.v1',
    snapshot_id: row.snapshotId,
    snapshot_version: row.snapshotVersion,
    evaluation_run_id: row.evaluationRunId,
    suite_id: row.suiteId,
    suite_version: row.suiteVersion,
    account_id: row.accountId,
    project_id: row.projectId,
    candidate_hash: row.candidateHash,
    capability_id: row.capabilityId,
    capability_version: row.capabilityVersion,
    sample_count: row.sampleCount,
    minimum_sample_count: row.minimumSampleCount,
    meets_minimum_samples: row.meetsMinimumSamples,
    confidence: row.confidence,
    metrics: row.metrics,
    scorer_versions: row.scorerVersions,
    published_at: row.publishedAt,
  });
}

function scopeError(message: string): IntelligenceEvaluationRepositoryError {
  return new IntelligenceEvaluationRepositoryError('EVALUATION_SCOPE_DENIED', message);
}

export function createDrizzleIntelligenceEvaluationRepository(
  database: Database,
): IntelligenceEvaluationRepository {
  return {
    async createSuite(input) {
      const suite = IntelligenceEvaluationSuiteSchema.parse(input);
      const [row] = await database
        .insert(intelligenceEvaluationSuites)
        .values({
          suiteId: suite.suite_id,
          accountId: suite.account_id,
          projectId: suite.project_id,
          protocolVersion: suite.protocol_version,
          suiteVersion: suite.suite_version,
          capabilityId: suite.capability_id,
          capabilityVersion: suite.capability_version,
          datasetManifestHash: suite.dataset_manifest_hash,
          datasetRef: suite.dataset_ref,
          scorerVersions: suite.scorer_versions,
          thresholds: suite.thresholds,
          minimumSampleCount: suite.minimum_sample_count,
          confidenceLevelBps: suite.confidence_level_bps,
          status: suite.status,
          createdAt: suite.created_at,
          publishedAt: suite.published_at,
        })
        .returning();
      if (!row) throw new Error('evaluation suite insert returned no row');
      return toSuite(row);
    },

    async createRun(input) {
      const run = IntelligenceEvaluationRunSchema.parse(input);
      const [suiteRow] = await database
        .select()
        .from(intelligenceEvaluationSuites)
        .where(
          and(
            eq(intelligenceEvaluationSuites.suiteId, run.suite_id),
            eq(intelligenceEvaluationSuites.accountId, run.account_id),
            eq(intelligenceEvaluationSuites.projectId, run.project_id),
            eq(intelligenceEvaluationSuites.suiteVersion, run.suite_version),
          ),
        )
        .limit(1);
      if (!suiteRow) throw scopeError('evaluation run is outside the suite project scope');
      if (suiteRow.status !== 'published') {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_NOT_PUBLISHED',
          'evaluation runs require a published suite version',
        );
      }

      const [insertedRow] = await database
        .insert(intelligenceEvaluationRuns)
        .values({
          evaluationRunId: run.evaluation_run_id,
          suiteId: run.suite_id,
          accountId: run.account_id,
          projectId: run.project_id,
          suiteVersion: run.suite_version,
          protocolVersion: run.protocol_version,
          idempotencyKey: run.idempotency_key,
          requestHash: run.request_hash,
          status: run.status,
          budgetMicredits: run.budget_micredits,
          maxSamples: run.max_samples,
          processedSamples: run.processed_samples,
          spentMicredits: run.spent_micredits,
          failureCode: run.failure_code,
          startedAt: run.started_at,
          completedAt: run.completed_at,
          createdAt: run.created_at,
        })
        .onConflictDoNothing({
          target: [intelligenceEvaluationRuns.projectId, intelligenceEvaluationRuns.idempotencyKey],
        })
        .returning();
      if (insertedRow) return { run: toRun(insertedRow), created: true };

      const [existingRow] = await database
        .select()
        .from(intelligenceEvaluationRuns)
        .where(
          and(
            eq(intelligenceEvaluationRuns.projectId, run.project_id),
            eq(intelligenceEvaluationRuns.idempotencyKey, run.idempotency_key),
          ),
        )
        .limit(1);
      if (!existingRow) throw new Error('evaluation run conflict could not be reloaded');
      const existing = toRun(existingRow);
      if (
        existing.request_hash !== run.request_hash ||
        existing.account_id !== run.account_id ||
        existing.suite_id !== run.suite_id ||
        existing.suite_version !== run.suite_version
      ) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_RUN_IDEMPOTENCY_MISMATCH',
          'evaluation run idempotency key was reused with a different request',
        );
      }
      return { run: existing, created: false };
    },

    async insertSnapshot(input) {
      const snapshot = IntelligenceModelEvaluationSnapshotSchema.parse(input);
      const [runRow] = await database
        .select()
        .from(intelligenceEvaluationRuns)
        .where(
          and(
            eq(intelligenceEvaluationRuns.evaluationRunId, snapshot.evaluation_run_id),
            eq(intelligenceEvaluationRuns.suiteId, snapshot.suite_id),
            eq(intelligenceEvaluationRuns.accountId, snapshot.account_id),
            eq(intelligenceEvaluationRuns.projectId, snapshot.project_id),
            eq(intelligenceEvaluationRuns.suiteVersion, snapshot.suite_version),
          ),
        )
        .limit(1);
      if (!runRow) throw scopeError('evaluation snapshot is outside the run project scope');
      if (runRow.status !== 'succeeded') {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_RUN_NOT_SUCCEEDED',
          'evaluation snapshots require a succeeded run',
        );
      }

      const [row] = await database
        .insert(intelligenceModelEvaluationSnapshots)
        .values({
          snapshotId: snapshot.snapshot_id,
          snapshotVersion: snapshot.snapshot_version,
          evaluationRunId: snapshot.evaluation_run_id,
          suiteId: snapshot.suite_id,
          accountId: snapshot.account_id,
          projectId: snapshot.project_id,
          suiteVersion: snapshot.suite_version,
          candidateHash: snapshot.candidate_hash,
          capabilityId: snapshot.capability_id,
          capabilityVersion: snapshot.capability_version,
          sampleCount: snapshot.sample_count,
          minimumSampleCount: snapshot.minimum_sample_count,
          meetsMinimumSamples: snapshot.meets_minimum_samples,
          confidence: snapshot.confidence,
          metrics: snapshot.metrics,
          scorerVersions: snapshot.scorer_versions,
          publishedAt: snapshot.published_at,
        })
        .returning();
      if (!row) throw new Error('evaluation snapshot insert returned no row');
      return toSnapshot(row);
    },

    async updateRun(input) {
      const next = IntelligenceEvaluationRunSchema.parse(input.run);
      const [currentRow] = await database
        .select()
        .from(intelligenceEvaluationRuns)
        .where(
          and(
            eq(intelligenceEvaluationRuns.evaluationRunId, next.evaluation_run_id),
            eq(intelligenceEvaluationRuns.accountId, next.account_id),
            eq(intelligenceEvaluationRuns.projectId, next.project_id),
          ),
        )
        .limit(1);
      if (!currentRow) throw scopeError('evaluation run is outside the requested project scope');
      const current = toRun(currentRow);
      assertRunUpdate(current, next);

      const [row] = await database
        .update(intelligenceEvaluationRuns)
        .set({
          status: next.status,
          processedSamples: next.processed_samples,
          spentMicredits: next.spent_micredits,
          failureCode: next.failure_code,
          startedAt: next.started_at,
          completedAt: next.completed_at,
          updatedAt: input.updatedAt,
        })
        .where(
          and(
            eq(intelligenceEvaluationRuns.evaluationRunId, current.evaluation_run_id),
            eq(intelligenceEvaluationRuns.accountId, current.account_id),
            eq(intelligenceEvaluationRuns.projectId, current.project_id),
            eq(intelligenceEvaluationRuns.status, current.status),
            eq(intelligenceEvaluationRuns.processedSamples, current.processed_samples),
            eq(intelligenceEvaluationRuns.spentMicredits, current.spent_micredits),
          ),
        )
        .returning();
      if (!row) {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_RUN_TRANSITION_CONFLICT',
          'evaluation run changed concurrently',
        );
      }
      return toRun(row);
    },

    async publishSuite(input) {
      const [existingRow] = await database
        .select()
        .from(intelligenceEvaluationSuites)
        .where(
          and(
            eq(intelligenceEvaluationSuites.suiteId, input.suiteId),
            eq(intelligenceEvaluationSuites.accountId, input.accountId),
            eq(intelligenceEvaluationSuites.projectId, input.projectId),
          ),
        )
        .limit(1);
      if (!existingRow) throw scopeError('evaluation suite is outside the requested project scope');
      if (existingRow.status === 'published') return toSuite(existingRow);
      if (existingRow.status !== 'draft') {
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_IMMUTABLE',
          'published evaluation suite versions are immutable',
        );
      }

      const [row] = await database
        .update(intelligenceEvaluationSuites)
        .set({ status: 'published', publishedAt: input.publishedAt })
        .where(
          and(
            eq(intelligenceEvaluationSuites.suiteId, input.suiteId),
            eq(intelligenceEvaluationSuites.accountId, input.accountId),
            eq(intelligenceEvaluationSuites.projectId, input.projectId),
            eq(intelligenceEvaluationSuites.status, 'draft'),
          ),
        )
        .returning();
      if (!row)
        throw new IntelligenceEvaluationRepositoryError(
          'EVALUATION_SUITE_IMMUTABLE',
          'evaluation suite changed concurrently',
        );
      return toSuite(row);
    },
  };
}
