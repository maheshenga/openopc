const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const {
  CONTROL_FRAME_MAX_BYTES,
  REMOTE_ONLY_STATUS,
  createDesktopTunnelController,
  createTunnelRuntimeSupervisor,
  resolveTunnelSidecarPath,
  signMessage,
} = require('./tunnel-runtime-supervisor');

const PROFILE = {
  apiOrigin: 'https://app.example.test',
  tunnelId: 'tunnel-1',
  setupToken: 'setup-token-1234567890',
  userId: 'user-1',
  deviceId: 'device-1',
  accountId: 'account-1',
};

function fakeChild() {
  const child = new EventEmitter();
  const stdinWrites = [];
  child.stdin = {
    destroyed: false,
    writable: true,
    write(value) {
      stdinWrites.push(String(value));
      return true;
    },
    end() {
      this.writable = false;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return { child, stdinWrites };
}

function signedOutputFrame(controlKey, nonce, payload) {
  return `${JSON.stringify({
    ...payload,
    _sig: signMessage(controlKey, JSON.stringify(payload), nonce),
    _nonce: nonce,
  })}\n`;
}

describe('Tunnel runtime supervisor', () => {
  test('spawns one sidecar and sends credentials only in the stdin bootstrap frame', async () => {
    const spawned = [];
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      execPath: 'C:/OpenOPC/OpenOPC.exe',
      env: { PATH: 'C:/Windows/System32' },
      randomBytes: () => Buffer.alloc(32, 7),
      spawn: (command, args, options) => {
        spawned.push({ command, args, options });
        return harness.child;
      },
    });

    await supervisor.start(PROFILE);
    await supervisor.start(PROFILE);

    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0], {
      command: 'C:/OpenOPC/OpenOPC.exe',
      args: ['C:/OpenOPC/resources/openopc-agent-sidecar.cjs'],
      options: {
        env: { PATH: 'C:/Windows/System32', ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    });
    assert.equal(JSON.stringify(spawned).includes(PROFILE.setupToken), false);
    assert.equal(harness.stdinWrites.length, 1);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    assert.equal(bootstrap.type, 'bootstrap');
    assert.deepEqual(bootstrap.profile, PROFILE);
    assert.equal(typeof bootstrap.controlKey, 'string');
    assert.equal(bootstrap.controlKey.length >= 32, true);
  });

  test('durably latches a fatal consent quarantine across supervisor instances', async () => {
    const latch = {
      reason: null,
      setFatalLatch(reason) {
        this.reason = reason;
      },
      getFatalLatch() {
        return this.reason ? { reason: this.reason, latchedAt: '2026-07-29T12:00:00.000Z' } : null;
      },
      clear() {
        this.reason = null;
      },
    };
    const firstHarness = fakeChild();
    const first = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      env: {},
      profileStore: latch,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      randomBytes: () => Buffer.alloc(32, 8),
      spawn: () => firstHarness.child,
    });
    await first.start(PROFILE);
    const bootstrap = JSON.parse(firstHarness.stdinWrites[0]);
    firstHarness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-1',
        status: {
          state: 'error',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
          pendingPairing: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(latch.reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(first.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(firstHarness.child.killed, true);

    const second = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: latch,
      spawn: () => {
        throw new Error('must not spawn while latched');
      },
    });
    await assert.rejects(second.start(PROFILE), { code: 'TUNNEL_RUNTIME_FATAL_LATCHED' });

    await second.forgetCredentials();
    assert.equal(latch.reason, null);
    assert.equal(second.status().state, 'remote_only');
  });

  test('accepts only authenticated status frames and completes native confirmation once', async () => {
    const harness = fakeChild();
    const seenStatuses = [];
    const nativeRequests = [];
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
      confirmNative: async (request) => {
        nativeRequests.push(request);
        return true;
      },
    });
    supervisor.onStatus((value) => seenStatuses.push(value));
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-online',
        status: {
          state: 'online',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: true,
          ready: false,
          reason: null,
          pendingPairing: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(supervisor.status().state, 'online');

    const confirmation = supervisor.confirmPermission('permission-1');
    const command = JSON.parse(harness.stdinWrites.at(-1));
    assert.equal(command.type, 'confirm_permission');
    assert.equal(JSON.stringify(command).includes(PROFILE.setupToken), false);

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 2, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'native-request-1',
        request: {
          tunnelId: PROFILE.tunnelId,
          permissionId: 'permission-1',
          capability: 'filesystem',
          scopeDigest: `sha256:${'a'.repeat(64)}`,
          expiresAt: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const nativeResponse = JSON.parse(harness.stdinWrites.at(-1));
    assert.equal(nativeResponse.type, 'confirmation_response');
    assert.equal(nativeResponse.requestId, 'native-request-1');
    assert.equal(nativeResponse.approved, true);
    assert.deepEqual(nativeRequests, [
      {
        tunnelId: PROFILE.tunnelId,
        permissionId: 'permission-1',
        capability: 'filesystem',
        scopeDigest: `sha256:${'a'.repeat(64)}`,
        expiresAt: null,
      },
    ]);

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 3, {
        version: 1,
        type: 'confirmation_result',
        requestId: command.requestId,
        permissionId: 'permission-1',
        approved: true,
      }),
    );
    assert.equal(await confirmation, true);
    assert.equal(seenStatuses.some((value) => value.state === 'online'), true);

    harness.child.stdout.write('{"version":1,"type":"status","requestId":"bad","status":{}}\n');
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(harness.child.killed, true);
    assert.equal(supervisor.status().state, 'error');
  });

  test('purges credentials and suppresses reconnect after a 4001 reauth status', async () => {
    const harness = fakeChild();
    let cleared = 0;
    const profileStore = {
      clear() {
        cleared += 1;
      },
    };
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-reauth',
        status: {
          state: 'reauth_required',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: 'auth_failed',
          pendingPairing: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cleared, 1);
    assert.equal(harness.child.killed, true);
    assert.equal(supervisor.status().state, 'reauth_required');
  });

  test('handles only the first priority security transition per child record', async () => {
    const harness = fakeChild();
    let cleared = 0;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        clear() {
          cleared += 1;
        },
      },
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const reauthStatus = {
      state: 'reauth_required',
      tunnelId: PROFILE.tunnelId,
      userId: PROFILE.userId,
      online: false,
      ready: false,
      reason: 'auth_failed',
      pendingPairing: null,
    };

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-reauth-first',
        status: reauthStatus,
      }) +
        signedOutputFrame(bootstrap.controlKey, 2, {
          version: 1,
          type: 'status',
          requestId: 'status-reauth-duplicate',
          status: reauthStatus,
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(cleared, 1);
    assert.equal(supervisor.status().state, 'reauth_required');
  });

  test('latches only the first repeated fatal status per child record', async () => {
    const harness = fakeChild();
    let latchCount = 0;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        setFatalLatch() {
          latchCount += 1;
        },
        getFatalLatch: () => null,
      },
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const fatalStatus = {
      state: 'error',
      tunnelId: PROFILE.tunnelId,
      userId: PROFILE.userId,
      online: false,
      ready: false,
      reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
      pendingPairing: null,
    };

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-fatal-first',
        status: fatalStatus,
      }) +
        signedOutputFrame(bootstrap.controlKey, 2, {
          version: 1,
          type: 'status',
          requestId: 'status-fatal-duplicate',
          status: fatalStatus,
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(latchCount, 1);
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
  });

  test('durably quarantines credentials when reauthentication cannot delete them', async () => {
    const harness = fakeChild();
    let latchReason = null;
    const profileStore = {
      clear() {
        throw new Error('disk unavailable');
      },
      setFatalLatch(reason) {
        latchReason = reason;
      },
      getFatalLatch() {
        return latchReason ? { reason: latchReason, latchedAt: '2026-07-29T12:00:00.000Z' } : null;
      },
    };
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-reauth-clear-failed',
        status: {
          state: 'reauth_required',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: 'auth_failed',
          pendingPairing: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(latchReason, 'TUNNEL_CREDENTIAL_CLEAR_FAILED');
    assert.equal(supervisor.status().reason, 'TUNNEL_CREDENTIAL_CLEAR_FAILED');
    assert.equal(harness.child.killed, true);
  });

  test('stops an existing sidecar before entering remote-only on secure-storage failure', async () => {
    const harness = fakeChild();
    let secure = true;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: { secureStorageAvailable: () => secure },
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });

    await supervisor.start(PROFILE);
    secure = false;
    await assert.rejects(supervisor.start(PROFILE), {
      code: 'TUNNEL_RUNTIME_SECURE_STORAGE_UNAVAILABLE',
    });
    assert.equal(harness.child.killed, true);
    assert.equal(supervisor.status().state, 'remote_only');
  });

  test('clears credentials when a reauth frame races with a user stop', async () => {
    const harness = fakeChild();
    let cleared = 0;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        clear() {
          cleared += 1;
        },
      },
      stopTimeoutMs: 50,
      spawn: () => harness.child,
    });

    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const stopping = supervisor.stop('user_stop');
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-reauth-race',
        status: {
          state: 'reauth_required',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: 'auth_failed',
          pendingPairing: null,
        },
      }),
    );
    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cleared, 1);
    assert.equal(supervisor.status().state, 'reauth_required');
  });

  test('honors an authenticated reauth frame even when the child exits immediately', async () => {
    const harness = fakeChild();
    let cleared = 0;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        clear() {
          cleared += 1;
        },
      },
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });

    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const stopping = supervisor.stop('user_stop');
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-reauth-before-exit',
        status: {
          state: 'reauth_required',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: '4001',
          pendingPairing: null,
        },
      }),
    );
    harness.child.emit('exit', 0, null);

    await stopping;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(cleared, 1);
    assert.equal(supervisor.status().state, 'reauth_required');
    assert.equal(supervisor.status().reason, '4001');
  });

  test('bounds in-flight permission commands', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      maxPendingCommands: 1,
      confirmationTimeoutMs: 20,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const first = supervisor.confirmPermission('permission-1');

    await assert.rejects(supervisor.confirmPermission('permission-2'), {
      code: 'TUNNEL_RUNTIME_CONFIRMATION_BUSY',
    });
    assert.equal(await first, false);
  });

  test('bounds and deduplicates native confirmation request ids without killing the sidecar', async () => {
    const harness = fakeChild();
    const nativeRequests = [];
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      maxSeenConfirmationRequests: 2,
      spawn: () => harness.child,
      confirmNative: async (request) => {
        nativeRequests.push(request);
        return true;
      },
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);

    for (const [nonce, requestId] of [
      [1, 'native-1'],
      [2, 'native-2'],
      [3, 'native-3'],
    ]) {
      harness.child.stdout.write(
        signedOutputFrame(bootstrap.controlKey, nonce, {
          version: 1,
          type: 'confirmation_request',
          requestId,
          request: {
            tunnelId: PROFILE.tunnelId,
            permissionId: 'permission-1',
            capability: 'filesystem',
            scopeDigest: `sha256:${'a'.repeat(64)}`,
            expiresAt: null,
          },
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.notEqual(supervisor.status().state, 'error');

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 4, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'native-3',
        request: {
          tunnelId: PROFILE.tunnelId,
          permissionId: 'permission-1',
          capability: 'filesystem',
          scopeDigest: `sha256:${'a'.repeat(64)}`,
          expiresAt: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(nativeRequests.length, 3);
    assert.notEqual(supervisor.status().state, 'error');
  });

  test('bounds queued native confirmations without pausing authenticated stdout', async () => {
    const harness = fakeChild();
    const nativeRequests = [];
    let resolveFirst;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      maxQueuedOutputFrames: 2,
      spawn: () => harness.child,
      confirmNative: async (request) => {
        nativeRequests.push(request);
        if (nativeRequests.length > 1) return false;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const request = {
      tunnelId: PROFILE.tunnelId,
      permissionId: 'permission-1',
      capability: 'filesystem',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      expiresAt: null,
    };

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'native-backpressure-1',
        request,
      }) +
        signedOutputFrame(bootstrap.controlKey, 2, {
          version: 1,
          type: 'confirmation_request',
          requestId: 'native-backpressure-2',
          request,
        }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    try {
      assert.equal(harness.child.stdout.isPaused(), false);
      assert.equal(nativeRequests.length, 1);
    } finally {
      resolveFirst?.(true);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(nativeRequests.length, 2);
    assert.notEqual(supervisor.status().state, 'error');
  });

  test('fails closed excess coalesced confirmations while keeping stdout readable', async () => {
    const harness = fakeChild();
    const nativeRequests = [];
    let resolveFirst;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      maxQueuedOutputFrames: 2,
      spawn: () => harness.child,
      confirmNative: async (request) => {
        nativeRequests.push(request);
        if (nativeRequests.length > 1) return false;
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      },
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const request = {
      tunnelId: PROFILE.tunnelId,
      permissionId: 'permission-1',
      capability: 'filesystem',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      expiresAt: null,
    };

    harness.child.stdout.write(
      [1, 2, 3]
        .map((nonce) =>
          signedOutputFrame(bootstrap.controlKey, nonce, {
            version: 1,
            type: 'confirmation_request',
            requestId: `native-coalesced-${nonce}`,
            request,
          }),
        )
        .join(''),
    );
    await new Promise((resolve) => setImmediate(resolve));

    try {
      assert.equal(harness.child.stdout.isPaused(), false);
      assert.equal(nativeRequests.length, 1);
      const overloadedResponse = JSON.parse(harness.stdinWrites.at(-1));
      assert.equal(overloadedResponse.type, 'confirmation_response');
      assert.equal(overloadedResponse.requestId, 'native-coalesced-3');
      assert.equal(overloadedResponse.approved, false);
      assert.equal(harness.child.killed, false);
      assert.notEqual(supervisor.status().state, 'error');
    } finally {
      resolveFirst?.(true);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(nativeRequests.length, 2);
    assert.equal(harness.child.killed, false);
    assert.notEqual(supervisor.status().state, 'error');
  });

  test('finds a fatal status at the end of a large coalesced stdout chunk', async () => {
    const harness = fakeChild();
    let latched = null;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      maxQueuedOutputFrames: 1,
      confirmationTimeoutMs: 1_000,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      profileStore: {
        setFatalLatch(reason) {
          latched = reason;
        },
        getFatalLatch: () => null,
      },
      spawn: () => harness.child,
      confirmNative: () => new Promise(() => undefined),
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const request = {
      tunnelId: PROFILE.tunnelId,
      permissionId: 'permission-1',
      capability: 'filesystem',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      expiresAt: null,
    };
    let nonce = 1;
    let chunk = '';
    while (Buffer.byteLength(chunk, 'utf8') <= CONTROL_FRAME_MAX_BYTES * 2) {
      chunk += signedOutputFrame(bootstrap.controlKey, nonce, {
        version: 1,
        type: 'confirmation_request',
        requestId: `large-chunk-${nonce}`,
        request,
      });
      nonce += 1;
    }
    chunk += signedOutputFrame(bootstrap.controlKey, nonce, {
      version: 1,
      type: 'status',
      requestId: 'large-chunk-fatal',
      status: {
        state: 'error',
        tunnelId: PROFILE.tunnelId,
        userId: PROFILE.userId,
        online: false,
        ready: false,
        reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
        pendingPairing: null,
      },
    });

    harness.child.stdout.write(chunk);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(latched, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
  });

  test('fails closed when an incomplete stdout frame reaches the frame limit', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);

    harness.child.stdout.write('x'.repeat(CONTROL_FRAME_MAX_BYTES));
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(supervisor.status().reason, 'control_frame_overflow');
    assert.equal(harness.child.killed, true);
  });

  test('fails closed when the active sidecar control output ends cleanly', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);

    harness.child.stdout.end();
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(supervisor.status().state, 'error');
    assert.equal(supervisor.status().reason, 'control_pipe_error');
    assert.equal(harness.child.killed, true);
  });

  test('caches a fail-closed native confirmation after the callback rejects', async () => {
    const harness = fakeChild();
    let nativeCalls = 0;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      spawn: () => harness.child,
      confirmNative: async () => {
        nativeCalls += 1;
        throw new Error('native confirmation unavailable');
      },
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const request = {
      tunnelId: PROFILE.tunnelId,
      permissionId: 'permission-1',
      capability: 'filesystem',
      scopeDigest: `sha256:${'a'.repeat(64)}`,
      expiresAt: null,
    };

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'native-rejected',
        request,
      }) +
        signedOutputFrame(bootstrap.controlKey, 2, {
          version: 1,
          type: 'confirmation_request',
          requestId: 'native-rejected',
          request,
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(nativeCalls, 1);
    assert.equal(harness.stdinWrites.length, 3);
    assert.equal(JSON.parse(harness.stdinWrites[1]).approved, false);
    assert.equal(JSON.parse(harness.stdinWrites[2]).approved, false);
    assert.notEqual(supervisor.status().state, 'error');
  });

  test('times out a hung native confirmation so a later fatal status is still processed', async () => {
    const harness = fakeChild();
    let latched = null;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        setFatalLatch(reason) {
          latched = reason;
        },
        getFatalLatch: () => null,
      },
      confirmationTimeoutMs: 5,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
      confirmNative: () => new Promise(() => undefined),
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'native-hung',
        request: {
          tunnelId: PROFILE.tunnelId,
          permissionId: 'permission-1',
          capability: 'filesystem',
          scopeDigest: `sha256:${'a'.repeat(64)}`,
          expiresAt: null,
        },
      }) +
        signedOutputFrame(bootstrap.controlKey, 2, {
          version: 1,
          type: 'status',
          requestId: 'status-fatal-after-hung-confirmation',
          status: {
            state: 'error',
            tunnelId: PROFILE.tunnelId,
            userId: PROFILE.userId,
            online: false,
            ready: false,
            reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
            pendingPairing: null,
          },
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(latched, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(harness.child.killed, true);
  });

  test('prioritizes a fatal status over a hung confirmation before child exit', async () => {
    const harness = fakeChild();
    let latched = null;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        setFatalLatch(reason) {
          latched = reason;
        },
        getFatalLatch: () => null,
      },
      confirmationTimeoutMs: 1_000,
      maxQueuedOutputFrames: 1,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
      confirmNative: () => new Promise(() => undefined),
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'native-hung-before-exit',
        request: {
          tunnelId: PROFILE.tunnelId,
          permissionId: 'permission-1',
          capability: 'filesystem',
          scopeDigest: `sha256:${'a'.repeat(64)}`,
          expiresAt: null,
        },
      }) +
        signedOutputFrame(bootstrap.controlKey, 2, {
          version: 1,
          type: 'status',
          requestId: 'status-fatal-before-exit',
          status: {
            state: 'error',
            tunnelId: PROFILE.tunnelId,
            userId: PROFILE.userId,
            online: false,
            ready: false,
            reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
            pendingPairing: null,
          },
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(latched, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    harness.child.emit('exit', 1, null);
    assert.equal(harness.child.stdout.isPaused(), false);
  });

  test('processes a fatal status from a later stdout chunk while normal output is backpressured', async () => {
    const harness = fakeChild();
    let latched = null;
    let resolveConfirmation;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        setFatalLatch(reason) {
          latched = reason;
        },
        getFatalLatch: () => null,
      },
      confirmationTimeoutMs: 1_000,
      maxQueuedOutputFrames: 1,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
      confirmNative: () =>
        new Promise((resolve) => {
          resolveConfirmation = resolve;
        }),
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'confirmation_request',
        requestId: 'later-chunk-hung',
        request: {
          tunnelId: PROFILE.tunnelId,
          permissionId: 'permission-1',
          capability: 'filesystem',
          scopeDigest: `sha256:${'a'.repeat(64)}`,
          expiresAt: null,
        },
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 2, {
        version: 1,
        type: 'status',
        requestId: 'later-chunk-fatal',
        status: {
          state: 'error',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
          pendingPairing: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    try {
      assert.equal(latched, 'LOCAL_CONSENT_QUARANTINE_FAILED');
      assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    } finally {
      resolveConfirmation?.(false);
    }
  });

  test('stops a replacement sidecar when an old stdout drain delivers a fatal status', async () => {
    const firstHarness = fakeChild();
    const secondHarness = fakeChild();
    const harnesses = [firstHarness, secondHarness];
    let latched = null;
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        setFatalLatch(reason) {
          latched = reason;
        },
        getFatalLatch: () => null,
      },
      stopTimeoutMs: 0,
      forceKillGraceMs: 0,
      spawn: () => harnesses.shift().child,
    });
    await supervisor.start(PROFILE);
    const firstBootstrap = JSON.parse(firstHarness.stdinWrites[0]);
    firstHarness.child.emit('exit', 1, null);
    await supervisor.start(PROFILE);

    firstHarness.child.stdout.write(
      signedOutputFrame(firstBootstrap.controlKey, 1, {
        version: 1,
        type: 'status',
        requestId: 'status-fatal-from-draining-generation',
        status: {
          state: 'error',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: false,
          ready: false,
          reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
          pendingPairing: null,
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(latched, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(secondHarness.child.killed, true);
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
  });

  test('ignores a matching permission result that arrives after its timeout', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      confirmationTimeoutMs: 5,
      stopTimeoutMs: 0,
      forceKillGraceMs: 0,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const confirmation = supervisor.confirmPermission('permission-late');
    const command = JSON.parse(harness.stdinWrites[1]);

    assert.equal(await confirmation, false);
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, {
        version: 1,
        type: 'confirmation_result',
        requestId: command.requestId,
        permissionId: 'permission-late',
        approved: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.notEqual(supervisor.status().reason, 'control_replay_detected');
    assert.equal(harness.child.killed, false);
  });

  test('does not let a late frame in the same stdout chunk resurrect a fatal runtime', async () => {
    const harness = fakeChild();
    const latch = {
      setFatalLatch: () => undefined,
      getFatalLatch: () => null,
      clear: () => undefined,
    };
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: latch,
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const fatal = {
      version: 1,
      type: 'status',
      requestId: 'status-fatal',
      status: {
        state: 'error',
        tunnelId: PROFILE.tunnelId,
        userId: PROFILE.userId,
        online: false,
        ready: false,
        reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
        pendingPairing: null,
      },
    };
    const lateOnline = {
      version: 1,
      type: 'status',
      requestId: 'status-late-online',
      status: {
        state: 'online',
        tunnelId: PROFILE.tunnelId,
        userId: PROFILE.userId,
        online: true,
        ready: false,
        reason: null,
        pendingPairing: null,
      },
    };
    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, fatal) +
        signedOutputFrame(bootstrap.controlKey, 2, lateOnline),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(supervisor.status().state, 'error');
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(supervisor.status().online, false);
  });

  test('does not let an earlier normal status resume after a later fatal status', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      profileStore: {
        setFatalLatch: () => undefined,
        getFatalLatch: () => null,
        clear: () => undefined,
      },
      stopTimeoutMs: 5,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    const online = {
      version: 1,
      type: 'status',
      requestId: 'status-online-before-fatal',
      status: {
        state: 'online',
        tunnelId: PROFILE.tunnelId,
        userId: PROFILE.userId,
        online: true,
        ready: false,
        reason: null,
        pendingPairing: null,
      },
    };
    const fatal = {
      version: 1,
      type: 'status',
      requestId: 'status-fatal-after-online',
      status: {
        state: 'error',
        tunnelId: PROFILE.tunnelId,
        userId: PROFILE.userId,
        online: false,
        ready: false,
        reason: 'LOCAL_CONSENT_QUARANTINE_FAILED',
        pendingPairing: null,
      },
    };

    harness.child.stdout.write(
      signedOutputFrame(bootstrap.controlKey, 1, online) +
        signedOutputFrame(bootstrap.controlKey, 2, fatal),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(supervisor.status().state, 'error');
    assert.equal(supervisor.status().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(supervisor.status().online, false);
  });

  test('drains a normal stop once and redacts sidecar stderr', async () => {
    const harness = fakeChild();
    const logs = [];
    const originalWrite = harness.child.stdin.write;
    harness.child.stdin.write = (value) => {
      const ok = originalWrite.call(harness.child.stdin, value);
      try {
        if (JSON.parse(String(value)).type === 'stop') {
          setImmediate(() => harness.child.emit('exit', 0, null));
        }
      } catch {
        // Bootstrap is not a stop command.
      }
      return ok;
    };
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      stopTimeoutMs: 50,
      logger: (line) => logs.push(line),
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);
    const bootstrap = JSON.parse(harness.stdinWrites[0]);
    harness.child.stderr.write(`sidecar setupToken=${PROFILE.setupToken} key=${bootstrap.controlKey}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(logs.length, 1);
    assert.equal(logs[0].includes(PROFILE.setupToken), false);
    assert.equal(logs[0].includes(bootstrap.controlKey), false);

    await Promise.all([supervisor.stop('user_stop'), supervisor.stop('user_stop')]);
    assert.equal(supervisor.status().state, 'stopped');
    assert.equal(harness.child.killed, false);
  });

  test('keeps a normal stop status when stdout errors during shutdown', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      stopTimeoutMs: 50,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);

    const stopping = supervisor.stop('user_stop');
    harness.child.stdout.emit('error', new Error('stdout closed during shutdown'));
    harness.child.emit('exit', 0, null);
    await stopping;

    assert.equal(supervisor.status().state, 'stopped');
    assert.equal(supervisor.status().reason, 'user_stop');
  });

  test('keeps a normal stop status when the child errors during shutdown', async () => {
    const harness = fakeChild();
    const supervisor = createTunnelRuntimeSupervisor({
      sidecarPath: 'C:/OpenOPC/resources/openopc-agent-sidecar.cjs',
      stopTimeoutMs: 50,
      forceKillGraceMs: 1,
      spawn: () => harness.child,
    });
    await supervisor.start(PROFILE);

    const stopping = supervisor.stop('user_stop');
    harness.child.emit('error', new Error('child closed during shutdown'));
    harness.child.emit('exit', 0, null);
    await stopping;

    assert.equal(supervisor.status().state, 'stopped');
    assert.equal(supervisor.status().reason, 'user_stop');
  });

  test('composes pairing, encrypted profile storage, and runtime start without exposing credentials', async () => {
    const saved = [];
    const started = [];
    const profileStore = {
      secureStorageAvailable: () => true,
      save: (profile) => saved.push(profile),
      load: () => null,
      clear: () => undefined,
    };
    let runtimeStatus = {
      state: 'remote_only',
      tunnelId: null,
      userId: null,
      online: false,
      ready: false,
      reason: null,
      pendingPairing: null,
    };
    const supervisor = {
      status: () => runtimeStatus,
      onStatus: () => () => undefined,
      start: async (profile) => {
        started.push(profile);
        runtimeStatus = {
          state: 'starting',
          tunnelId: profile.tunnelId,
          userId: profile.userId,
          online: false,
          ready: false,
          reason: null,
          pendingPairing: null,
        };
      },
      stop: async () => ({ graceful: true, forced: false }),
      forgetCredentials: async () => undefined,
    };
    const controller = createDesktopTunnelController({
      profileStore,
      supervisor,
      createPairing: (pairingOptions) => ({
        begin: async () => ({
          code: 'ABC123',
          verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
          expiresAt: '2026-07-29T12:05:00.000Z',
        }),
        waitForApproval: async () => ({
          status: 'approved',
          accountId: pairingOptions.accountId,
          tunnelId: 'tunnel-1',
          setupToken: 'setup-token-1234567890',
        }),
        cancel: () => undefined,
      }),
    });

    const pending = await controller.beginPairing({
      origin: 'https://app.example.test/projects',
      userId: 'user-1',
      deviceId: 'device-1',
      accountId: 'account-1',
    });
    assert.deepEqual(pending, {
      code: 'ABC123',
      verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
      expiresAt: '2026-07-29T12:05:00.000Z',
    });
    assert.equal(JSON.stringify(controller.status()).includes('setup-token'), false);
    await controller.waitForPairing();

    assert.equal(saved.length, 1);
    assert.deepEqual(started, saved);
    assert.deepEqual(saved[0], PROFILE);
    assert.equal(controller.status().state, 'starting');
  });

  test('does not let a superseded start failure clear newer pairing credentials', async () => {
    const saved = [];
    let currentProfile = null;
    let clearCount = 0;
    const profileStore = {
      secureStorageAvailable: () => true,
      save(profile) {
        currentProfile = profile;
        saved.push(profile.tunnelId);
      },
      load: () => currentProfile,
      clear() {
        clearCount += 1;
        currentProfile = null;
      },
    };
    let runtimeStatus = REMOTE_ONLY_STATUS;
    let rejectFirstStart;
    let firstStartCalled;
    const firstStartReady = new Promise((resolve) => {
      firstStartCalled = resolve;
    });
    let startCount = 0;
    const supervisor = {
      status: () => runtimeStatus,
      onStatus: () => () => undefined,
      start: async (profile) => {
        startCount += 1;
        if (startCount === 1) {
          firstStartCalled();
          return new Promise((_resolve, reject) => {
            rejectFirstStart = reject;
          });
        }
        runtimeStatus = {
          state: 'starting',
          tunnelId: profile.tunnelId,
          userId: profile.userId,
          online: false,
          ready: false,
          reason: null,
          pendingPairing: null,
        };
      },
      stop: async () => ({ graceful: true, forced: false }),
      forgetCredentials: async () => undefined,
    };
    let pairingCount = 0;
    const controller = createDesktopTunnelController({
      profileStore,
      supervisor,
      createPairing: (pairingOptions) => {
        pairingCount += 1;
        const pairingNumber = pairingCount;
        return {
          begin: async () => ({
            code: pairingNumber === 1 ? 'ABC123' : 'XYZ789',
            verificationUrl: `https://app.example.test/tunnel/authorize/${pairingNumber}`,
            expiresAt: '2026-07-29T12:05:00.000Z',
          }),
          waitForApproval: async () => ({
            status: 'approved',
            accountId: pairingOptions.accountId,
            tunnelId: `tunnel-${pairingNumber}`,
            setupToken: `setup-token-${pairingNumber}-1234567890`,
          }),
          cancel: () => undefined,
        };
      },
    });
    const context = {
      origin: PROFILE.apiOrigin,
      userId: PROFILE.userId,
      deviceId: PROFILE.deviceId,
      accountId: PROFILE.accountId,
    };

    await controller.beginPairing(context);
    await firstStartReady;
    const secondBeginning = controller.beginPairing(context);
    await new Promise((resolve) => setImmediate(resolve));
    rejectFirstStart(new Error('First runtime start failed'));
    await secondBeginning;
    await controller.waitForPairing();

    assert.deepEqual(saved, ['tunnel-1', 'tunnel-2']);
    assert.equal(clearCount, 1);
    assert.equal(currentProfile.tunnelId, 'tunnel-2');
    assert.equal(controller.status().tunnelId, 'tunnel-2');
  });

  test('does not clear credentials when the current profile cannot be confirmed', async () => {
    for (const loadMode of ['missing', 'error']) {
      let savedProfile = null;
      let clearCount = 0;
      const profileStore = {
        secureStorageAvailable: () => true,
        save(profile) {
          savedProfile = profile;
        },
        load() {
          if (loadMode === 'error') throw new Error('profile store unavailable');
          return null;
        },
        clear() {
          clearCount += 1;
          savedProfile = null;
        },
      };
      const supervisor = {
        status: () => REMOTE_ONLY_STATUS,
        onStatus: () => () => undefined,
        start: async () => {
          throw new Error('Runtime start failed');
        },
        stop: async () => ({ graceful: true, forced: false }),
        forgetCredentials: async () => undefined,
      };
      const controller = createDesktopTunnelController({
        profileStore,
        supervisor,
        createPairing: (pairingOptions) => ({
          begin: async () => ({
            code: 'ABC123',
            verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
            expiresAt: '2026-07-29T12:05:00.000Z',
          }),
          waitForApproval: async () => ({
            status: 'approved',
            accountId: pairingOptions.accountId,
            tunnelId: 'tunnel-1',
            setupToken: 'setup-token-1234567890',
          }),
          cancel: () => undefined,
        }),
      });

      await controller.beginPairing({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      });
      await controller.waitForPairing();

      assert.equal(clearCount, 0, loadMode);
      assert.deepEqual(savedProfile, PROFILE, loadMode);
    }
  });

  test('rejects an approved pairing for a different account before saving credentials', async () => {
    let saved = 0;
    const profileStore = {
      secureStorageAvailable: () => true,
      save() {
        saved += 1;
      },
      load: () => null,
      clear: () => undefined,
    };
    const supervisor = {
      status: () => ({
        state: 'remote_only',
        tunnelId: null,
        userId: null,
        online: false,
        ready: false,
        reason: null,
        pendingPairing: null,
      }),
      onStatus: () => () => undefined,
      start: async () => undefined,
      stop: async () => ({ graceful: true, forced: false }),
      forgetCredentials: async () => undefined,
    };
    const controller = createDesktopTunnelController({
      profileStore,
      supervisor,
      createPairing: () => ({
        begin: async () => ({
          code: 'ABC123',
          verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
          expiresAt: '2026-07-29T12:05:00.000Z',
        }),
        waitForApproval: async () => ({
          status: 'approved',
          accountId: 'account-B',
          tunnelId: 'tunnel-1',
          setupToken: 'setup-token-1234567890',
        }),
        cancel: () => undefined,
      }),
    });

    await controller.beginPairing({
      origin: PROFILE.apiOrigin,
      userId: PROFILE.userId,
      deviceId: PROFILE.deviceId,
      accountId: 'account-A',
    });
    await controller.waitForPairing();

    assert.equal(saved, 0);
    assert.equal(controller.status().state, 'error');
    assert.equal(controller.status().reason, 'TUNNEL_PAIRING_ACCOUNT_MISMATCH');
  });

  test('stops the active runtime when secure storage or profile loading fails', async () => {
    for (const mode of ['unavailable', 'load_error']) {
      const stops = [];
      const profileStore = {
        secureStorageAvailable: () => mode !== 'unavailable',
        load() {
          throw new Error('profile read failed');
        },
        clear: () => undefined,
      };
      const supervisor = {
        status: () => ({
          state: 'online',
          tunnelId: PROFILE.tunnelId,
          userId: PROFILE.userId,
          online: true,
          ready: false,
          reason: null,
          pendingPairing: null,
        }),
        onStatus: () => () => undefined,
        start: async () => undefined,
        stop: async (reason) => {
          stops.push(reason);
          return { graceful: true, forced: false };
        },
        forgetCredentials: async () => undefined,
      };
      const controller = createDesktopTunnelController({ profileStore, supervisor });

      assert.equal(
        await controller.startIfProfileMatches({
          origin: PROFILE.apiOrigin,
          userId: PROFILE.userId,
          deviceId: PROFILE.deviceId,
          accountId: PROFILE.accountId,
        }),
        false,
      );
      assert.deepEqual(stops, [
        mode === 'unavailable' ? 'secure_storage_unavailable' : 'profile_load_failed',
      ]);
      assert.equal(controller.status().state, 'remote_only');
    }
  });

  test('resolves sidecar paths outside asar for development and packaged builds', () => {
    assert.equal(
      resolveTunnelSidecarPath({ isPackaged: true, resourcesPath: 'C:/OpenOPC/resources' }),
      path.join('C:/OpenOPC/resources', 'openopc-agent-sidecar.cjs'),
    );
    assert.equal(
      resolveTunnelSidecarPath({ repositoryRoot: 'E:/repo' }),
      path.join(
        'E:/repo',
        'packages',
        'openopc-desktop-agent',
        'dist',
        'openopc-agent-sidecar.cjs',
      ),
    );
  });
});
