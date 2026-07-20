const URL_SCHEME = 'kortix';

const APP_PATH_PREFIXES = [
  '/projects',
  '/accounts',
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
  '/countryerror',
  '/debug',
];

function isPreviewHost(host) {
  return host.endsWith('.localhost') || host === 'kortix.cloud' || host.endsWith('.kortix.cloud');
}

function isMainAppHost(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === 'kortix.com' ||
    host.endsWith('.kortix.com')
  );
}

function isAppPath(pathname) {
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return true;
  return APP_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function shouldLoadInApp(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return false;
  }
  if (url.protocol === `${URL_SCHEME}:`) return true;
  if (url.pathname.startsWith('/auth/v1/')) return false;
  if (isPreviewHost(url.hostname)) return true;
  return isMainAppHost(url.hostname) && isAppPath(url.pathname);
}

function shouldRegisterProtocol(env = process.env) {
  return env.KORTIX_E2E_DISABLE_PROTOCOL_REGISTRATION !== '1';
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
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
  downloadFromWebContents,
  isMainAppHost,
  normalizeDownloadUrl,
  shouldLoadInApp,
  shouldRegisterProtocol,
};
