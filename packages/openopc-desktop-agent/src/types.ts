export type DesktopRuntimeState =
  | 'remote_only'
  | 'pairing_pending'
  | 'starting'
  | 'online'
  | 'ready'
  | 'stopped'
  | 'reauth_required'
  | 'error';

export interface DesktopPendingPairing {
  code: string;
  verificationUrl: string;
  expiresAt: string;
}

export interface DesktopRuntimeStatus {
  state: DesktopRuntimeState;
  tunnelId: string | null;
  userId: string | null;
  online: boolean;
  ready: boolean;
  reason: string | null;
  pendingPairing: DesktopPendingPairing | null;
}

export interface DesktopTunnelProfile {
  apiOrigin: string;
  tunnelId: string;
  setupToken: string;
  userId: string;
  deviceId: string;
}

export interface DesktopTunnelRuntime {
  start(profile: DesktopTunnelProfile): Promise<void>;
  stop(reason?: string): Promise<void>;
  status(): DesktopRuntimeStatus;
  onStatus(listener: (status: DesktopRuntimeStatus) => void): () => void;
}
