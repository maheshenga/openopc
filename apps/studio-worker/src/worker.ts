import type {
  StudioCredentialResolver,
  StudioObjectStore,
  StudioProviderAdapter,
  StudioProviderContext,
  StudioProviderHandle,
  StudioProviderResult,
  StudioReferenceAssetResolver,
  StudioRetryClassification,
} from '@kortix/studio-runtime';
import {
  STUDIO_MAX_PROVIDER_ATTEMPTS,
  StudioObjectStoreError,
  StudioProviderCallError,
  StudioStorageUnavailableError,
  addStudioCreditAmounts,
  calculateStudioImageUsageCredits,
  parseStudioTrustedCostEvidence,
} from '@kortix/studio-runtime';
import { assertStudioTransition } from '@kortix/studio-runtime';
import {
  type StoredStudioAsset,
  type StudioAssetWriter,
  type StudioWorkerAttempt,
  type StudioWorkerConfig,
  StudioWorkerConfigSchema,
  type StudioWorkerJob,
  type StudioWorkerProviderConfig,
  type StudioWorkerRepository,
  type StudioWorkerTickResult,
} from './contracts';
import type { StudioResultStager, StudioStagedResult } from './result-stager';

const RETRY_JITTER_BOUNDS_MS = [5_000, 30_000, 120_000] as const;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

export interface StudioProviderRegistry {
  get(job: StudioWorkerJob): StudioProviderAdapter | null;
  resolve(input: {
    job: StudioWorkerJob;
    config: StudioWorkerProviderConfig;
    credential: Awaited<ReturnType<StudioCredentialResolver['resolve']>>;
    referenceAssets: StudioReferenceAssetResolver;
  }): Promise<StudioProviderAdapter | null>;
}

export type StudioAuthorizationResult =
  | { authorized: true }
  | { authorized: false; code: string; message: string };

export interface StudioSubmissionAuthorization {
  revalidate(job: StudioWorkerJob): Promise<StudioAuthorizationResult>;
}

export type StudioWorkerDependencies = {
  config: StudioWorkerConfig;
  repository: StudioWorkerRepository;
  providers: StudioProviderRegistry;
  credentialResolver: StudioCredentialResolver;
  referenceAssets: StudioReferenceAssetResolver;
  authorization: StudioSubmissionAuthorization;
  assets: StudioAssetWriter;
  stager?: StudioResultStager;
  signal?: AbortSignal;
  now?: () => Date;
  random?: () => number;
};

export class StudioWorker {
  private readonly config: StudioWorkerConfig;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(private readonly deps: StudioWorkerDependencies) {
    this.config = StudioWorkerConfigSchema.parse(deps.config);
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? Math.random;
  }

  async runOnce(): Promise<StudioWorkerTickResult> {
    if (this.deps.signal?.aborted) return { kind: 'idle' };
    let job: StudioWorkerJob | null = null;
    const now = this.now();
    try {
      job = await this.deps.repository.claimNextJob({
        processRole: 'studio-worker',
        workerId: `${this.config.workerId}:${crypto.randomUUID()}`,
        now,
        leaseMs: this.config.leaseMs,
      });
      if (!job) return { kind: 'idle' };
      if (this.deps.signal?.aborted) {
        await this.deps.repository.abandonLease({
          jobId: job.jobId,
          workerId: this.owner(job),
          availableAt: now,
          now,
        });
        return { kind: 'idle' };
      }
      return await this.process(job, now);
    } catch (error) {
      if (job) {
        try {
          await this.deps.repository.abandonLease({
            jobId: job.jobId,
            workerId: this.owner(job),
            availableAt: new Date(now.getTime() + 5_000),
            now,
          });
        } catch {
          // Lease expiry remains the final recovery mechanism.
        }
      }
      return {
        kind: 'error',
        ...(job ? { jobId: job.jobId } : {}),
        code: 'STUDIO_WORKER_INTERNAL_ERROR',
        message: redactStudioDiagnostic(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  private async process(job: StudioWorkerJob, now: Date): Promise<StudioWorkerTickResult> {
    const attempt = await this.deps.repository.getLatestAttempt({
      jobId: job.jobId,
      workerId: this.owner(job),
      now,
    });
    if (attempt && ['submitting', 'submitted', 'polling', 'reconciling'].includes(attempt.status)) {
      const staged = await this.loadDurableStagedResult(job, attempt);
      if (staged.kind === 'failed') {
        return { kind: 'processed', jobId: job.jobId, status: 'failed' };
      }
      if (staged.kind === 'deferred') {
        return { kind: 'processed', jobId: job.jobId, status: 'running' };
      }
      if (staged.kind === 'staged') {
        return this.finalizeStagedResult(job, attempt, staged.result, now);
      }
    }

    if (job.cancellationRequestedAt) {
      if (attempt && ['submitting', 'reconciling'].includes(attempt.status)) {
        await this.deferUnknown(
          job,
          attempt,
          'Cancellation is pending while the provider submission outcome remains unknown',
          now,
        );
        return { kind: 'processed', jobId: job.jobId, status: 'running' };
      }
      return this.cancel(job, attempt, this.deps.providers.get(job), now);
    }

    if (attempt && ['submitting', 'reconciling'].includes(attempt.status)) {
      const adapter = this.deps.providers.get(job);
      if (!adapter) {
        await this.deferUnknown(
          job,
          attempt,
          'Provider reconciliation is unavailable; operator review is required',
          now,
        );
        return { kind: 'processed', jobId: job.jobId, status: 'running' };
      }
      return this.reconcile(job, attempt, adapter, now);
    }

    if (attempt?.providerHandle && ['submitted', 'polling'].includes(attempt.status)) {
      const adapter = this.deps.providers.get(job);
      if (!adapter) return this.failUnavailableProvider(job, attempt, now);
      return this.poll(job, attempt, adapter, attempt.providerHandle, now);
    }

    if (
      attempt?.status === 'failed' &&
      attempt.retryClassification &&
      job.attemptCount >= STUDIO_MAX_PROVIDER_ATTEMPTS
    ) {
      await this.fail(
        job,
        attempt,
        'STUDIO_RETRY_EXHAUSTED',
        'Provider retry budget exhausted',
        attempt.retryClassification,
        now,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'failed' };
    }

    return this.submit(job, now);
  }

  private async submit(job: StudioWorkerJob, now: Date): Promise<StudioWorkerTickResult> {
    const providerConfig = await this.deps.repository.loadProviderConfigForSubmission({
      jobId: job.jobId,
      workerId: this.owner(job),
      now,
    });
    const validProviderConfig =
      providerConfig !== null &&
      providerConfig.providerConfigId === job.providerConfigId &&
      providerConfig.accountId === job.accountId &&
      providerConfig.projectId === job.projectId &&
      providerConfig.provider === job.provider &&
      providerSupportsCapability(providerConfig.capabilityMap, job.capability);
    job.providerEnabled = validProviderConfig && providerConfig.enabled;
    if (validProviderConfig) job.credentialBinding = providerConfig.credentialBinding;

    if (!job.providerEnabled || !providerConfig) {
      await this.deps.repository.markCancelled({
        jobId: job.jobId,
        workerId: this.owner(job),
        reason: 'provider_config_unavailable',
        code: 'STUDIO_PROVIDER_UNAVAILABLE',
        message: 'The Studio provider configuration is unavailable or disabled',
        now: this.now(),
      });
      return { kind: 'processed', jobId: job.jobId, status: 'cancelled' };
    }

    const authorization = await this.deps.authorization.revalidate(job);
    if (!authorization.authorized) {
      await this.deps.repository.markCancelled({
        jobId: job.jobId,
        workerId: this.owner(job),
        reason: 'authorization_revoked',
        code: publicAuthorizationErrorCode(authorization.code),
        message: authorization.message,
        now: this.now(),
      });
      return { kind: 'processed', jobId: job.jobId, status: 'cancelled' };
    }

    let credential: Awaited<ReturnType<StudioCredentialResolver['resolve']>>;
    try {
      credential = await this.deps.credentialResolver.resolve({
        accountId: job.accountId,
        projectId: job.projectId,
        binding: job.credentialBinding as never,
      });
    } catch {
      await this.deps.repository.markCancelled({
        jobId: job.jobId,
        workerId: this.owner(job),
        reason: 'credential_unavailable',
        code: 'STUDIO_PROVIDER_CREDENTIAL_UNAVAILABLE',
        message: 'The Studio provider credential is unavailable',
        now: this.now(),
      });
      return { kind: 'processed', jobId: job.jobId, status: 'cancelled' };
    }

    const adapter = await this.deps.providers.resolve({
      job,
      config: providerConfig,
      credential,
      referenceAssets: this.deps.referenceAssets,
    });
    if (!adapter) return this.failUnavailableProvider(job, undefined, now);

    const submissionKey = `${job.jobId}:${job.attemptCount + 1}:${crypto.randomUUID()}`;
    const attempt = await this.deps.repository.prepareAttempt({
      jobId: job.jobId,
      workerId: this.owner(job),
      submissionKey,
      adapterVersion: 'studio-worker-v1',
      providerConfigVersion: providerConfig.versionToken,
      now,
    });
    if (!attempt) {
      await this.deps.repository.abandonLease({
        jobId: job.jobId,
        workerId: this.owner(job),
        availableAt: new Date(this.now().getTime() + 1_000),
        now: this.now(),
      });
      return {
        kind: 'error',
        jobId: job.jobId,
        code: 'STUDIO_ATTEMPT_CONFLICT',
        message: 'Attempt could not be prepared',
      };
    }
    if (job.status === 'queued') {
      assertStudioTransition('queued', 'running');
      job.status = 'running';
    }
    if (this.deps.signal?.aborted) {
      return this.scheduleRetryOrFail(
        job,
        attempt,
        'retryable',
        'Studio worker stopped before provider dispatch',
        undefined,
        this.now(),
      );
    }

    const ctx = this.providerContext(job, attempt);
    let handle: StudioProviderHandle;
    try {
      const submission = await this.withLeaseHeartbeat(job, () => adapter.submit(ctx, job.input));
      if (submission.kind === 'completed') {
        if (submission.provider !== job.provider || submission.submission_key !== submissionKey) {
          throw new StudioProviderCallError(
            'unknown_outcome',
            'Provider returned a mismatched completed submission identity',
          );
        }
        const stager = this.deps.stager;
        if (!stager || !job.pricingSnapshot) {
          throw new StudioProviderCallError(
            'terminal',
            'Completed provider submissions are not enabled in this worker version',
          );
        }
        let staged: StudioStagedResult;
        try {
          staged = await this.withLeaseHeartbeat(job, () =>
            stager.stage({
              ...this.stagingIdentity(job, attempt),
              assets: submission.result.assets,
              usage: this.pricedUsage(job, submission.result).usage,
            }),
          );
        } catch (error) {
          return this.handleStagingFailure(job, attempt, submission.result, error, this.now());
        }
        return this.finalizeStagedResult(job, attempt, staged, this.now());
      }
      handle = submission.handle;
      if (handle.submission_key !== submissionKey) {
        throw new StudioProviderCallError(
          'unknown_outcome',
          'Provider returned a mismatched submission key',
        );
      }
    } catch (error) {
      return this.handleProviderFailure(job, attempt, adapter, error, this.now());
    }
    const durableHandle = allowlistedProviderHandle(handle);
    const submittedAt = this.now();
    await this.deps.repository.markSubmitted({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      handle: durableHandle,
      now: submittedAt,
    });
    attempt.providerHandle = durableHandle;
    attempt.status = 'submitted';
    return this.poll(job, attempt, adapter, durableHandle, submittedAt);
  }

  private async reconcile(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    adapter: StudioProviderAdapter,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    const reconcile = adapter.reconcile;
    if (!reconcile) {
      await this.deferUnknown(
        job,
        attempt,
        'Provider does not support submission reconciliation',
        now,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'running' };
    }
    let reconciled: Awaited<ReturnType<NonNullable<StudioProviderAdapter['reconcile']>>>;
    try {
      reconciled = await this.withLeaseHeartbeat(job, () =>
        reconcile(this.providerContext(job, attempt), attempt.submissionKey),
      );
    } catch (error) {
      if (
        error instanceof StudioProviderCallError &&
        (error.classification === 'retryable' || error.classification === 'rate_limited')
      ) {
        await this.recordTrustedCostEvidence(
          job,
          attempt,
          error.trustedCostEvidence,
          'unknown',
          this.now(),
        );
        return this.scheduleContinuation(
          job,
          attempt,
          'reconciling',
          error.classification,
          error.message,
          error.retryAfterMs,
          this.now(),
        );
      }
      await this.deferUnknown(
        job,
        attempt,
        error instanceof Error ? error.message : String(error),
        this.now(),
      );
      return { kind: 'processed', jobId: job.jobId, status: 'running' };
    }
    const reconciledAt = this.now();
    if (reconciled === 'unknown') {
      await this.deferUnknown(
        job,
        attempt,
        'Provider could not determine the submission outcome',
        reconciledAt,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'running' };
    }
    if (reconciled === 'not-found') {
      return this.scheduleRetryOrFail(
        job,
        attempt,
        'unknown_outcome',
        'Provider confirmed submission was not created',
        undefined,
        reconciledAt,
      );
    }
    if (reconciled.submission_key !== attempt.submissionKey) {
      await this.deferUnknown(
        job,
        attempt,
        'Provider reconciliation returned a mismatched submission key',
        reconciledAt,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'running' };
    }
    const durableHandle = allowlistedProviderHandle(reconciled);
    await this.deps.repository.markSubmitted({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      handle: durableHandle,
      now: reconciledAt,
    });
    attempt.providerHandle = durableHandle;
    attempt.status = 'submitted';
    return this.poll(job, attempt, adapter, durableHandle, reconciledAt);
  }

  private async poll(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    adapter: StudioProviderAdapter,
    handle: StudioProviderHandle,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    let status: Awaited<ReturnType<StudioProviderAdapter['poll']>>;
    try {
      status = await this.withLeaseHeartbeat(job, () =>
        adapter.poll(this.providerContext(job, attempt), handle),
      );
    } catch (error) {
      if (
        error instanceof StudioProviderCallError &&
        (error.classification === 'retryable' || error.classification === 'rate_limited')
      ) {
        await this.recordTrustedCostEvidence(
          job,
          attempt,
          error.trustedCostEvidence,
          'unknown',
          this.now(),
        );
        return this.scheduleContinuation(
          job,
          attempt,
          'polling',
          error.classification,
          error.message,
          error.retryAfterMs,
          this.now(),
        );
      }
      return this.handleProviderFailure(job, attempt, adapter, error, this.now());
    }
    const polledAt = this.now();
    if (status.status === 'succeeded') {
      return this.complete(job, attempt, adapter, handle, polledAt);
    }
    if (status.status === 'failed') {
      await this.recordTrustedCostEvidence(
        job,
        attempt,
        status.trusted_cost_evidence,
        'failed',
        polledAt,
      );
      await this.fail(
        job,
        attempt,
        'STUDIO_PROVIDER_REJECTED',
        'Provider reported a terminal failure',
        'terminal',
        polledAt,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'failed' };
    }
    if (status.status === 'cancelled') {
      await this.recordTrustedCostEvidence(
        job,
        attempt,
        status.trusted_cost_evidence,
        'cancelled',
        polledAt,
      );
      return this.cancel(job, attempt, adapter, polledAt, false);
    }
    if (
      await this.deps.repository.isCancellationRequested({
        jobId: job.jobId,
        workerId: this.owner(job),
        now: polledAt,
      })
    ) {
      await this.recordTrustedCostEvidence(
        job,
        attempt,
        status.trusted_cost_evidence,
        'cancelled',
        polledAt,
      );
      return this.cancel(job, attempt, adapter, polledAt);
    }
    if (status.status === 'submitted' || status.status === 'running') {
      await this.deps.repository.schedulePoll({
        jobId: job.jobId,
        attemptId: attempt.attemptId,
        workerId: this.owner(job),
        availableAt: new Date(polledAt.getTime() + this.config.pollIntervalMs),
        progress: status.progress,
        now: polledAt,
      });
      return { kind: 'processed', jobId: job.jobId, status: 'running' };
    }
    if (status.status === 'unknown') {
      return this.reconcile(job, attempt, adapter, polledAt);
    }
    throw new StudioProviderCallError('terminal', 'Provider returned an invalid status');
  }

  private async complete(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    adapter: StudioProviderAdapter,
    handle: StudioProviderHandle,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    const result = await this.withLeaseHeartbeat(job, () =>
      adapter.fetchResult(this.providerContext(job, attempt), handle),
    );
    const stager = this.deps.stager;
    if (stager && job.pricingSnapshot) {
      let staged: StudioStagedResult;
      try {
        staged = await this.withLeaseHeartbeat(job, () =>
          stager.stage({
            ...this.stagingIdentity(job, attempt),
            assets: result.assets,
            usage: this.pricedUsage(job, result).usage,
          }),
        );
      } catch (error) {
        return this.handleStagingFailure(job, attempt, result, error, this.now());
      }
      return this.finalizeStagedResult(job, attempt, staged, this.now(), adapter, handle);
    }
    let stored: StoredStudioAsset[];
    try {
      stored = await this.withLeaseHeartbeat(job, () =>
        this.deps.assets.persist({ job, attempt, assets: result.assets }),
      );
    } catch (error) {
      if (error instanceof StudioProviderCallError && error.classification === 'terminal') {
        await this.fail(
          job,
          attempt,
          'STUDIO_ASSET_INVALID',
          error.message,
          error.classification,
          this.now(),
        );
        return { kind: 'processed', jobId: job.jobId, status: 'failed' };
      }
      throw error;
    }
    const actualCredits = actualCreditsFrom(result, job.reservedCredits);
    const outcome = await this.deps.repository.finalizeSuccess({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      actualCredits,
      assets: stored,
      now: this.now(),
    });
    if (outcome === 'cancelled') {
      try {
        await adapter.cancel(this.providerContext(job, attempt), handle);
      } catch {
        // Kortix already committed cancellation; upstream cancellation is best effort.
      }
      return { kind: 'processed', jobId: job.jobId, status: 'cancelled' };
    }
    assertStudioTransition(job.status, 'succeeded');
    return { kind: 'processed', jobId: job.jobId, status: 'succeeded' };
  }

  private async loadDurableStagedResult(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
  ): Promise<
    | { kind: 'none' }
    | { kind: 'staged'; result: StudioStagedResult }
    | { kind: 'deferred' }
    | { kind: 'failed' }
  > {
    if (!this.deps.stager || !job.pricingSnapshot) return { kind: 'none' };
    try {
      const result = await this.deps.stager.loadManifest(this.stagingIdentity(job, attempt));
      return result ? { kind: 'staged', result } : { kind: 'none' };
    } catch (error) {
      if (error instanceof StudioProviderCallError && error.classification === 'terminal') {
        await this.fail(
          job,
          attempt,
          'STUDIO_ASSET_INVALID',
          error.message,
          error.classification,
          this.now(),
        );
        return { kind: 'failed' };
      }
      if (
        (error instanceof StudioProviderCallError && error.classification === 'unknown_outcome') ||
        error instanceof StudioStorageUnavailableError
      ) {
        await this.deferUnknown(job, attempt, error.message, this.now());
        return { kind: 'deferred' };
      }
      throw error;
    }
  }

  private async finalizeStagedResult(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    staged: StudioStagedResult,
    now: Date,
    adapter?: StudioProviderAdapter,
    handle?: StudioProviderHandle,
  ): Promise<StudioWorkerTickResult> {
    const priced = this.pricedUsage(job, {
      assets: staged.manifest.assets.map(() => ({}) as never),
      usage: staged.manifest.usage,
    });
    await this.deps.repository.recordStagedManifest({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      submissionKind: attempt.providerHandle ? 'async' : 'completed',
      manifestKey: staged.manifestKey,
      manifestChecksum: staged.manifestChecksum,
      now,
    });
    const costOutcome = attempt.costRecordedAt ? attempt.costOutcome : 'succeeded';
    if (costOutcome !== 'succeeded' && costOutcome !== 'unknown') {
      throw new StudioProviderCallError(
        'terminal',
        'Studio attempt cost outcome cannot be finalized as success',
      );
    }
    await this.deps.repository.recordAttemptCost({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      usage: priced.usage,
      upstreamCostCredits: priced.upstreamCostCredits,
      outcome: costOutcome,
      now,
    });
    const recordedAttemptCost = await this.deps.repository.getRecordedAttemptCostTotal({
      jobId: job.jobId,
      workerId: this.owner(job),
      now,
    });
    const outcome = await this.deps.repository.finalizeSuccess({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      actualCredits: addStudioCreditAmounts([recordedAttemptCost, priced.outputMarkupCredits]),
      assets: staged.assets,
      now: this.now(),
    });
    if (outcome === 'cancelled') {
      if (adapter && handle) {
        try {
          await adapter.cancel(this.providerContext(job, attempt), handle);
        } catch {
          // Kortix already committed cancellation; upstream cancellation is best effort.
        }
      }
      return { kind: 'processed', jobId: job.jobId, status: 'cancelled' };
    }
    assertStudioTransition(job.status, 'succeeded');
    return { kind: 'processed', jobId: job.jobId, status: 'succeeded' };
  }

  private stagingIdentity(job: StudioWorkerJob, attempt: StudioWorkerAttempt) {
    const pricing = job.pricingSnapshot;
    const providerConfigVersion = attempt.providerConfigVersion ?? job.providerConfigVersion;
    if (!pricing || !providerConfigVersion) {
      throw new StudioProviderCallError('terminal', 'Studio staging snapshot identity is missing');
    }
    return {
      accountId: job.accountId,
      projectId: job.projectId,
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      submissionKey: attempt.submissionKey,
      providerConfigId: job.providerConfigId,
      providerConfigVersion,
      pricingCatalogId: pricing.pricing_catalog_id,
      pricingVersion: pricing.version,
    };
  }

  private pricedUsage(
    job: StudioWorkerJob,
    result: Pick<StudioProviderResult, 'assets' | 'usage'>,
  ) {
    const pricing = job.pricingSnapshot;
    if (!pricing) {
      const actualCredits = actualCreditsFrom(result as StudioProviderResult, job.reservedCredits);
      return {
        usage: { output_count: result.assets.length },
        upstreamCostCredits: actualCredits,
        actualCredits,
        outputMarkupCredits: 0,
      };
    }
    const priced = calculateStudioImageUsageCredits({
      pricing,
      outputCount: result.assets.length,
    });
    return {
      usage: priced.usage,
      upstreamCostCredits: priced.upstream_cost_credits,
      actualCredits: addStudioCreditAmounts([
        priced.upstream_cost_credits,
        priced.output_markup_credits,
      ]),
      outputMarkupCredits: priced.output_markup_credits,
    };
  }

  private async handleStagingFailure(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    result: Pick<StudioProviderResult, 'assets' | 'usage'>,
    error: unknown,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    const priced = this.pricedUsage(job, result);
    const terminal =
      error instanceof StudioProviderCallError && error.classification === 'terminal';
    await this.deps.repository.recordAttemptCost({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      usage: priced.usage,
      upstreamCostCredits: priced.upstreamCostCredits,
      outcome: 'succeeded',
      now,
    });
    if (terminal) {
      await this.fail(
        job,
        attempt,
        'STUDIO_ASSET_INVALID',
        error instanceof Error ? error.message : 'Studio result asset is invalid',
        'terminal',
        now,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'failed' };
    }
    await this.deferUnknown(
      job,
      attempt,
      error instanceof Error ? error.message : 'Studio result staging is ambiguous',
      now,
    );
    return { kind: 'processed', jobId: job.jobId, status: 'running' };
  }

  private async handleProviderFailure(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    adapter: StudioProviderAdapter,
    error: unknown,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    if (error instanceof StudioProviderCallError) {
      await this.recordTrustedCostEvidence(
        job,
        attempt,
        error.trustedCostEvidence,
        error.classification === 'unknown_outcome' ? 'unknown' : 'failed',
        now,
      );
      if (error.classification === 'unknown_outcome') {
        return this.reconcile(job, attempt, adapter, now);
      }
      if (error.classification === 'terminal') {
        await this.fail(
          job,
          attempt,
          'STUDIO_PROVIDER_REJECTED',
          error.message,
          error.classification,
          now,
        );
        return { kind: 'processed', jobId: job.jobId, status: 'failed' };
      }
      return this.scheduleRetryOrFail(
        job,
        attempt,
        error.classification,
        error.message,
        error.retryAfterMs,
        now,
      );
    }
    await this.fail(
      job,
      attempt,
      'STUDIO_PROVIDER_REJECTED',
      error instanceof Error ? error.message : String(error),
      'terminal',
      now,
    );
    return { kind: 'processed', jobId: job.jobId, status: 'failed' };
  }

  private async recordTrustedCostEvidence(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    rawEvidence: unknown,
    outcome: 'failed' | 'cancelled' | 'unknown',
    now: Date,
  ): Promise<void> {
    if (!job.pricingSnapshot) return;
    const evidence = parseStudioTrustedCostEvidence(rawEvidence);
    if (!evidence) return;
    const priced = calculateStudioImageUsageCredits({
      pricing: job.pricingSnapshot,
      outputCount: evidence.usage.output_count,
    });
    const persistedOutcome = attempt.costRecordedAt ? attempt.costOutcome : null;
    if (
      attempt.costRecordedAt &&
      persistedOutcome !== 'succeeded' &&
      persistedOutcome !== 'failed' &&
      persistedOutcome !== 'cancelled' &&
      persistedOutcome !== 'unknown'
    ) {
      throw new Error('Studio attempt recorded cost has an invalid immutable outcome');
    }
    await this.deps.repository.recordAttemptCost({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      usage: priced.usage,
      upstreamCostCredits: priced.upstream_cost_credits,
      outcome: persistedOutcome ?? outcome,
      now,
    });
    if (attempt.costRecordedAt) return;
    attempt.upstreamUsage = priced.usage;
    attempt.upstreamCostCredits = priced.upstream_cost_credits;
    attempt.costOutcome = outcome;
    attempt.costRecordedAt = now;
  }

  private async scheduleRetryOrFail(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    classification: StudioRetryClassification,
    message: string,
    retryAfterMs: number | undefined,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    if (attempt.attemptNumber >= STUDIO_MAX_PROVIDER_ATTEMPTS) {
      await this.fail(
        job,
        attempt,
        publicProviderErrorCode(classification),
        message,
        classification,
        now,
      );
      return { kind: 'processed', jobId: job.jobId, status: 'failed' };
    }
    const jitterBound =
      RETRY_JITTER_BOUNDS_MS[
        Math.min(attempt.attemptNumber - 1, RETRY_JITTER_BOUNDS_MS.length - 1)
      ] ?? 120_000;
    const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * jitterBound);
    const delay = Math.max(jitter, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
    await this.deps.repository.scheduleRetry({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      classification,
      availableAt: new Date(now.getTime() + delay),
      message: redactStudioDiagnostic(message),
      now,
    });
    return { kind: 'processed', jobId: job.jobId, status: 'running' };
  }

  private async scheduleContinuation(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    phase: 'polling' | 'reconciling',
    classification: StudioRetryClassification,
    message: string,
    retryAfterMs: number | undefined,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    const jitterBound =
      RETRY_JITTER_BOUNDS_MS[
        Math.min(attempt.attemptNumber - 1, RETRY_JITTER_BOUNDS_MS.length - 1)
      ] ?? 120_000;
    const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * jitterBound);
    const delay = Math.max(jitter, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
    await this.deps.repository.scheduleContinuation({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      phase,
      classification,
      availableAt: new Date(now.getTime() + delay),
      code: publicProviderErrorCode(classification),
      message: redactStudioDiagnostic(message),
      now,
    });
    return { kind: 'processed', jobId: job.jobId, status: 'running' };
  }

  private async deferUnknown(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    message: string,
    now: Date,
  ): Promise<void> {
    await this.deps.repository.markReconciling({
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      workerId: this.owner(job),
      availableAt: new Date(now.getTime() + this.config.unknownOutcomeTimeoutMs),
      message: redactStudioDiagnostic(message),
      now,
    });
  }

  private async fail(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt | undefined,
    code: string,
    message: string,
    classification: StudioRetryClassification,
    now: Date,
  ): Promise<void> {
    assertStudioTransition(job.status, 'failed');
    await this.deps.repository.markFailed({
      jobId: job.jobId,
      ...(attempt ? { attemptId: attempt.attemptId } : {}),
      workerId: this.owner(job),
      code,
      message: redactStudioDiagnostic(message),
      classification,
      now,
    });
  }

  private async cancel(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt | null,
    adapter: StudioProviderAdapter | null,
    now: Date,
    callProvider = true,
  ): Promise<StudioWorkerTickResult> {
    const handle = attempt?.providerHandle ?? job.providerHandle;
    if (callProvider && adapter && attempt && handle) {
      try {
        await this.withLeaseHeartbeat(job, () =>
          adapter.cancel(this.providerContext(job, attempt), handle),
        );
      } catch {
        // Cancellation is best effort upstream and definitive in Kortix.
      }
    }
    assertStudioTransition(job.status, 'cancelled');
    const reason = attempt ? 'cancelled_after_submission' : 'cancelled_before_submission';
    await this.deps.repository.markCancelled({
      jobId: job.jobId,
      ...(attempt ? { attemptId: attempt.attemptId } : {}),
      workerId: this.owner(job),
      reason,
      now,
    });
    return { kind: 'processed', jobId: job.jobId, status: 'cancelled' };
  }

  private providerContext(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
  ): StudioProviderContext {
    return { correlationId: job.jobId, submissionKey: attempt.submissionKey };
  }

  private async failUnavailableProvider(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt | undefined,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    await this.fail(
      job,
      attempt,
      'STUDIO_PROVIDER_UNAVAILABLE',
      'Provider adapter is unavailable',
      'terminal',
      now,
    );
    return { kind: 'processed', jobId: job.jobId, status: 'failed' };
  }

  private owner(job: StudioWorkerJob): string {
    if (!job.leaseOwner) throw new Error('Studio job has no claim fencing owner');
    return job.leaseOwner;
  }

  private async withLeaseHeartbeat<T>(
    job: StudioWorkerJob,
    operation: () => Promise<T>,
  ): Promise<T> {
    let lost = false;
    let stopped = false;
    let pending = Promise.resolve();
    const heartbeat = () => {
      pending = pending.then(async () => {
        if (stopped || lost) return;
        try {
          const owned = await this.deps.repository.heartbeatLease({
            jobId: job.jobId,
            workerId: this.owner(job),
            now: this.now(),
            leaseMs: this.config.leaseMs,
          });
          if (!owned) lost = true;
        } catch {
          lost = true;
        }
      });
      return pending;
    };

    await heartbeat();
    if (lost) throw new Error('Studio job lease was lost before provider I/O');
    const interval = setInterval(
      () => void heartbeat(),
      Math.max(5, Math.floor(this.config.leaseMs / 3)),
    );
    try {
      const result = await operation();
      await pending;
      if (lost) {
        throw new StudioProviderCallError(
          'unknown_outcome',
          'Studio job lease was lost after provider I/O',
        );
      }
      return result;
    } finally {
      stopped = true;
      clearInterval(interval);
      await pending;
    }
  }
}

export function createObjectStoreAssetWriter(store: StudioObjectStore): StudioAssetWriter {
  return {
    async persist({ job, attempt, assets }) {
      await store.assertReady();
      const stored: StoredStudioAsset[] = [];
      for (const [index, asset] of assets.entries()) {
        if (!asset.replayable_within_attempt) {
          throw new StudioProviderCallError(
            'terminal',
            'Studio provider assets must be replayable within an attempt',
          );
        }
        const filename = safeFilename(asset.filename, index);
        const objectKey = `jobs/${job.jobId}/${attempt.attemptId}/${index}-${filename}`;
        const checksumSha256 = await hashBody(await asset.openBody(), asset.size_bytes);
        try {
          await store.putObject({
            key: objectKey,
            body: await asset.openBody(),
            content_type: asset.mime_type,
            size_bytes: asset.size_bytes,
            checksum_sha256: checksumSha256,
            metadata: { project_id: job.projectId, attempt_id: attempt.attemptId },
          });
        } catch (error) {
          if (
            error instanceof StudioObjectStoreError &&
            (error.code === 'CHECKSUM_MISMATCH' || error.code === 'SIZE_MISMATCH')
          ) {
            throw new StudioProviderCallError(
              'terminal',
              'Studio provider asset body changed between replayable reads',
            );
          }
          throw error;
        }
        stored.push({
          kind: asset.kind,
          mimeType: asset.mime_type,
          bucket: store.namespace,
          objectKey,
          checksumSha256,
          sizeBytes: asset.size_bytes,
          filename,
        });
      }
      return stored;
    },
  };
}

async function hashBody(
  body: ReadableStream<Uint8Array>,
  expectedSizeBytes: number,
): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  const reader = body.getReader();
  let sizeBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    sizeBytes += next.value.byteLength;
    hasher.update(next.value);
  }
  if (sizeBytes !== expectedSizeBytes) {
    throw new StudioProviderCallError(
      'terminal',
      `Studio provider asset size mismatch: expected ${expectedSizeBytes}, got ${sizeBytes}`,
    );
  }
  return hasher.digest('hex');
}

function actualCreditsFrom(result: StudioProviderResult, reservedCredits: number): number {
  const raw = result.usage?.actual_credits;
  const parsed =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : reservedCredits;
  return Math.min(parsed, reservedCredits);
}

function publicProviderErrorCode(classification: StudioRetryClassification): string {
  if (classification === 'rate_limited') return 'STUDIO_PROVIDER_RATE_LIMITED';
  if (classification === 'unknown_outcome') return 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN';
  if (classification === 'retryable') return 'STUDIO_PROVIDER_TIMEOUT';
  return 'STUDIO_PROVIDER_REJECTED';
}

function publicAuthorizationErrorCode(code: string): string {
  if (
    code === 'STUDIO_PROVIDER_UNAVAILABLE' ||
    code === 'STUDIO_PROVIDER_CONFIG_INVALID' ||
    code === 'STUDIO_PROVIDER_CREDENTIAL_UNAVAILABLE'
  ) {
    return code;
  }
  return 'STUDIO_PERMISSION_DENIED';
}

function providerSupportsCapability(
  capabilityMap: Record<string, unknown>,
  capability: string,
): boolean {
  const capabilities = capabilityMap.capabilities;
  return (
    (Array.isArray(capabilities) && capabilities.includes(capability)) ||
    capabilityMap[capability] === true ||
    (typeof capabilityMap[capability] === 'object' && capabilityMap[capability] !== null)
  );
}

function allowlistedProviderHandle(handle: StudioProviderHandle): StudioProviderHandle {
  return {
    provider: handle.provider,
    id: handle.id,
    submission_key: handle.submission_key,
  };
}

function safeFilename(value: string, index: number): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return safe || `asset-${index}.bin`;
}

export function redactStudioDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*basic\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:["'])?(?:api[_-]?key|access[_-]?token|secret|password|token)(?:["'])?\s*[=:]\s*(?:["'])?)[^"'\s,;}&]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|secret|password|token|key)=)[^&#\s]+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 1_000);
}

export type {
  StudioAssetWriter,
  StudioWorkerAttempt,
  StudioWorkerJob,
  StudioWorkerRepository,
  StudioWorkerTickResult,
} from './contracts';
