import { randomUUID } from 'node:crypto';
import { type Database, automationJobs, automationKillSwitches } from '@kortix/db';
import { and, eq, max, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AutomationActor } from './repository';

const UuidSchema = z.string().uuid();
const KillSwitchScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accountId: UuidSchema }).strict(),
  z
    .object({
      kind: z.literal('project'),
      accountId: UuidSchema,
      projectId: UuidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('device'),
      accountId: UuidSchema,
      projectId: UuidSchema,
      deviceId: UuidSchema,
    })
    .strict(),
]);

export type KillSwitchScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'project'; accountId: string; projectId: string }
  | { kind: 'device'; accountId: string; projectId: string; deviceId: string };

export type KillSwitchActivation = {
  generation: number;
  auditEventId: string;
};

export type KillSwitchNotification = Readonly<{
  protocolVersion: 'automation.v1';
  scope: KillSwitchScope;
  generation: number;
  actorUserId: string;
  auditEventId: string;
  activatedAt: string;
}>;

export interface KillSwitchPublisher {
  publish(notification: KillSwitchNotification): Promise<void>;
}

export interface KillSwitchService {
  activate(scope: KillSwitchScope, actor: AutomationActor): Promise<KillSwitchActivation>;
  current(scope: KillSwitchScope): Promise<number>;
}

export type KillSwitchErrorCode = 'AUTOMATION_INVALID_REQUEST' | 'AUTOMATION_FORBIDDEN';

export class AutomationKillSwitchError extends Error {
  constructor(
    readonly code: KillSwitchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationKillSwitchError';
  }
}

export type MemoryKillSwitchJob = {
  jobId: string;
  accountId: string;
  projectId: string;
  deviceId: string | null;
  killSwitchGeneration: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
};

export type MemoryKillSwitchRecord = KillSwitchNotification & {
  active: boolean;
  releasedAt: string | null;
};

function validatedScope(scope: KillSwitchScope): KillSwitchScope {
  const parsed = KillSwitchScopeSchema.safeParse(scope);
  if (!parsed.success) {
    throw new AutomationKillSwitchError(
      'AUTOMATION_INVALID_REQUEST',
      'Kill-switch scope is invalid',
    );
  }
  return parsed.data;
}

function isExactScope(left: KillSwitchScope, right: KillSwitchScope): boolean {
  if (left.kind !== right.kind || left.accountId !== right.accountId) return false;
  if (left.kind === 'account' || right.kind === 'account') return true;
  if (left.projectId !== right.projectId) return false;
  if (left.kind === 'project' || right.kind === 'project') return true;
  return left.deviceId === right.deviceId;
}

function appliesTo(active: KillSwitchScope, requested: KillSwitchScope): boolean {
  if (active.accountId !== requested.accountId) return false;
  if (active.kind === 'account') return true;
  if (requested.kind === 'account' || active.projectId !== requested.projectId) return false;
  if (active.kind === 'project') return true;
  return requested.kind === 'device' && active.deviceId === requested.deviceId;
}

function jobIsInScope(job: MemoryKillSwitchJob, scope: KillSwitchScope): boolean {
  if (job.accountId !== scope.accountId) return false;
  if (scope.kind === 'account') return true;
  if (job.projectId !== scope.projectId) return false;
  return scope.kind === 'project' || job.deviceId === scope.deviceId;
}

function assertActorCanActivate(scope: KillSwitchScope, actor: AutomationActor): void {
  const forbidden = () =>
    new AutomationKillSwitchError(
      'AUTOMATION_FORBIDDEN',
      'Actor cannot activate this kill-switch scope',
    );
  if (actor.accountId !== scope.accountId) throw forbidden();
  if (actor.roles.includes('security_admin')) return;
  switch (scope.kind) {
    case 'account':
      throw forbidden();
    case 'project':
      if (actor.projectId === scope.projectId && actor.roles.includes('project_admin')) return;
      throw forbidden();
    case 'device':
      if (actor.projectId !== scope.projectId) throw forbidden();
      if (actor.roles.includes('project_admin')) return;
      if (actor.roles.includes('device_owner') && actor.deviceId === scope.deviceId) return;
      throw forbidden();
  }
}

function notificationFor(input: {
  scope: KillSwitchScope;
  generation: number;
  actorUserId: string;
  now: Date;
}): KillSwitchNotification {
  return {
    protocolVersion: 'automation.v1',
    scope: structuredClone(input.scope),
    generation: input.generation,
    actorUserId: input.actorUserId,
    auditEventId: randomUUID(),
    activatedAt: input.now.toISOString(),
  };
}

async function publishToAll(
  publishers: readonly KillSwitchPublisher[],
  notification: KillSwitchNotification,
): Promise<void> {
  await Promise.all(publishers.map((publisher) => publisher.publish(notification)));
}

export class MemoryKillSwitchStore {
  readonly #accountGenerations = new Map<string, number>();
  readonly #records: MemoryKillSwitchRecord[] = [];
  readonly #jobs = new Map<string, MemoryKillSwitchJob>();

  constructor(input?: { jobs?: readonly MemoryKillSwitchJob[] }) {
    for (const job of input?.jobs ?? []) this.#jobs.set(job.jobId, structuredClone(job));
  }

  activate(input: {
    scope: KillSwitchScope;
    actorUserId: string;
    now: Date;
  }): KillSwitchNotification {
    const nextGeneration = (this.#accountGenerations.get(input.scope.accountId) ?? 0) + 1;
    this.#accountGenerations.set(input.scope.accountId, nextGeneration);

    for (const record of this.#records) {
      if (record.active && isExactScope(record.scope, input.scope)) {
        record.active = false;
        record.releasedAt = input.now.toISOString();
      }
    }
    const notification = notificationFor({ ...input, generation: nextGeneration });
    this.#records.push({ ...notification, active: true, releasedAt: null });

    for (const job of this.#jobs.values()) {
      if (!jobIsInScope(job, input.scope)) continue;
      job.killSwitchGeneration = nextGeneration;
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
    }
    return notification;
  }

  current(scope: KillSwitchScope): number {
    return this.#records.reduce(
      (generation, record) =>
        record.active && appliesTo(record.scope, scope)
          ? Math.max(generation, record.generation)
          : generation,
      0,
    );
  }

  snapshotJobs(): readonly Readonly<MemoryKillSwitchJob>[] {
    return [...this.#jobs.values()].map((job) => structuredClone(job));
  }

  snapshotSwitches(): readonly Readonly<MemoryKillSwitchRecord>[] {
    return this.#records.map((record) => structuredClone(record));
  }
}

export function createMemoryKillSwitchStore(input?: {
  jobs?: readonly MemoryKillSwitchJob[];
}): MemoryKillSwitchStore {
  return new MemoryKillSwitchStore(input);
}

export function createMemoryKillSwitchService(options?: {
  store?: MemoryKillSwitchStore;
  publishers?: readonly KillSwitchPublisher[];
  now?: () => Date;
}): KillSwitchService {
  const store = options?.store ?? createMemoryKillSwitchStore();
  const publishers = options?.publishers ?? [];
  const now = options?.now ?? (() => new Date());

  return {
    async activate(scopeInput, actor) {
      const scope = validatedScope(scopeInput);
      assertActorCanActivate(scope, actor);
      const notification = store.activate({ scope, actorUserId: actor.userId, now: now() });
      await publishToAll(publishers, notification);
      return {
        generation: notification.generation,
        auditEventId: notification.auditEventId,
      };
    },

    async current(scopeInput) {
      return store.current(validatedScope(scopeInput));
    },
  };
}

export type RedisCommandClient = {
  send(command: string, args: string[]): Promise<unknown>;
};

function redisScopeKey(scope: KillSwitchScope): string {
  if (scope.kind === 'account') return `account:${scope.accountId}`;
  if (scope.kind === 'project') return `project:${scope.accountId}:${scope.projectId}`;
  return `device:${scope.accountId}:${scope.projectId}:${scope.deviceId}`;
}

export function createRedisKillSwitchPublisher(
  client: RedisCommandClient,
  options?: { keyPrefix?: string; channel?: string },
): KillSwitchPublisher {
  const keyPrefix = options?.keyPrefix ?? 'automation:kill-switch:generation';
  const channel = options?.channel ?? 'automation:kill-switch';
  return {
    async publish(notification) {
      await client.send('SET', [
        `${keyPrefix}:${redisScopeKey(notification.scope)}`,
        String(notification.generation),
      ]);
      await client.send('PUBLISH', [channel, JSON.stringify(notification)]);
    },
  };
}

function exactScopeCondition(scope: KillSwitchScope) {
  if (scope.kind === 'account') {
    return and(
      eq(automationKillSwitches.accountId, scope.accountId),
      eq(automationKillSwitches.scope, 'account'),
    );
  }
  if (scope.kind === 'project') {
    return and(
      eq(automationKillSwitches.accountId, scope.accountId),
      eq(automationKillSwitches.scope, 'project'),
      eq(automationKillSwitches.projectId, scope.projectId),
    );
  }
  return and(
    eq(automationKillSwitches.accountId, scope.accountId),
    eq(automationKillSwitches.scope, 'device'),
    eq(automationKillSwitches.projectId, scope.projectId),
    eq(automationKillSwitches.deviceId, scope.deviceId),
  );
}

function applicableScopeCondition(scope: KillSwitchScope) {
  if (scope.kind === 'account') return eq(automationKillSwitches.scope, 'account');
  if (scope.kind === 'project') {
    return or(
      eq(automationKillSwitches.scope, 'account'),
      and(
        eq(automationKillSwitches.scope, 'project'),
        eq(automationKillSwitches.projectId, scope.projectId),
      ),
    );
  }
  return or(
    eq(automationKillSwitches.scope, 'account'),
    and(
      eq(automationKillSwitches.scope, 'project'),
      eq(automationKillSwitches.projectId, scope.projectId),
    ),
    and(
      eq(automationKillSwitches.scope, 'device'),
      eq(automationKillSwitches.projectId, scope.projectId),
      eq(automationKillSwitches.deviceId, scope.deviceId),
    ),
  );
}

function jobScopeCondition(scope: KillSwitchScope) {
  if (scope.kind === 'account') return eq(automationJobs.accountId, scope.accountId);
  if (scope.kind === 'project') {
    return and(
      eq(automationJobs.accountId, scope.accountId),
      eq(automationJobs.projectId, scope.projectId),
    );
  }
  return and(
    eq(automationJobs.accountId, scope.accountId),
    eq(automationJobs.projectId, scope.projectId),
    eq(automationJobs.targetDeviceId, scope.deviceId),
  );
}

export function createPostgresKillSwitchService(
  db: Database,
  options?: {
    publishers?: readonly KillSwitchPublisher[];
    now?: () => Date;
  },
): KillSwitchService {
  const publishers = options?.publishers ?? [];
  const now = options?.now ?? (() => new Date());

  return {
    async activate(scopeInput, actor) {
      const scope = validatedScope(scopeInput);
      assertActorCanActivate(scope, actor);
      const activatedAt = now();
      const notification = await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`automation-kill-switch:${scope.accountId}`}, 0))`,
        );
        const [latest] = await tx
          .select({ generation: max(automationKillSwitches.generation) })
          .from(automationKillSwitches)
          .where(eq(automationKillSwitches.accountId, scope.accountId));
        const generation = Number(latest?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation)) {
          throw new AutomationKillSwitchError(
            'AUTOMATION_INVALID_REQUEST',
            'Kill-switch generation exceeded the supported range',
          );
        }

        await tx
          .update(automationKillSwitches)
          .set({ active: false, releasedAt: activatedAt.toISOString() })
          .where(and(exactScopeCondition(scope), eq(automationKillSwitches.active, true)));

        const created = notificationFor({
          scope,
          generation,
          actorUserId: actor.userId,
          now: activatedAt,
        });
        await tx.insert(automationKillSwitches).values({
          protocolVersion: created.protocolVersion,
          scope: scope.kind,
          accountId: scope.accountId,
          projectId: scope.kind === 'account' ? null : scope.projectId,
          deviceId: scope.kind === 'device' ? scope.deviceId : null,
          generation,
          active: true,
          actorUserId: actor.userId,
          auditEventId: created.auditEventId,
          activatedAt: created.activatedAt,
          releasedAt: null,
          createdAt: created.activatedAt,
        });
        await tx
          .update(automationJobs)
          .set({
            killSwitchGeneration: generation,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: activatedAt.toISOString(),
          })
          .where(jobScopeCondition(scope));
        return created;
      });

      await publishToAll(publishers, notification);
      return {
        generation: notification.generation,
        auditEventId: notification.auditEventId,
      };
    },

    async current(scopeInput) {
      const scope = validatedScope(scopeInput);
      const [current] = await db
        .select({ generation: max(automationKillSwitches.generation) })
        .from(automationKillSwitches)
        .where(
          and(
            eq(automationKillSwitches.accountId, scope.accountId),
            eq(automationKillSwitches.active, true),
            applicableScopeCondition(scope),
          ),
        );
      return Number(current?.generation ?? 0);
    },
  };
}
