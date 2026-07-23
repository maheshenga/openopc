import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { Hono } from 'hono';
import { ACCOUNT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import { createStudioAccountRoutes } from './account-routes';
import {
  type StudioBillingIncidentRepository,
  StudioBillingIncidentService,
  type StudioBillingIncidentServiceError,
  createDrizzleStudioBillingIncidentRepository,
} from './billing-incidents';
import { StudioPricingService } from './pricing';
import { createMemoryStudioRepository } from './repositories/memory';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '11000000-0000-4000-a000-000000000001';
const INCIDENT_ID = '12000000-0000-4000-a000-000000000001';
const JOB_ID = '13000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '14000000-0000-4000-a000-000000000001';
const USER_ID = '20000000-0000-4000-a000-000000000001';
const TOKEN_ID = '30000000-0000-4000-a000-000000000001';

describe('Studio billing incident resolution', () => {
  test('calculates platform liability from the locked incident and attributes the actor', async () => {
    const preparedInputs: unknown[] = [];
    const repository: StudioBillingIncidentRepository = {
      async resolveLocked(input, prepare) {
        const prepared = await prepare({
          incident_id: INCIDENT_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          job_id: JOB_ID,
          attempt_id: ATTEMPT_ID,
          status: 'open',
          verified_cost_credits: 2,
          potential_liability_credits: 6,
          opened_at: '2026-06-01T00:00:00.000Z',
          resolution: null,
        });
        preparedInputs.push({ input, prepared });
        return {
          incident_id: INCIDENT_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          job_id: JOB_ID,
          attempt_id: ATTEMPT_ID,
          status: 'resolved',
          decision: prepared.decision,
          evidence_reference: prepared.evidence_reference,
          verified_cost_credits: 2,
          potential_liability_credits: 6,
          provider_liability_credits: prepared.provider_liability_credits,
          resolved_at: input.resolved_at,
          resolved_by_user_id: input.actor_user_id,
        };
      },
    };
    const service = new StudioBillingIncidentService({
      repository,
      now: () => new Date('2026-07-24T00:00:00.000Z'),
    });

    const result = await service.resolve({
      accountId: ACCOUNT_ID,
      incidentId: INCIDENT_ID,
      actorUserId: USER_ID,
      actingTokenId: TOKEN_ID,
      request: {
        decision: 'record_platform_liability',
        idempotency_key: 'incident-resolution-key-0001',
        reason: 'Provider evidence confirms that the request was created.',
        evidence_reference: 'evidence:provider-case-0001',
      },
    });

    expect(result.provider_liability_credits).toBe(6);
    expect(preparedInputs).toEqual([
      {
        input: expect.objectContaining({
          account_id: ACCOUNT_ID,
          incident_id: INCIDENT_ID,
          actor_user_id: USER_ID,
          acting_token_id: TOKEN_ID,
          resolved_at: '2026-07-24T00:00:00.000Z',
        }),
        prepared: expect.objectContaining({
          decision: 'record_platform_liability',
          evidence_reference: 'evidence:provider-case-0001',
          provider_liability_credits: 6,
        }),
      },
    ]);
  });

  test('replays the same resolution and rejects conflicting evidence for the idempotency key', async () => {
    const resolution = {
      decision: 'confirm_not_created',
      reason: 'Provider evidence confirms that no request was created.',
      evidence_reference: 'evidence:provider-case-0002',
      provider_liability_credits: 0,
      idempotency_key: 'incident-resolution-key-0002',
      request_hash: 'request-hash-0002',
      actor_user_id: USER_ID,
      acting_token_id: TOKEN_ID,
      resolved_at: '2026-07-24T00:00:00.000Z',
    };
    const row = {
      incidentId: INCIDENT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      attemptId: ATTEMPT_ID,
      status: 'resolved',
      verifiedCostCredits: '2.0000',
      potentialLiabilityCredits: '6.0000',
      openedAt: '2026-06-01T00:00:00.000Z',
      resolvedAt: resolution.resolved_at,
      resolvedByUserId: USER_ID,
      resolution,
    };
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [row] }),
          }),
        }),
      }),
      update: () => {
        throw new Error('replay must not update the incident');
      },
    };
    const database = {
      transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
    } as unknown as Database;
    const repository = createDrizzleStudioBillingIncidentRepository(database);
    const repositoryInput = {
      account_id: ACCOUNT_ID,
      incident_id: INCIDENT_ID,
      actor_user_id: USER_ID,
      acting_token_id: TOKEN_ID,
      idempotency_key: resolution.idempotency_key,
      request_hash: resolution.request_hash,
      resolved_at: resolution.resolved_at,
    };

    expect(
      await repository.resolveLocked(repositoryInput, async () => {
        throw new Error('replay must not prepare another resolution');
      }),
    ).toMatchObject({
      status: 'resolved',
      decision: 'confirm_not_created',
      evidence_reference: resolution.evidence_reference,
      provider_liability_credits: 0,
    });
    await expect(
      repository.resolveLocked(
        { ...repositoryInput, request_hash: 'conflicting-evidence-hash' },
        async () => {
          throw new Error('conflict must not prepare another resolution');
        },
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'STUDIO_RECOVERY_CONFLICT',
        status: 409,
      } satisfies Partial<StudioBillingIncidentServiceError>),
    );
  });

  test('writes the first resolution as one attributed audit record', async () => {
    const openRow = {
      incidentId: INCIDENT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      attemptId: ATTEMPT_ID,
      status: 'open',
      verifiedCostCredits: '2.0000',
      potentialLiabilityCredits: '6.0000',
      openedAt: '2026-06-01T00:00:00.000Z',
      resolvedAt: null,
      resolvedByUserId: null,
      resolution: null,
    };
    let updateValues: Record<string, unknown> | null = null;
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [openRow] }),
          }),
        }),
      }),
      update: () => ({
        set(values: Record<string, unknown>) {
          updateValues = values;
          return {
            where: () => ({
              returning: async () => [
                {
                  ...openRow,
                  status: values.status,
                  resolvedAt: values.resolvedAt,
                  resolvedByUserId: values.resolvedByUserId,
                  resolution: values.resolution,
                },
              ],
            }),
          };
        },
      }),
    };
    const database = {
      transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
    } as unknown as Database;
    const repository = createDrizzleStudioBillingIncidentRepository(database);

    const result = await repository.resolveLocked(
      {
        account_id: ACCOUNT_ID,
        incident_id: INCIDENT_ID,
        actor_user_id: USER_ID,
        acting_token_id: TOKEN_ID,
        idempotency_key: 'incident-resolution-key-0005',
        request_hash: 'request-hash-0005',
        resolved_at: '2026-07-24T00:00:00.000Z',
      },
      async () => ({
        decision: 'record_platform_liability',
        reason: 'Provider evidence confirms that the request was created.',
        evidence_reference: 'evidence:provider-case-0005',
        provider_liability_credits: 6,
      }),
    );

    expect(result.provider_liability_credits).toBe(6);
    expect(updateValues).toEqual(
      expect.objectContaining({
        status: 'resolved',
        resolvedByUserId: USER_ID,
        resolution: expect.objectContaining({
          decision: 'record_platform_liability',
          evidence_reference: 'evidence:provider-case-0005',
          provider_liability_credits: 6,
          idempotency_key: 'incident-resolution-key-0005',
          request_hash: 'request-hash-0005',
          actor_user_id: USER_ID,
          acting_token_id: TOKEN_ID,
        }),
      }),
    );
  });

  test('fails closed when the account-scoped incident lookup finds no row', async () => {
    let prepared = false;
    const transaction = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [] }),
          }),
        }),
      }),
    };
    const database = {
      transaction: async (run: (tx: typeof transaction) => Promise<unknown>) => run(transaction),
    } as unknown as Database;
    const repository = createDrizzleStudioBillingIncidentRepository(database);

    await expect(
      repository.resolveLocked(
        {
          account_id: '90000000-0000-4000-a000-000000000009',
          incident_id: INCIDENT_ID,
          actor_user_id: USER_ID,
          acting_token_id: TOKEN_ID,
          idempotency_key: 'incident-resolution-key-0006',
          request_hash: 'request-hash-0006',
          resolved_at: '2026-07-24T00:00:00.000Z',
        },
        async () => {
          prepared = true;
          throw new Error('cross-account lookup must not prepare a resolution');
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: 'STUDIO_JOB_CONFLICT', status: 404 }));
    expect(prepared).toBe(false);
  });

  test('gates the internal account route with billing.write and attributes the request token', async () => {
    const authorizationCalls: unknown[][] = [];
    const resolutionCalls: unknown[] = [];
    const routes = createStudioAccountRoutes({
      pricingService: new StudioPricingService(createMemoryStudioRepository()),
      billingIncidentService: {
        async resolve(input) {
          resolutionCalls.push(input);
          return {
            incident_id: INCIDENT_ID,
            account_id: ACCOUNT_ID,
            project_id: PROJECT_ID,
            job_id: JOB_ID,
            attempt_id: ATTEMPT_ID,
            status: 'resolved',
            decision: input.request.decision,
            evidence_reference: input.request.evidence_reference,
            verified_cost_credits: 2,
            potential_liability_credits: 6,
            provider_liability_credits: 0,
            resolved_at: '2026-07-24T00:00:00.000Z',
            resolved_by_user_id: input.actorUserId,
          };
        },
      },
      assertAccountCapability: async (...args) => {
        authorizationCalls.push(args);
      },
    });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', USER_ID);
      c.set('iamTokenId', TOKEN_ID);
      await next();
    });
    app.route('/v1/accounts', routes);

    const response = await app.request(
      `/v1/accounts/${ACCOUNT_ID}/studio/billing-incidents/${INCIDENT_ID}/resolve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: 'confirm_not_created',
          idempotency_key: 'incident-resolution-key-0003',
          reason: 'Provider evidence confirms that no request was created.',
          evidence_reference: 'evidence:provider-case-0003',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(authorizationCalls).toEqual([
      expect.arrayContaining([
        expect.anything(),
        USER_ID,
        ACCOUNT_ID,
        ACCOUNT_ACTIONS.BILLING_WRITE,
      ]),
    ]);
    expect(resolutionCalls).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        incidentId: INCIDENT_ID,
        actorUserId: USER_ID,
        actingTokenId: TOKEN_ID,
      }),
    ]);
  });
});
