import { hostname, platform, arch, release } from 'os';
import { trustedCredential, trustedHttpUrl, type TunnelConfig } from './config';
import { CapabilityRegistry } from './capabilities/index';
import { PermissionGuard } from './security/permission-guard';
import type { LocalPermission } from './security/permission-guard';
import { capabilityForMethod } from './security/automation-action-policy';
import { signMessage, verifyMessageSignature } from '../shared/crypto';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
  _sig?: string;
  _nonce?: number;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  _sig?: string;
  _nonce?: number;
}

type IncomingMessage = JsonRpcRequest | JsonRpcNotification;

export type TunnelAgentLifecycleEvent =
  | { type: 'auth_ok' }
  | { type: 'permissions_synced'; permissions: readonly LocalPermission[] }
  | { type: 'permission_granted'; permission: LocalPermission }
  | { type: 'permission_revoked'; permissionId: string }
  | { type: 'token_rotated' }
  | { type: 'connection_closed'; code: number }
  | { type: 'kill_switch'; generation?: number };

export interface TunnelAgentOptions {
  onEvent?: (event: TunnelAgentLifecycleEvent) => void;
}

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  white:   '\x1b[97m',
  gray:    '\x1b[90m',
};

function log(icon: string, msg: string) {
  const safeIcon = icon.replace(/[\r\n]/g, ' ');
  const safeMsg = msg.replace(/[\r\n]/g, ' ');
  process.stdout.write(`  ${safeIcon} ${c.dim}${safeMsg}${c.reset}\n`);
}

export class TunnelAgent {
  private ws: WebSocket | null = null;
  private registry: CapabilityRegistry;
  private permissionGuard: PermissionGuard;
  private config: TunnelConfig;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private baseReconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private uptime = 0;
  private uptimeInterval: ReturnType<typeof setInterval> | null = null;

  // HMAC signature verification
  private signingKey: string | null = null;
  private lastNonce = 0;
  private responseNonce = 0;
  private readonly onEvent: TunnelAgentOptions['onEvent'];

  constructor(config: TunnelConfig, registry: CapabilityRegistry, options: TunnelAgentOptions = {}) {
    this.config = config;
    this.registry = registry;
    this.permissionGuard = new PermissionGuard();
    this.onEvent = options.onEvent;
  }

  private emitEvent(event: TunnelAgentLifecycleEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // An observer cannot alter the Agent's authorization or transport state.
    }
  }

  connect(): void {
    if (this.ws) {
      this.ws.close();
    }

    const wsUrl = this.buildWsUrl();
    log(`${c.cyan}◆${c.reset}`, `Connecting…`);

    try {
      // lgtm[js/file-access-to-http] Tunnel endpoint is intentionally loaded from trusted local config.
      this.ws = new WebSocket(new URL(wsUrl));
      this.setupWsHandlers();
    } catch (err) {
      log(`${c.red}✗${c.reset}`, `Connection failed`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }

    if (this.ws) {
      try { this.ws.close(1000, 'client shutdown'); } catch {}
      this.ws = null;
    }

    void this.enterStoppedState('client_disconnect');
    log(`${c.gray}○${c.reset}`, `Disconnected`);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private setupWsHandlers(): void {
    if (!this.ws) return;

    this.ws.addEventListener('open', () => {
      this.uptime = 0;
      this.lastNonce = 0;
      this.responseNonce = 0;
      this.signingKey = null;
      this.uptimeInterval = setInterval(() => { this.uptime++; }, 1000);

      // Send auth handshake as first message (token never in URL)
      this.send({ type: 'auth', token: trustedCredential(this.config.token, 'token') });
    });

    this.ws.addEventListener('message', (event) => {
      this.handleMessage(event.data as string);
    });

    this.ws.addEventListener('close', (event) => {
      this.emitEvent({ type: 'connection_closed', code: event.code });
      void this.enterStoppedState('connection_closed');
      if (this.uptimeInterval) {
        clearInterval(this.uptimeInterval);
        this.uptimeInterval = null;
      }
      if (this.stableConnectionTimer) {
        clearTimeout(this.stableConnectionTimer);
        this.stableConnectionTimer = null;
      }

      if (!this.isShuttingDown) {
        if (event.code === 4001) {
          log(`${c.red}✗${c.reset}`, `Authentication failed — check your token`);
          return; // Don't reconnect on auth failure
        }
        log(`${c.yellow}○${c.reset}`, `Disconnected ${c.gray}(code: ${event.code})${c.reset}`);
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      log(`${c.red}✗${c.reset}`, `WebSocket error`);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      log(`${c.yellow}!${c.reset}`, `Received invalid JSON`);
      return;
    }

    // Handle auth_ok — server sends signing key after successful auth
    if (msg.type === 'auth_ok' && msg.signingKey) {
      this.signingKey = msg.signingKey;
      this.emitEvent({ type: 'auth_ok' });
      log(`${c.green}●${c.reset}`, `Connected ${c.reset}${c.gray}(${this.registry.getCapabilityNames().join(', ')})${c.reset}`);
      if (this.stableConnectionTimer) clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = setTimeout(() => {
        this.reconnectAttempts = 0;
        this.stableConnectionTimer = null;
      }, 30_000);
      return;
    }

    if (!this.signingKey) {
      log(`${c.yellow}!${c.reset}`, `Message received before auth completed`);
      return;
    }

    if (!this.verifyIncomingSignature(msg, raw)) {
      if ('id' in msg && msg.id) {
        this.sendSignedError(msg.id, -32000, 'Invalid message signature');
      }
      return;
    }

    // ── Heartbeat ping (signature verified above) ────────────────────
    if ('method' in msg && msg.method === 'tunnel.ping') {
      this.sendPong();
      return;
    }

    // ── Automation kill switch (signature verified above) ──────────
    if ('method' in msg && msg.method === 'automation.kill_switch') {
      await this.enterStoppedState('automation_kill_switch', msg.params?.generation);
      this.emitEvent({
        type: 'kill_switch',
        ...(typeof msg.params?.generation === 'number'
          ? { generation: msg.params.generation }
          : {}),
      });
      log(`${c.red}■${c.reset}`, 'Automation stopped locally');
      return;
    }

    // ── Permission sync notification ────────────────────────────────
    if ('method' in msg && msg.method === 'tunnel.permissions.sync') {
      const permissions = (msg.params?.permissions || []) as LocalPermission[];
      this.permissionGuard.syncPermissions(permissions);
      this.emitEvent({ type: 'permissions_synced', permissions });
      log(`${c.green}●${c.reset}`, `Synced ${c.reset}${c.white}${permissions.length}${c.dim} permissions`);
      return;
    }

    // ── Permission granted notification ────────────────────────────
    if ('method' in msg && msg.method === 'tunnel.permission.granted') {
      const p = msg.params as LocalPermission | undefined;
      if (p?.permissionId) {
        this.permissionGuard.addPermission(p);
        this.emitEvent({ type: 'permission_granted', permission: p });
        log(`${c.green}+${c.reset}`, `Permission granted: ${p.capability} (${p.permissionId.slice(0, 12)}…)`);
      }
      return;
    }

    // ── Permission revocation notification ──────────────────────────
    if ('method' in msg && msg.method === 'tunnel.permission.revoked') {
      const permissionId = msg.params?.permissionId as string;
      if (permissionId) {
        this.permissionGuard.revokePermission(permissionId);
        this.emitEvent({ type: 'permission_revoked', permissionId });
        log(`${c.yellow}○${c.reset}`, `Permission revoked: ${permissionId.slice(0, 12)}…`);
      }
      return;
    }

    // ── Token rotation notification ─────────────────────────────────
    if ('method' in msg && msg.method === 'tunnel.token.rotated') {
      this.emitEvent({ type: 'token_rotated' });
      log(`${c.yellow}!${c.reset}`, `Token rotated — reconnecting with new token`);
      return;
    }

    // ── RPC request dispatch ────────────────────────────────────────
    if ('id' in msg && msg.id) {
      await this.handleRpcRequest(msg as JsonRpcRequest);
      return;
    }
  }

  /**
   * Verify HMAC signature on incoming messages (excluding pings).
   */
  private verifyIncomingSignature(msg: IncomingMessage, _raw: string): boolean {
    const sig = (msg as any)._sig as string | undefined;
    const nonce = (msg as any)._nonce as number | undefined;

    if (sig === undefined || nonce === undefined) {
      log(`${c.yellow}!${c.reset}`, `Message missing signature fields`);
      return false;
    }

    if (nonce <= this.lastNonce) {
      log(`${c.red}✗${c.reset}`, `Replay detected: nonce ${nonce} <= ${this.lastNonce}`);
      return false;
    }

    const { _sig, _nonce, ...payloadObj } = msg as any;
    const payload = JSON.stringify(payloadObj);

    if (!verifyMessageSignature(this.signingKey!, payload, nonce, sig)) {
      log(`${c.red}✗${c.reset}`, `Invalid HMAC signature`);
      return false;
    }

    this.lastNonce = nonce;
    return true;
  }

  private async handleRpcRequest(request: JsonRpcRequest): Promise<void> {
    const { id, method, params = {} } = request;

    const permissionId = params.permissionId as string | undefined;
    const capability = capabilityForMethod(method);
    if (!capability) {
      this.sendSignedError(id, -32000, `Permission denied: unknown capability for method ${method}`);
      return;
    }

    let permission: LocalPermission;
    try {
      permission = this.permissionGuard.checkRequest({
        permissionId,
        capability,
        method,
        params,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendSignedError(id, -32000, message);
      return;
    }

    const handler = this.registry.getHandler(method);
    if (!handler) {
      this.sendSignedError(id, -32001, `Capability not registered for method: ${method}`);
      return;
    }

    try {
      const result = await handler({
        ...params,
        __permission: permission,
      });
      this.sendSignedResult(id, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendSignedError(id, -32003, message);
    }
  }

  private async enterStoppedState(reason: string, generation?: unknown): Promise<void> {
    this.permissionGuard.activateKillSwitch(generation);
    const endSession = this.registry.getHandler('desktop.cua.end_session');
    if (!endSession) return;

    try {
      await endSession({ reason });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`${c.yellow}!${c.reset}`, `Local input stop was best-effort: ${message}`);
    }
  }

  /** Send HMAC-signed RPC result. */
  private sendSignedResult(id: string, result: unknown): void {
    const data = { jsonrpc: '2.0' as const, id, result };
    this.sendSigned(data);
  }

  /** Send HMAC-signed RPC error. */
  private sendSignedError(id: string, code: number, message: string): void {
    const data = { jsonrpc: '2.0' as const, id, error: { code, message } };
    this.sendSigned(data);
  }

  private sendSigned(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN && this.signingKey) {
      const nonce = ++this.responseNonce;
      const payload = JSON.stringify(data);
      const sig = signMessage(this.signingKey, payload, nonce);
      const signed = { ...data, _sig: sig, _nonce: nonce };
      try {
        this.ws.send(JSON.stringify(signed));
      } catch (err) {
        log(`${c.red}✗${c.reset}`, `Send failed`);
      }
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(data));
      } catch (err) {
        log(`${c.red}✗${c.reset}`, `Send failed`);
      }
    }
  }

  private sendPong(): void {
    this.sendSigned({
      jsonrpc: '2.0',
      method: 'tunnel.pong',
      params: {
        uptime: this.uptime,
        capabilities: this.registry.getCapabilityNames(),
        machineInfo: {
          hostname: hostname(),
          platform: platform(),
          arch: arch(),
          osVersion: release(),
          agentVersion: '0.1.2',
        },
      },
    });
  }

  private scheduleReconnect(): void {
    if (this.isShuttingDown) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    log(`${c.cyan}◆${c.reset}`, `Reconnecting in ${c.reset}${c.white}${(delay / 1000).toFixed(1)}s${c.dim} (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private buildWsUrl(): string {
    const base = trustedHttpUrl(this.config.apiUrl)
      .replace(/^http:/, 'ws:')
      .replace(/^https:/, 'wss:');

    if (base.startsWith('ws://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
      log(`${c.red}!${c.reset}`, `${c.red}WARNING: Connecting over unencrypted ws:// to a remote host. Token will be sent in plaintext. Use https:// API URL for production.${c.reset}`);
    }

    const wsPath = this.config.wsPath || '/ws';
    const params = new URLSearchParams({
      tunnelId: trustedCredential(this.config.tunnelId, 'tunnelId'),
    });

    return `${base}${wsPath}?${params.toString()}`;
  }
}
