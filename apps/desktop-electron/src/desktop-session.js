const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESKTOP_SESSION_TIMEOUT_MS = 5_000;

function parseHttpUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} URL must use http or https`);
  }
  return parsed;
}

function desktopSessionUrl(configuredUrl, frameUrl) {
  const configured = parseHttpUrl(configuredUrl, 'Configured app');
  const frame = parseHttpUrl(frameUrl, 'Renderer');
  if (configured.origin !== frame.origin) {
    throw new Error('Renderer origin does not match the configured app origin');
  }
  return `${frame.origin}/api/desktop/session`;
}

function parseDesktopSessionPayload(payload) {
  if (!payload || typeof payload !== 'object' || !UUID_RE.test(payload.userId || '')) {
    throw new Error('Authenticated desktop session did not return a valid user id');
  }
  return payload.userId;
}

async function fetchDesktopSessionUserId({
  configuredUrl,
  frameUrl,
  fetchSession,
  timeoutMs = DESKTOP_SESSION_TIMEOUT_MS,
}) {
  const sessionUrl = desktopSessionUrl(configuredUrl, frameUrl);
  if (typeof fetchSession !== 'function') {
    throw new Error('Authenticated desktop session is unavailable');
  }

  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetchSession(sessionUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
      signal: abort.signal,
    });
    if (!response?.ok || response.redirected === true || typeof response.json !== 'function') {
      throw new Error('Desktop session response was rejected');
    }
    return parseDesktopSessionPayload(await response.json());
  } catch {
    throw new Error('Authenticated desktop session is unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  DESKTOP_SESSION_TIMEOUT_MS,
  UUID_RE,
  desktopSessionUrl,
  fetchDesktopSessionUserId,
  parseDesktopSessionPayload,
};
