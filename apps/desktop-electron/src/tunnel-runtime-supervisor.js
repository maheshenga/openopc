const { spawn: nodeSpawn } = require('node:child_process');
const { createHmac, randomBytes: nodeRandomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const path = require('node:path');

const {
  normalizeOrigin,
  validateTunnelProfile,
} = require('./tunnel-profile-store');
const { createTunnelPairing } = require('./tunnel-pairing');

const CONTROL_PROTOCOL_VERSION = 1;
const CONTROL_FRAME_MAX_BYTES = 64 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_KILL_GRACE_MS = 1_000;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING_COMMANDS = 32;
const DEFAULT_MAX_SEEN_CONFIRMATION_REQUESTS = 1_024;
const DEFAULT_MAX_EXPIRED_COMMANDS = 1_024;
const DEFAULT_MAX_QUEUED_OUTPUT_FRAMES = 128;
const FATAL_CONSENT_REASON = 'LOCAL_CONSENT_QUARANTINE_FAILED';
const CREDENTIAL_CLEAR_FAILED_REASON = 'TUNNEL_CREDENTIAL_CLEAR_FAILED';
const FATAL_LATCH_PERSIST_FAILED_REASON = 'TUNNEL_FATAL_LATCH_PERSIST_FAILED';
const RUNTIME_STATES = new Set([
  'remote_only',
  'pairing_pending',
  'starting',
  'online',
  'ready',
  'stopped',
  'reauth_required',
  'error',
]);

const REMOTE_ONLY_STATUS = Object.freeze({
  state: 'remote_only',
  tunnelId: null,
  userId: null,
  online: false,
  ready: false,
  reason: null,
  pendingPairing: null,
});

class TunnelRuntimeSupervisorError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'TunnelRuntimeSupervisorError';
    this.code = code;
  }
}

function supervisorFail(code, message) {
  throw new TunnelRuntimeSupervisorError(code, message);
}

function boundedString(value, maximum = 4096) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\r\n]/.test(value)
  );
}

function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function sanitizePendingPairing(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    supervisorFail('TUNNEL_RUNTIME_STATUS_INVALID', 'Sidecar status was invalid');
  }
  if (
    !boundedString(value.code, 256) ||
    !boundedString(value.verificationUrl, 2048) ||
    !boundedString(value.expiresAt, 256)
  ) {
    supervisorFail('TUNNEL_RUNTIME_STATUS_INVALID', 'Sidecar status was invalid');
  }
  return Object.freeze({
    code: value.code,
    verificationUrl: value.verificationUrl,
    expiresAt: value.expiresAt,
  });
}

function sanitizeRuntimeStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    supervisorFail('TUNNEL_RUNTIME_STATUS_INVALID', 'Sidecar status was invalid');
  }
  if (typeof value.state !== 'string' || !RUNTIME_STATES.has(value.state)) {
    supervisorFail('TUNNEL_RUNTIME_STATUS_INVALID', 'Sidecar runtime state was invalid');
  }
  const status = {
    state: value.state,
    tunnelId: nullableString(value.tunnelId),
    userId: nullableString(value.userId),
    online: value.online === true,
    ready: value.ready === true,
    reason: nullableString(value.reason),
    pendingPairing: sanitizePendingPairing(value.pendingPairing),
  };
  if (status.ready && !status.online) {
    supervisorFail('TUNNEL_RUNTIME_STATUS_INVALID', 'Ready sidecar status must be online');
  }
  return Object.freeze(status);
}

function signMessage(key, payload, nonce) {
  return createHmac('sha256', key).update(`${nonce}:${payload}`).digest('hex');
}

function verifyMessageSignature(key, payload, nonce, signature) {
  try {
    const expected = Buffer.from(signMessage(key, payload, nonce), 'hex');
    const actual = Buffer.from(signature, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function sameProfile(left, right) {
  return (
    left.apiOrigin === right.apiOrigin &&
    left.tunnelId === right.tunnelId &&
    left.setupToken === right.setupToken &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId &&
    left.accountId === right.accountId
  );
}

function redactedText(value, secrets) {
  let output = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  output = output.replace(
    /\b(?:tnl_|setup[_-]?token[=: ]+|device[_-]?secret[=: ]+|control[_-]?key[=: ]+)[A-Za-z0-9._:/+=-]{8,}/gi,
    '[REDACTED]',
  );
  return output.slice(0, 16_384);
}

function resolveTunnelSidecarPath(options = {}) {
  if (options.isPackaged === true) {
    if (!boundedString(options.resourcesPath, 32_768)) {
      supervisorFail('TUNNEL_RUNTIME_RESOURCES_PATH_INVALID', 'Packaged resources path is invalid');
    }
    return path.join(options.resourcesPath, 'openopc-agent-sidecar.cjs');
  }
  const repositoryRoot = options.repositoryRoot || path.resolve(__dirname, '../../..');
  return path.join(
    repositoryRoot,
    'packages',
    'openopc-desktop-agent',
    'dist',
    'openopc-agent-sidecar.cjs',
  );
}

function createTunnelRuntimeSupervisor(options = {}) {
  const spawn = options.spawn || nodeSpawn;
  const execPath = options.execPath || process.execPath;
  const sidecarPath = options.sidecarPath;
  const baseEnv = options.env || process.env;
  const randomBytes = options.randomBytes || nodeRandomBytes;
  const profileStore = options.profileStore || null;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS;
  const confirmationTimeoutMs = options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS;
  const maxPendingCommands = Number.isSafeInteger(options.maxPendingCommands)
    ? Math.max(1, Math.min(options.maxPendingCommands, 1_024))
    : DEFAULT_MAX_PENDING_COMMANDS;
  const maxSeenConfirmationRequests = Number.isSafeInteger(options.maxSeenConfirmationRequests)
    ? Math.max(1, Math.min(options.maxSeenConfirmationRequests, 65_536))
    : DEFAULT_MAX_SEEN_CONFIRMATION_REQUESTS;
  const maxExpiredCommands = Number.isSafeInteger(options.maxExpiredCommands)
    ? Math.max(1, Math.min(options.maxExpiredCommands, 65_536))
    : DEFAULT_MAX_EXPIRED_COMMANDS;
  const maxQueuedOutputFrames = Number.isSafeInteger(options.maxQueuedOutputFrames)
    ? Math.max(1, Math.min(options.maxQueuedOutputFrames, 65_536))
    : DEFAULT_MAX_QUEUED_OUTPUT_FRAMES;
  const nativeConfirmation = options.confirmNative || (async () => false);
  const logger = options.logger || null;

  if (!boundedString(sidecarPath, 32_768)) {
    supervisorFail('TUNNEL_RUNTIME_SIDECAR_PATH_INVALID', 'Sidecar path is invalid');
  }
  if (typeof spawn !== 'function' || typeof randomBytes !== 'function') {
    supervisorFail('TUNNEL_RUNTIME_CONFIGURATION_INVALID', 'Sidecar supervisor is misconfigured');
  }

  const listeners = new Set();
  const pendingCommands = new Map();
  const expiredCommands = new Map();
  const seenConfirmationRequests = new Map();
  let statusValue = REMOTE_ONLY_STATUS;
  let childRecord = null;
  let generation = 0;
  let stopPromise = null;
  let inMemoryFatalLatch = null;
  let inputNonce = 0;
  let stderrBuffer = '';

  function emitStatus(next) {
    statusValue = sanitizeRuntimeStatus(next);
    for (const listener of [...listeners]) {
      try {
        listener(statusValue);
      } catch {
        // A renderer status listener cannot disrupt supervision.
      }
    }
  }

  function status() {
    return statusValue;
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') {
      supervisorFail('TUNNEL_RUNTIME_LISTENER_INVALID', 'Status listener is invalid');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function logStderr(text, secrets) {
    const safe = redactedText(text, secrets).trimEnd();
    if (!safe) return;
    if (typeof logger === 'function') logger(safe);
    else if (logger && typeof logger.warn === 'function') logger.warn(safe);
  }

  function cleanEnvironment(profile, controlKey) {
    const env = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' };
    for (const name of [
      'TUNNEL_TOKEN',
      'AGENT_TUNNEL_TOKEN',
      'OPENOPC_TUNNEL_TOKEN',
      'OPENOPC_DESKTOP_TUNNEL_TOKEN',
    ]) {
      delete env[name];
    }
    for (const [name, value] of Object.entries(env)) {
      if (value === profile.setupToken || value === controlKey) delete env[name];
    }
    return env;
  }

  function settlePendingCommands(approved = false) {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.resolve(approved);
    }
    pendingCommands.clear();
    expiredCommands.clear();
    seenConfirmationRequests.clear();
  }

  function rememberExpiredCommand(requestId, permissionId) {
    expiredCommands.set(requestId, { permissionId });
    while (expiredCommands.size > maxExpiredCommands) {
      const oldest = expiredCommands.keys().next().value;
      if (oldest === undefined) break;
      expiredCommands.delete(oldest);
    }
  }

  function rememberConfirmation(requestId, fingerprint, approved) {
    seenConfirmationRequests.set(requestId, { fingerprint, approved });
    while (seenConfirmationRequests.size > maxSeenConfirmationRequests) {
      const oldest = seenConfirmationRequests.keys().next().value;
      if (oldest === undefined) break;
      seenConfirmationRequests.delete(oldest);
    }
  }

  async function boundedNativeConfirmation(record, request) {
    let timer;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => nativeConfirmation(request)),
        record.confirmationAbortPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, confirmationTimeoutMs));
        }),
      ]);
      return result === true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function detachRecord(record) {
    if (childRecord !== record) return;
    childRecord = null;
    inputNonce = 0;
    stderrBuffer = '';
    settlePendingCommands(false);
  }

  function childExitPromise(record) {
    return record.exitPromise;
  }

  function resolveChildExit(record, code, signal) {
    if (record.exited) return;
    record.exited = true;
    record.resolveConfirmationAbort(false);
    record.exitCode = code;
    record.exitSignal = signal;
    record.resolveExit({ code, signal });
    if (childRecord !== record) return;
    const wasStopping = record.stopping;
    const preserveStatus = record.preserveStatus;
    detachRecord(record);
    if (preserveStatus) return;
    if (wasStopping) {
      record.exitStatusEmitted = true;
      emitStatus({
        state: 'stopped',
        tunnelId: record.profile.tunnelId,
        userId: record.profile.userId,
        online: false,
        ready: false,
        reason: record.stopReason || 'stopped',
        pendingPairing: null,
      });
      return;
    }
    emitStatus({
      state: 'error',
      tunnelId: record.profile.tunnelId,
      userId: record.profile.userId,
      online: false,
      ready: false,
      reason: `sidecar_exit_${code === null ? signal || 'unknown' : code}`,
      pendingPairing: null,
    });
  }

  function writeRaw(record, frame) {
    if (childRecord !== record || record.exited || !record.child.stdin?.writable) {
      supervisorFail('TUNNEL_RUNTIME_PIPE_CLOSED', 'Sidecar control pipe is closed');
    }
    if (Buffer.byteLength(frame, 'utf8') > CONTROL_FRAME_MAX_BYTES) {
      supervisorFail('TUNNEL_RUNTIME_FRAME_TOO_LARGE', 'Sidecar control frame is too large');
    }
    try {
      if (record.child.stdin.write(frame) === false) {
        supervisorFail('TUNNEL_RUNTIME_PIPE_BACKPRESSURE', 'Sidecar control pipe is not draining');
      }
    } catch {
      supervisorFail('TUNNEL_RUNTIME_PIPE_CLOSED', 'Sidecar control pipe is closed');
    }
  }

  function writeSigned(record, payload) {
    const nonce = ++inputNonce;
    const signature = signMessage(record.controlKey, JSON.stringify(payload), nonce);
    writeRaw(record, `${JSON.stringify({ ...payload, _sig: signature, _nonce: nonce })}\n`);
  }

  function activeSecurityStopTarget(record) {
    return childRecord && childRecord !== record ? childRecord : record;
  }

  async function latchFatal(record, reason) {
    inMemoryFatalLatch = { reason, latchedAt: new Date().toISOString() };
    let effectiveReason = reason;
    try {
      profileStore?.setFatalLatch?.(reason);
    } catch {
      try {
        const persisted = profileStore?.getFatalLatch?.();
        if (persisted?.reason !== reason) {
          effectiveReason = FATAL_LATCH_PERSIST_FAILED_REASON;
        }
      } catch {
        effectiveReason = FATAL_LATCH_PERSIST_FAILED_REASON;
      }
    }
    inMemoryFatalLatch = { reason: effectiveReason, latchedAt: new Date().toISOString() };
    emitStatus({
      state: 'error',
      tunnelId: record.profile.tunnelId,
      userId: record.profile.userId,
      online: false,
      ready: false,
      reason: effectiveReason,
      pendingPairing: null,
    });
    await stopRecord(activeSecurityStopTarget(record), effectiveReason, { preserveStatus: true });
  }

  function quarantineCredentialClearFailure() {
    inMemoryFatalLatch = {
      reason: CREDENTIAL_CLEAR_FAILED_REASON,
      latchedAt: new Date().toISOString(),
    };
    try {
      profileStore?.setFatalLatch?.(CREDENTIAL_CLEAR_FAILED_REASON);
    } catch {
      // The profile store writes its non-secret marker before updating the
      // encrypted envelope. The in-memory latch still blocks this process.
    }
    return CREDENTIAL_CLEAR_FAILED_REASON;
  }

  async function requireReauthentication(record, reason) {
    let effectiveReason = reason;
    try {
      profileStore?.clear?.();
    } catch {
      effectiveReason = quarantineCredentialClearFailure();
    }
    emitStatus({
      state: 'reauth_required',
      tunnelId: record.profile.tunnelId,
      userId: record.profile.userId,
      online: false,
      ready: false,
      reason: effectiveReason,
      pendingPairing: null,
    });
    await stopRecord(activeSecurityStopTarget(record), effectiveReason, { preserveStatus: true });
  }

  async function protocolFailure(record, reason = 'control_protocol_error') {
    if (childRecord !== record || record.exited) return;
    emitStatus({
      state: 'error',
      tunnelId: record.profile.tunnelId,
      userId: record.profile.userId,
      online: false,
      ready: false,
      reason,
      pendingPairing: null,
    });
    await stopRecord(record, reason, { preserveStatus: true, forceImmediately: true });
  }

  function validateSignedFrame(record, line) {
    const secrets = [record.profile.setupToken, record.controlKey];
    if (secrets.some((secret) => secret && line.includes(secret))) {
      supervisorFail('TUNNEL_RUNTIME_SECRET_LEAK', 'Sidecar output contained a credential');
    }
    if (Buffer.byteLength(`${line}\n`, 'utf8') > CONTROL_FRAME_MAX_BYTES) {
      supervisorFail('TUNNEL_RUNTIME_FRAME_TOO_LARGE', 'Sidecar output frame is too large');
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      supervisorFail('TUNNEL_RUNTIME_FRAME_INVALID', 'Sidecar output frame was invalid');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      supervisorFail('TUNNEL_RUNTIME_FRAME_INVALID', 'Sidecar output frame was invalid');
    }
    const signature = parsed._sig;
    const nonce = parsed._nonce;
    const { _sig: _ignoredSignature, _nonce: _ignoredNonce, ...payload } = parsed;
    if (
      parsed.version !== CONTROL_PROTOCOL_VERSION ||
      !boundedString(parsed.requestId, 256) ||
      typeof signature !== 'string' ||
      typeof nonce !== 'number' ||
      !Number.isSafeInteger(nonce) ||
      nonce <= record.outputNonce ||
      !verifyMessageSignature(record.controlKey, JSON.stringify(payload), nonce, signature)
    ) {
      supervisorFail('TUNNEL_RUNTIME_FRAME_AUTH_FAILED', 'Sidecar output authentication failed');
    }
    record.outputNonce = nonce;
    return payload;
  }

  function validateConfirmationRequest(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !boundedString(value.tunnelId, 4096) ||
      !boundedString(value.permissionId, 4096) ||
      !boundedString(value.capability, 256) ||
      !/^sha256:[0-9a-f]{64}$/.test(value.scopeDigest) ||
      (value.expiresAt !== null && !boundedString(value.expiresAt, 256))
    ) {
      supervisorFail('TUNNEL_RUNTIME_CONFIRMATION_INVALID', 'Native confirmation request was invalid');
    }
    return Object.freeze({
      tunnelId: value.tunnelId,
      permissionId: value.permissionId,
      capability: value.capability,
      scopeDigest: value.scopeDigest,
      expiresAt: value.expiresAt,
    });
  }

  function confirmationRequestDetails(record, payload) {
    const request = validateConfirmationRequest(payload.request);
    if (request.tunnelId !== record.profile.tunnelId) {
      supervisorFail('TUNNEL_RUNTIME_CONFIRMATION_INVALID', 'Native confirmation tunnel did not match');
    }
    return Object.freeze({ request, fingerprint: JSON.stringify(request) });
  }

  function writeConfirmationResponse(record, requestId, approved) {
    if (childRecord !== record || record.exited || record.stopping) return;
    try {
      writeSigned(record, {
        version: CONTROL_PROTOCOL_VERSION,
        type: 'confirmation_response',
        requestId,
        approved,
      });
    } catch {
      void protocolFailure(record, 'control_output_error');
    }
  }

  async function handleConfirmationRequest(record, payload, options = {}) {
    let approved = false;
    try {
      const { request, fingerprint } = confirmationRequestDetails(record, payload);
      const completed = seenConfirmationRequests.get(payload.requestId);
      if (completed) {
        if (completed.fingerprint !== fingerprint) {
          await protocolFailure(record, 'control_replay_detected');
          return;
        }
        approved = completed.approved;
      } else if (options.forceDeny === true) {
        rememberConfirmation(payload.requestId, fingerprint, false);
      } else {
        approved = await boundedNativeConfirmation(record, request);
        const settled = seenConfirmationRequests.get(payload.requestId);
        if (settled) {
          if (settled.fingerprint !== fingerprint) {
            await protocolFailure(record, 'control_replay_detected');
            return;
          }
          approved = settled.approved;
        } else {
          rememberConfirmation(payload.requestId, fingerprint, approved);
        }
      }
    } catch {
      approved = false;
    } finally {
      record.pendingConfirmationRequests.delete(payload.requestId);
    }
    writeConfirmationResponse(record, payload.requestId, approved);
  }

  function statusRequiresReauthentication(next) {
    return (
      next.state === 'reauth_required' ||
      next.reason === 'token_rotated' ||
      next.reason === 'auth_failed' ||
      next.reason === '4001'
    );
  }

  function securityStatusPriority(record, next) {
    if (
      (next.tunnelId !== null && next.tunnelId !== record.profile.tunnelId) ||
      (next.userId !== null && next.userId !== record.profile.userId)
    ) {
      return 1;
    }
    if (next.reason === FATAL_CONSENT_REASON) return 3;
    if (statusRequiresReauthentication(next)) return 2;
    return 0;
  }

  function claimSecurityStatus(record, next) {
    const priority = securityStatusPriority(record, next);
    if (priority === 0) return null;
    if (record.securityTransitionPriority >= priority) {
      return { priority, apply: false };
    }
    record.securityTransitionPriority = priority;
    return { priority, apply: true };
  }

  async function handleSecurityStatus(record, next, transition = claimSecurityStatus(record, next)) {
    if (!transition) return false;
    if (!transition.apply) return true;
    if (transition.priority === 1) {
      await protocolFailure(record, 'control_identity_mismatch');
      return true;
    }
    if (transition.priority === 3) {
      await latchFatal(record, FATAL_CONSENT_REASON);
      return true;
    }
    if (transition.priority === 2) {
      await requireReauthentication(record, next.reason || 'reauth_required');
      return true;
    }
    return false;
  }

  async function handlePayload(record, payload) {
    // A fatal/reauth transition can stop the child while later frames from the
    // same stdout chunk are still queued. Never let stale output resurrect the
    // runtime after the supervisor has begun termination.
    if (childRecord !== record || record.exited) return;
    if (record.stopping) {
      if (payload.type !== 'status') return;
      const stoppingStatus = sanitizeRuntimeStatus(payload.status);
      const transition = claimSecurityStatus(record, stoppingStatus);
      await handleSecurityStatus(record, stoppingStatus, transition);
      return;
    }
    switch (payload.type) {
      case 'status': {
        const next = sanitizeRuntimeStatus(payload.status);
        const transition = claimSecurityStatus(record, next);
        if (transition && (await handleSecurityStatus(record, next, transition))) return;
        if (childRecord !== record || record.exited || record.stopping) return;
        emitStatus(next);
        return;
      }
      case 'confirmation_request':
        await handleConfirmationRequest(record, payload);
        return;
      case 'confirmation_result': {
        if (
          !boundedString(payload.permissionId, 4096) ||
          typeof payload.approved !== 'boolean'
        ) {
          await protocolFailure(record, 'control_protocol_error');
          return;
        }
        const pending = pendingCommands.get(payload.requestId);
        if (!pending) {
          const expired = expiredCommands.get(payload.requestId);
          if (expired?.permissionId === payload.permissionId) return;
          await protocolFailure(record, 'control_replay_detected');
          return;
        }
        if (pending.permissionId !== payload.permissionId) {
          await protocolFailure(record, 'control_replay_detected');
          return;
        }
        pendingCommands.delete(payload.requestId);
        clearTimeout(pending.timer);
        pending.resolve(payload.approved);
        return;
      }
      default:
        await protocolFailure(record, 'control_protocol_error');
    }
  }

  function drainOutputQueue(record) {
    if (record.outputProcessing) return;
    record.outputProcessing = true;
    void (async () => {
      try {
        while (record.outputQueue.length > 0) {
          const payload = record.outputQueue.shift();
          try {
            await handlePayload(record, payload);
          } catch {
            await protocolFailure(record);
          } finally {
            record.outputQueueDepth -= 1;
          }
        }
      } finally {
        record.outputProcessing = false;
        if (record.outputQueue.length > 0) drainOutputQueue(record);
      }
    })();
  }

  function enqueueOutputPayload(record, payload) {
    if (record.outputQueueDepth >= maxQueuedOutputFrames) return false;
    record.outputQueue.push(payload);
    record.outputQueueDepth += 1;
    drainOutputQueue(record);
    return true;
  }

  function dispatchConfirmationRequest(record, payload) {
    try {
      const { fingerprint } = confirmationRequestDetails(record, payload);
      const completed = seenConfirmationRequests.get(payload.requestId);
      if (completed) {
        if (completed.fingerprint !== fingerprint) {
          void protocolFailure(record, 'control_replay_detected');
          return;
        }
        void handleConfirmationRequest(record, payload);
        return;
      }
      const pending = record.pendingConfirmationRequests.get(payload.requestId);
      if (pending) {
        if (pending !== fingerprint) {
          void protocolFailure(record, 'control_replay_detected');
          return;
        }
        if (!enqueueOutputPayload(record, payload)) {
          void handleConfirmationRequest(record, payload, { forceDeny: true });
        }
        return;
      }
      record.pendingConfirmationRequests.set(payload.requestId, fingerprint);
      if (!enqueueOutputPayload(record, payload)) {
        void handleConfirmationRequest(record, payload, { forceDeny: true });
      }
    } catch {
      void protocolFailure(record, 'control_protocol_error');
    }
  }

  function dispatchPriorityStatus(record, payload) {
    if (payload.type !== 'status') return false;
    let next;
    try {
      next = sanitizeRuntimeStatus(payload.status);
    } catch {
      void protocolFailure(record, 'control_protocol_error');
      return true;
    }
    const transition = claimSecurityStatus(record, next);
    if (!transition) return false;
    if (!transition.apply) return true;
    void handleSecurityStatus(record, next, transition).catch(() => protocolFailure(record));
    return true;
  }

  function attachOutput(record) {
    let stdoutBuffer = '';
    record.child.stdout?.setEncoding?.('utf8');
    record.child.stdout?.on?.('data', (chunk) => {
      if (record.outputClosed) return;
      stdoutBuffer += String(chunk);
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) {
          void protocolFailure(record, 'control_protocol_error');
          return;
        }
        try {
          const payload = validateSignedFrame(record, line);
          if (dispatchPriorityStatus(record, payload)) continue;
          if (payload.type === 'confirmation_request') {
            dispatchConfirmationRequest(record, payload);
            continue;
          }
          void handlePayload(record, payload).catch(() => protocolFailure(record));
        } catch {
          void protocolFailure(record, 'control_auth_failed');
          return;
        }
      }
      if (Buffer.byteLength(stdoutBuffer, 'utf8') >= CONTROL_FRAME_MAX_BYTES) {
        stdoutBuffer = '';
        void protocolFailure(record, 'control_frame_overflow');
      }
    });
    const closeOutput = () => {
      if (record.outputClosed) return;
      record.outputClosed = true;
      const reason = stdoutBuffer ? 'control_protocol_error' : 'control_pipe_error';
      stdoutBuffer = '';
      if (!record.stopping && !record.exited) void protocolFailure(record, reason);
    };
    record.child.stdout?.on?.('end', closeOutput);
    record.child.stdout?.on?.('close', closeOutput);
    record.child.stdout?.on?.('error', () => {
      if (!record.stopping && !record.exited) void protocolFailure(record, 'control_pipe_error');
    });

    const secrets = [record.profile.setupToken, record.controlKey];
    record.child.stderr?.setEncoding?.('utf8');
    record.child.stderr?.on?.('data', (chunk) => {
      stderrBuffer += String(chunk);
      if (stderrBuffer.length > 32_768) stderrBuffer = stderrBuffer.slice(-16_384);
      let newline;
      while ((newline = stderrBuffer.indexOf('\n')) >= 0) {
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        logStderr(line, secrets);
      }
    });
  }

  async function start(profileInput) {
    const profile = validateTunnelProfile(profileInput);
    if (
      typeof profileStore?.secureStorageAvailable === 'function' &&
      !profileStore.secureStorageAvailable()
    ) {
      await stop('secure_storage_unavailable');
      emitStatus({
        state: 'remote_only',
        tunnelId: null,
        userId: null,
        online: false,
        ready: false,
        reason: 'secure_storage_unavailable',
        pendingPairing: null,
      });
      supervisorFail(
        'TUNNEL_RUNTIME_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable',
      );
    }
    if (childRecord && !childRecord.exited) {
      if (sameProfile(childRecord.profile, profile)) return statusValue;
      supervisorFail('TUNNEL_RUNTIME_ALREADY_RUNNING', 'A different sidecar profile is already running');
    }
    let fatalLatch = inMemoryFatalLatch;
    if (!fatalLatch) {
      try {
        fatalLatch = profileStore?.getFatalLatch?.() || null;
      } catch {
        fatalLatch = { reason: 'secure_storage_unavailable' };
      }
    }
    if (fatalLatch) {
      emitStatus({
        state: 'reauth_required',
        tunnelId: profile.tunnelId,
        userId: profile.userId,
        online: false,
        ready: false,
        reason: fatalLatch.reason || FATAL_CONSENT_REASON,
        pendingPairing: null,
      });
      supervisorFail('TUNNEL_RUNTIME_FATAL_LATCHED', 'Sidecar restart requires credential reset');
    }

    const controlKey = Buffer.from(randomBytes(32)).toString('hex');
    if (!boundedString(controlKey, 4096)) {
      supervisorFail('TUNNEL_RUNTIME_CONTROL_KEY_INVALID', 'Per-launch control key is invalid');
    }
    let child;
    try {
      child = spawn(execPath, [sidecarPath], {
        env: cleanEnvironment(profile, controlKey),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      emitStatus({
        state: 'error',
        tunnelId: profile.tunnelId,
        userId: profile.userId,
        online: false,
        ready: false,
        reason: 'sidecar_spawn_failed',
        pendingPairing: null,
      });
      supervisorFail('TUNNEL_RUNTIME_SPAWN_FAILED', 'Sidecar could not be started');
    }
    if (!child || !child.stdin || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      try {
        child?.kill?.();
      } catch {
        // Ignore cleanup failure for a malformed child process adapter.
      }
      supervisorFail('TUNNEL_RUNTIME_SPAWN_FAILED', 'Sidecar process adapter was invalid');
    }

    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    let resolveConfirmationAbort;
    const confirmationAbortPromise = new Promise((resolve) => {
      resolveConfirmationAbort = resolve;
    });
    const record = {
      generation: ++generation,
      child,
      controlKey,
      profile,
      outputNonce: 0,
      outputQueue: [],
      outputQueueDepth: 0,
      outputProcessing: false,
      pendingConfirmationRequests: new Map(),
      securityTransitionPriority: 0,
      outputClosed: false,
      exited: false,
      stopping: false,
      preserveStatus: false,
      exitStatusEmitted: false,
      stopReason: null,
      exitPromise,
      resolveExit,
      confirmationAbortPromise,
      resolveConfirmationAbort,
    };
    childRecord = record;
    inputNonce = 0;
    stderrBuffer = '';
    child.on('exit', (code, signal) => resolveChildExit(record, code, signal));
    child.on('error', () => {
      if (!record.stopping && !record.exited) {
        void protocolFailure(record, 'sidecar_process_error');
      }
    });
    attachOutput(record);

    emitStatus({
      state: 'starting',
      tunnelId: profile.tunnelId,
      userId: profile.userId,
      online: false,
      ready: false,
      reason: null,
      pendingPairing: null,
    });
    try {
      writeRaw(record, `${JSON.stringify({ type: 'bootstrap', profile, controlKey })}\n`);
    } catch (error) {
      await protocolFailure(record, 'control_bootstrap_failed');
      throw error;
    }
    return statusValue;
  }

  function timeout(delayMs) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs), 'timeout'));
  }

  async function stopRecord(record, reason, stopOptions = {}) {
    if (!record || record.exited) return { graceful: true, forced: false };
    if (record.stopPromise) {
      if (stopOptions.preserveStatus === true) record.preserveStatus = true;
      return record.stopPromise;
    }
    record.stopping = true;
    record.resolveConfirmationAbort(false);
    record.stopReason = boundedString(reason, 1024) ? reason : 'stopped';
    record.preserveStatus = stopOptions.preserveStatus === true;
    const requestedTimeout = Number.isSafeInteger(stopOptions.timeoutMs)
      ? Math.max(0, stopOptions.timeoutMs)
      : Math.max(0, stopTimeoutMs);

    record.stopPromise = (async () => {
      let forced = stopOptions.forceImmediately === true;
      if (!forced) {
        try {
          writeSigned(record, {
            version: CONTROL_PROTOCOL_VERSION,
            type: 'stop',
            requestId: `stop-${record.generation}-${inputNonce + 1}`,
            reason: record.stopReason,
          });
        } catch {
          forced = true;
        }
      }
      let result = forced
        ? 'timeout'
        : await Promise.race([childExitPromise(record).then(() => 'exit'), timeout(requestedTimeout)]);
      if (result !== 'exit') {
        forced = true;
        try {
          record.child.kill?.('SIGTERM');
        } catch {
          // Continue to the hard-stop deadline.
        }
        result = await Promise.race([
          childExitPromise(record).then(() => 'exit'),
          timeout(Math.max(0, forceKillGraceMs)),
        ]);
      }
      if (result !== 'exit') {
        try {
          record.child.kill?.('SIGKILL');
        } catch {
          // The process may already be gone.
        }
        resolveChildExit(record, null, 'SIGKILL');
      }
      try {
        record.child.stdin?.end?.();
      } catch {
        // Closing the parent pipe is best effort after process termination.
      }
      if (childRecord === record) detachRecord(record);
      if (!record.preserveStatus && !record.exitStatusEmitted) {
        emitStatus({
          state: 'stopped',
          tunnelId: record.profile.tunnelId,
          userId: record.profile.userId,
          online: false,
          ready: false,
          reason: record.stopReason,
          pendingPairing: null,
        });
      }
      return { graceful: !forced, forced };
    })();
    return record.stopPromise;
  }

  async function stop(reason = 'stopped', timeoutMs) {
    if (stopPromise) return stopPromise;
    const record = childRecord;
    if (!record) {
      if (statusValue.state !== 'remote_only') {
        emitStatus({ ...statusValue, state: 'stopped', online: false, ready: false, reason });
      }
      return { graceful: true, forced: false };
    }
    stopPromise = stopRecord(record, reason, { timeoutMs }).finally(() => {
      stopPromise = null;
    });
    return stopPromise;
  }

  async function confirmPermission(permissionId) {
    if (!boundedString(permissionId, 4096)) {
      supervisorFail('TUNNEL_RUNTIME_PERMISSION_INVALID', 'Permission id is invalid');
    }
    const record = childRecord;
    if (!record || record.exited || record.stopping) {
      supervisorFail('TUNNEL_RUNTIME_NOT_RUNNING', 'Sidecar is not running');
    }
    if (pendingCommands.size >= maxPendingCommands) {
      supervisorFail(
        'TUNNEL_RUNTIME_CONFIRMATION_BUSY',
        'Too many permission confirmations are already pending',
      );
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(requestId);
        rememberExpiredCommand(requestId, permissionId);
        resolve(false);
      }, confirmationTimeoutMs);
      pendingCommands.set(requestId, { permissionId, resolve, timer });
      try {
        writeSigned(record, {
          version: CONTROL_PROTOCOL_VERSION,
          type: 'confirm_permission',
          requestId,
          permissionId,
        });
      } catch {
        pendingCommands.delete(requestId);
        clearTimeout(timer);
        resolve(false);
      }
    });
  }

  async function forgetCredentials() {
    await stop('unpair');
    try {
      profileStore?.clear?.();
    } catch {
      const reason = quarantineCredentialClearFailure();
      emitStatus({
        state: 'reauth_required',
        tunnelId: statusValue.tunnelId,
        userId: statusValue.userId,
        online: false,
        ready: false,
        reason,
        pendingPairing: null,
      });
      supervisorFail(
        'TUNNEL_RUNTIME_CREDENTIAL_CLEAR_FAILED',
        'Tunnel credentials could not be cleared',
      );
    }
    inMemoryFatalLatch = null;
    emitStatus(REMOTE_ONLY_STATUS);
  }

  return Object.freeze({
    start,
    stop,
    status,
    onStatus,
    confirmPermission,
    forgetCredentials,
    unpair: forgetCredentials,
    forceRepair: forgetCredentials,
  });
}

function controllerContext(input = {}, defaults = {}) {
  const origin = normalizeOrigin(input.origin || defaults.origin, 'Configured app');
  const userId = input.userId || defaults.userId;
  const deviceId = input.deviceId || defaults.deviceId;
  const accountId = input.accountId || defaults.accountId;
  const candidate = validateTunnelProfile({
    apiOrigin: origin,
    tunnelId: 'context-placeholder',
    setupToken: 'context-placeholder-token',
    userId,
    deviceId,
    ...(accountId ? { accountId } : {}),
  });
  return Object.freeze({
    origin: candidate.apiOrigin,
    userId: candidate.userId,
    deviceId: candidate.deviceId,
    ...(candidate.accountId ? { accountId: candidate.accountId } : {}),
    machineHostname:
      typeof input.machineHostname === 'string'
        ? input.machineHostname.slice(0, 255)
        : defaults.machineHostname,
  });
}

function createDesktopTunnelController(options = {}) {
  const profileStore = options.profileStore;
  const supervisor = options.supervisor;
  if (!profileStore || !supervisor) {
    supervisorFail('TUNNEL_CONTROLLER_CONFIGURATION_INVALID', 'Desktop tunnel controller is misconfigured');
  }
  const createPairing = options.createPairing || createTunnelPairing;
  const listeners = new Set();
  let pairing = null;
  let pairingTask = null;
  let pairingGeneration = 0;
  let overlayStatus = null;

  function currentStatus() {
    return overlayStatus || supervisor.status();
  }

  function emitCurrent() {
    const value = currentStatus();
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch {
        // Controller listeners cannot interrupt pairing or sidecar cleanup.
      }
    }
  }

  const unsubscribeSupervisor = supervisor.onStatus?.(() => {
    if (!overlayStatus) emitCurrent();
  });

  function setOverlay(value) {
    overlayStatus = value === null ? null : sanitizeRuntimeStatus(value);
    emitCurrent();
  }

  function pairingState(context, pending) {
    return {
      state: 'pairing_pending',
      tunnelId: null,
      userId: context.userId,
      online: false,
      ready: false,
      reason: null,
      pendingPairing: pending,
    };
  }

  function clearProfileIfCurrent(profile, context) {
    let current = null;
    try {
      current = profileStore.load?.({
        origin: context.origin,
        userId: context.userId,
        deviceId: context.deviceId,
        accountId: context.accountId,
      });
    } catch {
      return false;
    }
    if (!current) return false;
    if (
      (current.apiOrigin !== profile.apiOrigin ||
        current.tunnelId !== profile.tunnelId ||
        current.setupToken !== profile.setupToken ||
        current.userId !== profile.userId ||
        current.deviceId !== profile.deviceId ||
        current.accountId !== profile.accountId)
    ) {
      return false;
    }
    profileStore.clear();
    return true;
  }

  async function completePairing(context, activePairing, expectedGeneration) {
    try {
      const result = await activePairing.waitForApproval();
      if (expectedGeneration !== pairingGeneration || pairing !== activePairing) return null;
      if (result.status !== 'approved') {
        pairing = null;
        setOverlay({
          state: 'stopped',
          tunnelId: null,
          userId: context.userId,
          online: false,
          ready: false,
          reason: `pairing_${result.status}`,
          pendingPairing: null,
        });
        return result;
      }
      if (typeof result.accountId !== 'string' || result.accountId !== context.accountId) {
        supervisorFail(
          'TUNNEL_PAIRING_ACCOUNT_MISMATCH',
          'Approved pairing account did not match the selected account',
        );
      }
      const profile = validateTunnelProfile({
        apiOrigin: context.origin,
        tunnelId: result.tunnelId,
        setupToken: result.setupToken,
        userId: context.userId,
        deviceId: context.deviceId,
        accountId: result.accountId,
      });
      profileStore.save(profile);
      setOverlay(null);
      try {
        await supervisor.start(profile);
      } catch (error) {
        clearProfileIfCurrent(profile, context);
        throw error;
      }
      if (expectedGeneration !== pairingGeneration || pairing !== activePairing) {
        try {
          await supervisor.stop('pairing_superseded');
        } finally {
          clearProfileIfCurrent(profile, context);
          if (pairing === activePairing) pairing = null;
        }
        return null;
      }
      pairing = null;
      return result;
    } catch (error) {
      if (expectedGeneration !== pairingGeneration || pairing !== activePairing) return null;
      pairing = null;
      setOverlay({
        state: 'error',
        tunnelId: null,
        userId: context.userId,
        online: false,
        ready: false,
        reason: error?.code || 'pairing_failed',
        pendingPairing: null,
      });
      return null;
    }
  }

  async function beginPairing(input = {}) {
    if (
      typeof profileStore.secureStorageAvailable === 'function' &&
      !profileStore.secureStorageAvailable()
    ) {
      await supervisor.stop('secure_storage_unavailable');
      setOverlay(REMOTE_ONLY_STATUS);
      supervisorFail(
        'TUNNEL_PROFILE_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable',
      );
    }
    const context = controllerContext(input, options);
    const previousPairing = pairing;
    const previousTask = pairingTask;
    const activeGeneration = ++pairingGeneration;
    previousPairing?.cancel();
    if (previousTask) await previousTask;
    if (activeGeneration !== pairingGeneration) {
      supervisorFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
    }
    pairing = createPairing({
      origin: context.origin,
      accountId: context.accountId,
      machineHostname: context.machineHostname,
      fetch: options.fetch,
      now: options.now,
      sleep: options.sleep,
    });
    const activePairing = pairing;
    let pending;
    try {
      pending = await activePairing.begin();
    } catch (error) {
      if (activeGeneration === pairingGeneration && pairing === activePairing) {
        pairing = null;
        setOverlay({
          state: 'error',
          tunnelId: null,
          userId: context.userId,
          online: false,
          ready: false,
          reason: error?.code || 'pairing_failed',
          pendingPairing: null,
        });
      }
      throw error;
    }
    if (activeGeneration !== pairingGeneration || pairing !== activePairing) {
      supervisorFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
    }
    setOverlay(pairingState(context, pending));
    pairingTask = completePairing(context, activePairing, activeGeneration);
    return pending;
  }

  function cancelPairing() {
    pairingGeneration += 1;
    pairing?.cancel();
    pairing = null;
    setOverlay(null);
  }

  async function startIfProfileMatches(input = {}) {
    if (
      typeof profileStore.secureStorageAvailable === 'function' &&
      !profileStore.secureStorageAvailable()
    ) {
      await supervisor.stop('secure_storage_unavailable');
      setOverlay(REMOTE_ONLY_STATUS);
      return false;
    }
    const context = controllerContext(input, options);
    let profile;
    try {
      profile = profileStore.load({
        origin: context.origin,
        userId: context.userId,
        deviceId: context.deviceId,
        accountId: context.accountId,
      });
    } catch {
      await supervisor.stop('profile_load_failed');
      setOverlay(REMOTE_ONLY_STATUS);
      return false;
    }
    if (!profile) {
      await supervisor.stop('profile_mismatch');
      setOverlay(REMOTE_ONLY_STATUS);
      return false;
    }
    setOverlay(null);
    await supervisor.start(profile);
    return true;
  }

  async function stop(reason = 'stopped', timeoutMs) {
    cancelPairing();
    return supervisor.stop(reason, timeoutMs);
  }

  async function forgetCredentials() {
    cancelPairing();
    await supervisor.forgetCredentials();
    setOverlay(REMOTE_ONLY_STATUS);
  }

  function onStatus(listener) {
    if (typeof listener !== 'function') {
      supervisorFail('TUNNEL_RUNTIME_LISTENER_INVALID', 'Status listener is invalid');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function dispose() {
    cancelPairing();
    unsubscribeSupervisor?.();
    listeners.clear();
  }

  return Object.freeze({
    beginPairing,
    cancelPairing,
    startIfProfileMatches,
    stop,
    forgetCredentials,
    unpair: forgetCredentials,
    status: currentStatus,
    onStatus,
    waitForPairing: () => pairingTask || Promise.resolve(null),
    dispose,
  });
}

module.exports = {
  CONTROL_FRAME_MAX_BYTES,
  CONTROL_PROTOCOL_VERSION,
  DEFAULT_STOP_TIMEOUT_MS,
  FATAL_CONSENT_REASON,
  REMOTE_ONLY_STATUS,
  TunnelRuntimeSupervisorError,
  createDesktopTunnelController,
  createTunnelRuntimeSupervisor,
  redactedText,
  resolveTunnelSidecarPath,
  sanitizeRuntimeStatus,
  signMessage,
  verifyMessageSignature,
};
