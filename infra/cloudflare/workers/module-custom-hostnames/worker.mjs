const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROUTE_RE =
  /^\/v1\/module-host\/releases\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_BASE_DOMAIN_LENGTH = 214;
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-kortix-internal-key',
  'x-openopc-module-domain-binding',
  'x-openopc-module-release',
  'x-forwarded-host',
  'x-forwarded-proto',
  'host',
]);

function validInternalKey(env) {
  return typeof env?.INTERNAL_SERVICE_KEY === 'string' && env.INTERNAL_SERVICE_KEY.length >= 16;
}

function isIpv4Literal(value) {
  const labels = value.split('.');
  return (
    labels.length === 4 &&
    labels.every(
      (label) => /^(?:0|[1-9][0-9]{0,2})$/.test(label) && Number(label) <= 255,
    )
  );
}

function canonicalBaseDomain(baseDomain) {
  if (
    typeof baseDomain !== 'string' ||
    baseDomain !== baseDomain.trim() ||
    baseDomain !== baseDomain.toLowerCase() ||
    baseDomain.length > MAX_BASE_DOMAIN_LENGTH ||
    isIpv4Literal(baseDomain)
  ) {
    return false;
  }
  const labels = baseDomain.split('.');
  return labels.length >= 2 && labels.every((label) => DNS_LABEL_RE.test(label));
}

export function platformReleaseId(hostname, baseDomain) {
  if (!canonicalBaseDomain(baseDomain)) return null;
  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return null;
  const label = hostname.slice(0, -suffix.length);
  if (!label.startsWith('r-')) return null;
  const releaseId = label.slice(2);
  return UUID_RE.test(releaseId) && releaseId === releaseId.toLowerCase()
    ? releaseId
    : null;
}

function platformOrigin(env) {
  if (!canonicalBaseDomain(env?.OPENOPC_MODULE_APP_BASE_DOMAIN)) return null;
  if (!validInternalKey(env)) return null;
  if (typeof env?.OPENOPC_MODULE_HOST_ORIGIN !== 'string') return null;
  try {
    const origin = new URL(env.OPENOPC_MODULE_HOST_ORIGIN);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.port ||
      origin.search ||
      origin.hash ||
      (origin.pathname !== '' && origin.pathname !== '/') ||
      origin.hostname.split('.').some((label) => !DNS_LABEL_RE.test(label))
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

function hasPlatformConfiguration(env) {
  return (
    env?.OPENOPC_MODULE_APP_BASE_DOMAIN !== undefined ||
    env?.OPENOPC_MODULE_HOST_ORIGIN !== undefined
  );
}

function customHostnameOrigin(env) {
  if (typeof env?.OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN !== 'string') return null;
  if (typeof env?.OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX !== 'string') return null;
  if (!validInternalKey(env)) return null;
  try {
    const origin = new URL(env.OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      (origin.pathname !== '' && origin.pathname !== '/')
    ) {
      return null;
    }
    const hostname = origin.hostname.toLowerCase().replace(/[.]$/, '');
    const suffix = env.OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX.toLowerCase()
      .trim()
      .replace(/[.]$/, '');
    const suffixLabels = suffix.split('.');
    if (
      !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(suffix) ||
      suffixLabels.length < 2 ||
      suffixLabels.some((label) => !DNS_LABEL_RE.test(label)) ||
      hostname === suffix ||
      !hostname.endsWith(`.${suffix}`) ||
      hostname.split('.').some((label) => !DNS_LABEL_RE.test(label))
    ) {
      return null;
    }
    return origin.origin;
  } catch {
    return null;
  }
}

function notFound() {
  return new Response('Not Found', { status: 404 });
}

function safeResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'binding_id,route_path') return null;
  if (typeof value.binding_id !== 'string' || !UUID_RE.test(value.binding_id)) return null;
  if (typeof value.route_path !== 'string' || !ROUTE_RE.test(value.route_path)) return null;
  return value;
}

function sanitizeHeaders(headers) {
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
}

function configurationError() {
  return new Response('Invalid module hostname worker configuration', { status: 500 });
}

function redirectToHttps(incoming) {
  incoming.protocol = 'https:';
  return new Response(null, { status: 308, headers: { Location: incoming.toString() } });
}

async function forwardToModuleOrigin(request, target, internalKey, identityHeader, identity) {
  const forwarded = new Request(target, request);
  sanitizeHeaders(forwarded.headers);
  forwarded.headers.set(identityHeader, identity);
  forwarded.headers.set('X-Kortix-Internal-Key', internalKey);
  let response;
  try {
    response = await fetch(forwarded, { redirect: 'manual' });
  } catch {
    return new Response('Module upstream unavailable', { status: 502 });
  }
  const result = new Response(response.body, response);
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return result;
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const configuredPlatformOrigin = platformOrigin(env);
    if (hasPlatformConfiguration(env) && !configuredPlatformOrigin) {
      return configurationError();
    }
    const releaseId = platformReleaseId(
      incoming.hostname,
      env?.OPENOPC_MODULE_APP_BASE_DOMAIN,
    );
    if (releaseId) {
      if (incoming.protocol !== 'https:') return redirectToHttps(incoming);

      const target = new URL(configuredPlatformOrigin);
      target.pathname = `/v1/module-host/platform/releases/${releaseId}${
        incoming.pathname === '/' ? '' : incoming.pathname
      }`;
      target.search = incoming.search;
      return forwardToModuleOrigin(
        request,
        target,
        env.INTERNAL_SERVICE_KEY,
        'X-OpenOPC-Module-Release',
        releaseId,
      );
    }

    const origin = customHostnameOrigin(env);
    if (!origin) return configurationError();
    if (incoming.protocol !== 'https:') return redirectToHttps(incoming);

    const resolverUrl = new URL('/v1/internal/module-domains/resolve', origin);
    resolverUrl.searchParams.set('hostname', incoming.hostname.toLowerCase());
    let resolutionResponse;
    try {
      resolutionResponse = await fetch(
        new Request(resolverUrl, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'X-Kortix-Internal-Key': env.INTERNAL_SERVICE_KEY,
          },
          redirect: 'manual',
        }),
      );
    } catch {
      return notFound();
    }
    if (!resolutionResponse.ok) return notFound();

    let resolution;
    try {
      resolution = safeResolution(await resolutionResponse.json());
    } catch {
      resolution = null;
    }
    if (!resolution) return notFound();

    const target = new URL(origin);
    target.pathname = `${resolution.route_path}${incoming.pathname === '/' ? '' : incoming.pathname}`;
    target.search = incoming.search;
    return forwardToModuleOrigin(
      request,
      target,
      env.INTERNAL_SERVICE_KEY,
      'X-OpenOPC-Module-Domain-Binding',
      resolution.binding_id,
    );
  },
};
