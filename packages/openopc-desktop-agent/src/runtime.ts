import { homedir } from 'node:os';
import type {
  CapabilityRegistry,
  LocalPermission,
  TunnelAgentLifecycleEvent,
  TunnelConfig,
} from 'agent-tunnel';

import { createOpenOpcCapabilityRegistry } from './capabilities';
import { confirmAndGrantDesktopConsent } from './consent-guard';
import {
  type DesktopConsentStore,
  type NativeConfirmationPort,
  canonicalPermissionScopeDigest,
} from './consent-store';
import { sanitizeRuntimeStatus, transitionRuntimeStatus } from './framed-control';
import type { DesktopRuntimeStatus, DesktopTunnelProfile, DesktopTunnelRuntime } from './types';

export type DesktopSidecarAgentEvent = TunnelAgentLifecycleEvent;

export interface DesktopSidecarAgentPort {
  connect(): void;
  disconnect(): void;
}

export interface DesktopSidecarAgentFactoryInput {
  config: TunnelConfig;
  registry: CapabilityRegistry;
  onEvent: (event: DesktopSidecarAgentEvent) => void;
}

export interface DesktopSidecarRuntimeOptions {
  consentStore: DesktopConsentStore;
  createAgent(input: DesktopSidecarAgentFactoryInput): DesktopSidecarAgentPort;
  createRegistry?: (input: {
    config: TunnelConfig;
    consentStore: DesktopConsentStore;
    tunnelId: string;
    userId: string;
    deviceId: string;
  }) => CapabilityRegistry;
  onStatus?: (status: DesktopRuntimeStatus) => void;
}

export interface DesktopSidecarRuntime extends DesktopTunnelRuntime {
  confirmPermission(permissionId: string, confirmation: NativeConfirmationPort): Promise<boolean>;
}

const INITIAL_STATUS: DesktopRuntimeStatus = {
  state: 'remote_only',
  tunnelId: null,
  userId: null,
  online: false,
  ready: false,
  reason: null,
  pendingPairing: null,
};

function requiredCredential(value: string, field: string): string {
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new Error(`Invalid Desktop Tunnel ${field}`);
  }
  return value;
}

function exactHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid Desktop Tunnel API origin');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('Invalid Desktop Tunnel API origin');
  }
  return url.origin;
}

export function buildDesktopTunnelConfig(profile: DesktopTunnelProfile): TunnelConfig {
  const apiOrigin = exactHttpOrigin(profile.apiOrigin);
  return {
    token: requiredCredential(profile.setupToken, 'setup token'),
    tunnelId: requiredCredential(profile.tunnelId, 'tunnel id'),
    apiUrl: `${apiOrigin}/v1/tunnel`,
    wsPath: '/ws',
    maxFileSize: 10 * 1024 * 1024,
    allowedPaths: [],
    allowedCommands: [],
    blockedCommands: [],
    blockedPaths: [],
    workingDir: homedir(),
    shellTimeout: 30_000,
    shellMaxTimeout: 120_000,
    shellMaxOutputSize: 1024 * 1024,
    shellEnvPassthrough: [
      'PATH',
      'HOME',
      'USER',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TMPDIR',
      'NODE_ENV',
      'HOSTNAME',
    ],
  };
}

function sameProfile(left: DesktopTunnelProfile, right: DesktopTunnelProfile): boolean {
  return (
    left.apiOrigin === right.apiOrigin &&
    left.tunnelId === right.tunnelId &&
    left.setupToken === right.setupToken &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId
  );
}

export function createDesktopSidecarRuntime(
  options: DesktopSidecarRuntimeOptions,
): DesktopSidecarRuntime {
  let currentStatus = INITIAL_STATUS;
  let profile: DesktopTunnelProfile | null = null;
  let agent: DesktopSidecarAgentPort | null = null;
  let generation = 0;
  let permissionsSynced = false;
  const permissions = new Map<string, LocalPermission>();
  const confirmedPermissions = new Map<string, string>();
  const statusListeners = new Set<(status: DesktopRuntimeStatus) => void>();
  if (options.onStatus) statusListeners.add(options.onStatus);

  const publish = (status: DesktopRuntimeStatus): void => {
    currentStatus = sanitizeRuntimeStatus(status);
    for (const listener of statusListeners) {
      try {
        listener(sanitizeRuntimeStatus(currentStatus));
      } catch {
        // A UI observer cannot alter the runtime's fail-closed state.
      }
    }
  };

  const disconnectAgent = (): void => {
    generation += 1;
    const current = agent;
    agent = null;
    if (current) current.disconnect();
  };

  const publishPermissionReadiness = (): void => {
    if (!currentStatus.online) return;
    const ready =
      permissionsSynced &&
      [...permissions].every(
        ([permissionId, permission]) =>
          confirmedPermissions.get(permissionId) === canonicalPermissionScopeDigest(permission),
      );
    publish({
      ...currentStatus,
      state: ready ? 'ready' : 'online',
      ready,
    });
  };

  const stopWithState = (
    reason: string,
    state: 'stopped' | 'reauth_required' | 'error' = 'stopped',
  ): void => {
    if (!agent && (currentStatus.state === 'stopped' || currentStatus.state === state)) return;
    disconnectAgent();
    permissions.clear();
    confirmedPermissions.clear();
    permissionsSynced = false;
    profile = null;
    try {
      options.consentStore.clear(reason);
    } finally {
      publish({
        ...currentStatus,
        state,
        online: false,
        ready: false,
        reason,
        pendingPairing: null,
      });
    }
  };

  const handleEvent = (eventGeneration: number, event: DesktopSidecarAgentEvent): void => {
    if (eventGeneration !== generation || !agent) return;
    try {
      switch (event.type) {
        case 'auth_ok':
          publish(transitionRuntimeStatus(currentStatus, event));
          return;
        case 'permissions_synced':
          for (const [permissionId, previous] of permissions) {
            const next = event.permissions.find(
              (permission) => permission.permissionId === permissionId,
            );
            if (!next) {
              confirmedPermissions.delete(permissionId);
              options.consentStore.revoke(permissionId, 'server_sync_removed');
            } else if (
              canonicalPermissionScopeDigest(previous) !== canonicalPermissionScopeDigest(next)
            ) {
              confirmedPermissions.delete(permissionId);
              options.consentStore.revoke(permissionId, 'server_scope_changed');
            }
          }
          permissions.clear();
          for (const permission of event.permissions) {
            permissions.set(permission.permissionId, permission);
          }
          permissionsSynced = true;
          publishPermissionReadiness();
          return;
        case 'permission_granted': {
          const previous = permissions.get(event.permission.permissionId);
          if (
            previous &&
            canonicalPermissionScopeDigest(previous) !==
              canonicalPermissionScopeDigest(event.permission)
          ) {
            confirmedPermissions.delete(event.permission.permissionId);
            options.consentStore.revoke(event.permission.permissionId, 'server_scope_changed');
          } else if (!previous) {
            confirmedPermissions.delete(event.permission.permissionId);
          }
          permissions.set(event.permission.permissionId, event.permission);
          publishPermissionReadiness();
          return;
        }
        case 'permission_revoked':
          permissions.delete(event.permissionId);
          confirmedPermissions.delete(event.permissionId);
          options.consentStore.revoke(event.permissionId, 'server_revoked');
          publishPermissionReadiness();
          return;
        case 'token_rotated':
          stopWithState('token_rotated', 'reauth_required');
          return;
        case 'connection_closed':
          if (event.code === 4001) stopWithState('auth_failed', 'reauth_required');
          else stopWithState('connection_closed');
          return;
        case 'kill_switch':
          stopWithState('kill_switch');
          return;
      }
    } catch {
      try {
        stopWithState('runtime_error', 'error');
      } catch {
        publish({
          ...currentStatus,
          state: 'error',
          online: false,
          ready: false,
          reason: 'runtime_error',
          pendingPairing: null,
        });
      }
    }
  };

  return {
    async start(nextProfile) {
      if (agent && profile && sameProfile(profile, nextProfile)) return;
      if (agent) stopWithState('profile_changed');

      const config = buildDesktopTunnelConfig(nextProfile);
      requiredCredential(nextProfile.userId, 'user id');
      requiredCredential(nextProfile.deviceId, 'device id');
      profile = { ...nextProfile };
      permissions.clear();
      confirmedPermissions.clear();
      permissionsSynced = false;
      publish(
        transitionRuntimeStatus(currentStatus, {
          type: 'starting',
          tunnelId: nextProfile.tunnelId,
          userId: nextProfile.userId,
        }),
      );

      const registry = (options.createRegistry ?? createOpenOpcCapabilityRegistry)({
        config,
        consentStore: options.consentStore,
        tunnelId: nextProfile.tunnelId,
        userId: nextProfile.userId,
        deviceId: nextProfile.deviceId,
      });
      const eventGeneration = ++generation;
      agent = options.createAgent({
        config,
        registry,
        onEvent: (event) => handleEvent(eventGeneration, event),
      });
      try {
        agent.connect();
      } catch (error) {
        stopWithState('connect_failed', 'error');
        throw error;
      }
    },
    async stop(reason = 'stopped') {
      stopWithState(reason);
    },
    async confirmPermission(permissionId, confirmation) {
      const activeProfile = profile;
      const activeAgent = agent;
      const activeGeneration = generation;
      const permission = permissions.get(permissionId);
      if (
        !activeProfile ||
        !activeAgent ||
        !currentStatus.online ||
        !permissionsSynced ||
        !permission
      ) {
        throw new Error('LOCAL_CONSENT_SERVER_PERMISSION_REQUIRED');
      }
      const scopeDigest = canonicalPermissionScopeDigest(permission);
      const isCurrentPermission = (): boolean => {
        const current = permissions.get(permissionId);
        return (
          agent === activeAgent &&
          profile === activeProfile &&
          generation === activeGeneration &&
          currentStatus.online &&
          !!current &&
          canonicalPermissionScopeDigest(current) === scopeDigest
        );
      };
      const approved = await confirmAndGrantDesktopConsent({
        confirmation: {
          confirm: async (request) =>
            (await confirmation.confirm(request)) && isCurrentPermission(),
        },
        consentStore: options.consentStore,
        request: {
          tunnelId: activeProfile.tunnelId,
          permissionId: permission.permissionId,
          capability: permission.capability,
          scopeDigest,
          expiresAt: permission.expiresAt ?? null,
        },
        userId: activeProfile.userId,
        deviceId: activeProfile.deviceId,
      });
      if (!approved || !isCurrentPermission()) return false;
      confirmedPermissions.set(permissionId, scopeDigest);
      publishPermissionReadiness();
      return true;
    },
    status() {
      return sanitizeRuntimeStatus(currentStatus);
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
  };
}
