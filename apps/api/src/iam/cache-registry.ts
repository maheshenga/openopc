interface ScopedMemo {
  invalidateByPrefix: (prefix: string) => void;
}

export interface IamCacheRegistry {
  registerPrincipalScopedMemo(memo: ScopedMemo): void;
  registerProjectScopedMemo(memo: ScopedMemo): void;
  invalidateProjectResources(projectId: string | null | undefined): void;
  invalidatePrincipal(userId: string | null | undefined): void;
  invalidatePrincipals(userIds: Iterable<string | null | undefined>): void;
}

export function createIamCacheRegistry(): IamCacheRegistry {
  const principalScopedMemos: ScopedMemo[] = [];
  const projectScopedMemos: ScopedMemo[] = [];
  const registry: IamCacheRegistry = {
    registerPrincipalScopedMemo(memo) {
      principalScopedMemos.push(memo);
    },
    registerProjectScopedMemo(memo) {
      projectScopedMemos.push(memo);
    },
    invalidateProjectResources(projectId) {
      if (!projectId) return;
      const prefix = `${projectId}|`;
      for (const memo of projectScopedMemos) memo.invalidateByPrefix(prefix);
    },
    invalidatePrincipal(userId) {
      if (!userId) return;
      const prefix = `${userId}|`;
      for (const memo of principalScopedMemos) memo.invalidateByPrefix(prefix);
    },
    invalidatePrincipals(userIds) {
      for (const userId of userIds) registry.invalidatePrincipal(userId);
    },
  };
  return registry;
}

export const defaultIamCacheRegistry = createIamCacheRegistry();

export const registerPrincipalScopedMemo =
  defaultIamCacheRegistry.registerPrincipalScopedMemo.bind(defaultIamCacheRegistry);
export const registerProjectScopedMemo =
  defaultIamCacheRegistry.registerProjectScopedMemo.bind(defaultIamCacheRegistry);
export const invalidateIamCacheForProjectResources =
  defaultIamCacheRegistry.invalidateProjectResources.bind(defaultIamCacheRegistry);
export const invalidateIamCacheForUser =
  defaultIamCacheRegistry.invalidatePrincipal.bind(defaultIamCacheRegistry);
export const invalidateIamCacheForUsers =
  defaultIamCacheRegistry.invalidatePrincipals.bind(defaultIamCacheRegistry);
