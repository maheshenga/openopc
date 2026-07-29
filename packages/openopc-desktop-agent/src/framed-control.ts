import type {
  DesktopPendingPairing,
  DesktopRuntimeState,
  DesktopRuntimeStatus,
  DesktopTunnelProfile,
} from './types';

export const CONTROL_FRAME_MAX_BYTES = 64 * 1024;

const RUNTIME_STATES = new Set<DesktopRuntimeState>([
  'remote_only',
  'pairing_pending',
  'starting',
  'online',
  'ready',
  'stopped',
  'reauth_required',
  'error',
]);

export type ControlFrame = {
  type: 'status';
  status: DesktopRuntimeStatus;
};

export type RuntimeStatusEvent =
  | { type: 'starting'; tunnelId: string; userId: string }
  | { type: 'auth_ok' }
  | { type: 'permissions_synced'; ready: boolean }
  | { type: 'stopped'; reason: string | null };

export interface BootstrapFrame {
  type: 'bootstrap';
  profile: DesktopTunnelProfile;
  controlKey: string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function pendingPairing(value: unknown): DesktopPendingPairing | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid pending pairing status');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.code !== 'string' ||
    typeof record.verificationUrl !== 'string' ||
    typeof record.expiresAt !== 'string'
  ) {
    throw new Error('Invalid pending pairing status');
  }
  return {
    code: record.code,
    verificationUrl: record.verificationUrl,
    expiresAt: record.expiresAt,
  };
}

export function sanitizeRuntimeStatus(value: unknown): DesktopRuntimeStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid runtime status');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.state !== 'string' ||
    !RUNTIME_STATES.has(record.state as DesktopRuntimeState)
  ) {
    throw new Error('Invalid runtime state');
  }
  const status = {
    state: record.state as DesktopRuntimeState,
    tunnelId: nullableString(record.tunnelId),
    userId: nullableString(record.userId),
    online: record.online === true,
    ready: record.ready === true,
    reason: nullableString(record.reason),
    pendingPairing: pendingPairing(record.pendingPairing),
  };
  if (status.ready && !status.online) {
    throw new Error('Ready runtime status must be online');
  }
  return status;
}

function validateBootstrap(frame: BootstrapFrame): DesktopTunnelProfile {
  if (
    frame.type !== 'bootstrap' ||
    typeof frame.controlKey !== 'string' ||
    frame.controlKey.length === 0 ||
    !frame.profile ||
    typeof frame.profile.apiOrigin !== 'string' ||
    typeof frame.profile.tunnelId !== 'string' ||
    typeof frame.profile.setupToken !== 'string' ||
    typeof frame.profile.userId !== 'string' ||
    typeof frame.profile.deviceId !== 'string'
  ) {
    throw new Error('Invalid bootstrap frame');
  }
  return { ...frame.profile };
}

export function createBootstrapGate(): {
  accept(frame: BootstrapFrame): DesktopTunnelProfile;
} {
  let accepted = false;
  return {
    accept(frame) {
      if (accepted) throw new Error('Bootstrap already accepted');
      const profile = validateBootstrap(frame);
      accepted = true;
      return profile;
    },
  };
}

export function encodeControlFrame(frame: ControlFrame): string {
  const encoded = `${JSON.stringify({ type: 'status', status: sanitizeRuntimeStatus(frame.status) })}\n`;
  if (byteLength(encoded) > CONTROL_FRAME_MAX_BYTES) {
    throw new Error(`Control frame exceeds ${CONTROL_FRAME_MAX_BYTES} bytes`);
  }
  return encoded;
}

export function decodeControlFrame(raw: string): ControlFrame {
  if (byteLength(raw) > CONTROL_FRAME_MAX_BYTES) {
    throw new Error(`Control frame exceeds ${CONTROL_FRAME_MAX_BYTES} bytes`);
  }
  if (!raw.endsWith('\n')) {
    throw new Error('Control frame must end with a newline');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(0, -1));
  } catch {
    throw new Error('Invalid control frame JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid control frame');
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== 'status') {
    throw new Error('Unknown control frame type');
  }
  return { type: 'status', status: sanitizeRuntimeStatus(record.status) };
}

export function transitionRuntimeStatus(
  current: DesktopRuntimeStatus,
  event: RuntimeStatusEvent,
): DesktopRuntimeStatus {
  switch (event.type) {
    case 'starting':
      return {
        state: 'starting',
        tunnelId: event.tunnelId,
        userId: event.userId,
        online: false,
        ready: false,
        reason: null,
        pendingPairing: null,
      };
    case 'auth_ok':
      if (current.state !== 'starting') return current;
      return { ...current, state: 'online', online: true, ready: false, reason: null };
    case 'permissions_synced':
      if (!current.online) return current;
      return {
        ...current,
        state: event.ready ? 'ready' : 'online',
        ready: event.ready,
      };
    case 'stopped':
      return {
        ...current,
        state: 'stopped',
        online: false,
        ready: false,
        reason: event.reason,
      };
  }
}
