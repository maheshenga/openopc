import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  type CapabilityRegistry,
  type LocalPermission,
  type TunnelConfig,
  signMessage,
} from 'agent-tunnel';

import {
  type DesktopConsentStore,
  type DesktopConsentStoreOptions,
  canonicalPermissionScopeDigest,
} from './consent-store';
import {
  type DesktopSidecarAgentEvent,
  type DesktopSidecarAgentPort,
  createDesktopSidecarRuntime,
} from './runtime';
import { createSidecarControlSession, runDesktopAgentSidecar } from './sidecar-entry';
import type { DesktopRuntimeStatus, DesktopTunnelProfile } from './types';

const PROFILE: DesktopTunnelProfile = {
  apiOrigin: 'https://api.example.com',
  tunnelId: 'tunnel-1',
  setupToken: 'setup-secret-never-rendered',
  userId: 'user-1',
  deviceId: 'device-1',
};

const STOPPED_STATUS: DesktopRuntimeStatus = {
  state: 'stopped',
  tunnelId: null,
  userId: null,
  online: false,
  ready: false,
  reason: null,
  pendingPairing: null,
};

function fakeConsentStore() {
  const granted: unknown[] = [];
  const revoked: Array<{ permissionId: string; reason: string }> = [];
  const cleared: string[] = [];
  const store: DesktopConsentStore = {
    grant: (input) => {
      granted.push(input);
    },
    grantBundle: () => undefined,
    revoke: (permissionId, reason) => revoked.push({ permissionId, reason }),
    clear: (reason) => cleared.push(reason),
    issuePermit: () => {
      throw new Error('not used');
    },
    consumePermit: async () => undefined,
    authorize: async () => undefined,
  };
  return { store, granted, revoked, cleared };
}

function signedControlFrame(key: string, nonce: number, payload: Record<string, unknown>): string {
  return `${JSON.stringify({
    ...payload,
    _sig: signMessage(key, JSON.stringify(payload), nonce),
    _nonce: nonce,
  })}\n`;
}

function fakeAgentHarness() {
  let listener: ((event: DesktopSidecarAgentEvent) => void) | undefined;
  let creates = 0;
  let connects = 0;
  let disconnects = 0;
  let config: TunnelConfig | undefined;
  const agent: DesktopSidecarAgentPort = {
    connect() {
      connects += 1;
    },
    disconnect() {
      disconnects += 1;
    },
  };
  return {
    create(input: {
      config: TunnelConfig;
      registry: CapabilityRegistry;
      onEvent: (event: DesktopSidecarAgentEvent) => void;
    }) {
      creates += 1;
      config = input.config;
      listener = input.onEvent;
      return agent;
    },
    emit(event: DesktopSidecarAgentEvent) {
      if (!listener) throw new Error('agent listener is not installed');
      listener(event);
    },
    snapshot: () => ({ creates, connects, disconnects, config }),
  };
}

function permission(
  permissionId: string,
  capability: LocalPermission['capability'] = 'filesystem',
): LocalPermission {
  return {
    permissionId,
    capability,
    scope: capability === 'filesystem' ? { paths: ['C:/workspace'] } : {},
    expiresAt: '2026-07-29T12:00:00.000Z',
  };
}

describe('desktop agent sidecar runtime', () => {
  test('starts one TunnelAgent for an idempotent bootstrap and never exposes the token', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const statuses: DesktopRuntimeStatus[] = [];
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
      onStatus: (status) => statuses.push(status),
    });

    await runtime.start(PROFILE);
    await runtime.start({ ...PROFILE });

    expect(agents.snapshot().creates).toBe(1);
    expect(agents.snapshot().connects).toBe(1);
    expect(agents.snapshot().config).toMatchObject({
      token: PROFILE.setupToken,
      tunnelId: PROFILE.tunnelId,
      apiUrl: 'https://api.example.com/v1/tunnel',
      wsPath: '/ws',
    });
    expect(runtime.status()).toMatchObject({
      state: 'starting',
      tunnelId: PROFILE.tunnelId,
      userId: PROFILE.userId,
      online: false,
      ready: false,
    });
    expect(JSON.stringify(statuses)).not.toContain(PROFILE.setupToken);
  });

  test('disconnects once and clears consent on repeated stop calls', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    await runtime.start(PROFILE);

    await runtime.stop('user_stop');
    await runtime.stop('user_stop');

    expect(agents.snapshot().disconnects).toBe(1);
    expect(consent.cleared).toEqual(['user_stop']);
    expect(runtime.status()).toMatchObject({
      state: 'stopped',
      online: false,
      ready: false,
      reason: 'user_stop',
    });
  });

  test('applies only verified Agent lifecycle events to status and local consent', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    await runtime.start(PROFILE);

    agents.emit({ type: 'auth_ok' });
    agents.emit({
      type: 'permissions_synced',
      permissions: [permission('permission-fs'), permission('permission-shell', 'shell')],
    });
    expect(runtime.status()).toMatchObject({ state: 'online', online: true, ready: false });

    agents.emit({ type: 'permission_revoked', permissionId: 'permission-fs' });
    expect(consent.revoked).toEqual([{ permissionId: 'permission-fs', reason: 'server_revoked' }]);

    agents.emit({ type: 'token_rotated' });
    await Promise.resolve();
    expect(consent.cleared).toEqual(['token_rotated']);
    expect(agents.snapshot().disconnects).toBe(1);
    expect(runtime.status()).toMatchObject({
      state: 'reauth_required',
      online: false,
      ready: false,
      reason: 'token_rotated',
    });
  });

  test('clears consent when the verified Agent reports disconnect or kill switch', async () => {
    for (const event of [
      { type: 'connection_closed', code: 1006 } as const,
      { type: 'kill_switch', generation: 9 } as const,
    ]) {
      const consent = fakeConsentStore();
      const agents = fakeAgentHarness();
      const runtime = createDesktopSidecarRuntime({
        consentStore: consent.store,
        createAgent: agents.create,
      });
      await runtime.start(PROFILE);
      agents.emit(event);
      await Promise.resolve();

      expect(consent.cleared).toEqual([event.type]);
      expect(runtime.status()).toMatchObject({
        state: 'stopped',
        online: false,
        ready: false,
        reason: event.type,
      });
    }
  });

  test('requires reauthentication after WebSocket auth failure', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    await runtime.start(PROFILE);

    agents.emit({ type: 'connection_closed', code: 4001 });
    await Promise.resolve();

    expect(consent.cleared).toEqual(['auth_failed']);
    expect(runtime.status()).toMatchObject({
      state: 'reauth_required',
      online: false,
      ready: false,
      reason: 'auth_failed',
    });
  });

  test('revokes local consent removed by a complete permission sync', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    await runtime.start(PROFILE);
    agents.emit({ type: 'auth_ok' });
    agents.emit({
      type: 'permissions_synced',
      permissions: [permission('permission-old')],
    });

    agents.emit({ type: 'permissions_synced', permissions: [] });

    expect(consent.revoked).toContainEqual({
      permissionId: 'permission-old',
      reason: 'server_sync_removed',
    });
    expect(runtime.status()).toMatchObject({ state: 'ready', online: true, ready: true });
  });

  test('confirms only a verified server permission before granting local consent', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    const serverPermission = permission('permission-confirm');
    await runtime.start(PROFILE);
    agents.emit({ type: 'auth_ok' });
    agents.emit({ type: 'permissions_synced', permissions: [serverPermission] });

    const requests: unknown[] = [];
    await expect(
      runtime.confirmPermission('permission-confirm', {
        confirm: async (request) => {
          requests.push(request);
          return true;
        },
      }),
    ).resolves.toBe(true);

    expect(requests).toEqual([
      {
        tunnelId: PROFILE.tunnelId,
        permissionId: serverPermission.permissionId,
        capability: serverPermission.capability,
        scopeDigest: canonicalPermissionScopeDigest(serverPermission),
        expiresAt: serverPermission.expiresAt ?? null,
      },
    ]);
    expect(consent.granted).toHaveLength(1);
    expect(runtime.status()).toMatchObject({ state: 'ready', online: true, ready: true });
    await expect(
      runtime.confirmPermission('permission-missing', { confirm: async () => true }),
    ).rejects.toThrow('LOCAL_CONSENT_SERVER_PERMISSION_REQUIRED');
  });

  test('does not grant consent when the verified permission changes during confirmation', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    await runtime.start(PROFILE);
    agents.emit({ type: 'auth_ok' });
    agents.emit({
      type: 'permissions_synced',
      permissions: [permission('permission-race')],
    });
    let respond: ((approved: boolean) => void) | undefined;
    const confirmation = runtime.confirmPermission('permission-race', {
      confirm: () =>
        new Promise<boolean>((resolve) => {
          respond = resolve;
        }),
    });
    await Promise.resolve();

    agents.emit({ type: 'permission_revoked', permissionId: 'permission-race' });
    respond?.(true);

    await expect(confirmation).resolves.toBe(false);
    expect(consent.granted).toHaveLength(0);
    expect(runtime.status()).toMatchObject({ state: 'ready', online: true, ready: true });
  });

  test('invalidates confirmed consent when an incremental grant changes scope', async () => {
    const consent = fakeConsentStore();
    const agents = fakeAgentHarness();
    const runtime = createDesktopSidecarRuntime({
      consentStore: consent.store,
      createAgent: agents.create,
    });
    const original = permission('permission-scope');
    await runtime.start(PROFILE);
    agents.emit({ type: 'auth_ok' });
    agents.emit({ type: 'permissions_synced', permissions: [original] });
    await runtime.confirmPermission(original.permissionId, { confirm: async () => true });

    agents.emit({
      type: 'permission_granted',
      permission: { ...original, scope: { paths: ['C:/different'] } },
    });

    expect(consent.revoked).toContainEqual({
      permissionId: original.permissionId,
      reason: 'server_scope_changed',
    });
    expect(runtime.status()).toMatchObject({ state: 'online', online: true, ready: false });
  });
});

describe('desktop agent sidecar control session', () => {
  test('never starts the runtime for a malformed first frame', async () => {
    let starts = 0;
    const stops: string[] = [];
    const fatal: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => {
          starts += 1;
        },
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
        },
        status: () => STOPPED_STATUS,
      },
      write: () => undefined,
      onFatal: (reason) => fatal.push(reason),
    });

    await session.receive('{"type":"unexpected"}\n');

    expect(starts).toBe(0);
    expect(stops).toEqual(['control_protocol_error']);
    expect(fatal).toEqual(['control_protocol_error']);
  });

  test('accepts one bootstrap and stops on duplicate or unauthenticated control frames', async () => {
    let starts = 0;
    const stops: string[] = [];
    const output: string[] = [];
    const fatal: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => {
          starts += 1;
        },
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
        },
        status: () => ({
          ...STOPPED_STATUS,
          state: 'starting',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
        }),
      },
      write: (frame) => output.push(frame),
      onFatal: (reason) => fatal.push(reason),
    });
    const bootstrap = `${JSON.stringify({
      type: 'bootstrap',
      profile: PROFILE,
      controlKey: 'per-launch-control-secret',
    })}\n`;

    await session.receive(bootstrap);
    expect(starts).toBe(1);
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(PROFILE.setupToken);
    expect(output[0]).toContain('"_sig"');

    await session.receive(
      `${JSON.stringify({
        version: 1,
        type: 'stop',
        requestId: 'stop-1',
        reason: 'user_stop',
        _nonce: 1,
        _sig: 'invalid-signature',
      })}\n`,
    );
    expect(stops).toEqual(['control_auth_failed']);
    expect(fatal).toEqual(['control_auth_failed']);

    const duplicate = createSidecarControlSession({
      runtime: {
        start: async () => {
          starts += 1;
        },
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
        },
        status: () => STOPPED_STATUS,
      },
      write: () => undefined,
      onFatal: (reason) => fatal.push(reason),
    });
    await duplicate.receive(bootstrap);
    await duplicate.receive(bootstrap);
    expect(stops.at(-1)).toBe('control_protocol_error');
  });

  test('gracefully closes the host after an authenticated stop command', async () => {
    const key = 'per-launch-graceful-stop-key';
    const stops: string[] = [];
    const closed: string[] = [];
    const fatal: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => undefined,
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
        },
        status: () => STOPPED_STATUS,
      },
      write: () => undefined,
      onFatal: (reason) => fatal.push(reason),
      onStopped: () => closed.push('host'),
    });
    await session.receive(
      `${JSON.stringify({ type: 'bootstrap', profile: PROFILE, controlKey: key })}\n`,
    );

    await session.receive(
      signedControlFrame(key, 1, {
        version: 1,
        type: 'stop',
        requestId: 'stop-graceful',
        reason: 'user_stop',
      }),
    );

    expect(stops).toEqual(['user_stop']);
    expect(closed).toEqual(['host']);
    expect(fatal).toEqual([]);
  });

  test('treats parent-pipe EOF as an idempotent stop', async () => {
    const stops: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => undefined,
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
        },
        status: () => STOPPED_STATUS,
      },
      write: () => undefined,
      onFatal: () => undefined,
    });

    await session.parentClosed();
    await session.parentClosed();

    expect(stops).toEqual(['parent_eof']);
  });

  test('round-trips a native confirmation over authenticated frames', async () => {
    const key = 'per-launch-confirmation-key';
    let approved: boolean | undefined;
    const output: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => undefined,
        stop: async () => undefined,
        status: () => STOPPED_STATUS,
        confirmPermission: async (_permissionId, confirmation) => {
          approved = await confirmation.confirm({
            tunnelId: PROFILE.tunnelId,
            permissionId: 'permission-confirm',
            capability: 'filesystem',
            scopeDigest: `sha256:${'a'.repeat(64)}`,
            expiresAt: '2026-07-29T12:00:00.000Z',
          });
          return approved;
        },
      },
      write: (frame) => output.push(frame),
      onFatal: () => undefined,
    });
    await session.receive(
      `${JSON.stringify({ type: 'bootstrap', profile: PROFILE, controlKey: key })}\n`,
    );

    await session.receive(
      signedControlFrame(key, 1, {
        version: 1,
        type: 'confirm_permission',
        requestId: 'command-confirm-1',
        permissionId: 'permission-confirm',
      }),
    );
    await Promise.resolve();
    const requestFrame = JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
    expect(requestFrame.type).toBe('confirmation_request');
    expect(JSON.stringify(requestFrame)).not.toContain(PROFILE.setupToken);
    expect(JSON.stringify(requestFrame)).not.toContain('C:/workspace');

    await session.receive(
      signedControlFrame(key, 2, {
        version: 1,
        type: 'confirmation_response',
        requestId: requestFrame.requestId,
        approved: true,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(approved).toBe(true);
    expect(output.some((frame) => frame.includes('"type":"confirmation_result"'))).toBe(true);
  });

  test('fails closed on a duplicate confirmation response', async () => {
    const key = 'per-launch-duplicate-response-key';
    const output: string[] = [];
    const fatal: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => undefined,
        stop: async () => undefined,
        status: () => STOPPED_STATUS,
        confirmPermission: async (_permissionId, confirmation) =>
          confirmation.confirm({
            tunnelId: PROFILE.tunnelId,
            permissionId: 'permission-confirm',
            capability: 'filesystem',
            scopeDigest: `sha256:${'a'.repeat(64)}`,
            expiresAt: null,
          }),
      },
      write: (frame) => output.push(frame),
      onFatal: (reason) => fatal.push(reason),
    });
    await session.receive(
      `${JSON.stringify({ type: 'bootstrap', profile: PROFILE, controlKey: key })}\n`,
    );
    await session.receive(
      signedControlFrame(key, 1, {
        version: 1,
        type: 'confirm_permission',
        requestId: 'command-confirm-duplicate',
        permissionId: 'permission-confirm',
      }),
    );
    await Promise.resolve();
    const request = JSON.parse(output.at(-1) ?? '{}') as Record<string, unknown>;
    expect(request.type).toBe('confirmation_request');
    expect(fatal).toEqual([]);
    const response = {
      version: 1,
      type: 'confirmation_response',
      requestId: request.requestId,
      approved: true,
    };

    await session.receive(signedControlFrame(key, 2, response));
    await Promise.resolve();
    expect(fatal).toEqual([]);
    await session.receive(signedControlFrame(key, 3, response));

    expect(fatal).toEqual(['control_auth_failed']);
  });

  test('deduplicates repeated confirmation command request ids', async () => {
    const key = 'per-launch-command-deduplication-key';
    const output: string[] = [];
    const fatal: string[] = [];
    let prompts = 0;
    const session = createSidecarControlSession({
      runtime: {
        start: async () => undefined,
        stop: async () => undefined,
        status: () => STOPPED_STATUS,
        confirmPermission: async (_permissionId, confirmation) => {
          prompts += 1;
          return confirmation.confirm({
            tunnelId: PROFILE.tunnelId,
            permissionId: 'permission-confirm',
            capability: 'filesystem',
            scopeDigest: `sha256:${'a'.repeat(64)}`,
            expiresAt: null,
          });
        },
      },
      write: (frame) => output.push(frame),
      onFatal: (reason) => fatal.push(reason),
    });
    await session.receive(
      `${JSON.stringify({ type: 'bootstrap', profile: PROFILE, controlKey: key })}\n`,
    );
    const command = {
      version: 1,
      type: 'confirm_permission',
      requestId: 'command-confirm-idempotent',
      permissionId: 'permission-confirm',
    };

    await session.receive(signedControlFrame(key, 1, command));
    await Promise.resolve();
    await session.receive(signedControlFrame(key, 2, command));
    await Promise.resolve();

    const confirmationRequests = output
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame.type === 'confirmation_request');
    expect(prompts).toBe(1);
    expect(confirmationRequests).toHaveLength(1);
    expect(fatal).toEqual([]);

    await session.receive(
      signedControlFrame(key, 3, {
        version: 1,
        type: 'confirmation_response',
        requestId: confirmationRequests[0]?.requestId,
        approved: true,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await session.receive(signedControlFrame(key, 4, command));
    await Promise.resolve();

    const results = output
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .filter((frame) => frame.type === 'confirmation_result');
    expect(prompts).toBe(1);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ requestId: command.requestId, approved: true });
    expect(results[1]).toMatchObject({ requestId: command.requestId, approved: true });
  });

  test('emits a signed error status before a fatal consent shutdown', async () => {
    const key = 'per-launch-fatal-storage-key';
    const output: string[] = [];
    const stops: string[] = [];
    const fatal: string[] = [];
    const session = createSidecarControlSession({
      runtime: {
        start: async () => undefined,
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
        },
        status: () => ({
          ...STOPPED_STATUS,
          state: 'online',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: true,
        }),
      },
      write: (frame) => output.push(frame),
      onFatal: (reason) => fatal.push(reason),
    });
    await session.receive(
      `${JSON.stringify({ type: 'bootstrap', profile: PROFILE, controlKey: key })}\n`,
    );

    await session.fatal('LOCAL_CONSENT_QUARANTINE_FAILED');

    const terminal = JSON.parse(output.at(-1) ?? '{}') as {
      type?: string;
      status?: DesktopRuntimeStatus;
      _sig?: string;
    };
    expect(terminal.type).toBe('status');
    expect(terminal.status).toMatchObject({
      state: 'error',
      online: false,
      ready: false,
      reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
    });
    expect(typeof terminal._sig).toBe('string');
    expect(stops).toEqual(['LOCAL_CONSENT_QUARANTINE_FAILED']);
    expect(fatal).toEqual(['LOCAL_CONSENT_QUARANTINE_FAILED']);
  });

  test('binds fatal consent storage failure to sidecar shutdown and nonzero exit', async () => {
    const key = 'per-launch-process-fatal-key';
    const input = new PassThrough();
    const output: string[] = [];
    const exitCodes: number[] = [];
    const stops: string[] = [];
    let storageFatal: DesktopConsentStoreOptions['onFatalStorageFailure'];
    let status: DesktopRuntimeStatus = STOPPED_STATUS;
    const close = runDesktopAgentSidecar({
      input,
      write: (frame) => output.push(frame),
      setExitCode: (code) => exitCodes.push(code),
      createConsentStore: (options) => {
        storageFatal = options.onFatalStorageFailure;
        return fakeConsentStore().store;
      },
      createRuntime: () => ({
        start: async () => {
          status = {
            ...STOPPED_STATUS,
            state: 'online',
            tunnelId: PROFILE.tunnelId,
            userId: PROFILE.userId,
            online: true,
          };
        },
        stop: async (reason) => {
          stops.push(reason ?? 'unknown');
          status = { ...status, state: 'stopped', online: false, ready: false };
        },
        status: () => status,
      }),
    });
    input.write(`${JSON.stringify({ type: 'bootstrap', profile: PROFILE, controlKey: key })}\n`);
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    storageFatal?.('LOCAL_CONSENT_QUARANTINE_FAILED');
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(exitCodes).toEqual([1]);
    expect(stops).toContain('LOCAL_CONSENT_QUARANTINE_FAILED');
    const terminal = JSON.parse(output.at(-1) ?? '{}') as {
      type?: string;
      status?: DesktopRuntimeStatus;
      _sig?: string;
    };
    expect(terminal.type).toBe('status');
    expect(terminal.status).toMatchObject({
      state: 'error',
      reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
    });
    expect(typeof terminal._sig).toBe('string');
    await close();
  });

  test('reports a storage fatal that occurs while parent EOF is stopping the runtime', async () => {
    const input = new PassThrough();
    const exitCodes: number[] = [];
    const stops: string[] = [];
    let storageFatal: DesktopConsentStoreOptions['onFatalStorageFailure'];
    const close = runDesktopAgentSidecar({
      input,
      write: () => undefined,
      setExitCode: (code) => exitCodes.push(code),
      createConsentStore: (options) => {
        storageFatal = options.onFatalStorageFailure;
        return fakeConsentStore().store;
      },
      createRuntime: () => ({
        start: async () => undefined,
        stop: async (reason) => {
          const stopReason = reason ?? 'unknown';
          stops.push(stopReason);
          if (stopReason === 'parent_eof') {
            storageFatal?.('LOCAL_CONSENT_QUARANTINE_FAILED');
          }
        },
        status: () => STOPPED_STATUS,
      }),
    });
    input.end();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stops).toEqual(['parent_eof']);
    expect(exitCodes).toEqual([1]);
    await close();
  });
});
