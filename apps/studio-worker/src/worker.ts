import type {
  StudioObjectStore,
  StudioProviderAdapter,
  StudioProviderContext,
  StudioProviderHandle,
  StudioProviderResult,
  StudioRetryClassification,
} from '@kortix/studio-runtime';
import { STUDIO_MAX_PROVIDER_ATTEMPTS } from '@kortix/studio-runtime';
import { assertStudioTransition } from '@kortix/studio-runtime';
import {
  type StoredStudioAsset,
  type StudioAssetWriter,
  type StudioWorkerAttempt,
  type StudioWorkerConfig,
  StudioWorkerConfigSchema,
  type StudioWorkerJob,
  type StudioWorkerRepository,
  type StudioWorkerTickResult,
} from './contracts';

const RETRY_JITTER_BOUNDS_MS = [5_000, 30_000, 120_000] as const;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

export class StudioProviderCallError extends Error {
  constructor(
    readonly classification: StudioRetryClassification,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'StudioProviderCallError';
  }
}

export interface StudioProviderRegistry {
  get(job: StudioWorkerJob): StudioProviderAdapter | null;
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
  authorization: StudioSubmissionAuthorization;
  assets: StudioAssetWriter;
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
      return await this.process(job, now);
    } catch (error) {
      if (job) {
        try {
          await this.deps.repository.abandonLease({
            jobId: job.jobId,
            workerId: this.owner(job),
            availableAt: new Date(now.getTime() + 5_000),
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
    const attempt = await this.deps.repository.getLatestAttempt(job.jobId);
    if (job.cancellationRequestedAt) {
      return this.cancel(job, attempt, this.deps.providers.get(job), now);
    }

    if (
      attempt &&
      ['submitting', 'reconciling'].includes(attempt.status) &&
      !attempt.providerHandle
    ) {
      const adapter = this.deps.providers.get(job);
      if (!adapter) return this.failUnavailableProvider(job, attempt, now);
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

    const adapter = this.deps.providers.get(job);
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

    const ctx = this.providerContext(job, attempt);
    let handle: StudioProviderHandle;
    try {
      handle = await this.withLeaseHeartbeat(job, () => adapter.submit(ctx, job.input));
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
    if (
      await this.deps.repository.isCancellationRequested({
        jobId: job.jobId,
        workerId: this.owner(job),
      })
    ) {
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
    if (status.status === 'failed') {
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
      return this.cancel(job, attempt, adapter, polledAt, false);
    }
    return this.complete(job, attempt, adapter, handle, polledAt);
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
    if (
      await this.deps.repository.isCancellationRequested({
        jobId: job.jobId,
        workerId: this.owner(job),
      })
    ) {
      return this.cancel(job, attempt, adapter, this.now());
    }
    const stored = await this.withLeaseHeartbeat(job, () =>
      this.deps.assets.persist({ job, attempt, assets: result.assets }),
    );
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

  private async handleProviderFailure(
    job: StudioWorkerJob,
    attempt: StudioWorkerAttempt,
    adapter: StudioProviderAdapter,
    error: unknown,
    now: Date,
  ): Promise<StudioWorkerTickResult> {
    if (error instanceof StudioProviderCallError) {
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

export function createObjectStoreAssetWriter(
  store: StudioObjectStore,
  options: { bucket: string },
): StudioAssetWriter {
  return {
    async persist({ job, attempt, assets }) {
      await store.assertReady();
      const stored: StoredStudioAsset[] = [];
      for (const [index, asset] of assets.entries()) {
        const filename = safeFilename(asset.filename, index);
        const objectKey = `jobs/${job.jobId}/${attempt.attemptId}/${index}-${filename}`;
        await store.putObject({
          bucket: options.bucket,
          key: objectKey,
          body: byteStream(asset.bytes),
          content_type: asset.mime_type,
          size_bytes: asset.bytes.byteLength,
        });
        stored.push({
          kind: asset.kind,
          mimeType: asset.mime_type,
          bucket: options.bucket,
          objectKey,
          checksumSha256: new Bun.CryptoHasher('sha256').update(asset.bytes).digest('hex'),
          sizeBytes: asset.bytes.byteLength,
          filename,
        });
      }
      return stored;
    },
  };
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
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
