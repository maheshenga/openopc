import { z } from 'zod';

const ImageOutcomeObservationSchema = z
  .object({
    schema_valid: z.boolean(),
    integrity_passed: z.boolean(),
    safety_passed: z.boolean(),
  })
  .strict();

export type ImageOutcomeObservation = z.infer<typeof ImageOutcomeObservationSchema>;

const OperationalObservationSchema = z
  .object({
    available: z.boolean(),
    failed: z.boolean(),
    retry_count: z.number().int().nonnegative().max(1000),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.available === observation.failed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'evaluation availability and terminal failure must be opposites',
        path: ['failed'],
      });
    }
  });

export type OperationalObservation = z.infer<typeof OperationalObservationSchema>;

const LatencyObservationSchema = z
  .object({ latency_ms: z.number().int().nonnegative().max(604_800_000) })
  .strict();

export type LatencyObservation = z.infer<typeof LatencyObservationSchema>;

const CostObservationSchema = z
  .object({ cost_micredits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();

export type CostObservation = z.infer<typeof CostObservationSchema>;

const HumanReviewObservationSchema = z
  .object({ human_review: z.enum(['approved', 'rejected', 'not_reviewed']) })
  .strict();

export type HumanReviewObservation = z.infer<typeof HumanReviewObservationSchema>;

const ImageEvaluationSampleSchema = z
  .object({
    schema_valid: z.boolean(),
    integrity_passed: z.boolean(),
    safety_passed: z.boolean(),
    available: z.boolean(),
    failed: z.boolean(),
    retry_count: z.number().int().nonnegative().max(1000),
    latency_ms: z.number().int().nonnegative().max(604_800_000),
    cost_micredits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    human_review: z.enum(['approved', 'rejected', 'not_reviewed']),
  })
  .strict();

export type ImageEvaluationSample = z.infer<typeof ImageEvaluationSampleSchema>;

export const IMAGE_EVALUATION_SCORER_VERSIONS = [
  { scorer_id: 'image.schema_validity', version: '1.0.0' },
  { scorer_id: 'image.integrity', version: '1.0.0' },
  { scorer_id: 'image.safety', version: '1.0.0' },
  { scorer_id: 'system.latency', version: '1.0.0' },
  { scorer_id: 'system.availability', version: '1.0.0' },
  { scorer_id: 'system.failure', version: '1.0.0' },
  { scorer_id: 'system.retry', version: '1.0.0' },
  { scorer_id: 'system.cost', version: '1.0.0' },
  { scorer_id: 'human.image_quality', version: '1.0.0' },
] as const;

function ratePpm(successes: number, samples: number): number {
  return Number((BigInt(successes) * 1_000_000n + BigInt(samples) / 2n) / BigInt(samples));
}

export function scoreImageOutcomeRates(observations: readonly ImageOutcomeObservation[]): {
  schema_valid_rate_ppm: number;
  integrity_rate_ppm: number;
  safety_rate_ppm: number;
} {
  const samples = observations.map((observation) =>
    ImageOutcomeObservationSchema.parse(observation),
  );
  if (samples.length === 0) throw new Error('evaluation samples must not be empty');

  return {
    schema_valid_rate_ppm: ratePpm(
      samples.filter((sample) => sample.schema_valid).length,
      samples.length,
    ),
    integrity_rate_ppm: ratePpm(
      samples.filter((sample) => sample.integrity_passed).length,
      samples.length,
    ),
    safety_rate_ppm: ratePpm(
      samples.filter((sample) => sample.safety_passed).length,
      samples.length,
    ),
  };
}

export function scoreOperationalRates(observations: readonly OperationalObservation[]): {
  availability_rate_ppm: number;
  failure_rate_ppm: number;
  retry_rate_ppm: number;
} {
  const samples = observations.map((observation) =>
    OperationalObservationSchema.parse(observation),
  );
  if (samples.length === 0) throw new Error('evaluation samples must not be empty');

  return {
    availability_rate_ppm: ratePpm(
      samples.filter((sample) => sample.available).length,
      samples.length,
    ),
    failure_rate_ppm: ratePpm(samples.filter((sample) => sample.failed).length, samples.length),
    retry_rate_ppm: ratePpm(
      samples.filter((sample) => sample.retry_count > 0).length,
      samples.length,
    ),
  };
}

function nearestRank(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(sorted.length * percentile));
  return sorted[rank - 1] ?? 0;
}

export function scoreLatency(observations: readonly LatencyObservation[]): {
  latency_p50_ms: number;
  latency_p95_ms: number;
} {
  const samples = observations.map((observation) => LatencyObservationSchema.parse(observation));
  if (samples.length === 0) throw new Error('evaluation samples must not be empty');
  const values = samples.map((sample) => sample.latency_ms);
  return {
    latency_p50_ms: nearestRank(values, 0.5),
    latency_p95_ms: nearestRank(values, 0.95),
  };
}

export function scoreCost(observations: readonly CostObservation[]): {
  mean_cost_micredits: number;
  total_cost_micredits: number;
} {
  const samples = observations.map((observation) => CostObservationSchema.parse(observation));
  if (samples.length === 0) throw new Error('evaluation samples must not be empty');

  const total = samples.reduce((sum, sample) => sum + BigInt(sample.cost_micredits), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('evaluation total cost exceeds the safe integer range');
  }
  return {
    mean_cost_micredits: Number(total / BigInt(samples.length)),
    total_cost_micredits: Number(total),
  };
}

export function scoreHumanReview(observations: readonly HumanReviewObservation[]): {
  human_approval_rate_ppm: number;
} {
  const reviewed = observations
    .map((observation) => HumanReviewObservationSchema.parse(observation))
    .filter((observation) => observation.human_review !== 'not_reviewed');
  if (reviewed.length === 0) return { human_approval_rate_ppm: 0 };

  return {
    human_approval_rate_ppm: ratePpm(
      reviewed.filter((observation) => observation.human_review === 'approved').length,
      reviewed.length,
    ),
  };
}

export function scoreImageEvaluation(observations: readonly ImageEvaluationSample[]) {
  const samples = z.array(ImageEvaluationSampleSchema).min(1).max(10_000).parse(observations);
  const imageOutcomes = samples.map((sample) => ({
    schema_valid: sample.schema_valid,
    integrity_passed: sample.integrity_passed,
    safety_passed: sample.safety_passed,
  }));
  const operations = samples.map((sample) => ({
    available: sample.available,
    failed: sample.failed,
    retry_count: sample.retry_count,
  }));
  const latencies = samples.map((sample) => ({ latency_ms: sample.latency_ms }));
  const costs = samples.map((sample) => ({ cost_micredits: sample.cost_micredits }));
  const humanReviews = samples.map((sample) => ({ human_review: sample.human_review }));

  return {
    sample_count: samples.length,
    metrics: {
      ...scoreImageOutcomeRates(imageOutcomes),
      ...scoreOperationalRates(operations),
      ...scoreHumanReview(humanReviews),
      ...scoreLatency(latencies),
      ...scoreCost(costs),
    },
    scorer_versions: IMAGE_EVALUATION_SCORER_VERSIONS.map((scorer) => ({ ...scorer })),
  };
}
