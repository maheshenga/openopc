import { describe, expect, test } from 'bun:test';
import type {
  IntelligenceEvaluationRun,
  IntelligenceEvaluationSuite,
  IntelligenceModelEvaluationSnapshot,
} from '@kortix/intelligence-contracts';
import {
  createDrizzleIntelligenceEvaluationRepository,
  createMemoryIntelligenceEvaluationRepository,
} from './repository';

const ACCOUNT_ID = '41000000-0000-4000-a000-000000000001';
const PROJECT_ID = '42000000-0000-4000-a000-000000000001';
const SUITE_ID = '43000000-0000-4000-a000-000000000001';
const RUN_ID = '44000000-0000-4000-a000-000000000001';
const SNAPSHOT_ID = '45000000-0000-4000-a000-000000000001';
const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;

function draftSuite(): IntelligenceEvaluationSuite {
  return {
    protocol_version: 'intelligence.workflow.v1',
    suite_id: SUITE_ID,
    suite_version: 'image-golden-v1',
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    capability_id: 'studio.image.generate',
    capability_version: '1.0.0',
    dataset_manifest_hash: HASH_A,
    dataset_ref: 'sealed:image-golden-v1',
    scorer_versions: [
      { scorer_id: 'image.schema_validity', version: '1.0.0' },
      { scorer_id: 'image.integrity', version: '1.0.0' },
      { scorer_id: 'image.safety', version: '1.0.0' },
    ],
    thresholds: {
      minimum_schema_valid_rate_ppm: 1_000_000,
      minimum_integrity_rate_ppm: 990_000,
      minimum_safety_rate_ppm: 1_000_000,
      minimum_human_approval_rate_ppm: 800_000,
      maximum_failure_rate_ppm: 10_000,
    },
    minimum_sample_count: 30,
    confidence_level_bps: 9_500,
    status: 'draft',
    created_at: '2026-07-19T00:00:00.000Z',
    published_at: null,
  };
}

function queuedRun(): IntelligenceEvaluationRun {
  return {
    protocol_version: 'intelligence.workflow.v1',
    evaluation_run_id: RUN_ID,
    suite_id: SUITE_ID,
    suite_version: 'image-golden-v1',
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    idempotency_key: 'evaluation-run-key-000001',
    request_hash: HASH_A,
    status: 'queued',
    budget_micredits: 5_000_000,
    max_samples: 100,
    processed_samples: 0,
    spent_micredits: 0,
    failure_code: null,
    started_at: null,
    completed_at: null,
    created_at: '2026-07-19T00:02:00.000Z',
  };
}

function succeededRun(): IntelligenceEvaluationRun {
  return {
    ...queuedRun(),
    status: 'succeeded',
    processed_samples: 100,
    spent_micredits: 4_200_000,
    started_at: '2026-07-19T00:02:01.000Z',
    completed_at: '2026-07-19T00:04:59.000Z',
  };
}

function evaluationSnapshot(): IntelligenceModelEvaluationSnapshot {
  return {
    protocol_version: 'intelligence.workflow.v1',
    snapshot_id: SNAPSHOT_ID,
    snapshot_version: 'image-golden-v1.fake-image-v1.1',
    evaluation_run_id: RUN_ID,
    suite_id: SUITE_ID,
    suite_version: 'image-golden-v1',
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    candidate_hash: HASH_B,
    capability_id: 'studio.image.generate',
    capability_version: '1.0.0',
    sample_count: 100,
    minimum_sample_count: 30,
    meets_minimum_samples: true,
    confidence: {
      method: 'wilson',
      level_bps: 9_500,
      lower_bound_ppm: 900_000,
      upper_bound_ppm: 990_000,
    },
    metrics: {
      schema_valid_rate_ppm: 1_000_000,
      integrity_rate_ppm: 990_000,
      safety_rate_ppm: 1_000_000,
      availability_rate_ppm: 980_000,
      failure_rate_ppm: 20_000,
      retry_rate_ppm: 50_000,
      human_approval_rate_ppm: 900_000,
      latency_p50_ms: 1_200,
      latency_p95_ms: 2_500,
      mean_cost_micredits: 42_000,
      total_cost_micredits: 4_200_000,
    },
    scorer_versions: [
      { scorer_id: 'image.schema_validity', version: '1.0.0' },
      { scorer_id: 'system.latency', version: '1.0.0' },
    ],
    published_at: '2026-07-19T00:05:00.000Z',
  };
}

describe('intelligence evaluation repository', () => {
  test('publishes a draft suite once and rejects replacement of that version', async () => {
    const repository = createMemoryIntelligenceEvaluationRepository();
    await repository.createSuite(draftSuite());

    const published = await repository.publishSuite({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      publishedAt: '2026-07-19T00:01:00.000Z',
    });

    expect(published).toMatchObject({
      status: 'published',
      published_at: '2026-07-19T00:01:00.000Z',
    });
    await expect(
      repository.createSuite({ ...draftSuite(), dataset_manifest_hash: HASH_B }),
    ).rejects.toMatchObject({ code: 'EVALUATION_SUITE_IMMUTABLE' });
  });

  test('replays an identical run idempotently and rejects a changed request', async () => {
    const repository = createMemoryIntelligenceEvaluationRepository();
    await repository.createSuite(draftSuite());
    await repository.publishSuite({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      publishedAt: '2026-07-19T00:01:00.000Z',
    });

    expect(await repository.createRun(queuedRun())).toMatchObject({ created: true });
    expect(await repository.createRun(queuedRun())).toMatchObject({
      created: false,
      run: { evaluation_run_id: RUN_ID },
    });
    await expect(
      repository.createRun({ ...queuedRun(), request_hash: HASH_B }),
    ).rejects.toMatchObject({ code: 'EVALUATION_RUN_IDEMPOTENCY_MISMATCH' });
  });

  test('advances run lifecycle while preserving its declared budget and identity', async () => {
    const repository = createMemoryIntelligenceEvaluationRepository();
    await repository.createSuite(draftSuite());
    await repository.publishSuite({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      publishedAt: '2026-07-19T00:01:00.000Z',
    });
    await repository.createRun(queuedRun());

    const running = await repository.updateRun({
      run: {
        ...queuedRun(),
        status: 'running',
        processed_samples: 10,
        spent_micredits: 420_000,
        started_at: '2026-07-19T00:02:01.000Z',
      },
      updatedAt: '2026-07-19T00:03:00.000Z',
    });
    expect(running).toMatchObject({ status: 'running', processed_samples: 10 });

    expect(
      await repository.updateRun({
        run: succeededRun(),
        updatedAt: '2026-07-19T00:04:59.000Z',
      }),
    ).toMatchObject({ status: 'succeeded', spent_micredits: 4_200_000 });
    await expect(
      repository.updateRun({
        run: { ...succeededRun(), budget_micredits: 6_000_000 },
        updatedAt: '2026-07-19T00:05:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'EVALUATION_RUN_IMMUTABLE' });
  });

  test('inserts an aggregate snapshot once for a succeeded in-scope run', async () => {
    const repository = createMemoryIntelligenceEvaluationRepository();
    await repository.createSuite(draftSuite());
    await repository.publishSuite({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      publishedAt: '2026-07-19T00:01:00.000Z',
    });
    await repository.createRun(succeededRun());

    expect(await repository.insertSnapshot(evaluationSnapshot())).toMatchObject({
      snapshot_id: SNAPSHOT_ID,
      project_id: PROJECT_ID,
    });
    await expect(repository.insertSnapshot(evaluationSnapshot())).rejects.toMatchObject({
      code: 'EVALUATION_SNAPSHOT_IMMUTABLE',
    });
  });

  test('finds a published snapshot only through its exact account, project, and candidate fence', async () => {
    const repository = createMemoryIntelligenceEvaluationRepository();
    await repository.createSuite(draftSuite());
    await repository.publishSuite({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      suiteId: SUITE_ID,
      publishedAt: '2026-07-19T00:01:00.000Z',
    });
    await repository.createRun(succeededRun());
    await repository.insertSnapshot(evaluationSnapshot());

    const query = {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      candidateHash: HASH_B,
      capabilityId: 'studio.image.generate' as const,
      capabilityVersion: '1.0.0' as const,
    };
    expect(await repository.findPublishedSnapshot(query)).toEqual(evaluationSnapshot());
    expect(
      await repository.findPublishedSnapshot({
        ...query,
        accountId: '41000000-0000-4000-a000-000000000002',
      }),
    ).toBeNull();
    expect(
      await repository.findPublishedSnapshot({
        ...query,
        projectId: '42000000-0000-4000-a000-000000000002',
      }),
    ).toBeNull();
    expect(await repository.findPublishedSnapshot({ ...query, candidateHash: HASH_A })).toBeNull();
  });

  test('constructs the Drizzle repository without opening a database connection', () => {
    const repository = createDrizzleIntelligenceEvaluationRepository({} as never);
    expect(Object.keys(repository).sort()).toEqual(
      [
        'createRun',
        'createSuite',
        'findPublishedSnapshot',
        'insertSnapshot',
        'publishSuite',
        'updateRun',
      ].sort(),
    );
  });

  test('uses an atomic insert conflict path for Drizzle run idempotency', async () => {
    let selectCount = 0;
    let atomicInsertCount = 0;
    const suiteRow = {
      suiteId: SUITE_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      protocolVersion: 'intelligence.workflow.v1',
      suiteVersion: 'image-golden-v1',
      capabilityId: 'studio.image.generate',
      capabilityVersion: '1.0.0',
      datasetManifestHash: HASH_A,
      datasetRef: 'sealed:image-golden-v1',
      scorerVersions: draftSuite().scorer_versions,
      thresholds: draftSuite().thresholds,
      minimumSampleCount: 30,
      confidenceLevelBps: 9_500,
      status: 'published',
      createdAt: '2026-07-19T00:00:00.000Z',
      publishedAt: '2026-07-19T00:01:00.000Z',
    };
    const runRow = {
      evaluationRunId: RUN_ID,
      suiteId: SUITE_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      suiteVersion: 'image-golden-v1',
      protocolVersion: 'intelligence.workflow.v1',
      idempotencyKey: 'evaluation-run-key-000001',
      requestHash: HASH_A,
      status: 'queued',
      budgetMicredits: 5_000_000,
      maxSamples: 100,
      processedSamples: 0,
      spentMicredits: 0,
      failureCode: null,
      startedAt: null,
      completedAt: null,
      createdAt: '2026-07-19T00:02:00.000Z',
      updatedAt: '2026-07-19T00:02:00.000Z',
    };
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCount += 1;
              return selectCount === 1 ? [suiteRow] : [runRow];
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              atomicInsertCount += 1;
              return [];
            },
          }),
        }),
      }),
    };

    const repository = createDrizzleIntelligenceEvaluationRepository(database as never);
    expect(await repository.createRun(queuedRun())).toMatchObject({
      created: false,
      run: { evaluation_run_id: RUN_ID },
    });
    expect(atomicInsertCount).toBe(1);
  });
});
