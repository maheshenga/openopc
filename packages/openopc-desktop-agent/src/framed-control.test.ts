import { describe, expect, test } from 'bun:test';

import {
  CONTROL_FRAME_MAX_BYTES,
  createBootstrapGate,
  decodeControlFrame,
  encodeControlFrame,
  sanitizeRuntimeStatus,
  transitionRuntimeStatus,
} from './framed-control';
import type { DesktopRuntimeStatus } from './types';

const initialStatus: DesktopRuntimeStatus = {
  state: 'remote_only',
  tunnelId: null,
  userId: null,
  online: false,
  ready: false,
  reason: null,
  pendingPairing: null,
};

describe('desktop sidecar control frames', () => {
  test('round-trips an allowed status frame', () => {
    const encoded = encodeControlFrame({
      type: 'status',
      status: {
        ...initialStatus,
        state: 'online',
        tunnelId: 'tunnel-1',
        userId: 'user-1',
        online: true,
      },
    });

    expect(encoded.endsWith('\n')).toBe(true);
    expect(decodeControlFrame(encoded)).toEqual({
      type: 'status',
      status: {
        ...initialStatus,
        state: 'online',
        tunnelId: 'tunnel-1',
        userId: 'user-1',
        online: true,
      },
    });
  });

  test('rejects oversized, truncated, and unknown control frames', () => {
    const oversized = `${JSON.stringify({ type: 'status', value: 'x'.repeat(CONTROL_FRAME_MAX_BYTES) })}\n`;

    expect(() => decodeControlFrame(oversized)).toThrow('Control frame exceeds 65536 bytes');
    expect(() => decodeControlFrame('{"type":"status"')).toThrow(
      'Control frame must end with a newline',
    );
    expect(() => decodeControlFrame('{"type":"unexpected"}\n')).toThrow(
      'Unknown control frame type',
    );
  });

  test('removes credential fields from renderer-visible status projections', () => {
    const projected = sanitizeRuntimeStatus({
      ...initialStatus,
      state: 'pairing_pending',
      pendingPairing: {
        code: 'ABCD-EFGH',
        verificationUrl: 'https://app.example.com/tunnel/authorize/ABCD-EFGH',
        expiresAt: '2026-07-29T06:00:00.000Z',
      },
      setupToken: 'secret-token',
      deviceSecret: 'secret-device-code',
    });

    expect(projected).toEqual({
      ...initialStatus,
      state: 'pairing_pending',
      pendingPairing: {
        code: 'ABCD-EFGH',
        verificationUrl: 'https://app.example.com/tunnel/authorize/ABCD-EFGH',
        expiresAt: '2026-07-29T06:00:00.000Z',
      },
    });
    expect(JSON.stringify(projected)).not.toContain('secret-token');
    expect(JSON.stringify(projected)).not.toContain('secret-device-code');
  });

  test('cannot become ready before an authenticated online transition', () => {
    const premature = transitionRuntimeStatus(initialStatus, {
      type: 'permissions_synced',
      ready: true,
    });
    expect(premature).toEqual(initialStatus);

    const starting = transitionRuntimeStatus(initialStatus, {
      type: 'starting',
      tunnelId: 'tunnel-1',
      userId: 'user-1',
    });
    const online = transitionRuntimeStatus(starting, { type: 'auth_ok' });
    const ready = transitionRuntimeStatus(online, {
      type: 'permissions_synced',
      ready: true,
    });

    expect(online.state).toBe('online');
    expect(online.online).toBe(true);
    expect(online.ready).toBe(false);
    expect(ready.state).toBe('ready');
    expect(ready.online).toBe(true);
    expect(ready.ready).toBe(true);
  });

  test('accepts exactly one authenticated bootstrap profile', () => {
    const gate = createBootstrapGate();
    const bootstrap = {
      type: 'bootstrap' as const,
      profile: {
        apiOrigin: 'https://app.example.com',
        tunnelId: 'tunnel-1',
        setupToken: 'setup-secret',
        userId: 'user-1',
        deviceId: 'device-1',
      },
      controlKey: 'control-secret',
    };

    expect(gate.accept(bootstrap)).toEqual(bootstrap.profile);
    expect(() => gate.accept(bootstrap)).toThrow('Bootstrap already accepted');
  });

  test('rejects inconsistent renderer-visible runtime status', () => {
    expect(() =>
      sanitizeRuntimeStatus({
        ...initialStatus,
        state: 'ready',
        online: false,
        ready: true,
      }),
    ).toThrow('Ready runtime status must be online');
  });
});
