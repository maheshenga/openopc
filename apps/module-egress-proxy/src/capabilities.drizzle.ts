import { type Database, moduleCapabilityUses } from '@kortix/db';
import {
  type CapabilityTokenClaimsV1,
  parseCapabilityTokenClaims,
} from '@openopc/module-runtime-contracts';
import { sql } from 'drizzle-orm';

export interface ConsumeModuleCapabilityInput {
  tokenHash: `sha256:${string}`;
  claims: CapabilityTokenClaimsV1;
  observedAt: string;
}

export interface ModuleCapabilityConsumer {
  ready(): Promise<boolean>;
  consume(input: ConsumeModuleCapabilityInput): Promise<boolean>;
}

function validInput(input: ConsumeModuleCapabilityInput): boolean {
  try {
    parseCapabilityTokenClaims(input.claims);
  } catch {
    return false;
  }
  const observedAt = Date.parse(input.observedAt);
  return (
    /^sha256:[0-9a-f]{64}$/.test(input.tokenHash) &&
    Number.isFinite(observedAt) &&
    Date.parse(input.claims.iat) <= observedAt &&
    observedAt < Date.parse(input.claims.exp) &&
    input.claims.actor.type === 'runner'
  );
}

export function createDrizzleModuleCapabilityConsumer(db: Database): ModuleCapabilityConsumer {
  return {
    async ready() {
      try {
        await db.execute(sql`SELECT 1 AS ready`);
        return true;
      } catch {
        return false;
      }
    },

    async consume(input) {
      if (!validInput(input)) return false;
      const audience = input.claims.aud.slice('openopc:capability/'.length);
      return db.transaction(async (tx) => {
        const execution = await tx.execute<{ executionId: string }>(sql`
          SELECT execution.execution_id AS "executionId"
          FROM kortix.module_executions AS execution
          WHERE execution.execution_id = ${input.claims.sub}::uuid
            AND execution.account_id = ${input.claims.accountId}::uuid
            AND execution.project_id = ${input.claims.projectId}::uuid
            AND execution.installation_id = ${input.claims.installationId}::uuid
            AND execution.state IN ('leased', 'running')
            AND execution.deadline_at > ${input.observedAt}::timestamptz
            AND execution.kill_switch_generation = ${input.claims.killSwitchGeneration}::integer
            AND NOT EXISTS (
              SELECT 1
              FROM kortix.module_kill_switch_generations AS kill_switch
              WHERE kill_switch.account_id = ${input.claims.accountId}::uuid
                AND (
                  kill_switch.scope = 'account'
                  OR (
                    kill_switch.scope = 'project'
                    AND kill_switch.project_id = ${input.claims.projectId}::uuid
                  )
                  OR (
                    kill_switch.scope = 'runner'
                    AND kill_switch.runner_id = ${input.claims.actor.id}::uuid
                  )
                )
                AND (
                  kill_switch.active
                  OR kill_switch.generation > ${input.claims.killSwitchGeneration}::integer
                )
            )
          FOR UPDATE
        `);
        if (!execution[0]) return false;

        const lease = await tx.execute<{ leaseId: string }>(sql`
          SELECT lease_row.lease_id AS "leaseId"
          FROM kortix.module_execution_leases AS lease_row
          WHERE lease_row.lease_id = ${input.claims.lease.id}::uuid
            AND lease_row.execution_id = ${input.claims.sub}::uuid
            AND lease_row.account_id = ${input.claims.accountId}::uuid
            AND lease_row.project_id = ${input.claims.projectId}::uuid
            AND lease_row.runner_id = ${input.claims.actor.id}::uuid
            AND lease_row.generation = ${input.claims.lease.generation}::integer
            AND lease_row.released_at IS NULL
            AND lease_row.deadline_at > ${input.observedAt}::timestamptz
            AND lease_row.deadline_at >= ${input.claims.lease.deadline}::timestamptz
          FOR UPDATE
        `);
        if (!lease[0]) return false;

        const grant = await tx.execute<{ grantId: string }>(sql`
          SELECT grant_row.grant_id AS "grantId"
          FROM kortix.module_capability_grants AS grant_row
          WHERE grant_row.grant_id = ${input.claims.grantId}::uuid
            AND grant_row.execution_id = ${input.claims.sub}::uuid
            AND grant_row.account_id = ${input.claims.accountId}::uuid
            AND grant_row.project_id = ${input.claims.projectId}::uuid
            AND grant_row.lease_id = ${input.claims.lease.id}::uuid
            AND grant_row.audience = ${audience}::kortix.module_capability_audience
            AND grant_row.token_hash = ${input.tokenHash}
            AND grant_row.expires_at = ${input.claims.exp}::timestamptz
            AND grant_row.expires_at > ${input.observedAt}::timestamptz
            AND grant_row.revoked_at IS NULL
          FOR UPDATE
        `);
        if (!grant[0]) return false;

        const uses = await tx.execute<{ useCount: number | string }>(sql`
          SELECT count(*)::integer AS "useCount"
          FROM kortix.module_capability_uses
          WHERE grant_id = ${input.claims.grantId}::uuid
        `);
        if (Number(uses[0]?.useCount ?? 0) >= input.claims.ceilings.maxCalls) return false;

        await tx.insert(moduleCapabilityUses).values({
          grantId: input.claims.grantId,
          executionId: input.claims.sub,
          accountId: input.claims.accountId,
          projectId: input.claims.projectId,
          observedAt: input.observedAt,
        });
        return true;
      });
    },
  };
}
