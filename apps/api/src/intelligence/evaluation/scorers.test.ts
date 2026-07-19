import { describe, expect, test } from 'bun:test';
import {
  scoreCost,
  scoreHumanReview,
  scoreImageEvaluation,
  scoreImageOutcomeRates,
  scoreLatency,
  scoreOperationalRates,
} from './scorers';

describe('deterministic intelligence evaluation scorers', () => {
  test('scores image outcome rates as rounded fixed-point ppm integers', () => {
    expect(
      scoreImageOutcomeRates([
        { schema_valid: true, integrity_passed: true, safety_passed: true },
        { schema_valid: true, integrity_passed: false, safety_passed: true },
        { schema_valid: false, integrity_passed: false, safety_passed: true },
      ]),
    ).toEqual({
      schema_valid_rate_ppm: 666_667,
      integrity_rate_ppm: 333_333,
      safety_rate_ppm: 1_000_000,
    });
  });

  test('scores availability, terminal failure, and retry incidence per sample', () => {
    expect(
      scoreOperationalRates([
        { available: true, failed: false, retry_count: 0 },
        { available: true, failed: false, retry_count: 2 },
        { available: false, failed: true, retry_count: 1 },
      ]),
    ).toEqual({
      availability_rate_ppm: 666_667,
      failure_rate_ppm: 333_333,
      retry_rate_ppm: 666_667,
    });
  });

  test('scores p50 and p95 latency using nearest-rank integer milliseconds', () => {
    expect(
      scoreLatency([
        { latency_ms: 10 },
        { latency_ms: 20 },
        { latency_ms: 30 },
        { latency_ms: 40 },
      ]),
    ).toEqual({
      latency_p50_ms: 20,
      latency_p95_ms: 40,
    });
  });

  test('scores total and integer mean cost in micredits without floating-point drift', () => {
    expect(
      scoreCost([{ cost_micredits: 100 }, { cost_micredits: 200 }, { cost_micredits: 400 }]),
    ).toEqual({
      mean_cost_micredits: 233,
      total_cost_micredits: 700,
    });
  });

  test('scores human approval only across samples that received human review', () => {
    expect(
      scoreHumanReview([
        { human_review: 'approved' },
        { human_review: 'rejected' },
        { human_review: 'not_reviewed' },
      ]),
    ).toEqual({ human_approval_rate_ppm: 500_000 });
  });

  test('combines image and operational scorers with fixed version identities', () => {
    expect(
      scoreImageEvaluation([
        {
          schema_valid: true,
          integrity_passed: true,
          safety_passed: true,
          available: true,
          failed: false,
          retry_count: 0,
          latency_ms: 100,
          cost_micredits: 100,
          human_review: 'approved',
        },
        {
          schema_valid: false,
          integrity_passed: false,
          safety_passed: true,
          available: false,
          failed: true,
          retry_count: 1,
          latency_ms: 300,
          cost_micredits: 300,
          human_review: 'rejected',
        },
      ]),
    ).toEqual({
      sample_count: 2,
      metrics: {
        schema_valid_rate_ppm: 500_000,
        integrity_rate_ppm: 500_000,
        safety_rate_ppm: 1_000_000,
        availability_rate_ppm: 500_000,
        failure_rate_ppm: 500_000,
        retry_rate_ppm: 500_000,
        human_approval_rate_ppm: 500_000,
        latency_p50_ms: 100,
        latency_p95_ms: 300,
        mean_cost_micredits: 200,
        total_cost_micredits: 400,
      },
      scorer_versions: [
        { scorer_id: 'image.schema_validity', version: '1.0.0' },
        { scorer_id: 'image.integrity', version: '1.0.0' },
        { scorer_id: 'image.safety', version: '1.0.0' },
        { scorer_id: 'system.latency', version: '1.0.0' },
        { scorer_id: 'system.availability', version: '1.0.0' },
        { scorer_id: 'system.failure', version: '1.0.0' },
        { scorer_id: 'system.retry', version: '1.0.0' },
        { scorer_id: 'system.cost', version: '1.0.0' },
        { scorer_id: 'human.image_quality', version: '1.0.0' },
      ],
    });
  });

  test('rejects raw prompt, provider, and response fields at the scorer boundary', () => {
    const unsafeSample = {
      schema_valid: true,
      integrity_passed: true,
      safety_passed: true,
      available: true,
      failed: false,
      retry_count: 0,
      latency_ms: 100,
      cost_micredits: 100,
      human_review: 'approved' as const,
      prompt: 'private prompt',
      provider: 'provider-a',
      raw_response: { output: 'private response' },
    };

    expect(() => scoreImageEvaluation([unsafeSample])).toThrow('Unrecognized key');
  });
});
