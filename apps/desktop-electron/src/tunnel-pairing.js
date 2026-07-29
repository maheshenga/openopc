const { normalizeOrigin } = require('./tunnel-profile-store');

const DEVICE_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/;
const DEVICE_SECRET_RE = /^[\x21-\x7e]{16,4096}$/;
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const POLL_STATUSES = new Set(['pending', 'approved', 'denied', 'expired', 'not_found']);

class TunnelPairingError extends Error {
  constructor(code, message = code, details) {
    super(message);
    this.name = 'TunnelPairingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function pairingFail(code, message, details) {
  throw new TunnelPairingError(code, message, details);
}

function safeString(value, label, maximum = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\r\n]/.test(value)) {
    pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', `${label} was invalid`);
  }
  return value;
}

function parseJsonResponse(response, expectedStatus) {
  if (!response || typeof response.json !== 'function') {
    pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing API response was invalid');
  }
  if (response.status !== expectedStatus) {
    pairingFail('TUNNEL_PAIRING_API_ERROR', `Pairing API returned HTTP ${response.status}` , {
      status: response.status,
    });
  }
  return response.json().catch(() => {
    pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing API response was not JSON');
  });
}

function createTunnelPairing(options = {}) {
  const origin = normalizeOrigin(options.origin, 'Configured app');
  const accountId = options.accountId;
  if (typeof accountId !== 'string' || !ACCOUNT_ID_RE.test(accountId)) {
    pairingFail(
      'TUNNEL_PAIRING_ACCOUNT_REQUIRED',
      'Desktop pairing requires an explicit selected account',
    );
  }
  const requestFetch = options.fetch || globalThis.fetch;
  if (typeof requestFetch !== 'function') {
    pairingFail('TUNNEL_PAIRING_UNAVAILABLE', 'Pairing network client is unavailable');
  }
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const defaultPollIntervalMs = Number.isSafeInteger(options.pollIntervalMs)
    ? Math.max(250, Math.min(options.pollIntervalMs, 30_000))
    : 2_000;
  const machineHostname =
    typeof options.machineHostname === 'string' ? options.machineHostname.slice(0, 255) : undefined;

  let active = null;
  let abortController = null;
  let state = 'idle';
  let lastError = null;

  function safeMetadata() {
    if (!active) return null;
    return Object.freeze({
      code: active.code,
      verificationUrl: active.verificationUrl,
      expiresAt: active.expiresAt,
    });
  }

  function clearSecret() {
    if (active) active.deviceSecret = null;
  }

  function clearActive() {
    clearSecret();
    active = null;
    abortController = null;
  }

  function requestWasCancelled(controller) {
    return controller.signal.aborted || abortController !== controller;
  }

  function requireCurrentRequest(controller) {
    if (requestWasCancelled(controller)) {
      pairingFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
    }
  }

  function status() {
    return Object.freeze({
      state,
      pending: safeMetadata(),
      error: lastError ? Object.freeze({ code: lastError.code, message: lastError.message }) : null,
    });
  }

  async function begin() {
    if (active && active.deviceSecret) {
      state = 'pairing_pending';
      return safeMetadata();
    }
    abortController?.abort();
    lastError = null;
    const controller = new AbortController();
    abortController = controller;
    const body = JSON.stringify({
      account_id: accountId,
      ...(machineHostname ? { machineHostname } : {}),
    });
    let response;
    try {
      response = await requestFetch(`${origin}/v1/tunnel/device-auth`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      requireCurrentRequest(controller);
    } catch (error) {
      if (requestWasCancelled(controller)) {
        pairingFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
      }
      clearActive();
      state = 'error';
      lastError = new TunnelPairingError('TUNNEL_PAIRING_NETWORK_ERROR', 'Pairing API is unavailable');
      throw lastError;
    }

    let payload;
    try {
      payload = await parseJsonResponse(response, 201);
      requireCurrentRequest(controller);
      if (
        !payload ||
        typeof payload !== 'object' ||
        !DEVICE_CODE_RE.test(payload.deviceCode) ||
        !DEVICE_SECRET_RE.test(payload.deviceSecret) ||
        typeof payload.verificationUrl !== 'string' ||
        typeof payload.expiresAt !== 'string' ||
        !Number.isSafeInteger(payload.pollIntervalMs) ||
        payload.pollIntervalMs < 0
      ) {
        pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing API response was invalid');
      }
      const verificationUrl = new URL(payload.verificationUrl);
      if (verificationUrl.protocol !== 'http:' && verificationUrl.protocol !== 'https:') {
        pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing verification URL was invalid');
      }
      const expiresAtMs = Date.parse(payload.expiresAt);
      if (!Number.isFinite(expiresAtMs)) {
        pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing expiry was invalid');
      }
      active = {
        code: payload.deviceCode,
        deviceSecret: payload.deviceSecret,
        verificationUrl: verificationUrl.toString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        pollIntervalMs: Math.max(250, Math.min(payload.pollIntervalMs || defaultPollIntervalMs, 30_000)),
      };
      state = 'pairing_pending';
      return safeMetadata();
    } catch (error) {
      if (requestWasCancelled(controller)) {
        pairingFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
      }
      clearActive();
      state = 'error';
      lastError =
        error instanceof TunnelPairingError
          ? error
          : new TunnelPairingError('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing API response was invalid');
      throw lastError;
    }
  }

  async function pollOnce() {
    if (!active || !active.deviceSecret) {
      pairingFail('TUNNEL_PAIRING_NOT_ACTIVE', 'No pairing request is active');
    }
    const expectedActive = active;
    if (now() >= expectedActive.expiresAtMs) {
      state = 'expired';
      clearActive();
      return Object.freeze({ status: 'expired' });
    }
    const controller = abortController || new AbortController();
    const pollWasCancelled = () =>
      controller.signal.aborted || abortController !== controller || active !== expectedActive;
    const requireCurrentPoll = () => {
      if (pollWasCancelled()) pairingFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
    };
    let response;
    try {
      response = await requestFetch(
        `${origin}/v1/tunnel/device-auth/${encodeURIComponent(expectedActive.code)}/status`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${expectedActive.deviceSecret}`,
          },
          signal: controller.signal,
        },
      );
      requireCurrentPoll();
    } catch (error) {
      if (pollWasCancelled() || (error?.name === 'AbortError' && controller.signal.aborted)) {
        pairingFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
      }
      pairingFail('TUNNEL_PAIRING_NETWORK_ERROR', 'Pairing API is unavailable');
    }

    let payload;
    try {
      if (!response || typeof response.json !== 'function') {
        pairingFail('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing API response was invalid');
      }
      payload = await response.json();
      requireCurrentPoll();
    } catch (error) {
      if (pollWasCancelled()) {
        pairingFail('TUNNEL_PAIRING_CANCELLED', 'Pairing was cancelled');
      }
      clearActive();
      state = 'error';
      lastError = new TunnelPairingError('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing API response was not JSON');
      throw lastError;
    }

    if (response.status === 403) {
      clearActive();
      state = 'error';
      lastError = new TunnelPairingError('TUNNEL_PAIRING_SECRET_REJECTED', 'Pairing secret was rejected');
      throw lastError;
    }
    if (response.status === 404 && payload?.status === 'not_found') {
      clearActive();
      state = 'error';
      lastError = new TunnelPairingError('TUNNEL_PAIRING_NOT_FOUND', 'Pairing request was not found');
      throw lastError;
    }
    if (response.status !== 200 || !payload || typeof payload !== 'object') {
      clearActive();
      state = 'error';
      lastError = new TunnelPairingError('TUNNEL_PAIRING_API_ERROR', `Pairing API returned HTTP ${response.status}`);
      throw lastError;
    }
    if (typeof payload.status !== 'string' || !POLL_STATUSES.has(payload.status)) {
      clearActive();
      state = 'error';
      lastError = new TunnelPairingError('TUNNEL_PAIRING_INVALID_RESPONSE', 'Pairing status was invalid');
      throw lastError;
    }
    if (payload.status === 'pending') return Object.freeze({ status: 'pending' });
    if (payload.status === 'denied') {
      clearActive();
      state = 'denied';
      return Object.freeze({ status: 'denied' });
    }
    if (payload.status === 'expired') {
      clearActive();
      state = 'expired';
      return Object.freeze({ status: 'expired' });
    }
    if (payload.status === 'approved') {
      const setupToken = payload.token ?? payload.setupToken;
      if (!DEVICE_CODE_RE.test(String(payload.tunnelId || '')) || !DEVICE_SECRET_RE.test(String(setupToken || ''))) {
        clearActive();
        state = 'error';
        lastError = new TunnelPairingError(
          'TUNNEL_PAIRING_APPROVAL_INCOMPLETE',
          'Approved pairing did not include a valid tunnel credential',
        );
        throw lastError;
      }
      if (payload.accountId !== accountId) {
        clearActive();
        state = 'error';
        lastError = new TunnelPairingError(
          'TUNNEL_PAIRING_ACCOUNT_MISMATCH',
          'Approved pairing account did not match the selected account',
        );
        throw lastError;
      }
      const result = Object.freeze({
        status: 'approved',
        accountId,
        tunnelId: payload.tunnelId,
        setupToken,
      });
      clearActive();
      state = 'approved';
      return result;
    }
    clearActive();
    state = 'error';
    lastError = new TunnelPairingError('TUNNEL_PAIRING_NOT_FOUND', 'Pairing request was not found');
    throw lastError;
  }

  async function waitForApproval(options = {}) {
    const deadline = Math.min(
      now() + (Number.isSafeInteger(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 5 * 60_000),
      active?.expiresAtMs ?? now(),
    );
    while (active && active.deviceSecret && now() < deadline) {
      const result = await pollOnce();
      if (result.status !== 'pending') return result;
      await sleep(Math.min(active?.pollIntervalMs ?? defaultPollIntervalMs, Math.max(0, deadline - now())));
    }
    if (active) {
      clearActive();
      state = 'expired';
    }
    return Object.freeze({ status: 'expired' });
  }

  function cancel() {
    if (abortController) abortController.abort();
    clearActive();
    state = 'cancelled';
    lastError = null;
  }

  return Object.freeze({
    begin,
    start: begin,
    pollOnce,
    poll: pollOnce,
    waitForApproval,
    cancel,
    stop: cancel,
    status,
    getPending: safeMetadata,
  });
}

module.exports = {
  TunnelPairingError,
  createTunnelPairing,
};
