import { randomUUID } from 'node:crypto';
import { type Database, automationPolicies, projects } from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { InternalAutomationEnv } from '../internal-auth';

const AllowedOriginSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === ''
    );
  }, 'Only HTTP(S) origins without credentials, paths, query, or fragments are allowed');

const PolicyValueSchema = z
  .object({
    allowed_origins: z.array(AllowedOriginSchema).max(64),
    open_network_allowed: z.boolean(),
    persistent_profiles_allowed: z.boolean(),
    full_access_allowed: z.boolean(),
    default_approval_policy: z.enum(['project-default', 'full-access']),
    expected_policy_version: z.string().trim().min(1).max(128),
  })
  .strict();

export type AutomationPolicyRecord = Readonly<{
  project_id: string;
  allowed_origins: readonly string[];
  open_network_allowed: boolean;
  persistent_profiles_allowed: boolean;
  full_access_allowed: boolean;
  default_approval_policy: 'project-default' | 'full-access';
  policy_version: string;
  updated_by: string | null;
  updated_at: string;
}>;

type PolicyValue = Omit<z.infer<typeof PolicyValueSchema>, 'expected_policy_version'>;

export interface AutomationPolicyStore {
  get(input: { accountId: string; projectId: string }): Promise<AutomationPolicyRecord | null>;
  put(input: {
    accountId: string;
    projectId: string;
    actorUserId: string;
    expectedPolicyVersion: string;
    value: PolicyValue;
  }): Promise<AutomationPolicyRecord>;
}

function nextVersion(current: string): string {
  const numeric = Number(current);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? String(numeric + 1) : randomUUID();
}

function conflict(): Error & { code: string } {
  const error = new Error('Automation policy was updated by another request') as Error & {
    code: string;
  };
  error.code = 'AUTOMATION_CONFLICT';
  return error;
}

export function createPostgresAutomationPolicyStore(db: Database): AutomationPolicyStore {
  return {
    async get(input) {
      const [row] = await db
        .select({ policy: automationPolicies })
        .from(automationPolicies)
        .innerJoin(projects, eq(projects.projectId, automationPolicies.projectId))
        .where(
          and(
            eq(projects.accountId, input.accountId),
            eq(automationPolicies.projectId, input.projectId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        project_id: row.policy.projectId,
        allowed_origins: row.policy.allowedOrigins,
        open_network_allowed: row.policy.openNetworkAllowed,
        persistent_profiles_allowed: row.policy.persistentProfilesAllowed,
        full_access_allowed: row.policy.fullAccessAllowed,
        default_approval_policy: row.policy.defaultApprovalPolicy,
        policy_version: row.policy.policyVersion,
        updated_by: row.policy.updatedBy,
        updated_at: row.policy.updatedAt,
      };
    },
    async put(input) {
      return db.transaction(async (tx) => {
        const [project] = await tx
          .select({ projectId: projects.projectId })
          .from(projects)
          .where(
            and(eq(projects.accountId, input.accountId), eq(projects.projectId, input.projectId)),
          )
          .limit(1);
        if (!project) {
          const error = new Error('Project was not found') as Error & { code: string };
          error.code = 'AUTOMATION_NOT_FOUND';
          throw error;
        }
        const [existing] = await tx
          .select()
          .from(automationPolicies)
          .where(eq(automationPolicies.projectId, input.projectId))
          .limit(1)
          .for('update');
        const currentVersion = existing?.policyVersion ?? '1';
        if (input.expectedPolicyVersion !== currentVersion) throw conflict();
        const policyVersion = nextVersion(currentVersion);
        const updatedAt = new Date().toISOString();
        const [updated] = await tx
          .insert(automationPolicies)
          .values({
            projectId: input.projectId,
            allowedOrigins: [...new Set(input.value.allowed_origins)],
            openNetworkAllowed: input.value.open_network_allowed,
            persistentProfilesAllowed: input.value.persistent_profiles_allowed,
            fullAccessAllowed: input.value.full_access_allowed,
            defaultApprovalPolicy: input.value.default_approval_policy,
            policyVersion,
            updatedBy: input.actorUserId,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: automationPolicies.projectId,
            set: {
              allowedOrigins: [...new Set(input.value.allowed_origins)],
              openNetworkAllowed: input.value.open_network_allowed,
              persistentProfilesAllowed: input.value.persistent_profiles_allowed,
              fullAccessAllowed: input.value.full_access_allowed,
              defaultApprovalPolicy: input.value.default_approval_policy,
              policyVersion,
              updatedBy: input.actorUserId,
              updatedAt,
            },
          })
          .returning();
        if (!updated) throw new Error('Automation policy update returned no row');
        return {
          project_id: updated.projectId,
          allowed_origins: updated.allowedOrigins,
          open_network_allowed: updated.openNetworkAllowed,
          persistent_profiles_allowed: updated.persistentProfilesAllowed,
          full_access_allowed: updated.fullAccessAllowed,
          default_approval_policy: updated.defaultApprovalPolicy,
          policy_version: updated.policyVersion,
          updated_by: updated.updatedBy,
          updated_at: updated.updatedAt,
        };
      });
    },
  };
}

function defaultPolicy(projectId: string): AutomationPolicyRecord {
  return {
    project_id: projectId,
    allowed_origins: [],
    open_network_allowed: false,
    persistent_profiles_allowed: false,
    full_access_allowed: false,
    default_approval_policy: 'project-default',
    policy_version: '1',
    updated_by: null,
    updated_at: new Date(0).toISOString(),
  };
}

export function createPoliciesRouter(store: AutomationPolicyStore): Hono<InternalAutomationEnv> {
  const router = new Hono<InternalAutomationEnv>();

  router.get('/', async (context) => {
    const actor = context.get('automationActor');
    const policy = await store.get({ accountId: actor.accountId, projectId: actor.projectId });
    return context.json(policy ?? defaultPolicy(actor.projectId));
  });

  router.put('/', async (context) => {
    const body = PolicyValueSchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Automation policy is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const actor = context.get('automationActor');
    const { expected_policy_version, ...value } = body.data;
    const policy = await store.put({
      accountId: actor.accountId,
      projectId: actor.projectId,
      actorUserId: actor.userId,
      expectedPolicyVersion: expected_policy_version,
      value,
    });
    return context.json(policy);
  });

  return router;
}
