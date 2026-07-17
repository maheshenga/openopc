import type { StudioJobInput, StudioJobState } from '@kortix/api-contract';
import type { StudioProviderHandle, StudioRetryClassification } from '@kortix/studio-runtime';
import type {
  StoredStudioAsset,
  StudioWorkerAttempt,
  StudioWorkerEvent,
  StudioWorkerJob,
  StudioWorkerRepository,
} from './contracts';

const DEFAULT_NOW = new Date('2026-07-15T10:00:00.000Z');

type MutableJob = StudioWorkerJob & { terminalStatus?: 'succeeded' | 'failed' | 'cancelled' };

export function createMemoryStudioWorkerRepository(): StudioWorkerRepository & {
  seedJob(input?: Partial<StudioWorkerJob>): StudioWorkerJob;
  seedAttempt(jobId: string, input?: Partial<StudioWorkerAttempt>): StudioWorkerAttempt;
  getJob(jobId: string): (Omit<StudioWorkerJob, 'status'> & { status: StudioJobState }) | null;
  getAttempts(jobId: string): StudioWorkerAttempt[];
  getEvents(jobId: string): StudioWorkerEvent[];
  getAssets(jobId: string): StoredStudioAsset[];
  getHeartbeatCount(jobId: string): number;
  requestCancellation(jobId: string, now?: Date): void;
} {
  const jobs = new Map<string, MutableJob>();
  const attempts = new Map<string, StudioWorkerAttempt[]>();
  const events = new Map<string, StudioWorkerEvent[]>();
  const assets = new Map<string, StoredStudioAsset[]>();
  const heartbeatCounts = new Map<string, number>();

  function append(
    jobId: string,
    type: StudioWorkerEvent['type'],
    payload: Record<string, unknown> = {},
    now = DEFAULT_NOW,
  ) {
    const list = events.get(jobId) ?? [];
    list.push({ type, payload, createdAt: now });
    events.set(jobId, list);
  }

  function ownedJob(jobId: string, workerId: string): MutableJob {
    const job = jobs.get(jobId);
    if (!job || job.leaseOwner !== workerId)
      throw new Error('Studio job lease is not owned by this worker');
    return job;
  }

  const repository: ReturnType<typeof createMemoryStudioWorkerRepository> = {
    seedJob(input = {}) {
      const jobId = input.jobId ?? crypto.randomUUID();
      const job: MutableJob = {
        jobId,
        accountId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        actorUserId: crypto.randomUUID(),
        actorType: 'user',
        actingTokenId: null,
        agentName: null,
        sessionId: null,
        capability: 'image.generate',
        providerConfigId: crypto.randomUUID(),
        providerEnabled: true,
        provider: 'fake',
        model: 'fake-image-v1',
        input: defaultInput(),
        status: 'queued',
        attemptCount: 0,
        providerHandle: null,
        cancellationRequestedAt: null,
        reservedCredits: 1,
        actualCredits: null,
        errorCode: null,
        errorMessage: null,
        availableAt: DEFAULT_NOW,
        createdAt: new Date(DEFAULT_NOW.getTime() + jobs.size),
        leaseOwner: null,
        leaseExpiresAt: null,
        credentialBinding: { kind: 'none' },
        pricingSnapshot: null,
        ...input,
      };
      jobs.set(jobId, job);
      attempts.set(jobId, []);
      assets.set(jobId, []);
      events.set(jobId, []);
      append(jobId, 'queued', {}, job.createdAt);
      return cloneJob(job);
    },

    seedAttempt(jobId, input = {}) {
      const job = jobs.get(jobId);
      if (!job) throw new Error('Unknown Studio job');
      const list = attempts.get(jobId) ?? [];
      const attempt: StudioWorkerAttempt = {
        attemptId: crypto.randomUUID(),
        jobId,
        attemptNumber: input.attemptNumber ?? Math.max(1, list.length + 1),
        submissionKey: input.submissionKey ?? `${jobId}:${list.length + 1}:seed`,
        status: 'submitting',
        providerHandle: null,
        retryClassification: null,
        startedAt: DEFAULT_NOW,
        endedAt: null,
        providerConfigVersion: job.createdAt.toISOString(),
        submissionKind: 'async',
        stagingManifestKey: null,
        stagingManifestChecksum: null,
        costOutcome: null,
        costRecordedAt: null,
        upstreamUsage: null,
        upstreamCostCredits: null,
        ...input,
      };
      list.push(attempt);
      attempts.set(jobId, list);
      return cloneAttempt(attempt);
    },

    getJob(jobId) {
      const job = jobs.get(jobId);
      if (!job) return null;
      return { ...cloneJob(job), status: job.terminalStatus ?? job.status };
    },

    getAttempts(jobId) {
      return (attempts.get(jobId) ?? []).map(cloneAttempt);
    },

    getEvents(jobId) {
      return (events.get(jobId) ?? []).map((event) => ({
        ...event,
        payload: { ...event.payload },
      }));
    },

    getAssets(jobId) {
      return (assets.get(jobId) ?? []).map((asset) => ({ ...asset }));
    },

    getHeartbeatCount(jobId) {
      return heartbeatCounts.get(jobId) ?? 0;
    },

    requestCancellation(jobId, now = DEFAULT_NOW) {
      const job = jobs.get(jobId);
      if (!job || job.terminalStatus) return;
      job.cancellationRequestedAt = now;
    },

    async claimNextJob(input) {
      assertProcessRole(input.processRole);
      const candidate = [...jobs.values()]
        .filter((job) => !job.terminalStatus)
        .filter((job) => job.availableAt.getTime() <= input.now.getTime())
        .filter((job) => !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= input.now.getTime())
        .sort(
          (a, b) =>
            a.availableAt.getTime() - b.availableAt.getTime() ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )[0];
      if (!candidate) return null;
      candidate.leaseOwner = input.workerId;
      candidate.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      append(candidate.jobId, 'claimed', { worker_id: input.workerId }, input.now);
      return cloneJob(candidate);
    },

    async getLatestAttempt(jobId) {
      const list = attempts.get(jobId) ?? [];
      const latest = list.at(-1);
      return latest ? cloneAttempt(latest) : null;
    },

    async heartbeatLease(input) {
      const job = jobs.get(input.jobId);
      if (!job || job.terminalStatus || job.leaseOwner !== input.workerId) return false;
      heartbeatCounts.set(input.jobId, (heartbeatCounts.get(input.jobId) ?? 0) + 1);
      job.leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs);
      return true;
    },

    async isCancellationRequested(input) {
      return ownedJob(input.jobId, input.workerId).cancellationRequestedAt !== null;
    },

    async loadProviderConfigForSubmission(input) {
      const job = ownedJob(input.jobId, input.workerId);
      return {
        providerConfigId: job.providerConfigId,
        accountId: job.accountId,
        projectId: job.projectId,
        provider: job.provider,
        enabled: job.providerEnabled,
        baseUrl: null,
        region: null,
        definitionId: job.provider,
        credentialBinding: { ...job.credentialBinding },
        capabilityMap: { capabilities: [job.capability] },
        versionToken: job.createdAt.toISOString(),
      };
    },

    async prepareAttempt(input) {
      const job = ownedJob(input.jobId, input.workerId);
      if (job.attemptCount >= 3 || job.cancellationRequestedAt) return null;
      const list = attempts.get(input.jobId) ?? [];
      const active = list.find((attempt) =>
        ['submitting', 'submitted', 'polling', 'reconciling'].includes(attempt.status),
      );
      if (active) return null;
      const attempt: StudioWorkerAttempt = {
        attemptId: crypto.randomUUID(),
        jobId: input.jobId,
        attemptNumber: job.attemptCount + 1,
        submissionKey: input.submissionKey,
        status: 'submitting',
        providerHandle: null,
        retryClassification: null,
        startedAt: input.now,
        endedAt: null,
        providerConfigVersion: input.providerConfigVersion,
      };
      list.push(attempt);
      attempts.set(input.jobId, list);
      job.attemptCount += 1;
      job.status = 'running';
      return cloneAttempt(attempt);
    },

    async markSubmitted(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      if (attempt.submissionKey !== input.handle.submission_key) {
        throw new Error('Studio provider handle does not match the durable submission key');
      }
      attempt.status = 'submitted';
      attempt.providerHandle = { ...input.handle };
      job.providerHandle = { ...input.handle };
      append(
        input.jobId,
        'provider-submitted',
        { submission_key: attempt.submissionKey },
        input.now,
      );
    },

    async markReconciling(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      attempt.status = 'reconciling';
      attempt.retryClassification = 'unknown_outcome';
      job.errorCode = 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN';
      job.errorMessage = input.message;
      release(job, input.availableAt);
      append(input.jobId, 'progress', { phase: 'reconciling' }, input.now);
    },

    async schedulePoll(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      attempt.status = 'polling';
      release(job, input.availableAt);
      append(
        input.jobId,
        'progress',
        { ...(input.progress === undefined ? {} : { progress: input.progress }) },
        input.now,
      );
    },

    async scheduleContinuation(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      attempt.status = input.phase;
      attempt.retryClassification = input.classification;
      job.errorCode = input.code;
      job.errorMessage = input.message;
      release(job, input.availableAt);
      append(
        input.jobId,
        'retry-scheduled',
        {
          phase: input.phase,
          classification: input.classification,
          available_at: input.availableAt.toISOString(),
        },
        input.now,
      );
    },

    async scheduleRetry(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      attempt.status = 'failed';
      attempt.retryClassification = input.classification;
      attempt.endedAt = input.now;
      job.providerHandle = null;
      release(job, input.availableAt);
      append(
        input.jobId,
        'retry-scheduled',
        {
          attempt: attempt.attemptNumber,
          classification: input.classification,
        },
        input.now,
      );
    },

    async finalizeSuccess(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      if (job.cancellationRequestedAt) {
        attempt.status = 'cancelled';
        attempt.endedAt = input.now;
        job.terminalStatus = 'cancelled';
        release(job, input.now);
        append(input.jobId, 'cancelled', { reason: 'user_cancelled' }, input.now);
        return 'cancelled';
      }

      const list = assets.get(input.jobId) ?? [];
      for (const raw of input.assets) {
        let asset = list.find(
          (candidate) => candidate.bucket === raw.bucket && candidate.objectKey === raw.objectKey,
        );
        if (!asset) {
          asset = { ...raw, assetId: crypto.randomUUID() };
          list.push(asset);
          append(input.jobId, 'asset-created', { asset_id: asset.assetId }, input.now);
        }
      }
      assets.set(input.jobId, list);
      append(input.jobId, 'billing-settled', { actual_credits: input.actualCredits }, input.now);
      attempt.status = 'succeeded';
      attempt.endedAt = input.now;
      job.actualCredits = input.actualCredits;
      job.terminalStatus = 'succeeded';
      release(job, input.now);
      append(input.jobId, 'succeeded', {}, input.now);
      return 'succeeded';
    },

    async recordStagedManifest(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      if (!['submitting', 'submitted', 'polling', 'reconciling'].includes(attempt.status)) {
        throw new Error('Studio attempt is not active');
      }
      if (
        (attempt.submissionKind && attempt.submissionKind !== input.submissionKind) ||
        (attempt.stagingManifestKey && attempt.stagingManifestKey !== input.manifestKey) ||
        (attempt.stagingManifestChecksum && attempt.stagingManifestChecksum !== input.manifestChecksum)
      ) {
        throw new Error('Studio staging manifest identity conflict');
      }
      attempt.submissionKind = input.submissionKind;
      attempt.stagingManifestKey = input.manifestKey;
      attempt.stagingManifestChecksum = input.manifestChecksum;
      if (attempt.status === 'submitting') attempt.status = 'reconciling';
      void job;
    },

    async recordAttemptCost(input) {
      const job = ownedJob(input.jobId, input.workerId);
      const attempt = findAttempt(attempts, input.jobId, input.attemptId);
      if (attempt.costRecordedAt) {
        if (
          JSON.stringify(attempt.upstreamUsage ?? {}) !== JSON.stringify(input.usage) ||
          attempt.upstreamCostCredits !== input.upstreamCostCredits ||
          attempt.costOutcome !== input.outcome
        ) {
          throw new Error('Studio attempt cost was already recorded differently');
        }
        return;
      }
      attempt.upstreamUsage = { ...input.usage };
      attempt.upstreamCostCredits = input.upstreamCostCredits;
      attempt.costOutcome = input.outcome;
      attempt.costRecordedAt = input.now;
      void job;
    },

    async getRecordedAttemptCostTotal(input) {
      ownedJob(input.jobId, input.workerId);
      return (attempts.get(input.jobId) ?? []).reduce(
        (total, attempt) => total + (attempt.costRecordedAt ? attempt.upstreamCostCredits ?? 0 : 0),
        0,
      );
    },

    async markFailed(input) {
      const job = ownedJob(input.jobId, input.workerId);
      if (input.attemptId) {
        const attempt = findAttempt(attempts, input.jobId, input.attemptId);
        attempt.status = 'failed';
        attempt.retryClassification = input.classification ?? 'terminal';
        attempt.endedAt = input.now;
      }
      job.errorCode = input.code;
      job.errorMessage = input.message;
      job.terminalStatus = 'failed';
      release(job, input.now);
      append(input.jobId, 'failed', { code: input.code }, input.now);
    },

    async markCancelled(input) {
      const job = ownedJob(input.jobId, input.workerId);
      if (input.attemptId) {
        const attempt = findAttempt(attempts, input.jobId, input.attemptId);
        attempt.status = 'cancelled';
        attempt.endedAt = input.now;
      }
      job.errorCode = input.code ?? null;
      job.errorMessage = input.message ?? null;
      job.terminalStatus = 'cancelled';
      release(job, input.now);
      append(
        input.jobId,
        'cancelled',
        { reason: input.reason, ...(input.code ? { code: input.code } : {}) },
        input.now,
      );
    },

    async abandonLease(input) {
      const job = ownedJob(input.jobId, input.workerId);
      release(job, input.availableAt);
    },
  } as ReturnType<typeof createMemoryStudioWorkerRepository>;

  return repository;
}

export function assertProcessRole(role: string): asserts role is 'studio-worker' {
  if (role !== 'studio-worker') {
    throw new Error('Studio jobs may only be claimed by the studio-worker process');
  }
}

function findAttempt(
  attempts: Map<string, StudioWorkerAttempt[]>,
  jobId: string,
  attemptId: string,
): StudioWorkerAttempt {
  const attempt = (attempts.get(jobId) ?? []).find(
    (candidate) => candidate.attemptId === attemptId,
  );
  if (!attempt) throw new Error('Unknown Studio attempt');
  return attempt;
}

function release(job: MutableJob, availableAt: Date) {
  job.availableAt = availableAt;
  job.leaseOwner = null;
  job.leaseExpiresAt = null;
}

function cloneJob(job: MutableJob): StudioWorkerJob {
  return {
    ...job,
    input: structuredClone(job.input),
    providerHandle: job.providerHandle ? { ...job.providerHandle } : null,
    credentialBinding: { ...job.credentialBinding },
  };
}

function cloneAttempt(attempt: StudioWorkerAttempt): StudioWorkerAttempt {
  return {
    ...attempt,
    providerHandle: attempt.providerHandle ? { ...attempt.providerHandle } : null,
  };
}

function defaultInput(): StudioJobInput {
  return {
    capability: 'image.generate',
    image: {
      prompt: 'A professional studio image',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    },
  };
}
