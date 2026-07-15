import type { AgentGrant } from '@kortix/db';
import { z } from 'zod';
import type { StudioWorkerJob } from './contracts';
import type { StudioSubmissionAuthorization } from './worker';

const STUDIO_RUN_ACTION = 'project.studio.jobs.run';
const STUDIO_PROVIDER_USE_ACTION = 'project.studio.providers.use';

export const StudioCredentialBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('secret'), identifier: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal('connector'), slug: z.string().trim().min(1) }).strict(),
]);
export type StudioCredentialBinding = z.infer<typeof StudioCredentialBindingSchema>;

export type StudioWorkerTokenRow = {
  status: string;
  revokedAt: Date | null;
  expiresAt: Date | null;
  projectId: string | null;
  accountId: string;
  userId: string;
  sessionId: string | null;
  serviceAccountId: string | null;
  agentGrant: AgentGrant | null;
};

export type StudioWorkerServiceAccountRow = {
  status: string;
  expiresAt: Date | null;
  accountId: string;
  projectId: string | null;
  agentName: string | null;
};

export interface StudioSubmissionAuthorizationDeps {
  loadToken(tokenId: string): Promise<StudioWorkerTokenRow | null>;
  loadServiceAccount?(serviceAccountId: string): Promise<StudioWorkerServiceAccountRow | null>;
  validateCredentialBinding?(input: {
    accountId: string;
    projectId: string;
    binding: StudioCredentialBinding;
  }): Promise<boolean>;
  invalidateAuthorizationCache?(principalIds: string[]): Promise<void>;
  authorizeProjectAction(input: {
    userId: string;
    accountId: string;
    projectId: string;
    action: string;
    actingTokenId?: string;
  }): Promise<boolean>;
  now?: () => Date;
}

export function createStudioSubmissionAuthorization(
  deps: StudioSubmissionAuthorizationDeps,
): StudioSubmissionAuthorization {
  return {
    async revalidate(job) {
      if (!job.providerEnabled) {
        return denied(
          'STUDIO_PROVIDER_UNAVAILABLE',
          'The Studio provider configuration was disabled',
        );
      }
      const credentialBinding = StudioCredentialBindingSchema.safeParse(job.credentialBinding);
      if (!credentialBinding.success) {
        return denied(
          'STUDIO_PROVIDER_CONFIG_INVALID',
          'The Studio provider credential binding is invalid',
        );
      }
      if (
        credentialBinding.data.kind !== 'none' &&
        !(await deps.validateCredentialBinding?.({
          accountId: job.accountId,
          projectId: job.projectId,
          binding: credentialBinding.data,
        }))
      ) {
        return denied(
          'STUDIO_PROVIDER_CREDENTIAL_UNAVAILABLE',
          'The Studio provider credential is inactive or outside the job tenant',
        );
      }
      const now = (deps.now ?? (() => new Date()))();
      let token: StudioWorkerTokenRow | null = null;
      if (job.actingTokenId) {
        token = await deps.loadToken(job.actingTokenId);
        const lifecycleError = tokenLifecycleError(token, now);
        if (lifecycleError) return lifecycleError;
        if (!token) return denied('STUDIO_TOKEN_REVOKED', 'The acting token no longer exists');
        const projectScopeMismatch =
          job.actorType === 'agent'
            ? token.projectId !== job.projectId
            : token.projectId !== null && token.projectId !== job.projectId;
        if (
          projectScopeMismatch ||
          token.accountId !== job.accountId ||
          token.userId !== job.actorUserId ||
          (job.actorType === 'agent' &&
            (!job.sessionId || !token.sessionId || token.sessionId !== job.sessionId))
        ) {
          return denied(
            'STUDIO_TOKEN_SCOPE_REVOKED',
            'The acting token no longer matches the Studio job scope',
          );
        }
      }

      if (
        job.actorType === 'agent' &&
        (!token?.agentGrant || !job.agentName || token.agentGrant.agent !== job.agentName)
      ) {
        return denied(
          'STUDIO_AGENT_GRANT_REVOKED',
          'The Agent grant no longer matches the Studio job actor',
        );
      }

      const serviceAccountId =
        job.actorType === 'system'
          ? job.actorUserId
          : job.actorType === 'agent'
            ? (token?.serviceAccountId ?? null)
            : null;
      if (serviceAccountId) {
        const serviceAccount = deps.loadServiceAccount
          ? await deps.loadServiceAccount(serviceAccountId)
          : null;
        if (
          !serviceAccount ||
          serviceAccount.status !== 'active' ||
          (serviceAccount.expiresAt && serviceAccount.expiresAt.getTime() <= now.getTime()) ||
          serviceAccount.accountId !== job.accountId ||
          (job.actorType === 'agent'
            ? serviceAccount.projectId !== job.projectId
            : serviceAccount.projectId !== null && serviceAccount.projectId !== job.projectId) ||
          (serviceAccount.agentName !== null && serviceAccount.agentName !== job.agentName)
        ) {
          return denied(
            'STUDIO_SERVICE_ACCOUNT_REVOKED',
            'The Service Account no longer matches the Studio job scope or lifecycle',
          );
        }
      } else if (job.actorType === 'system') {
        return denied(
          'STUDIO_SERVICE_ACCOUNT_REVOKED',
          'The Studio job no longer has a Service Account actor',
        );
      }

      if (!job.actorUserId) {
        return denied('STUDIO_ACTOR_REVOKED', 'The Studio job no longer has an active actor');
      }

      await deps.invalidateAuthorizationCache?.([
        ...new Set([job.actorUserId, serviceAccountId].filter((id): id is string => Boolean(id))),
      ]);

      for (const action of [STUDIO_RUN_ACTION, STUDIO_PROVIDER_USE_ACTION]) {
        const allowed = await deps.authorizeProjectAction({
          userId: job.actorUserId,
          accountId: job.accountId,
          projectId: job.projectId,
          action,
          ...(job.actingTokenId ? { actingTokenId: job.actingTokenId } : {}),
        });
        if (!allowed) {
          return denied('STUDIO_IAM_REVOKED', `The actor is no longer authorized for ${action}`);
        }
      }

      const grant = token?.agentGrant ?? null;
      if (grant) {
        if (
          !mayPerform(grant, STUDIO_RUN_ACTION) ||
          !mayPerform(grant, STUDIO_PROVIDER_USE_ACTION)
        ) {
          return denied(
            'STUDIO_AGENT_GRANT_REVOKED',
            'The Agent no longer has both Studio execution grants',
          );
        }
        if (!mayUseCredential(grant, credentialBinding.data)) {
          return denied(
            'STUDIO_AGENT_GRANT_REVOKED',
            'The Agent no longer has access to the provider credential binding',
          );
        }
      }

      return { authorized: true };
    },
  };
}

function tokenLifecycleError(
  token: StudioWorkerTokenRow | null,
  now: Date,
): { authorized: false; code: string; message: string } | null {
  if (!token) return denied('STUDIO_TOKEN_REVOKED', 'The acting token no longer exists');
  if (token.status !== 'active' || token.revokedAt) {
    return denied('STUDIO_TOKEN_REVOKED', 'The acting token has been revoked');
  }
  if (token.expiresAt && token.expiresAt.getTime() <= now.getTime()) {
    return denied('STUDIO_TOKEN_EXPIRED', 'The acting token has expired');
  }
  return null;
}

function mayPerform(grant: AgentGrant, action: string): boolean {
  return grant.kortixCli === 'all' || grant.kortixCli.includes(action);
}

function mayUseCredential(grant: AgentGrant, binding: StudioCredentialBinding): boolean {
  if (binding.kind === 'none') return true;
  if (binding.kind === 'secret') {
    const env = grant.env ?? 'all';
    return (
      env === 'all' || env.some((value) => value.toUpperCase() === binding.identifier.toUpperCase())
    );
  }
  if (binding.kind === 'connector') {
    return grant.connectors === 'all' || grant.connectors.includes(binding.slug);
  }
  return false;
}

function denied(code: string, message: string) {
  return { authorized: false as const, code, message };
}

export type { StudioWorkerJob };
