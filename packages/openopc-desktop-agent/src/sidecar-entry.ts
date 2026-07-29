import { createInterface } from 'node:readline';

import { TunnelAgent, signMessage, verifyMessageSignature } from 'agent-tunnel';

import {
  type DesktopConsentStore,
  type DesktopConsentStoreOptions,
  type NativeConfirmationRequest,
  createDesktopConsentStore,
} from './consent-store';
import {
  type BootstrapFrame,
  CONTROL_FRAME_MAX_BYTES,
  createBootstrapGate,
  sanitizeRuntimeStatus,
} from './framed-control';
import { type DesktopSidecarRuntimeOptions, createDesktopSidecarRuntime } from './runtime';
import type { DesktopRuntimeStatus, DesktopTunnelProfile } from './types';

const CONTROL_PROTOCOL_VERSION = 1;

export interface SidecarRuntimePort {
  start(profile: DesktopTunnelProfile): Promise<void>;
  stop(reason?: string): Promise<void>;
  status(): DesktopRuntimeStatus;
  onStatus?(listener: (status: DesktopRuntimeStatus) => void): () => void;
  confirmPermission?(
    permissionId: string,
    confirmation: { confirm(request: NativeConfirmationRequest): Promise<boolean> },
  ): Promise<boolean>;
}

export interface SidecarControlSessionOptions {
  runtime: SidecarRuntimePort;
  write(frame: string): void;
  onFatal(reason: string): void;
  onStopped?(): void;
  confirmationTimeoutMs?: number;
}

export interface SidecarControlSession {
  receive(raw: string): Promise<void>;
  parentClosed(): Promise<void>;
  fatal(reason: string): Promise<void>;
}

export interface DesktopSidecarProcessOptions {
  input: NodeJS.ReadableStream;
  write(frame: string): void;
  setExitCode(code: number): void;
  createConsentStore?: (options: DesktopConsentStoreOptions) => DesktopConsentStore;
  createRuntime?: (options: DesktopSidecarRuntimeOptions) => SidecarRuntimePort;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function parseFrame(raw: string): Record<string, unknown> {
  if (byteLength(raw) > CONTROL_FRAME_MAX_BYTES) {
    throw new Error(`Control frame exceeds ${CONTROL_FRAME_MAX_BYTES} bytes`);
  }
  if (!raw.endsWith('\n')) throw new Error('Control frame must end with a newline');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(0, -1));
  } catch {
    throw new Error('Invalid control frame JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid control frame');
  }
  return parsed as Record<string, unknown>;
}

function controlKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 16 ||
    value.length > 4096 ||
    /[\r\n]/.test(value)
  ) {
    throw new Error('Invalid control key');
  }
  return value;
}

function bootstrapFrame(record: Record<string, unknown>): BootstrapFrame {
  if (record.type !== 'bootstrap') throw new Error('First control frame must be bootstrap');
  return record as unknown as BootstrapFrame;
}

type AuthenticatedControlCommand =
  | { type: 'stop'; nonce: number; reason: string }
  | { type: 'confirm_permission'; nonce: number; requestId: string; permissionId: string }
  | { type: 'confirmation_response'; nonce: number; requestId: string; approved: boolean };

function boundedControlString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\r\n]/.test(value)
  );
}

function authenticatedControlCommand(
  record: Record<string, unknown>,
  key: string,
  previousNonce: number,
): AuthenticatedControlCommand {
  const signature = record._sig;
  const nonce = record._nonce;
  const { _sig: _ignoredSignature, _nonce: _ignoredNonce, ...payload } = record;
  if (
    record.version !== CONTROL_PROTOCOL_VERSION ||
    !boundedControlString(record.requestId, 256) ||
    typeof signature !== 'string' ||
    typeof nonce !== 'number' ||
    !Number.isSafeInteger(nonce) ||
    nonce <= previousNonce ||
    !verifyMessageSignature(key, JSON.stringify(payload), nonce, signature)
  ) {
    throw new Error('Invalid authenticated control frame');
  }
  switch (record.type) {
    case 'stop':
      if (
        record.reason !== undefined &&
        record.reason !== null &&
        !boundedControlString(record.reason, 1024)
      ) {
        throw new Error('Invalid authenticated control frame');
      }
      return {
        type: 'stop',
        nonce,
        reason: typeof record.reason === 'string' ? record.reason : 'stopped',
      };
    case 'confirm_permission':
      if (!boundedControlString(record.permissionId, 4096)) {
        throw new Error('Invalid authenticated control frame');
      }
      return {
        type: 'confirm_permission',
        nonce,
        requestId: record.requestId,
        permissionId: record.permissionId,
      };
    case 'confirmation_response':
      if (typeof record.approved !== 'boolean') {
        throw new Error('Invalid authenticated control frame');
      }
      return {
        type: 'confirmation_response',
        nonce,
        requestId: record.requestId,
        approved: record.approved,
      };
    default:
      throw new Error('Invalid authenticated control frame');
  }
}

function sanitizedConfirmationRequest(value: NativeConfirmationRequest): NativeConfirmationRequest {
  if (
    !boundedControlString(value.tunnelId, 4096) ||
    !boundedControlString(value.permissionId, 4096) ||
    !boundedControlString(value.capability, 256) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.scopeDigest) ||
    (value.expiresAt !== null && !boundedControlString(value.expiresAt, 256))
  ) {
    throw new Error('Invalid native confirmation request');
  }
  return {
    tunnelId: value.tunnelId,
    permissionId: value.permissionId,
    capability: value.capability,
    scopeDigest: value.scopeDigest,
    expiresAt: value.expiresAt,
  };
}

export function createSidecarControlSession(
  options: SidecarControlSessionOptions,
): SidecarControlSession {
  const bootstrapGate = createBootstrapGate();
  let key: string | null = null;
  let inputNonce = 0;
  let outputNonce = 0;
  let terminated = false;
  let fatalReported = false;
  let confirmationSequence = 0;
  const confirmationCommands = new Map<
    string,
    { permissionId: string; state: 'pending' | 'completed'; approved?: boolean }
  >();
  const MAX_COMPLETED_COMMANDS = 256;
  const MAX_IN_FLIGHT_COMMANDS = 32;
  const confirmationTimeoutMs = options.confirmationTimeoutMs ?? 60_000;
  const pendingConfirmations = new Map<
    string,
    { resolve(approved: boolean): void; timer: ReturnType<typeof setTimeout> }
  >();

  const writeSignedFrame = (payload: Record<string, unknown>): void => {
    if (!key || terminated) return;
    const nonce = ++outputNonce;
    const signature = signMessage(key, JSON.stringify(payload), nonce);
    const encoded = `${JSON.stringify({ ...payload, _sig: signature, _nonce: nonce })}\n`;
    if (byteLength(encoded) > CONTROL_FRAME_MAX_BYTES) {
      throw new Error(`Control frame exceeds ${CONTROL_FRAME_MAX_BYTES} bytes`);
    }
    options.write(encoded);
  };

  const writeStatus = (status: DesktopRuntimeStatus): void => {
    if (!key || terminated) return;
    writeSignedFrame({
      version: CONTROL_PROTOCOL_VERSION,
      type: 'status' as const,
      requestId: `status-${outputNonce + 1}`,
      status: sanitizeRuntimeStatus(status),
    });
  };

  const cancelPendingConfirmations = (): void => {
    const pending = [...pendingConfirmations.values()];
    pendingConfirmations.clear();
    for (const confirmation of pending) {
      clearTimeout(confirmation.timer);
      confirmation.resolve(false);
    }
  };

  const clearCommandStates = (): void => {
    confirmationCommands.clear();
  };

  const pruneCompletedCommands = (): void => {
    while (confirmationCommands.size > MAX_COMPLETED_COMMANDS) {
      const oldestCompleted = [...confirmationCommands].find(
        ([, command]) => command.state === 'completed',
      );
      if (!oldestCompleted) return;
      confirmationCommands.delete(oldestCompleted[0]);
    }
  };

  const requestNativeConfirmation = (value: NativeConfirmationRequest): Promise<boolean> => {
    if (terminated) return Promise.resolve(false);
    const request = sanitizedConfirmationRequest(value);
    const requestId = `confirmation-${++confirmationSequence}`;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingConfirmations.delete(requestId)) return;
        resolve(false);
      }, confirmationTimeoutMs);
      pendingConfirmations.set(requestId, { resolve, timer });
      writeSignedFrame({
        version: CONTROL_PROTOCOL_VERSION,
        type: 'confirmation_request',
        requestId,
        request,
      });
    });
  };

  const unsubscribe = options.runtime.onStatus?.((status) => {
    writeStatus(status);
  });

  const fail = async (reason: string): Promise<void> => {
    if (fatalReported) return;
    fatalReported = true;
    const wasTerminated = terminated;
    if (!wasTerminated && key) {
      try {
        writeStatus({
          ...options.runtime.status(),
          state: 'error',
          online: false,
          ready: false,
          reason,
          pendingPairing: null,
        });
      } catch {
        // The sidecar still terminates if the parent control pipe cannot be written.
      }
    }
    terminated = true;
    cancelPendingConfirmations();
    clearCommandStates();
    unsubscribe?.();
    try {
      if (!wasTerminated) await options.runtime.stop(reason);
    } finally {
      options.onFatal(reason);
    }
  };

  return {
    async receive(raw) {
      if (terminated) return;
      let record: Record<string, unknown>;
      try {
        record = parseFrame(raw);
      } catch {
        await fail('control_protocol_error');
        return;
      }

      if (!key) {
        try {
          const bootstrap = bootstrapFrame(record);
          const nextKey = controlKey(bootstrap.controlKey);
          const profile = bootstrapGate.accept(bootstrap);
          key = nextKey;
          await options.runtime.start(profile);
          writeStatus(options.runtime.status());
        } catch {
          await fail('control_protocol_error');
        }
        return;
      }

      if (record.type === 'bootstrap') {
        await fail('control_protocol_error');
        return;
      }

      try {
        const command = authenticatedControlCommand(record, key, inputNonce);
        inputNonce = command.nonce;
        switch (command.type) {
          case 'stop':
            terminated = true;
            cancelPendingConfirmations();
            clearCommandStates();
            unsubscribe?.();
            try {
              await options.runtime.stop(command.reason);
            } finally {
              options.onStopped?.();
            }
            return;
          case 'confirm_permission': {
            const confirmPermission = options.runtime.confirmPermission;
            if (!confirmPermission) throw new Error('Native confirmation is unavailable');
            const existing = confirmationCommands.get(command.requestId);
            if (existing) {
              if (existing.permissionId !== command.permissionId) {
                throw new Error('Confirmation request id was reused');
              }
              if (existing.state === 'completed') {
                writeSignedFrame({
                  version: CONTROL_PROTOCOL_VERSION,
                  type: 'confirmation_result',
                  requestId: command.requestId,
                  permissionId: command.permissionId,
                  approved: existing.approved === true,
                });
              }
              return;
            }
            const inFlight = [...confirmationCommands.values()].filter(
              (entry) => entry.state === 'pending',
            ).length;
            if (inFlight >= MAX_IN_FLIGHT_COMMANDS) {
              confirmationCommands.set(command.requestId, {
                permissionId: command.permissionId,
                state: 'completed',
                approved: false,
              });
              writeSignedFrame({
                version: CONTROL_PROTOCOL_VERSION,
                type: 'confirmation_result',
                requestId: command.requestId,
                permissionId: command.permissionId,
                approved: false,
              });
              pruneCompletedCommands();
              return;
            }
            const commandState = {
              permissionId: command.permissionId,
              state: 'pending' as const,
            };
            confirmationCommands.set(command.requestId, commandState);
            const complete = (approved: boolean): void => {
              const current = confirmationCommands.get(command.requestId);
              if (!current || current.state !== 'pending' || terminated) return;
              current.state = 'completed';
              current.approved = approved;
              try {
                writeSignedFrame({
                  version: CONTROL_PROTOCOL_VERSION,
                  type: 'confirmation_result',
                  requestId: command.requestId,
                  permissionId: command.permissionId,
                  approved,
                });
              } catch {
                void fail('control_output_error').catch(() => undefined);
              }
              pruneCompletedCommands();
            };
            let confirmationPromise: Promise<boolean>;
            try {
              confirmationPromise = confirmPermission.call(options.runtime, command.permissionId, {
                confirm: requestNativeConfirmation,
              });
            } catch {
              complete(false);
              return;
            }
            void confirmationPromise.then(complete, () => complete(false));
            return;
          }
          case 'confirmation_response': {
            const pending = pendingConfirmations.get(command.requestId);
            if (!pending) throw new Error('Unknown native confirmation response');
            pendingConfirmations.delete(command.requestId);
            clearTimeout(pending.timer);
            pending.resolve(command.approved);
            return;
          }
        }
      } catch {
        await fail('control_auth_failed');
      }
    },
    async parentClosed() {
      if (terminated) return;
      terminated = true;
      cancelPendingConfirmations();
      clearCommandStates();
      unsubscribe?.();
      await options.runtime.stop('parent_eof');
    },
    async fatal(reason) {
      await fail(reason);
    },
  };
}

export function runDesktopAgentSidecar(options: DesktopSidecarProcessOptions): () => Promise<void> {
  let session: SidecarControlSession | null = null;
  let deferredStorageFatal: 'LOCAL_CONSENT_QUARANTINE_FAILED' | null = null;
  const handleStorageFatal = (reason: 'LOCAL_CONSENT_QUARANTINE_FAILED'): void => {
    if (!session) {
      deferredStorageFatal = reason;
      return;
    }
    void session.fatal(reason).catch(() => {
      options.setExitCode(1);
    });
  };
  const consentStore = (options.createConsentStore ?? createDesktopConsentStore)({
    onFatalStorageFailure: handleStorageFatal,
  });
  const runtime = (options.createRuntime ?? createDesktopSidecarRuntime)({
    consentStore,
    createAgent: ({ config, registry, onEvent }) => new TunnelAgent(config, registry, { onEvent }),
  });
  const input = createInterface({ input: options.input, crlfDelay: Number.POSITIVE_INFINITY });
  let queue = Promise.resolve();
  let closed = false;
  session = createSidecarControlSession({
    runtime,
    write: options.write,
    onStopped: () => {
      input.close();
    },
    onFatal: () => {
      options.setExitCode(1);
      input.close();
    },
  });
  if (deferredStorageFatal) {
    void session.fatal(deferredStorageFatal).catch(() => {
      options.setExitCode(1);
    });
  }

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    input.close();
    await queue;
    await session.parentClosed();
  };

  input.on('line', (line) => {
    queue = queue
      .then(() => session.receive(`${line}\n`))
      .catch(async () => {
        options.setExitCode(1);
        await session.parentClosed();
      });
  });
  input.on('close', () => {
    queue = queue.then(() => session.parentClosed());
  });
  input.on('error', () => {
    options.setExitCode(1);
    queue = queue.then(() => session.parentClosed());
  });

  return close;
}

if (import.meta.main) {
  const writeControl = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  runDesktopAgentSidecar({
    input: process.stdin,
    write: (frame) => {
      writeControl(frame);
    },
    setExitCode: (code) => {
      process.exitCode = code;
    },
  });
}
