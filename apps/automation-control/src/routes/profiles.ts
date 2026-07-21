import { randomUUID } from 'node:crypto';
import {
  type AutomationBrowserProfile,
  type Database,
  automationBrowserProfiles,
  projects,
} from '@kortix/db';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { InternalAutomationEnv } from '../internal-auth';

const CreateProfileBodySchema = z
  .object({
    encrypted_state_ref: z.string().regex(/^sealed:[A-Za-z0-9][A-Za-z0-9._:/-]{0,2040}$/),
    state_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expires_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export type BrowserProfileRecord = Readonly<{
  profile_id: string;
  project_id: string;
  encrypted_state_ref: string;
  state_hash: string;
  status: 'active' | 'revoked' | 'expired';
  created_by: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}>;

export interface BrowserProfileStore {
  list(input: { accountId: string; projectId: string }): Promise<readonly BrowserProfileRecord[]>;
  create(input: {
    accountId: string;
    projectId: string;
    actorUserId: string;
    encryptedStateRef: string;
    stateHash: `sha256:${string}`;
    expiresAt: string | null;
  }): Promise<BrowserProfileRecord>;
  revoke(input: {
    accountId: string;
    projectId: string;
    profileId: string;
    actorUserId: string;
  }): Promise<BrowserProfileRecord | null>;
}

function toRecord(row: AutomationBrowserProfile): BrowserProfileRecord {
  return {
    profile_id: row.profileId,
    project_id: row.projectId,
    encrypted_state_ref: row.encryptedStateRef,
    state_hash: row.stateHash,
    status: row.status,
    created_by: row.createdBy,
    last_used_at: row.lastUsedAt,
    expires_at: row.expiresAt,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function projectExists(db: Database, accountId: string, projectId: string): Promise<boolean> {
  const [project] = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.projectId, projectId)))
    .limit(1);
  return project !== undefined;
}

export function createPostgresBrowserProfileStore(db: Database): BrowserProfileStore {
  return {
    async list(input) {
      const rows = await db
        .select({ profile: automationBrowserProfiles })
        .from(automationBrowserProfiles)
        .innerJoin(projects, eq(projects.projectId, automationBrowserProfiles.projectId))
        .where(
          and(
            eq(projects.accountId, input.accountId),
            eq(automationBrowserProfiles.projectId, input.projectId),
          ),
        )
        .orderBy(desc(automationBrowserProfiles.updatedAt))
        .limit(128);
      return rows.map(({ profile }) => toRecord(profile));
    },
    async create(input) {
      if (!(await projectExists(db, input.accountId, input.projectId))) {
        const error = new Error('Project was not found') as Error & { code: string };
        error.code = 'AUTOMATION_NOT_FOUND';
        throw error;
      }
      const now = new Date().toISOString();
      const [created] = await db
        .insert(automationBrowserProfiles)
        .values({
          profileId: randomUUID(),
          projectId: input.projectId,
          encryptedStateRef: input.encryptedStateRef,
          stateHash: input.stateHash,
          status: 'active',
          createdBy: input.actorUserId,
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!created) throw new Error('Browser profile insert returned no row');
      return toRecord(created);
    },
    async revoke(input) {
      if (!(await projectExists(db, input.accountId, input.projectId))) return null;
      const now = new Date().toISOString();
      const [updated] = await db
        .update(automationBrowserProfiles)
        .set({ status: 'revoked', revokedAt: now, updatedAt: now })
        .where(
          and(
            eq(automationBrowserProfiles.projectId, input.projectId),
            eq(automationBrowserProfiles.profileId, input.profileId),
            eq(automationBrowserProfiles.status, 'active'),
          ),
        )
        .returning();
      return updated ? toRecord(updated) : null;
    },
  };
}

function publicProfile(profile: BrowserProfileRecord) {
  const { encrypted_state_ref: _encryptedStateRef, ...publicValue } = profile;
  return publicValue;
}

export function createProfilesRouter(store: BrowserProfileStore): Hono<InternalAutomationEnv> {
  const router = new Hono<InternalAutomationEnv>();

  router.get('/', async (context) => {
    const actor = context.get('automationActor');
    const profiles = await store.list({ accountId: actor.accountId, projectId: actor.projectId });
    return context.json({ profiles: profiles.map(publicProfile) });
  });

  router.post('/', async (context) => {
    const body = CreateProfileBodySchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Browser profile request is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const actor = context.get('automationActor');
    const profile = await store.create({
      accountId: actor.accountId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      encryptedStateRef: body.data.encrypted_state_ref,
      stateHash: body.data.state_hash as `sha256:${string}`,
      expiresAt: body.data.expires_at,
    });
    return context.json(publicProfile(profile), 201);
  });

  router.delete('/:profileId', async (context) => {
    const actor = context.get('automationActor');
    const profile = await store.revoke({
      accountId: actor.accountId,
      projectId: actor.projectId,
      profileId: context.req.param('profileId'),
      actorUserId: actor.userId,
    });
    if (!profile) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_NOT_FOUND',
          message: 'Browser profile was not found',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        404,
      );
    }
    return context.json(publicProfile(profile));
  });

  return router;
}
