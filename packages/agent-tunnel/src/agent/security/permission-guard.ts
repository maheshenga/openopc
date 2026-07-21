/**
 * Permission Guard — local-side permission enforcement (defense in depth).
 *
 * Even though the server validates permissions before relaying RPCs,
 * the local agent also checks permissions as a second layer of defense.
 * This prevents a compromised server from bypassing permission controls.
 *
 * After the initial permission sync, unknown permissionIds are denied.
 * Before sync, unknown IDs are also denied (fail-closed).
 */

import { assertAutomationActionPolicy, capabilityForMethod } from './automation-action-policy';

export interface LocalPermission {
  permissionId: string;
  capability: string;
  scope: Record<string, unknown>;
  expiresAt?: string;
  policyVersion?: string;
  policy_version?: string;
}

export class PermissionGuard {
  private permissions = new Map<string, LocalPermission>();
  private stopped = false;
  private killSwitchGeneration: number | null = null;

  /** Bulk-load permissions from server sync notification. */
  syncPermissions(permissions: LocalPermission[]): void {
    this.permissions.clear();
    if (this.stopped) return;
    for (const perm of permissions) {
      this.permissions.set(perm.permissionId, perm);
    }
  }

  addPermission(permission: LocalPermission): void {
    if (this.stopped) return;
    this.permissions.set(permission.permissionId, permission);
  }

  revokePermission(permissionId: string): void {
    this.permissions.delete(permissionId);
  }

  checkPermission(permissionId: string | undefined): boolean {
    return !!this.getPermission(permissionId);
  }

  getPermission(permissionId: string | undefined): LocalPermission | null {
    if (this.stopped || !permissionId) {
      return null;
    }

    const perm = this.permissions.get(permissionId);
    if (!perm) {
      // After sync, unknown permission = deny (fail-closed).
      // Before sync, also deny — we have no basis to allow.
      return null;
    }

    if (perm.expiresAt) {
      const expiry = new Date(perm.expiresAt).getTime();
      if (Number.isNaN(expiry) || expiry < Date.now()) {
        this.permissions.delete(permissionId);
        return null;
      }
    }

    return perm;
  }

  checkRequest(input: {
    permissionId: string | undefined;
    capability: string;
    method: string;
    params: Record<string, unknown>;
    now?: number;
  }): LocalPermission {
    if (this.stopped) {
      const generation =
        this.killSwitchGeneration === null ? '' : ` at generation ${this.killSwitchGeneration}`;
      throw new Error(`Permission denied: local kill switch is active${generation}`);
    }

    if (!input.permissionId) {
      throw new Error('Permission denied: no permissionId provided');
    }

    const permission = this.permissions.get(input.permissionId);
    if (!permission) {
      throw new Error(`Permission denied: unknown permission ${input.permissionId}`);
    }

    if (permission.expiresAt) {
      const expiresAt = new Date(permission.expiresAt).getTime();
      const now = input.now ?? Date.now();
      if (!Number.isFinite(expiresAt) || expiresAt <= now) {
        this.permissions.delete(input.permissionId);
        throw new Error(`Permission denied: expired permission ${input.permissionId}`);
      }
    }

    const methodCapability = capabilityForMethod(input.method);
    if (!methodCapability || methodCapability !== input.capability) {
      throw new Error(
        `Permission denied: method ${input.method} is not in capability ${input.capability}`,
      );
    }

    if (permission.capability !== input.capability) {
      throw new Error(
        `Permission capability ${permission.capability} does not match ${input.capability}`,
      );
    }

    assertAutomationActionPolicy({
      scope: permission.scope,
      policyVersion: permission.policyVersion ?? permission.policy_version,
      method: input.method,
      params: input.params,
    });

    return permission;
  }

  revokeAll(): void {
    this.permissions.clear();
  }

  activateKillSwitch(generation?: unknown): void {
    this.stopped = true;
    if (typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0) {
      this.killSwitchGeneration = Math.max(this.killSwitchGeneration ?? 0, generation);
    }
    this.revokeAll();
  }

  clear(): void {
    this.revokeAll();
  }
}
