import {
  type Database,
  developerModuleReleases,
  projectModuleInstallationEvents,
  projectModuleInstallations,
} from '@kortix/db';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import {
  type ProjectModuleInstallation,
  ProjectModuleInstallationError,
  type ProjectModuleInstallationEvent,
  type ProjectModuleInstallationRepository,
  type ProjectModuleInstallationTransition,
} from './installations';

type InstallationRow = typeof projectModuleInstallations.$inferSelect;
type InstallationEventRow = typeof projectModuleInstallationEvents.$inferSelect;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

function serializeInstallation(
  row: InstallationRow,
  releaseStatus?: string | null,
): ProjectModuleInstallation {
  return {
    installation_id: row.installationId,
    project_id: row.projectId,
    account_id: row.accountId,
    module_id: row.moduleId,
    active_release_id: row.activeReleaseId,
    active_version: row.activeVersion,
    install_revision: row.installRevision,
    status: releaseStatus !== undefined && releaseStatus !== 'published' ? 'blocked' : row.status,
    installed_by: row.installedBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function serializeEvent(row: InstallationEventRow): ProjectModuleInstallationEvent {
  return {
    installation_event_id: row.installationEventId,
    installation_id: row.installationId,
    project_id: row.projectId,
    account_id: row.accountId,
    sequence: row.sequence,
    action: row.action,
    from_release_id: row.fromReleaseId,
    to_release_id: row.toReleaseId,
    expected_revision: row.expectedRevision,
    resulting_revision: row.resultingRevision,
    idempotency_key: row.idempotencyKey,
    actor_user_id: row.actorUserId,
    created_at: row.createdAt,
  };
}

function conflict(): never {
  throw new ProjectModuleInstallationError('PROJECT_MODULE_INSTALL_CONFLICT', 409);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return candidate.code === '23505' || candidate.cause?.code === '23505';
}

async function classifyMoveFailure(
  tx: Transaction,
  input: { accountId: string; projectId: string; moduleId: string },
): Promise<never> {
  const [existing] = await tx
    .select({ installationId: projectModuleInstallations.installationId })
    .from(projectModuleInstallations)
    .where(
      and(
        eq(projectModuleInstallations.accountId, input.accountId),
        eq(projectModuleInstallations.projectId, input.projectId),
        eq(projectModuleInstallations.moduleId, input.moduleId),
      ),
    )
    .limit(1);
  if (existing) conflict();
  throw new ProjectModuleInstallationError('PROJECT_MODULE_NOT_FOUND', 404);
}

async function appendEvent(
  tx: Transaction,
  input: {
    installationId: string;
    projectId: string;
    accountId: string;
    sequence: number;
    action: 'install' | 'update' | 'rollback';
    fromReleaseId: string | null;
    toReleaseId: string;
    expectedRevision: number;
    actorUserId: string;
    idempotencyKey?: string;
  },
): Promise<ProjectModuleInstallationEvent> {
  const [event] = await tx
    .insert(projectModuleInstallationEvents)
    .values({
      installationId: input.installationId,
      projectId: input.projectId,
      accountId: input.accountId,
      sequence: input.sequence,
      action: input.action,
      fromReleaseId: input.fromReleaseId,
      toReleaseId: input.toReleaseId,
      expectedRevision: input.expectedRevision,
      resultingRevision: input.sequence,
      idempotencyKey: input.idempotencyKey ?? null,
      actorUserId: input.actorUserId,
    })
    .returning();
  if (!event) throw new Error('Project module installation event insert returned no row');
  return serializeEvent(event);
}

export function createDrizzleProjectModuleInstallationRepository(
  db: Database,
): ProjectModuleInstallationRepository {
  return {
    async list(accountId, projectId) {
      const rows = await db
        .select({
          installation: projectModuleInstallations,
          releaseStatus: developerModuleReleases.status,
        })
        .from(projectModuleInstallations)
        .leftJoin(
          developerModuleReleases,
          eq(developerModuleReleases.releaseId, projectModuleInstallations.activeReleaseId),
        )
        .where(
          and(
            eq(projectModuleInstallations.accountId, accountId),
            eq(projectModuleInstallations.projectId, projectId),
          ),
        )
        .orderBy(asc(projectModuleInstallations.moduleId));
      return rows.map(({ installation, releaseStatus }) =>
        serializeInstallation(installation, releaseStatus),
      );
    },

    async get(accountId, projectId, moduleId) {
      const [row] = await db
        .select({
          installation: projectModuleInstallations,
          releaseStatus: developerModuleReleases.status,
        })
        .from(projectModuleInstallations)
        .leftJoin(
          developerModuleReleases,
          eq(developerModuleReleases.releaseId, projectModuleInstallations.activeReleaseId),
        )
        .where(
          and(
            eq(projectModuleInstallations.accountId, accountId),
            eq(projectModuleInstallations.projectId, projectId),
            eq(projectModuleInstallations.moduleId, moduleId),
          ),
        )
        .limit(1);
      return row ? serializeInstallation(row.installation, row.releaseStatus) : null;
    },

    async install(command) {
      try {
        return await db.transaction(async (tx) => {
          const [installation] = await tx
            .insert(projectModuleInstallations)
            .values({
              projectId: command.projectId,
              accountId: command.accountId,
              moduleId: command.moduleId,
              activeReleaseId: command.releaseId,
              activeVersion: command.moduleVersion,
              installRevision: 1,
              status: 'active',
              installedBy: command.actorUserId,
            })
            .returning();
          if (!installation) conflict();
          const event = await appendEvent(tx, {
            installationId: installation.installationId,
            projectId: command.projectId,
            accountId: command.accountId,
            sequence: 1,
            action: 'install',
            fromReleaseId: null,
            toReleaseId: command.releaseId,
            expectedRevision: 0,
            actorUserId: command.actorUserId,
            idempotencyKey: command.idempotencyKey,
          });
          return { installation: serializeInstallation(installation), event };
        });
      } catch (error) {
        if (isUniqueViolation(error)) conflict();
        throw error;
      }
    },

    async move(command) {
      return db
        .transaction(async (tx): Promise<ProjectModuleInstallationTransition> => {
          const [updated] = await tx
            .update(projectModuleInstallations)
            .set({
              activeReleaseId: command.releaseId,
              activeVersion: command.moduleVersion,
              installRevision: sql`${projectModuleInstallations.installRevision} + 1`,
              status: 'active',
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(projectModuleInstallations.accountId, command.accountId),
                eq(projectModuleInstallations.projectId, command.projectId),
                eq(projectModuleInstallations.moduleId, command.moduleId),
                eq(projectModuleInstallations.installRevision, command.expectedInstallRevision),
                eq(projectModuleInstallations.activeReleaseId, command.fromReleaseId),
                ne(projectModuleInstallations.activeReleaseId, command.releaseId),
              ),
            )
            .returning();
          if (!updated) return classifyMoveFailure(tx, command);
          const event = await appendEvent(tx, {
            installationId: updated.installationId,
            projectId: command.projectId,
            accountId: command.accountId,
            sequence: updated.installRevision,
            action: command.action,
            fromReleaseId: command.fromReleaseId,
            toReleaseId: command.releaseId,
            expectedRevision: command.expectedInstallRevision,
            actorUserId: command.actorUserId,
            idempotencyKey: command.idempotencyKey,
          });
          return { installation: serializeInstallation(updated), event };
        })
        .catch((error) => {
          if (isUniqueViolation(error)) conflict();
          throw error;
        });
    },

    async hasHistoricalTarget(installationId, releaseId) {
      const [event] = await db
        .select({ installationEventId: projectModuleInstallationEvents.installationEventId })
        .from(projectModuleInstallationEvents)
        .where(
          and(
            eq(projectModuleInstallationEvents.installationId, installationId),
            eq(projectModuleInstallationEvents.toReleaseId, releaseId),
          ),
        )
        .limit(1);
      return Boolean(event);
    },

    async findIdempotentResult(input) {
      const [row] = await db
        .select({
          event: projectModuleInstallationEvents,
          installation: projectModuleInstallations,
          releaseVersion: developerModuleReleases.moduleVersion,
          releaseStatus: developerModuleReleases.status,
        })
        .from(projectModuleInstallationEvents)
        .leftJoin(
          projectModuleInstallations,
          and(
            eq(
              projectModuleInstallations.installationId,
              projectModuleInstallationEvents.installationId,
            ),
            eq(projectModuleInstallations.projectId, projectModuleInstallationEvents.projectId),
            eq(projectModuleInstallations.accountId, projectModuleInstallationEvents.accountId),
          ),
        )
        .leftJoin(
          developerModuleReleases,
          eq(developerModuleReleases.releaseId, projectModuleInstallationEvents.toReleaseId),
        )
        .where(
          and(
            eq(projectModuleInstallationEvents.accountId, input.accountId),
            eq(projectModuleInstallationEvents.projectId, input.projectId),
            eq(projectModuleInstallationEvents.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!row?.installation || !row.releaseVersion) return null;
      const event = serializeEvent(row.event);
      return {
        installation: {
          ...serializeInstallation(row.installation, row.releaseStatus),
          active_release_id: event.to_release_id,
          active_version: row.releaseVersion,
          install_revision: event.resulting_revision,
          updated_at: event.created_at,
        },
        event,
      };
    },
  };
}
