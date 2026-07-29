'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Clock3, Cloud, Loader2, MonitorCog, ShieldCheck, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export type LocalGrantCapability =
  'filesystem' | 'app_connector' | 'desktop_automation' | 'local_execution' | 'full_access';

export interface LocalGrant {
  grantId: string;
  capability: LocalGrantCapability;
  roots: string[];
  userId: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  commandDigest: `sha256:${string}`;
  approvedLocally: true;
  revokedAt?: string | null;
}

export interface LocalGrantCommand {
  grantId: string;
  capability: LocalGrantCapability;
  roots: string[];
  userId: string;
  deviceId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  executionMode: 'foreground';
  commandDigest: `sha256:${string}`;
  signature: string;
}

export interface LocalAccessBridge {
  requestLocalGrant(request: { command: LocalGrantCommand }): Promise<LocalGrant>;
  listLocalGrants(): Promise<LocalGrant[]>;
  revokeLocalGrant(request: { grantId: string; reason?: string }): Promise<LocalGrant>;
}

export interface LocalAccessOperationContext {
  userId: string;
  bridge: LocalAccessBridge | null;
}

export interface LocalAccessOperationToken extends LocalAccessOperationContext {
  generation: number;
}

export function createLocalAccessOperationGuard(initial: LocalAccessOperationContext) {
  let current = initial;
  let generation = 0;

  return {
    invalidate() {
      generation += 1;
    },
    update(next: LocalAccessOperationContext) {
      if (current.userId !== next.userId || current.bridge !== next.bridge) {
        generation += 1;
      }
      current = next;
    },
    capture(): LocalAccessOperationToken {
      return { ...current, generation };
    },
    isCurrent(token: LocalAccessOperationToken): boolean {
      return (
        token.generation === generation &&
        token.userId === current.userId &&
        token.bridge === current.bridge
      );
    },
  };
}

export interface LocalAccessPanelProps {
  userId: string;
  pendingCommand?: LocalGrantCommand | null;
  bridge?: LocalAccessBridge | null;
  initialGrants?: LocalGrant[];
}

export type LocalGrantListResult = {
  grants: LocalGrant[];
  error: string | null;
};

function isLocalGrant(value: unknown): value is LocalGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  const roots = grant.roots;
  const issuedAt = typeof grant.issuedAt === 'string' ? Date.parse(grant.issuedAt) : Number.NaN;
  const expiresAt = typeof grant.expiresAt === 'string' ? Date.parse(grant.expiresAt) : Number.NaN;
  const revokedAt = grant.revokedAt;
  return (
    typeof grant.grantId === 'string' &&
    grant.grantId.length > 0 &&
    typeof grant.capability === 'string' &&
    grant.capability in CAPABILITY_LABELS &&
    Array.isArray(roots) &&
    roots.length > 0 &&
    roots.every((root) => typeof root === 'string' && root.length > 0) &&
    typeof grant.userId === 'string' &&
    grant.userId.length > 0 &&
    typeof grant.deviceId === 'string' &&
    grant.deviceId.length > 0 &&
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    expiresAt > issuedAt &&
    typeof grant.commandDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(grant.commandDigest) &&
    grant.approvedLocally === true &&
    (revokedAt == null || (typeof revokedAt === 'string' && Number.isFinite(Date.parse(revokedAt))))
  );
}

function filterLocalGrants(value: unknown, userId: string): LocalGrant[] {
  return Array.isArray(value)
    ? value.filter((grant): grant is LocalGrant => isLocalGrant(grant) && grant.userId === userId)
    : [];
}

export function createLocalGrantListLoader() {
  let generation = 0;
  return {
    invalidate() {
      generation += 1;
    },
    async load(
      bridge: Pick<LocalAccessBridge, 'listLocalGrants'>,
      userId: string,
    ): Promise<LocalGrantListResult | null> {
      const requestGeneration = ++generation;
      try {
        const loaded = await bridge.listLocalGrants();
        if (requestGeneration !== generation) return null;
        return {
          grants: filterLocalGrants(loaded, userId),
          error: null,
        };
      } catch (cause) {
        if (requestGeneration !== generation) return null;
        return {
          grants: [],
          error: cause instanceof Error ? cause.message : 'Local access is unavailable',
        };
      }
    },
  };
}

const CAPABILITY_LABELS: Record<LocalGrantCapability, string> = {
  filesystem: 'Filesystem',
  app_connector: 'App connector',
  desktop_automation: 'Desktop automation',
  local_execution: 'Local execution',
  full_access: 'Full access',
};

function browserBridge(): LocalAccessBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (
    window as unknown as {
      kortixDesktop?: Partial<LocalAccessBridge>;
    }
  ).kortixDesktop;
  if (
    typeof candidate?.requestLocalGrant !== 'function' ||
    typeof candidate.listLocalGrants !== 'function' ||
    typeof candidate.revokeLocalGrant !== 'function'
  ) {
    return null;
  }
  return candidate as LocalAccessBridge;
}

function expiryLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

export function localGrantStatus(
  grant: Pick<LocalGrant, 'expiresAt' | 'revokedAt'>,
  now = new Date(),
): 'active' | 'expired' | 'revoked' {
  if (grant.revokedAt) return 'revoked';
  const expiry = Date.parse(grant.expiresAt);
  return Number.isFinite(expiry) && expiry <= now.getTime() ? 'expired' : 'active';
}

export function LocalAccessPanel({
  userId,
  pendingCommand = null,
  bridge,
  initialGrants = [],
}: LocalAccessPanelProps) {
  const [activeBridge, setActiveBridge] = useState<LocalAccessBridge | null>(() => bridge ?? null);
  const [operationGuard] = useState(() =>
    createLocalAccessOperationGuard({ userId, bridge: bridge ?? null }),
  );
  const [grants, setGrants] = useState<LocalGrant[]>(() =>
    filterLocalGrants(initialGrants, userId),
  );
  const [loading, setLoading] = useState(false);
  const [workingGrantId, setWorkingGrantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const grantListLoader = useRef(createLocalGrantListLoader());

  const loadGrants = useCallback(
    async (nextBridge: LocalAccessBridge | null) => {
      const operation = operationGuard.capture();
      if (operation.userId !== userId || operation.bridge !== nextBridge) {
        return;
      }
      if (!nextBridge || !userId) {
        grantListLoader.current.invalidate();
        setGrants([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      const result = await grantListLoader.current.load(nextBridge, userId);
      if (!result || !operationGuard.isCurrent(operation)) return;
      setGrants(result.grants);
      setError(result.error);
      setLoading(false);
    },
    [operationGuard, userId],
  );

  const refresh = useCallback(
    async (nextBridge: LocalAccessBridge | null = activeBridge) => loadGrants(nextBridge),
    [activeBridge, loadGrants],
  );

  useIsomorphicLayoutEffect(() => {
    grantListLoader.current.invalidate();
    const nextBridge = bridge === undefined ? browserBridge() : bridge;
    operationGuard.update({ userId, bridge: nextBridge ?? null });
    setActiveBridge(nextBridge ?? null);
    setGrants([]);
    setLoading(false);
    setWorkingGrantId(null);
    setError(null);
    if (nextBridge && userId) void loadGrants(nextBridge);
    return () => {
      grantListLoader.current.invalidate();
      operationGuard.invalidate();
    };
  }, [bridge, loadGrants, operationGuard, userId]);

  const requestGrant = async () => {
    if (!activeBridge || !pendingCommand) return;
    const operation = operationGuard.capture();
    if (
      operation.userId !== userId ||
      operation.bridge !== activeBridge ||
      !operationGuard.isCurrent(operation)
    ) {
      return;
    }
    setWorkingGrantId(pendingCommand.grantId);
    setError(null);
    try {
      if (pendingCommand.userId !== userId) {
        throw new Error('Local grant user identity mismatch');
      }
      await activeBridge.requestLocalGrant({ command: pendingCommand });
      if (!operationGuard.isCurrent(operation)) return;
      await refresh(activeBridge);
      if (!operationGuard.isCurrent(operation)) return;
    } catch (cause) {
      if (operationGuard.isCurrent(operation)) {
        setError(cause instanceof Error ? cause.message : 'Local access was not approved');
      }
    } finally {
      if (operationGuard.isCurrent(operation)) setWorkingGrantId(null);
    }
  };

  const revokeGrant = async (grantId: string) => {
    if (!activeBridge) return;
    const operation = operationGuard.capture();
    if (
      operation.userId !== userId ||
      operation.bridge !== activeBridge ||
      !operationGuard.isCurrent(operation)
    ) {
      return;
    }
    setWorkingGrantId(grantId);
    setError(null);
    try {
      await activeBridge.revokeLocalGrant({ grantId, reason: 'user_revoked' });
      if (!operationGuard.isCurrent(operation)) return;
      await refresh(activeBridge);
      if (!operationGuard.isCurrent(operation)) return;
    } catch (cause) {
      if (operationGuard.isCurrent(operation)) {
        setError(cause instanceof Error ? cause.message : 'Local access could not be revoked');
      }
    } finally {
      if (operationGuard.isCurrent(operation)) setWorkingGrantId(null);
    }
  };

  if (!activeBridge) {
    return (
      <section
        data-local-access-panel
        data-local-access-mode="remote-only"
        className="border-border bg-background rounded-md border px-4 py-4"
      >
        <div className="flex items-start gap-3">
          <span className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
            <Cloud className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-foreground text-sm font-medium">Local access</h2>
              <Badge variant="muted" size="xs">
                Remote-only
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              Web access remains available. Local capabilities require OpenOPC Desktop.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section
      data-local-access-panel
      data-local-access-mode="desktop"
      className="border-border bg-background overflow-hidden rounded-md border"
    >
      <header className="border-border/70 flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
            <MonitorCog className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 className="text-foreground text-sm font-medium">Local access</h2>
            <p className="text-muted-foreground text-xs">{grants.length} grants on this device</p>
          </div>
        </div>
        {loading && <Loader2 className="text-muted-foreground size-4 animate-spin" />}
      </header>

      {pendingCommand && (
        <div className="border-border/70 bg-muted/25 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="text-foreground size-4" />
              <span className="text-foreground text-sm font-medium">
                {CAPABILITY_LABELS[pendingCommand.capability]}
              </span>
              <Badge variant="outline" size="xs">
                Local confirmation
              </Badge>
            </div>
            <p className="text-muted-foreground mt-1 truncate text-xs">
              {pendingCommand.roots.join(', ')}
            </p>
          </div>
          <Button
            size="sm"
            onClick={requestGrant}
            disabled={workingGrantId === pendingCommand.grantId}
          >
            {workingGrantId === pendingCommand.grantId ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ShieldCheck className="size-4" />
            )}
            Approve on this device
          </Button>
        </div>
      )}

      {error && (
        <div role="status" className="border-border/70 text-destructive border-b px-4 py-2 text-xs">
          {error}
        </div>
      )}

      <div className="divide-border divide-y">
        {grants.length === 0 ? (
          <div className="text-muted-foreground px-4 py-6 text-center text-xs">No local grants</div>
        ) : (
          grants.map((grant) =>
            (() => {
              const status = localGrantStatus(grant);
              return (
                <div
                  key={grant.grantId}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground text-sm font-medium">
                        {CAPABILITY_LABELS[grant.capability]}
                      </span>
                      <Badge variant={status === 'active' ? 'success' : 'muted'} size="xs">
                        {status === 'active'
                          ? 'Active'
                          : status === 'expired'
                            ? 'Expired'
                            : 'Revoked'}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground mt-1 truncate text-xs">
                      {grant.roots.join(', ')}
                    </p>
                    <p className="text-muted-foreground mt-1 flex items-center gap-1 text-xs">
                      <Clock3 className="size-3" /> Expires {expiryLabel(grant.expiresAt)}
                    </p>
                  </div>
                  {status === 'active' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Revoke ${CAPABILITY_LABELS[grant.capability]}`}
                      title="Revoke local grant"
                      onClick={() => revokeGrant(grant.grantId)}
                      disabled={workingGrantId === grant.grantId}
                    >
                      {workingGrantId === grant.grantId ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Trash2 className="size-4" />
                      )}
                    </Button>
                  )}
                </div>
              );
            })(),
          )
        )}
      </div>
    </section>
  );
}
