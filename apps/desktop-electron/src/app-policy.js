const URL_SCHEME = 'kortix';
const LOCAL_GRANT_OPERATIONS = new Set([
  'requestLocalGrant',
  'listLocalGrants',
  'revokeLocalGrant',
]);

const APP_PATH_PREFIXES = [
  '/projects',
  '/accounts',
  '/developer',
  '/invites',
  '/admin',
  '/setup',
  '/connectors',
  '/oauth',
  '/checkout',
  '/tunnel',
  '/github',
  '/cli',
  '/templates',
  '/maintenance',
  '/review',
  '/legacy-machines',
  '/countryerror',
  '/debug',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname);
}

function isLegacyKortixHost(hostname) {
  return hostname === 'kortix.com' || hostname.endsWith('.kortix.com');
}

function normalizeOpenOpcDesktopUrl(value, options = {}) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/projects' ||
    isLegacyKortixHost(url.hostname)
  ) {
    return null;
  }

  if (url.protocol === 'https:') return `${url.origin}/projects`;
  if (url.protocol === 'http:' && options.allowLoopback === true && isLoopbackHost(url.hostname)) {
    return `${url.origin}/projects`;
  }
  return null;
}

function createOpenOpcFrontendSubmenu({ isPackaged, onLocal, onCustom, onReset }) {
  return {
    label: 'Frontend URL',
    submenu: [
      ...(isPackaged
        ? []
        : [
            {
              label: 'Local (localhost:3000)',
              click: onLocal,
            },
            { type: 'separator' },
          ]),
      {
        label: 'Custom URL…',
        click: onCustom,
      },
      {
        label: 'Reset to Default',
        click: onReset,
      },
    ],
  };
}

function resolveOpenOpcDesktopDefault(input = {}) {
  const env = input.env && typeof input.env === 'object' ? input.env : {};
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const isPackaged = input.isPackaged === true;

  if (isPackaged) {
    const normalized = normalizeOpenOpcDesktopUrl(metadata.openopcDefaultUrl);
    if (!normalized) throw new Error('OPENOPC_DESKTOP_URL_REQUIRED');
    return normalized;
  }

  const explicit =
    (typeof env.OPENOPC_DESKTOP_URL === 'string' && env.OPENOPC_DESKTOP_URL) ||
    (typeof env.OPENOPC_DESKTOP_DEFAULT_URL === 'string' && env.OPENOPC_DESKTOP_DEFAULT_URL) ||
    metadata.openopcDefaultUrl ||
    'http://localhost:3000/projects';
  const normalized = normalizeOpenOpcDesktopUrl(explicit, { allowLoopback: true });
  if (!normalized) throw new Error('OPENOPC_DESKTOP_URL_INVALID');
  return normalized;
}

function isPreviewHost(host) {
  return host.endsWith('.localhost') || host === 'kortix.cloud' || host.endsWith('.kortix.cloud');
}

function isAppPath(pathname) {
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return true;
  return APP_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function shouldLoadInApp(urlStr, configuredUrl) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol === `${URL_SCHEME}:`) return true;
  if (url.pathname.startsWith('/auth/v1/')) return false;
  if (isPreviewHost(url.hostname)) return true;
  if (configuredUrl && isTrustedAppSender(configuredUrl, urlStr)) return true;
  return false;
}

function shouldRegisterProtocol(env = process.env) {
  return env.KORTIX_E2E_DISABLE_PROTOCOL_REGISTRATION !== '1';
}

function isLocalGrantOperation(value) {
  return typeof value === 'string' && LOCAL_GRANT_OPERATIONS.has(value);
}

function isTrustedAppSender(configuredUrl, senderUrl) {
  try {
    const configured = new URL(configuredUrl);
    const sender = new URL(senderUrl);
    if (!['http:', 'https:'].includes(configured.protocol)) return false;
    if (!['http:', 'https:'].includes(sender.protocol)) return false;
    return configured.origin === sender.origin && isAppPath(sender.pathname);
  } catch {
    return false;
  }
}

function isOpenOpcModuleServiceUrl(urlStr, configuredUrl) {
  try {
    const configured = new URL(configuredUrl);
    const requested = new URL(urlStr);
    if (!['http:', 'https:'].includes(configured.protocol)) return false;
    if (!['http:', 'https:'].includes(requested.protocol)) return false;
    if (requested.protocol === 'http:' && !isLoopbackHost(requested.hostname)) return false;
    if (configured.origin !== requested.origin) return false;
    if (requested.username || requested.password) return false;
    return (
      requested.pathname === '/v1/module-services' ||
      requested.pathname.startsWith('/v1/module-services/')
    );
  } catch {
    return false;
  }
}

function normalizeDownloadUrl(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.toString();
  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) return url.toString();
  return null;
}

function downloadFromWebContents(webContents, value) {
  const url = normalizeDownloadUrl(value);
  if (!url) throw new Error('Invalid download URL');
  if (!webContents || typeof webContents.downloadURL !== 'function') {
    throw new Error('Download is unavailable');
  }
  webContents.downloadURL(url);
}

module.exports = {
  createOpenOpcFrontendSubmenu,
  downloadFromWebContents,
  isLocalGrantOperation,
  isOpenOpcModuleServiceUrl,
  isTrustedAppSender,
  normalizeOpenOpcDesktopUrl,
  normalizeDownloadUrl,
  resolveOpenOpcDesktopDefault,
  shouldLoadInApp,
  shouldRegisterProtocol,
};
