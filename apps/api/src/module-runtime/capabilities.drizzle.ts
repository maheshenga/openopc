import type { Database } from '@kortix/db';
import { sql } from 'drizzle-orm';

import { ModuleCapabilityError, type ModuleCapabilityPersistence } from './capabilities';
import type { ModuleExecutionRepository } from './executions';

export function createDrizzleModuleCapabilityPersistence(
  db: Database,
  repository: Pick<ModuleExecutionRepository, 'storeCapabilityGrants'>,
): ModuleCapabilityPersistence {
  return {
    async store(input) {
      const stored = await repository.storeCapabilityGrants({
        accountId: input.accountId,
        projectId: input.projectId,
        executionId: input.executionId,
        leaseId: input.leaseId,
        runnerId: input.runnerId,
        generation: input.leaseGeneration,
        grants: [
          {
            grantId: input.grantId,
            audience: input.audience,
            tokenHash: input.tokenHash,
            expiresAt: input.expiresAt,
          },
        ],
      });
      const grant = stored[0];
      if (!grant) throw new ModuleCapabilityError('MODULE_CAPABILITY_UNAVAILABLE');
      return grant;
    },

    async revokeByExecution(input) {
      const revoked = await db.execute<{ grantId: string }>(sql`
        UPDATE kortix.module_capability_grants AS grant_row
        SET revoked_at = ${input.revokedAt}::timestamptz
        WHERE grant_row.account_id = ${input.accountId}::uuid
          AND grant_row.project_id = ${input.projectId}::uuid
          AND grant_row.execution_id = ${input.executionId}::uuid
          AND grant_row.revoked_at IS NULL
        RETURNING grant_row.grant_id AS "grantId"
      `);
      return revoked.length;
    },
  };
}
